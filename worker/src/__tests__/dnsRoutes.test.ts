import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

const mocks = vi.hoisted(() => ({ cfFetch: vi.fn(), cfFetchAll: vi.fn() }));
const cfA = 'a'.repeat(32); const cfB = 'b'.repeat(32);
const account = { id: 1, name: 'Production', credential_id: 10, account_id: cfA, is_active: 1, is_enabled: 1, auth_type: 'token', api_token: 'ciphertext', api_key: null, email: null, enabled_features: 'dns', proxy_url: '', proxy_enabled: 0 };
const zone = { id: 'zone-a', name: 'example.test', status: 'active', account: { id: cfA }, cfAccountId: 1, accountName: 'Production' };
vi.mock('../services/cfApi', () => ({ cfFetch: mocks.cfFetch, cfFetchAll: mocks.cfFetchAll, accountRequest: vi.fn() }));
vi.mock('../db/models', () => ({ getActiveAccountsByFeature: async () => [account, { ...account, id: 2, name: 'Testing', account_id: cfB }], getAccountById: async () => account, addAuditLog: vi.fn() }));
vi.mock('../services/demo', () => ({ isDemoAccount: () => false }));
import workerDns from '../routes/dns';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cfFetchAll.mockImplementation(async (_account, path) => path.startsWith('/zones?') ? [zone, { ...zone, id: 'zone-b', account: { id: cfB } }] : [{ id: 'record-1', type: 'A', content: '192.0.2.1' }]);
  mocks.cfFetch.mockImplementation(async (_account, _path, _key, init) => ({ result: { id: 'record-1', ...(init?.body ? JSON.parse(init.body) : {}) } }));
});
describe('Worker DNS routes', () => {
  const env = { DB: {}, KV: { get: async () => null, put: async () => {}, delete: async () => {} }, ENCRYPTION_KEY: 'test-key' } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>().route('/dns', workerDns);
  it('filters shared-token Zones by the actual Account and fully enumerates DNS records', async () => {
    const result = await app.request('/dns/domains', {}, env); expect(result.status).toBe(200);
    const zones = await result.json() as Array<{ cfAccountId: number }>; expect(zones).toHaveLength(2);
    expect(zones.map(z => z.cfAccountId)).toEqual([1, 2]);
    await app.request('/dns/domains/example.test/records?accountId=1&zoneId=zone-a', {}, env);
    expect(mocks.cfFetchAll).toHaveBeenCalledWith(account, '/zones/zone-a/dns_records', 'test-key', 100);
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
