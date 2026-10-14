import type { InventorySink } from './snapshotIdentity';
import { bindingSignature, type DnsBinding } from './zoneDirectory';
import type { ReadMetric, ReadScheduler } from './readScheduler';
import { errorDetails } from './cfErrors';

export interface CacheState { state: 'fresh' | 'miss' | 'stale'; fetchedAt: number; startedAt?:number; error?: string }
type Entry = { accountId: number; cfAccountId: string; scope: string; value: unknown; fetchedAt: number; startedAt:number; bytes: number; error?: string; failedAt?:number };
/** Bounded display snapshots. Ownership and write preconditions are checked outside this cache. */
export class BoundReadCache {
  private entries = new Map<string, Entry>();
  private revision = 0;
  private serial=0;
  private readonly instance=crypto.randomUUID();
  constructor(private directory: { scheduler: Pick<ReadScheduler, 'run'>; inventory?:InventorySink }, private metric: (event: ReadMetric) => void = () => {}, private freshMs = 30000, private staleMs = 180000, private capacity = 500, private maxBytes = 8 * 1024 * 1024) {}
  get size() { return this.entries.size; }
  get bytes() { return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0); }
  uncached<T>(account:DnsBinding,load:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    return this.directory.scheduler.run(`uncached:${this.instance}:${++this.serial}`,account.id,load,{signal});
  }
  invalidate(accountId?: number, cfAccountId?: string | null, scope?: string) {
    // Fence pending fills without evicting unrelated completed snapshots.
    this.revision++;
    for (const [key, entry] of this.entries) if ((accountId === undefined || entry.accountId === accountId || (!!cfAccountId && entry.cfAccountId === cfAccountId)) && (!scope || entry.scope === scope || entry.scope.startsWith(`${scope}/`))) this.entries.delete(key);
  }
  async peek<T>(account: DnsBinding, scope: string) {
    const entry = this.entries.get(`${await bindingSignature(account)}:${scope}`);
    return entry ? { value: structuredClone(entry.value) as T, fetchedAt: entry.fetchedAt, error: entry.error, failedAt:entry.failedAt } : undefined;
  }
  async read<T>(account: DnsBinding, scope: string, load: (signal: AbortSignal) => Promise<T>, options: { refresh?: boolean; background?:boolean; signal?: AbortSignal; waitUntil?: (promise: Promise<unknown>) => void; inventory?:boolean } = {}): Promise<{ value: T; cache: CacheState }> {
    options.signal?.throwIfAborted();
    const revision = this.revision, key = `${await bindingSignature(account)}:${scope}`;
    options.signal?.throwIfAborted();
    const cached = this.entries.get(key);
    this.metric({event:'snapshot_lookup',accountId:account.id});
    const perform = async (background: boolean) => {
      const started = Date.now();
      let bucketFirst:boolean|undefined;
      if(scope.startsWith('buckets:/')){try{const parts=JSON.parse(scope.slice('buckets:/'.length));if(Array.isArray(parts)&&parts[0]==='')bucketFirst=parts[2]==='';}catch{/* only known unfiltered directory keys can provide an inventory */}}
      const inventoryMetric=scope==='tunnel/list'?'tunnels':scope==='d1:list'?'d1':bucketFirst!==undefined?'r2':null;
      try {
        const value = await this.directory.scheduler.run(`snapshot:${revision}:${key}`,account.id,load,{background,signal:background ? undefined : options.signal});
        const entry: Entry = {accountId:account.id,cfAccountId:account.account_id!,scope,value,fetchedAt:Date.now(),startedAt:started,bytes:JSON.stringify(value).length*2};
        const page=value as {items?:unknown[];is_truncated?:boolean};
        const inventoryRows=inventoryMetric==='r2'?bucketFirst&&Array.isArray(page?.items)&&page.is_truncated===false?page.items:null:Array.isArray(value)?value:null;
        if(revision===this.revision&&inventoryMetric&&options.inventory!==false&&inventoryRows)await this.directory.inventory?.(account,inventoryMetric,inventoryRows,started,entry.fetchedAt);
        if (revision === this.revision) this.put(key,entry);
        this.metric({event:'snapshot_loaded',accountId:account.id,durationMs:Date.now()-started});
        return {value: structuredClone(value),cache:{state:'miss' as const,fetchedAt:entry.fetchedAt,startedAt:started}};
      } catch (error) {
        if(revision===this.revision&&inventoryMetric&&options.inventory!==false&&!options.signal?.aborted)await this.directory.inventory?.(account,inventoryMetric,null,started,Date.now(),error);
        if (revision === this.revision && cached && !options.signal?.aborted) {cached.error = errorDetails(error).message;cached.failedAt=Date.now();}
        this.metric({event:'snapshot_failed',accountId:account.id,status:errorDetails(error).statusCode,durationMs:Date.now()-started}); throw error;
      }
    };
    if (!options.refresh && cached && Date.now()-cached.fetchedAt < this.staleMs) {
      this.entries.delete(key); this.entries.set(key,cached);
      const stale = Date.now()-cached.fetchedAt >= this.freshMs || !!cached.error;
      if (stale) { const pending = perform(true).catch(()=>{}); options.waitUntil?.(pending); }
      this.metric({event:stale ? 'snapshot_stale' : 'snapshot_hit',accountId:account.id});
      return {value:structuredClone(cached.value) as T,cache:{state:stale ? 'stale' : 'fresh',fetchedAt:cached.fetchedAt,startedAt:cached.startedAt,...(cached.error ? {error:cached.error} : {})}};
    }
    return perform(options.background??false);
  }
  private put(key: string, entry: Entry) {
    this.entries.delete(key);
    if(entry.bytes > this.maxBytes) return;
    this.entries.set(key,entry);
    while(this.entries.size > this.capacity || this.bytes > this.maxBytes) this.entries.delete(this.entries.keys().next().value!);
  }
}
