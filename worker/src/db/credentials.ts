import { decrypt } from '../services/encryption';

export interface Credential {
  id: number; name: string; auth_type: 'token' | 'global_key';
  api_token: string | null; api_key: string | null; email: string | null;
  fingerprint: string | null; status: string; last_checked_at: string | null;
  created_at: string; updated_at: string;
}
export type CredentialInput = Pick<Credential, 'name' | 'auth_type'> & Partial<Pick<Credential, 'api_token' | 'api_key' | 'email'>>;
export async function getCredential(db: D1Database, id: number): Promise<Credential | null> {
  return db.prepare('SELECT * FROM credentials WHERE id = ?').bind(id).first<Credential>();
}
export async function listCredentials(db: D1Database): Promise<Credential[]> {
  return (await db.prepare('SELECT * FROM credentials ORDER BY id DESC').all<Credential>()).results;
}
export async function credentialFingerprint(input: CredentialInput, encryptionKey: string): Promise<string> {
  const secret = input.auth_type === 'token' ? input.api_token : input.api_key;
  if (!secret) throw new Error('Credential is missing authentication secret');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(encryptionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([input.auth_type, input.auth_type === 'global_key' ? input.email?.trim().toLowerCase() : '', await decrypt(secret, encryptionKey)])));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function ensureCredential(db: D1Database, input: CredentialInput, encryptionKey: string): Promise<number> {
  const fingerprint = await credentialFingerprint(input, encryptionKey);
  const found = await db.prepare('SELECT id FROM credentials WHERE fingerprint = ?').bind(fingerprint).first<{ id: number }>();
  if (found) return found.id;
  for (const legacy of (await listCredentials(db)).filter(c => !c.fingerprint)) {
    try {
      if (await credentialFingerprint(legacy, encryptionKey) === fingerprint) {
        await db.prepare('UPDATE credentials SET fingerprint = ? WHERE id = ? AND fingerprint IS NULL').bind(fingerprint, legacy.id).run();
        return legacy.id;
      }
    } catch { /* Retain unreadable legacy ciphertext for recovery. */ }
  }
  await db.prepare('INSERT OR IGNORE INTO credentials (name, auth_type, api_token, api_key, email, fingerprint) VALUES (?, ?, ?, ?, ?, ?)').bind(input.name, input.auth_type, input.api_token || null, input.api_key || null, input.email || null, fingerprint).run();
  return (await db.prepare('SELECT id FROM credentials WHERE fingerprint = ?').bind(fingerprint).first<{ id: number }>())!.id;
}
export async function updateCredential(db: D1Database, id: number, input: Partial<CredentialInput> & { status?: string; last_checked_at?: string }, encryptionKey: string): Promise<void> {
  const existing = await getCredential(db, id);
  if (!existing) throw Object.assign(new Error('Credential not found'), { statusCode: 404 });
  const next = { ...existing, ...input };
  const changingAuth = ['api_token', 'api_key', 'email', 'auth_type'].some(k => k in input);
  await db.prepare('UPDATE credentials SET name = ?, auth_type = ?, api_token = ?, api_key = ?, email = ?, fingerprint = ?, status = ?, last_checked_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(next.name, next.auth_type, next.auth_type === 'token' ? next.api_token : null, next.auth_type === 'global_key' ? next.api_key : null, next.auth_type === 'global_key' ? next.email : null, changingAuth ? await credentialFingerprint(next, encryptionKey) : next.fingerprint, next.status, next.last_checked_at, id).run();
}
export const ACCOUNT_SELECT = `SELECT accounts.*,
  CASE WHEN c.id IS NOT NULL THEN c.api_token ELSE accounts.api_token END AS api_token,
  CASE WHEN c.id IS NOT NULL THEN c.api_key ELSE accounts.api_key END AS api_key,
  CASE WHEN c.id IS NOT NULL THEN c.email ELSE accounts.email END AS email,
  COALESCE(c.auth_type, accounts.auth_type) AS auth_type,
  c.name AS credential_name, c.status AS credential_status, c.last_checked_at AS credential_checked_at
  FROM accounts LEFT JOIN credentials c ON c.id = accounts.credential_id`;
