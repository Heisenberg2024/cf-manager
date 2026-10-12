import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const mocks = vi.hoisted(() => ({ find: vi.fn(), list: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn(), cfFetch: vi.fn(), cfFetchAll: vi.fn(), account: vi.fn(), request: vi.fn(), demo: vi.fn() }));
const cfA = 'a'.repeat(32);
const account = { id: 1, name: 'Production', credential_id: 10, account_id: cfA, is_active: 1, is_enabled: 1, auth_type: 'token', api_token: 'ciphertext', api_key: null, email: null, enabled_features: 'dns', proxy_url: '', proxy_enabled: 0 };
vi.mock('../src/services/accountRouter', () => ({ findAccountByDomain: mocks.find, getAllZones: vi.fn(async () => []), getZoneSnapshots: vi.fn(async () => []), getAccountZones: vi.fn(), clearCache: vi.fn() }));
vi.mock('../src/services/dnsService', () => ({ listDnsRecords: mocks.list, createDnsRecord: mocks.create, updateDnsRecord: mocks.edit, deleteDnsRecord: mocks.remove }));
vi.mock('../src/models/auditLog', () => ({ createAuditLog: vi.fn() }));
vi.mock('../src/models/account', () => ({ getAccountById: mocks.account }));
vi.mock('../src/services/cfFactory', () => ({ accountRequest: mocks.request, getCfClient: vi.fn() }));
vi.mock('../src/routes/routeUtils', () => ({ isDemoAccountId: mocks.demo }));
vi.mock('../src/services/logger', () => ({ appLogger: { error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn() } }));
import backendDns from '../src/routes/dns';
import { responseWrapper } from '../src/middleware/responseWrapper';
import { errorHandler } from '../src/middleware/errorHandler';
import { fakeZonePlans } from '../../shared/tests/zonePlans.fixture';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(responseWrapper); app.use('/dns', backendDns); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockReturnValue(account); mocks.demo.mockReturnValue(false);
  mocks.find.mockResolvedValue({ account, zoneId: 'zone-a' });
  mocks.list.mockResolvedValue([{ id: 'record-1', type: 'A', name: 'api.example.test', content: '192.0.2.1', ttl: 300 }]);
  mocks.create.mockImplementation(async (_account, _zone, body) => ({ id: 'created', ...body }));
  mocks.edit.mockImplementation(async (_account, _zone, id, body) => ({ id, ...body }));
});

