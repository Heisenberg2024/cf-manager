import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const mocks = vi.hoisted(() => ({ find: vi.fn(), list: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn(), cfFetch: vi.fn(), cfFetchAll: vi.fn(), account: vi.fn(), request: vi.fn(), demo: vi.fn() }));
const cfA = 'a'.repeat(32);
const account = { id: 1, name: 'Production', credential_id: 10, account_id: cfA, is_active: 1, is_enabled: 1, auth_type: 'token', api_token: 'ciphertext', api_key: null, email: null, enabled_features: 'dns', proxy_url: '', proxy_enabled: 0 };
vi.mock('../src/services/accountRouter', () => ({ findAccountByDomain: mocks.find, getAllZones: vi.fn(async () => []), clearCache: vi.fn() }));
vi.mock('../src/services/dnsService', () => ({ listDnsRecords: mocks.list, createDnsRecord: mocks.create, updateDnsRecord: mocks.edit, deleteDnsRecord: mocks.remove }));
vi.mock('../src/models/auditLog', () => ({ createAuditLog: vi.fn() }));
vi.mock('../src/models/account', () => ({ getAccountById: mocks.account }));
vi.mock('../src/services/cfFactory', () => ({ accountRequest: mocks.request, getCfClient: vi.fn() }));
vi.mock('../src/routes/routeUtils', () => ({ isDemoAccountId: mocks.demo }));
vi.mock('../src/services/logger', () => ({ appLogger: { error: vi.fn(), warn: vi.fn() } }));
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

