import { describe, expect, it, vi } from 'vitest';
import { normalizeSettings, validateSetting, writeZoneSettings } from '../src/services/zoneSettings';
import { CloudflareError } from '../src/services/cfErrors';
import type { CfRequest } from '../src/services/accountDiscovery';

describe('Zone settings remote confirmation', () => {
  it('maps 0rtt, preserves falsy values, and marks deprecated/read-only fields', () => {
    expect(normalizeSettings([{ id: '0rtt', value: 'off' }, { id: 'browser_cache_ttl', value: 0 }, { id: 'ssl', value: 'strict', editable: false }, { id: 'minify', value: { js: 'off' } }, { id: 'brotli', value: 'on' }])).toMatchObject({ zero_rtt: 'off', browser_cache_ttl: 0, __meta: { ssl: { editable: false }, minify: { editable: false }, brotli: { editable: false } } });
  });
  it('rejects guessed legacy enum and boolean values before sending writes', () => {
    for (const [key, value] of [['ssl', 'full_strict'], ['cache_level', 'simplify'], ['always_use_https', true], ['browser_cache_ttl', '3600'], ['browser_cache_ttl', null]]) expect(() => validateSetting(key as string, value)).toThrow();
    expect(() => validateSetting('ssl', 'strict')).not.toThrow();
    expect(() => validateSetting('cache_level', 'simplified')).not.toThrow();
  });
  it('executes GET → PATCH → GET and returns the verified remote value', async () => {
    let ssl = 'full'; const calls: string[] = [];
    const request: CfRequest = async (path, init) => {
      calls.push(init?.method || 'GET');
      if (init?.method === 'PATCH') { ssl = 'strict'; return { result: { value: ssl } }; }
      return { result: [{ id: 'ssl', value: ssl, editable: true }] };
    };
    expect(await writeZoneSettings(request, 'zone-a', { ssl: 'strict' })).toMatchObject({ updated: ['ssl'], failed: [], settings: { ssl: 'strict' } });
    expect(calls).toEqual(['GET', 'PATCH', 'GET']);
  });
  it('reports a mismatch and updates the UI with what Cloudflare retained', async () => {
    const request: CfRequest = async (_path, init) => init?.method ? { result: { value: 'strict' } } : { result: [{ id: 'ssl', value: 'full', editable: true }] };
    expect(await writeZoneSettings(request, 'zone-a', { ssl: 'strict' })).toMatchObject({ updated: [], failed: ['ssl'], settings: { ssl: 'full' } });
  });
  it('keeps partial results with Cloudflare codes and read-only reasons', async () => {
    const request: CfRequest = async (_path, init) => {
      if (init?.method) throw new CloudflareError(403, 'Zone Settings Edit permission missing', [10000]);
      return { result: [{ id: 'ssl', value: 'full', editable: true }, { id: 'cache_level', value: 'aggressive', editable: false }] };
    };
    const result = await writeZoneSettings(request, 'zone-a', { ssl: 'strict', cache_level: 'basic' });
    expect(result.failed).toHaveLength(2); expect(result.errors.ssl).toContain('HTTP 403 Code 10000'); expect(result.errors.cache_level).toContain('read-only');
  });
  it('rejects a failed/invalid GET rather than generating a successful empty form', async () => {
    const request = vi.fn(async () => { throw new CloudflareError(403, 'Read denied'); });
    await expect(writeZoneSettings(request, 'zone-a', { ssl: 'strict' })).rejects.toThrow('Read denied');
    expect(request).toHaveBeenCalledTimes(1); expect(() => normalizeSettings({})).toThrow();
  });
});
