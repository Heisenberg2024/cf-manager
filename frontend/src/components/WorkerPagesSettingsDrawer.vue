<template>
  <n-drawer v-model:show="visible" :width="drawerWidth(860)" placement="right">
    <n-drawer-content :title="t('pagesSettings.drawerTitle', { name: workerName })" closable>
      <n-tabs type="line" animated>
        <!-- Pages 项目信息 -->
        <n-tab-pane name="pagesInfo" :tab="t('pagesSettings.tabs.info')">
          <n-space vertical>
            <n-text depth="3">{{ t('pagesSettings.infoHint') }}</n-text>
            <n-spin :show="pagesProjectLoading">
              <n-card size="small" v-if="pagesProject">
                <n-descriptions label-placement="left" :column="1" bordered>
                  <n-descriptions-item :label="t('pagesSettings.name')">{{ pagesProject.name }}</n-descriptions-item>
                  <n-descriptions-item label="ID">{{ pagesProject.id }}</n-descriptions-item>
                  <n-descriptions-item :label="t('pagesSettings.productionBranch')">{{ pagesProject.production_branch }}</n-descriptions-item>
                  <n-descriptions-item :label="t('pagesSettings.framework')">{{ pagesProject.framework || '-' }}</n-descriptions-item>
                  <n-descriptions-item :label="t('pagesSettings.subdomain')">{{ pagesProject.subdomain || '-' }}</n-descriptions-item>
                  <n-descriptions-item :label="t('pagesSettings.createdTime')">{{ pagesProject.created_on ? formatCN(pagesProject.created_on) : '-' }}</n-descriptions-item>
                  <n-descriptions-item :label="t('pagesSettings.functions')">{{ pagesProject.uses_functions ? t('common.yes') : t('common.no') }}</n-descriptions-item>
                </n-descriptions>
              </n-card>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 自定义域名 -->
        <n-tab-pane name="pagesDomains" :tab="t('pagesSettings.tabs.domains')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('pagesSettings.domainsHint') }}</n-text>
              <n-button size="small" type="primary" @click="openPagesDomainModal">{{ t('pagesSettings.addDomain') }}</n-button>
            </n-space>
            <n-spin :show="pagesDomainsLoading">
              <n-data-table :columns="pagesDomainColumns" :data="pagesDomains" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 环境变量 -->
        <n-tab-pane name="pagesEnvVars" :tab="t('pagesSettings.tabs.envVars')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('pagesSettings.envVarsHint') }}</n-text>
              <n-button size="small" type="primary" @click="pagesEnvEditing = false; pagesEnvForm = { name: '', value: '', type: 'plain_text' }; showPagesEnvModal = true">{{ t('pagesSettings.addVar') }}</n-button>
            </n-space>
            <n-spin :show="pagesProjectLoading">
              <n-data-table :columns="pagesEnvColumns" :data="pagesEnvVars" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 绑定 -->
        <n-tab-pane name="pagesBindings" :tab="t('pagesSettings.tabs.bindings')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('pagesSettings.bindingsHint') }}</n-text>
              <n-button size="small" type="primary" @click="openBindingModal">{{ t('pagesSettings.addBinding') }}</n-button>
            </n-space>
            <n-spin :show="bindingsLoading">
              <n-data-table :columns="bindingsColumns" :data="bindingsList" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 部署历史 -->
        <n-tab-pane name="pagesDeployments" :tab="t('pagesSettings.tabs.deployments')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('pagesSettings.deploymentsHint') }}</n-text>
              <n-space>
                <n-button size="small" @click="checkAllCurrentPage">{{ t('pagesSettings.selectAllPage') }}</n-button>
                <n-button size="small" @click="checkedDeploymentIds = []">{{ t('pagesSettings.deselectAll') }}</n-button>
                <n-button
                  size="small"
                  type="error"
                  :disabled="checkedDeploymentIds.length === 0 || batchDeleting"
                  :loading="batchDeleting"
                  @click="showBatchDeleteModal = true"
                >
                  {{ t('pagesSettings.deleteSelected', { count: checkedDeploymentIds.length }) }}
                </n-button>
                <n-button size="small" @click="loadPagesDeployments" :loading="pagesDeploymentsLoading">{{ t('common.refresh') }}</n-button>
              </n-space>
            </n-space>
            <n-spin :show="pagesDeploymentsLoading">
              <n-data-table
                :columns="pagesDeploymentColumns"
                :data="pagesDeployments"
                :bordered="false"
                size="small"
                :scroll-x="820"
                :pagination="pagesDeploymentPagination"
                :row-key="(row: any) => row.id"
                :checked-row-keys="checkedDeploymentIds"
                @update:checked-row-keys="handleCheckedKeysChange"
              />
            </n-spin>
          </n-space>
        </n-tab-pane>
      </n-tabs>
    </n-drawer-content>
  </n-drawer>

  <!-- Pages Domain Modal -->
  <n-modal v-model:show="showPagesDomainModal" preset="dialog" :title="t('pagesSettings.domainModalTitle')" style="width: 520px; max-width: 95vw">
    <n-form label-placement="left" label-width="80">
      <n-form-item :label="t('pagesSettings.domain')">
        <n-select
          v-model:value="pagesDomainHostname"
          :options="managedDomainOptions"
          filterable
          tag
          :placeholder="t('pagesSettings.domainPlaceholder')"
          :loading="managedDomainsLoading"
        />
      </n-form-item>
      <n-form-item v-if="isPagesZoneSelected" :label="t('pagesSettings.subdomain')">
        <n-input-group>
          <n-input v-model:value="pagesDomainSubdomain" :placeholder="t('pagesSettings.subdomainPlaceholder')" />
          <n-input :value="`.${pagesDomainHostname}`" disabled style="width: 40%" />
        </n-input-group>
      </n-form-item>
      <n-form-item v-if="composedPagesHostname" :label="t('pagesSettings.preview')">
        <n-tag type="info" size="large">{{ composedPagesHostname }}</n-tag>
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showPagesDomainModal = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="pagesDomainSaving" @click="handleAddPagesDomain">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <!-- Pages Env Var Modal -->
  <n-modal v-model:show="showPagesEnvModal" preset="dialog" :title="pagesEnvEditing ? t('pagesSettings.envModalTitleEdit') : t('pagesSettings.envModalTitleAdd')" style="width: 450px; max-width: 95vw">
    <n-form :model="pagesEnvForm" label-placement="left" label-width="80">
      <n-form-item :label="t('pagesSettings.varName')">
        <n-input v-model:value="pagesEnvForm.name" :placeholder="t('pagesSettings.varNamePlaceholder')" :disabled="pagesEnvEditing" />
      </n-form-item>
      <n-form-item :label="t('pagesSettings.varValue')">
        <n-input v-model:value="pagesEnvForm.value" :placeholder="t('pagesSettings.varValuePlaceholder')" />
      </n-form-item>
      <n-form-item :label="t('pagesSettings.varType')">
        <n-select v-model:value="pagesEnvForm.type" :options="envTypeOptions" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showPagesEnvModal = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="pagesEnvSaving" @click="handleAddPagesEnv">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <!-- Pages Binding Modal -->
  <n-modal v-model:show="showBindingModal" preset="dialog" :title="t('pagesSettings.bindingModalTitle')" style="width: 500px; max-width: 95vw">
    <n-form :model="bindingForm" label-placement="left" label-width="80">
      <n-form-item :label="t('pagesSettings.bindingType')">
        <n-select v-model:value="bindingForm.type" :options="bindingTypeOptions" @update:value="onBindingTypeChange" />
      </n-form-item>
      <n-form-item :label="t('pagesSettings.bindingName')">
        <n-input v-model:value="bindingForm.name" :placeholder="t('pagesSettings.bindingNamePlaceholder')" />
      </n-form-item>
      <n-form-item :label="t('pagesSettings.bindingResource')">
        <n-select v-model:value="bindingForm.value" :options="bindingResourceOptions" :loading="bindingResourcesLoading" filterable :placeholder="t('pagesSettings.bindingResourcePlaceholder')" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showBindingModal = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="bindingSaving" @click="handleAddBinding">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <!-- 批量删除 Pages 部署确认弹窗 -->
  <n-modal
    v-model:show="showBatchDeleteModal"
    preset="dialog"
    :title="t('pagesSettings.batchDeleteTitle')"
    :positive-text="t('common.delete')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ type: 'error' }"
    :loading="batchDeleting"
    @positive-click="handleBatchDeleteDeployments"
  >
    <n-space vertical>
      <div v-if="checkedProductionCount > 0" style="color: #d97706; font-weight: 500; padding: 8px 12px; background: #fef3c7; border-radius: 4px; border: 1px solid #fcd34d;">
        {{ t('pagesSettings.batchDeleteWarning', { count: checkedProductionCount }) }}
      </div>
      <div>{{ t('pagesSettings.batchDeleteConfirm', { count: checkedDeploymentIds.length }) }}</div>
    </n-space>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { confirmOperation } from '../utils/confirmOperation';
