<template>
  <DnsOperationModal
    :show="show"
    :title="t(`dns.zoneOperations.${mode}Title`)"
    :running="running"
    @update:show="close"
  >
    <n-alert
      type="warning"
      :bordered="false"
      style="margin-bottom: 12px"
    >
      {{ t(`dns.zoneOperations.${mode}Hint`) }}
    </n-alert>
    <n-form
      v-if="mode === 'ssl'"
      label-placement="top"
      :disabled="running || finished"
    >
      <n-grid
        :cols="2"
        :x-gap="12"
        :y-gap="0"
      >
        <n-gi
          v-for="field in fields"
          :key="field.key"
        >
          <n-form-item :label="t(field.label)">
            <n-select
              v-model:value="form[field.key]"
              :options="field.options"
              clearable
              :placeholder="t('dns.zoneOperations.keep')"
            />
          </n-form-item>
        </n-gi>
      </n-grid>
    </n-form>
    <n-text
      v-if="loading"
      depth="3"
    >
      {{ t('common.loading') }}
    </n-text>
    <n-data-table
      :columns="columns"
      :data="rows"
      :row-key="rowKey"
      :max-height="320"
      :scroll-x="760"
      size="small"
    />
    <n-progress
      v-if="running"
      type="line"
      :percentage="Math.round(completed / Math.max(rows.length, 1) * 100)"
      style="margin-top: 12px"
    />
    <n-text
      v-if="finished"
      style="display: block; margin-top: 12px"
    >
      {{ t('dns.zoneOperations.summary', {
        total: rows.length, success: count('success') + count('unchanged'), partial: count('partial'),
        failed: count('failed'), uncertain: count('uncertain'), skipped: count('skipped'),
      }) }}
    </n-text>
    <n-checkbox
      v-else
      v-model:checked="confirmed"
      :disabled="loading || running"
      style="margin-top: 12px"
    >
      {{ t('dns.zoneOperations.confirm', { count: rows.length }) }}
    </n-checkbox>
    <template #action>
      <n-button
        v-if="!finished"
        type="primary"
        :loading="running"
        :disabled="loading || running || !confirmed || !canExecute"
        @click="execute"
      >
        {{ t('dns.zoneOperations.execute') }}
      </n-button>
    </template>
  </DnsOperationModal>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { NText, type DataTableColumns } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { dnsApi } from '../api/dns';
import type { ZoneSettingsResult } from '../shared/zoneSettingsEvents';
import { runBatch } from '../utils/batchOperation';
import { zoneOperationRows, settingsOperationResult, runZoneOperations, type ZoneOperationRow, type ZoneOperationTarget } from '../utils/zoneOperations';
import DnsOperationModal from './DnsOperationModal.vue';

