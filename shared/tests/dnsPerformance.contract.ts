import type { TestHarness } from './dnsBatch.contract';
import type { ZoneDirectory, recordPageQuery } from '../zoneDirectory';
import type { ReadScheduler } from '../readScheduler';
import { createCfRequest } from '../accountDiscovery';
type Implementation = {
  // Synced implementations have independent private fields; test their public contract structurally.
  ZoneDirectory: new (...args: ConstructorParameters<typeof ZoneDirectory>) => Pick<ZoneDirectory, 'invalidate' | 'list' | 'resolve' | 'all' | 'page'>;
  ReadScheduler: new (...args: ConstructorParameters<typeof ReadScheduler>) => Pick<ReadScheduler, 'run'>;
  recordPageQuery: typeof recordPageQuery;
};
const account = { id: 1, name: 'A', account_id: 'cf-a', credential_id: 10, is_enabled: 1, is_active: 1, enabled_features: 'dns', api_token: 'synthetic-cipher', updated_at: 'v1' };
const zone = { id: 'zone-a', name: 'same.test', status: 'active', account: { id: 'cf-a' }, plan: { name: 'Free' } };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function dnsPerformanceContract(label: string, implementation: Implementation, harness: TestHarness) {
  const { describe, it, expect, vi } = harness;
  const { ZoneDirectory, ReadScheduler, recordPageQuery } = implementation;
  describe(`${label} DNS cache and read scheduling`, () => {
    it('singleflights cold reads and caches successful empty accounts', async () => {
      const directory = new ZoneDirectory();
      let calls = 0;
      const request = async () => { calls++; await new Promise(r => setTimeout(r, 1)); return { result: [], result_info: { total_pages: 1 } }; };
      await Promise.all(Array.from({ length: 10 }, () => directory.list(account, request)));
      expect(calls).toBe(1); expect((await directory.list(account, request)).meta.state).toBe('fresh'); expect(calls).toBe(1);
    });
    it('SWR returns the successful snapshot immediately and reports background failures', async () => {
      const directory = new ZoneDirectory(undefined, -1, 300000);
      await directory.list(account, async () => ({ result: [zone] }));
      const failure = deferred<{ result: unknown[] }>(); const started = deferred<void>(); const backgrounds: Promise<unknown>[] = [];
      const stale = await directory.list(account, () => { started.resolve(); return failure.promise; }, { waitUntil: p => backgrounds.push(p) });
      expect(stale.meta.state).toBe('stale'); expect(stale.zones).toHaveLength(1);
      await started.promise; failure.reject(Object.assign(new Error('do not log TXT secret'), { status: 403 })); await Promise.all(backgrounds);
      const next = await directory.list(account, async () => { throw new Error('offline'); });
      expect(next.meta.state).toBe('stale'); expect(next.meta.error).toBe('permission');
    });
    it('never caches failed cold/force refresh reads as successful emptiness', async () => {
      const directory = new ZoneDirectory();
      await expect(directory.list(account, async () => { throw new Error('offline'); })).rejects.toThrow();
      expect((await directory.list(account, async () => ({ result: [zone] }))).zones).toHaveLength(1);
      await expect(directory.list(account, async () => { throw new Error('offline'); }, { refresh: true })).rejects.toThrow();
    });
    it('isolates local Account/Credential identities and observes credential changes', async () => {
      const directory = new ZoneDirectory(); let calls = 0;
      const request = async () => { calls++; return { result: [zone] }; };
      await directory.list(account, request);
      await directory.list({ ...account, id: 2, credential_id: 20 }, request);
      await directory.list({ ...account, api_token: 'changed-synthetic-cipher' }, request);
      expect(calls).toBe(3);
    });
    it('invalidation fences in-flight cache fills without clearing unrelated accounts', async () => {
      const directory = new ZoneDirectory(); const old = deferred<{ result: unknown[] }>(); const started = deferred<void>();
      await directory.list({ ...account, id: 2 }, async () => ({ result: [zone] }));
      const pending = directory.list(account, () => { started.resolve(); return old.promise; });
      await started.promise; directory.invalidate(1);
      await directory.list(account, async () => ({ result: [{ ...zone, name: 'new.test' }] }));
      old.resolve({ result: [zone] }); await pending;
      expect((await directory.list(account, async () => ({ result: [] }))).zones[0].name).toBe('new.test');
      expect((await directory.list({ ...account, id: 2 }, async () => ({ result: [] }))).zones).toHaveLength(1);
    });
    it('validates actual Zone ownership live even after a list cache hit', async () => {
      const directory = new ZoneDirectory(); await directory.list(account, async () => ({ result: [zone] }));
      await expect(directory.resolve(account, async () => ({ result: { ...zone, account: { id: 'cf-other' } } }), 'same.test', zone.id)).rejects.toThrow('Zone does not belong');
      await expect(directory.resolve({ ...account, is_enabled: 0 }, async () => ({ result: zone }), 'same.test', zone.id)).rejects.toThrow('unavailable');
      await expect(directory.resolve({ ...account, enabled_features: 'ai' }, async () => ({ result: zone }), 'same.test', zone.id)).rejects.toThrow('unavailable');
    });
    it('invalidates other Credential aliases of a changed Cloudflare Account', async () => {
      const directory = new ZoneDirectory(); const request = async () => ({ result: [zone] });
      await directory.list(account, request); await directory.list({ ...account, id: 2, credential_id: 20 }, request);
      directory.invalidate(1, account.account_id);
      expect((await directory.list({ ...account, id: 2, credential_id: 20 }, request)).meta.state).toBe('miss');
    });
    it('enumerates 10000 records in 20 bounded pages and explicitly distinguishes a page', async () => {
      const directory = new ZoneDirectory(); let calls = 0;
      const rows = await directory.all(account, async path => { calls++; const url = new URL(path, 'https://synthetic.invalid'); const page = Number(url.searchParams.get('page')), perPage = Number(url.searchParams.get('per_page')); expect(perPage).toBe(500); return { result: Array.from({ length: 500 }, (_, i) => ({ id: `${page}-${i}` })), result_info: { total_count: 10000 } }; }, '/zones/zone-a/dns_records', 500);
      expect(rows).toHaveLength(10000); expect(calls).toBe(20);
      expect(recordPageQuery({ page: '2', perPage: '50', type: 'TXT', search: 'a&b' })).toBe('page=2&per_page=50&type=TXT&search=a%26b');
      expect(() => recordPageQuery({ page: 'NaN' })).toThrow('Invalid');
      await expect(directory.page(account, async () => ({ result: {} }), '/zones/zone-a/dns_records?page=1')).rejects.toThrow('Unexpected');
    });
    it('bounds concurrency per account and lets foreground reads pass queued preloads', async () => {
      const scheduler = new ReadScheduler(undefined, 3, 1); const order: string[] = []; let active = 0, maximum = 0;
      const task = (name: string) => async () => { order.push(name); active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return name; };
      const one = scheduler.run('1', 1, task('first'), { background: true });
      const two = scheduler.run('2', 1, task('preload'), { background: true });
      const foreground = scheduler.run('3', 1, task('foreground'));
      const other = scheduler.run('4', 2, task('other'));
      await Promise.all([one, two, foreground, other]); expect(order).toEqual(['first', 'other', 'foreground', 'preload']); expect(maximum).toBeLessThanOrEqual(3);
    });
    it('deduplicates GETs without letting one consumer cancel another', async () => {
      const scheduler = new ReadScheduler(); const pending = deferred<number>(); let calls = 0;
      const controller = new AbortController();
      const a = scheduler.run('same', 1, async () => { calls++; return pending.promise; }, { signal: controller.signal });
      const b = scheduler.run('same', 1, async () => 0);
      const rejected = expect(a).rejects.toThrow(); controller.abort(); pending.resolve(7);
      await rejected; expect(await b).toBe(7); expect(calls).toBe(1);
    });
    it('cancels queued reads and enforces a deadline', async () => {
      const scheduler = new ReadScheduler(undefined, 1, 1, 10); const controller = new AbortController();
      const first = scheduler.run('blocked', 1, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
      const queued = scheduler.run('queued', 1, async () => 1, { signal: controller.signal });
      const rejected = expect(queued).rejects.toThrow(); controller.abort(); await rejected;
      await expect(first).rejects.toThrow('deadline');
    });
    it('honors 429 Retry-After and never repeats an uncertain write', async () => {
      const delays: number[] = []; let count = 0; const metrics: unknown[] = [];
      const request = createCfRequest(async () => ({ ok: ++count > 1, status: count > 1 ? 200 : 429, headers: { get: () => '1' }, json: async () => ({ result: [] }) }), {}, '', async ms => { delays.push(ms); }, value => metrics.push(value));
      await request('/zones'); expect(delays).toEqual([1000]); expect(count).toBe(2); expect(metrics).toHaveLength(2);
      const transport = vi.fn(async () => { throw new Error('socket disconnected'); });
      await expect(createCfRequest(transport, {})('/zones', { method: 'POST', body: '{}' })).rejects.toThrow('socket'); expect(transport).toHaveBeenCalledOnce();
    });
  });
}