import { createRequestScope } from '../utils/requestScope';
import { useI18n } from 'vue-i18n';
import { NTag, NSpace, NButton, NA, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { workersApi } from '../api/workers';
import { formatCN } from '../utils/dateFormat';
import { isDemoAccount } from '../utils/demoAccounts';

const { t } = useI18n();

interface WorkerProp {
  name: string;
  cfAccountId: number;
  type: 'worker' | 'pages';
}

const props = defineProps<{ show: boolean; worker: WorkerProp | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();

const message = useMessage();

const visible = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
});
const workerName = computed(() => props.worker?.name || '');
const accountId = computed(() => props.worker?.cfAccountId || 0);
const requests = createRequestScope(() => `${props.show}:${accountId.value}:${workerName.value}`);

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}

// Pages Settings
const pagesProject = ref<any>(null);
const pagesProjectLoading = ref(false);
const pagesDomains = ref<any[]>([]);
const pagesDomainsLoading = ref(false);
const showPagesDomainModal = ref(false);
const pagesDomainHostname = ref('');
const pagesDomainSubdomain = ref('');
const pagesDomainSaving = ref(false);
const managedDomains = ref<any[]>([]);
const managedDomainsLoading = ref(false);
const managedDomainOptions = computed(() =>
  managedDomains.value.map((z: any) => ({ label: `${z.name} (${z.status})`, value: z.name }))
);
const isPagesZoneSelected = computed(() =>
  !!pagesDomainHostname.value && managedDomains.value.some((z: any) => z.name === pagesDomainHostname.value)
);
const composedPagesHostname = computed(() => {
  const zone = pagesDomainHostname.value;
  if (!zone) return '';
  const sub = pagesDomainSubdomain.value?.trim();
  return sub ? `${sub}.${zone}` : zone;
});
const pagesEnvVars = ref<any[]>([]);
const showPagesEnvModal = ref(false);
const pagesEnvEditing = ref(false);
const pagesEnvForm = ref({ name: '', value: '', type: 'plain_text' });
const pagesEnvSaving = ref(false);