const props = defineProps<{ show: boolean; mode: 'ssl' | 'purge'; targets: ZoneOperationTarget[] }>();
const emit = defineEmits<{ 'update:show': [show: boolean]; completed: [zoneIds: string[]] }>();
const { t } = useI18n();
const rows = ref<ZoneOperationRow[]>([]);
const form = ref<Record<string, string | null>>({});
const loading = ref(false), running = ref(false), finished = ref(false), confirmed = ref(false), completed = ref(0);
let identity = 0;
const switchOptions = computed(() => [{ label: t('common.enabled'), value: 'on' }, { label: t('common.disabled'), value: 'off' }]);
const fields = computed(() => [
  { key: 'ssl', label: 'dns.sslMode', options: [{ label: 'Off', value: 'off' }, { label: 'Flexible', value: 'flexible' }, { label: 'Full', value: 'full' }, { label: 'Full (Strict)', value: 'strict' }] },
  { key: 'always_use_https', label: 'dns.alwaysHttps', options: switchOptions.value },
  { key: 'automatic_https_rewrites', label: 'dns.autoHttpsRewrite', options: switchOptions.value },
  { key: 'security_level', label: 'dns.securityLevel', options: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'].map((value, index) => ({ value, label: ['Off', 'Essentially Off', 'Low', 'Medium', 'High', 'Under Attack'][index]! })) },
]);
const changes = computed(() => Object.fromEntries(Object.entries(form.value).filter(([, value]) => value !== null)));
const canExecute = computed(() => rows.value.some(row => row.status === 'ready') && (props.mode === 'purge' || Object.keys(changes.value).length > 0));
const count = (status: ZoneOperationRow['status']) => rows.value.filter(row => row.status === status).length;
const rowKey = (row: ZoneOperationRow) => `${row.target.accountId}:${row.target.zoneId}`;
function displaySettings(settings?: Record<string, unknown>) {
  const selected = fields.value.filter(field => form.value[field.key] !== null);
  return selected.map(field => `${t(field.label)}: ${field.options.find(option => option.value === settings?.[field.key])?.label || settings?.[field.key] || '—'}`).join('\n') || '—';
}
const columns = computed<DataTableColumns<ZoneOperationRow>>(() => [
  { title: t('dns.plans.domain'), key: 'name', width: 200, render: row => h('div', [h('div', row.target.name), h(NText, { depth: 3, style: 'font-size: 11px; overflow-wrap: anywhere' }, () => row.target.accountLabel)]) },
  ...(props.mode === 'ssl' ? [
    { title: t('dns.zoneOperations.current'), key: 'before', width: 190, render: (row: ZoneOperationRow) => h('div', { style: 'white-space: pre-line' }, displaySettings(row.before)) },
    { title: t('dns.zoneOperations.actual'), key: 'actual', width: 190, render: (row: ZoneOperationRow) => h('div', { style: 'white-space: pre-line' }, displaySettings(row.result?.settings)) },
  ] : []),
  { title: t('dns.plans.status'), key: 'status', width: 100, render: row => t(`dns.zoneOperations.states.${row.status}`) },
  { title: t('dns.reason'), key: 'reason', render: row => h(NText, { type: row.status === 'failed' ? 'error' : 'warning', style: 'white-space: pre-line; overflow-wrap: anywhere' }, () => row.status === 'skipped' ? t('dns.plans.duplicateSkipped') : [row.error, ...Object.entries(row.result?.fields || {}).filter(([, field]) => !['updated', 'unchanged'].includes(field.status)).map(([key, field]) => `${t(fields.value.find(item => item.key === key)?.label || key)}: ${field.reason || field.status}`), row.receipt ? t('dns.zoneOperations.receipt', { id: row.receipt }) : ''].filter(Boolean).join('\n')) },
]);
function close(show: boolean) { if (!running.value) emit('update:show', show); }
watch([() => props.show, () => props.targets, () => props.mode], async ([show]) => {
  const request = ++identity;
  if (!show) return;
  rows.value = zoneOperationRows(props.targets);
  form.value = Object.fromEntries(fields.value.map(field => [field.key, null]));
  finished.value = false; confirmed.value = false; completed.value = 0;
  loading.value = props.mode === 'ssl';
  if (!loading.value) return;
  try {
    await runBatch(rows.value.filter(row => row.status === 'ready'), async row => {
      try {
        const { data } = await dnsApi.getSettings(row.target.name, { accountId: row.target.accountId, zoneId: row.target.zoneId }, undefined, true);
        if (request === identity) row.before = data;
      } catch (error) {
        if (request !== identity) return;
        const failure = error as { errorMessage?: string; message?: string };
        row.status = 'failed'; row.error = failure.errorMessage || failure.message;
      }
    });
  } finally { if (request === identity) loading.value = false; }
});
async function execute() {
  if (loading.value || running.value || finished.value || !confirmed.value || !canExecute.value) return;
  running.value = true;
  const mode = props.mode, submitted = { ...changes.value }, batchRows = [...rows.value];
  try {
    await runZoneOperations(batchRows, async row => {
      const context = { accountId: row.target.accountId, zoneId: row.target.zoneId };
      if (mode === 'purge') {
        const { data } = await dnsApi.purgeCache(row.target.name, { purge_everything: true }, context);
        if (!data?.id) throw new Error(t('dns.zoneOperations.missingReceipt'));
        row.receipt = data.id; row.status = 'success';
      } else {
        const baseline = Object.fromEntries(Object.keys(submitted).filter(key => Object.hasOwn(row.before || {}, key)).map(key => [key, row.before![key]]));
        const { data } = await dnsApi.updateSettings(row.target.name, { changes: submitted, baseline }, context);
        settingsOperationResult(row, data as ZoneSettingsResult, submitted);
      }
    }, value => { completed.value = value; });
  } finally {
    running.value = false; finished.value = true;
    if (mode === 'ssl') emit('completed', batchRows.filter(row => row.status !== 'skipped').map(row => row.target.zoneId));
  }
}
</script>
