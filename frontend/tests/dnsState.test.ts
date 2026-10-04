import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { dnsApi } from '../src/api/dns';
import { useDnsStore } from '../src/stores/dnsStore';
import { runBatch } from '../src/utils/batchOperation';
import { createRequestScope } from '../src/utils/requestScope';

vi.mock('../src/api/dns', () => ({ dnsApi: { getDomains: vi.fn(), getRecords: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn(), deleteDomains: vi.fn(), updateStatus: vi.fn() } }));
const a = { accountId: 1, zoneId: 'zone-a' };
const b = { accountId: 2, zoneId: 'zone-b' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); });

describe('DNS state ownership', () => {
  it('does not let Account A overwrite Account B for the same domain', async () => {
    const first = deferred<any>(); const second = deferred<any>();
    vi.mocked(dnsApi.getRecords).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = useDnsStore();
    const loadA = store.fetchRecords('example.test', a);
    const loadB = store.fetchRecords('example.test', b);
    second.resolve({ data: [{ id: 'b' }] }); await loadB;
    first.resolve({ data: [{ id: 'a' }] }); await loadA;
    expect(store.records).toEqual([{ id: 'b' }]); expect(store.currentContext).toEqual(b);
  });
  it('keeps loading owned by the newer request even if an older request finishes first', async () => {
    const first = deferred<any>(); const second = deferred<any>();
    vi.mocked(dnsApi.getRecords).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = useDnsStore(); const loadA = store.fetchRecords('a.test', a); const loadB = store.fetchRecords('b.test', b);
    first.resolve({ data: [] }); await loadA; expect(store.loading).toBe(true);
    second.resolve({ data: [] }); await loadB; expect(store.loading).toBe(false);
  });
  it('prevents stale settings from crossing a Zone switch', async () => {
    vi.mocked(dnsApi.getRecords).mockResolvedValue({ data: [] } as any);
    const slow = deferred<any>();
    vi.mocked(dnsApi.getSettings).mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ data: { ssl: 'strict' } } as any);
    const store = useDnsStore(); await store.fetchRecords('a.test', a); const settingsA = store.fetchZoneSettings('a.test');
    await store.fetchRecords('b.test', b); await store.fetchZoneSettings('b.test');
    slow.resolve({ data: { ssl: 'off' } }); await settingsA;
    expect(store.zoneSettings).toEqual({ ssl: 'strict' });
  });
  it('uses verified remote settings after save instead of optimistic submitted values', async () => {
    vi.mocked(dnsApi.getRecords).mockResolvedValue({ data: [] } as any);
    vi.mocked(dnsApi.updateSettings).mockResolvedValue({ data: { updated: [], failed: ['ssl'], settings: { ssl: 'full' } } } as any);
    const store = useDnsStore(); await store.fetchRecords('a.test', a); await store.updateZoneSettings('a.test', { ssl: 'strict' });
    expect(store.zoneSettings.ssl).toBe('full');
    expect(dnsApi.updateSettings).toHaveBeenCalledWith('a.test', { ssl: 'strict' }, a);
  });
  it('protects the newer Zone while a previous save completes', async () => {
    vi.mocked(dnsApi.getRecords).mockResolvedValue({ data: [] } as any);
    const slow = deferred<any>(); vi.mocked(dnsApi.updateSettings).mockReturnValue(slow.promise);
    const store = useDnsStore(); await store.fetchRecords('a.test', a); const save = store.updateZoneSettings('a.test', { ssl: 'strict' });
    await store.fetchRecords('b.test', b); store.zoneSettings = { ssl: 'off' };
    slow.resolve({ data: { settings: { ssl: 'strict' } } }); await save;
    expect(store.zoneSettings.ssl).toBe('off');
  });
  it('forces Cloudflare refresh after deletion and clears the removed Zone', async () => {
    vi.mocked(dnsApi.getRecords).mockResolvedValue({ data: [{ id: 'a' }] } as any);
    vi.mocked(dnsApi.deleteDomains).mockResolvedValue({ data: { succeeded: 1 } } as any);
    vi.mocked(dnsApi.getDomains).mockResolvedValue({ data: [] } as any);
    const store = useDnsStore(); await store.fetchRecords('a.test', a); await store.deleteDomains([{ name: 'a.test', ...a }]);
    expect(dnsApi.getDomains).toHaveBeenCalledWith(true); expect(store.currentDomain).toBe(''); expect(store.records).toEqual([]);
  });
});

describe('batch and resource identities', () => {
  it('bounds concurrent work and retains success/failure results and progress', async () => {
    let running = 0; let maximum = 0; const progress: number[] = [];
    const results = await runBatch([1, 2, 3, 4, 5, 6], async value => {
      running++; maximum = Math.max(maximum, running); await new Promise(r => setTimeout(r, 2)); running--;
      if (value === 3) throw new Error('Cloudflare Code 1004: invalid record'); return value;
    }, value => progress.push(value), 3);
    expect(maximum).toBe(3); expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.filter(r => r.success)).toHaveLength(5); expect(results[2].error).toContain('1004');
    expect(results.map(r => r.item)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('invalidates A-to-B-to-A requests and latest refresh ownership', () => {
    let account = 'A'; const scope = createRequestScope(() => account);
    const first = scope.begin('records'); account = 'B'; scope.invalidate(); account = 'A';
    expect(first.current()).toBe(false);
    const refresh = scope.begin('records'); scope.begin('records'); expect(refresh.current()).toBe(false);
  });
});
