import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({ config: { dbPath: ':memory:', encryptionKey: 'stable-test-encryption-key', fileLogging: false, apiSecret: '' } }));
import { getDb, initDb } from '../src/db';
import { encrypt, decrypt } from '../src/services/encryptionService';
import { createAccount, deleteAccount, getAccountById, getAllAccounts, getActiveAccounts, listAccountsPaged, updateAccount } from '../src/models/account';
import { getCredential } from '../src/models/credential';

const cfA = 'a'.repeat(32);
const cfB = 'b'.repeat(32);
let originalCipher: string;

beforeAll(() => {
  originalCipher = encrypt('legacy-secret');
  getDb().exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, auth_type TEXT NOT NULL, api_token TEXT, api_key TEXT, email TEXT, account_id TEXT, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  getDb().prepare('INSERT INTO accounts (id, name, auth_type, api_token, account_id) VALUES (?, ?, ?, ?, ?)').run(77, 'Legacy', 'token', originalCipher, cfA);
  initDb();
});

describe('production SQLite credential migration', () => {
  it('preserves Account identity and ciphertext without changing the encryption key', () => {
    const account = getAccountById(77)!;
    expect(account.id).toBe(77);
    expect(account.account_id).toBe(cfA);
    expect(account.api_token).toBe(originalCipher);
    expect(decrypt(account.api_token!)).toBe('legacy-secret');
    expect(getDb().prepare('SELECT api_token FROM accounts WHERE id=77').get()).toEqual({ api_token: null });
    expect(getCredential(account.credential_id!)?.api_token).toBe(originalCipher);
  });
  it('is repeatable and retains audit/quota ownership', () => {
    getDb().prepare("INSERT INTO quota_usage (account_id, resource, date, count) VALUES (77, 'ai_neurons', '2026-10-05', 123)").run();
    initDb(); initDb();
    expect(getAllAccounts()).toHaveLength(1);
    expect(getDb().prepare('SELECT count FROM quota_usage WHERE account_id=77').get()).toEqual({ count: 123 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 1 });
  });
  it('reuses a credential for another Account and never copies its token to accounts', () => {
    const id = createAccount({ name: 'Testing', auth_type: 'token', api_token: encrypt('legacy-secret'), account_id: cfB });
    expect(getAccountById(id)?.credential_id).toBe(getAccountById(77)?.credential_id);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT api_token FROM accounts WHERE id=?').get(id)).toEqual({ api_token: null });
    expect(createAccount({ name: 'Repeated', auth_type: 'token', api_token: encrypt('legacy-secret'), account_id: cfB })).toBe(id);
    expect(listAccountsPaged({ page: 1, pageSize: 20, search: 'Testing' }).total).toBe(1);
  });
  it('keeps the sibling Account usable after deleting one binding', () => {
    const sibling = getAllAccounts().find(a => a.account_id === cfB)!;
    deleteAccount(77);
    expect(decrypt(getAccountById(sibling.id)!.api_token!)).toBe('legacy-secret');
    expect(getCredential(sibling.credential_id!)).toBeDefined();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM quota_usage').get()).toEqual({ n: 0 });
  });
  it('separates enabled state from verification and supports shared credential updates', () => {
    const account = getAllAccounts()[0];
    updateAccount(account.id, { is_enabled: 0 });
    expect(getActiveAccounts()).toHaveLength(0);
    updateAccount(account.id, { is_active: 1, api_token: encrypt('rotated-secret') });
    expect(getActiveAccounts()).toHaveLength(0);
    expect(decrypt(getAccountById(account.id)!.api_token!)).toBe('rotated-secret');
  });
  it('retains Global API Key credentials and creates independent Account contexts', () => {
    const key = encrypt('global-api-key');
    const id = createAccount({ name: 'Global', auth_type: 'global_key', email: 'ops@example.test', api_key: key, account_id: cfA });
    expect(getAccountById(id)).toMatchObject({ auth_type: 'global_key', email: 'ops@example.test', account_id: cfA });
    expect(decrypt(getAccountById(id)!.api_key!)).toBe('global-api-key');
  });
});
