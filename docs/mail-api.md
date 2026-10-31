# 统一 iCloud 邮箱池 API

本接口兼容 sentinel-rs 现有邮箱客户端，不需要修改 Rust 代码。
邮箱来自 Workbench 已有库存；发信、隐藏邮箱生成和注册目标站点均不属于本接口。
freeAgentIdentity 本次不适配，原管理端和 `/openapi/.../latest` 保持兼容。

## 启用配置

在实际 Workbench 实例的 `.env` 中补齐缺失项并编辑以下五项，保留原有其他配置、数据库路径和全部密钥：

```dotenv
MAIL_API_ENABLED=true
MAIL_API_TOKEN=<独立生成的至少32字符随机密钥>
MAIL_API_ORIGIN=https://mail.example.com
MAIL_API_ACCOUNT_ID=<已有Workbench账号的内部ID>
MAIL_API_LABEL_PREFIX=sentinel-
```

| 配置 | 说明 |
| --- | --- |
| `MAIL_API_ENABLED` | 默认 `false`；关闭时原服务正常，新 API 返回 `503` |
| `MAIL_API_TOKEN` | 32～512 字符、无空白的独立随机密钥；不要复用管理员密码或 JWT 密钥 |
| `MAIL_API_ORIGIN` | 可信的源地址，不带路径、查询参数或凭据；留空回退 `APP_ORIGIN` |
| `MAIL_API_ACCOUNT_ID` | 必填，指定一个未删除且已配置 IMAP 的账号；内部 ID 可从已有管理 API 获取 |
| `MAIL_API_LABEL_PREFIX` | 必填，按标签开头进行大小写不敏感匹配，`%`、`_` 按字面量处理 |

使用项目内 Node 生成随机密钥后，保存至受保护的 `.env`：

```powershell
.\runtime\node\node.exe -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

选择与 freeAgent 当前账号／标签范围不重叠的库存。新 API 不会修改已有邮箱标签，
也不保证与旧客户端的多步骤领取流程共同消费同一批地址时仍能互斥。
如果没有可隔离范围，保持关闭；不要把所有已有库存自动开放给新 API。
配置错误仅关闭新接口，并记录不含配置值的原因，原管理端仍可启动。

远程访问需要有效 HTTPS 入口。本机可用 `http://127.0.0.1:4173`、
`http://localhost:4173` 或 IPv6 回环地址。远程 HTTP IP 地址会被拒绝。
可以为新接口设置独立 `MAIL_API_ORIGIN`，无需改动旧管理端的 `APP_ORIGIN`。

## 接口

### 健康检查

```http
GET /api/v1/health
```

就绪返回 `200 {"ok":true}`；未启用、配置错误、账号不可用或数据库不可读返回 `503`。
就绪只表示 API、数据库和收件配置存在，不代表已经验证 IMAP 登录或公网 HTTPS 连通性。
健康检查不读取凭据明文、不连接 IMAP、不占用邮箱。

### 领取邮箱

```http
POST /api/v1/mailboxes
Authorization: Bearer <MAIL_API_TOKEN>
Content-Type: application/json

{}
```

成功严格返回 `201`：

```json
{
  "email": "example@icloud.com",
  "code_url": "https://mail.example.com/api/v1/mailboxes/<claimId>/code?token=<independent-token>",
  "expires_at": "2026-10-30T04:00:00.000Z"
}
```

该请求会消耗一个 `unused` 邮箱，原子地标记为 `used` 并保存领取记录。
允许空请求体或 `{}`；可选字符串 `local_part`、`subdomain` 为兼容字段，不改变库存选择。
未知字段和错误类型返回 `400`；JSON 请求体上限为 4 KiB。
库存不足返回 `409`，不会自动生成新邮箱。

没有幂等键的每次 POST 都是独立领取。响应丢失后再次请求可能额外占用地址，
不会向不同成功领取重复分配同一地址，也不会自动将失败注册的邮箱放回库存。
在管理端手动改回 `unused` 后，已有领取记录仍会阻止本 API 再次分配该地址。

### 读取验证码

直接 `GET` 返回的 `code_url`，不发送全局 Bearer Token、不需要管理员登录。
成功返回 `text/html; charset=utf-8`：

```html
<article>
  <h2>邮件主题</h2><p>发件人</p>
  <div class="meta">Time: 2026-10-30 03:00:02</div>
  <div class="code">123456</div>
</article>
```

