import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { BatchZone } from '../shared/dnsBatch';
import type { CreateZoneResult, ZonePlanId } from '../shared/zonePlans';
import type { ApiError } from '../api/client';
import { dnsApi, type ZoneContext, type ZoneSelection } from '../api/dns';

export const useDnsStore = defineStore('dns', () => {
  const domains = ref<any[]>([]);
  const records = ref<any[]>([]);
  const currentDomain = ref('');
  const currentContext = ref<ZoneContext>({});
  const loading = ref(false);
  const domainsLoading = ref(false);
  const zoneSettings = ref<Record<string, any>>({});
  const settingsLoading = ref(false);
  const recordsError = ref('');
  const settingsError = ref('');
  let domainIdentity = 0;
  let recordIdentity = 0;
  let settingsIdentity = 0;
  const key = (domain: string, context: ZoneContext) => `${context.accountId || ''}:${context.zoneId || ''}:${domain}`;
  const isCurrent = (domain: string, context: ZoneContext) => key(domain, context) === key(currentDomain.value, currentContext.value);

  function clearSelection() {
    ++recordIdentity; ++settingsIdentity;
    currentDomain.value = ''; currentContext.value = {};
    records.value = []; zoneSettings.value = {};
    loading.value = false; settingsLoading.value = false;
    recordsError.value = ''; settingsError.value = '';
  }
  async function fetchDomains(refresh = false) {
    const identity = ++domainIdentity;
    domainsLoading.value = true;
    try {
      const { data } = await dnsApi.getDomains(refresh);
      if (identity !== domainIdentity) return;
      domains.value = data;
      if (currentDomain.value && !domains.value.some(d => d.name === currentDomain.value && (!currentContext.value.accountId || d.cfAccountId === currentContext.value.accountId) && (!currentContext.value.zoneId || d.id === currentContext.value.zoneId))) clearSelection();
    } finally { if (identity === domainIdentity) domainsLoading.value = false; }
  }
  async function fetchRecords(domain: string, context: ZoneContext = currentContext.value) {
    const changed = !isCurrent(domain, context);
    if (changed) { records.value = []; zoneSettings.value = {}; ++settingsIdentity; settingsLoading.value = false; settingsError.value = ''; }
    currentDomain.value = domain; currentContext.value = { ...context };
    const identity = ++recordIdentity;
    loading.value = true; recordsError.value = '';
    try {
      const { data } = await dnsApi.getRecords(domain, { ...context });
      if (identity === recordIdentity && isCurrent(domain, context)) records.value = data;
    } catch (error: any) {
      if (identity === recordIdentity) recordsError.value = error.errorMessage || error.message;
    } finally { if (identity === recordIdentity) loading.value = false; }
  }
  async function fetchZoneSettings(domain: string, context: ZoneContext = currentContext.value) {
    const identity = ++settingsIdentity;
    settingsLoading.value = true; settingsError.value = '';
    try {
      const { data } = await dnsApi.getSettings(domain, { ...context });
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
    try { await fetchDomains(true); } catch { /* The result dialog still reports the actual writes. */ }
    return { total: results.length, succeeded: results.filter(row => row.success).length, failed: results.filter(row => !row.success).length,
      fallback_count: results.filter(row => row.fallback).length, pending_count: results.filter(row => row.activation_pending).length, results };
  }
  async function deleteDomains(names: Array<string | ZoneSelection>) {
    const { data } = await dnsApi.deleteDomains(names);
    try { await fetchDomains(true); } catch { /* Preserve per-Zone deletion receipts when refresh fails. */ }
    return data;
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
    await fetchDomains(true);
  }
  // Records are never cached outside the active Zone. All other Zones read CF on next open.
  async function invalidateRecords(zones: BatchZone[]) {
    if(zones.some(z => isCurrent(z.zoneName, {accountId:z.accountId, zoneId:z.zoneId}))) {
      records.value = []; ++recordIdentity;
      await fetchRecords(currentDomain.value, {...currentContext.value});
    }
  }
  return { invalidateRecords, domains, records, currentDomain, currentContext, loading, domainsLoading, recordsError,
    zoneSettings, settingsLoading, settingsError, fetchDomains, fetchRecords, clearSelection, isCurrent,
    createDomains, deleteDomains, fetchZoneSettings, updateZoneSettings, purgeZoneCache, updateZoneStatus };
});
