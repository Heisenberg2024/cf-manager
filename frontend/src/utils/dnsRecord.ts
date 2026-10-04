export interface DnsRecordForm { type: string; name: string; content: string; ttl: number; proxied: boolean; priority?: number; weight?: number; port?: number }
export function buildDnsRecord(input: DnsRecordForm, zone: string) {
  const proxied = ['A', 'AAAA', 'CNAME'].includes(input.type) && input.proxied;
  const relative = input.name.trim().replace(/\.$/, '');
  const name = relative === '@' || !relative ? zone : relative.toLowerCase() === zone.toLowerCase() || relative.toLowerCase().endsWith(`.${zone.toLowerCase()}`) ? relative : `${relative}.${zone}`;
  const base = { type: input.type, name, ttl: proxied ? 1 : input.ttl, proxied };
  if (input.type === 'SRV') return { ...base, data: { target: input.content, priority: input.priority ?? 0, weight: input.weight ?? 0, port: input.port ?? 0 } };
  return { ...base, content: input.content, ...(input.type === 'MX' ? { priority: input.priority ?? 0 } : {}) };
}
