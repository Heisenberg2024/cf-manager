<template>
  <DnsOperationModal
    :show="show"
    :title="t('dns.zoneBatch.deleteTitle')"
    :running="running"
    @update:show="emit('update:show', $event)"
  >
    <n-alert
      type="warning"
      :bordered="false"
      style="margin-bottom: 12px"
    >
      {{ t('dns.plans.deleteHint') }}
    </n-alert>
    <n-data-table
      :columns="columns"
      :data="rows"
      :row-key="rowKey"
      :max-height="320"
      :scroll-x="720"
      :loading="running"
      size="small"
    />
    <n-text
      v-if="finished"
      style="display: block; margin-top: 12px"
    >
      {{ t('dns.zoneBatch.summary', { total: rows.length, success: rows.filter(row => row.status === 'success').length, failed: rows.filter(row => row.status === 'failed').length, uncertain: rows.filter(row => row.status === 'uncertain').length }) }}
    </n-text>
    <n-checkbox
      v-else
      v-model:checked="confirmed"
      :disabled="running"
      style="margin-top: 12px"
    >
      {{ t('dns.zoneBatch.confirmDelete', { count: rows.length }) }}
    </n-checkbox>
    <template #action>
      <n-button
        v-if="!finished"
        type="error"
        :loading="running"
        :disabled="running || !confirmed || !rows.length"
        @click="execute"
      >
        {{ t('common.delete') }}
      </n-button>
    </template>
  </DnsOperationModal>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { NText, type DataTableColumns } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import DnsOperationModal from './DnsOperationModal.vue';
import { dnsApi, type PlanChangeTarget, type DeleteZonesResult } from '../api/dns';
import type { ApiError } from '../api/client';
const props = defineProps<{ show: boolean; targets: PlanChangeTarget[] }>();
const emit = defineEmits<{ 'update:show': [show: boolean]; completed: [result: DeleteZonesResult] }>();
const { t } = useI18n();
interface Row { target: PlanChangeTarget; status: 'ready' | 'success' | 'failed' | 'uncertain'; error?: string }
const rows = ref<Row[]>([]), running = ref(false), finished = ref(false), confirmed = ref(false);
const rowKey = (row: Row) => `${row.target.accountId}:${row.target.zoneId}`;
const columns = computed<DataTableColumns<Row>>(() => [
  { title: t('dns.plans.domain'), key: 'name', width: 220, render: row => h('div', [h('div', row.target.name), h(NText, { depth: 3, style: 'font-size: 11px; overflow-wrap: anywhere' }, () => row.target.accountLabel)]) },
  { title: t('dns.zoneBatch.currentPlan'), key: 'plan', width: 160, render: row => row.target.plan?.name || t('dns.plans.unknown') },
  { title: t('dns.plans.status'), key: 'status', width: 100, render: row => t(`dns.plans.states.${row.status}`) },
  { title: t('dns.reason'), key: 'error', render: row => h(NText, { type: row.status === 'uncertain' ? 'warning' : 'error', style: 'overflow-wrap: anywhere' }, () => row.error || '') },
]);
watch([() => props.show, () => props.targets], ([show]) => {
  if (!show || running.value) return;
  rows.value = props.targets.map(target => ({ target: { ...target }, status: 'ready' }));
  finished.value = false; confirmed.value = false;
});
async function execute() {
  if (running.value || finished.value || !confirmed.value) return;
  const targets = rows.value.map(row => ({ name: row.target.name, accountId: row.target.accountId, zoneId: row.target.zoneId }));
  running.value = true;
  let result: DeleteZonesResult;
  try {
    const response = await dnsApi.deleteDomains(targets);
    result = response.data;
    for (const row of rows.value) {
      const receipt = result.results.find(item => item.accountId === row.target.accountId && item.zoneId === row.target.zoneId && item.name === row.target.name);
      row.status = !receipt ? 'uncertain' : receipt.outcome_uncertain ? 'uncertain' : receipt.success ? 'success' : 'failed';
      row.error = receipt?.error || (!receipt ? t('dns.zoneBatch.deleteUncertain') : undefined);
    }
  } catch (error) {
    const failure = error as ApiError;
    const uncertain = !failure.response?.status || failure.response.status >= 500;
    for (const row of rows.value) { row.status = uncertain ? 'uncertain' : 'failed'; row.error = failure.errorMessage || failure.message; }
    result = { total: targets.length, succeeded: 0, failed: targets.length, results: targets.map(target => ({ ...target, success: false, outcome_uncertain: uncertain, error: failure.errorMessage || failure.message })) };
  } finally { running.value = false; finished.value = true; }
  emit('completed', result);
}
</script>
