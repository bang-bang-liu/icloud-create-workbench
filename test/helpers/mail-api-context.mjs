import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createDatabase } from "../../src/db.mjs";
import { createRepositories } from "../../src/repositories.mjs";
import { createMailApiRepository } from "../../src/repositories/mail-api-repository.mjs";
import { createMailApiService } from "../../src/services/mail-api-service.mjs";
import { createPublicMailService } from "../../src/services/public-mail-service.mjs";
import { readMailApiConfig } from "../../src/mail-api-config.mjs";
import { createApp } from "../../src/app.mjs";
import { encryptSecret } from "../../src/security.mjs";

/** 创建完全隔离的本地邮箱池测试环境，所有数据均为虚构数据。 */
export function createMailApiContext(options = {}) {
  const base = resolve(".cache/mail-api-tests");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "case-"));
  const databasePath = join(directory, "test.db");
  const db = createDatabase(databasePath);
  const repositories = createRepositories(db);
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const account = repositories.upsertAccount({ identityKey: "mail-api-test", appleId: "owner@example.test",
    region: "global", cookieEncrypted: encryptSecret("cookie-test-value", encryptionKey) });
  repositories.saveInboxConfig(account.id, { host: "imap.example.test", port: 993, secure: true,
    email: "owner@example.test", passwordEncrypted: encryptSecret("imap-test-value", encryptionKey), mailbox: "INBOX" });
  let timestamp = Date.UTC(2026, 9, 30, 3, 0, 0);
  const config = { appOrigin: "http://127.0.0.1:4173", adminUsername: "admin", adminPassword: "admin-test-password",
    jwtSecret: "mail-api-jwt-test-value-at-least-32-characters", jwtExpiresIn: "8h", cookieSecure: false,
    publicMailRateLimit: 60, encryptionKey,
    mailApi: readMailApiConfig({ MAIL_API_ENABLED: "true", MAIL_API_TOKEN: "t".repeat(48),
      MAIL_API_ACCOUNT_ID: account.id, MAIL_API_LABEL_PREFIX: "sentinel-",
      MAIL_API_ORIGIN: "https://mail.example.test", ...options.env }, "http://127.0.0.1:4173") };
  const syncCalls = [];
  const warnings = [];
  const inboxService = {
    /** 记录虚构同步请求，测试期间永不连接真实 IMAP。 */
    sync(accountId) { syncCalls.push(accountId); return options.sync?.(accountId); },
    /** 返回固定测试配置状态，不暴露真实配置。 */
    getConfig() { return { configured: true }; }
  };
  const repository = createMailApiRepository(db);
  const service = createMailApiService({ config, repository, inboxService, now: () => timestamp,
    logger: { warn: message => warnings.push(message) } });
  const publicMailService = createPublicMailService({ config, repositories });
  const app = createApp({ config, repositories, inboxService, publicMailService,
    mailApiService: service, icloudService: {}, campaignService: {} });

  /** 添加库存并可设置固定创建时间、状态及所属账号。 */
  function seedAddress({ email, label = "sentinel-001", accountId = account.id, state = "unused",
    createdAt = "2026-10-29T00:00:00.000Z" }) {
    repositories.upsertAddresses(accountId, null, [{ email, label, createdAt }], "generated");
    const address = db.prepare("SELECT id FROM hidden_addresses WHERE email = ?").get(email);
    if (state !== "unused") repositories.updateAddressState(address.id, state);
    return repositories.getAddress(address.id);
  }

  /** 添加一封虚构邮件，固定所属地址和邮件原时间。 */
  function seedMessage(email, input = {}) {
    return repositories.insertMessage(account.id, { uid: `mail-${Math.random()}`, recipient: email,
      code: "123456", receivedAt: new Date(timestamp + 2_000).toISOString(), ...input });
  }

  /** 调整服务时钟，以便无需实际等待地测试期限和同步节流。 */
  function setNow(value) { timestamp = value; }

  /** 删除前验证目标严格位于本项目测试目录内，保护真实数据目录。 */
  async function cleanup() {
    await service.close();
    db.close();
    const target = resolve(directory);
    if (!target.startsWith(base + sep)) throw new Error("测试目录越界，拒绝清理");
    rmSync(target, { recursive: true, force: true });
  }

  const addresses = Array.from({ length: options.count ?? 3 }, (_, index) => seedAddress({
    email: `sentinel-${index + 1}@icloud.com`, label: `sentinel-${String(index + 1).padStart(3, "0")}`,
    createdAt: `2026-10-29T00:00:${String(index).padStart(2, "0")}.000Z`
  }));
  return { app, db, databasePath, config, account, addresses, repository, repositories, service,
    publicMailService, encryptionKey, syncCalls, warnings, seedAddress, seedMessage, setNow, cleanup };
}

/** 从响应的绝对地址构造本地 HTTP 测试路径，保留领取 Token。 */
export function codePath(mailbox) {
  const url = new URL(mailbox.code_url);
  return url.pathname + url.search;
}
