import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** 对凭据计算固定长度哈希，领取密钥的明文不写入数据库。 */
function hashToken(value) { return createHash("sha256").update(value).digest(); }

/** 将邮件内容作为纯文本嵌入 HTML，禁止原始邮件脚本进入取码页。 */
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

/** 输出 sentinel 可直接解析的 UTC 时间和六位验证码卡片。 */
function renderCodePage(email, messages) {
  const cards = messages.flatMap(message => {
    const timestamp = Date.parse(message.receivedAt);
    const code = String(message.code || "");
    if (!Number.isFinite(timestamp) || !/^\d{6}$/.test(code)) return [];
    const time = new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
    return [`<article><h2>${escapeHtml(message.subject)}</h2><p>${escapeHtml(message.sender)}</p>`
      + `<div class="meta">Time: ${time}</div><div class="code">${code}</div></article>`];
  });
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + `<title>iCloud 邮箱验证码</title></head><body><h1>${escapeHtml(email)}</h1>${cards.join("\n")}</body></html>`;
}

/** 创建统一邮箱池服务，复用现有收件实例并让慢 IMAP 与 HTTP 取码解耦。 */
export function createMailApiService({ config, repository, inboxService, now = Date.now, logger = console }) {
  const settings = config.mailApi;
  const lastSyncAt = new Map();
  const activeSyncs = new Set();
  const pending = new Set();
  let stopped = false;
  if (settings?.error) logger.warn(`[mail-api] ${settings.error}`);

  /** 查询 API 配置和数据库就绪状态，健康检查不占用邮箱。 */
  function isReady() {
    if (stopped || !settings?.enabled || settings.error) return false;
    try { return repository.isReady(settings.accountId); }
    catch { return false; }
  }

  /** 使用固定长度比较校验全局 Bearer 凭据，不接受管理员 Cookie 代替。 */
  function authorize(header) {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ""));
    return Boolean(settings?.enabled && !settings.error && match
      && timingSafeEqual(hashToken(match[1]), hashToken(settings.token)));
  }

  /** 领取已有邮箱并返回独立的一小时取码凭据，不改动旧公开链接。 */
  function claim() {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const timestamp = now();
    const expiresAt = new Date(timestamp + 3_600_000).toISOString();
    const mailbox = repository.claim({ id, accountId: settings.accountId, labelPrefix: settings.labelPrefix,
      tokenHash: hashToken(token).toString("hex"), createdAt: new Date(timestamp).toISOString(), expiresAt });
    return { email: mailbox.email,
      code_url: `${settings.origin}/api/v1/mailboxes/${id}/code?token=${token}`, expires_at: expiresAt };
  }

  /** 同一账号最多每八秒触发一次同步，已有同步仍未完成时不重复请求。 */
  function triggerSync(accountId) {
    const timestamp = now();
    const previous = lastSyncAt.get(accountId);
    if (stopped || activeSyncs.has(accountId) || (previous !== undefined && timestamp - previous < 8_000)) return;
    lastSyncAt.set(accountId, timestamp);
    activeSyncs.add(accountId);
    const task = Promise.resolve().then(() => inboxService.sync(accountId)).catch(error => {
      if (error?.status !== 409) logger.warn("[mail-api] 收件同步失败，将在后续轮询重试");
    }).finally(() => { activeSyncs.delete(accountId); pending.delete(task); });
    pending.add(task);
  }

  /** 校验独立取码密钥、期限和原邮件时间窗口，立即返回当前缓存。 */
  function getCodePage(id, token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw Object.assign(new Error("取码链接无效"), { status: 404 });
    }
    const record = repository.getClaim(id, hashToken(token).toString("hex"));
    if (!record) throw Object.assign(new Error("取码链接无效"), { status: 404 });
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now()) {
      throw Object.assign(new Error("取码链接已过期"), { status: 410 });
    }
    const after = new Date(Date.parse(record.createdAt) - 5_000).toISOString();
    const messages = repository.listMessages(record.addressId, after);
    triggerSync(record.accountId);
    return renderCodePage(record.email, messages);
  }

  /** 关闭时停止触发新同步，等待本服务已经启动的收件任务结束。 */
  async function close() { stopped = true; await Promise.allSettled([...pending]); }

  return { isReady, authorize, claim, getCodePage, close };
}
