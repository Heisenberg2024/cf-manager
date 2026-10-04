import crypto from 'crypto';
import { getDb } from '../db';
import { config } from '../config';
import { decrypt } from '../services/encryptionService';

export interface Credential {
  id: number; name: string; auth_type: 'token' | 'global_key';
  api_token: string | null; api_key: string | null; email: string | null;
  fingerprint: string | null; status: string; last_checked_at: string | null;
  created_at: string; updated_at: string;
}
export type CredentialInput = Pick<Credential, 'name' | 'auth_type'> & Partial<Pick<Credential, 'api_token' | 'api_key' | 'email'>>;
export function getCredential(id: number): Credential | undefined {
  return getDb().prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Credential | undefined;
}
export function listCredentials(): Credential[] {
  return getDb().prepare('SELECT * FROM credentials ORDER BY id DESC').all() as Credential[];
}
export function credentialFingerprint(input: CredentialInput): string {
  const secret = input.auth_type === 'token' ? input.api_token : input.api_key;
  if (!secret) throw new Error('Credential is missing authentication secret');
  return crypto.createHmac('sha256', config.encryptionKey).update(JSON.stringify([input.auth_type, input.auth_type === 'global_key' ? input.email?.trim().toLowerCase() : '', decrypt(secret)])).digest('hex');
}
export function ensureCredential(input: CredentialInput): number {
  const fingerprint = credentialFingerprint(input);
  const found = getDb().prepare('SELECT id FROM credentials WHERE fingerprint = ?').get(fingerprint) as { id: number } | undefined;
  if (found) return found.id;
  // Legacy migration cannot compare randomized ciphertext in SQL. Reuse a matching migrated credential.
  for (const legacy of listCredentials().filter(c => !c.fingerprint)) {
    try {
      if (credentialFingerprint(legacy) === fingerprint) {
        getDb().prepare('UPDATE credentials SET fingerprint = ? WHERE id = ?').run(fingerprint, legacy.id);
        return legacy.id;
      }
    } catch { /* Keep damaged legacy credentials for recovery; never discard their ciphertext. */ }
  }
  getDb().prepare('INSERT OR IGNORE INTO credentials (name, auth_type, api_token, api_key, email, fingerprint) VALUES (?, ?, ?, ?, ?, ?)').run(input.name, input.auth_type, input.api_token || null, input.api_key || null, input.email || null, fingerprint);
  return (getDb().prepare('SELECT id FROM credentials WHERE fingerprint = ?').get(fingerprint) as { id: number }).id;
}
export function updateCredential(id: number, input: Partial<CredentialInput> & { status?: string; last_checked_at?: string }): void {
  const existing = getCredential(id);
  if (!existing) throw Object.assign(new Error('Credential not found'), { statusCode: 404 });
  const next = { ...existing, ...input };
  const changingAuth = ['api_token', 'api_key', 'email', 'auth_type'].some(k => k in input);
  getDb().prepare('UPDATE credentials SET name = ?, auth_type = ?, api_token = ?, api_key = ?, email = ?, fingerprint = ?, status = ?, last_checked_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next.name, next.auth_type, next.auth_type === 'token' ? next.api_token : null, next.auth_type === 'global_key' ? next.api_key : null, next.auth_type === 'global_key' ? next.email : null, changingAuth ? credentialFingerprint(next) : next.fingerprint, next.status, next.last_checked_at, id);
}

// Same shape as Account authentication fields, resolved at the query boundary for all resources.
export const ACCOUNT_SELECT = `SELECT accounts.*,
  CASE WHEN c.id IS NOT NULL THEN c.api_token ELSE accounts.api_token END AS api_token,
  CASE WHEN c.id IS NOT NULL THEN c.api_key ELSE accounts.api_key END AS api_key,
  CASE WHEN c.id IS NOT NULL THEN c.email ELSE accounts.email END AS email,
  COALESCE(c.auth_type, accounts.auth_type) AS auth_type,
  c.name AS credential_name, c.status AS credential_status, c.last_checked_at AS credential_checked_at
  FROM accounts LEFT JOIN credentials c ON c.id = accounts.credential_id`;
