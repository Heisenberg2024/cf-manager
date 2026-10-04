import { discoverAccounts, validateManualAccount, type AuthInput, type CfRequest, type DiscoveredAccount, type DiscoveryResult } from './accountDiscovery';
import { errorDetails } from './cfErrors';

export interface CredentialRow {
  id: number; name: string; auth_type: AuthInput['auth_type']; api_token: string | null;
  api_key: string | null; email: string | null; status: string; last_checked_at: string | null;
}
export interface BindingRow {
  id: number; name: string; account_id: string | null; credential_id?: number;
  is_active: number; is_enabled?: number; access_status?: string;
}
export interface CredentialRepository {
  list(): Promise<CredentialRow[]>;
  get(id: number): Promise<CredentialRow | null | undefined>;
  auth(row: CredentialRow): Promise<AuthInput>;
  ensure(name: string, input: AuthInput): Promise<number>;
  update(id: number, input: { name?: string; auth?: AuthInput; status?: string; last_checked_at?: string }): Promise<void>;
  bindings(): Promise<BindingRow[]>;
  bind(credential: CredentialRow, account: DiscoveredAccount, features?: string, plan?: string): Promise<number>;
  mark(id: number, status: string, checkedAt: string): Promise<void>;
  remove(id: number): Promise<void>;
  assertMutable(bindings: BindingRow[]): void;
  invalidate(): Promise<void>;
  request(auth: AuthInput, binding?: BindingRow): CfRequest;
}
export interface SaveCredentialInput extends AuthInput {
  name?: string; account_id?: string; selected_account_ids?: string[]; enabled_features?: string; worker_plan?: string;
}

function validation(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'VALIDATION_ERROR' });
}
function requireUsableDiscovery(result: DiscoveryResult): void {
  if (['invalid', 'network', 'timeout', 'rate_limited', 'error'].includes(result.status)) {
    throw Object.assign(new Error(result.message || result.status), { statusCode: result.status === 'rate_limited' ? 429 : result.status === 'timeout' ? 504 : result.status === 'invalid' ? 400 : 502, code: `CF_${result.status.toUpperCase()}` });
  }
}

