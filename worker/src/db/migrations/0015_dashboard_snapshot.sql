-- v2.10.2: retain successful inventory; separate invalidation and failed collection.
ALTER TABLE accounts ADD COLUMN snapshot_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resource_summaries ADD COLUMN last_failed_at INTEGER;
ALTER TABLE resource_summaries ADD COLUMN invalidated_at INTEGER;
UPDATE resource_summaries SET invalidated_at=fetched_at,error_kind=NULL WHERE error_kind='invalidated';
DROP TRIGGER IF EXISTS dashboard_scan_resource_change;
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
  UPDATE resource_summaries SET invalidated_at=CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER),fetched_at=MAX(fetched_at,CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER))
  WHERE cf_account_id=(SELECT account_id FROM accounts WHERE id=NEW.account_id)
    AND metric=CASE WHEN NEW.action LIKE '%zone' THEN 'zones' WHEN NEW.action IN ('batch_deploy','create_worker','delete_worker','deploy_worker') THEN 'workers' WHEN NEW.action LIKE '%pages' THEN 'pages' WHEN NEW.action IN ('create_tunnel','delete_tunnel','wizard_origin') THEN 'tunnels' WHEN NEW.action IN ('kv_create_ns','kv_delete_ns','create_kv','delete_kv') THEN 'kv' WHEN NEW.action IN ('d1_create_db','d1_delete_db','create_d1','delete_d1') THEN 'd1' ELSE 'r2' END;
  UPDATE dashboard_scan_items SET revision=revision+1,force=1,state=CASE WHEN state='running' THEN 'running' ELSE 'queued' END,attempts=CASE WHEN state='running' THEN attempts ELSE 0 END,finished_at=NULL
  WHERE job_id=(SELECT id FROM dashboard_scan_jobs WHERE active_key='global') AND cf_account_id=(SELECT account_id FROM accounts WHERE id=NEW.account_id) AND metric=CASE WHEN NEW.action LIKE '%zone' THEN 'zones' WHEN NEW.action IN ('batch_deploy','create_worker','delete_worker','deploy_worker') THEN 'workers' WHEN NEW.action LIKE '%pages' THEN 'pages' WHEN NEW.action IN ('create_tunnel','delete_tunnel','wizard_origin') THEN 'tunnels' WHEN NEW.action IN ('kv_create_ns','kv_delete_ns','create_kv','delete_kv') THEN 'kv' WHEN NEW.action IN ('d1_create_db','d1_delete_db','create_d1','delete_d1') THEN 'd1' ELSE 'r2' END;
END;

ALTER TABLE dashboard_scan_control ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0;

-- Security transitions fence even an A -> B -> A credential change. Display metadata does not advance this epoch.
CREATE TRIGGER IF NOT EXISTS dashboard_snapshot_account_identity
AFTER UPDATE OF credential_id,account_id,auth_type,api_token,api_key,email,proxy_enabled,proxy_url ON accounts
WHEN NEW.credential_id IS NOT OLD.credential_id OR NEW.account_id IS NOT OLD.account_id
 OR NEW.proxy_enabled IS NOT OLD.proxy_enabled OR NEW.proxy_url IS NOT OLD.proxy_url
 OR (NEW.credential_id IS NULL AND (NEW.auth_type IS NOT OLD.auth_type OR NEW.api_token IS NOT OLD.api_token OR NEW.api_key IS NOT OLD.api_key OR NEW.email IS NOT OLD.email))
BEGIN
 UPDATE accounts SET snapshot_epoch=snapshot_epoch+1 WHERE id=NEW.id;
 DELETE FROM resource_summaries WHERE account_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS dashboard_snapshot_credential_identity
AFTER UPDATE OF auth_type,api_token,api_key,email,status ON credentials
WHEN NEW.auth_type IS NOT OLD.auth_type OR NEW.api_token IS NOT OLD.api_token OR NEW.api_key IS NOT OLD.api_key OR NEW.email IS NOT OLD.email
 OR (NEW.status IS NOT OLD.status AND (NEW.status IN ('invalid','expired','disabled') OR OLD.status IN ('invalid','expired','disabled')))
BEGIN
 UPDATE accounts SET snapshot_epoch=snapshot_epoch+1 WHERE credential_id=NEW.id;
 DELETE FROM resource_summaries WHERE account_id IN (SELECT id FROM accounts WHERE credential_id=NEW.id);
END;

-- One durable monotonic version for lightweight cross-client refresh detection.
CREATE TRIGGER IF NOT EXISTS dashboard_snapshot_insert AFTER INSERT ON resource_summaries BEGIN
 UPDATE dashboard_scan_control SET snapshot_revision=snapshot_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS dashboard_snapshot_update AFTER UPDATE ON resource_summaries
WHEN NEW.identity IS NOT OLD.identity OR NEW.value IS NOT OLD.value OR NEW.breakdown IS NOT OLD.breakdown
 OR NEW.fetched_at IS NOT OLD.fetched_at OR NEW.last_success_at IS NOT OLD.last_success_at
 OR NEW.last_failed_at IS NOT OLD.last_failed_at OR NEW.invalidated_at IS NOT OLD.invalidated_at OR NEW.error_kind IS NOT OLD.error_kind
BEGIN
 UPDATE dashboard_scan_control SET snapshot_revision=snapshot_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS dashboard_snapshot_delete AFTER DELETE ON resource_summaries BEGIN
 UPDATE dashboard_scan_control SET snapshot_revision=snapshot_revision+1 WHERE id=1;
END;