const envTypeOptions = computed(() => [
  { label: t('pagesSettings.plainText'), value: 'plain_text' },
  { label: t('pagesSettings.secretText'), value: 'secret_text' },
]);

// ============ Pages Bindings ============
const bindingsLoading = ref(false);
const bindingsList = ref<any[]>([]);
const showBindingModal = ref(false);
const bindingSaving = ref(false);
const bindingForm = ref({ type: 'kv_namespaces', name: '', value: '' });
const bindingResources = ref<any[]>([]);
const bindingResourcesLoading = ref(false);
const r2Available = ref(true);
const bindingTypeOptions = computed(() => {
  const options = [
    { label: t('pagesSettings.bindingTypes.kv'), value: 'kv_namespaces' },
    { label: t('pagesSettings.bindingTypes.d1'), value: 'd1_databases' },
  ];
  if (r2Available.value) {
    options.push({ label: t('pagesSettings.bindingTypes.r2'), value: 'r2_buckets' });
  }
  return options;
});

const bindingResourceOptions = computed(() =>
  bindingResources.value.map((r: any) => ({
    label: r.title || r.name || r.id,
    value: bindingForm.value.type === 'kv_namespaces' ? r.id : bindingForm.value.type === 'd1_databases' ? r.uuid || r.id : r.name,
  }))
);

