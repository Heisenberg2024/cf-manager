import type { CfRequest } from './accountDiscovery';
import { bindingSignature, type DnsBinding } from './zoneDirectory';
import type { ReadMetric, ReadScheduler } from './readScheduler';
import { errorDetails } from './cfErrors';

export type ResourceKind = 'workers' | 'pages' | 'usage';
export interface ResourceUsage { requests: number; errors: number; subrequests: number; cpuTimeMs: number }
type Entry = { accountId: number; cfAccountId: string; value?: unknown; error?: unknown; expires: number; bytes?: number };
export function requireWorkerBinding<T extends DnsBinding>(account: T | null | undefined): T {
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  if (!account.account_id || account.is_enabled === 0 || account.is_active === 0 || !account.enabled_features.split(',').includes('workers')) throw Object.assign(new Error('Account unavailable or Workers feature disabled'), { statusCode: 409 });
  return account;
}

export function unavailableWorkerSummary(account: DnsBinding, error: unknown) {
  const state = errorDetails(error).kind;
  return { accountId: account.id, accountName: account.name, workerCount: null, pagesCount: null, requests: null, errors: null, subrequests: null, cpuTimeMs: null, states: { workers: state, pages: state, usage: state } };
}
/** Shares the first-stage scheduler, identity fingerprint and metrics. Memory only. */
export class WorkerResources {
  private entries = new Map<string, Entry>();
  private generations = new Map<number, number>();
  private globalGeneration = 0;
  constructor(private directory: { scheduler: Pick<ReadScheduler, 'run'> }, private metric: (metric: ReadMetric) => void = () => {}, private listMs = 30000, private usageMs = 120000, private maxBytes = 8 * 1024 * 1024) {}
  invalidate(accountId?: number, cfAccountId?: string | null) {
    if (accountId === undefined) { this.globalGeneration++; this.entries.clear(); this.generations.clear(); return; }
    const ids = new Set([accountId]);
    for (const entry of this.entries.values()) if (cfAccountId && entry.cfAccountId === cfAccountId) ids.add(entry.accountId);
    for (const id of ids) this.generations.set(id, (this.generations.get(id) || 0) + 1);
    for (const [key, entry] of this.entries) if (ids.has(entry.accountId) && !key.includes(':usage:')) this.entries.delete(key);
    // Usage is independent of resource mutations; its UTC date and credential fingerprint fence it.
  }
  async read<T>(account: DnsBinding, request: CfRequest, kind: ResourceKind, options: { refresh?: boolean; signal?: AbortSignal; background?: boolean } = {}): Promise<T> {
    requireWorkerBinding(account);
    options.signal?.throwIfAborted();
    const generation = `${this.globalGeneration}:${kind === 'usage' ? 0 : this.generations.get(account.id) || 0}`;
    const signature = await bindingSignature(account);
    const date = kind === 'usage' ? new Date().toISOString().slice(0, 10) : '';
    const key = `${signature}:${kind}:${date}`;
    this.metric({ event: 'resource_lookup', accountId: account.id });
    const cached = this.entries.get(key);
    if (cached && Date.now() < cached.expires && (!options.refresh || cached.error)) {
      this.entries.delete(key); this.entries.set(key, cached);
      if (cached.error) throw cached.error;
      this.metric({ event: 'resource_hit', accountId: account.id }); return cached.value as T;
    }
    const started = Date.now();
    try {
      const value = await this.directory.scheduler.run<unknown>(`workers:${generation}:${key}`, account.id, signal => kind === 'usage' ? readUsage(account, request, signal) : readList(account, request, kind, signal), options);
      if (generation === `${this.globalGeneration}:${kind === 'usage' ? 0 : this.generations.get(account.id) || 0}`) this.put(key, { accountId: account.id, cfAccountId: account.account_id!, value, expires: Date.now() + (kind === 'usage' ? this.usageMs : this.listMs) });
      this.metric({ event: 'resource_loaded', accountId: account.id, durationMs: Date.now() - started }); return value as T;
    } catch (error) {
      const detail = errorDetails(error);
      // Short negative caching dampens cold-cache storms. No false successful empty array.
      if (generation === `${this.globalGeneration}:${kind === 'usage' ? 0 : this.generations.get(account.id) || 0}` && !options.signal?.aborted) this.put(key, { accountId: account.id, cfAccountId: account.account_id!, error, expires: Date.now() + (detail.statusCode === 429 ? 300000 : 5000) });
      this.metric({ event: 'resource_failed', accountId: account.id, durationMs: Date.now() - started, status: detail.statusCode }); throw error;
    }
  }
  private put(key: string, entry: Entry) {
    if (this.entries.get(key)?.value === entry.value && !entry.error && entry.value !== undefined) return;
    entry.bytes = entry.error ? (entry.error instanceof Error ? entry.error.message.length * 2 + 512 : 512) : JSON.stringify(entry.value).length * 2;
    this.entries.delete(key);
    if (entry.bytes > this.maxBytes) return;
    this.entries.set(key, entry);
    let bytes = [...this.entries.values()].reduce((sum, value) => sum + (value.bytes || 0), 0);
    while (this.entries.size > 1500 || bytes > this.maxBytes) { const oldest = this.entries.keys().next().value!; bytes -= this.entries.get(oldest)?.bytes || 0; this.entries.delete(oldest); }
  }
  async summary(account: DnsBinding, request: CfRequest, options: { refresh?: boolean; usage?: boolean; signal?: AbortSignal; background?: boolean } = {}) {
    const [workers, pages, usage] = await Promise.allSettled([
      this.read<unknown[]>(account, request, 'workers', options), this.read<unknown[]>(account, request, 'pages', options),
      options.usage === false ? Promise.resolve(null) : this.read<ResourceUsage>(account, request, 'usage', options),
    ]);
    const state = (result: PromiseSettledResult<unknown>) => result.status === 'fulfilled' ? 'ready' : errorDetails(result.reason).kind;
    return { accountId: account.id, accountName: account.name, workerCount: workers.status === 'fulfilled' ? workers.value.length : null, pagesCount: pages.status === 'fulfilled' ? pages.value.length : null,
      ...(usage.status === 'fulfilled' && usage.value ? usage.value : { requests: null, errors: null, subrequests: null, cpuTimeMs: null }),
      states: { workers: state(workers), pages: state(pages), usage: options.usage === false ? 'pending' : state(usage) } };
  }
  async list(account: DnsBinding, request: CfRequest, options: { refresh?: boolean; signal?: AbortSignal } = {}) {
    const [workers, pages] = await Promise.allSettled([this.read<any[]>(account, request, 'workers', options), this.read<any[]>(account, request, 'pages', options)]);
    const decorate = (rows: any[], type: string) => rows.map(row => ({ ...row, name: type === 'worker' ? row.id : row.name ?? row.id, ...(type === 'worker' ? { status: 'deployed' } : {}), type, cfAccountId: account.id, accountName: account.name }));
    return { items: [...(workers.status === 'fulfilled' ? decorate(workers.value, 'worker') : []), ...(pages.status === 'fulfilled' ? decorate(pages.value, 'pages') : [])],
      states: { workers: workers.status === 'fulfilled' ? 'ready' : errorDetails(workers.reason).kind, pages: pages.status === 'fulfilled' ? 'ready' : errorDetails(pages.reason).kind } };
  }
}
async function readList(account: DnsBinding, request: CfRequest, kind: 'workers' | 'pages', signal: AbortSignal) {
  const path = `/accounts/${account.account_id}/${kind === 'workers' ? 'workers/scripts' : 'pages/projects'}`;
  // /workers/scripts is a SinglePage endpoint; page/per_page are not supported.
  if (kind === 'workers') { const data = await request(path, { signal }); if (!Array.isArray(data.result)) throw Object.assign(new Error('Unexpected Worker list'), { statusCode: 502 }); return data.result; }
  const rows: unknown[] = [];
  for (let page = 1; page <= 1000; page++) {
    const data = await request(`${path}?page=${page}&per_page=100`, { signal });
    if (!Array.isArray(data.result)) throw Object.assign(new Error('Unexpected resource list'), { statusCode: 502 });
    rows.push(...data.result);
    const info = data.result_info;
    if (!data.result.length || (info?.total_pages !== undefined && page >= info.total_pages) || (info?.total_count !== undefined && rows.length >= info.total_count) || (info?.total_pages === undefined && info?.total_count === undefined && data.result.length < (info?.per_page || 100))) return rows;
  }
  throw Object.assign(new Error('Resource pagination limit exceeded'), { statusCode: 502 });
}
async function readUsage(account: DnsBinding, request: CfRequest, signal: AbortSignal): Promise<ResourceUsage> {
  const now = new Date(), todayDate = now.toISOString().slice(0, 10);
  const query = 'query($accountTag:string!,$datetimeStart:Time!,$datetimeEnd:Time!,$todayDate:Date!){viewer{accounts(filter:{accountTag:$accountTag}){workers:workersInvocationsAdaptive(filter:{datetime_geq:$datetimeStart,datetime_leq:$datetimeEnd},limit:10000){sum{requests,errors,subrequests,cpuTimeUs}}pages:pagesFunctionsInvocationsAdaptiveGroups(filter:{date:$todayDate},limit:1){sum{requests,errors}}}}}';
  const json = await request('/graphql', { method: 'POST', signal, body: JSON.stringify({ query, variables: { accountTag: account.account_id, datetimeStart: `${todayDate}T00:00:00.000Z`, datetimeEnd: now.toISOString(), todayDate } }) }) as { errors?: unknown[]; data?: { viewer?: { accounts?: Array<{ workers?: Array<{ sum?: any }>; pages?: Array<{ sum?: any }> }> } } };
  const accountData = json.data?.viewer?.accounts?.[0];
  if (json.errors?.length || !accountData || !Array.isArray(accountData.workers) || !Array.isArray(accountData.pages)) throw Object.assign(new Error('Workers usage unavailable'), { statusCode: 502 });
  const usage = { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 }; let cpuUs = 0;
  for (const row of accountData.workers) { usage.requests += row.sum?.requests || 0; usage.errors += row.sum?.errors || 0; usage.subrequests += row.sum?.subrequests || 0; cpuUs += row.sum?.cpuTimeUs || 0; }
  for (const row of accountData.pages) { usage.requests += row.sum?.requests || 0; usage.errors += row.sum?.errors || 0; }
  usage.cpuTimeMs = Math.round(cpuUs / 1000); return usage;
}
