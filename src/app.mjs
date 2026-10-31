import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAuthRouter } from "./routes/auth-routes.mjs";
import { createAccountRouter } from "./routes/account-routes.mjs";
import { createAddressRouter } from "./routes/address-routes.mjs";
import { createInboxRouter } from "./routes/inbox-routes.mjs";
import { createTaskRouter } from "./routes/task-routes.mjs";
import { createCampaignRouter } from "./routes/campaign-routes.mjs";
import { createMessageRouter } from "./routes/message-routes.mjs";
import { createPublicMailRouter } from "./routes/public-mail-routes.mjs";
import { createMailApiRouter } from "./routes/mail-api-routes.mjs";
import { requireAdmin, requireTrustedOrigin } from "./middleware.mjs";
import { verifyAdminToken } from "./security.mjs";

/** 创建配置完整的 Express 应用。 */
export function createApp({ config, repositories, icloudService, inboxService, campaignService, publicMailService, mailApiService }) {
  const app = express();
  const skyrocDir = join(process.cwd(), "frontend", "apps", "admin", "dist");
  const legacyDir = join(process.cwd(), "public");
  const frontendDir = existsSync(join(skyrocDir, "index.html")) ? skyrocDir : legacyDir;
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    "connect-src": ["'self'", "https://api.iconify.design", "https://api.unisvg.com", "https://api.simplesvg.com"],
    "upgrade-insecure-requests": null
  } } }));
  app.use("/api/v1", createMailApiRouter(mailApiService));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use(requireTrustedOrigin(config));

  /** 返回不含敏感信息的健康状态。 */
  app.get("/api/health", (req, res) => res.json({ ok: true, service: "icloud-create-workbench" }));
  app.use("/openapi", createPublicMailRouter(config, publicMailService));
  app.use("/api/auth", createAuthRouter(config));

  const requireApiAdmin = requireAdmin(config);
  app.use("/api/icloud-accounts", requireApiAdmin, createAccountRouter({ repositories, icloudService }));
  app.use("/api/addresses", requireApiAdmin, createAddressRouter(repositories, publicMailService));
  app.use("/api/messages", requireApiAdmin, createMessageRouter(repositories));
  app.use("/api/inbox", requireApiAdmin, createInboxRouter({ inboxService, repositories }));
  app.use("/api/generation-jobs", requireApiAdmin, createTaskRouter(repositories));
  app.use("/api/generation-campaigns", requireApiAdmin, createCampaignRouter(campaignService));

  for (const directory of ["assets", "css", "js"]) {
    app.use(`/${directory}`, express.static(join(frontendDir, directory), { maxAge: "1h" }));
  }
  app.get("/favicon.ico", (req, res) => res.sendFile(join(frontendDir, "favicon.ico")));
  app.get("/favicon.svg", (req, res) => res.sendFile(join(frontendDir, "favicon.svg")));

  /** 返回公开邮件或登录页面的 React 入口。 */
  const sendFrontend = (req, res) => {
    // 入口文件引用带哈希的构建资源，禁止缓存可避免部署后继续加载旧版本模块。
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, no-transform");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(join(frontendDir, "index.html"));
  };
  app.get(["/login", "/login/", "/login.html", "/login-out"], sendFrontend);
  app.get("/mail/:email/:token", (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Referrer-Policy", "no-referrer");
    sendFrontend(req, res);
  });

  /** 在服务器侧校验管理页面会话并返回 React 入口。 */
  app.get(["/", "/index.html", "/home", "/overview", "/accounts", "/tasks", "/addresses", "/addresses/:id", "/inbox", "/guide"], (req, res) => {
    try {
      verifyAdminToken(req.cookies?.workbench_admin, config);
      sendFrontend(req, res);
    } catch {
      res.redirect("/login");
    }
  });

  /** 将业务异常转换为统一 JSON，避免输出堆栈和敏感参数。 */
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status || 500);
    if (status >= 500) console.error(`${new Date().toISOString()} ${req.method} ${req.path}: ${error.message}`);
    const body = { error: status >= 500 ? "服务器处理请求失败" : error.message };
    if (error.cooldownUntil) body.cooldownUntil = error.cooldownUntil;
    res.status(status).json(body);
  });
  return app;
}
