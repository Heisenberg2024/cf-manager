import { describe, expect, it } from 'vitest';
import { cacheRuleParameters, headerRuleParameters } from '../src/utils/rulePayload';

describe('Cloudflare rule payloads', () => {
  it('uses official edge_ttl enum and default field while retaining existing options', () => {
    expect(cacheRuleParameters(true, 'custom', 3600, { origin_cache_control: true, edge_ttl: { status_code_ttl: [{ status_code: 404, value: 30 }] } })).toEqual({ cache: true, origin_cache_control: true, edge_ttl: { mode: 'override_origin', default: 3600, status_code_ttl: [{ status_code: 404, value: 30 }] } });
  });
  it('respects origin headers without leaving a guessed override TTL', () => {
    expect(cacheRuleParameters(false, 'respect_origin', 3600, { edge_ttl: { mode: 'override_origin', default: 900 } })).toEqual({ cache: false, edge_ttl: { mode: 'respect_origin' } });
  });
  it('builds actual header operations rather than nested request/response objects', () => {
    expect(headerRuleParameters('x-service', 'set', 'manager')).toEqual({ headers: { 'x-service': { operation: 'set', value: 'manager' } } });
    expect(headerRuleParameters('x-service', 'remove', '')).toEqual({ headers: { 'x-service': { operation: 'remove' } } });
  });
});
