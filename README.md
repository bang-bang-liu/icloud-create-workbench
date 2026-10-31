# iCloud 隐藏邮箱生产控制台

这是一个单管理员、多 CK 的服务器控制台。Node.js 负责 Web、JWT、SQLite 和调度，Python 调用固定版本的 `hidemyemail-generator` 完成 iCloud 操作。

## 功能

- 管理员 JWT 登录，Cookie 使用 `HttpOnly + SameSite=Strict`
- CK 与 IMAP 密码使用 AES-256-GCM 加密保存
- 多 CK 工作台、账号检测和 Apple 邮箱同步
- 自动验证 maildomain 分片，错误的用户分区主机名会回退到区域默认节点
- 每条 CK 每批最多生成 5 个，成功后强制冷却 60 分钟
- 持久化生产目标默认库存 700，可停止、继续并自动按冷却周期执行
- 未使用、已使用、垃圾箱状态与 CSV 导出
- 邮箱、批次记录和邮件分页，支持批量修改使用状态
- 每条 CK 独立 IMAP 配置、验证码提取和邮件预览
- 每 30 秒按 CK 增量同步 IMAP，首次最多读取最近 100 封
- 每个隐私邮箱可生成独立开放密钥，提供 JSON 最新邮件接口和只读网页
- 面向 sentinel-rs 的统一邮箱池 API：原子领取已有邮箱、独立密钥、HTML 验证码卡片，默认关闭
- Skyroc Admin v3 管理界面、响应式布局、暗色主题和库存分页
- Docker 镜像、SQLite 持久卷、健康检查和在线备份

## 开放邮件接口

在“邮箱库存”中点击“开放链接”，系统会生成一组仅展示一次的密钥和两个地址：

```text
GET /openapi/mail/:email/:token/latest
GET /mail/:email/:token
```

JSON 接口返回该隐私邮箱在本地数据库中的最新邮件；暂无邮件时返回 `message: null`。重置或撤销后，旧密钥立即失效。开放请求不会临时连接 IMAP，后台同步器默认每 30 秒更新本地邮件。

## 统一邮箱池 API

新增 `/api/v1/health`、`POST /api/v1/mailboxes` 及领取后返回的 HTML 取码地址，
兼容 sentinel-rs 的通用邮箱契约。新 API 使用独立 Bearer Token，从明确配置的账号和标签范围领取
`unused` 邮箱，取码时按账号节流触发后台同步。领取后标记为 `used`，不会自动生产或回收邮箱。

默认不启用，也不轮换现有公开链接。freeAgentIdentity 继续使用旧接口，启用时需要为新 API
选择不重叠的库存范围。配置、接口、HTTPS 接入、数据备份和回滚步骤见 [统一邮箱池 API 接入说明](docs/mail-api.md)。

## 获取 iCloud CK

### 调试插件

仓库内置 Chrome / Edge 调试插件：`extensions/icloud-ck-extractor`。在浏览器扩展管理页开启开发者模式并“加载已解压的扩展程序”后，登录 iCloud+、打开“隐藏邮件地址”，即可自动捕获并复制 CK。详细步骤见插件目录内的 `README.md`。

### 推荐方法：Network 复制为 cURL

请按下面步骤获取：

1. 浏览器打开 `https://www.icloud.com/icloudplus/`。中国区使用 `https://www.icloud.com.cn/icloudplus/`。
2. 正常登录 Apple ID 并完成双重验证。
3. 按 `F12` 打开开发者工具，进入 `Network`，勾选 `Preserve log`。
4. 在 iCloud+ 页面点击“隐藏邮件地址”。
5. 在 Network 过滤框输入 `maildomainws`。
6. 找到路径包含 `/v2/hme/list` 或 `/v1/hme/` 的请求。
7. 右键请求，选择 `Copy` → `Copy as cURL`。
8. 打开控制台的“CK 账号”页面，点击“导入 CK”，粘贴完整 cURL 并提交。

控制台内置 `/guide` 页面，提供相同指引和复制按钮。

## Docker 部署

服务器只需要安装 Docker 与 Docker Compose。拉取代码后创建环境文件：

```bash
cp .env.example .env
# 编辑 .env，至少填写 APP_ORIGIN、ADMIN_PASSWORD、JWT_SECRET 和 DATA_ENCRYPTION_KEY
docker compose up -d --build
docker compose ps
```

`ADMIN_PASSWORD` 直接填写至少 10 位的登录密码，不需要生成哈希。`JWT_SECRET` 可使用 `openssl rand -base64 48` 生成，`DATA_ENCRYPTION_KEY` 可使用 `openssl rand -base64 32` 生成。将 `APP_ORIGIN` 设置为 `http://服务器IP:4173` 或实际域名，然后打开该地址登录。真实 `.env`、数据库和 CK 不得提交。

查看日志：

```bash
docker compose logs -f app
```

更新服务：

```bash
docker compose up -d --build
```

## 数据备份

容器内执行 SQLite 一致性备份：

```bash
docker compose exec app node scripts/backup-db.mjs /app/data/workbench-backup.db
```

再使用 `docker cp` 将备份文件取出。不要直接复制正在写入的数据库和 WAL 文件。

## Windows 本地开发

安装 Node.js 24、Python 3.12 后执行：

```powershell
npm install
npm run init-env
.\start.ps1
```

`start.ps1` 会自动安装根目录 npm 依赖、Skyroc 的 pnpm 依赖、构建前端，并把数据库路径切换为项目内的 `data/workbench.db`。

## HTTPS 升级

接入 Nginx、Caddy 或负载均衡后，将 `APP_ORIGIN` 改为实际 HTTPS 地址，并设置 `COOKIE_SECURE=true`，然后重启容器。
