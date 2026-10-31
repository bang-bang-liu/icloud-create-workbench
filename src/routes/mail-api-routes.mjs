import { Router, json } from "express";
import { rateLimit } from "express-rate-limit";

const messages = {
  400: "请求体必须为 JSON 对象，且仅包含可选的 local_part、subdomain 字符串",
  401: "邮箱池 API 凭据无效", 404: "取码链接无效", 409: "没有可领取的邮箱",
  410: "取码链接已过期", 413: "请求体过大", 429: "请求过于频繁", 503: "邮箱池 API 未就绪"
};

/** 创建面向机器调用的独立路由，不使用管理端 Cookie 或 Origin 校验。 */
export function createMailApiRouter(service) {
  const router = Router();
  const claimLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true,
    legacyHeaders: false, message: { error: messages[429] } });
  const codeLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true,
    legacyHeaders: false, message: { error: messages[429] } });

  /** 禁用凭据及验证码响应缓存，避免链接作为来源地址泄露。 */
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  /** 配置缺失只关闭本 API，保留原管理端可用性。 */
  function requireReady(req, res, next) {
    if (!service?.isReady()) return res.status(503).json({ error: messages[503] });
    next();
  }

  /** 领取请求必须持有独立 Bearer Token，不能依赖浏览器登录状态。 */
  function requireToken(req, res, next) {
    if (!service.authorize(req.get("authorization"))) return res.status(401).json({ error: messages[401] });
    next();
  }

  /** 只检查就绪状态，不触发 IMAP 同步或库存分配。 */
  router.get("/health", requireReady, (req, res) => res.json({ ok: true }));

  /** 兼容空对象领邮箱契约，拒绝通过请求体扩展库存范围。 */
  router.post("/mailboxes", claimLimiter, requireReady, requireToken, json({ limit: "4kb" }), (req, res) => {
    const body = req.body ?? {};
    const unparsed = req.body === undefined && (Number(req.get("content-length")) > 0 || req.get("transfer-encoding"));
    if (unparsed || !body || typeof body !== "object" || Array.isArray(body)
      || Object.entries(body).some(([key, value]) => !["local_part", "subdomain"].includes(key)
        || typeof value !== "string" || value.length > 253)) {
      return res.status(400).json({ error: messages[400] });
    }
    res.status(201).json(service.claim());
  });

  /** 取码依赖领取链接内的独立 Token，无需再发送全局 Authorization。 */
  router.get("/mailboxes/:claimId/code", codeLimiter, requireReady, (req, res) => {
    const page = service.getCodePage(req.params.claimId, req.query.token);
    res.type("html").send(page);
  });

  /** 新 API 的异常统一脱敏，避免底层错误和请求中的密钥进入输出。 */
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = String(error?.code || "").startsWith("SQLITE_BUSY") ? 503
      : Object.hasOwn(messages, error.status) ? Number(error.status) : 500;
    if (status === 500) console.error("[mail-api] 请求处理失败");
    res.status(status).type("json").json({ error: messages[status] || "邮箱池 API 处理失败" });
  });
  return router;
}
