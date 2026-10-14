import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { workersApi } from '../api/workers';
import { accountsApi } from '../api/accounts';

export const useWorkerStore = defineStore('workers', () => {
  const workers = shallowRef<any[]>([]), summary = shallowRef<any[]>([]);
  const loading = ref(false), summaryLoading = ref(false), resourceError = ref('');
  const selectedAccountId = ref<number | null>(null);
  let accounts: any[] = [], generation = 0, identity = 0;
  let listController: AbortController | undefined, summaryController: AbortController | undefined;
  const cache = new Map<number, { rows: any[]; states: Record<string, string>; at: number; bytes: number }>();
  const versions = new Map<number, string>();
  const revisions = new Map<number, number>();
  const flights = new Map<number, Promise<void>>();
  function unknown(account: any) { return { accountId: account.id, accountName: account.name, workerCount: null, pagesCount: null, requests: null, errors: null, subrequests: null, cpuTimeMs: null, states: { workers: 'pending', pages: 'pending', usage: 'pending' } }; }
  function configureAccounts(bindings: any[]) {
    accounts = bindings.filter(a => a.account_id && a.is_active !== 0 && a.is_enabled !== 0 && (a.enabled_features || '').split(',').includes('workers'));
    for (const [id, version] of versions) {
      const account = accounts.find(a => a.id === id);
      if (!account || version !== JSON.stringify([account.account_id, account.credential_id, account.updated_at, account.identity_version, account.enabled_features])) { invalidate([id]); summary.value = summary.value.filter(row => row.accountId !== id); }
    }
    versions.clear();
    for (const account of accounts) versions.set(account.id, JSON.stringify([account.account_id, account.credential_id, account.updated_at, account.identity_version, account.enabled_features]));
    summary.value = accounts.map(a => ({ ...unknown(a), ...summary.value.find(s => s.accountId === a.id), accountName: a.name }));
  }
  function invalidate(ids: number[]) {
    const cfIds = new Set(accounts.filter(a => ids.includes(a.id)).map(a => a.account_id));
    for (const id of new Set([...ids, ...accounts.filter(a => cfIds.has(a.account_id)).map(a => a.id)])) { cache.delete(id); flights.delete(id); revisions.set(id, (revisions.get(id) || 0) + 1); }
  }
  function resetSensitiveState() {
    generation++; identity++; listController?.abort(); summaryController?.abort();
    cache.clear(); flights.clear(); versions.clear(); revisions.clear(); accounts = [];
    workers.value = []; summary.value = []; loading.value = false; summaryLoading.value = false; resourceError.value = ''; selectedAccountId.value = null;
  }
  function mergeSummary(row: any) { summary.value = summary.value.map(s => s.accountId === row.accountId ? { ...s, ...row } : s); }
  async function fetchAccountSummary(id: number, refresh = false, background = false, signal?: AbortSignal) {
    if (!refresh && flights.has(id)) return flights.get(id);
    const session = generation, revision = revisions.get(id) || 0;
    const promise = (async () => {
      try {
        const { data } = await workersApi.getSummary(id, { refresh, background, signal });
        if (session !== generation || revision !== (revisions.get(id) || 0) || signal?.aborted) return;
        if (Array.isArray(data)) for (const row of data) if (row.accountId === id) mergeSummary(row);
      } catch { if (session === generation && revision === (revisions.get(id) || 0) && !signal?.aborted) { const account = accounts.find(a => a.id === id); if (account) mergeSummary({ ...unknown(account), states: { workers: 'error', pages: 'error', usage: 'error' } }); } }
    })();
    flights.set(id, promise); void promise.finally(() => { if (flights.get(id) === promise) flights.delete(id); }).catch(() => {}); return promise;
  }
  async function fetchSummary(refresh = false) {
    const metadataSession = generation;
    if (!accounts.length) {
      try { const { data } = await accountsApi.getOptions('workers'); if (metadataSession !== generation) return; configureAccounts(data.accounts || []); }
      catch (error: any) { if (metadataSession === generation) resourceError.value = error.errorMessage || error.message; return; }
    }
    if (summaryController) { summaryController.abort(); flights.clear(); }
    const controller = summaryController = new AbortController();
    const session = generation;
    summaryLoading.value = true;
    const current = selectedAccountId.value || accounts[0]?.id;
    // Start foreground before other accounts; never block the selected resource list.
    const first = current ? fetchAccountSummary(current, refresh, false, controller.signal) : Promise.resolve();
    const queue = accounts.filter(a => a.id !== current).map(a => a.id);
    try {
      await Promise.all([first, ...Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (queue.length && !controller.signal.aborted && session === generation) await fetchAccountSummary(queue.shift()!, refresh, true, controller.signal);
      })]);
    } finally { if (session === generation && summaryController === controller) summaryLoading.value = false; }
  }
  async function fetchWorkers(accountId?: number | null, refresh = false) {
    listController?.abort(); const controller = listController = new AbortController(), request = ++identity;
    const session = generation, id = accountId ?? undefined, revision = id ? revisions.get(id) || 0 : 0;
    const current = () => request === identity && session === generation && (!id || revision === (revisions.get(id) || 0)) && !controller.signal.aborted;
    resourceError.value = ''; const cached = id ? cache.get(id) : undefined;
    workers.value = cached?.rows || [];
    if (!refresh && cached && Date.now() - cached.at < 30000) { loading.value = false; return; }
    loading.value = true;
    try {
      const { data } = await workersApi.getAll(id, { refresh, details: true, signal: controller.signal });
      if (!current()) return;
      const rows = Array.isArray(data) ? data : data.items;
      const state = data.states?.find((s: any) => s.accountId === id) || { workers: 'ready', pages: 'ready' };
      workers.value = rows;
      if (Object.values(state).some(v => typeof v === 'string' && v !== 'ready')) resourceError.value = 'RESOURCE_READ_FAILED';
      if (id && !resourceError.value) {
        cache.delete(id); const bytes = JSON.stringify(rows).length * 2;
        if (bytes <= 8 * 1024 * 1024) cache.set(id, { rows, states: state, at: Date.now(), bytes });
        while (cache.size > 60 || [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 8 * 1024 * 1024) cache.delete(cache.keys().next().value!);
      }
      if (id) mergeSummary({ accountId: id, workerCount: state.workers === 'ready' ? rows.filter((r: any) => r.type === 'worker').length : null, pagesCount: state.pages === 'ready' ? rows.filter((r: any) => r.type === 'pages').length : null, states: { ...summary.value.find(s => s.accountId === id)?.states, ...state } });
    } catch (error: any) { if (current()) resourceError.value = error.errorMessage || error.message; }
    finally { if (request === identity && session === generation) loading.value = false; }
  }
  async function refreshAccounts(ids: number[]) {
    invalidate(ids);
    await Promise.all(ids.map(id => fetchAccountSummary(id)));
    if (selectedAccountId.value && ids.includes(selectedAccountId.value)) await fetchWorkers(selectedAccountId.value);
  }
  async function fetchAllWorkers(): Promise<any[]> {
    const { data } = await workersApi.getAll(); return Array.isArray(data) ? data : [];
  }
  return { workers, loading, summary, summaryLoading, selectedAccountId, resourceError, configureAccounts, invalidate, resetSensitiveState, fetchSummary, fetchAccountSummary, fetchWorkers, fetchAllWorkers, refreshAccounts };
});
