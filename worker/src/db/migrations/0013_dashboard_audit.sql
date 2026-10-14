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
CREATE INDEX IF NOT EXISTS idx_audit_cursor ON audit_log(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_account_cursor ON audit_log(account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_status_cursor ON audit_log(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_cursor ON audit_log(action, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_quota_date ON quota_usage(date, account_id, resource);
