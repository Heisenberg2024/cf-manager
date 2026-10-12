import type { CfEnvelope, CfRequest } from './accountDiscovery';
import { errorDetails } from './cfErrors';
import { ReadScheduler, type ReadMetric } from './readScheduler';

export interface DnsBinding { id: number; name: string; account_id: string | null; credential_id?: number; is_enabled?: number; is_active: number; enabled_features: string; updated_at?: string; auth_type?: string; api_token?: string | null; api_key?: string | null; email?: string | null; proxy_url?: string; proxy_enabled?: number }
export interface DnsZone { id: string; name: string; status: string; paused?: boolean; account: { id: string; name?: string }; plan?: unknown; name_servers?: string[]; cfAccountId: number; credentialId?: number; accountName: string }
export interface ZoneSnapshot { zones: DnsZone[]; meta: { accountId: number; state: 'fresh' | 'miss' | 'stale' | 'error'; fetchedAt?: number; error?: string; durationMs?: number } }
export function parseZoneContext(query: { accountId?: unknown; zoneId?: unknown }): { accountId?: number; zoneId?: string } {
  const context: { accountId?: number; zoneId?: string } = {};
  if (query.accountId !== undefined) {
    if (!['string', 'number'].includes(typeof query.accountId) || !Number.isSafeInteger(Number(query.accountId)) || Number(query.accountId) <= 0) throw Object.assign(new Error('Invalid local Account ID'), { statusCode: 400, code: 'VALIDATION_ERROR' });
    context.accountId = Number(query.accountId);
  }
  if (query.zoneId !== undefined) {
    if (typeof query.zoneId !== 'string' || !query.zoneId.trim() || query.zoneId.length > 128) throw Object.assign(new Error('Invalid Zone ID'), { statusCode: 400, code: 'VALIDATION_ERROR' });
    context.zoneId = query.zoneId.trim();
  }
  return context;
}
export function recordPageQuery(query: { page?: unknown; perPage?: unknown; type?: unknown; search?: unknown }): string | undefined {
  if (query.page === undefined) return;
  const page = Number(query.page), perPage = Number(query.perPage ?? 100);
  if (!Number.isInteger(page) || page < 1 || page > 1000 || !Number.isInteger(perPage) || perPage < 1 || perPage > 500 || (query.type !== undefined && (typeof query.type !== 'string' || !/^[A-Z0-9]+$/.test(query.type))) || (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 256))) throw Object.assign(new Error('Invalid DNS page/filter parameters'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return new URLSearchParams({ page: String(page), per_page: String(perPage), ...(query.type ? { type: String(query.type) } : {}), ...(query.search ? { search: String(query.search) } : {}) }).toString();
}
type Entry = { signature: string; cloudflareAccountId: string; snapshot?: ZoneSnapshot; flight?: Promise<ZoneSnapshot>; failed?: string };
export function requireDnsBinding<T extends DnsBinding>(account: T | undefined | null): T {
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
  if (account.is_enabled === 0 || account.is_active === 0 || !account.account_id || !(account.enabled_features ?? 'dns').split(',').includes('dns')) throw Object.assign(new Error('Account unavailable or DNS feature disabled'), { statusCode: 409, code: 'ACCOUNT_DISABLED' });
  return account;
}
export async function bindingSignature(account: DnsBinding): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([account.account_id, account.credential_id, account.updated_at, account.auth_type, account.api_token, account.api_key, account.email, account.proxy_enabled, account.proxy_url]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `${account.id}:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export class ZoneDirectory {
  private entries = new Map<number, Entry>();
  private revision = 0;
  private revisions = new Map<number, number>();
  readonly scheduler: ReadScheduler;
  constructor(private metric: (value: ReadMetric) => void = () => {}, private freshMs = 30000, private staleMs = 300000, private capacity = 500) { this.scheduler = new ReadScheduler(metric); }
  private epoch(accountId: number) { return `${this.revision}:${this.revisions.get(accountId) || 0}`; }
  invalidate(accountId?: number, cloudflareAccountId?: string | null) {
    if (accountId === undefined) { this.entries.clear(); this.revision++; this.revisions.clear(); return; }
    this.revisions.set(accountId, (this.revisions.get(accountId) || 0) + 1);
    this.entries.delete(accountId);
    if (cloudflareAccountId) for (const [id, entry] of this.entries) if (entry.cloudflareAccountId === cloudflareAccountId) { this.revisions.set(id, (this.revisions.get(id) || 0) + 1); this.entries.delete(id); }
  }
  async request(account: DnsBinding, request: CfRequest, path: string, options: { background?: boolean; signal?: AbortSignal; revision?: string } = {}): Promise<CfEnvelope> {
    const revision = options.revision ?? this.epoch(account.id);
    const signature = await bindingSignature(account);
    return this.scheduler.run(`${revision}:${signature}:${path}`, account.id, signal => request(path, { signal }), options);
  }
  async list(account: DnsBinding, request: CfRequest, options: { refresh?: boolean; waitUntil?: (promise: Promise<unknown>) => void } = {}): Promise<ZoneSnapshot> {
    requireDnsBinding(account);
    this.metric({ event: 'zone_lookup', accountId: account.id });
    const revision = this.epoch(account.id);
    const signature = await bindingSignature(account);
    let entry = revision === this.epoch(account.id) ? this.entries.get(account.id) : undefined;
    if (entry?.signature !== signature) entry = { signature, cloudflareAccountId: account.account_id! };
    if (revision === this.epoch(account.id)) { this.entries.delete(account.id); this.entries.set(account.id, entry); }
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const current = entry;
    const age = Date.now() - (entry.snapshot?.meta.fetchedAt || 0);
    const load = (background: boolean) => {
      if (current.flight) { this.metric({ event: 'zone_merged', accountId: account.id }); return current.flight; }
      const started = Date.now();
      const pending = (async () => {
        const raw = await this.all(account, request, `/zones?account.id=${encodeURIComponent(account.account_id!)}`, 50, { background, revision });
        const zones = (raw as DnsZone[]).filter(z => z.account?.id === account.account_id).map(z => ({ id: z.id, name: z.name, status: z.paused ? 'paused' : z.status, paused: z.paused, account: z.account, plan: z.plan, name_servers: z.name_servers, cfAccountId: account.id, credentialId: account.credential_id, accountName: account.name }));
        const snapshot: ZoneSnapshot = { zones, meta: { accountId: account.id, state: 'miss', fetchedAt: Date.now(), durationMs: Date.now() - started } };
        if (this.entries.get(account.id) === current) { current.snapshot = snapshot; current.failed = undefined; }
        this.metric({ event: 'zone_loaded', accountId: account.id, durationMs: Date.now() - started });
        return snapshot;
      })().catch(error => { current.failed = errorDetails(error).kind; this.metric({ event: 'zone_failed', accountId: account.id, durationMs: Date.now() - started }); throw error; }).finally(() => { if (current.flight === pending) current.flight = undefined; });
      current.flight = pending; return pending;
    };
    if (!options.refresh && entry.snapshot && age < this.freshMs && !entry.failed) { this.metric({ event: 'zone_hit', accountId: account.id }); return { zones: entry.snapshot.zones, meta: { ...entry.snapshot.meta, state: 'fresh' } }; }
    if (!options.refresh && entry.snapshot && age < this.staleMs) {
      const pending = load(true).catch(() => {}); options.waitUntil?.(pending);
      this.metric({ event: 'zone_stale', accountId: account.id });
      return { zones: entry.snapshot.zones, meta: { ...entry.snapshot.meta, state: 'stale', error: entry.failed } };
    }
    return load(false);
  }
  async resolve<T extends DnsBinding>(account: T, request: CfRequest, domain: string, zoneId: string) {
    requireDnsBinding(account);
    // Live ownership validation is never satisfied by list/KV cache (including writes).
    const data = await this.request(account, request, `/zones/${encodeURIComponent(zoneId)}`);
    const zone = data.result as DnsZone | undefined;
    if (zone?.id !== zoneId || zone.name.toLowerCase() !== domain.toLowerCase() || zone.account?.id !== account.account_id) throw Object.assign(new Error('Zone does not belong to this Account/domain'), { statusCode: 409, code: 'ZONE_OWNERSHIP_MISMATCH' });
    return { account, zoneId };
  }
  wrap(account: DnsBinding, request: CfRequest): CfRequest {
    return (path, init = {}) => !init.method || init.method.toUpperCase() === 'GET'
      ? this.request(account, (target, options) => request(target, { ...init, ...options }), path, { signal: init.signal ?? undefined })
      : request(path, init);
  }
  async page(account: DnsBinding, request: CfRequest, path: string, signal?: AbortSignal) {
    const data = await this.request(account, request, path, { signal });
    if (!Array.isArray(data.result)) throw Object.assign(new Error('Unexpected Cloudflare record page'), { statusCode: 502 });
    return { records: data.result, meta: { ...data.result_info, scope: 'page' as const } };
  }
  async all(account: DnsBinding, request: CfRequest, path: string, perPage: number, options: { background?: boolean; signal?: AbortSignal; revision?: string } = {}): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 1000; page++) {
      const data = await this.request(account, request, `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=${perPage}`, options);
      if (!Array.isArray(data.result)) throw new Error('Unexpected Cloudflare list response');
      rows.push(...data.result);
      const info = data.result_info;
      if (!data.result.length || (info?.total_pages !== undefined && page >= info.total_pages) || (info?.total_count !== undefined && rows.length >= info.total_count) || (!info?.total_pages && info?.total_count === undefined && data.result.length < (info?.per_page || perPage))) return rows;
    }
    throw new Error('Cloudflare pagination exceeded its limit');
  }
}
