<template>
  <div class="page-view">
    <n-space justify="space-between" align="center" :wrap="true" style="margin-bottom: 16px">
      <n-h2 style="margin: 0">{{ t('workers.title') }}</n-h2>
      <n-space :size="8">
        <n-button size="small" type="primary" @click="openDeploy(null)" :disabled="!allAccounts.length">{{ t('workers.deploy') }}</n-button>
      </n-space>
    </n-space>

    <!-- 账户卡片：只显示有部署数量的账户，悬停显示用量详情，点击切换加载 -->
    <div class="card-grid-scroll" style="width: 100%">
      <n-grid v-if="accountCards.length" :x-gap="10" :y-gap="10" cols="1 s:2 m:4 l:6 xl:8" responsive="screen" style="width: 100%">
        <n-gi v-for="c in accountCards" :key="c.accountId">
          <n-popover trigger="hover" placement="bottom" style="display: block; width: 100%;">
            <template #trigger>
              <div
                class="worker-compact-card"
                :class="{ 'worker-compact-card--active': c.accountId === workerStore.selectedAccountId }"
                @click="selectAccount(c.accountId)"
              >
                <span class="worker-compact-card__name" :title="c.accountName">{{ c.accountName }}</span>
                <n-progress
                  type="line"
                  :percentage="calcUsagePercentage(c)"
                  :height="6"
                  :show-indicator="false"
                  :status="calcUsagePercentage(c) > 90 ? 'error' : calcUsagePercentage(c) > 70 ? 'warning' : 'success'"
                  :style="{ flex: '1 1 0', minWidth: '24px', overflow: 'hidden' }"
                />
                <span class="worker-compact-card__metric">{{ formatNumber(c.requests) }}</span>
                <span class="worker-compact-card__count">{{ c.workerCount + c.pagesCount }}</span>
              </div>
            </template>
            <div style="min-width: 220px; padding: 4px 0;">
              <div style="font-weight: bold; margin-bottom: 10px;">{{ c.accountName }}</div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                <span>{{ t('workers.table.deployCount') }}</span><span>{{ c.workerCount }}W · {{ c.pagesCount }}P（{{ c.workerCount + c.pagesCount }}）</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                <span>{{ t('workers.table.requests') }}</span><span>{{ formatNumber(c.requests) }} / 100,000</span>
              </div>
              <n-progress type="line" :percentage="calcUsagePercentage(c)" :height="12" :show-indicator="false"
                :status="calcUsagePercentage(c) > 90 ? 'error' : calcUsagePercentage(c) > 70 ? 'warning' : 'success'" style="margin-bottom: 10px;" />
              <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
                <span>{{ t('workers.table.errors') }}</span><span>{{ formatNumber(c.errors) }}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
                <span>{{ t('workers.table.cpuTime') }}</span><span>{{ formatCpuTime(c.cpuTimeMs) }}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span>{{ t('workers.table.subrequests') }}</span><span>{{ formatNumber(c.subrequests) }}</span>
              </div>
            </div>
          </n-popover>
        </n-gi>
      </n-grid>
      <n-empty v-else :description="t('workers.noAccounts')" />
    </div>

    <AutoFitTable
      :columns="columns"
      :data="workerStore.workers"
      :row-key="(row: any) => `${row.cfAccountId}:${row.type}:${row.id || row.name}`"
      :loading="workerStore.loading"
      :scroll-x="700"
      :pagination="false"
      style="margin-top: 0"
    >
      <!-- 底部统计栏整合进 AutoFitTable 的 footer 插槽 -->
      <template #footer>
        <n-space align="center" :size="16">
          <n-text depth="3" style="font-size: 12px">
            {{ t('workers.totalDeployments', { count: workerStore.workers.length }) }}
          </n-text>
          <n-text depth="3" style="font-size: 12px">·</n-text>
          <n-space align="center" :size="4">
            <span class="status-dot status-dot--worker" />
            <n-text depth="3" style="font-size: 12px">Worker {{ workerCount }}</n-text>
          </n-space>
          <n-space align="center" :size="4">
            <span class="status-dot status-dot--pages" />
            <n-text depth="3" style="font-size: 12px">Pages {{ pagesCount }}</n-text>
          </n-space>
          <template v-if="workerStore.selectedAccountId">
            <n-text depth="3" style="font-size: 12px">·</n-text>
            <n-text depth="3" style="font-size: 12px">{{ t('workers.currentAccount', { name: selectedAccountName }) }}</n-text>
          </template>
        </n-space>
      </template>
    </AutoFitTable>

    <!-- 日志 Drawer -->
    <n-drawer v-model:show="showLogDrawer" :width="drawerWidth(520)" placement="right">
      <n-drawer-content :title="t('workers.logDrawerTitle', { name: currentWorkerName })" closable>
        <n-code :code="logContent" language="text" :word-wrap="true" />
        <n-empty v-if="!logContent && !logLoading" :description="t('workers.noLogs')" />
        <n-spin v-if="logLoading" style="display: block; text-align: center; margin: 40px auto" />
      </n-drawer-content>
    </n-drawer>

    <!-- 设置抽屉（Worker / Pages 拆分到子组件） -->
    <WorkerSettingsDrawer
      v-if="settingsWorker && settingsWorker.type === 'worker'"
      :key="`${settingsWorker.cfAccountId}:${settingsWorker.name}`"
      v-model:show="showSettingsDrawer"
      :worker="settingsWorker"
    />
    <WorkerPagesSettingsDrawer
      v-else-if="settingsWorker && settingsWorker.type === 'pages'"
      :key="`${settingsWorker.cfAccountId}:${settingsWorker.name}`"
      v-model:show="showSettingsDrawer"
      :worker="settingsWorker"
    />

    <!-- 统一部署对话框（单/批量共用；redeploy 预填） -->
    <DeployDialog
      :show="showDeployDialog"
      :redeploy="redeployTarget"
      :all-accounts="allAccounts"
      @update:show="showDeployDialog = $event"
      @deployed="onDeployed"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { NButton, NSpace, NTag, useMessage, NPopconfirm } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useWorkerStore } from '../stores/workerStore';
