import { defineStore } from 'pinia';
import { ref } from 'vue';
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
  async function createDomains(data: { names: string[]; account_id: number; type: 'full' | 'partial' }) {
    const { data: result } = await dnsApi.createDomains(data);
    await fetchDomains(true); return result;
  }
  async function deleteDomains(names: Array<string | ZoneSelection>) {
    const { data } = await dnsApi.deleteDomains(names);
    await fetchDomains(true); return data;
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
  return { domains, records, currentDomain, currentContext, loading, domainsLoading, recordsError,
    zoneSettings, settingsLoading, settingsError, fetchDomains, fetchRecords, clearSelection, isCurrent,
    createDomains, deleteDomains, fetchZoneSettings, updateZoneSettings, purgeZoneCache, updateZoneStatus };
});
