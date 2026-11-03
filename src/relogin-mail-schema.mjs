/** 新建重登独立取码凭据表，允许同一邮箱重复签发且不改变原领取表。 */
export function ensureReloginMailSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_api_relogin_accesses (
    id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL REFERENCES hidden_addresses(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
}
