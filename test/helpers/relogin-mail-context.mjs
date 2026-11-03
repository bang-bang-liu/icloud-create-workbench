import { createMailApiContext } from "./mail-api-context.mjs";
import { createApp } from "../../src/app.mjs";
import { readReloginMailConfig } from "../../src/relogin-mail-config.mjs";
import { createReloginMailRepository } from "../../src/repositories/relogin-mail-repository.mjs";
import { createReloginMailService } from "../../src/services/relogin-mail-service.mjs";

/** 扩展合成邮箱环境，重登与原领取服务共享测试数据库但使用各自密钥。 */
export function createReloginMailContext(options = {}) {
  const context = createMailApiContext(options);
  let timestamp = Date.UTC(2026, 9, 30, 3);
  context.config.reloginMail = readReloginMailConfig({ MAIL_API_RELOGIN_TOKEN: "r".repeat(48),
    ...options.env }, context.config.mailApi);
  const repository = createReloginMailRepository(context.db);
  const inboxService = {
    /** 只记录同步次数，完全不访问真实邮箱。 */
    sync(accountId) { context.syncCalls.push(accountId); return options.sync?.(accountId); }
  };
  const service = createReloginMailService({ config: context.config, repository, inboxService,
    now: () => timestamp, logger: { warn: message => context.warnings.push(message) } });
  const app = createApp({ config: context.config, repositories: context.repositories, inboxService,
    publicMailService: context.publicMailService, mailApiService: context.service,
    reloginMailService: service, icloudService: {}, campaignService: {} });

  /** 保持新旧服务时钟一致，直接模拟跨日与过期。 */
  function setNow(value) { timestamp = value; context.setNow(value); }

  /** 等待重登同步结束后使用原测试环境的受限目录清理。 */
  async function cleanup() { await service.close(); await context.cleanup(); }

  return { ...context, app, reloginService: service, reloginRepository: repository, setNow, cleanup };
}