function parseBindings(configs: any): any[] {
  if (!configs) return [];
  const production = configs.production || {};
  const list: any[] = [];
  const typeLabels: Record<string, string> = { kv_namespaces: 'KV', d1_databases: 'D1', r2_buckets: 'R2', services: 'Service', queue_producers: 'Queue', durable_object_namespaces: 'DO', browsers: 'Browser', analytics_engine_datasets: 'Analytics' };
  for (const [typeKey, label] of Object.entries(typeLabels)) {
    const bindings = production[typeKey];
    if (!bindings) continue;
    if (Array.isArray(bindings)) {
      for (const item of bindings) {
        const name = item.name || item.binding || '';
        const value = item.namespace_id || item.id || item.bucket_name || item.dataset || item.service || JSON.stringify(item);
        list.push({ type: label, typeKey, name, value });
      }
    } else if (typeof bindings === 'object') {
      for (const [name, val] of Object.entries(bindings as Record<string, any>)) {
        const value = val?.namespace_id || val?.id || val?.name || val?.dataset || val?.service || JSON.stringify(val);
        list.push({ type: label, typeKey, name, value });
      }
    }
  }
  return list;
}

// Resource name lookup map (id -> name)
const resourceNameMap = ref<Record<string, string>>({});

async function buildResourceNameMap() {
  const map: Record<string, string> = {};
  const request = requests.begin('buildResourceNameMap');
  try {
    const promises = [
      workersApi.getKvNamespaces(accountId.value).catch(() => null),
      workersApi.getD1Databases(accountId.value).catch(() => null),
    ];
    if (r2Available.value) {
      promises.push(workersApi.getR2Buckets(accountId.value, { _silent: true } as any).catch((err: any) => {
        const msg = err?.response?.data?.error?.message || err?.message || '';
        if (msg.includes('10042') || msg.includes('Please enable R2')) {
          r2Available.value = false;
        }
        return null;
      }));
    } else {
      promises.push(Promise.resolve(null));
    }
    const [kvResp, d1Resp, r2Resp] = await Promise.all(promises);
    const kvList = Array.isArray(kvResp?.data) ? kvResp.data : [];
    const d1List = Array.isArray(d1Resp?.data) ? d1Resp.data : [];
    const r2List = Array.isArray(r2Resp?.data) ? r2Resp.data : [];
    for (const ns of kvList) { if (ns.id) map[ns.id] = ns.title || ns.id; }
    for (const db of d1List) { const key = db.uuid || db.id; if (key) map[key] = db.name || key; }
    for (const b of r2List) { if (b.name) map[b.name] = b.name; }
  } catch { if (!request.current()) return;
    resourceNameMap.value = {};
    return;
  }
  if (request.current()) resourceNameMap.value = map;
}

function resolveResourceName(id: string): { id: string; name: string } {
  return { id, name: resourceNameMap.value[id] || '' };
}

async function loadBindings() {
  bindingsLoading.value = true;
  const request = requests.begin('loadBindings');
  try {
    const [{ data }, _] = await Promise.all([
      workersApi.getPagesProject(accountId.value, workerName.value),
      buildResourceNameMap(),
    ]);
    if (!request.current()) return;
    bindingsList.value = parseBindings(data?.deployment_configs);
  } catch (e) {
    if (!request.current()) return;
    message.error((e as { errorMessage?: string; message?: string }).errorMessage || t('common.networkError'));
    bindingsList.value = [];
  }
  finally { if (request.current()) bindingsLoading.value = false; }
}

async function openBindingModal() {
  bindingForm.value = { type: 'kv_namespaces', name: '', value: '' };
  showBindingModal.value = true;
  await loadBindingResources('kv_namespaces');
}

async function onBindingTypeChange(type: string) {
  bindingForm.value.value = '';
  if (type === 'r2_buckets' && !r2Available.value) {
    message.warning(t('pagesSettings.msg.r2NotEnabled'));
    bindingForm.value.type = 'kv_namespaces';
    return;
  }
  await loadBindingResources(type);
}

