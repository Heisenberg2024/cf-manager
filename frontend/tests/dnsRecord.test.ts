import { describe, expect, it } from 'vitest';
import { buildDnsRecord } from '../src/utils/dnsRecord';

const record = { type: 'A', name: 'api', content: '192.0.2.1', ttl: 300, proxied: true };
describe('DNS form → Cloudflare payload', () => {
  it('expands relative and root names while preserving a full record name', () => {
    expect(buildDnsRecord(record, 'example.test').name).toBe('api.example.test');
    expect(buildDnsRecord({ ...record, name: '@' }, 'example.test').name).toBe('example.test');
    expect(buildDnsRecord({ ...record, name: 'api.example.test.' }, 'example.test').name).toBe('api.example.test');
  });
  it('forces proxied TTL to automatic and never proxies unsupported record types', () => {
    expect(buildDnsRecord(record, 'example.test').ttl).toBe(1);
    expect(buildDnsRecord({ ...record, type: 'MX', content: 'mail.example.test', priority: 0 }, 'example.test')).toMatchObject({ proxied: false, ttl: 300, priority: 0 });
  });
  it('uses the SRV data object and preserves zero priority/weight', () => {
    expect(buildDnsRecord({ ...record, type: 'SRV', name: '_sip._tcp', content: 'sip.example.test', priority: 0, weight: 0, port: 5060 }, 'example.test')).toEqual({ type: 'SRV', name: '_sip._tcp.example.test', ttl: 300, proxied: false, data: { target: 'sip.example.test', priority: 0, weight: 0, port: 5060 } });
  });
});
