/** 读取重登专用密钥，邮箱范围沿用既有邮箱池设置且不修改原配置。 */
export function readReloginMailConfig(env, mailApi) {
  const token = String(env.MAIL_API_RELOGIN_TOKEN || "").trim();
  const config = { enabled: Boolean(mailApi?.enabled && token), token,
    origin: mailApi?.origin, accountId: mailApi?.accountId, labelPrefix: mailApi?.labelPrefix,
    error: mailApi?.error || "" };
  if (token && (token.length < 32 || token.length > 512 || /\s/.test(token))) {
    config.error = "MAIL_API_RELOGIN_TOKEN 必须是 32 至 512 字符的独立随机密钥";
  }
  return config;
}