async function loadBindingResources(type: string) {
  bindingResourcesLoading.value = true;
  bindingResources.value = [];
  const request = requests.begin('loadBindingResources', () => `${props.show}:${accountId.value}:${workerName.value}:${bindingForm.value.type}`);
  try {
    let resp: any;
    if (type === 'kv_namespaces') resp = await workersApi.getKvNamespaces(accountId.value);
    else if (type === 'd1_databases') resp = await workersApi.getD1Databases(accountId.value);
    else if (type === 'r2_buckets') {
      resp = await workersApi.getR2Buckets(accountId.value, { _silent: true } as any);
    }
    if (!request.current()) return;
    bindingResources.value = Array.isArray(resp?.data) ? resp.data : [];
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.message || '';
    if (type === 'r2_buckets' && (msg.includes('10042') || msg.includes('Please enable R2'))) {
      message.warning(t('pagesSettings.msg.r2NotEnabled'));
      r2Available.value = false;
    }
    if (!request.current()) return;
    bindingResources.value = [];
  }
  finally { if (request.current()) bindingResourcesLoading.value = false; }
}

async function handleAddBinding() {
  if (!bindingForm.value.name) { message.warning(t('pagesSettings.msg.varNameRequired')); return; }
  if (!bindingForm.value.value) { message.warning(t('pagesSettings.msg.resourceRequired')); return; }
  bindingSaving.value = true;
  try {
    const { data } = await workersApi.getPagesProject(accountId.value, workerName.value);
    const configs = data?.deployment_configs || {};
    const production = configs.production || {};
    const existing = production[bindingForm.value.type] || {};
    const type = bindingForm.value.type;
    let bindingValue: any;
    if (type === 'kv_namespaces') bindingValue = { namespace_id: bindingForm.value.value };
    else if (type === 'd1_databases') bindingValue = { id: bindingForm.value.value };
    else if (type === 'r2_buckets') bindingValue = { name: bindingForm.value.value };
    const updated = { ...existing, [bindingForm.value.name]: bindingValue };
    const preview = configs.preview || {};
    await workersApi.updatePagesBindings(accountId.value, workerName.value, {
      production: { ...production, [type]: updated },
      preview: { ...preview, [type]: updated },
    });
    message.success(t('pagesSettings.msg.bindingAdded'));
    showBindingModal.value = false;
    loadBindings();
  } finally { bindingSaving.value = false; }
}

async function handleDeleteBinding(row: any) {
  const request = requests.begin('handleDeleteBinding');
  if (!await confirmOperation(t('common.delete'), row.name || row.hostname || row.pattern || row.id, `Account ${accountId.value} / ${workerName.value}`)) return;
  if (!request.current()) return;
  const { data } = await workersApi.getPagesProject(accountId.value, workerName.value);
  const configs = data?.deployment_configs || {};
  const production = configs.production || {};
  const existing = { ...(production[row.typeKey] || {}) };
  delete existing[row.name];
  const preview = configs.preview || {};
  const val = Object.keys(existing).length > 0 ? existing : null;
  await workersApi.updatePagesBindings(accountId.value, workerName.value, {
    production: { ...production, [row.typeKey]: val },
    preview: { ...preview, [row.typeKey]: val },
  });
  message.success(t('pagesSettings.msg.bindingDeleted'));
  loadBindings();
}
const pagesDeployments = ref<any[]>([]);
const pagesDeploymentsLoading = ref(false);
const checkedDeploymentIds = ref<string[]>([]);
const batchDeleting = ref(false);
const showBatchDeleteModal = ref(false);

// 部署历史表格分页：默认每页 10 条，支持切换页长方便全选批量删除
const pagesDeploymentPagination = ref<{ page: number; pageSize: number; pageSizes: number[]; showSizePicker: boolean }>({
  page: 1,
  pageSize: 10,
  pageSizes: [10, 20, 50, 100, 200],
  showSizePicker: true,
});

// 当前页选中的生产环境部署数量（用于警告显示）
const checkedProductionCount = computed(() => {
  const checked = pagesDeployments.value.filter(d => checkedDeploymentIds.value.includes(d.id));
  return checked.filter(d => d.environment === 'production').length;
});

