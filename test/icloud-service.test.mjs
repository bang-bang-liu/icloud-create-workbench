import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../src/db.mjs";
import { createRepositories } from "../src/repositories.mjs";
import { createIcloudService } from "../src/services/icloud-service.mjs";

/** 创建使用临时 SQLite 和模拟 Python 桥接的测试上下文。 */
function createContext() {
  const directory = mkdtempSync(join(tmpdir(), "icloud-workbench-"));
  const db = createDatabase(join(directory, "test.db"));
  const repositories = createRepositories(db);
  const config = {
    encryptionKey: randomBytes(32).toString("base64"),
    batchLimit: 5,
    cooldownMinutes: 60
  };
  const calls = [];
  const bridgeErrors = { validate: "", generate: "", list: "" };

  /** 模拟上游 CK 校验、生成和列表接口。 */
  async function callBridge(ignoredConfig, command, payload) {
    calls.push({ command, payload });
    if (bridgeErrors[command]) throw new Error(bridgeErrors[command]);
    if (command === "validate") return {
      ok: true,
      cookie: "X-APPLE-SECRET=value",
      region: "global",
      appleId: "owner@example.com",
      dsid: "123456",
      displayName: "测试账号",
      featureAvailable: true,
      userPartition: "68",
      maildomainHost: "p68-maildomainws.icloud.com"
    };
    if (command === "generate") return {
      ok: true,
      generated: payload.labels.map((label, index) => ({
        email: `hidden${index}@icloud.com`,
        label,
        createdAt: new Date().toISOString()
      })),
      errors: []
    };
    if (command === "list") return { ok: true, addresses: [], maildomainHost: "p68-maildomainws.icloud.com" };
    throw new Error("未知命令");
  }

  const service = createIcloudService({ config, repositories, callBridge });

  /** 设置指定桥接命令返回的错误。 */
  function setBridgeError(command, message) {
    bridgeErrors[command] = message;
  }

  /** 关闭测试数据库并删除临时目录。 */
  function cleanup() {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }

  return { repositories, service, calls, setBridgeError, cleanup };
}

test("导入 CK 后返回完整 Apple ID", async () => {
  const context = createContext();
  try {
    const stored = await context.service.importAccount("Cookie: X-APPLE-SECRET=value", "auto");
    const publicAccount = context.repositories.getAccount(stored.id);
    assert.equal(publicAccount.appleId, "owner@example.com");
    assert.equal("cookieEncrypted" in publicAccount, false);
    assert.equal(context.calls[0].command, "validate");
  } finally {
    context.cleanup();
  }
});

test("检测 CK 后持久化有效或过期状态", async () => {
  const context = createContext();
  try {
    const validAccount = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    const validResult = await context.service.checkCookie(validAccount.id);
    assert.equal(validResult.valid, true);
    assert.equal(context.repositories.getAccount(validAccount.id).status, "active");

    context.setBridgeError("validate", "CK 已失效");
    const expiredResult = await context.service.checkCookie(validAccount.id);
    assert.equal(expiredResult.valid, false);
    assert.equal(expiredResult.account.status, "expired");
  } finally {
    context.cleanup();
  }
});

test("历史脱敏账号过期后不再显示星号 Apple ID", () => {
  const context = createContext();
  try {
    const account = context.repositories.upsertAccount({
      identityKey: "legacy",
      appleId: "ow***@example.com",
      dsid: "legacy",
      displayName: "历史账号",
      region: "global",
      userPartition: "68",
      maildomainHost: "p68-maildomainws.icloud.com",
      cookieEncrypted: "encrypted"
    });
    context.repositories.markAccountExpired(account.id);
    assert.equal(context.repositories.getAccount(account.id).appleId, "无法获取（CK 已过期）");
  } finally {
    context.cleanup();
  }
});

test("手动更新同账号 CK 时保留原账号和库存数据", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("Cookie: old=value", "auto");
    context.repositories.upsertAddresses(account.id, null, [{ email: "keep@icloud.com", label: "keep-001" }], "synced");
    await context.service.updateCookie(account.id, "Cookie: renewed=value", "auto");
    assert.equal(context.repositories.listAccounts().length, 1);
    assert.equal(context.repositories.listAddresses({ accountId: account.id }).length, 1);
    assert.equal(context.calls.at(-1).command, "validate");
  } finally {
    context.cleanup();
  }
});

test("批量生成成功后写入邮箱并强制冷却", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    const result = await context.service.generate(account.id, 2, "changsheng");
    assert.equal(result.generated.length, 2);
    assert.equal(context.repositories.listAddresses({ accountId: account.id }).length, 2);
    await assert.rejects(() => context.service.generate(account.id, 1, "changsheng"), error => error.status === 409);
  } finally {
    context.cleanup();
  }
});

test("生成数量超过五个时由后端拒绝", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    await assert.rejects(() => context.service.generate(account.id, 6, "changsheng"), error => error.status === 400);
  } finally {
    context.cleanup();
  }
});

test("同一 CK 只能占用一个活动批次任务名额", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    const first = context.repositories.createJobWithLabels(account.id, "first", 1);
    assert.deepEqual(first.labels, ["first-001"]);
    assert.throws(
      () => context.repositories.createJobWithLabels(account.id, "second", 1),
      error => error.status === 409
    );
    assert.equal(context.repositories.getAccountInternal(account.id).label_sequence, 1);
  } finally {
    context.cleanup();
  }
});

test("生成前自动回收超时的遗留任务", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    const staleJob = context.repositories.createJob(account.id, 5);
    context.repositories.startJob(staleJob.id);
    assert.equal(context.repositories.recoverStaleJobs(account.id, 0), 1);
    const result = await context.service.generate(account.id, 1, "recovered");
    assert.equal(result.generated.length, 1);
  } finally {
    context.cleanup();
  }
});

test("同步成功后持久化桥接层探测到的有效分片", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    context.repositories.updateMaildomainHost(account.id, "p213-maildomainws.icloud.com");
    await context.service.syncAddresses(account.id);
    assert.equal(context.repositories.getAccountInternal(account.id).maildomain_host, "p68-maildomainws.icloud.com");
  } finally {
    context.cleanup();
  }
});

test("生成时遇到 Invalid global session 会标记 CK 过期", async () => {
  const context = createContext();
  try {
    const account = await context.service.importAccount("X-APPLE-SECRET=value", "auto");
    context.setBridgeError("generate", "Invalid global session");
    await assert.rejects(
      () => context.service.generate(account.id, 1, "changsheng"),
      error => error.status === 410 && error.accountExpired === true
    );
    assert.equal(context.repositories.getAccount(account.id).status, "expired");
  } finally {
    context.cleanup();
  }
});
