import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dns_batch_executions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dns_batch_expires ON dns_batch_executions(expires_at);
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      auth_type TEXT NOT NULL CHECK(auth_type IN ('token', 'global_key')),
      api_token TEXT,
      api_key TEXT,
      email TEXT,
      fingerprint TEXT UNIQUE,
      legacy_account_id INTEGER UNIQUE,
      status TEXT DEFAULT 'unknown',
      last_checked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      auth_type       TEXT NOT NULL CHECK(auth_type IN ('token', 'global_key')),
      api_token       TEXT,
      api_key         TEXT,
      email           TEXT,
      account_id      TEXT,
      is_active       INTEGER DEFAULT 1,
      enabled_features TEXT DEFAULT 'ai,workers,browser_render,dns,storage',
      available_features TEXT DEFAULT '',
      worker_plan     TEXT DEFAULT 'free',
      proxy_url       TEXT DEFAULT '',
      proxy_enabled   INTEGER DEFAULT 0,
      credential_id   INTEGER REFERENCES credentials(id),
      is_enabled      INTEGER DEFAULT 1,
      access_status   TEXT DEFAULT 'unknown',
      last_checked_at DATETIME,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quota_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      resource    TEXT NOT NULL,
      date        DATE NOT NULL,
      count       INTEGER DEFAULT 0,
      optimistic  INTEGER DEFAULT 0,
      exhausted   INTEGER DEFAULT 0,
      UNIQUE(account_id, resource, date)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      target      TEXT,
      detail      TEXT,
      status      TEXT NOT NULL CHECK(status IN ('success', 'error')),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log(action, created_at);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      cron        TEXT NOT NULL,
      config      TEXT,
      enabled     INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_executions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      status      TEXT NOT NULL CHECK(status IN ('running', 'success', 'error')),
      detail      TEXT,
      started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_sources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      is_default    INTEGER DEFAULT 0,
      enabled       INTEGER DEFAULT 1,
      last_synced   DATETIME,
      last_status   TEXT DEFAULT 'pending',
      last_error    TEXT,
      etag          TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
-- Counts only. No credentials, resource payloads or configuration are persisted.
CREATE TABLE IF NOT EXISTS resource_summaries (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cf_account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  identity TEXT NOT NULL,
  value INTEGER,
  breakdown TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL,
  last_success_at INTEGER,
  error_kind TEXT,
  PRIMARY KEY(account_id, metric)
);
-- v2.10.1: counts-only durable queue; one active job and one executor per database.
CREATE TABLE IF NOT EXISTS dashboard_scan_jobs (
  id TEXT PRIMARY KEY,
  active_key TEXT UNIQUE,
  state TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  full_scan INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_error_kind TEXT
);
CREATE TABLE IF NOT EXISTS dashboard_scan_items (
  job_id TEXT NOT NULL REFERENCES dashboard_scan_jobs(id) ON DELETE CASCADE,
  cf_account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  identity TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  force INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  attempted_bindings TEXT NOT NULL DEFAULT '[]',
  lease_token TEXT,
  lease_until INTEGER,
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  error_kind TEXT,
  PRIMARY KEY(job_id, cf_account_id, metric)
);
CREATE INDEX IF NOT EXISTS idx_dashboard_scan_work ON dashboard_scan_items(job_id,state,next_eligible_at);
CREATE TABLE IF NOT EXISTS dashboard_scan_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  next_full_at INTEGER NOT NULL DEFAULT 0,
  executor_token TEXT,
  executor_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO dashboard_scan_control(id) VALUES(1);
CREATE TABLE IF NOT EXISTS dashboard_scan_dirty (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(account_id, metric)
);