- 时间始终为原邮件时间转换的 UTC，不将旧邮件时间改写为当前时间。
- 返回该邮箱自领取前 5 秒起最近最多 50 封邮件中的有效六位数字验证码，按真实时间倒序。
- 不输出没有可信时间的验证码，不嵌入原始邮件 HTML；主题和发件人经过 HTML 转义。
- 无验证码返回 `200` 空卡片页，不输出假码。
- 同账号最多每 8 秒触发一次后台 IMAP 同步；慢同步不阻塞响应，后续轮询读取缓存更新。
- 新领取 Token 只保存哈希，有效期一小时；过期不回收邮箱。
- 垃圾箱内邮箱和已删除账号的领取链接不可读取。
- 新领取记录独立于原公开访问记录，原公开链接的生成、轮换及撤销不影响本链接。

所有新 API 响应均禁用缓存。取码地址本身属于凭据；部署代理日志应去掉查询参数，
分享日志前脱敏。sentinel 的 debug 日志会打印完整 URL，正常使用 `info` 日志。

### 状态码和限流

| 状态码 | 含义 |
| --- | --- |
| `400` / `413` | 请求格式错误／正文过大 |
| `401` | 领取请求缺少或提供了错误 Bearer Token |
| `404` | 领取 ID、取码 Token 无效或邮箱已不可访问 |
| `409` | 当前范围没有可领取的邮箱 |
| `410` | 正确的取码 Token 已过期 |
| `429` | 超过限流额度 |
| `503` | API 未就绪或数据库暂时忙，可稍后重试 |
| `500` | 内部处理失败，响应不包含底层错误和凭据 |

领取接口每 IP 每分钟最多 60 次；取码接口每 IP 每分钟最多 600 次。
配置代理时保留项目原有可信代理设置，避免所有调用错误归并到同一个地址。

## sentinel-rs 配置示例

以下仅为接入说明，本次未修改 sentinel 项目的配置：

```powershell
$env:REG_MAIL_API_BASE_URL="https://mail.example.com/api/v1"
$env:REG_MAIL_API_TOKEN="<与Workbench一致的MAIL_API_TOKEN>"
$env:OTP_MAX_WAIT="180"
$env:OTP_POLL_INTERVAL="3"
```

本机回环 HTTP 联调时，基地址改为 `http://127.0.0.1:4173/api/v1`，
并设置 `$env:REG_MAIL_ALLOW_INSECURE="1"`。该开关不能放行远程 HTTP 地址。
sentinel 的邮箱和注册请求共用代理，实际接入要确认该代理可以访问基地址及返回的取码地址。

sentinel 自身按开始轮询的时间筛选验证码，并有 5 秒容差；
投递时间更早的邮件仍可能被客户端过滤，本 API 不伪造时间绕过该行为。
本接口的契约验证不等同于真实注册或真实邮件收取成功。

## 升级、数据校验与回滚

1. 核实实际实例的数据库路径、环境配置、进程及持久卷。不要把本机数据库部署覆盖到远程实例。
2. 在停写维护窗口创建最终一致性备份，复用 `scripts/backup-db.mjs`，同时保留配套 `.env`。
   Docker 示例：`docker compose exec app node scripts/backup-db.mjs /app/data/workbench-before-mail-api.db`。
   取出备份并校验 `PRAGMA integrity_check`，不只复制运行中的 `.db`。
3. 记录原业务表的主键集合、记录数及内容摘要，并在受保护副本验证旧 CK 和 IMAP 密文可解密。
4. 原样保留 `DATA_ENCRYPTION_KEY`、管理员配置、JWT 密钥、`DATABASE_PATH` 和已有公开访问记录。
   不运行 `init-env --force`，不删除数据卷、不清表、不重建库存。
5. 新版本只新增 `mail_api_claims` 表和库存查询索引，迁移可重复执行。
   先在备份副本演练，再重启实际实例，区分原有任务恢复和正常收件造成的业务变化。
6. 验证旧管理端和新健康端点；正式领用只由明确发起的业务请求执行。

仅代码异常时，先关闭 `MAIL_API_ENABLED` 并回退本次代码增量，保留新表和原数据。
不要为了代码回滚恢复旧数据库，避免丢失上线后新增邮件。
确需恢复数据时，先停写并备份故障现场，核对新增记录后制定保留／合并步骤；
不直接用旧快照覆盖运行中的数据库，也不混用不同时间点的数据库与 WAL。

## 验证范围

实际部署的 HTTPS、代理可达性和真实新邮件收取需要分别验证。
