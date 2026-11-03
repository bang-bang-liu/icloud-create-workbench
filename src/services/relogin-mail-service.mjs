import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** 只保存固定长度哈希，不持久化取码密钥明文。 */
function hashToken(value) { return createHash("sha256").update(value).digest(); }

/** 取码页只显示经过转义的邮件文本。 */
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

/** 保持现有读取器支持的 UTC 时间和六位验证码 HTML 格式。 */
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
    + `<title>重登邮箱验证码</title></head><body><h1>${escapeHtml(email)}</h1>${cards.join("\n")}</body></html>`;
}

/** 为已有邮箱签发本轮取码链接，与原领取及公开访问凭据隔离。 */
export function createReloginMailService({ config, repository, inboxService, now = Date.now, logger = console }) {
  const settings = config.reloginMail;
  const lastSyncAt = new Map();
  const activeSyncs = new Set();
  const pending = new Set();
  let stopped = false;
  if (settings?.error) logger.warn(`[relogin-mail] ${settings.error}`);

  /** 配置错误只关闭重登接口，保留原管理端和注册邮箱服务。 */
  function isReady() {
    if (stopped || !settings?.enabled || settings.error) return false;
    try { return repository.isReady(settings.accountId); }
    catch { return false; }
  }

  /** 仅接受重登专用 Bearer 密钥，不接受注册密钥或管理员 Cookie。 */
  function authorize(header) {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ""));
    return Boolean(settings?.enabled && !settings.error && match
      && timingSafeEqual(hashToken(match[1]), hashToken(settings.token)));
  }

  /** 每次为指定邮箱生成新的一小时链接，不撤销其他尚未过期的链接。 */
  function resolve(email) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const timestamp = now();
    const expiresAt = new Date(timestamp + 3_600_000).toISOString();
    const mailbox = repository.issue({ id, email, accountId: settings.accountId, labelPrefix: settings.labelPrefix,
      tokenHash: hashToken(token).toString("hex"), createdAt: new Date(timestamp).toISOString(), expiresAt });
    return { email: mailbox.email,
      code_url: `${settings.origin}/api/v1/relogin/access/${id}/code?token=${token}`, expires_at: expiresAt };
  }

  /** 复用现有收件实例的账号互斥，同账号最多每八秒触发一次后台同步。 */
  function triggerSync(accountId) {
    const timestamp = now();
    const previous = lastSyncAt.get(accountId);
    if (stopped || activeSyncs.has(accountId) || (previous !== undefined && timestamp - previous < 8_000)) return;
    lastSyncAt.set(accountId, timestamp);
    activeSyncs.add(accountId);
    const task = Promise.resolve().then(() => inboxService.sync(accountId)).catch(error => {
      if (error?.status !== 409) logger.warn("[relogin-mail] 收件同步失败，将在后续轮询重试");
    }).finally(() => { activeSyncs.delete(accountId); pending.delete(task); });
    pending.add(task);
  }

  /** 验证本轮凭据及有效期，返回邮件缓存并异步触发正常收件。 */
  function getCodePage(id, token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw Object.assign(new Error("取码链接无效"), { status: 404 });
    }
    const record = repository.getAccess({ id, tokenHash: hashToken(token).toString("hex"),
      accountId: settings.accountId, labelPrefix: settings.labelPrefix });
    if (!record) throw Object.assign(new Error("取码链接无效"), { status: 404 });
    if (Date.parse(record.expiresAt) <= now()) throw Object.assign(new Error("取码链接已过期"), { status: 410 });
    const after = new Date(Date.parse(record.createdAt) - 5_000).toISOString();
    const messages = repository.listMessages(record.addressId, after);
    triggerSync(record.accountId);
    return renderCodePage(record.email, messages);
  }

  /** 退出时等待本模块已启动的收件任务结束。 */
  async function close() { stopped = true; await Promise.allSettled([...pending]); }

  return { isReady, authorize, resolve, getCodePage, close };
}