describe('Docker DNS routes', () => {
  it('exposes bounded record pages with explicit page scope and validates filters', async () => {
    mocks.request.mockReturnValue(async () => ({ result: [{ id: 'record-page' }], result_info: { page: 2, total_pages: 20, total_count: 10000 } }));
    const response = await fetch(`${base}/dns/domains/example.test/records?accountId=1&zoneId=zone-a&page=2&perPage=500&type=TXT`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).data).toMatchObject({ records: [{ id: 'record-page' }], meta: { page: 2, scope: 'page', total_count: 10000 } });
    expect((await fetch(`${base}/dns/domains/example.test/records?page=-1`)).status).toBe(400);
  });
  it('uses Enterprise contract rate IDs and continues creating after the first domain fails', async () => {
    const cf = fakeZonePlans({ capacity: 10, omitLegacyEnterprise: true, enterpriseName: 'Enterprise Website', enterpriseRateId: 'd'.repeat(32), failedName: 'bad.test' });
    mocks.request.mockReturnValue(cf.request);
    const names = ['bad.test', 'one.test', 'two.test'];
    const response = await fetch(`${base}/dns/domains`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 1, names, plan: 'enterprise' }) });
    const result = (await response.json()).data;
    expect(result).toMatchObject({ total: 3, succeeded: 2, failed: 1, fallback_count: 0 });
    expect(result.results[1]).toMatchObject({ zone_created: true, plan: { id: 'enterprise' } });
    expect(cf.calls.filter(call => call.path === '/zones').map(call => call.body?.name)).toEqual(names);
    expect(cf.calls.filter(call => call.path.endsWith('/subscription')).map(call => call.body?.rate_plan)).toEqual([{ id: 'd'.repeat(32) }, { id: 'd'.repeat(32) }]);
  });
  it('returns accepted pending changes instead of local 409 errors when Zone plan activation is delayed', async () => {
    const cf = fakeZonePlans({ noActivation: true });
    cf.zones.set('zone-a', { id: 'zone-a', name: 'example.test', account: { id: cf.accountId }, plan: { id: 'opaque-ent', legacy_id: 'enterprise', name: 'Enterprise Website' }, name_servers: [] });
    mocks.request.mockReturnValue(cf.request);
    const response = await fetch(`${base}/dns/domains/example.test/plan?accountId=1&zoneId=zone-a`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'free' }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ success: true, activation_pending: true, outcome_uncertain: false, plan: { id: 'enterprise' } });
    expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
  });
  it('reads and changes the exact Zone plan and preserves unsuccessful receipts inside the response envelope', async () => {
    const cf = fakeZonePlans();
    cf.zones.set('zone-a', { id: 'zone-a', name: 'example.test', account: { id: cf.accountId }, plan: { id: 'opaque-ent', legacy_id: 'enterprise', name: 'Enterprise Website' }, name_servers: [] });
    mocks.request.mockReturnValue(cf.request);
    const path = `${base}/dns/domains/example.test`; const query = '?accountId=1&zoneId=zone-a';
    const options = await fetch(`${path}/plans${query}`);
    expect((await options.json()).data.plan.id).toBe('enterprise');
    const send = (plan: string) => fetch(`${path}/plan${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    const changed = await send('free');
    expect((await changed.json()).data).toMatchObject({ success: true, plan: { id: 'free' } });
    cf.zones.get('zone-a')!.plan.legacy_id = 'enterprise';
    mocks.request.mockReturnValue(async (path: string, init: RequestInit) => {
      if (path.endsWith('/subscription')) throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
      return cf.request(path, init);
    });
    const failed = await send('free');
    expect((await failed.json()).data).toMatchObject({ success: false, outcome_uncertain: true, plan: { id: 'enterprise' } });
    expect(mocks.find).toHaveBeenCalledWith('example.test', { accountId: 1, zoneId: 'zone-a' });
    expect((await send('opaque-ent')).status).toBe(400);
    mocks.demo.mockReturnValue(true);
    expect((await send('free')).status).toBe(403);
  });
  it('returns ordered actual plans and Free fallback receipts for the selected local binding', async () => {
    const cf = fakeZonePlans(); mocks.request.mockReturnValue(cf.request);
    const result = await fetch(`${base}/dns/domains`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 1, names: ['1.test', '2.test', '3.test', '4.test', '5.test'], plan: 'enterprise' }) });
    expect(result.status).toBe(201); const body = (await result.json()).data;
    expect(body.fallback_count).toBe(2);
    expect(body.results.map((row: { plan: { id: string } }) => row.plan.id)).toEqual(['enterprise', 'enterprise', 'enterprise', 'free', 'free']);
    expect(mocks.account).toHaveBeenCalledWith(1); expect(mocks.request).toHaveBeenCalledWith(account);
  });
  it('reads plan options for an explicit binding and guards invalid input and demo writes', async () => {
    const cf = fakeZonePlans(); mocks.request.mockReturnValue(cf.request);
    const plans = await fetch(`${base}/dns/accounts/1/plans`); expect(plans.status).toBe(200);
    expect((await plans.json()).data.plans[1].id).toBe('enterprise');
    const send = (body: unknown) => fetch(`${base}/dns/domains`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await send({ account_id: 1, names: [42] })).status).toBe(400);
    mocks.demo.mockReturnValue(true); expect((await send({ account_id: 1, names: ['a.test'], plan: 'enterprise' })).status).toBe(403);
    expect(cf.zones.size).toBe(0);
  });
  it('creates, edits and deletes a record in the captured Account/Zone context', async () => {
    const path = '/dns/domains/example.test/records'; const query = '?accountId=1&zoneId=zone-a';
    const body = { type: 'A', name: 'api.example.test', content: '192.0.2.1', ttl: 300, proxied: false };
    const created = await fetch(`${base}${path}${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(created.status).toBe(201); expect((await created.json()).data.id).toBe('created');
    const edited = await fetch(`${base}${path}/record-1${query}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600 }) });
    expect((await edited.json()).data.ttl).toBe(600);
    const removed = await fetch(`${base}${path}/record-1${query}`, { method: 'DELETE' }); expect(removed.ok).toBe(true);
    expect(mocks.find).toHaveBeenCalledWith('example.test', { accountId: 1, zoneId: 'zone-a' });
    expect(mocks.remove).toHaveBeenCalledWith(account, 'zone-a', 'record-1');
  });
  it('returns the real HTTP status and Cloudflare error code for a single failed operation', async () => {
    mocks.edit.mockRejectedValue(Object.assign(new Error('DNS Validation Error'), { status: 403, error: { errors: [{ code: 1004, message: 'DNS Validation Error' }] } }));
    const result = await fetch(`${base}/dns/domains/example.test/records/record-1?accountId=1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(result.status).toBe(403); const body = await result.json(); expect(body.error.message).toContain('1004'); expect(body.error.code).toBe('CF_PERMISSION');
  });
});

