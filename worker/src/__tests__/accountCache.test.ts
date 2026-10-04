import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

const mocks = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn(), invalidateAi: vi.fn(), deleteKv: vi.fn() }));
vi.mock('../db/models', () => ({ getAccountById: async () => ({ id: 1, name: 'Production', auth_type: 'token', account_id: 'a'.repeat(32), credential_id: 10 }), updateAccount: mocks.update, deleteAccount: mocks.remove, addAuditLog: vi.fn() }));
vi.mock('../services/quotaTracker', () => ({ getQuotaSummary: async () => [], invalidateAiCache: mocks.invalidateAi }));
vi.mock('../services/demo', () => ({ isDemoAccount: () => false }));
import accountsRouter from '../routes/accounts';

beforeEach(() => vi.clearAllMocks());
describe('Account mutation invalidates routing and Zone caches', () => {
  const env = { DB: {}, KV: { delete: mocks.deleteKv }, ENCRYPTION_KEY: 'test-key' } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>().route('/accounts', accountsRouter);
  it.each([
    ['PUT', '/accounts/1', { is_enabled: 0 }],
    ['PATCH', '/accounts/1/features', { enabled_features: '' }],
    ['DELETE', '/accounts/1', undefined],
  ])('invalidates caches after %s %s', async (method, path, body) => {
    const response = await app.request(path as string, { method: method as string, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    expect(response.status).toBe(200);
    expect(mocks.deleteKv).toHaveBeenCalledWith('dns_zones_all');
    expect(mocks.invalidateAi).toHaveBeenCalledWith(env);
  });
  it('keeps the established CF Account identity stable instead of moving historical quota ownership', async () => {
    const response = await app.request('/accounts/1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'b'.repeat(32) }) }, env);
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
