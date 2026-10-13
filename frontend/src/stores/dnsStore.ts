import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type { BatchZone } from '../shared/dnsBatch';
import type { CreateZoneResult, ZonePlanId } from '../shared/zonePlans';
import type { ApiError } from '../api/client';
import { dnsApi, type ZoneContext, type ZoneSelection } from '../api/dns';

export const useDnsStore = defineStore('dns', () => {
  const domains = shallowRef<any[]>([]);
  const records = shallowRef<any[]>([]);
  const currentDomain = ref('');
  const currentContext = ref<ZoneContext>({});
  const loading = ref(false);
  const domainsLoading = ref(false);
  const zoneSettings = ref<Record<string, any>>({});
  const settingsLoading = ref(false);
  const recordsError = ref('');
  const settingsError = ref('');
  const domainErrors = ref<Record<number, string>>({});
  const domainStates = ref<Record<number, string>>({});
  let domainIdentity = 0;
  let recordIdentity = 0;
  let settingsIdentity = 0;
  let sessionRevision = 0;
  let activeRecordsComplete = false;
  let accountIds: number[] | undefined;
  let accountVersions = new Map<number, string>();
  let domainScope: number[] | undefined;
  let domainController: AbortController | undefined;
  let recordController: AbortController | undefined;
  let settingsController: AbortController | undefined;
  const recordMode = ref<'all' | 'page'>('all');
  const recordTotal = ref(0);
  const zoneRecordTotal = ref(0);
  const recordWindow = ref(1);
  const recordFilter = ref<{ type?: string; nameContains?: string; contentContains?: string }>({});
  const pageCache = new Map<string, { rows: any[]; total: number; fetchedAt: number }>();
  function clearPageCache(zoneId?: string) {
    for (const cacheKey of pageCache.keys()) if (!zoneId || cacheKey.split(':')[1] === zoneId) pageCache.delete(cacheKey);
  }
  const recordCache = new Map<string, { rows: any[]; fetchedAt: number }>();
  const revisions = new Map<string, number>();
  let recordFlight: { key: string; promise: Promise<void> } | undefined;
  const key = (domain: string, context: ZoneContext) => `${context.accountId || ''}:${context.zoneId || ''}:${domain}`;
  const isCurrent = (domain: string, context: ZoneContext) => key(domain, context) === key(currentDomain.value, currentContext.value);
  function cacheRecords(cacheKey: string, rows: any[], fetchedAt = Date.now()) {
    recordCache.delete(cacheKey);
    if (rows.length <= 20000) recordCache.set(cacheKey, { rows, fetchedAt });
    while (recordCache.size > 30 || [...recordCache.values()].reduce((count, entry) => count + entry.rows.length, 0) > 50000) recordCache.delete(recordCache.keys().next().value!);
  }
  function configureAccounts(bindings: Array<{ id: number } & Record<string, unknown>>) {
    const next = new Map(bindings.map(account => [account.id, JSON.stringify(account)]));
    for (const [id, version] of accountVersions) if (next.get(id) !== version) {
      for (const cacheKey of recordCache.keys()) if (cacheKey.startsWith(`${id}:`)) { recordCache.delete(cacheKey); revisions.set(cacheKey, (revisions.get(cacheKey) || 0) + 1); }
      for (const cacheKey of pageCache.keys()) if (cacheKey.startsWith(`${id}:`)) pageCache.delete(cacheKey);
      domains.value = domains.value.filter(zone => zone.cfAccountId !== id);
      if (currentContext.value.accountId === id) clearSelection();
    }
    accountVersions = next; accountIds = bindings.map(account => account.id);
  }
  function clearSelection() {
    recordController?.abort(); settingsController?.abort();
    ++recordIdentity; ++settingsIdentity;
    currentDomain.value = ''; currentContext.value = {};
    records.value = []; zoneSettings.value = {};
    activeRecordsComplete = false; recordMode.value = 'all'; recordTotal.value = 0; zoneRecordTotal.value = 0; recordWindow.value = 1; recordFilter.value = {};
    loading.value = false; settingsLoading.value = false;
    recordsError.value = ''; settingsError.value = '';
  }
  function resetSensitiveState() {
    sessionRevision++;
    clearSelection(); domainController?.abort(); ++domainIdentity;
    domains.value = []; domainErrors.value = {}; domainStates.value = {}; domainsLoading.value = false;
    recordCache.clear(); clearPageCache(); revisions.clear(); accountVersions.clear(); accountIds = undefined; domainScope = undefined;
  }
  function setDomainScope(scope: number[]) { domainScope = scope; }
  async function fetchDomains(refresh = false, scope: number[] | undefined = domainScope ?? accountIds) {
    const identity = ++domainIdentity;
    domainController?.abort(); const controller = domainController = new AbortController();
    domainsLoading.value = true;
    if (scope) for (const id of scope) { delete domainErrors.value[id]; delete domainStates.value[id]; }
    else { domainErrors.value = {}; domainStates.value = {}; }
    const reconcile = (ids?: number[]) => {
      if ((!ids || ids.includes(currentContext.value.accountId!)) && currentDomain.value && !domains.value.some(d => d.name === currentDomain.value && (!currentContext.value.accountId || d.cfAccountId === currentContext.value.accountId) && (!currentContext.value.zoneId || d.id === currentContext.value.zoneId))) clearSelection();
    };
    try {
      if (!scope) {
        const { data } = await dnsApi.getDomains(refresh);
        if (identity !== domainIdentity) return;
        domains.value = data; reconcile(); return;
      }
      const queue = [...scope];
      const staleIds: number[] = [];
      const order = new Map((accountIds ?? scope).map((id, index) => [id, index]));
      const merge = (id: number, zones: any[]) => {
        domains.value = [...domains.value.filter(zone => zone.cfAccountId !== id), ...zones].sort((a, b) => (order.get(a.cfAccountId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.cfAccountId) ?? Number.MAX_SAFE_INTEGER));
      };
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && identity === domainIdentity) {
          const id = queue.shift()!;
          try {
            const { data } = await dnsApi.getAccountDomains(id, refresh, controller.signal);
            if (identity !== domainIdentity) return;
            merge(id, data.zones);
            domainStates.value[id] = data.meta.state;
            if (data.meta.error) domainErrors.value[id] = data.meta.error;
            reconcile([id]);
            if (data.meta.state === 'stale') staleIds.push(id);
          } catch (error: any) {
            if (identity === domainIdentity) { domainErrors.value[id] = error.errorMessage || error.message; domainStates.value[id] = 'error'; }
          }
        }
      }));
      // Show the stale snapshot first, then join server revalidation after other accounts can render.
      await Promise.all(Array.from({ length: Math.min(2, staleIds.length) }, async () => {
        while (staleIds.length && identity === domainIdentity) {
          const id = staleIds.shift()!;
          try {
            const { data } = await dnsApi.getAccountDomains(id, true, controller.signal);
            if (identity !== domainIdentity) return;
            merge(id, data.zones);
            domainStates.value[id] = data.meta.state; delete domainErrors.value[id]; reconcile([id]);
          } catch (error: any) { if (identity === domainIdentity) { domainErrors.value[id] = error.errorMessage || error.message; domainStates.value[id] = 'error'; } }
        }
      }));
    } finally { if (identity === domainIdentity) domainsLoading.value = false; }
  }
  function fetchRecords(domain: string, context: ZoneContext = currentContext.value, refresh = false): Promise<void> {
    context = { ...context };
    const cacheKey = key(domain, context);
    if (!refresh && recordFlight?.key === cacheKey && isCurrent(domain, context)) return recordFlight.promise;
    const changed = !isCurrent(domain, context);
    if (!changed && recordMode.value === 'page') return fetchRecordWindow(recordWindow.value, recordFilter.value, refresh);
    recordController?.abort();
    recordFlight = undefined;
    if (changed) { recordMode.value = 'all'; recordTotal.value = 0; zoneRecordTotal.value = 0; recordWindow.value = 1; recordFilter.value = {}; records.value = []; activeRecordsComplete = false; zoneSettings.value = {}; ++settingsIdentity; settingsController?.abort(); settingsLoading.value = false; settingsError.value = ''; }
    currentDomain.value = domain; currentContext.value = context;
    const identity = ++recordIdentity;
    const revision = revisions.get(cacheKey) || 0;
    const cacheable = !!context.accountId && !!context.zoneId;
    const cached = cacheable ? recordCache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.fetchedAt < 120000) {
      records.value = cached.rows; cacheRecords(cacheKey, cached.rows, cached.fetchedAt);
      activeRecordsComplete = true; recordMode.value = 'all'; recordTotal.value = cached.rows.length; zoneRecordTotal.value = cached.rows.length;
      if (!refresh && Date.now() - cached.fetchedAt < 30000) { recordsError.value = ''; loading.value = false; return Promise.resolve(); }
    } else if (changed) records.value = [];
    const initialPage = pageCache.get(`${cacheKey}:${JSON.stringify([1, '', '', ''])}`);
    if (!refresh && initialPage && Date.now() - initialPage.fetchedAt < 30000) {
      recordMode.value = 'page'; records.value = initialPage.rows; recordTotal.value = initialPage.total; zoneRecordTotal.value = initialPage.total;
      activeRecordsComplete = false; loading.value = false; recordsError.value = ''; return Promise.resolve();
    }
    const controller = recordController = new AbortController();
    loading.value = true; recordsError.value = '';
    const promise: Promise<void> = (async () => {
      try {
        const { data } = await dnsApi.getRecords(domain, context, controller.signal, { page: 1, perPage: 500 });
        if (controller.signal.aborted || revision !== (revisions.get(cacheKey) || 0)) return;
        const rows = Array.isArray(data) ? data : data.records;
        const total = Array.isArray(data) ? rows.length : data.meta?.total_count ?? (rows.length < 500 ? rows.length : undefined);
        if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total < rows.length) throw new Error('DNS pagination total unavailable; refresh before selecting a scope');
        const complete = total === rows.length;
        if (cacheable && complete) cacheRecords(cacheKey, rows);
        if (!complete) { recordCache.delete(cacheKey); if (cacheable) cachePage(cacheKey, 1, {}, rows, total); }
        if (identity === recordIdentity && isCurrent(domain, context)) { records.value = rows; activeRecordsComplete = complete; recordMode.value = complete ? 'all' : 'page'; recordTotal.value = total; zoneRecordTotal.value = total; }
      } catch (error: any) {
        if (identity === recordIdentity && !controller.signal.aborted) { recordsError.value = error.errorMessage || error.message; recordCache.delete(cacheKey); }
      } finally { if (identity === recordIdentity) { loading.value = false; recordFlight = undefined; } }
    })();
    recordFlight = { key: cacheKey, promise }; return promise;
  }
  function cachePage(base: string, page: number, filter: typeof recordFilter.value, rows: any[], total: number) {
    if (!base.split(':')[0] || !base.split(':')[1]) return;
    const cacheKey = `${base}:${JSON.stringify([page, filter.type || '', filter.nameContains || '', filter.contentContains || ''])}`;
    pageCache.delete(cacheKey); pageCache.set(cacheKey, { rows, total, fetchedAt: Date.now() });
    while (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value!);
  }
  async function fetchRecordWindow(page: number, filter: typeof recordFilter.value = {}, refresh = false) {
    const domain = currentDomain.value, context = { ...currentContext.value }, base = key(domain, context);
    if (!domain || recordMode.value !== 'page') return;
    const normalized = { ...filter };
    const cacheKey = `${base}:${JSON.stringify([page, normalized.type || '', normalized.nameContains || '', normalized.contentContains || ''])}`;
    if (!refresh && recordWindow.value === page && JSON.stringify(recordFilter.value) === JSON.stringify(normalized) && recordFlight?.key === cacheKey) return recordFlight.promise;
    recordController?.abort(); const identity = ++recordIdentity;
    const revision = revisions.get(base) || 0;
    const controller = recordController = new AbortController();
    const changed = page !== recordWindow.value || JSON.stringify(normalized) !== JSON.stringify(recordFilter.value);
    recordWindow.value = page; recordFilter.value = normalized;
    if (changed) records.value = [];
    const cached = pageCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.fetchedAt < 30000) {
      pageCache.delete(cacheKey); pageCache.set(cacheKey, cached);
      records.value = cached.rows; recordTotal.value = cached.total; if (!Object.values(normalized).some(Boolean)) zoneRecordTotal.value = cached.total; loading.value = false; recordsError.value = ''; return;
    }
    loading.value = true; recordsError.value = '';
    const promise = (async () => {
      try {
        const { data } = await dnsApi.getRecords(domain, context, controller.signal, { page, perPage: 500, ...normalized });
        if (controller.signal.aborted || identity !== recordIdentity || revision !== (revisions.get(base) || 0) || !isCurrent(domain, context)) return;
        if (!Array.isArray(data.records) || !Number.isSafeInteger(data.meta?.total_count)) throw new Error('DNS pagination total unavailable');
        cachePage(base, page, normalized, data.records, data.meta.total_count);
        records.value = data.records; recordTotal.value = data.meta.total_count; if (!Object.values(normalized).some(Boolean)) zoneRecordTotal.value = data.meta.total_count;
      } catch (error: any) { if (identity === recordIdentity && !controller.signal.aborted) recordsError.value = error.errorMessage || error.message; }
      finally { if (identity === recordIdentity) { loading.value = false; recordFlight = undefined; } }
    })();
    recordFlight = { key: cacheKey, promise }; return promise;
  }
  function applyRecord(domain: string, context: ZoneContext, recordId: string, row?: any) {
    const cacheKey = key(domain, context);
    clearPageCache(context.zoneId);
    if (currentContext.value.zoneId === context.zoneId && recordMode.value === 'page') recordCache.delete(cacheKey);
    for (const alias of recordCache.keys()) if (alias !== cacheKey && alias.split(':')[1] === context.zoneId) { recordCache.delete(alias); revisions.set(alias, (revisions.get(alias) || 0) + 1); }
    if (isCurrent(domain, context) && recordMode.value === 'page') {
      revisions.set(cacheKey, (revisions.get(cacheKey) || 0) + 1);
      const before = records.value.find(record => record.id === recordId);
      const filter = recordFilter.value;
      if (row && before && row.name === before.name && row.type === before.type && (!filter.contentContains || String(row.content || '').toLowerCase().includes(filter.contentContains.toLowerCase()))) {
        ++recordIdentity; recordController?.abort(); loading.value = false;
        records.value = records.value.map(record => record.id === recordId ? row : record);
        cachePage(cacheKey, recordWindow.value, filter, records.value, recordTotal.value);
      } else void fetchRecordWindow(recordWindow.value, filter, true);
      return;
    }
    revisions.set(cacheKey, (revisions.get(cacheKey) || 0) + 1);
    if (!isCurrent(domain, context) && currentContext.value.zoneId === context.zoneId) void fetchRecords(currentDomain.value, { ...currentContext.value }, true);
    const cached = recordCache.get(cacheKey);
    const current = isCurrent(domain, context);
    if (current && !cached && !activeRecordsComplete) { void fetchRecords(domain, context, true); return; }
    const rows = cached?.rows ?? (current ? records.value : undefined);
    if (!rows) return;
    const exists = rows.some(record => record.id === recordId);
    const next = row ? (exists ? rows.map(record => record.id === recordId ? row : record) : [...rows, row]) : rows.filter(record => record.id !== recordId);
    if (context.accountId && context.zoneId) cacheRecords(cacheKey, next, cached?.fetchedAt ?? 0);
    if (current) { ++recordIdentity; recordController?.abort(); loading.value = false; records.value = next; recordTotal.value = next.length; }
  }
  async function saveRecord(domain: string, context: ZoneContext, body: any, recordId?: string) {
    const session = sessionRevision, version = accountVersions.get(context.accountId!);
    const valid = () => session === sessionRevision && version === accountVersions.get(context.accountId!);
    try {
      const { data } = recordId ? await dnsApi.updateRecord(domain, recordId, body, context) : await dnsApi.createRecord(domain, body, context);
      if (!valid()) return data;
      if (data?.id) applyRecord(domain, context, data.id, data);
      else await invalidateRecords([{ accountId: context.accountId!, zoneId: context.zoneId!, zoneName: domain, credentialId: 0 }]);
      return data;
    } catch (error) { if (valid()) { recordCache.delete(key(domain, context)); clearPageCache(context.zoneId); } throw error; }
  }
  async function removeRecord(domain: string, context: ZoneContext, recordId: string) {
    const session = sessionRevision, version = accountVersions.get(context.accountId!);
    const valid = () => session === sessionRevision && version === accountVersions.get(context.accountId!);
    try { await dnsApi.deleteRecord(domain, recordId, context); if (valid()) applyRecord(domain, context, recordId); }
    catch (error) { if (valid()) { recordCache.delete(key(domain, context)); clearPageCache(context.zoneId); } throw error; }
  }
  const proxyPending = ref<Set<string>>(new Set());
  async function toggleProxy(domain: string, context: ZoneContext, recordId: string, proxied: boolean) {
    const session = sessionRevision, version = accountVersions.get(context.accountId!);
    const valid = () => session === sessionRevision && version === accountVersions.get(context.accountId!);
    const pendingKey = `${key(domain, context)}:${recordId}`;
    if (proxyPending.value.has(pendingKey)) return;
    proxyPending.value = new Set([...proxyPending.value, pendingKey]);
    const old = (recordCache.get(key(domain, context))?.rows ?? records.value).find(row => row.id === recordId);
    if (!old) { proxyPending.value.delete(pendingKey); return; }
    applyRecord(domain, context, recordId, { ...old, proxied, ...(proxied ? { ttl: 1 } : {}) });
    try {
      const { data } = await dnsApi.updateProxy(domain, recordId, proxied, context);
      if (!valid()) return;
      const confirmed = data?.record || data;
      if (confirmed?.id) applyRecord(domain, context, recordId, confirmed);
      else {
        await invalidateRecords([{ accountId: context.accountId!, zoneId: context.zoneId!, zoneName: domain, credentialId: 0 }]);
        if (currentContext.value.zoneId === context.zoneId && recordsError.value) throw new Error(recordsError.value);
      }
    } catch (error) { if (valid()) { applyRecord(domain, context, recordId, old); recordCache.delete(key(domain, context)); clearPageCache(context.zoneId); } throw error; }
    finally { const next = new Set(proxyPending.value); next.delete(pendingKey); proxyPending.value = next; }
  }
  async function fetchZoneSettings(domain: string, context: ZoneContext = currentContext.value) {
    settingsController?.abort(); const controller = settingsController = new AbortController();
    const identity = ++settingsIdentity;
    settingsLoading.value = true; settingsError.value = '';
    try {
      const { data } = await dnsApi.getSettings(domain, { ...context }, controller.signal);
      if (identity === settingsIdentity && isCurrent(domain, context)) zoneSettings.value = data;
    } catch (error: any) {
      if (identity === settingsIdentity) { settingsError.value = error.errorMessage || error.message; zoneSettings.value = {}; }
    } finally { if (identity === settingsIdentity) settingsLoading.value = false; }
  }
  async function createDomains(data: { names: string[]; account_id: number; type: 'full' | 'partial'; plan?: ZonePlanId }, onProgress?: (name: string, result?: CreateZoneResult) => void) {
    const input = { ...data };
    const requested = input.plan || 'free';
    const names = [...new Set(input.names.map(name => name.trim().toLowerCase()).filter(Boolean))];
    const results: CreateZoneResult[] = [];
    let capacityExhausted = false;
    let capacityWarning = '';
    // One domain per invocation isolates HTTP failures and Worker subrequest budgets.
    // Never repeat a processed name, including an unknown creation/write response.
    for (const name of names) {
      onProgress?.(name);
      try {
        const { data: receipt } = await dnsApi.createDomains({ ...input, names: [name], plan: capacityExhausted ? 'free' : requested });
        if (receipt.total !== 1 || receipt.results?.length !== 1 || receipt.results[0]?.name !== name) throw new Error('Zone creation receipt could not be confirmed; refresh before retrying');
        const row = { ...receipt.results[0], requested_plan: requested };
        if (capacityExhausted && row.success && (row.plan?.id === 'free' || row.plan?.id === 'partners_free')) {
          row.fallback = true; row.warning ||= capacityWarning;
        }
        results.push(row);
        // The server marks fallback only after an explicit upstream capacity rejection.
        if (row.fallback) { capacityExhausted = true; capacityWarning = row.warning || ''; }
      } catch (error) {
        const failure = error as ApiError;
        const status = failure.response?.status;
        results.push({ name, success: false, zone_created: false, requested_plan: requested, outcome_uncertain: !status || status >= 500, error: failure.errorMessage || failure.message });
      }
      onProgress?.(name, results[results.length - 1]);
    }
    // Preserve the creation receipt even if the subsequent list refresh fails.
    try { await fetchDomains(true, [input.account_id]); } catch { /* The result dialog still reports the actual writes. */ }
    return { total: results.length, succeeded: results.filter(row => row.success).length, failed: results.filter(row => !row.success).length,
      fallback_count: results.filter(row => row.fallback).length, pending_count: results.filter(row => row.activation_pending).length, results };
  }
  async function deleteDomains(names: Array<string | ZoneSelection>) {
    const { data } = await dnsApi.deleteDomains(names);
    forgetDeletedZones(data.results || []);
    try { await fetchDomains(true, names.every(name => typeof name !== 'string' && name.accountId) ? [...new Set(names.map(name => (name as ZoneSelection).accountId!))] : accountIds); } catch { /* Preserve per-Zone deletion receipts when refresh fails. */ }
    return data;
  }
  function forgetDeletedZones(results: Array<ZoneSelection & { success?: boolean }>) {
    for (const result of results) if (result.zoneId) clearPageCache(result.zoneId);
    const touched = new Set(results.map(result => result.zoneId).filter(Boolean));
    const deleted = new Set(results.filter(result => result.success).map(result => result.zoneId).filter(Boolean));
    if (recordFlight && touched.has(recordFlight.key.split(':')[1])) revisions.set(recordFlight.key, (revisions.get(recordFlight.key) || 0) + 1);
    for (const cacheKey of recordCache.keys()) if (touched.has(cacheKey.split(':')[1])) { recordCache.delete(cacheKey); revisions.set(cacheKey, (revisions.get(cacheKey) || 0) + 1); }
    domains.value = domains.value.filter(zone => !deleted.has(zone.id));
    if (deleted.has(currentContext.value.zoneId)) clearSelection();
  }
  async function updateZoneSettings(domain: string, settings: Record<string, any>) {
    const context = { ...currentContext.value };
    const identity = ++settingsIdentity;
    const { data } = await dnsApi.updateSettings(domain, settings, context);
    if (identity === settingsIdentity && isCurrent(domain, context)) zoneSettings.value = data.settings;
    return data;
  }
  async function purgeZoneCache(domain: string, options: { purge_everything?: boolean; files?: string[] }) {
    const { data } = await dnsApi.purgeCache(domain, options, { ...currentContext.value }); return data;
  }
  async function updateZoneStatus(domain: string, paused: boolean) {
    await dnsApi.updateStatus(domain, paused, { ...currentContext.value });
    await fetchDomains(true, currentContext.value.accountId ? [currentContext.value.accountId] : accountIds);
  }
  async function invalidateRecords(zones: BatchZone[]) {
    for (const zone of zones) {
      clearPageCache(zone.zoneId);
      const keys = new Set([key(zone.zoneName, { accountId: zone.accountId, zoneId: zone.zoneId }), ...[...recordCache.keys()].filter(cacheKey => cacheKey.split(':')[1] === zone.zoneId)]);
      for (const cacheKey of keys) { recordCache.delete(cacheKey); revisions.set(cacheKey, (revisions.get(cacheKey) || 0) + 1); }
    }
    if (zones.some(z => z.zoneId === currentContext.value.zoneId)) await fetchRecords(currentDomain.value, { ...currentContext.value }, true);
  }
  return { zoneRecordTotal, recordMode, recordTotal, recordWindow, recordFilter, fetchRecordWindow, forgetDeletedZones, resetSensitiveState, setDomainScope, configureAccounts, domainErrors, domainStates, saveRecord, removeRecord, toggleProxy, proxyPending, invalidateRecords, domains, records, currentDomain, currentContext, loading, domainsLoading, recordsError,
    zoneSettings, settingsLoading, settingsError, fetchDomains, fetchRecords, clearSelection, isCurrent,
    createDomains, deleteDomains, fetchZoneSettings, updateZoneSettings, purgeZoneCache, updateZoneStatus };
});