CREATE INDEX IF NOT EXISTS idx_audit_cursor ON audit_log(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_account_cursor ON audit_log(account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_status_cursor ON audit_log(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_cursor ON audit_log(action, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_quota_date ON quota_usage(date, account_id, resource);
  `);

  applyMigrations(db);
  db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run('0012_dns_batch_executions');
  db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run('0013_dashboard_audit');
  db.exec(`CREATE TRIGGER IF NOT EXISTS dashboard_scan_account_insert AFTER INSERT ON accounts BEGIN
  INSERT INTO dashboard_scan_dirty(account_id,metric) VALUES(NEW.id,'*')
    ON CONFLICT(account_id,metric) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS dashboard_scan_account_update
AFTER UPDATE OF credential_id,account_id,is_enabled,is_active,enabled_features,auth_type,api_token,api_key,email,proxy_enabled,proxy_url ON accounts
WHEN NEW.credential_id IS NOT OLD.credential_id OR NEW.account_id IS NOT OLD.account_id OR NEW.is_enabled IS NOT OLD.is_enabled OR NEW.is_active IS NOT OLD.is_active OR NEW.enabled_features IS NOT OLD.enabled_features OR NEW.auth_type IS NOT OLD.auth_type OR NEW.api_token IS NOT OLD.api_token OR NEW.api_key IS NOT OLD.api_key OR NEW.email IS NOT OLD.email OR NEW.proxy_enabled IS NOT OLD.proxy_enabled OR NEW.proxy_url IS NOT OLD.proxy_url BEGIN
  INSERT INTO dashboard_scan_dirty(account_id,metric) VALUES(NEW.id,'*')
    ON CONFLICT(account_id,metric) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS dashboard_scan_credential_update
AFTER UPDATE OF auth_type,api_token,api_key,email,status ON credentials
WHEN NEW.auth_type IS NOT OLD.auth_type OR NEW.api_token IS NOT OLD.api_token OR NEW.api_key IS NOT OLD.api_key OR NEW.email IS NOT OLD.email OR NEW.status IS NOT OLD.status BEGIN
  INSERT INTO dashboard_scan_dirty(account_id,metric)
    SELECT id,'*' FROM accounts WHERE credential_id=NEW.id
    ON CONFLICT(account_id,metric) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS dashboard_scan_resource_change AFTER INSERT ON audit_log
WHEN NEW.account_id IS NOT NULL AND NEW.action IN (
 'batch_create_zone','batch_delete_zone','create_zone','delete_zone',
 'batch_deploy','create_worker','delete_worker','deploy_worker',
 'batch_deploy_pages','deploy_pages','create_pages','delete_pages',
 'create_tunnel','delete_tunnel','wizard_origin',
 'kv_create_ns','kv_delete_ns','create_kv','delete_kv',
 'd1_create_db','d1_delete_db','create_d1','delete_d1',
 'r2_create_bucket','r2_delete_bucket','create_r2','delete_r2')
BEGIN
  INSERT INTO dashboard_scan_dirty(account_id,metric)
  SELECT NEW.account_id, CASE
    WHEN NEW.action LIKE '%zone' THEN 'zones'
    WHEN NEW.action IN ('batch_deploy','create_worker','delete_worker','deploy_worker') THEN 'workers'
    WHEN NEW.action LIKE '%pages' THEN 'pages'
    WHEN NEW.action IN ('create_tunnel','delete_tunnel','wizard_origin') THEN 'tunnels'
    WHEN NEW.action IN ('kv_create_ns','kv_delete_ns','create_kv','delete_kv') THEN 'kv'
    WHEN NEW.action IN ('d1_create_db','d1_delete_db','create_d1','delete_d1') THEN 'd1'
    ELSE 'r2' END WHERE EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id)
  ON CONFLICT(account_id,metric) DO UPDATE SET revision=revision+1;
  UPDATE resource_summaries SET error_kind='invalidated',fetched_at=MAX(fetched_at,CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER))
  WHERE cf_account_id=(SELECT account_id FROM accounts WHERE id=NEW.account_id)
    AND metric=CASE WHEN NEW.action LIKE '%zone' THEN 'zones' WHEN NEW.action IN ('batch_deploy','create_worker','delete_worker','deploy_worker') THEN 'workers' WHEN NEW.action LIKE '%pages' THEN 'pages' WHEN NEW.action IN ('create_tunnel','delete_tunnel','wizard_origin') THEN 'tunnels' WHEN NEW.action IN ('kv_create_ns','kv_delete_ns','create_kv','delete_kv') THEN 'kv' WHEN NEW.action IN ('d1_create_db','d1_delete_db','create_d1','delete_d1') THEN 'd1' ELSE 'r2' END;
  UPDATE dashboard_scan_items SET revision=revision+1,force=1,state=CASE WHEN state='running' THEN 'running' ELSE 'queued' END,attempts=CASE WHEN state='running' THEN attempts ELSE 0 END,finished_at=NULL
  WHERE job_id=(SELECT id FROM dashboard_scan_jobs WHERE active_key='global') AND cf_account_id=(SELECT account_id FROM accounts WHERE id=NEW.account_id) AND metric=CASE WHEN NEW.action LIKE '%zone' THEN 'zones' WHEN NEW.action IN ('batch_deploy','create_worker','delete_worker','deploy_worker') THEN 'workers' WHEN NEW.action LIKE '%pages' THEN 'pages' WHEN NEW.action IN ('create_tunnel','delete_tunnel','wizard_origin') THEN 'tunnels' WHEN NEW.action IN ('kv_create_ns','kv_delete_ns','create_kv','delete_kv') THEN 'kv' WHEN NEW.action IN ('d1_create_db','d1_delete_db','create_d1','delete_d1') THEN 'd1' ELSE 'r2' END;
END;
`);
  db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run('0014_dashboard_scan');
  // Copy ciphertext verbatim and preserve Account IDs / foreign keys. All steps are atomic.
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO credentials (name, auth_type, api_token, api_key, email, legacy_account_id, created_at, updated_at)
      SELECT name, auth_type, api_token, api_key, email, id, created_at, updated_at FROM accounts WHERE credential_id IS NULL;
      UPDATE accounts SET credential_id = (SELECT id FROM credentials WHERE legacy_account_id = accounts.id) WHERE credential_id IS NULL;
      UPDATE accounts SET api_token = NULL, api_key = NULL WHERE credential_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_accounts_credential ON accounts(credential_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_binding ON accounts(credential_id, account_id);
    `);
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run('0011_credentials_backfill');
  })();
}

