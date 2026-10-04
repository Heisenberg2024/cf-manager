<template>
  <n-collapse style="margin-bottom: 12px; flex-shrink: 0" @item-header-click="load">
    <n-collapse-item :title="t('credentials.title', { count: rows.length })" name="credentials">
      <n-space justify="space-between" style="margin-bottom: 8px">
        <n-text depth="3">{{ t('credentials.relationship') }}</n-text>
        <n-button size="small" :loading="loading" @click="load">{{ t('common.refresh') }}</n-button>
      </n-space>
      <n-data-table :columns="columns" :data="rows" :loading="loading" :row-key="(row: Credential) => row.id" :max-height="220" size="small" :scroll-x="900" />
    </n-collapse-item>
  </n-collapse>

  <n-modal v-model:show="show" preset="dialog" :title="editingId ? t('credentials.edit') : t('credentials.add')" style="width: 640px; max-width: 95vw" :mask-closable="!saving" @after-leave="clearSecrets">
    <n-form label-placement="top" size="small">
      <n-form-item :label="t('credentials.name')"><n-input v-model:value="form.name" :placeholder="t('credentials.optionalName')" /></n-form-item>
      <n-form-item :label="t('accounts.authType')"><n-select v-model:value="form.auth_type" :options="authTypes" :disabled="!!bindingId" /></n-form-item>
      <template v-if="!bindingId">
        <n-form-item v-if="form.auth_type === 'token'" label="API Token"><n-input v-model:value="form.api_token" type="password" :placeholder="editingId ? t('credentials.keepSecret') : t('accounts.apiTokenPlaceholder')" /></n-form-item>
        <template v-else>
          <n-form-item label="Email"><n-input v-model:value="form.email" /></n-form-item>
          <n-form-item label="Global API Key"><n-input v-model:value="form.api_key" type="password" :placeholder="editingId ? t('credentials.keepSecret') : ''" /></n-form-item>
        </template>
      </template>
      <n-alert v-if="editingId" type="warning" :bordered="false" style="margin-bottom: 12px">{{ t('credentials.sharedWarning') }}</n-alert>
      <template v-else>
        <n-space style="margin-bottom: 12px">
          <n-button v-if="!bindingId" :loading="detecting" @click="detect">{{ t('credentials.detect') }}</n-button>
          <n-checkbox v-model:checked="manual">{{ t('credentials.manual') }}</n-checkbox>
        </n-space>
        <n-form-item v-if="manual" label="Account ID"><n-input v-model:value="form.account_id" :placeholder="t('credentials.accountIdHint')" /></n-form-item>
        <n-alert v-if="discovery?.message" :type="discovery.status === 'discovered' ? 'info' : 'warning'" :bordered="false" style="margin-bottom: 12px">{{ discovery.message }}</n-alert>
        <n-alert v-if="discovery && !manual && !discovery.accounts.length" type="info" :bordered="false">{{ t('credentials.fallback') }}</n-alert>
        <n-checkbox-group v-if="!manual && discovered.length" v-model:value="selectedIds">
          <n-space vertical style="max-height: 280px; overflow: auto">
            <n-checkbox v-for="account in discovered" :key="account.id" :value="account.id">
              {{ account.name }} <n-text depth="3" style="font-family: monospace; font-size: 12px">{{ account.id }}</n-text>
            </n-checkbox>
          </n-space>
        </n-checkbox-group>
      </template>
    </n-form>
    <template #action>
      <n-button :disabled="saving" @click="show = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="saving" :disabled="detecting || (!editingId && !manual && !selectedIds.length)" @click="save">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <n-modal v-model:show="showSync" preset="dialog" :title="t('credentials.syncResult')" style="width: 700px; max-width: 95vw">
    <n-alert v-if="syncResult?.discovery.message" type="warning" :bordered="false">{{ syncResult.discovery.message }}</n-alert>
    <n-text>{{ t('credentials.newCount', { count: syncResult?.new_accounts.length || 0 }) }}</n-text>
    <n-data-table :columns="syncColumns" :data="syncResult?.results || []" :max-height="280" size="small" />
    <template #action><n-button @click="showSync = false">{{ t('common.close') }}</n-button></template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NCollapse, NCollapseItem, NDataTable, NForm, NFormItem, NInput, NModal, NSelect, NSpace, NText, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { credentialsApi, type Credential, type CredentialInput, type Discovery, type CloudflareAccount, type CredentialSync } from '../api/credentials';
import { formatCN } from '../utils/dateFormat';

