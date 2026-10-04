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
ALTER TABLE accounts ADD COLUMN credential_id INTEGER REFERENCES credentials(id);
ALTER TABLE accounts ADD COLUMN is_enabled INTEGER DEFAULT 1;
ALTER TABLE accounts ADD COLUMN access_status TEXT DEFAULT 'unknown';
ALTER TABLE accounts ADD COLUMN last_checked_at DATETIME;
INSERT OR IGNORE INTO credentials (name, auth_type, api_token, api_key, email, legacy_account_id, created_at, updated_at)
SELECT name, auth_type, api_token, api_key, email, id, created_at, updated_at FROM accounts WHERE credential_id IS NULL;
UPDATE accounts SET credential_id = (SELECT id FROM credentials WHERE legacy_account_id = accounts.id) WHERE credential_id IS NULL;
UPDATE accounts SET api_token = NULL, api_key = NULL WHERE credential_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_credential ON accounts(credential_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_binding ON accounts(credential_id, account_id);