import { accountsApi } from '../api/accounts';
import { workersApi } from '../api/workers';
import { formatCN } from '../utils/dateFormat';
import { loadDemoAccounts, isDemoAccount } from '../utils/demoAccounts';
import WorkerSettingsDrawer from '../components/WorkerSettingsDrawer.vue';
import WorkerPagesSettingsDrawer from '../components/WorkerPagesSettingsDrawer.vue';
import DeployDialog from '../components/DeployDialog.vue';
import AutoFitTable from '../components/AutoFitTable.vue';

const { t } = useI18n();
const workerStore = useWorkerStore();
const message = useMessage();

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}

// ============ 账户卡片（显示所有启用 workers 功能的账户，统计常驻可见） ============
const accountCards = computed(() => workerStore.summary || []);

// 底部统计：Worker / Pages 数量
const workerCount = computed(() => workerStore.workers.filter((w: any) => w.type === 'worker').length);
const pagesCount = computed(() => workerStore.workers.filter((w: any) => w.type === 'pages').length);
const selectedAccountName = computed(() => {
  if (!workerStore.selectedAccountId) return '';
  const acc = accountCards.value.find((c: any) => c.accountId === workerStore.selectedAccountId);
  return acc?.accountName || '';
});

function selectAccount(accountId: number) {
  workerStore.selectedAccountId = accountId;
  workerStore.fetchWorkers(accountId);
}
const FREE_DAILY_LIMIT = 100000;

function calcUsagePercentage(u: { requests: number }) {
  return Math.min(100, Math.round((u.requests / FREE_DAILY_LIMIT) * 100));
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCpuTime(ms: number): string {
  if (!ms) return '0ms';
  if (ms >= 1000000) return (ms / 1000000).toFixed(1) + 'Ks';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms.toLocaleString() + 'ms';
}

// 统一部署对话框状态（单/批量共用）
const showDeployDialog = ref(false);
const redeployTarget = ref<{ type: 'worker' | 'pages'; name: string; accountId: number } | null>(null);
const showLogDrawer = ref(false);
const logContent = ref('');
const logLoading = ref(false);
const currentWorkerName = ref('');

// 设置抽屉（具体逻辑拆分到 WorkerSettingsDrawer / WorkerPagesSettingsDrawer 子组件）
const settingsWorker = ref<any>(null);
const showSettingsDrawer = ref(false);
function openSettings(row: any) {
  settingsWorker.value = row;
  showSettingsDrawer.value = true;
}

// 部署对话框需要全部账户（不分页），accountStore.accounts 仅含当前页
const allAccounts = ref<any[]>([]);
async function loadAllAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    allAccounts.value = data.accounts || [];
  } catch { allAccounts.value = []; }
}

// ============ Deploy ============
function openDeploy(row: any | null) {
  redeployTarget.value = row ? { type: row.type, name: row.name, accountId: row.cfAccountId } : null;
  showDeployDialog.value = true;
}
function onDeployed() {
  // 部署后只刷新当前选中账户，不加载全部
  if (workerStore.selectedAccountId) {
    workerStore.fetchWorkers(workerStore.selectedAccountId);
  } else {
    workerStore.fetchWorkers();
  }
  // 刷新摘要（用量+数量）
  workerStore.fetchSummary();
}

