import { getDb } from '../db';
import { credentialManager } from './credentialManager';
import { listCredentials, getCredential, ensureCredential, updateCredential } from '../models/credential';
import { getAllAccounts, createAccount, getAccountById, updateAccount } from '../models/account';
import { encrypt, decrypt } from './encryptionService';
import { credentialRequest } from './cfFactory';
import { clearCache } from './accountRouter';
import { isDemoAccountId } from '../routes/routeUtils';

export const credentials = credentialManager({
  list: async () => listCredentials(),
  get: async id => getCredential(id),
  auth: async row => ({ auth_type: row.auth_type, api_token: row.api_token ? decrypt(row.api_token) : undefined, api_key: row.api_key ? decrypt(row.api_key) : undefined, email: row.email || undefined }),
  ensure: async (name, auth) => ensureCredential({ name, auth_type: auth.auth_type, api_token: auth.auth_type === 'token' ? encrypt(auth.api_token!.trim()) : null, api_key: auth.auth_type === 'global_key' ? encrypt(auth.api_key!.trim()) : null, email: auth.auth_type === 'global_key' ? auth.email?.trim() : null }),
  update: async (id, input) => {
    const { auth, ...metadata } = input;
    updateCredential(id, { ...metadata, ...(auth ? { auth_type: auth.auth_type, api_token: auth.auth_type === 'token' ? encrypt(auth.api_token!.trim()) : null, api_key: auth.auth_type === 'global_key' ? encrypt(auth.api_key!.trim()) : null, email: auth.auth_type === 'global_key' ? auth.email?.trim() : null } : {}) });
  },
  bindings: async () => getAllAccounts(),
  bind: async (row, account, features, plan) => createAccount({ name: account.name, auth_type: row.auth_type, credential_id: row.id, account_id: account.id, enabled_features: features, worker_plan: plan }),
  mark: async (id, status, checkedAt) => updateAccount(id, { access_status: status, is_active: status === 'available' ? 1 : 0, last_checked_at: checkedAt }),
  remove: async id => {
    getDb().transaction(() => {
      getDb().prepare('DELETE FROM accounts WHERE credential_id = ?').run(id);
      getDb().prepare('DELETE FROM credentials WHERE id = ?').run(id);
    })();
  },
  assertMutable: bindings => {
    if (bindings.some(a => isDemoAccountId(a.id))) throw Object.assign(new Error('Demo credential is protected'), { code: 'DEMO_PROTECTED', statusCode: 403 });
  },
  invalidate: async () => clearCache(),
  request: (auth, binding) => credentialRequest(auth, binding ? getAccountById(binding.id) : undefined),
});