async function checkR2Availability() {
  try {
    const { data } = await workersApi.getR2Buckets(accountId.value, { _silent: true });
    if (data?.r2_not_enabled) {
      r2Available.value = false;
    } else {
      r2Available.value = true;
    }
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.errorMessage || err?.message || '';
    if (msg.includes('10042') || msg.includes('enable R2') || msg.includes('R2_NOT_ENABLED')) {
      r2Available.value = false;
    } else {
      r2Available.value = true;
    }
  }
}

async function loadPagesProject() {
  pagesProjectLoading.value = true;
  const request = requests.begin('loadPagesProject');
  try {
    const { data } = await workersApi.getPagesProject(accountId.value, workerName.value);
    if (!request.current()) return;
    pagesProject.value = data;
    const envVars = data?.deployment_configs?.production?.env_vars || {};
    pagesEnvVars.value = Object.entries(envVars).map(([key, val]: [string, any]) => ({
      name: key,
      type: val?.type || 'plain_text',
      value: val?.type === 'plain_text' ? val?.value : '******',
    }));
  } catch { if (!request.current()) return; pagesProject.value = null; pagesEnvVars.value = []; }
  finally { if (request.current()) pagesProjectLoading.value = false; }
}

async function loadPagesDomains() {
  pagesDomainsLoading.value = true;
  const request = requests.begin('loadPagesDomains');
  try {
    const { data } = await workersApi.getPagesDomains(accountId.value, workerName.value);
    if (!request.current()) return;
    pagesDomains.value = Array.isArray(data) ? data : [];
  } catch { if (!request.current()) return; pagesDomains.value = []; }
  finally { if (request.current()) pagesDomainsLoading.value = false; }
}

async function openPagesDomainModal() {
  pagesDomainHostname.value = '';
  pagesDomainSubdomain.value = '';
  showPagesDomainModal.value = true;
  managedDomainsLoading.value = true;
  const request = requests.begin('openPagesDomainModal');
  try {
    const { data } = await workersApi.getZones(accountId.value);
    if (!request.current()) return;
    managedDomains.value = Array.isArray(data) ? data : [];
  } catch { if (!request.current()) return; managedDomains.value = []; }
  finally { if (request.current()) managedDomainsLoading.value = false; }
}

async function handleAddPagesDomain() {
  if (!composedPagesHostname.value) { message.warning(t('pagesSettings.msg.domainRequired')); return; }
  pagesDomainSaving.value = true;
  try {
    await workersApi.addPagesDomain(accountId.value, workerName.value, composedPagesHostname.value);
    message.success(t('pagesSettings.msg.domainAdded'));
    showPagesDomainModal.value = false;
    pagesDomainHostname.value = '';
    pagesDomainSubdomain.value = '';
    loadPagesDomains();
  } finally { pagesDomainSaving.value = false; }
}

async function handleRemovePagesDomain(row: any) {
  const request = requests.begin('handleRemovePagesDomain');
  if (!await confirmOperation(t('common.delete'), row.name || row.hostname || row.pattern || row.id, `Account ${accountId.value} / ${workerName.value}`)) return;
  if (!request.current()) return;
  await workersApi.removePagesDomain(accountId.value, workerName.value, row.name || row.hostname);
  message.success(t('pagesSettings.msg.domainDeleted'));
  loadPagesDomains();
}

async function handleAddPagesEnv() {
  if (!pagesEnvForm.value.name) { message.warning(t('pagesSettings.msg.nameRequired')); return; }
  pagesEnvSaving.value = true;
  try {
    const existingProd = pagesProject.value?.deployment_configs?.production || {};
    const existingPreview = pagesProject.value?.deployment_configs?.preview || {};
    const envVars = { ...(existingProd.env_vars || {}) };
    envVars[pagesEnvForm.value.name] = { type: pagesEnvForm.value.type, value: pagesEnvForm.value.value };
    await workersApi.editPagesProject(accountId.value, workerName.value, {
      deployment_configs: {
        production: { ...existingProd, env_vars: envVars },
        preview: { ...existingPreview, env_vars: envVars },
      },
    });
    message.success(t('pagesSettings.msg.varSaved'));
    showPagesEnvModal.value = false;
    pagesEnvForm.value = { name: '', value: '', type: 'plain_text' };
    loadPagesProject();
  } finally { pagesEnvSaving.value = false; }
}

