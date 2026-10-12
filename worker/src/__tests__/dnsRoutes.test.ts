import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

const mocks = vi.hoisted(() => ({ cfFetch: vi.fn(), cfFetchAll: vi.fn(), request: vi.fn(), account: vi.fn(), demo: vi.fn() }));
const cfA = 'a'.repeat(32); const cfB = 'b'.repeat(32);
const account = { id: 1, name: 'Production', credential_id: 10, account_id: cfA, is_active: 1, is_enabled: 1, auth_type: 'token', api_token: 'ciphertext', api_key: null, email: null, enabled_features: 'dns', proxy_url: '', proxy_enabled: 0 };
const zone = { id: 'zone-a', name: 'example.test', status: 'active', account: { id: cfA }, cfAccountId: 1, accountName: 'Production' };
vi.mock('../services/cfApi', () => ({ cfFetch: mocks.cfFetch, cfFetchAll: mocks.cfFetchAll, accountRequest: mocks.request }));
vi.mock('../db/models', () => ({ getActiveAccountsByFeature: async () => [account, { ...account, id: 2, name: 'Testing', account_id: cfB }], getAccountById: mocks.account, addAuditLog: vi.fn() }));
vi.mock('../services/demo', () => ({ isDemoAccount: mocks.demo }));
import workerDns from '../routes/dns';
import { getDnsDirectory } from '../services/dnsDirectory';
const env = { DB: {}, KV: { get: async () => null, put: async () => {}, delete: async () => {} }, ENCRYPTION_KEY: 'test-key' } as unknown as Env;
import { fakeZonePlans } from '../../../shared/tests/zonePlans.fixture';
import { errorDetails } from '../services/cfErrors';
import { responseWrapper } from '../middleware/responseWrapper';

