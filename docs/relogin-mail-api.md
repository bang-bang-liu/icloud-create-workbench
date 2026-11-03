# 重登邮箱自动取码接口

本接口为已有邮箱签发一小时有效的独立链接。它不领取库存、不改变邮箱状态，也不轮换注册领取链接或公开链接。

## 配置

保留既有 `MAIL_API_ENABLED`、`MAIL_API_ORIGIN`、`MAIL_API_ACCOUNT_ID`、`MAIL_API_LABEL_PREFIX`，在 Workbench 的私有配置中增加：

```dotenv
MAIL_API_RELOGIN_TOKEN=<32至512字符的独立随机密钥>
```

该密钥与注册的 `MAIL_API_TOKEN` 分开。未设置或格式错误只关闭重登接口，其他服务继续工作。

在 `sentinel-relogin` 自己的私有配置中增加：

```dotenv
LOGIN_MAIL_RESOLVE_URL=https://mail.example.invalid/api/v1/relogin/mailboxes/resolve
LOGIN_MAIL_RESOLVE_TOKEN=<与MAIL_API_RELOGIN_TOKEN一致的密钥>
```

URL 未配置时保留原 JSON 文件模式；配置 URL 后使用 API，不再读文件，接口失败也不回退旧链接。密钥缺失只在邮箱挑战时提示，不妨碍不需要邮箱验证的登录。

## 签发

```http
POST /api/v1/relogin/mailboxes/resolve
Authorization: Bearer <MAIL_API_RELOGIN_TOKEN>
Content-Type: application/json

{"email":"first@example.invalid"}
```

成功返回 `201`：

```json
{
  "email": "first@example.invalid",
  "code_url": "https://mail.example.invalid/api/v1/relogin/access/<id>/code?token=<random-token>",
  "expires_at": "2026-11-03T08:00:00.000Z"
}
```

请求仅允许 `email`。去除首尾空白后与已有邮箱精确匹配，限制在配置的账号与标签范围内。`used` 邮箱可查询，不要求旧领取记录存在。垃圾箱、删除账号或缺少 IMAP 配置的邮箱不可查询。

同邮箱每次生成新链接，旧的未过期链接继续有效；数据库只保存 Token 哈希。新凭据存入 `mail_api_relogin_accesses`，不修改其他访问记录、邮箱状态、标签或更新时间。

## 取码

GET 返回的 `code_url`，无需全局 Bearer。HTML 使用现有的 `article`、`class="meta"` 与 `class="code"` 卡片格式，时间为原邮件的 UTC 时间。

只读取签发前五秒以来、当前邮箱最近最多 50 封邮件中的有效六位码。无验证码返回 `200` 空页。读取异步触发既有 IMAP 收件实例，同账号最多每八秒一次，使用原服务互斥；慢同步不阻塞 HTTP。

重登顺序为“明确邮箱挑战 → 签发链接 → 记录基线 → 登录 resend → 轮询新码 → 提交”。只有签发 POST 携带重登接口密钥；取码 GET 只携带链接 Token。邮箱始终直连，与账号认证代理分开。

## 状态与部署

| 状态 | 含义 |
| --- | --- |
| `201` / `200` | 签发成功 / 取码页成功 |
| `400` / `413` | JSON 格式或字段错误 / 正文超过 4 KiB |
| `401` | 重登专用密钥错误 |
| `404` | 邮箱不在可用范围，或链接无效 |
| `410` | 正确的链接已过期 |
| `429` / `503` | 超过限流 / 接口未就绪或数据库忙 |

签发每 IP 每分钟 60 次，取码每 IP 每分钟 600 次，两者不占原注册接口的限流额度。响应禁用缓存，错误不回传密钥或底层异常。临时链接属于凭据，日志不应保留查询参数。

升级前使用 `scripts/backup-db.mjs` 创建一致性备份，保留原数据库、加密密钥及全部既有环境变量。启动只新增表，不迁移原表；代码回滚保留该表即可。关闭新接口只需清空 `MAIL_API_RELOGIN_TOKEN` 并重启，无需恢复旧数据库。

本地验证：`runtime/node/node.exe --test --test-concurrency=1 "test/*.test.mjs"`。新增重登测试采用隔离数据库、合成邮箱及模拟收件，不连接真实 IMAP、不消耗真实库存。

## 2026-11-03 实施记录

阿里云 SSH 别名 `AlibabaCloud`，实际项目为 `/root/icloud-create-workbench`，通过 Docker Compose 的 `app` 服务运行。升级在原镜像上仅覆盖本次后端文件，沿用原前端、运行依赖和 `/root/icloud-create-workbench/data:/app/data` 挂载。服务已重启且健康，新增密钥只保存在私有配置。

全量测试 78 项通过，其中新增重登测试 10 项。迁移前通过在线备份保存一致性数据库；上线后完整性为 `ok`，原邮箱、领取凭据及公开访问凭据的内容摘要均未变化。

已从 SG 对同一已有邮箱重复签发并读取两条独立链接，正式 Rust 读取器也已通过生产签发和 HTML 读取验证；均未消耗新邮箱。使用读取器自身的 User-Agent，避免 Python 默认 User-Agent 被公网入口返回 1010。

SG 重登工具已升级 0.1.1，单账号密码/TOTP 登录成功。该次实际登录没有触发邮箱验证；真实邮件投递与登录提交的完整分支尚未实测，离线模拟已覆盖其模块调用顺序。

## 服务器源码发布检查

本次导出阿里云服务器的未提交源码进行发布，服务器快照所含 50 项后端测试全部通过，包括 10 项重登邮箱接口测试及遗留生成任务回收检查。发布排除真实配置、数据库、日志和源码压缩包，部署记录中的库存数量及账号标识使用通用描述。
