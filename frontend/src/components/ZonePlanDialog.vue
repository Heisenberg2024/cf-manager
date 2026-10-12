<template>
  <DnsOperationModal
    :show="show"
    :title="t('dns.plans.changeTitle')"
    :running="running"
    @update:show="close"
  >
    <n-alert
      type="warning"
      :bordered="false"
      style="margin-bottom: 12px"
    >
      {{ t('dns.plans.changeHint') }}
    </n-alert>
    <n-alert
      v-if="rows.some(row => row.optionsError)"
      type="warning"
      :bordered="false"
      style="margin-bottom: 12px"
    >
      {{ t('dns.plans.optionsFailed') }}
    </n-alert>
    <n-form label-placement="top">
      <n-form-item :label="t('dns.plans.targetPlan')">
        <n-select
          v-model:value="selectedPlan"
          :options="options"
          :loading="loading"
          :disabled="loading || running || finished"
        />
      </n-form-item>
    </n-form>
    <n-data-table
      :columns="columns"
      :data="rows"
      :row-key="rowKey"
      :max-height="320"
      :scroll-x="720"
      size="small"
    />
    <n-progress
      v-if="running"
      style="margin-top: 12px"
      type="line"
      :percentage="Math.round(completed / Math.max(rows.length, 1) * 100)"
    />
    <n-text
      v-if="finished"
      style="display: block; margin-top: 12px"
    >
      {{ t('dns.plans.changeSummary', { total: rows.length, active: rows.filter(row => row.status === 'success').length, pending: rows.filter(row => row.status === 'pending').length, failed: rows.filter(row => row.status === 'failed').length, uncertain: rows.filter(row => row.status === 'uncertain').length, skipped: rows.filter(row => row.status === 'skipped').length }) }}
    </n-text>
    <n-checkbox
      v-else
      v-model:checked="confirmed"
      :disabled="running || loading"
      style="margin-top: 12px"
    >
      {{ t('dns.plans.confirmBilling') }}
    </n-checkbox>
    <template #action>
      <n-button
        v-if="!finished"
        type="primary"
        :loading="running"
        :disabled="loading || running || !confirmed || !rows.length"
        @click="execute"
      >
        {{ t('dns.plans.confirmChange') }}
      </n-button>
    </template>
  </DnsOperationModal>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { NText, type DataTableColumns } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { dnsApi, type PlanChangeTarget } from '../api/dns';
import type { ApiError } from '../api/client';
import type { ZonePlan, ZonePlanId, ZonePlanOption } from '../shared/zonePlans';
import { runBatch } from '../utils/batchOperation';
import DnsOperationModal from './DnsOperationModal.vue';
import { dnsPlanOptionLabel } from '../utils/dnsPlanLabel';

const props = defineProps<{ show: boolean; targets: PlanChangeTarget[] }>();
const emit = defineEmits<{ 'update:show': [show: boolean]; completed: [] }>();
const { t } = useI18n();
interface Row {
  target: PlanChangeTarget;
  before?: ZonePlan;
  actual?: ZonePlan;
  plans: ZonePlanOption[];
  optionsError?: string;
  error?: string;
  warning?: string;
  uncertain?: boolean;
  status: 'ready' | 'running' | 'success' | 'pending' | 'failed' | 'uncertain' | 'skipped';
}
const rows = ref<Row[]>([]);
const selectedPlan = ref<ZonePlanId>('free');
const confirmed = ref(false), loading = ref(false), running = ref(false), finished = ref(false), completed = ref(0);
let identity = 0;
const rowKey = (row: Row) => `${row.target.accountId}:${row.target.zoneId}`;
const options = computed(() => {
  const plans = new Map<string, ZonePlanOption>([['free', { id: 'free', name: 'Free', can_subscribe: true }]]);
  for (const row of rows.value) for (const plan of row.plans) if (plan.can_subscribe === true) plans.set(plan.id, plan);
  return [...plans.values()].map(plan => ({ value: plan.id, label: dnsPlanOptionLabel(plan, t) }));
});
const columns = computed<DataTableColumns<Row>>(() => [
  { title: t('dns.plans.domain'), key: 'name', width: 180, render: row => h('div', [h('div', row.target.name), h(NText, { depth: 3, style: 'font-size: 11px; overflow-wrap: anywhere' }, () => row.target.accountLabel)]) },
  { title: t('dns.plans.current'), key: 'before', width: 140, render: row => row.before?.name || t('dns.plans.unknown') },
  { title: t('dns.plans.actual'), key: 'actual', width: 140, render: row => row.actual?.name || (row.status === 'ready' || row.status === 'skipped' ? '—' : t('dns.plans.unknown')) },
  { title: t('dns.plans.status'), key: 'status', width: 100, render: row => t(`dns.plans.states.${row.status}`) },
  { title: t('dns.reason'), key: 'error', render: row => h(NText, { type: row.status === 'failed' ? 'error' : 'warning', style: 'overflow-wrap: anywhere' }, () => [row.uncertain ? t('dns.plans.changeUncertain') : '', row.error || row.warning || row.optionsError || ''].filter(Boolean).join(' ')) },
]);
function close(show: boolean) { if (!running.value) emit('update:show', show); }
watch([() => props.show, () => props.targets], async ([show]) => {
  const request = ++identity;
  if (!show) return;
  selectedPlan.value = 'free'; confirmed.value = false; finished.value = false; completed.value = 0;
  rows.value = props.targets.map(target => ({ target: { ...target }, before: target.plan, plans: [], status: 'ready' }));
  loading.value = true;
  const snapshot = rows.value;
  try {
    await runBatch(snapshot, async row => {
      try {
        const { data } = await dnsApi.getZonePlans(row.target.name, { accountId: row.target.accountId, zoneId: row.target.zoneId });
        if (request !== identity) return;
        row.plans = data.plans; row.before = data.plan;
      } catch (error) {
        const failure = error as ApiError;
        if (request === identity) row.optionsError = failure.errorMessage || failure.message;
      }
    });
  } finally { if (request === identity) loading.value = false; }
});
async function execute() {
  if (loading.value || running.value || finished.value || !confirmed.value) return;
  running.value = true;
  const plan = selectedPlan.value;
  const batchRows = [...rows.value];
  const processedZones = new Set<string>();
  try {
    // Each remote Zone is submitted at most once, including aliases bound through another credential.
    // Every failure/unknown outcome stays on its own row; all remaining Zones are still processed.
    for (const row of batchRows) {
      if (processedZones.has(row.target.zoneId)) {
        row.status = 'skipped'; row.warning = t('dns.plans.duplicateSkipped'); completed.value++; continue;
      }
      processedZones.add(row.target.zoneId);
      row.status = 'running'; row.error = undefined;
      try {
        const { data } = await dnsApi.changePlan(row.target.name, plan, { accountId: row.target.accountId, zoneId: row.target.zoneId });
        row.before = data.previous_plan; row.actual = data.plan; row.error = data.error; row.warning = data.warning; row.uncertain = data.outcome_uncertain;
        row.status = data.outcome_uncertain ? 'uncertain' : data.activation_pending ? 'pending' : data.success ? 'success' : 'failed';
      } catch (error) {
        const failure = error as ApiError;
        row.error = failure.errorMessage || failure.message;
        const status = failure.response?.status;
        row.uncertain = !status || status >= 500;
        row.status = row.uncertain ? 'uncertain' : 'failed';
      }
      completed.value++;
    }
  } finally {
    running.value = false; finished.value = true;
    emit('completed');
  }
}
</script>
