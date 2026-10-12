import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ accounts: [{ id: 1, name: 'A', account_id: 'cf-1', credential_id: 1, is_active: 1, is_enabled: 1, enabled_features: 'dns', api_token: 'synthetic' }, { id: 2, name: 'B', account_id: 'cf-2', credential_id: 2, is_active: 1, is_enabled: 1, enabled_features: 'dns', api_token: 'synthetic' }], get: vi.fn() }));
vi.mock('../src/models/account', () => ({ getActiveAccounts: () => mocks.accounts, getActiveAccountsByFeature: () => mocks.accounts, getAccountById: (id: number) => mocks.accounts.find(a => a.id === id) }));
vi.mock('../src/services/cfFactory', () => ({ accountRequest: (account: { id: number }) => (path: string) => mocks.get(account.id, path) }));
vi.mock('../src/services/aiService', () => ({ isPaidModelName: vi.fn() }));
vi.mock('../src/services/quotaTracker', () => ({ getAccountQuota: vi.fn() }));
vi.mock('../src/models/quotaUsage', () => ({ getQuotaTodayByResource: vi.fn() }));
vi.mock('../src/services/logger', () => ({ apiLogger: { info: vi.fn() }, appLogger: { warn: vi.fn() } }));
import { clearCache, findAccountByDomain } from '../src/services/accountRouter';
beforeEach(() => {
  clearCache(); mocks.get.mockReset(); mocks.accounts[0].is_enabled = 1;
  mocks.get.mockImplementation(async (id: number, path: string) => {
    const zone = { id: `zone-${id}`, name: 'same.test', account: { id: `cf-${id}` } };
    return { result: path.startsWith('/zones?') ? [zone] : zone };
  });
});
describe('DNS binding safety and precise access', () => {
  it('resolves an exact binding with one live GET and no Account list enumeration', async () => {
    expect(await findAccountByDomain('same.test', { accountId: 1, zoneId: 'zone-1' })).toMatchObject({ zoneId: 'zone-1', account: { id: 1 } });
    expect(mocks.get.mock.calls).toEqual([[1, '/zones/zone-1']]);
  });
  it('rejects disabled bindings before touching Cloudflare', async () => {
    await expect(findAccountByDomain('same.test', { accountId: NaN, zoneId: 'zone-1' })).rejects.toMatchObject({ statusCode: 400 });
    mocks.accounts[0].is_enabled = 0;
    await expect(findAccountByDomain('same.test', { accountId: 1, zoneId: 'zone-1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('preserves same-name ambiguity in legacy interfaces', async () => {
    await expect(findAccountByDomain('same.test')).rejects.toMatchObject({ statusCode: 409, code: 'AMBIGUOUS_ACCOUNT' });
  });
  it('does not infer a unique owner from a partially failed legacy Account scan', async () => {
    mocks.get.mockImplementation(async (id: number) => { if (id === 2) throw new Error('offline'); return { result: [{ id: 'zone-1', name: 'same.test', account: { id: 'cf-1' } }] }; });
    await expect(findAccountByDomain('same.test')).rejects.toMatchObject({ statusCode: 503, code: 'INCOMPLETE_ACCOUNT_SCAN' });
  });
});
