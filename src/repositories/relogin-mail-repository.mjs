/** 创建只对重登凭据写入的仓储，不占用或更新邮箱库存。 */
export function createReloginMailRepository(db) {
  const scope = `h.account_id = @accountId AND h.local_state != 'trash' AND a.status != 'deleted'
    AND length(trim(c.host)) > 0 AND length(trim(c.email)) > 0 AND length(c.password_encrypted) > 0
    AND substr(trim(COALESCE(h.apple_label, '')), 1, length(@labelPrefix)) = @labelPrefix COLLATE NOCASE`;
  const ready = db.prepare(`SELECT 1 FROM icloud_accounts a
    JOIN account_inbox_configs c ON c.account_id = a.id
    WHERE a.id = ? AND a.status != 'deleted' AND length(trim(c.host)) > 0
      AND length(trim(c.email)) > 0 AND length(c.password_encrypted) > 0`);
  const address = db.prepare(`SELECT h.id, h.email FROM hidden_addresses h
    JOIN icloud_accounts a ON a.id = h.account_id
    JOIN account_inbox_configs c ON c.account_id = a.id
    WHERE ${scope} AND h.email = @email`);
  const insert = db.prepare(`INSERT INTO mail_api_relogin_accesses
    (id, address_id, token_hash, created_at, expires_at)
    VALUES (@id, @addressId, @tokenHash, @createdAt, @expiresAt)`);
  const access = db.prepare(`SELECT r.address_id AS addressId, h.account_id AS accountId,
    h.email, r.created_at AS createdAt, r.expires_at AS expiresAt
    FROM mail_api_relogin_accesses r JOIN hidden_addresses h ON h.id = r.address_id
    JOIN icloud_accounts a ON a.id = h.account_id
    JOIN account_inbox_configs c ON c.account_id = a.id
    WHERE r.id = @id AND r.token_hash = @tokenHash AND ${scope}`);
  const messages = db.prepare(`SELECT id, subject, sender, code, received_at AS receivedAt
    FROM inbox_messages WHERE address_id = ? AND julianday(received_at) >= julianday(?)
    ORDER BY julianday(received_at) DESC, id ASC LIMIT 50`);
  const issueTransaction = db.transaction(input => {
    const mailbox = address.get({ accountId: input.accountId, labelPrefix: input.labelPrefix, email: input.email });
    if (!mailbox) throw Object.assign(new Error("该邮箱没有可用的自动取码地址"), { status: 404 });
    insert.run({ id: input.id, addressId: mailbox.id, tokenHash: input.tokenHash,
      createdAt: input.createdAt, expiresAt: input.expiresAt });
    return { email: mailbox.email };
  });

  /** 仅检查指定收件账号配置，不解密或连接邮箱。 */
  function isReady(accountId) { return Boolean(ready.get(accountId)); }

  /** 在短事务内精确查找已有邮箱并签发，不修改地址状态。 */
  function issue(input) { return issueTransaction.immediate(input); }

  /** 同时验证凭据、当前归属范围与邮箱可用状态。 */
  function getAccess(input) { return access.get(input); }

  /** 从现有邮件缓存读取本轮时间窗口内的邮件。 */
  function listMessages(addressId, after) { return messages.all(addressId, after); }

  return { isReady, issue, getAccess, listMessages };
}
