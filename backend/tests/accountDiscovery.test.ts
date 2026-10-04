import { describe, it, expect, vi } from 'vitest';
import { authHeaders, createCfRequest, discoverAccounts, listAccessibleAccounts, validateManualAccount, type CfRequest } from '../src/services/accountDiscovery';
import { CloudflareError, redact, rememberSecret } from '../src/services/cfErrors';

const a = { id: 'a'.repeat(32), name: 'Production' };
const b = { id: 'b'.repeat(32), name: 'Testing' };

describe('Cloudflare account discovery', () => {
  it.each(['token', 'global_key'] as const)('discovers a single account using %s', async type => {
    const request: CfRequest = async () => ({ success: true, result: [a] });
    expect(await discoverAccounts(request, type)).toMatchObject({ status: 'discovered', accounts: [a], credentialStatus: 'active' });
  });
  it('reads every page using total_count when total_pages is absent', async () => {
    const request = vi.fn(async (path: string) => ({ result: path.includes('page=1&') ? [a] : [b], result_info: { total_count: 2, per_page: 1 } }));
    expect(await listAccessibleAccounts(request)).toEqual([a, b]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects a non-advancing page rather than silently losing accounts', async () => {
    await expect(listAccessibleAccounts(async () => ({ result: [a], result_info: { total_count: 5 } }))).rejects.toThrow('did not advance');
  });
  it('keeps a verified scoped token usable when enumeration is forbidden', async () => {
    const request: CfRequest = async path => {
      if (path === '/user/tokens/verify') return { result: { status: 'active' } };
      throw new CloudflareError(403, 'Account list permission missing', [10000]);
    };
    expect(await discoverAccounts(request, 'token')).toMatchObject({ status: 'manual_required', credentialStatus: 'active' });
  });
  it('does not label a Global Key with restricted account listing invalid', async () => {
    expect(await discoverAccounts(async () => { throw new CloudflareError(403, 'Forbidden'); }, 'global_key')).toMatchObject({ status: 'manual_required', credentialStatus: 'unknown' });
  });
  it('distinguishes invalid tokens from permission failures', async () => {
    expect(await discoverAccounts(async () => { throw new CloudflareError(401, 'Invalid API Token'); }, 'token')).toMatchObject({ status: 'invalid', credentialStatus: 'invalid' });
  });
  it.each(['expired', 'disabled'])('rejects %s token verification', async status => {
    const request: CfRequest = async path => {
      if (path === '/user/tokens/verify') return { result: { status } };
      throw new CloudflareError(403, 'Forbidden');
    };
    expect((await discoverAccounts(request, 'token')).status).toBe('invalid');
  });
  it.each([['network', new Error('fetch failed')], ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })], ['rate_limited', new CloudflareError(429, 'Too many requests')]])('classifies %s without marking credentials invalid', async (status, error) => {
    expect(await discoverAccounts(async () => { throw error; }, 'token')).toMatchObject({ status, credentialStatus: 'unknown' });
  });
  it('validates a manually entered Account ID', async () => {
    const request = vi.fn(async () => ({ result: a }));
    expect(await validateManualAccount(request, a.id)).toEqual(a);
    expect(request).toHaveBeenCalledWith(`/accounts/${a.id}`);
  });
  it('validates a DNS-only token by matching the actual Zone account', async () => {
    const request: CfRequest = async path => {
      if (path.startsWith('/zones?')) return { result: [{ account: a }] };
      throw new CloudflareError(403, 'Account Settings Read unavailable');
    };
    expect(await validateManualAccount(request, a.id)).toEqual(a);
    await expect(validateManualAccount(request, b.id)).rejects.toThrow();
  });
  it('does not accept a mismatched Account ID response', async () => {
    await expect(validateManualAccount(async () => ({ result: b }), a.id)).rejects.toThrow('Unexpected Account ID');
    await expect(validateManualAccount(async () => ({ result: a }), 'invalid')).rejects.toThrow('32 hexadecimal');
  });
});

describe('bounded retries and sensitive diagnostics', () => {
  it('preserves body-read timeout classification instead of returning an empty successful object', async () => {
    const request = createCfRequest(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new DOMException('Body timed out', 'AbortError'); } }), {});
    await expect(request('/accounts')).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('retains the real upstream HTTP status when a successful HTTP response contains a CF failure', async () => {
    const request = createCfRequest(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ success: false, errors: [{ code: 1004, message: 'DNS validation error' }] }) }), {});
    await expect(request('/zones/a')).rejects.toMatchObject({ status: 200, statusCode: 502 });
  });
  it('retries 429 at most twice then returns the actual failure', async () => {
    const send = vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), json: async () => ({ success: false, errors: [{ code: 1015, message: 'Rate limited' }] }) }));
    const sleep = vi.fn(async () => {});
    await expect(createCfRequest(send, {}, 'Account Production', sleep)('/accounts')).rejects.toThrow('HTTP 429 Code 1015');
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it('returns a long Retry-After instead of retrying early', async () => {
    const send = vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '60' }), json: async () => ({}) }));
    await expect(createCfRequest(send, {})('/accounts')).rejects.toThrow('retry after 60s');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('never retries an ambiguous failed write', async () => {
    const send = vi.fn(async () => { throw new Error('connection reset'); });
    await expect(createCfRequest(send, {})('/zones/a/dns_records', { method: 'POST' })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('redacts full known secrets, auth fields, cookies and URL credentials', () => {
    rememberSecret('top-secret-token');
    const text = redact('token echoed: top-secret-token Authorization: Bearer another-secret api_key="global-secret" Cookie=session-secret https://user:pass@proxy.test');
    for (const secret of ['top-secret-token', 'another-secret', 'global-secret', 'session-secret', 'user:pass']) expect(text).not.toContain(secret);
    expect(authHeaders({ auth_type: 'global_key', email: 'ops@example.test', api_key: 'test-key' })).toEqual({ 'X-Auth-Key': 'test-key', 'X-Auth-Email': 'ops@example.test' });
  });
});
