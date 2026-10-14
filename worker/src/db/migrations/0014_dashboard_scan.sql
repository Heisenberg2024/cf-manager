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
CREATE TRIGGER IF NOT EXISTS dashboard_scan_account_insert AFTER INSERT ON accounts BEGIN
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
