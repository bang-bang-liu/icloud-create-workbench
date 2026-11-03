import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import request from "supertest";
import { createReloginMailContext } from "./helpers/relogin-mail-context.mjs";
import { codePath } from "./helpers/mail-api-context.mjs";
import { readReloginMailConfig } from "../src/relogin-mail-config.mjs";

const resolvePath = "/api/v1/relogin/mailboxes/resolve";

/** 通过真实本地 HTTP 路由签发指定合成邮箱的凭据。 */
async function resolve(context, email = context.addresses[0].email) {
  const response = await request(context.app).post(resolvePath)
    .set("Authorization", `Bearer ${context.config.reloginMail.token}`).send({ email }).expect(201);
  return response.body;
}

/** 记录不应因重登签发而改变的业务表内容。 */
function snapshot(context) {
  return Object.fromEntries(["hidden_addresses", "icloud_accounts", "account_inbox_configs",
    "mail_api_claims", "address_public_access"].map(table => [table,
    context.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

test("重登密钥默认关闭及错误配置不影响原邮箱接口与管理端", async t => {
  for (const token of ["", "short", "x ".repeat(32)]) {
    const context = createReloginMailContext({ env: { MAIL_API_RELOGIN_TOKEN: token } });
    t.after(() => context.cleanup());
    await request(context.app).post(resolvePath).send({ email: context.addresses[0].email }).expect(503);
    await request(context.app).get("/api/v1/health").expect(200);
    await request(context.app).get("/api/health").expect(200);
    await request(context.app).post("/api/v1/mailboxes")
      .set("Authorization", `Bearer ${context.config.mailApi.token}`).send({}).expect(201);
    assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM mail_api_relogin_accesses").get().n, 0);
  }
  const parent = { enabled: true, error: "", token: "original-token", accountId: "account", labelPrefix: "sentinel-" };
  const before = { ...parent };
  readReloginMailConfig({ MAIL_API_RELOGIN_TOKEN: "short" }, parent);
  assert.deepEqual(parent, before);
});

test("已用邮箱重复签发不消耗库存、不改变旧凭据，每条链接独立有效", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  const publicLink = context.publicMailService.createAccess(context.addresses[0].id);
  const registration = context.service.claim();
  const before = snapshot(context);
  const first = await resolve(context, `  ${context.addresses[0].email}  `);
  const second = await resolve(context);
  assert.deepEqual(Object.keys(first).sort(), ["code_url", "email", "expires_at"]);
  assert.equal(first.email, context.addresses[0].email);
  assert.equal(Date.parse(first.expires_at), Date.UTC(2026, 9, 30, 4));
  assert.notEqual(first.code_url, second.code_url);
  assert.deepEqual(snapshot(context), before);
  await request(context.app).get(codePath(first)).expect(200);
  await request(context.app).get(codePath(second)).expect(200);
  await request(context.app).get(codePath(registration)).expect(200);
  await request(context.app).get(new URL(publicLink.apiUrl).pathname).expect(200);
  const rows = context.db.prepare("SELECT * FROM mail_api_relogin_accesses").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.token_hash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(row).includes(new URL(first.code_url).searchParams.get("token")));
  }
});

test("未领取但属于指定范围的邮箱也可解析，始终保留原状态", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  const before = snapshot(context);
  await resolve(context);
  assert.deepEqual(snapshot(context), before);
  assert.equal(context.repositories.getAddress(context.addresses[0].id).state, "unused");
});

test("签发需要专用密钥，不接受注册密钥或管理员会话", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  for (const authorization of ["", "Bearer wrong", `Bearer ${context.config.mailApi.token}`]) {
    await request(context.app).post(resolvePath).set("Authorization", authorization)
      .send({ email: context.addresses[0].email }).expect(401);
  }
  const login = await request(context.app).post("/api/auth/login").set("Origin", context.config.appOrigin)
    .send({ username: "admin", password: "admin-test-password" }).expect(200);
  await request(context.app).post(resolvePath).set("Cookie", login.headers["set-cookie"])
    .send({ email: context.addresses[0].email }).expect(401);
  await resolve(context);
});

test("请求格式受限，邮箱精确匹配且无法扩大账号或标签范围", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  for (const body of [{}, [], { email: 1 }, { email: "bad" },
    { email: context.addresses[0].email, account_id: "another" }, { email: "a".repeat(300) + "@example.test" }]) {
    await request(context.app).post(resolvePath).set("Authorization", `Bearer ${context.config.reloginMail.token}`)
      .send(body).expect(400);
  }
  await request(context.app).post(resolvePath).set("Authorization", `Bearer ${context.config.reloginMail.token}`)
    .type("json").send('{"email":"do-not-reflect').expect(400);
  await request(context.app).post(resolvePath).set("Authorization", `Bearer ${context.config.reloginMail.token}`)
    .send({ email: "a".repeat(5000) }).expect(413);
  const foreignLabel = context.seedAddress({ email: "other@example.test", label: "other-prefix" });
  const otherAccount = context.repositories.upsertAccount({ identityKey: "other-account",
    appleId: "other@example.test", region: "global", cookieEncrypted: "synthetic" });
  const foreignAccount = context.seedAddress({ email: "foreign@example.test", accountId: otherAccount.id });
  for (const email of ["missing@example.test", context.addresses[0].email.toUpperCase(), foreignLabel.email, foreignAccount.email]) {
    await request(context.app).post(resolvePath).set("Authorization", `Bearer ${context.config.reloginMail.token}`)
      .send({ email }).expect(404).expect({ error: "该邮箱没有可用的自动取码地址" });
  }
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM mail_api_relogin_accesses").get().n, 0);
});