function handleEditPagesEnv(row: any) {
  pagesEnvEditing.value = true;
  pagesEnvForm.value = { name: row.name, value: row.type === 'secret_text' ? '' : (row.value || ''), type: row.type || 'plain_text' };
  showPagesEnvModal.value = true;
}

async function handleDeletePagesEnv(row: any) {
  const request = requests.begin('handleDeletePagesEnv');
  if (!await confirmOperation(t('common.delete'), row.name || row.hostname || row.pattern || row.id, `Account ${accountId.value} / ${workerName.value}`)) return;
  if (!request.current()) return;
  try {
    // CF PATCH deployment_configs.env_vars 是 merge 语义：
    // - {key: null} → 删除该键（实测确认）
    // - omit 键 → 保留；空对象 {} → 被 CF 忽略（均无法删除）
    await workersApi.editPagesProject(accountId.value, workerName.value, {
      deployment_configs: {
        production: { env_vars: { [row.name]: null } },
        preview: { env_vars: { [row.name]: null } },
      },
    });
    message.success(t('pagesSettings.msg.varDeleted'));
    loadPagesProject();
  } catch (e: any) { message.error(e?.errorMessage || e?.message || t('pagesSettings.msg.deleteFailed')); }
}

async function loadPagesDeployments() {
  pagesDeploymentsLoading.value = true;
  const request = requests.begin('loadPagesDeployments');
  try {
    const { data } = await workersApi.getPagesDeployments(accountId.value, workerName.value);
    if (!request.current()) return;
    pagesDeployments.value = Array.isArray(data) ? data : [];
  } catch { if (!request.current()) return; pagesDeployments.value = []; }
  finally {
    if (request.current()) pagesDeploymentsLoading.value = false;
    if (request.current()) checkedDeploymentIds.value = [];
  }
}

function handleCheckedKeysChange(keys: string[]) {
  checkedDeploymentIds.value = keys;
}

// 全选当前页（仅勾选 data-table 当前分页展示的记录）
function checkAllCurrentPage() {
  const { page, pageSize } = pagesDeploymentPagination.value;
  checkedDeploymentIds.value = pagesDeployments.value.slice((page - 1) * pageSize, page * pageSize).map(d => d.id);
}

async function handleBatchDeleteDeployments() {
  const idsToDelete = [...checkedDeploymentIds.value];
  if (idsToDelete.length === 0) return;

  batchDeleting.value = true;
  try {
    const { data } = await workersApi.deletePagesDeployments(accountId.value, workerName.value, idsToDelete);
    const succeeded = data?.succeeded ?? 0;
    const failed = data?.failed ?? 0;
    const results: Array<{ id: string; success: boolean; error?: string }> = data?.results ?? [];

    if (succeeded === 0) {
      // 全部失败：展示第一条错误信息
      const firstErr = results.find(r => r.error)?.error || '';
      message.error(t('pagesSettings.msg.batchDeleteAllFailed', { error: firstErr }));
    } else if (failed > 0) {
      // 部分失败：展示错误提示
      const failedErrors = results.filter(r => !r.success).map(r => r.error).filter(Boolean);
      const firstErr = failedErrors[0] || '';
      message.warning(t('pagesSettings.msg.batchDeletePartial', { succeeded, failed, error: firstErr }));
    } else {
      message.success(t('pagesSettings.msg.batchDeleteSuccess', { count: succeeded }));
    }

    // 关闭弹窗并刷新列表
    showBatchDeleteModal.value = false;
    await loadPagesDeployments();
  } catch (e: any) {
    const errMsg = e?.errorMessage || e?.message || t('pagesSettings.msg.batchDeleteFailed');
    message.error(errMsg);
  } finally {
    batchDeleting.value = false;
  }
}

