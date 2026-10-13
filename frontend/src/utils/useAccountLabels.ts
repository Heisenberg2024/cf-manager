import { h, onMounted, onScopeDispose, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { credentialsApi } from '../api/credentials';
import { dnsAccountLabel, type DnsAccountIdentity } from './dnsAccountLabel';

/** Each mounted view owns its Credential names; late responses cannot survive logout/unmount. */
export function useAccountLabels() {
  const { t } = useI18n();
  const names = ref(new Map<number, string>());
  let active = true;
  let flight: Promise<void> | undefined;
  function loadCredentialNames(): Promise<void> {
    if (flight) return flight;
    const token = localStorage.getItem('api_token');
    flight = credentialsApi.list().then(({ data }) => {
      if (active && token === localStorage.getItem('api_token')) names.value = new Map(data.map(credential => [credential.id, credential.name]));
    }).catch(() => {
      if (active) names.value = new Map();
    }).finally(() => { flight = undefined; });
    return flight;
  }
  onMounted(() => { void loadCredentialNames(); });
  onScopeDispose(() => { active = false; names.value = new Map(); });
  function renderAccountOption(option: { label?: string | number }, selected: boolean) {
    return h('span', { title: String(option.label || ''), style: selected ? '' : 'white-space: normal; overflow-wrap: anywhere; display: block' }, option.label);
  }
  return { loadCredentialNames, renderAccountOption, accountLabel: (account: DnsAccountIdentity) => dnsAccountLabel(account, names.value, t('dns.plans.credential')) };
}