const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const dialog = useDialog();
const message = useMessage();
const rows = ref<Credential[]>([]);
const loading = ref(false);
const busy = ref(new Set<number>());
let loadIdentity = 0;
async function load() {
  const identity = ++loadIdentity;
  loading.value = true;
  try { const { data } = await credentialsApi.list(); if (identity === loadIdentity) rows.value = data; }
  finally { if (identity === loadIdentity) loading.value = false; }
}
const show = ref(false);
const editingId = ref<number | null>(null);
const bindingId = ref<number | null>(null);
const manual = ref(false);
const saving = ref(false);
const detecting = ref(false);
const discovery = ref<Discovery | null>(null);
const discovered = ref<CloudflareAccount[]>([]);
const selectedIds = ref<string[]>([]);
const form = ref<CredentialInput>({ name: '', auth_type: 'token', api_token: '', api_key: '', email: '', account_id: '' });
const authTypes = computed(() => [{ label: t('accounts.authTypeToken'), value: 'token' }, { label: t('accounts.authTypeKey'), value: 'global_key' }]);
let detectionIdentity = 0;
function clearSecrets() { form.value.api_token = ''; form.value.api_key = ''; }
function open(row?: Credential) {
  ++detectionIdentity;
  editingId.value = row?.id || null;
  bindingId.value = null;
  form.value = { name: row?.name || '', auth_type: row?.auth_type || 'token', email: row?.email || '', api_token: '', api_key: '', account_id: '' };
  manual.value = false;
  discovery.value = null;
  discovered.value = [];
  selectedIds.value = [];
  show.value = true;
}
watch(() => [form.value.auth_type, form.value.api_token, form.value.api_key, form.value.email], () => {
  ++detectionIdentity; detecting.value = false; discovery.value = null;
  if (!bindingId.value) { discovered.value = []; selectedIds.value = []; }
});
async function detect() {
  const identity = ++detectionIdentity;
  detecting.value = true;
  try {
    const { data } = await credentialsApi.discover({ ...form.value });
    if (identity !== detectionIdentity) return;
    discovery.value = data;
    discovered.value = data.accounts;
    selectedIds.value = data.accounts.map(a => a.id);
    if (data.status === 'manual_required') manual.value = true;
  } finally { if (identity === detectionIdentity) detecting.value = false; }
}
async function save() {
  if (manual.value && !/^[a-f\d]{32}$/i.test(form.value.account_id?.trim() || '')) { message.warning(t('credentials.accountIdHint')); return; }
  saving.value = true;
  try {
    if (editingId.value) await credentialsApi.update(editingId.value, { ...form.value });
    else if (bindingId.value) await credentialsApi.bind(bindingId.value, manual.value ? { account_id: form.value.account_id?.trim() } : { selected_account_ids: [...selectedIds.value] });
    else await credentialsApi.create({ ...form.value, account_id: manual.value ? form.value.account_id?.trim() : undefined, selected_account_ids: manual.value ? undefined : [...selectedIds.value] });
    show.value = false; clearSecrets();
    await load(); emit('changed'); message.success(t('common.success'));
  } finally { saving.value = false; }
}
const showSync = ref(false);
const syncResult = ref<CredentialSync | null>(null);
async function sync(row: Credential, attach = false) {
  busy.value = new Set(busy.value).add(row.id);
  try {
    const { data } = await credentialsApi.sync(row.id);
    await load(); emit('changed');
    if (attach) {
      open();
      bindingId.value = row.id; form.value.name = row.name; form.value.auth_type = row.auth_type;
      discovered.value = data.new_accounts;
      selectedIds.value = data.new_accounts.map(a => a.id);
      discovery.value = { ...data.discovery, accounts: data.new_accounts };
      manual.value = !data.new_accounts.length;
    } else { syncResult.value = data; showSync.value = true; }
  } finally { const next = new Set(busy.value); next.delete(row.id); busy.value = next; }
}
function remove(row: Credential) {
  const names = row.accounts.map(a => `${a.name} (${a.account_id || a.id})`).join(', ');
  dialog.warning({ title: t('credentials.delete'), content: t('credentials.deleteConfirm', { name: row.name, count: row.accounts.length, accounts: names }), positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => { await credentialsApi.delete(row.id); await load(); emit('changed'); },
  });
}
const columns = computed<DataTableColumns<Credential>>(() => [
  { title: t('credentials.name'), key: 'name', width: 160 },
  { title: t('accounts.authType'), key: 'auth_type', width: 100 },
  { title: t('accounts.title'), key: 'accounts', width: 300, render: row => row.accounts.map(a => `${a.name} (${a.account_id || '—'})`).join(', ') || '—' },
  { title: t('accounts.table.status'), key: 'status', width: 110, render: row => t(`credentials.status.${row.status}`) },
  { title: t('credentials.checkedAt'), key: 'last_checked_at', width: 160, render: row => row.last_checked_at ? formatCN(row.last_checked_at) : '—' },
  { title: t('common.actions'), key: 'actions', width: 260, render: row => h(NSpace, { size: 4 }, { default: () => [
    h(NButton, { size: 'tiny', loading: busy.value.has(row.id), onClick: () => sync(row) }, { default: () => t('credentials.sync') }),
    h(NButton, { size: 'tiny', disabled: busy.value.has(row.id), onClick: () => sync(row, true) }, { default: () => t('credentials.bind') }),
    h(NButton, { size: 'tiny', onClick: () => open(row) }, { default: () => t('common.edit') }),
    h(NButton, { size: 'tiny', type: 'error', onClick: () => remove(row) }, { default: () => t('common.delete') }),
  ] }) },
]);
const syncColumns = computed<DataTableColumns<CredentialSync['results'][number]>>(() => [
  { title: t('accounts.table.name'), key: 'name' }, { title: 'Account ID', key: 'account_id' },
  { title: t('accounts.table.status'), key: 'status', render: row => t(`credentials.status.${row.status}`) },
  { title: t('common.message'), key: 'message' },
]);
onMounted(load);
defineExpose({ open, load });
</script>
