import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { getAllAccounts, getAccountById, createAccount, deleteAccount, updateAccount } from '../../worker/src/db/models';
import { listCredentials } from '../../worker/src/db/credentials';
import { encrypt, decrypt } from '../../worker/src/services/encryption';
import { credentials } from '../../worker/src/services/credentials';
import type { Env } from '../../worker/src/types';

const key = 'd1-stable-encryption-key';
const a = { id: 'a'.repeat(32), name: 'Production' };
const b = { id: 'b'.repeat(32), name: 'Testing' };
function d1Adapter(sqlite: Database.Database) {
  function prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async () => sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true }),
      run: async () => { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes } }; },
    };
    return statement;
  }
  return { prepare, batch: async (statements: Array<ReturnType<typeof prepare>>) => Promise.all(statements.map(s => s.run())) } as unknown as Env['DB'];
}
let sqlite: Database.Database;
let db: Env['DB'];
beforeEach(() => { sqlite = new Database(':memory:'); sqlite.pragma('foreign_keys=ON'); sqlite.exec(readFileSync(new URL('../../worker/src/db/schema.sql', import.meta.url), 'utf8')); db = d1Adapter(sqlite); vi.restoreAllMocks(); });

describe('D1 credential model and runtime workflow', () => {
  it('migrates the old schema and preserves legacy ciphertext and Account IDs', async () => {
    const old = new Database(':memory:');
    const cipher = await encrypt('old-global-key', key);
    old.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, auth_type TEXT NOT NULL, api_token TEXT, api_key TEXT, email TEXT, account_id TEXT, is_active INTEGER DEFAULT 1, enabled_features TEXT, available_features TEXT, worker_plan TEXT, proxy_url TEXT, proxy_enabled INTEGER, created_at TEXT, updated_at TEXT);`);
    old.prepare('INSERT INTO accounts (id, name, auth_type, api_key, email, account_id) VALUES (77, ?, ?, ?, ?, ?)').run('Legacy', 'global_key', cipher, 'ops@example.test', a.id);
    const migration = readFileSync(new URL('../../worker/src/db/migrations/0011_credentials.sql', import.meta.url), 'utf8');
    old.exec(migration);
    // D1 runner skips already-existing columns. Remaining statements are safely replayable after interruption.
    old.exec(migration.replace(/^ALTER TABLE.*;$/gm, ''));
    const account = await getAccountById(d1Adapter(old), 77);
    expect(account).toMatchObject({ id: 77, account_id: a.id, api_key: cipher });
    expect(await decrypt(account!.api_key!, key)).toBe('old-global-key');
    expect(old.prepare('SELECT api_key FROM accounts').get()).toEqual({ api_key: null });
    expect(old.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 1 });
    old.close();
  });
  it('normalizes one token for multiple Accounts, with independent binding deletion and disabled state', async () => {
    const api_token = await encrypt('one-token', key);
    const first = await createAccount(db, { name: a.name, auth_type: 'token', api_token, account_id: a.id }, key);
    const second = await createAccount(db, { name: b.name, auth_type: 'token', api_token: await encrypt('one-token', key), account_id: b.id }, key);
    expect(await listCredentials(db)).toHaveLength(1);
    expect((await getAccountById(db, first))!.credential_id).toBe((await getAccountById(db, second))!.credential_id);
    await updateAccount(db, second, { is_enabled: 0 });
    await deleteAccount(db, first);
    expect((await getAccountById(db, second))!.is_enabled).toBe(0);
    expect(await decrypt((await getAccountById(db, second))!.api_token!, key)).toBe('one-token');
  });
  it('creates selected Accounts, syncs new/lost access without deleting bindings, and never exposes tokens', async () => {
    const kv = { delete: vi.fn(async () => {}) } as unknown as Env['KV'];
    const manager = credentials({ DB: db, KV: kv, ENCRYPTION_KEY: key, DEMO_ACCOUNT_IDS: '' } as Env);
    let accounts = [a, b];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/accounts')) return new Response(JSON.stringify({ success: true, result: accounts }), { status: 200 });
      if (path.endsWith('/user/tokens/verify')) return new Response(JSON.stringify({ result: { status: 'active' } }));
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Account permission denied' }] }), { status: 403 });
    }));
    const saved = await manager.save({ auth_type: 'token', api_token: 'private-token', selected_account_ids: [a.id, b.id] });
    expect(saved.ids).toHaveLength(2);
    expect(await listCredentials(db)).toHaveLength(1);
    expect(JSON.stringify(await manager.list())).not.toContain('private-token');
    accounts = [b, { id: 'c'.repeat(32), name: 'New' }];
    const synced = await manager.sync(saved.credential_id);
    expect(synced.new_accounts.map(c => c.name)).toEqual(['New']);
    expect(synced.results.find(r => r.account_id === a.id)?.status).toBe('unauthorized');
    expect(await getAllAccounts(db)).toHaveLength(2);
    await manager.remove(saved.credential_id);
    expect(await getAllAccounts(db)).toHaveLength(0); expect(await listCredentials(db)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
  it('accepts an account-scoped token whose user-token verification endpoint is unauthorized', async () => {
    const manager = credentials({ DB: db, KV: { delete: async () => {} }, ENCRYPTION_KEY: key, DEMO_ACCOUNT_IDS: '' } as unknown as Env);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (new URL(url).pathname.endsWith(`/accounts/${a.id}`)) return new Response(JSON.stringify({ success: true, result: a }));
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'User token verification unauthorized' }] }), { status: 401 });
    }));
    const saved = await manager.save({ auth_type: 'token', api_token: 'account-token', account_id: a.id });
    const synced = await manager.sync(saved.credential_id);
    expect(synced.discovery.credentialStatus).toBe('active');
    expect(synced.results[0].status).toBe('available');
    await manager.update(saved.credential_id, { auth_type: 'token', api_token: 'replacement-account-token' });
    expect((await listCredentials(db))[0].status).toBe('active');
    vi.unstubAllGlobals();
  });
});
