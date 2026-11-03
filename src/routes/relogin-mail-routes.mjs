import { Router, json } from "express";
import { rateLimit } from "express-rate-limit";

const messages = {
  400: "请求体必须为仅包含 email 的 JSON 对象", 401: "重登邮箱接口凭据无效",
  404: "取码链接无效", 410: "取码链接已过期", 413: "请求体过大",
  429: "请求过于频繁", 503: "重登邮箱接口未就绪"
};

/** 创建独立重登路由，不依赖管理端会话，不调用邮箱领取接口。 */
export function createReloginMailRouter(service) {
  const router = Router();
  const resolveLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true,
    legacyHeaders: false, message: { error: messages[429] } });
  const codeLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true,
    legacyHeaders: false, message: { error: messages[429] } });

  /** 禁止缓存取码凭据与验证码，避免作为来源地址发送。 */
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  /** 缺失配置仅使新增接口不可用。 */
  function requireReady(req, res, next) {
    if (!service?.isReady()) return res.status(503).json({ error: messages[503] });
    next();
  }

  /** 使用重登专用密钥签发临时链接。 */
  function requireToken(req, res, next) {
    if (!service.authorize(req.get("authorization"))) return res.status(401).json({ error: messages[401] });
    next();
  }

  /** 精确解析已有邮箱，每次签发独立凭据。 */
  router.post("/mailboxes/resolve", resolveLimiter, requireReady, requireToken, json({ limit: "4kb" }), (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
      || typeof body.email !== "string" || body.email.trim().length > 253
      || !/^[^\s@]+@[^\s@]+$/.test(body.email.trim())) {
      return res.status(400).json({ error: messages[400] });
    }
    try { res.status(201).json(service.resolve(body.email.trim())); }
    catch (error) {
      if (error.status !== 404) throw error;
      res.status(404).json({ error: "该邮箱没有可用的自动取码地址" });
    }
  });

  /** 读取仅凭本轮链接 Token 授权，不使用全局密钥。 */
  router.get("/access/:accessId/code", codeLimiter, requireReady, (req, res) => {
    res.type("html").send(service.getCodePage(req.params.accessId, req.query.token));
  });

  /** 错误不回传数据库内容、取码链接或密钥。 */
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = String(error?.code || "").startsWith("SQLITE_BUSY") ? 503
      : Object.hasOwn(messages, error.status) ? Number(error.status) : 500;
    if (status === 500) console.error("[relogin-mail] 请求处理失败");
    res.status(status).json({ error: messages[status] || "重登邮箱接口处理失败" });
  });
  return router;
}