// Columns
const pagesDomainColumns = computed<DataTableColumns<any>>(() => [
  {
    title: t('pagesSettings.domain'), key: 'name', minWidth: 180, ellipsis: { tooltip: true },
    render: (row) => h(NA, { href: `https://${row.name}`, target: '_blank', type: 'primary' }, { default: () => row.name }),
  },
  { title: t('common.status'), key: 'status', width: 100, render: (row) => h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'warning' }, { default: () => row.status || '-' }) },
  {
    title: t('common.actions'), key: 'actions', width: 80,
    render: (row) => isDemoAccount(accountId.value)
      ? null
      : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleRemovePagesDomain(row) }, { default: () => t('common.delete') }),
  },
]);

const pagesEnvColumns = computed<DataTableColumns<any>>(() => [
  { title: t('pagesSettings.varName'), key: 'name', width: 120 },
  { title: t('pagesSettings.varType'), key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.type === 'secret_text' ? 'warning' : 'default' }, { default: () => row.type === 'secret_text' ? t('pagesSettings.secretText') : t('pagesSettings.plainText') }) },
  { title: t('pagesSettings.varValue'), key: 'value', minWidth: 120, ellipsis: true },
  { title: t('common.actions'), key: 'actions', width: 140, render: (row) => h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => handleEditPagesEnv(row) }, { default: () => t('common.edit') }),
      ...(isDemoAccount(accountId.value) ? [] : [
        h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeletePagesEnv(row) }, { default: () => t('common.delete') }),
      ]),
    ],
  }) },
]);

const bindingsColumns = computed<DataTableColumns<any>>(() => [
  { title: t('pagesSettings.bindingType'), key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.typeKey === 'kv_namespaces' ? 'info' : row.typeKey === 'd1_databases' ? 'warning' : 'success' }, { default: () => row.type }) },
  { title: t('pagesSettings.bindingName'), key: 'name', width: 120 },
  { title: t('pagesSettings.bindingResource'), key: 'value', minWidth: 150, ellipsis: true, render: (row) => {
    const resolved = resolveResourceName(row.value);
    return resolved.name
      ? h(NSpace, { size: 'small', align: 'center' }, { default: () => [h('span', null, resolved.name), h(NTag, { size: 'tiny', type: 'default', style: 'opacity: 0.6' }, { default: () => resolved.id })] })
      : h('span', null, resolved.id);
  }},
  { title: t('common.actions'), key: 'actions', width: 80, render: (row) => isDemoAccount(accountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteBinding(row) }, { default: () => t('common.delete') }) },
]);

const pagesDeploymentColumns = computed<DataTableColumns<any>>(() => [
  { type: 'selection' as any },
  { title: 'ID', key: 'id', width: 90, ellipsis: true },
  { title: t('pagesSettings.status'), key: 'environment', width: 90, render: (row) => h(NTag, { size: 'small', type: row.environment === 'production' ? 'success' : 'info' }, { default: () => row.environment || '-' }) },
  { title: t('pagesSettings.status'), key: 'status', width: 80, render: (row) => h(NTag, { size: 'small', type: row.latest_stage?.status === 'success' ? 'success' : row.latest_stage?.status === 'failure' ? 'error' : 'default' }, { default: () => row.latest_stage?.status || '-' }) },
  { title: t('pagesSettings.stage'), key: 'stage', width: 80, render: (row) => row.latest_stage?.name || '-' },
  { title: 'URL', key: 'url', minWidth: 200, render: (row) => row.url ? h('a', { href: row.url, target: '_blank', style: 'word-break: break-all; font-size: 12px;' }, row.url) : '-' },
  { title: t('pagesSettings.createdTime'), key: 'created_on', width: 200, render: (row) => row.created_on ? formatCN(row.created_on) : '-' },
]);

// 打开抽屉时加载数据
watch(
  () => [props.show, props.worker?.name, props.worker?.cfAccountId] as const,
  () => {
    requests.invalidate();
    if (props.show && props.worker) {
      loadPagesProject();
      loadPagesDomains();
      loadPagesDeployments();
      checkR2Availability();
      loadBindings();
    }
  },
  { immediate: true },
);
</script>
