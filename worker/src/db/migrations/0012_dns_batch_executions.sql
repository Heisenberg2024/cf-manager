-- One-time execution receipts; no DNS content or credentials are persisted.
CREATE TABLE IF NOT EXISTS dns_batch_executions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dns_batch_expires ON dns_batch_executions(expires_at);
