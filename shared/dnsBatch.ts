import { type CfRequest } from './accountDiscovery';
import { errorDetails, redact } from './cfErrors';
import { buildDnsRecord, dnsName, DNS_TYPES, PROXY_TYPES, validateDnsTtl, type DnsRecordForm, type DnsRecordInput } from './dnsRecord';

export type BatchAction = 'create' | 'update' | 'delete' | 'proxy' | 'ttl';
export interface BatchZone { credentialId: number; accountId: number; zoneId: string; zoneName: string }
export interface BatchSpec { zones: BatchZone[]; action: BatchAction; match: { host: string; types: string[]; currentContent?: string }; record?: DnsRecordForm; changes?: DnsRecordInput; conflictPolicy?: 'skip' | 'update' | 'create' }
export interface BatchRecord extends DnsRecordInput { id: string; type: string; name: string; content?: string; tags?: string[]; settings?: unknown; modified_on?: string }
export type BatchStatus = 'READY' | 'FOUND' | 'SKIP' | 'ERROR' | 'PENDING' | 'RUNNING' | 'SUCCESS' | 'SKIPPED' | 'CONFLICT' | 'NOT_FOUND' | 'FAILED';
export interface BatchItem { id: string; zone: BatchZone; action: BatchAction; name: string; type: string; status: BatchStatus; operation?: 'POST' | 'PATCH' | 'DELETE'; recordId?: string; before?: BatchRecord; after?: DnsRecordInput; existing?: string; message?: string; httpStatus?: number; cfCodes?: Array<number | string> }
export interface BatchPreview { id: string; expiresAt: number; spec: BatchSpec; items: BatchItem[]; token: string }
export interface BatchEvent { type: 'start' | 'item' | 'done' | 'error'; items?: BatchItem[]; item?: BatchItem; completed?: number; total?: number; message?: string }
export interface BatchRuntime {
  resolve(zone: BatchZone): Promise<{ request: CfRequest; cloudflareAccountId: string; credentialId: number }>;
  audit(item: BatchItem): Promise<void>;
}
export const BATCH_CONCURRENCY = 3;
export function batchError(message: string) { return Object.assign(new Error(message), { statusCode: 400, code: 'DNS_BATCH_INVALID' }); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function snapshot(r: BatchRecord): BatchRecord {
  return Object.fromEntries(['id', 'type', 'name', 'content', 'ttl', 'proxied', 'priority', 'data', 'comment', 'tags', 'settings', 'modified_on'].filter(k => r[k as keyof BatchRecord] !== undefined).map(k => [k, r[k as keyof BatchRecord]])) as unknown as BatchRecord;
}
function content(r: DnsRecordInput): string { return r.data ? stable(r.data) : r.content || ''; }
function recordContent(r: DnsRecordInput): string { return String(r.data?.target ?? r.data?.value ?? r.content ?? ''); }
export function summarizeBatch(items: BatchItem[]) {
  return Object.fromEntries(['READY', 'FOUND', 'SKIP', 'ERROR', 'PENDING', 'RUNNING', 'SUCCESS', 'SKIPPED', 'CONFLICT', 'NOT_FOUND', 'FAILED'].map(status => [status, items.filter(i => i.status === status).length])) as Record<BatchStatus, number>;
}
async function concurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await fn(items[index]!); }
  }));
  return result;
}
function failure(item: BatchItem, error: unknown, status: 'ERROR' | 'FAILED' = 'FAILED'): BatchItem {
  const details = errorDetails(error);
  return { ...item, status, message: details.message, httpStatus: details.statusCode, cfCodes: (error as { cfCodes?: Array<string | number> })?.cfCodes };
}
export function validateBatchSpec(input: BatchSpec): BatchSpec {
  try { return validateSpec(input); } catch(error) { throw batchError(redact(error)); }
}
function validateSpec(input: BatchSpec): BatchSpec {
  if (!input || !['create', 'update', 'delete', 'proxy', 'ttl'].includes(input.action) || !Array.isArray(input.zones) || !input.zones.length || input.zones.length > 500) throw batchError('Select 1–500 Zones and a DNS action');
  const zones = new Set<string>();
  for (const z of input.zones) {
    if (!Number.isSafeInteger(z.accountId) || z.accountId <= 0 || !Number.isSafeInteger(z.credentialId) || z.credentialId <= 0 || !/^[a-f\d]{32}$/i.test(z.zoneId) || !/^[a-z\d_.-]+$/i.test(z.zoneName)) throw batchError('Each Zone requires credentialId, local accountId, zoneId and zoneName');
    if (zones.has(z.zoneId)) throw batchError('The same Cloudflare Zone is selected through multiple bindings; select it once');
    zones.add(z.zoneId);
  }
  if (!input.match || typeof input.match.host !== 'string' || !input.match.host.trim() || !Array.isArray(input.match.types) || !input.match.types.length || input.match.types.some(t => !(DNS_TYPES as readonly string[]).includes(t))) throw batchError('Exact relative host and record type are required');
  if (input.match.currentContent !== undefined && typeof input.match.currentContent !== 'string') throw batchError('Current Content must be text');
  if (input.conflictPolicy && !['skip', 'update', 'create'].includes(input.conflictPolicy)) throw batchError('Invalid duplicate strategy');
  if (input.action === 'create') {
    if (!input.record || typeof input.record.type !== 'string' || typeof input.record.name !== 'string' || typeof input.record.content !== 'string' || typeof input.record.ttl !== 'number' || typeof input.record.proxied !== 'boolean' || (input.record.comment !== undefined && typeof input.record.comment !== 'string')) throw batchError('DNS Type, relative Host, Content, numeric TTL and boolean Proxy are required');
    for (const z of input.zones) buildDnsRecord(input.record, z.zoneName, true);
  } else if (input.action !== 'delete') {
    const changes = input.changes;
    if (!changes || !Object.keys(changes).length || Object.keys(changes).some(k => !['content', 'ttl', 'proxied', 'priority', 'data', 'comment'].includes(k))) throw batchError('Select explicit fields to patch');
    if (changes.data !== undefined) {
      if (!changes.data || typeof changes.data !== 'object' || Array.isArray(changes.data) || Object.keys(changes.data).some(k => !['target','priority','weight','port','flags','tag','value'].includes(k))) throw batchError('Invalid structured DNS fields');
      for(const key of ['priority','weight','port','flags']) {
        const value = changes.data[key];
        if(value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > (key === 'flags' ? 255 : 65535))) throw batchError(`Invalid ${key}`);
      }
      for(const key of ['target','tag','value']) if(changes.data[key] !== undefined && typeof changes.data[key] !== 'string') throw batchError(`Invalid ${key}`);
    }
    if (changes.ttl !== undefined) validateDnsTtl(changes.ttl);
    if (changes.proxied !== undefined && typeof changes.proxied !== 'boolean') throw batchError('Proxy must be boolean');
    if (changes.content !== undefined && (typeof changes.content !== 'string' || !changes.content.trim())) throw batchError('Content is required');
    if (changes.comment !== undefined && typeof changes.comment !== 'string') throw batchError('Comment must be text');
    if (changes.priority !== undefined && (!Number.isInteger(changes.priority) || changes.priority < 0 || changes.priority > 65535)) throw batchError('Invalid priority');
    if (input.action === 'proxy' && (Object.keys(changes).length !== 1 || typeof changes.proxied !== 'boolean')) throw batchError('Proxy action only patches proxied');
    if (input.action === 'ttl' && (Object.keys(changes).length !== 1 || changes.ttl === undefined)) throw batchError('TTL action only patches ttl');
  }
  for (const z of input.zones) dnsName(input.match.host, z.zoneName, true);
  return JSON.parse(JSON.stringify(input)) as BatchSpec;
}
async function resolve(runtime: BatchRuntime, zone: BatchZone): Promise<CfRequest> {
  const identity = await runtime.resolve(zone);
  if (identity.credentialId !== zone.credentialId) throw batchError('Credential binding changed; preview again');
  const data = await identity.request(`/zones/${zone.zoneId}`);
  const actual = data.result as { id?: string; name?: string; account?: { id?: string } };
  if (actual?.id !== zone.zoneId || actual?.name?.toLowerCase() !== zone.zoneName.toLowerCase() || actual?.account?.id !== identity.cloudflareAccountId) throw batchError('Zone ownership does not match the selected Account');
  return identity.request;
}
async function records(request: CfRequest, zone: BatchZone, name: string): Promise<BatchRecord[]> {
  const rows: BatchRecord[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = await request(`/zones/${zone.zoneId}/dns_records?name.exact=${encodeURIComponent(name)}&per_page=100&page=${page}`);
    if (!Array.isArray(data.result)) throw new Error('Unexpected DNS records response');
    rows.push(...(data.result as BatchRecord[]).filter(r => r.name.toLowerCase().replace(/\.$/, '') === name));
    if (data.result_info?.total_pages !== undefined ? page >= data.result_info.total_pages : data.result.length < 100) return rows;
  }
  throw new Error('DNS pagination limit exceeded');
}
function patchFor(record: BatchRecord, changes: DnsRecordInput): DnsRecordInput {
  if (changes.proxied !== undefined && !PROXY_TYPES.includes(record.type)) throw batchError(`${record.type} does not support Proxy`);
  if (changes.ttl !== undefined && changes.ttl !== 1 && (changes.proxied ?? record.proxied)) throw batchError('Proxied DNS uses Auto TTL; disable Proxy before changing TTL');
  if (changes.priority !== undefined && !['MX', 'SRV'].includes(record.type)) throw batchError('Priority is only supported by MX/SRV');
  const patch = { ...changes };
  if (['SRV', 'CAA'].includes(record.type)) {
    const allowed = record.type === 'SRV' ? ['target','priority','weight','port'] : ['flags','tag','value'];
    if(changes.data && Object.keys(changes.data).some(key => !allowed.includes(key))) throw batchError('Structured field does not apply to this record type');
    const data = { ...record.data, ...changes.data };
    if (changes.content !== undefined) data[record.type === 'SRV' ? 'target' : 'value'] = changes.content;
    if (record.type === 'SRV' && changes.priority !== undefined) data.priority = changes.priority;
    if (changes.data || changes.content !== undefined || changes.priority !== undefined) patch.data = data;
    delete patch.content; delete patch.priority;
  } else if (changes.data) throw batchError('Structured DNS fields require SRV/CAA');
  return patch;
}
async function previewZone(runtime: BatchRuntime, spec: BatchSpec, zone: BatchZone): Promise<BatchItem[]> {
  const name = dnsName(spec.action === 'create' ? spec.record!.name : spec.match.host, zone.zoneName, true);
  const base: BatchItem = { id: `${zone.accountId}:${zone.zoneId}:none`, zone, action: spec.action, name, type: spec.action === 'create' ? spec.record!.type : spec.match.types.join('/'), status: 'READY' };
  try {
    const request = await resolve(runtime, zone); const all = await records(request, zone, name);
    const existing = stable(all.map(snapshot).sort((a, b) => a.id.localeCompare(b.id)));
    if (spec.action === 'create') {
      const after = buildDnsRecord(spec.record!, zone.zoneName, true);
      const sameType = all.filter(r => r.type === after.type);
      if (sameType.some(r => content(r) === content(after))) return [{ ...base, status: 'SKIP', message: 'Already exists' }];
      if (all.some(r => r.type !== after.type && (r.type === 'CNAME' || after.type === 'CNAME' || r.type === 'NS' || after.type === 'NS'))) return [{ ...base, status: 'CONFLICT', message: 'CNAME/NS conflicts with another record type' }];
      if (sameType.length && (!spec.conflictPolicy || spec.conflictPolicy === 'skip')) return [{ ...base, status: 'CONFLICT', message: 'Same Type + Name has different Content; no overwrite' }];
      if (sameType.length && after.type === 'CNAME' && spec.conflictPolicy === 'create') return [{ ...base, status: 'CONFLICT', message: 'Only one CNAME is allowed at the same Name' }];
      if (sameType.length && spec.conflictPolicy === 'update') {
        if (sameType.length !== 1) return [{ ...base, status: 'CONFLICT', message: 'Multiple records match; use Update with Current Content' }];
        const r = sameType[0]!;
        const { type: _type, name: _name, ...changes } = after;
        return [{ ...base, id: `${zone.accountId}:${zone.zoneId}:${r.id}`, operation: 'PATCH', recordId: r.id, before: snapshot(r), after: patchFor(r, changes), status: 'FOUND' }];
      }
      return [{ ...base, operation: 'POST', after, existing }];
    }
    const matched = all.filter(r => spec.match.types.includes(r.type));
    if (!matched.length) return [{ ...base, status: 'NOT_FOUND', message: 'No matching DNS record' }];
    return matched.map(r => {
      const item: BatchItem = { ...base, id: `${zone.accountId}:${zone.zoneId}:${r.id}`, type: r.type, status: 'FOUND', recordId: r.id, before: snapshot(r), operation: spec.action === 'delete' ? 'DELETE' : 'PATCH' };
      if (spec.match.currentContent !== undefined && recordContent(r) !== spec.match.currentContent) return { ...item, status: 'CONFLICT', message: 'Current Content does not match' };
      try {
        if (spec.action === 'delete') return item;
        const after = patchFor(r, spec.changes!);
        if (Object.entries(after).every(([k, v]) => stable(r[k as keyof BatchRecord]) === stable(v))) return { ...item, status: 'SKIP', message: 'Already set' };
        return { ...item, after };
      } catch (error) { return { ...item, status: 'CONFLICT', message: redact(error) }; }
    });
  } catch (error) { return [failure(base, error, 'ERROR')]; }
}
const encoder = new TextEncoder();
async function signingKey(secret: string) { return crypto.subtle.importKey('raw', encoder.encode(`cf-manager/dns-batch/v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
function unsigned(preview: BatchPreview): string { const { token: _token, ...plan } = preview; return stable(plan); }
export async function previewBatch(input: BatchSpec, runtime: BatchRuntime, secret: string): Promise<BatchPreview> {
  const spec = validateBatchSpec(input);
  const items = (await concurrent(spec.zones, zone => previewZone(runtime, spec, zone))).flat();
  if (items.length > 5000) throw batchError('Preview exceeds 5000 records; narrow the match');
  const plan: BatchPreview = { id: crypto.randomUUID(), expiresAt: Date.now() + 15 * 60_000, spec, items, token: '' };
  const signed = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(unsigned(plan)));
  plan.token = Array.from(new Uint8Array(signed), v => v.toString(16).padStart(2, '0')).join('');
  return plan;
}
export async function verifyPreview(plan: BatchPreview, secret: string): Promise<void> {
  if (!plan || !Array.isArray(plan.items) || plan.items.length > 5000 || typeof plan.token !== 'string' || !/^[a-f\d]{64}$/.test(plan.token) || plan.expiresAt < Date.now()) throw batchError('Preview expired or invalid; preview again');
  const bytes = Uint8Array.from(plan.token.match(/../g)!, s => parseInt(s, 16));
  if (!await crypto.subtle.verify('HMAC', await signingKey(secret), bytes, encoder.encode(unsigned(plan)))) throw batchError('Preview was changed; preview again');
}
/** Only explicit, signed preview items can write. Re-read snapshots just before PATCH/DELETE. */
export async function executeBatch(plan: BatchPreview, runtime: BatchRuntime, emit: (event: BatchEvent) => Promise<void>): Promise<BatchItem[]> {
  let completed = 0;
  const items: BatchItem[] = plan.items.map(i => ({ ...i, status: ['READY', 'FOUND'].includes(i.status) ? 'PENDING' : i.status === 'SKIP' ? 'SKIPPED' : i.status === 'ERROR' ? 'FAILED' : i.status }));
  completed = items.filter(i => i.status !== 'PENDING').length;
  await emit({ type: 'start', items, total: items.length, completed });
  await concurrent(plan.spec.zones, async zone => {
    const pending = items.filter(i => i.zone.zoneId === zone.zoneId && i.status === 'PENDING');
    if (!pending.length) return;
    let request: CfRequest | undefined; let resolutionError: unknown;
    try { request = await resolve(runtime, zone); } catch (e) { resolutionError = e; }
    for (const item of pending) {
      Object.assign(item, { status: 'RUNNING' }); await emit({ type: 'item', item, completed, total: items.length });
      try {
        if (!request) throw resolutionError;
        const path = `/zones/${zone.zoneId}/dns_records`;
        if (item.operation === 'POST') {
          const now = await records(request, zone, item.name);
          const current = stable(now.map(snapshot).sort((a, b) => a.id.localeCompare(b.id)));
          if (current !== item.existing) {
            item.status = now.some(r => r.type === item.after?.type && content(r) === content(item.after!)) ? 'SKIPPED' : 'CONFLICT';
            item.message = 'DNS changed after preview; preview again';
          }
        } else {
          const current = (await request(`${path}/${item.recordId}`)).result as BatchRecord;
          if (stable(snapshot(current)) !== stable(item.before)) { item.status = 'CONFLICT'; item.message = 'Record changed after preview; no write'; }
        }
        if (item.status === 'RUNNING') {
          await request(item.operation === 'POST' ? path : `${path}/${item.recordId}`, { method: item.operation, ...(item.operation === 'DELETE' ? {} : { body: JSON.stringify(item.after) }) });
          item.status = 'SUCCESS'; item.message = undefined;
        }
      } catch (error) {
        Object.assign(item, failure(item, error));
        if (item.httpStatus === 404) item.status = 'NOT_FOUND';
      }
      // Audit contains only identity/action/status, never DNS Content (including TXT).
      try { await runtime.audit(item); } catch { item.message = `${item.message || ''} Audit persistence failed`.trim(); }
      completed++; await emit({ type: 'item', item, completed, total: items.length });
    }
  });
  await emit({ type: 'done', items, completed, total: items.length });
  return items;
}
