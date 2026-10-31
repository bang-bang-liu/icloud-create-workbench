/** 仅新增独立领取表及查询索引，不修改已有配置、邮箱和邮件记录。 */
export function ensureMailApiSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_api_claims (
      id TEXT PRIMARY KEY,
      address_id TEXT NOT NULL UNIQUE REFERENCES hidden_addresses(id),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_api_inventory
      ON hidden_addresses(account_id, local_state, created_at, id);
  `);
}
