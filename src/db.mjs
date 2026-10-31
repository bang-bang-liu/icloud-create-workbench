import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { ensureMailApiSchema } from "./mail-api-schema.mjs";

/** 创建数据库并执行启动迁移。 */
export function createDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS icloud_accounts (
      id TEXT PRIMARY KEY,
      apple_id TEXT NOT NULL,
      identity_key TEXT NOT NULL UNIQUE,
      dsid TEXT,
      display_name TEXT,
      region TEXT NOT NULL,
      user_partition TEXT,
      maildomain_host TEXT,
      cookie_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      label_prefix TEXT NOT NULL DEFAULT 'changsheng',
      label_sequence INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      requested_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_summary TEXT,
      started_at TEXT,
      finished_at TEXT,
      first_success_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES icloud_accounts(id)
    );
    CREATE TABLE IF NOT EXISTS hidden_addresses (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      job_id TEXT,
      email TEXT NOT NULL UNIQUE,
      apple_label TEXT,
      local_state TEXT NOT NULL DEFAULT 'unused',
      source TEXT NOT NULL,
      error_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES icloud_accounts(id),
      FOREIGN KEY(job_id) REFERENCES generation_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS generation_results (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      label TEXT,
      email TEXT,
      status TEXT NOT NULL,
      error_text TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES generation_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS generation_campaigns (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      target_total INTEGER NOT NULL DEFAULT 700,
      batch_size INTEGER NOT NULL DEFAULT 5,
      label_prefix TEXT NOT NULL DEFAULT 'changsheng',
      status TEXT NOT NULL,
      generated_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES icloud_accounts(id)
    );
    CREATE TABLE IF NOT EXISTS inbox_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      host TEXT,
      port INTEGER,
      secure INTEGER,
      email TEXT,
      password_encrypted TEXT,
      mailbox TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS account_inbox_configs (
      account_id TEXT PRIMARY KEY,
      host TEXT,
      port INTEGER,
      secure INTEGER,
      email TEXT,
      password_encrypted TEXT,
      mailbox TEXT,
      last_uid INTEGER NOT NULL DEFAULT 0,
      uid_validity TEXT,
      last_sync_at TEXT,
      next_sync_at TEXT,
      last_error TEXT,
      html_backfill_done INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      FOREIGN KEY(account_id) REFERENCES icloud_accounts(id)
    );
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id TEXT PRIMARY KEY,
      address_id TEXT,
      message_uid TEXT NOT NULL UNIQUE,
      subject TEXT,
      sender TEXT,
      code TEXT,
      preview TEXT,
      body_text TEXT,
      body_html TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(address_id) REFERENCES hidden_addresses(id)
    );
    CREATE TABLE IF NOT EXISTS address_public_access (
      address_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      last_access_at TEXT,
      FOREIGN KEY(address_id) REFERENCES hidden_addresses(id)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_account ON generation_jobs(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_addresses_account ON hidden_addresses(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_results_job ON generation_results(job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_campaigns_due ON generation_campaigns(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_messages_received ON inbox_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_address ON inbox_messages(address_id, received_at DESC);
  `);
  const migrationTime = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE generation_campaigns SET status = 'superseded', next_run_at = NULL, updated_at = ?
      WHERE status IN ('running', 'stopped') AND id NOT IN (
        SELECT id FROM generation_campaigns current
        WHERE current.status IN ('running', 'stopped')
          AND current.id = (SELECT latest.id FROM generation_campaigns latest
            WHERE latest.account_id = current.account_id AND latest.status IN ('running', 'stopped')
            ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
      )`).run(migrationTime);
    db.prepare(`UPDATE generation_jobs SET status = 'failed',
      error_summary = '重复任务已由系统终止', finished_at = COALESCE(finished_at, ?)
      WHERE status IN ('queued', 'running') AND id NOT IN (
        SELECT id FROM generation_jobs current
        WHERE current.status IN ('queued', 'running')
          AND current.id = (SELECT latest.id FROM generation_jobs latest
            WHERE latest.account_id = current.account_id AND latest.status IN ('queued', 'running')
            ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
      )`).run(migrationTime);
  })();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_one_open_per_account
      ON generation_campaigns(account_id) WHERE status IN ('running', 'stopped');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_per_account
      ON generation_jobs(account_id) WHERE status IN ('queued', 'running');
  `);
  const accountColumns = db.pragma("table_info(icloud_accounts)");
  if (!accountColumns.some(column => column.name === "apple_id") && accountColumns.some(column => column.name === "apple_id_masked")) {
    db.exec("ALTER TABLE icloud_accounts RENAME COLUMN apple_id_masked TO apple_id");
  }
  const messageColumns = db.pragma("table_info(inbox_messages)");
  if (!messageColumns.some(column => column.name === "account_id")) {
    db.exec("ALTER TABLE inbox_messages ADD COLUMN account_id TEXT REFERENCES icloud_accounts(id)");
  }
  if (!messageColumns.some(column => column.name === "body_html")) {
    db.exec("ALTER TABLE inbox_messages ADD COLUMN body_html TEXT");
  }
  const configColumns = db.pragma("table_info(account_inbox_configs)");
  const inboxMigrations = [
    ["last_uid", "ALTER TABLE account_inbox_configs ADD COLUMN last_uid INTEGER NOT NULL DEFAULT 0"],
    ["uid_validity", "ALTER TABLE account_inbox_configs ADD COLUMN uid_validity TEXT"],
    ["last_sync_at", "ALTER TABLE account_inbox_configs ADD COLUMN last_sync_at TEXT"],
    ["next_sync_at", "ALTER TABLE account_inbox_configs ADD COLUMN next_sync_at TEXT"],
    ["last_error", "ALTER TABLE account_inbox_configs ADD COLUMN last_error TEXT"],
    ["html_backfill_done", "ALTER TABLE account_inbox_configs ADD COLUMN html_backfill_done INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const [name, sql] of inboxMigrations) {
    if (!configColumns.some(column => column.name === name)) db.exec(sql);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_account ON inbox_messages(account_id, received_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_configs_due ON account_inbox_configs(next_sync_at)");
  ensureMailApiSchema(db);
  return db;
}