beforeEach(() => {
  vi.resetAllMocks();
  getDnsDirectory(env.DB).invalidate();
  mocks.request.mockImplementation(async a => async (path: string) => path.startsWith('/zones?') ? { result: [zone, { ...zone, id: 'zone-b', account: { id: cfB } }], result_info: { total_pages: 1 } } : path.includes('/dns_records') ? { result: [{ id: 'record-1', type: 'A', content: '192.0.2.1' }], result_info: { total_pages: 1 } } : { result: { ...zone, account: { id: a.account_id } } });
  mocks.account.mockResolvedValue(account); mocks.demo.mockReturnValue(false);
  mocks.cfFetchAll.mockImplementation(async (_account, path) => path.startsWith('/zones?') ? [zone, { ...zone, id: 'zone-b', account: { id: cfB } }] : [{ id: 'record-1', type: 'A', content: '192.0.2.1' }]);
  mocks.cfFetch.mockImplementation(async (_account, _path, _key, init) => ({ result: { id: 'record-1', ...(init?.body ? JSON.parse(init.body) : {}) } }));
});
describe('Worker DNS routes', () => {
  const app = new Hono<{ Bindings: Env }>().route('/dns', workerDns);
  app.onError((error, c) => { const detail = errorDetails(error); return c.json({ error: detail }, detail.statusCode as 400); });
  it('exposes the same bounded page contract and fresh Account snapshot metadata', async () => {
    const snapshot = await app.request('/dns/accounts/1/domains?refresh=true', {}, env);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('Cache-Control')).toBe('no-store');
    expect(await snapshot.json()).toMatchObject({ zones: [{ id: 'zone-a', cfAccountId: 1 }], meta: { accountId: 1, state: 'miss' } });
    const response = await app.request('/dns/domains/example.test/records?accountId=1&zoneId=zone-a&page=2&perPage=500&type=TXT', {}, env);
    expect(await response.json()).toMatchObject({ records: [{ id: 'record-1' }], meta: { scope: 'page' } });
    expect((await app.request('/dns/domains/example.test/records?page=-1', {}, env)).status).toBe(400);
  });
  it('rejects actual Zone ownership mismatch without issuing a write', async () => {
    mocks.request.mockResolvedValue(async () => ({ result: { ...zone, account: { id: cfB } } }));
    const response = await app.request('/dns/domains/example.test/records?accountId=1&zoneId=zone-a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(response.status).toBe(409); expect(mocks.cfFetch).not.toHaveBeenCalled();
  });
  it('rejects a binding without DNS capability before reading or writing Cloudflare', async () => {
    const unsafe = await app.request('/dns/domains/example.test/proxy?accountId=1&zoneId=zone-a', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record_id: '../../foreign-zone', proxied: true }) }, env);
    expect(unsafe.status).toBe(400); expect(mocks.cfFetch).not.toHaveBeenCalled();
    mocks.account.mockResolvedValue({ ...account, enabled_features: 'ai' });
    const response = await app.request('/dns/domains/example.test/records?accountId=1&zoneId=zone-a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(response.status).toBe(409); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.cfFetch).not.toHaveBeenCalled();
  });
  it('recognizes contract Enterprise rates and continues after a failed first creation', async () => {
    const cf = fakeZonePlans({ capacity: 10, omitLegacyEnterprise: true, enterpriseName: 'Enterprise Website', enterpriseRateId: 'd'.repeat(32), failedName: 'bad.test' });
    mocks.request.mockResolvedValue(cf.request);
    const names = ['bad.test', 'one.test', 'two.test'];
    const response = await app.request('/dns/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 1, names, plan: 'enterprise' }) }, env);
    const result = await response.json() as { total: number; results: Array<{ plan?: { id: string } }> };
    expect(result).toMatchObject({ total: 3, succeeded: 2, failed: 1, fallback_count: 0 });
    expect(result.results[1].plan?.id).toBe('enterprise');
    expect(cf.calls.filter(call => call.path === '/zones').map(call => call.body?.name)).toEqual(names);
    expect(cf.calls.filter(call => call.path.endsWith('/subscription')).map(call => call.body?.rate_plan)).toEqual([{ id: 'd'.repeat(32) }, { id: 'd'.repeat(32) }]);
  });
  it('returns accepted pending changes without confusing actual activation with submission success', async () => {
    const cf = fakeZonePlans({ noActivation: true });
    cf.zones.set('zone-a', { id: 'zone-a', name: 'example.test', account: { id: cf.accountId }, plan: { id: 'opaque-ent', legacy_id: 'enterprise', name: 'Enterprise Website' }, name_servers: [] });
    mocks.request.mockResolvedValue(cf.request);
    const response = await app.request('/dns/domains/example.test/plan?accountId=1&zoneId=zone-a', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'free' }) }, env);
    expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown }).data).toMatchObject({ success: true, activation_pending: true, outcome_uncertain: false, plan: { id: 'enterprise' } });
    expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
  });
  it('changes only the selected Zone and preserves failed plan receipts through the production response wrapper', async () => {
    const wrapped = new Hono<{ Bindings: Env }>(); wrapped.use('*', responseWrapper); wrapped.route('/dns', workerDns);
    wrapped.onError((error, c) => { const detail = errorDetails(error); return c.json({ error: detail }, detail.statusCode as 400); });
    const cf = fakeZonePlans();
    cf.zones.set('zone-a', { id: 'zone-a', name: 'example.test', account: { id: cf.accountId }, plan: { id: 'opaque-ent', legacy_id: 'enterprise', name: 'Enterprise Website' }, name_servers: [] });
    mocks.request.mockResolvedValue(cf.request);
    const path = '/dns/domains/example.test'; const query = '?accountId=1&zoneId=zone-a';
    const options = await wrapped.request(`${path}/plans${query}`, {}, env);
    expect((await options.json() as { data: { plan: { id: string } } }).data.plan.id).toBe('enterprise');
    const send = (plan: string) => wrapped.request(`${path}/plan${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) }, env);
    expect((await (await send('free')).json() as { data: unknown }).data).toMatchObject({ success: true, plan: { id: 'free' } });
    cf.zones.get('zone-a')!.plan.legacy_id = 'enterprise';
    mocks.request.mockResolvedValue(async (path: string, init: RequestInit) => {
      if (path.endsWith('/subscription')) throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
      return cf.request(path, init);
    });
    expect((await (await send('free')).json() as { data: unknown }).data).toMatchObject({ success: false, outcome_uncertain: true });
    expect((await send('opaque-ent')).status).toBe(400);
    mocks.demo.mockReturnValue(true); expect((await send('free')).status).toBe(403);
  });
  it('returns the same ordered plan allocation and Free fallback as Express', async () => {
    const cf = fakeZonePlans(); mocks.request.mockResolvedValue(cf.request);
    const result = await app.request('/dns/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 1, names: ['1.test', '2.test', '3.test', '4.test', '5.test'], plan: 'enterprise' }) }, env);
    expect(result.status).toBe(201);
    const body = await result.json() as { fallback_count: number; results: Array<{ plan: { id: string } }> };
    expect(body.fallback_count).toBe(2); expect(body.results.map(row => row.plan.id)).toEqual(['enterprise', 'enterprise', 'enterprise', 'free', 'free']);
    expect(mocks.account).toHaveBeenCalledWith(env.DB, 1); expect(mocks.request).toHaveBeenCalledWith(account, env.ENCRYPTION_KEY);
  });
  it('reads plans from the chosen binding and rejects malformed input and demo writes', async () => {
    const cf = fakeZonePlans(); mocks.request.mockResolvedValue(cf.request);
    const plans = await app.request('/dns/accounts/1/plans', {}, env); expect(plans.status).toBe(200);
    expect((await plans.json() as { plans: Array<{ id: string }> }).plans[1].id).toBe('enterprise');
    const send = (body: unknown) => app.request('/dns/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
    expect((await send({ account_id: 1, names: [42] })).status).toBe(400);
    mocks.demo.mockReturnValue(true); expect((await send({ account_id: 1, names: ['a.test'], plan: 'enterprise' })).status).toBe(403);
    expect(cf.zones.size).toBe(0);
  });
  it('filters shared-token Zones by the actual Account and fully enumerates DNS records', async () => {
    const result = await app.request('/dns/domains', {}, env); expect(result.status).toBe(200);
    const zones = await result.json() as Array<{ cfAccountId: number }>; expect(zones).toHaveLength(2);
    expect(zones.map(z => z.cfAccountId)).toEqual([1, 2]);
    await app.request('/dns/domains/example.test/records?accountId=1&zoneId=zone-a', {}, env);
    expect(mocks.request).toHaveBeenCalledWith(account, 'test-key');
    expect(mocks.cfFetchAll).not.toHaveBeenCalled();
  });
  it('uses PATCH at Cloudflare for partial TTL edits, preserving existing record fields', async () => {
    const result = await app.request('/dns/domains/example.test/records/record-1?accountId=1&zoneId=zone-a', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600 }) }, env);
    expect(result.status).toBe(200);
    expect(mocks.cfFetch).toHaveBeenCalledWith(account, '/zones/zone-a/dns_records/record-1', 'test-key', { method: 'PATCH', body: '{"ttl":600}' });
    expect((await result.json() as { ttl: number }).ttl).toBe(600);
  });
  it('creates and deletes only the chosen Zone', async () => {
    await app.request('/dns/domains/example.test/records?accountId=1&zoneId=zone-a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"A","name":"api.example.test","content":"192.0.2.1"}' }, env);
    expect(mocks.cfFetch).toHaveBeenCalledWith(account, '/zones/zone-a/dns_records', 'test-key', expect.objectContaining({ method: 'POST' }));
    await app.request('/dns/domains/example.test/records/record-1?accountId=1&zoneId=zone-a', { method: 'DELETE' }, env);
    expect(mocks.cfFetch).toHaveBeenCalledWith(account, '/zones/zone-a/dns_records/record-1', 'test-key', { method: 'DELETE' });
  });
});