test("取码只返回本轮时间窗口、真实 UTC 时间、当前邮箱的有效六位码", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  const link = await resolve(context);
  const empty = await request(context.app).get(codePath(link)).expect(200);
  assert.doesNotMatch(empty.text, /class="code"/);
  context.seedMessage(link.email, { uid: "old", code: "111111", receivedAt: "2026-10-30T02:59:54Z" });
  context.seedMessage(link.email, { uid: "new", code: "007421", receivedAt: "2026-10-30T11:00:02+08:00",
    subject: "<script>secret</script>", sender: "a&b" });
  context.seedMessage(link.email, { uid: "bad-time", code: "999999", receivedAt: "invalid" });
  context.seedMessage(link.email, { uid: "bad-code", code: "abcdef" });
  context.seedMessage(context.addresses[1].email, { uid: "other", code: "444444" });
  const page = await request(context.app).get(codePath(link)).expect(200).expect("Content-Type", /text\/html/);
  assert.match(page.text, /Time: 2026-10-30 03:00:02/);
  assert.match(page.text, /class="code">007421</);
  assert.match(page.text, /&lt;script&gt;secret&lt;\/script&gt;/);
  assert.doesNotMatch(page.text, /111111|999999|444444|abcdef|<script/);
  assert.match(page.headers["cache-control"], /no-store/);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
});

test("新旧凭据不能交叉使用，错误密钥不暴露期限，三天后可重新签发", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  const registration = context.service.claim();
  const link = await resolve(context);
  const oldUrl = new URL(registration.code_url);
  const newUrl = new URL(link.code_url);
  await request(context.app).get(newUrl.pathname + "?token=" + oldUrl.searchParams.get("token")).expect(404);
  await request(context.app).get(oldUrl.pathname + "?token=" + newUrl.searchParams.get("token")).expect(404);
  const oldId = oldUrl.pathname.split("/")[4];
  await request(context.app).get(`/api/v1/relogin/access/${oldId}/code?${oldUrl.searchParams}`).expect(404);
  context.setNow(Date.parse(link.expires_at));
  await request(context.app).get(codePath(link)).expect(410);
  await request(context.app).get(newUrl.pathname + "?token=" + "x".repeat(43)).expect(404);
  context.setNow(Date.UTC(2026, 10, 2, 3));
  const next = await resolve(context);
  assert.notEqual(next.code_url, link.code_url);
  assert.equal(Date.parse(next.expires_at), Date.UTC(2026, 10, 2, 4));
  await request(context.app).get(codePath(next)).expect(200);
});

test("已有凭据在邮箱入垃圾箱、标签越界、收件配置移除或账号删除后不可读", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  const link = await resolve(context);
  const url = new URL(link.code_url);
  const id = url.pathname.split("/")[5];
  const token = url.searchParams.get("token");
  context.repositories.updateAddressState(context.addresses[0].id, "trash");
  assert.throws(() => context.reloginService.getCodePage(id, token), { status: 404 });
  context.repositories.updateAddressState(context.addresses[0].id, "used");
  context.db.prepare("UPDATE hidden_addresses SET apple_label = 'other' WHERE id = ?").run(context.addresses[0].id);
  assert.throws(() => context.reloginService.getCodePage(id, token), { status: 404 });
  context.db.prepare("UPDATE hidden_addresses SET apple_label = 'sentinel-001' WHERE id = ?").run(context.addresses[0].id);
  context.db.prepare("UPDATE account_inbox_configs SET password_encrypted = '' WHERE account_id = ?").run(context.account.id);
  assert.throws(() => context.reloginService.getCodePage(id, token), { status: 404 });
  context.db.prepare("UPDATE account_inbox_configs SET password_encrypted = 'synthetic' WHERE account_id = ?").run(context.account.id);
  context.repositories.deleteAccount(context.account.id);
  assert.throws(() => context.reloginService.getCodePage(id, token), { status: 404 });
});

test("慢同步不阻塞 HTTP，同账号后台同步互斥并按八秒节流", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = createReloginMailContext({ sync: () => gate });
  t.after(async () => { release(); await context.cleanup(); });
  const first = await resolve(context);
  const second = await resolve(context, context.addresses[1].email);
  await request(context.app).get(codePath(first)).timeout({ response: 1000 }).expect(200);
  await setImmediate();
  context.setNow(Date.UTC(2026, 9, 30, 3, 0, 20));
  await request(context.app).get(codePath(second)).timeout({ response: 1000 }).expect(200);
  assert.equal(context.syncCalls.length, 1);
  release(); await setImmediate();
  await request(context.app).get(codePath(first)).expect(200);
  assert.equal(context.syncCalls.length, 2);
});

test("签发失败不写凭据且错误脱敏，独立限流不占用原领取额度", async t => {
  const context = createReloginMailContext(); t.after(() => context.cleanup());
  context.reloginRepository.issue = () => {
    throw Object.assign(new Error("private-token-database-path"), { code: "SQLITE_BUSY" });
  };
  const failed = await request(context.app).post(resolvePath)
    .set("Authorization", `Bearer ${context.config.reloginMail.token}`)
    .send({ email: context.addresses[0].email }).expect(503);
  assert.doesNotMatch(failed.text, /private|database-path/);
  for (let index = 0; index < 59; index++) await request(context.app).post(resolvePath).send({}).expect(401);
  await request(context.app).post(resolvePath).send({}).expect(429);
  await request(context.app).post("/api/v1/mailboxes")
    .set("Authorization", `Bearer ${context.config.mailApi.token}`).send({}).expect(201);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM mail_api_relogin_accesses").get().n, 0);
});