// ============ Logs ============
async function handleViewLogs(row: any) {
  currentWorkerName.value = row.name;
  showLogDrawer.value = true;
  logLoading.value = true;
  logContent.value = '';
  try {
    const { data } = await workersApi.getLogs(row.cfAccountId || row.account_id, row.name);
    logContent.value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (e: any) {
    logContent.value = t('workers.getLogFailed', { error: e?.errorMessage || e?.message || t('common.unknown') });
  } finally { logLoading.value = false; }
}

// ============ Delete ============
async function handleDelete(row: any) {
  if (row.type === 'pages') await workersApi.deletePages(row.cfAccountId, row.name);
  else await workersApi.delete(row.cfAccountId, row.name);
  message.success(row.type === 'pages' ? t('workers.msg.pagesDeleted') : t('workers.msg.workerDeleted'));
  // 删除后只刷新当前选中账户，不加载全部
  if (workerStore.selectedAccountId) {
    workerStore.fetchWorkers(workerStore.selectedAccountId);
  } else {
    workerStore.fetchWorkers();
  }
  // 刷新摘要（数量会变化）
  workerStore.fetchSummary();
}

// ============ Table Columns ============
const columns = computed<DataTableColumns<any>>(() => {
  const hasModifiedOn = workerStore.workers.some((w: any) => w.modified_on || w.created_on);
  const cols: DataTableColumns<any> = [
    { title: t('workers.table.type'), key: 'type', width: 80, render: (row) => h(NTag, { size: 'small', type: row.type === 'pages' ? 'info' : 'success' }, { default: () => row.type === 'pages' ? 'Pages' : 'Worker' }) },
    { title: t('workers.table.name'), key: 'name', width: 180 },
    { title: t('workers.table.account'), key: 'accountName', width: 120, render: (row) => row.accountName || row.cfAccountId },
    { title: t('workers.table.status'), key: 'status', width: 100, render: (row) => {
      // 统一状态文案：Worker 的 deployed/enabled 和 Pages 的 active 都显示为「活跃」
      const rawStatus = row.status || (row.type === 'pages' ? 'active' : 'deployed');
      const isActive = ['active', 'deployed', 'enabled'].includes(rawStatus);
      return h(NTag, { size: 'small', type: isActive ? 'success' : 'default' }, { default: () => isActive ? t('workers.table.active') : rawStatus });
    } },
  ];
  if (hasModifiedOn) {
    cols.push({ title: t('workers.table.modifiedTime'), key: 'modified_on', width: 180, render: (row) => {
      const time = row.modified_on || row.created_on;
      return time ? formatCN(time) : '-';
    } });
  }
  cols.push({
    title: t('workers.table.actions'), key: 'actions', width: 280,
    render: (row) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'small', type: 'success', onClick: () => openDeploy(row) }, { default: () => t('workers.table.deployBtn') }),
        h(NButton, { size: 'small', onClick: () => openSettings(row) }, { default: () => t('workers.table.settingsBtn') }),
        ...(row.type === 'worker' ? [
          h(NButton, { size: 'small', onClick: () => handleViewLogs(row) }, { default: () => t('workers.table.logsBtn') }),
        ] : []),
        ...(isDemoAccount(row.cfAccountId) ? [] : [
          h(NPopconfirm, {
            positiveText: t('common.delete'),
            negativeText: t('common.cancel'),
            positiveButtonProps: { type: 'error' },
            onPositiveClick: () => handleDelete(row),
          }, {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => t('workers.table.deleteBtn') }),
            default: () => t('workers.table.deleteConfirm', { type: row.type === 'pages' ? 'Pages' : 'Worker', name: row.name }),
          }),
        ]),
      ],
    }),
  });
  return cols;
});

onMounted(async () => {
  await loadDemoAccounts();
  loadAllAccounts();
  await workerStore.fetchSummary();
  const list = workerStore.summary || [];
  // 默认优先加载第一个有部署数量的账户；都没有则加载第一个账户；若没有任何账户则加载全部
  const firstDeployed = list.find((c: any) => (c.workerCount || 0) + (c.pagesCount || 0) > 0);
  if (firstDeployed) selectAccount(firstDeployed.accountId);
  else if (list.length) selectAccount(list[0].accountId);
  else workerStore.fetchWorkers();
});
</script>

<style scoped>
.worker-compact-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--app-border-input);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
  background-color: var(--app-bg-card);
  box-sizing: border-box;
}
.worker-compact-card:hover { background-color: var(--app-bg-hover); }
.worker-compact-card__count {
  font-size: 11px;
  color: var(--app-text-tertiary);
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
}
.worker-compact-card--active {
  /* 半透明蓝色在明暗模式下都能良好显示 */
  background-color: rgba(64, 152, 252, 0.12);
  border-color: #4098fc;
}
.worker-compact-card--active:hover {
  background-color: rgba(64, 152, 252, 0.18);
}
.worker-compact-card__name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}
.worker-compact-card__metric {
  font-size: 12px;
  color: var(--app-text-primary);
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
  min-width: 32px;
  text-align: right;
}

.table-scroll-wrapper {
  flex: 1;
  min-height: 0;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
}

/* 底部统计栏 */
.table-footer-bar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--app-border-input);
  background-color: var(--app-bg-card);
  border-radius: 0 0 6px 6px;
  min-height: 36px;
}

/* 状态圆点 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--worker {
  background-color: var(--theme-success);
}
.status-dot--pages {
  background-color: var(--theme-info);
}

.card-grid-scroll {
  max-height: 200px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
  .worker-compact-card {
    width: 100%;
    min-width: 100px;
  }
  .worker-compact-card__name {
    min-width: 0;
  }
  .worker-compact-card__metric {
    font-size: 10px;
  }
}
</style>