// 版本化迁移（P1-17 / P1-18）：每条仅执行一次，记录于 _migrations 表。
// 新增列通过 PRAGMA table_info 判断列是否存在后再执行普通 ADD COLUMN，
// 跨所有 SQLite 版本保持幂等、可重复部署（当前 better-sqlite3 构建解析 ADD COLUMN IF NOT EXISTS 会报语法错误）；
// 非加法迁移（改名/改类型/删列/NOT NULL 无默认/数据回填）请新增带版本号的条目并写一次性脚本。
type Migration = {
  version: string;
  table: string;
  column: string;
  sql: string;
  /** add（默认）：列不存在才执行；drop：列存在才执行 */
  kind?: 'add' | 'drop';
};
const MIGRATIONS: Migration[] = [
  { version: '0011_accounts_credential_id', table: 'accounts', column: 'credential_id', sql: 'ALTER TABLE accounts ADD COLUMN credential_id INTEGER REFERENCES credentials(id);' },
  { version: '0011_accounts_is_enabled', table: 'accounts', column: 'is_enabled', sql: 'ALTER TABLE accounts ADD COLUMN is_enabled INTEGER DEFAULT 1;' },
  { version: '0011_accounts_access_status', table: 'accounts', column: 'access_status', sql: "ALTER TABLE accounts ADD COLUMN access_status TEXT DEFAULT 'unknown';" },
  { version: '0011_accounts_last_checked_at', table: 'accounts', column: 'last_checked_at', sql: 'ALTER TABLE accounts ADD COLUMN last_checked_at DATETIME;' },
  { version: '0001_accounts_enabled_features', table: 'accounts', column: 'enabled_features', sql: "ALTER TABLE accounts ADD COLUMN enabled_features TEXT DEFAULT 'ai,workers,browser_render,dns,storage';" },
  // 注：历史上此处有 0002_accounts_password（ADD COLUMN password），该字段已废弃并移除，
  // 见下方 0008 的删列迁移；已部署库 `_migrations` 中的 0002 记录留着无害。
  { version: '0003_accounts_available_features', table: 'accounts', column: 'available_features', sql: "ALTER TABLE accounts ADD COLUMN available_features TEXT DEFAULT '';" },
  { version: '0004_accounts_proxy_url', table: 'accounts', column: 'proxy_url', sql: "ALTER TABLE accounts ADD COLUMN proxy_url TEXT DEFAULT '';" },
  { version: '0005_accounts_proxy_enabled', table: 'accounts', column: 'proxy_enabled', sql: "ALTER TABLE accounts ADD COLUMN proxy_enabled INTEGER DEFAULT 0;" },
  { version: '0006_quota_optimistic', table: 'quota_usage', column: 'optimistic', sql: "ALTER TABLE quota_usage ADD COLUMN optimistic INTEGER DEFAULT 0;" },
  { version: '0007_quota_exhausted', table: 'quota_usage', column: 'exhausted', sql: "ALTER TABLE quota_usage ADD COLUMN exhausted INTEGER DEFAULT 0;" },
  // 移除从未在界面上使用的 accounts.password（登录密码）：旧库该列存在则删除，
  // 新库基础建表已不含该列，columnExists 为假直接跳过（见 applyMigrations 的 drop 分支）。
  { version: '0008_accounts_drop_password', table: 'accounts', column: 'password', kind: 'drop', sql: "ALTER TABLE accounts DROP COLUMN password;" },
  // worker_plan：账号的 Cloudflare Workers 计划类型（'free' 默认 / 'paid' / 'enterprise'），
  // 用于把付费模型只路由到付费账号；不标即免费。与 worker/src/db/migrations/0010_accounts_worker_plan.sql 对应。
  { version: '0010_accounts_worker_plan', table: 'accounts', column: 'worker_plan', sql: "ALTER TABLE accounts ADD COLUMN worker_plan TEXT DEFAULT 'free';" },
];

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: string }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const exists = columnExists(db, m.table, m.column);
    if (m.kind === 'drop') {
      // 删列：仅当列确实存在时执行
      if (exists) db.exec(m.sql);
    } else if (!exists) {
      // 加列：列已存在（旧库/手动加过）则跳过执行，但照常记录为已应用，保证幂等
      db.exec(m.sql);
    }
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(m.version);
  }
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}
