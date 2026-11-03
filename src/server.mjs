import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";
import { createRepositories } from "./repositories.mjs";
import { callPythonBridge } from "./python-bridge.mjs";
import { createIcloudService } from "./services/icloud-service.mjs";
import { createInboxService } from "./services/inbox-service.mjs";
import { createCampaignService } from "./services/campaign-service.mjs";
import { createPublicMailService } from "./services/public-mail-service.mjs";
import { createInboxSyncWorker } from "./services/inbox-sync-worker.mjs";
import { createApp } from "./app.mjs";
import { createMailApiRepository } from "./repositories/mail-api-repository.mjs";
import { createMailApiService } from "./services/mail-api-service.mjs";
import { createReloginMailRepository } from "./repositories/relogin-mail-repository.mjs";
import { createReloginMailService } from "./services/relogin-mail-service.mjs";

/** 启动数据库、服务依赖和 HTTP 监听。 */
function main() {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const repositories = createRepositories(db);
  const recovered = repositories.recoverRunningJobs();
  if (recovered) console.warn(`已恢复 ${recovered} 个被中断的生成任务`);
  const icloudService = createIcloudService({ config, repositories, callBridge: callPythonBridge });
  const inboxService = createInboxService({ config, repositories });
  const mailApiService = createMailApiService({ config, repository: createMailApiRepository(db), inboxService });
  const reloginMailService = createReloginMailService({ config,
    repository: createReloginMailRepository(db), inboxService });
  const campaignService = createCampaignService({ config, repositories, icloudService });
  const publicMailService = createPublicMailService({ config, repositories });
  const inboxSyncWorker = createInboxSyncWorker({ config, repositories, inboxService });
  campaignService.start();
  inboxSyncWorker.start();
  const app = createApp({ config, repositories, icloudService, inboxService, campaignService, publicMailService, mailApiService, reloginMailService });
  const server = app.listen(config.port, config.host, error => {
    if (error) {
      console.error(`HTTP 监听失败：${error.message}`);
      campaignService.close();
      inboxSyncWorker.close();
      void mailApiService.close();
      void reloginMailService.close();
      db.close();
      process.exitCode = 1;
      return;
    }
    console.log(`iCloud 生产控制台已启动：http://${config.host}:${config.port}`);
  });
  const shutdown = signal => {
    console.log(`收到 ${signal}，正在关闭服务`);
    campaignService.close();
    inboxSyncWorker.close();
    server.close(async () => {
      await Promise.all([mailApiService.close(), reloginMailService.close()]);
      db.close(); process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
