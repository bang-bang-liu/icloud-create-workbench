import "dotenv/config";
import { resolve } from "node:path";
import { readMailApiConfig } from "./mail-api-config.mjs";

/** 将环境变量转换为限定范围内的整数。 */
function readInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return value;
}

/** 校验必填环境变量，避免使用不安全的默认密钥启动。 */
function requireSecret(name, minimumLength) {
  const value = String(process.env[name] || "").trim();
  if (!value || value.length < minimumLength || /示例|change|replace|your-/i.test(value)) {
    throw new Error(`${name} 未配置或长度不足`);
  }
  return value;
}

/** 读取可直接用于登录的管理员明文密码。 */
function readAdminPassword() {
  const value = String(process.env.ADMIN_PASSWORD || "");
  if (value && value.length < 10) throw new Error("ADMIN_PASSWORD 长度至少为 10 位");
  return value;
}

/** 读取并校验应用配置。 */
export function loadConfig(overrides = {}) {
  const adminPassword = readAdminPassword();
  const config = {
    nodeEnv: process.env.NODE_ENV || "development",
    host: process.env.HOST || "127.0.0.1",
    port: readInteger("PORT", 4173, 1, 65535),
    appOrigin: String(process.env.APP_ORIGIN || "http://127.0.0.1:4173").replace(/\/$/, ""),
    adminUsername: String(process.env.ADMIN_USERNAME || "admin").trim(),
    adminPassword,
    adminPasswordHash: adminPassword ? "" : requireSecret("ADMIN_PASSWORD_HASH", 32),
    jwtSecret: requireSecret("JWT_SECRET", 32),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
    cookieSecure: String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true",
    encryptionKey: requireSecret("DATA_ENCRYPTION_KEY", 40),
    databasePath: resolve(process.env.DATABASE_PATH || "./data/workbench.db"),
    batchLimit: readInteger("GENERATION_BATCH_LIMIT", 5, 1, 5),
    cooldownMinutes: readInteger("GENERATION_COOLDOWN_MINUTES", 60, 1, 1440),
    targetDefault: readInteger("GENERATION_TARGET_DEFAULT", 700, 1, 700),
    retryMinutes: readInteger("GENERATION_RETRY_MINUTES", 5, 1, 60),
    inboxSyncIntervalSeconds: readInteger("INBOX_SYNC_INTERVAL_SECONDS", 30, 10, 3600),
    inboxSyncConcurrency: readInteger("INBOX_SYNC_CONCURRENCY", 2, 1, 10),
    publicMailRateLimit: readInteger("PUBLIC_MAIL_RATE_LIMIT", 60, 10, 1000),
    pythonCommand: process.env.PYTHON_COMMAND || "python",
    pythonBridge: resolve(process.env.PYTHON_BRIDGE || "./python/hme_bridge.py"),
    logLevel: process.env.LOG_LEVEL || "info"
  };
  config.mailApi = readMailApiConfig(process.env, config.appOrigin);
  return { ...config, ...overrides };
}