export function credentialManager(repo: CredentialRepository) {
  async function requireCredential(id: number): Promise<CredentialRow> {
    if (!Number.isSafeInteger(id) || id <= 0) validation('Credential ID must be a positive integer');
    const row = await repo.get(id);
    if (!row) throw Object.assign(new Error('Credential not found'), { statusCode: 404, code: 'NOT_FOUND' });
    return row;
  }
  async function list() {
    const [credentials, bindings] = await Promise.all([repo.list(), repo.bindings()]);
    return credentials.map(c => ({ id: c.id, name: c.name, auth_type: c.auth_type, email: c.email, status: c.status, last_checked_at: c.last_checked_at,
      accounts: bindings.filter(a => a.credential_id === c.id).map(a => ({ id: a.id, name: a.name, account_id: a.account_id, is_active: a.is_active, is_enabled: a.is_enabled, access_status: a.access_status })) }));
  }
  async function discover(input: AuthInput) {
    return discoverAccounts(repo.request(input), input.auth_type);
  }
  async function selectedAccounts(input: SaveCredentialInput, request: CfRequest): Promise<DiscoveredAccount[]> {
    if (input.account_id !== undefined && typeof input.account_id !== 'string') validation('Account ID must be a string');
    if (input.account_id?.trim()) return [await validateManualAccount(request, input.account_id.trim())];
    const result = await discoverAccounts(request, input.auth_type);
    requireUsableDiscovery(result);
    if (result.status !== 'discovered') validation('Account enumeration is unavailable. Manually specify and verify an Account ID.');
    const selected = input.selected_account_ids === undefined ? result.accounts.map(a => a.id) : input.selected_account_ids;
    if (!Array.isArray(selected) || !selected.length || selected.length > 500 || selected.some(id => typeof id !== 'string')) validation('Select between 1 and 500 Cloudflare Accounts');
    const ids = new Set(selected);
    const accounts = result.accounts.filter(a => ids.has(a.id));
    if (accounts.length !== ids.size) validation('Selected Account is not accessible by this credential');
    return accounts;
  }
  async function save(input: SaveCredentialInput) {
    const accounts = await selectedAccounts(input, repo.request(input));
    const name = input.name?.trim() || (accounts.length === 1 ? accounts[0].name : input.email?.trim() || 'API Token');
    const id = await repo.ensure(name, input);
    const row = await requireCredential(id);
    const existing = (await repo.bindings()).filter(a => a.credential_id === id);
    repo.assertMutable(existing);
    const ids: number[] = [];
    for (const account of accounts) {
      const bindingId = await repo.bind(row, account, input.enabled_features, input.worker_plan);
      await repo.mark(bindingId, 'available', new Date().toISOString());
      ids.push(bindingId);
    }
    await repo.update(id, { status: 'active', last_checked_at: new Date().toISOString() });
    await repo.invalidate();
    return { credential_id: id, id: ids[0], ids, accounts };
  }
  async function addBindings(id: number, input: { selected_account_ids?: string[]; account_id?: string }) {
    const row = await requireCredential(id);
    repo.assertMutable((await repo.bindings()).filter(a => a.credential_id === id));
    const auth = await repo.auth(row);
    const accounts = await selectedAccounts({ ...auth, ...input }, repo.request(auth));
    const ids: number[] = [];
    for (const a of accounts) {
      const bindingId = await repo.bind(row, a);
      await repo.mark(bindingId, 'available', new Date().toISOString());
      ids.push(bindingId);
    }
    await repo.invalidate();
    return { ids, accounts };
  }
  async function sync(id: number) {
    const row = await requireCredential(id);
    const bindings = (await repo.bindings()).filter(a => a.credential_id === id);
    repo.assertMutable(bindings);
    const auth = await repo.auth(row);
    const request = repo.request(auth, bindings[0]);
    const discovery = await discoverAccounts(request, auth.auth_type);
    const checkedAt = new Date().toISOString();
    await repo.update(id, { status: discovery.credentialStatus, last_checked_at: checkedAt });
    const results: Array<{ id: number; account_id: string | null; name: string; status: string; message?: string }> = [];
    // Bounded work and individual errors. No automatic local deletion on lost permissions.
    for (let offset = 0; offset < bindings.length; offset += 3) {
      await Promise.all(bindings.slice(offset, offset + 3).map(async binding => {
        try {
          if (!binding.account_id) throw Object.assign(new Error('Manually specify an Account ID to complete this legacy binding'), { code: 'VALIDATION_ERROR', statusCode: 400 });
          if (!discovery.accounts.some(a => a.id === binding.account_id)) await validateManualAccount(request, binding.account_id);
          await repo.mark(binding.id, 'available', checkedAt);
          results.push({ id: binding.id, account_id: binding.account_id, name: binding.name, status: 'available' });
        } catch (error) {
          const details = errorDetails(error);
          const status = ['invalid', 'permission'].includes(details.kind) ? 'unauthorized' : details.statusCode === 404 ? 'unavailable' : 'error';
          if (status !== 'error') await repo.mark(binding.id, status, checkedAt);
          results.push({ id: binding.id, account_id: binding.account_id, name: binding.name, status, message: details.message });
        }
      }));
    }
    // Account-scoped tokens may fail /user/tokens/verify but still access their bound Accounts.
    if (results.some(result => result.status === 'available') && discovery.credentialStatus !== 'active') {
      await repo.update(id, { status: 'active', last_checked_at: checkedAt });
      discovery.credentialStatus = 'active';
      discovery.status = 'manual_required';
    }
    await repo.invalidate();
    return { discovery, results, new_accounts: discovery.accounts.filter(a => !bindings.some(b => b.account_id === a.id)) };
  }
  async function update(id: number, input: Partial<AuthInput> & { name?: string }) {
    const row = await requireCredential(id);
    const bindings = (await repo.bindings()).filter(a => a.credential_id === id);
    repo.assertMutable(bindings);
    const changingAuth = !!input.api_token?.trim() || !!input.api_key?.trim() || (!!input.email?.trim() && input.email.trim() !== row.email) || (input.auth_type !== undefined && input.auth_type !== row.auth_type);
    if (changingAuth) {
      const previous = await repo.auth(row);
      const auth: AuthInput = { auth_type: input.auth_type || previous.auth_type, api_token: input.api_token?.trim() || previous.api_token, api_key: input.api_key?.trim() || previous.api_key, email: input.email?.trim() || previous.email };
      const result = await discoverAccounts(repo.request(auth), auth.auth_type);
      if (result.status === 'invalid' && bindings.some(binding => binding.account_id)) {
        // Test actual access before deciding a replacement account-scoped token is invalid.
        const accessible = bindings.find(binding => binding.account_id)!;
        await validateManualAccount(repo.request(auth), accessible.account_id!);
        result.credentialStatus = 'active'; result.status = 'manual_required';
      } else requireUsableDiscovery(result);
      if (result.credentialStatus !== 'active') {
        const first = bindings.find(a => a.account_id);
        if (!first?.account_id) validation('Verify an accessible Account before replacing this credential');
        await validateManualAccount(repo.request(auth), first.account_id);
      }
      await repo.update(id, { auth, ...(input.name?.trim() ? { name: input.name.trim() } : {}) });
      return sync(id);
    }
    if (!input.name?.trim()) validation('Credential name is required');
    await repo.update(id, { name: input.name.trim() });
    await repo.invalidate();
    return { success: true };
  }
  async function remove(id: number) {
    await requireCredential(id);
    repo.assertMutable((await repo.bindings()).filter(a => a.credential_id === id));
    await repo.remove(id);
    await repo.invalidate();
    return { success: true };
  }
  return { list, discover, save, sync, addBindings, update, remove };
}
