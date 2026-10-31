/** 读取独立邮箱池配置，错误仅影响新 API，不阻断管理端启动。 */
export function readMailApiConfig(env, appOrigin) {
  const flag = String(env.MAIL_API_ENABLED || "false").trim().toLowerCase();
  const config = {
    enabled: ["1", "true", "yes", "on"].includes(flag),
    token: String(env.MAIL_API_TOKEN || "").trim(),
    origin: String(env.MAIL_API_ORIGIN || appOrigin || "").trim(),
    accountId: String(env.MAIL_API_ACCOUNT_ID || "").trim(),
    labelPrefix: String(env.MAIL_API_LABEL_PREFIX || "").trim(),
    error: ""
  };
  if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(flag)) {
    config.error = "MAIL_API_ENABLED 必须是明确的布尔值";
  }
  if (!config.enabled) return config;
  if (config.token.length < 32 || config.token.length > 512 || /\s/.test(config.token)) {
    config.error = "MAIL_API_TOKEN 必须是 32 至 512 字符的独立随机密钥";
  } else if (!config.accountId || config.accountId.length > 128) {
    config.error = "MAIL_API_ACCOUNT_ID 必须指定已有的收件账号";
  } else if (!config.labelPrefix || config.labelPrefix.length > 100) {
    config.error = "MAIL_API_LABEL_PREFIX 必须指定独立库存前缀，长度不超过 100";
  }
  try {
    const url = new URL(config.origin);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("地址格式无效");
    }
    config.origin = url.origin;
  } catch {
    config.error = "MAIL_API_ORIGIN 必须为 HTTPS 或回环 HTTP 源地址，不能带路径或凭据";
  }
  return config;
}
