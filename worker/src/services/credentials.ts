import type { Env } from '../types';
import { credentialManager } from './credentialManager';
import { listCredentials, getCredential, ensureCredential, updateCredential } from '../db/credentials';
import { getAllAccounts, createAccount, updateAccount } from '../db/models';
import { encrypt, decrypt } from './encryption';
import { credentialRequest } from './cfApi';
import { isDemoAccount } from './demo';
import { invalidateAiCache } from './quotaTracker';

export function credentials(env: Env) {
  const db = env.DB;
  const encryptionKey = env.ENCRYPTION_KEY;
  return credentialManager({
    list: () => listCredentials(db),
    get: id => getCredential(db, id),
    auth: async row => ({ auth_type: row.auth_type, api_token: row.api_token ? await decrypt(row.api_token, encryptionKey) : undefined, api_key: row.api_key ? await decrypt(row.api_key, encryptionKey) : undefined, email: row.email || undefined }),
    ensure: async (name, auth) => ensureCredential(db, { name, auth_type: auth.auth_type, api_token: auth.auth_type === 'token' ? await encrypt(auth.api_token!.trim(), encryptionKey) : null, api_key: auth.auth_type === 'global_key' ? await encrypt(auth.api_key!.trim(), encryptionKey) : null, email: auth.auth_type === 'global_key' ? auth.email?.trim() : null }, encryptionKey),
    update: async (id, input) => {
      const { auth, ...metadata } = input;
      await updateCredential(db, id, { ...metadata, ...(auth ? { auth_type: auth.auth_type, api_token: auth.auth_type === 'token' ? await encrypt(auth.api_token!.trim(), encryptionKey) : null, api_key: auth.auth_type === 'global_key' ? await encrypt(auth.api_key!.trim(), encryptionKey) : null, email: auth.auth_type === 'global_key' ? auth.email?.trim() : null } : {}) }, encryptionKey);
    },
    bindings: () => getAllAccounts(db),
    bind: (row, account, features, plan) => createAccount(db, { name: account.name, auth_type: row.auth_type, credential_id: row.id, account_id: account.id, enabled_features: features, worker_plan: plan }),
    mark: (id, status, checkedAt) => updateAccount(db, id, { access_status: status, is_active: status === 'available' ? 1 : 0, last_checked_at: checkedAt }),
    remove: async id => {
      await db.batch([db.prepare('DELETE FROM accounts WHERE credential_id = ?').bind(id), db.prepare('DELETE FROM credentials WHERE id = ?').bind(id)]);
    },
    assertMutable: bindings => {
      if (bindings.some(a => isDemoAccount(a.id, env.DEMO_ACCOUNT_IDS))) throw Object.assign(new Error('Demo credential is protected'), { code: 'DEMO_PROTECTED', statusCode: 403 });
    },
    invalidate: async () => { await env.KV.delete('dns_zones_all'); await invalidateAiCache(env); },
    request: auth => credentialRequest(auth),
  });
}
