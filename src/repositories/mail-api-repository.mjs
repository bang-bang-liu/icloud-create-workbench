/** 创建独立邮箱池仓储，使用数据库事务保证多连接领取互斥。 */
export function createMailApiRepository(db) {
  const readyAccount = db.prepare(`SELECT 1 FROM icloud_accounts a
    JOIN account_inbox_configs c ON c.account_id = a.id
    WHERE a.id = ? AND a.status != 'deleted'
      AND length(trim(c.host)) > 0 AND length(trim(c.email)) > 0
      AND length(c.password_encrypted) > 0`);
  const candidate = db.prepare(`SELECT h.id, h.email FROM hidden_addresses h
    JOIN icloud_accounts a ON a.id = h.account_id
    JOIN account_inbox_configs c ON c.account_id = a.id
    WHERE h.account_id = @accountId AND h.local_state = 'unused' AND a.status != 'deleted'
      AND length(trim(c.host)) > 0 AND length(trim(c.email)) > 0 AND length(c.password_encrypted) > 0
      AND substr(trim(COALESCE(h.apple_label, '')), 1, length(@labelPrefix)) = @labelPrefix COLLATE NOCASE
      AND instr(h.email, '@') > 1
      AND NOT EXISTS (SELECT 1 FROM mail_api_claims m WHERE m.address_id = h.id)
    ORDER BY h.created_at ASC, h.id ASC LIMIT 1`);
  const occupy = db.prepare(`UPDATE hidden_addresses SET local_state = 'used', updated_at = ?
    WHERE id = ? AND local_state = 'unused'`);
  const insertClaim = db.prepare(`INSERT INTO mail_api_claims
    (id, address_id, token_hash, created_at, expires_at) VALUES (@id, @addressId, @tokenHash, @createdAt, @expiresAt)`);
  const findClaim = db.prepare(`SELECT m.id, m.address_id AS addressId, h.account_id AS accountId,
      h.email, m.created_at AS createdAt, m.expires_at AS expiresAt
    FROM mail_api_claims m JOIN hidden_addresses h ON h.id = m.address_id
    JOIN icloud_accounts a ON a.id = h.account_id
    WHERE m.id = ? AND m.token_hash = ? AND h.local_state != 'trash' AND a.status != 'deleted'`);
  const messages = db.prepare(`SELECT id, subject, sender, code, received_at AS receivedAt
    FROM inbox_messages WHERE address_id = ? AND julianday(received_at) >= julianday(?)
    ORDER BY julianday(received_at) DESC, id ASC LIMIT 50`);
  const claimTransaction = db.transaction(input => {
    const address = candidate.get({ accountId: input.accountId, labelPrefix: input.labelPrefix });
    if (!address || occupy.run(input.createdAt, address.id).changes !== 1) {
      throw Object.assign(new Error("没有可领取的邮箱"), { status: 409 });
    }
    insertClaim.run({ id: input.id, addressId: address.id, tokenHash: input.tokenHash,
      createdAt: input.createdAt, expiresAt: input.expiresAt });
    return { email: address.email };
  });

  /** 仅查询账号是否具备收件配置，不解密凭据或连接 IMAP。 */
  function isReady(accountId) { return Boolean(readyAccount.get(accountId)); }

  /** 先取得 SQLite 写锁，再完成选取、占用和写入领取凭据。 */
  function claim(input) { return claimTransaction.immediate(input); }

  /** 校验领取编号和密钥哈希，只读取该领取所属邮箱。 */
  function getClaim(id, tokenHash) { return findClaim.get(id, tokenHash); }

  /** 读取时间窗口内最新邮件，数据库过滤无效时间并稳定排序。 */
  function listMessages(addressId, after) { return messages.all(addressId, after); }

  return { isReady, claim, getClaim, listMessages };
}
