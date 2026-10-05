/** Shared single-Zone and multi-Zone DNS definitions. */
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV', 'NS', 'PTR'] as const;
export const PROXY_TYPES = ['A', 'AAAA', 'CNAME'];
export interface DnsRecordForm { type: string; name: string; content: string; ttl: number; proxied: boolean; priority?: number; weight?: number; port?: number; flags?: number; tag?: string; comment?: string }
export interface DnsRecordInput { type?: string; name?: string; content?: string; ttl?: number; proxied?: boolean; priority?: number; comment?: string; data?: Record<string, string | number> }
export function dnsName(host: string, zone: string, relativeOnly = false): string {
  const name = host.trim().replace(/\.$/, '').toLowerCase();
  zone = zone.trim().replace(/\.$/, '').toLowerCase();
  if (name === '@' || !name) return zone;
  if (!relativeOnly && (name === zone || name.endsWith(`.${zone}`))) return name;
  if (name.includes('*') && name !== '*' && !name.startsWith('*.')) throw new Error('Wildcard must be the leftmost label');
  if (!name.split('.').every(part => /^(\*|[a-z0-9_-]{1,63})$/.test(part))) throw new Error('Invalid DNS host');
  const fqdn = `${name}.${zone}`;
  if (fqdn.length > 253) throw new Error('DNS name is too long');
  return fqdn;
}
export function validateDnsTtl(ttl: number): void {
  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) throw new Error('TTL must be Auto (1) or 60–86400 seconds');
}
export function buildDnsRecord(input: DnsRecordForm, zone: string, relativeOnly = false): DnsRecordInput {
  if (!(DNS_TYPES as readonly string[]).includes(input.type)) throw new Error('Unsupported DNS record type');
  if (!input.content?.trim()) throw new Error('DNS content is required');
  const proxied = PROXY_TYPES.includes(input.type) && input.proxied;
  validateDnsTtl(proxied ? 1 : input.ttl);
  for (const field of ['priority', 'weight', 'port'] as const) {
    const value = input[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 65535)) throw new Error(`Invalid ${field}`);
  }
  const base: DnsRecordInput = { type: input.type, name: dnsName(input.name, zone, relativeOnly), ttl: proxied ? 1 : input.ttl, proxied, ...(input.comment !== undefined ? { comment: input.comment } : {}) };
  if (input.type === 'SRV') return { ...base, data: { target: input.content, priority: input.priority ?? 0, weight: input.weight ?? 0, port: input.port ?? 0 } };
  if (input.type === 'CAA') {
    if (!['issue', 'issuewild', 'iodef'].includes(input.tag || 'issue') || !Number.isInteger(input.flags ?? 0) || (input.flags ?? 0) < 0 || (input.flags ?? 0) > 255) throw new Error('Invalid CAA tag/flags');
    return { ...base, data: { flags: input.flags ?? 0, tag: input.tag || 'issue', value: input.content } };
  }
  return { ...base, content: input.content, ...(input.type === 'MX' ? { priority: input.priority ?? 0 } : {}) };
}
