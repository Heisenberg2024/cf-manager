<template>
  <div class="page-view">
    <n-h2>{{ t('settings.title') }}</n-h2>

    <n-card :title="t('settings.configStatus')" size="small" style="margin-bottom: 16px">
      <n-spin :show="loading">
        <n-descriptions :column="1" bordered label-placement="left">
          <n-descriptions-item :label="t('settings.encryptionKey')">
            <n-tag :type="settings.encryption_key_configured ? 'success' : 'error'" size="small">
              {{ settings.encryption_key_configured ? t('common.configured') : t('common.notConfigured') }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item :label="t('settings.apiSecret')">
            <n-tag :type="settings.api_secret_configured ? 'success' : 'error'" size="small">
              {{ settings.api_secret_configured ? t('common.configured') : t('common.notConfigured') }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item :label="t('settings.demoAccounts')">
            <n-text v-if="settings.demo_account_ids">{{ settings.demo_account_ids }}</n-text>
            <n-tag v-else size="small" type="default">{{ t('common.notConfigured') }}</n-tag>
          </n-descriptions-item>
          <n-descriptions-item :label="t('settings.dbPath')">
            <n-text>{{ settings.db_path || '-' }}</n-text>
          </n-descriptions-item>
          <n-descriptions-item :label="t('settings.version')">
            <n-text v-if="settings.version">v{{ settings.version }}<n-text v-if="settings.git_commit" depth="3" style="margin-left: 8px; font-size: 12px">{{ settings.git_commit }}</n-text></n-text>
            <n-tag v-else size="small" type="default">{{ t('settings.unknown') }}</n-tag>
          </n-descriptions-item>
        </n-descriptions>
      </n-spin>
    </n-card>

    <n-card v-if="!isWorkerPlatform" :title="t('settings.proxySettings')" size="small" style="margin-bottom: 16px">
      <n-space vertical size="large">
        <!-- 优先级说明 -->
        <n-alert type="info" :bordered="false" style="font-size: 12px">
          {{ t('settings.proxyPriority') }}
        </n-alert>

        <!-- 全局代理 -->
        <div>
          <n-space align="center" style="margin-bottom: 12px">
            <n-switch :value="proxyEnabled" @update:value="toggleProxy" :loading="proxyToggling" size="small" />
            <n-text strong :depth="proxyEnabled ? 1 : 3">{{ t('settings.globalProxy') }}</n-text>
            <n-text depth="3" style="font-size: 12px">{{ proxyEnabled ? t('common.enabled') : t('common.disabled') }}</n-text>
          </n-space>
          <n-input-group>
            <n-input v-model:value="proxyUrl" :placeholder="t('settings.proxyUrlPlaceholder')" clearable style="flex: 1" />
            <n-button type="info" :loading="proxyTesting" :disabled="!proxyUrl" @click="testProxy">{{ t('settings.test') }}</n-button>
            <n-button type="primary" :loading="proxySaving" @click="saveProxy">{{ t('common.save') }}</n-button>
          </n-input-group>
          <n-text depth="3" style="font-size: 12px; display: block; margin-top: 4px">
            {{ t('settings.proxyHint') }}
          </n-text>
        </div>

        <n-divider style="margin: 4px 0" />

        <!-- Resin 代理池 -->
        <div>
          <n-space align="center" style="margin-bottom: 12px">
            <n-switch :value="resinEnabled" @update:value="toggleResin" :loading="resinToggling" size="small" />
            <n-text strong :depth="resinEnabled ? 1 : 3">{{ t('settings.resinProxy') }}</n-text>
            <n-text depth="3" style="font-size: 12px">{{ resinEnabled ? t('common.enabled') : t('common.disabled') }}</n-text>
            <n-button v-if="resinDashboardUrl && (resinDashboardUrl.startsWith('http://') || resinDashboardUrl.startsWith('https://'))" text type="primary" tag="a" :href="resinDashboardUrl" target="_blank" size="small">
              {{ t('settings.dashboard') }}
            </n-button>
          </n-space>
          <n-form label-placement="left" label-width="80" size="small">
            <n-form-item :label="t('settings.serviceUrl')">
              <n-input v-model:value="resinUrlInput" :placeholder="t('settings.resinUrlPlaceholder')" clearable />
            </n-form-item>
            <n-form-item :label="t('settings.token')">
              <n-input v-model:value="resinTokenInput" placeholder="RESIN_PROXY_TOKEN" clearable show-password-on="click" />
            </n-form-item>
            <n-form-item :label="t('settings.platform')">
              <n-input v-model:value="resinPlatformInput" placeholder="Default" clearable />
            </n-form-item>
          </n-form>
          <n-space>
            <n-button type="info" :loading="resinTesting" :disabled="!resinUrlInput || !resinTokenInput" @click="testResin">{{ t('settings.testConnection') }}</n-button>
            <n-button type="primary" :loading="resinSaving" @click="saveResin">{{ t('common.save') }}</n-button>
          </n-space>
          <n-text depth="3" style="font-size: 12px; display: block; margin-top: 4px">
            {{ t('settings.resinHint') }}
            <n-a href="https://github.com/Resinat/Resin" target="_blank">Resin</n-a>。
          </n-text>
        </div>
      </n-space>
    </n-card>

    <n-card :title="t('settings.cacheManagement')" size="small" style="margin-bottom: 16px">
      <n-space>
        <n-button type="warning" @click="handleClearCache" :loading="clearing">{{ t('settings.clearCache') }}</n-button>
      </n-space>
    </n-card>

    <!-- 定时任务 -->
    <n-card v-if="!isWorkerPlatform" size="small">
      <template #header>
        {{ t('settings.scheduledTasks') }}
        <n-tag size="small" type="warning" style="margin-left: 8px; vertical-align: middle">{{ t('settings.taskLogicPending') }}</n-tag>
      </template>
      <template #header-extra>
        <n-button size="small" type="primary" @click="openTaskModal()">{{ t('settings.addTask') }}</n-button>
      </template>
      <n-spin :show="tasksLoading">
        <n-data-table v-if="tasks.length" :columns="taskColumns" :data="tasks" :bordered="false" size="small" :scroll-x="600" />
        <n-empty v-else-if="!tasksLoading" :description="t('settings.noTasks')" />
      </n-spin>
    </n-card>

    <!-- 添加/编辑任务 Modal -->
    <n-modal v-if="!isWorkerPlatform" v-model:show="showTaskModal" preset="dialog" :title="editingTaskId ? t('settings.editTaskTitle') : t('settings.addTaskTitle')" style="width: 550px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item :label="t('settings.taskName')">
          <n-input v-model:value="taskForm.name" :placeholder="t('settings.taskNamePlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('settings.taskType')">
          <n-select v-model:value="taskForm.type" :options="taskTypeOptions" @update:value="onTaskTypeChange" />
        </n-form-item>
        <n-text v-if="currentTypeDesc" depth="3" style="display: block; margin: -8px 0 12px 100px; font-size: 12px">{{ currentTypeDesc }}</n-text>

        <!-- 动态配置: 账号选择 -->
        <n-form-item v-if="taskNeedsAccount" :label="t('settings.account')">
          <n-select v-model:value="taskConfig.accountId" :options="accountOptions" :placeholder="t('settings.selectAccount')" />
        </n-form-item>

        <!-- KV 清理配置 -->
        <template v-if="taskForm.type === 'kv_cleanup'">
          <n-form-item :label="t('settings.namespaceId')">
            <n-input v-model:value="taskConfig.namespaceId" placeholder="KV Namespace ID" />
          </n-form-item>
          <n-form-item :label="t('settings.keyPrefix')">
            <n-input v-model:value="taskConfig.prefix" :placeholder="t('settings.keyPrefixPlaceholder')" />
          </n-form-item>
        </template>

        <!-- D1 备份配置 -->
        <template v-if="taskForm.type === 'd1_backup'">
          <n-form-item :label="t('settings.databaseId')">
            <n-input v-model:value="taskConfig.databaseId" placeholder="D1 Database UUID" />
          </n-form-item>
        </template>

        <!-- R2 清理配置 -->
        <template v-if="taskForm.type === 'r2_cleanup'">
          <n-form-item :label="t('settings.bucket')">
            <n-input v-model:value="taskConfig.bucket" :placeholder="t('settings.bucketPlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('settings.maxAgeDays')">
            <n-input-number v-model:value="taskConfig.maxAgeDays" :min="1" :max="365" placeholder="30" />
          </n-form-item>
          <n-form-item :label="t('settings.prefixFilter')">
            <n-input v-model:value="taskConfig.prefix" :placeholder="t('settings.keyPrefixPlaceholder')" />
          </n-form-item>
        </template>

        <n-form-item :label="t('settings.cronExpr')">
          <n-input v-model:value="taskForm.cron" :placeholder="t('settings.cronPlaceholder')" />
        </n-form-item>
        <n-text depth="3" style="display: block; margin: -8px 0 0 100px; font-size: 12px">
          {{ t('settings.cronHint') }}
        </n-text>
      </n-form>
      <template #action>
        <n-button @click="showTaskModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="taskSaving" @click="handleSaveTask">{{ t('common.save') }}</n-button>
      </template>
    </n-modal>

    <!-- Catalog Sources -->
    <n-card :title="t('settings.catalogSources')" size="small" style="margin-bottom: 16px">
      <template #header-extra>
        <n-button size="small" type="primary" @click="openAddSource">{{ t('settings.addSource') }}</n-button>
      </template>
      <n-spin :show="sourceLoading">
        <n-list hoverable>
          <n-list-item v-for="s in catalogSources" :key="s.id">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%">
              <div>
                <n-space align="center">
                  <n-tag v-if="s.is_default" size="tiny" type="primary">{{ t('settings.default') }}</n-tag>
                  <n-tag :type="s.enabled ? 'success' : 'default'" size="tiny">{{ s.enabled ? t('settings.enabled') : t('settings.disabled') }}</n-tag>
                  <span>{{ s.name }}</span>
                  <span style="color: var(--text-color-3); font-size: 12px">{{ s.url }}</span>
                </n-space>
                <div style="font-size: 12px; color: var(--text-color-3); margin-top: 4px">
                  <span v-if="s.last_status === 'ok'">✓ {{ s.last_synced }}</span>
                  <span v-else-if="s.last_status === 'error'" style="color: var(--error-color)">✗ {{ s.last_error }}</span>
                  <span v-else>{{ t('settings.waitingSync') }}</span>
                </div>
              </div>
              <n-space>
                <n-button size="tiny" @click="toggleSource(s)">{{ s.enabled ? t('settings.disable') : t('settings.enable') }}</n-button>
                <n-button v-if="!s.is_default" size="tiny" @click="openEditSource(s)">{{ t('settings.edit') }}</n-button>
                <n-button v-if="!s.is_default" size="tiny" type="error" quaternary @click="deleteSource(s)">{{ t('settings.delete') }}</n-button>
              </n-space>
            </div>
          </n-list-item>
        </n-list>
        <n-empty v-if="!catalogSources.length && !sourceLoading" :description="t('settings.noSources')" />
      </n-spin>
    </n-card>

    <!-- Add Source Modal -->
    <n-modal v-model:show="showAddSource" preset="card" :title="t('settings.addSourceTitle')" style="width: 400px; max-width: 95vw">
      <n-form label-placement="top" size="small">
        <n-form-item label="URL" required>
          <n-input-group>
            <n-input v-model:value="newSourceUrl" placeholder="https://..." clearable @keyup.enter="() => testSource(newSourceUrl)" />
            <n-button :loading="testingSource" :disabled="!newSourceUrl" @click="() => testSource(newSourceUrl)">{{ t('settings.test') }}</n-button>
          </n-input-group>
          <n-text v-if="sourceTestResult" :type="sourceTestResult.ok ? 'success' : 'error'" depth="3" style="font-size: 12px; display: block; margin-top: 4px">
            <template v-if="sourceTestResult.ok">✓ {{ t('settings.available', { count: sourceTestResult.templateCount }) }}</template>
            <template v-else>✗ {{ sourceTestResult.error }}</template>
          </n-text>
        </n-form-item>
        <n-form-item :label="t('settings.alias')" required>
          <n-input v-model:value="newSourceName" :placeholder="t('settings.aliasPlaceholder')" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showAddSource = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="addingSource" :disabled="!sourceTestResult?.ok" @click="addSource">{{ t('common.add') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- Edit Source Modal -->
    <n-modal v-model:show="showEditSource" preset="card" :title="t('settings.editSourceTitle')" style="width: 400px; max-width: 95vw">
      <n-form label-placement="top" size="small">
        <n-form-item label="URL" required>
          <n-input-group>
            <n-input v-model:value="editSourceUrl" placeholder="https://..." clearable @keyup.enter="() => testSource(editSourceUrl)" />
            <n-button :loading="testingSource" :disabled="!editSourceUrl" @click="() => testSource(editSourceUrl)">{{ t('settings.test') }}</n-button>
          </n-input-group>
          <n-text v-if="sourceTestResult" :type="sourceTestResult.ok ? 'success' : 'error'" depth="3" style="font-size: 12px; display: block; margin-top: 4px">
            <template v-if="sourceTestResult.ok">✓ {{ t('settings.available', { count: sourceTestResult.templateCount }) }}</template>
            <template v-else>✗ {{ sourceTestResult.error }}</template>
          </n-text>
        </n-form-item>
        <n-form-item :label="t('settings.alias')" required>
          <n-input v-model:value="editSourceName" :placeholder="t('settings.aliasPlaceholder')" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showEditSource = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="editingSource" :disabled="!editCanSave" @click="saveEditSource">{{ t('common.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 执行历史 Drawer -->
    <n-drawer v-if="!isWorkerPlatform" v-model:show="showHistoryDrawer" :width="drawerWidth(520)" placement="right">
      <n-drawer-content :title="t('settings.historyTitle', { name: historyTaskName })" closable>
        <n-spin :show="historyLoading">
          <n-timeline>
            <n-timeline-item v-for="h in taskHistory" :key="h.id" :type="h.status === 'success' ? 'success' : h.status === 'error' ? 'error' : 'info'" :title="h.status" :content="h.detail || '-'" :time="h.started_at ? formatCN(h.started_at) : '-'" />
          </n-timeline>
          <n-empty v-if="!taskHistory.length && !historyLoading" :description="t('settings.noHistory')" />
        </n-spin>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import { createRequestScope } from '../utils/requestScope';
import { useI18n } from 'vue-i18n';
import { NButton, NSpace, NTag, NSwitch, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { settingsApi } from '../api/settings';
import { tasksApi } from '../api/storage';
import { accountsApi } from '../api/accounts';
import apiClient from '../api/client';
import { formatCN } from '../utils/dateFormat';
import { confirmOperation } from '../utils/confirmOperation';
import { storeApi } from '../api/store';

const { t } = useI18n();
const requests = createRequestScope();
const message = useMessage();

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}
const loading = ref(false);
const clearing = ref(false);
const settings = ref<any>({});
const proxyUrl = ref('');
const proxyEnabled = ref(false);

// 任务表单需要全量账户列表（不受分页影响）
const taskAllAccounts = ref<any[]>([]);
async function loadTaskAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    taskAllAccounts.value = (data as any).accounts || [];
  } catch { taskAllAccounts.value = []; }
}
const proxySaving = ref(false);
const proxyTesting = ref(false);
const proxyToggling = ref(false);

// Resin 代理池
const resinEnabled = ref(false);
const resinUrlInput = ref('');
const resinTokenInput = ref('');
const resinPlatformInput = ref('Default');
const resinDashboardUrl = ref('');
const resinToggling = ref(false);
const resinSaving = ref(false);
const resinTesting = ref(false);

const isWorkerPlatform = computed(() => settings.value.platform === 'cloudflare-workers');

async function fetchSettings() {
  loading.value = true;
  const request = requests.begin('fetchSettings');
  try {
    const { data } = await settingsApi.get();
    if (!request.current()) return;
    settings.value = data;
    proxyUrl.value = data.proxy_url || '';
    proxyEnabled.value = !!data.proxy_enabled;
    // Resin
    resinEnabled.value = !!data.resin_enabled;
    resinUrlInput.value = data.resin_url || '';
    resinTokenInput.value = ''; // Token 不回填（安全考虑）
    resinPlatformInput.value = data.resin_platform || 'Default';
    resinDashboardUrl.value = data.resin_url || '';
  } catch {
    if (!request.current()) return;
    settings.value = {};
  } finally {
    if (request.current()) loading.value = false;
  }
}

async function toggleProxy(enabled: boolean) {
  proxyToggling.value = true;
  try {
    const { data } = await apiClient.put('/settings/proxy', { proxy_enabled: enabled });
    proxyEnabled.value = !!data.proxy_enabled;
    message.success(enabled ? t('settings.msg.proxyEnabled') : t('settings.msg.proxyDisabled'));
  } catch {
    message.error(t('settings.msg.proxySaveFailed'));
  } finally {
    proxyToggling.value = false;
  }
}

async function saveProxy() {
  proxySaving.value = true;
  try {
    const { data } = await apiClient.put('/settings/proxy', { proxy_url: proxyUrl.value });
    proxyEnabled.value = !!data.proxy_enabled;
    message.success(t('settings.msg.proxySaved'));
  } catch {
    message.error(t('settings.msg.proxySaveSettingsFailed'));
  } finally {
    proxySaving.value = false;
  }
}

async function testProxy() {
  if (!proxyUrl.value) return;
  proxyTesting.value = true;
  try {
    const { data } = await settingsApi.testProxy(proxyUrl.value);
    message.success(t('settings.msg.proxyAvailable', { latency: data.latency_ms, status: data.status }));
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.message || 'error';
    message.error(t('settings.msg.proxyUnavailable', { error: msg }));
  } finally {
    proxyTesting.value = false;
  }
}

// ============ Resin 代理池 ============
async function toggleResin(enabled: boolean) {
  resinToggling.value = true;
  try {
    const { data } = await settingsApi.saveResin({ enabled });
    resinEnabled.value = !!data.enabled;
    message.success(enabled ? t('settings.msg.resinEnabled') : t('settings.msg.resinDisabled'));
  } catch {
    message.error(t('settings.msg.resinToggleFailed'));
  } finally {
    resinToggling.value = false;
  }
}

async function saveResin() {
  resinSaving.value = true;
  try {
    const cfg: any = {
      url: resinUrlInput.value,
      platform: resinPlatformInput.value || 'Default',
    };
    // 仅在用户输入了 Token 时才传（避免空值覆盖已有 Token）
    if (resinTokenInput.value) {
      cfg.token = resinTokenInput.value;
    }
    const { data } = await settingsApi.saveResin(cfg);
    resinEnabled.value = !!data.enabled;
    resinDashboardUrl.value = data.url || resinUrlInput.value;
    resinTokenInput.value = ''; // 清空 Token 输入框
    message.success(t('settings.msg.resinSaved'));
  } catch {
    message.error(t('settings.msg.resinSaveFailed'));
  } finally {
    resinSaving.value = false;
  }
}

async function testResin() {
  resinTesting.value = true;
  try {
    // 先保存当前输入的配置，再测试
    const cfg: any = {
      url: resinUrlInput.value,
      platform: resinPlatformInput.value || 'Default',
    };
    if (resinTokenInput.value) {
      cfg.token = resinTokenInput.value;
    }
    await settingsApi.saveResin(cfg);
    const { data } = await settingsApi.testResin();
    message.success(t('settings.msg.resinConnected', { latency: data.latency_ms, status: data.status }));
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.message || 'error';
    message.error(t('settings.msg.resinConnectFailed', { error: msg }));
  } finally {
    resinTesting.value = false;
  }
}

async function handleClearCache() {
  clearing.value = true;
  try {
    await settingsApi.clearCache();
    message.success(t('settings.msg.cacheCleared'));
  } finally {
    clearing.value = false;
  }
}

// ============ Tasks ============
const tasks = ref<any[]>([]);
const tasksLoading = ref(false);
const showTaskModal = ref(false);
const editingTaskId = ref<number | null>(null);
const taskForm = ref({ name: '', type: 'quota_report', cron: '0 8 * * *' });
const taskConfig = ref<any>({ accountId: null, namespaceId: '', databaseId: '', bucket: '', maxAgeDays: 30, prefix: '' });
const taskSaving = ref(false);
const showHistoryDrawer = ref(false);
const historyTaskName = ref('');
const taskHistory = ref<any[]>([]);
const historyLoading = ref(false);

const taskTypeOptions = computed(() => [
  { label: t('settings.taskTypes.quotaReport'), value: 'quota_report' },
  { label: t('settings.taskTypes.kvCleanup'), value: 'kv_cleanup' },
  { label: t('settings.taskTypes.d1Backup'), value: 'd1_backup' },
  { label: t('settings.taskTypes.r2Cleanup'), value: 'r2_cleanup' },
]);

const taskTypeDescMap = computed<Record<string, string>>(() => ({
  quota_report: t('settings.taskTypeDesc.quotaReport'),
  kv_cleanup: t('settings.taskTypeDesc.kvCleanup'),
  d1_backup: t('settings.taskTypeDesc.d1Backup'),
  r2_cleanup: t('settings.taskTypeDesc.r2Cleanup'),
}));

const currentTypeDesc = computed(() => taskTypeDescMap.value[taskForm.value.type] || '');
const taskNeedsAccount = computed(() => ['kv_cleanup', 'd1_backup', 'r2_cleanup'].includes(taskForm.value.type));

const accountOptions = computed(() =>
  taskAllAccounts.value.filter((a: any) => a.is_active).map((a: any) => ({ label: a.name, value: a.id }))
);

function onTaskTypeChange() {
  taskConfig.value = { accountId: accountOptions.value[0]?.value || null, namespaceId: '', databaseId: '', bucket: '', maxAgeDays: 30, prefix: '' };
}

async function fetchTasks() {
  tasksLoading.value = true;
  const request = requests.begin('fetchTasks');
  try {
    const { data } = await tasksApi.getAll();
    if (!request.current()) return;
    tasks.value = Array.isArray(data) ? data : [];
  } catch {
    if (!request.current()) return;
    tasks.value = [];
  } finally {
    if (request.current()) tasksLoading.value = false;
  }
}

function openTaskModal(task?: any) {
  if (task) {
    editingTaskId.value = task.id;
    taskForm.value = { name: task.name, type: task.type, cron: task.cron };
    const parsed = task.config ? (typeof task.config === 'string' ? JSON.parse(task.config) : task.config) : {};
    taskConfig.value = {
      accountId: parsed.accountId || accountOptions.value[0]?.value || null,
      namespaceId: parsed.namespaceId || '',
      databaseId: parsed.databaseId || '',
      bucket: parsed.bucket || '',
      maxAgeDays: parsed.maxAgeDays || 30,
      prefix: parsed.prefix || '',
    };
  } else {
    editingTaskId.value = null;
    taskForm.value = { name: '', type: 'quota_report', cron: '0 8 * * *' };
    taskConfig.value = { accountId: accountOptions.value[0]?.value || null, namespaceId: '', databaseId: '', bucket: '', maxAgeDays: 30, prefix: '' };
  }
  showTaskModal.value = true;
}

async function handleSaveTask() {
  if (!taskForm.value.name || !taskForm.value.cron) {
    message.warning(t('settings.msg.infoRequired'));
    return;
  }
  taskSaving.value = true;
  try {
    const payload = { ...taskForm.value, config: taskNeedsAccount.value ? taskConfig.value : undefined };
    if (editingTaskId.value) {
      await tasksApi.update(editingTaskId.value, payload);
      message.success(t('settings.msg.taskUpdated'));
    } else {
      await tasksApi.create(payload);
      message.success(t('settings.msg.taskCreated'));
    }
    showTaskModal.value = false;
    fetchTasks();
  } finally {
    taskSaving.value = false;
  }
}

async function handleDeleteTask(row: any) {
  if (!await confirmOperation(t('common.delete'), row.name, `Scheduled task ${row.id}`)) return;
  await tasksApi.delete(row.id);
  message.success(t('settings.msg.taskDeleted'));
  fetchTasks();
}

async function handleRunTask(row: any) {
  const { data } = await tasksApi.run(row.id);
  if (data?.status === 'error') message.error(data.detail || t('common.error'));
  else message.success(t('settings.msg.taskExecuted'));
  if (showHistoryDrawer.value && historyTaskName.value === row.name) await openHistory(row);
}

async function handleToggleTask(row: any, enabled: boolean) {
  await tasksApi.update(row.id, { enabled });
  row.enabled = enabled ? 1 : 0;
}

async function openHistory(row: any) {
  historyTaskName.value = row.name;
  showHistoryDrawer.value = true;
  historyLoading.value = true;
  const request = requests.begin('openHistory');
  try {
    const { data } = await tasksApi.getHistory(row.id);
    if (!request.current()) return;
    taskHistory.value = Array.isArray(data) ? data : [];
  } catch {
    if (!request.current()) return;
    taskHistory.value = [];
  } finally {
    if (request.current()) historyLoading.value = false;
  }
}

const taskColumns = computed<DataTableColumns<any>>(() => [
  { title: t('common.name'), key: 'name', minWidth: 120 },
  { title: t('common.type'), key: 'type', width: 120, render: (row) => h(NTag, { size: 'small' }, { default: () => taskTypeOptions.value.find(o => o.value === row.type)?.label || row.type }) },
  { title: 'Cron', key: 'cron', width: 140 },
  { title: t('settings.enabled'), key: 'enabled', width: 80, render: (row) => h(NSwitch, { value: !!row.enabled, onUpdateValue: (v: boolean) => handleToggleTask(row, v) }) },
  {
    title: t('common.actions'), key: 'actions', width: 220,
    render: (row) => h(NSpace, null, { default: () => [
      h(NButton, { size: 'small', onClick: () => handleRunTask(row) }, { default: () => t('common.execute') }),
      h(NButton, { size: 'small', onClick: () => openHistory(row) }, { default: () => t('common.history') }),
      h(NButton, { size: 'small', onClick: () => openTaskModal(row) }, { default: () => t('common.edit') }),
      h(NButton, { size: 'small', type: 'error', onClick: () => handleDeleteTask(row) }, { default: () => t('common.delete') }),
    ]}),
  },
]);

// ============ Catalog Sources ============
const sourceLoading = ref(false);
const catalogSources = ref<any[]>([]);
const showAddSource = ref(false);
const newSourceUrl = ref('');
const newSourceName = ref('');
const addingSource = ref(false);
const testingSource = ref(false);
const sourceTestResult = ref<{ ok: boolean; templateCount?: number; error?: string } | null>(null);

// Edit source state
const showEditSource = ref(false);
const editingSource = ref(false);
const editSourceId = ref<number | null>(null);
const editSourceUrl = ref('');
const editSourceName = ref('');
const editSourceOriginalUrl = ref('');

const editUrlChanged = computed(() => editSourceUrl.value !== editSourceOriginalUrl.value);
const editCanSave = computed(() =>
  !!editSourceName.value && (!editUrlChanged.value || !!sourceTestResult.value?.ok) && !editingSource.value
);

async function loadSources() {
  sourceLoading.value = true;
  const request = requests.begin('loadSources');
  try {
    const { data } = await storeApi.getSources();
    if (!request.current()) return;
    catalogSources.value = data as any[];
  } catch {
    if (!request.current()) return;} finally {
    if (request.current()) sourceLoading.value = false;
  }
}

function openAddSource() {
  showAddSource.value = true;
  newSourceUrl.value = '';
  newSourceName.value = '';
  sourceTestResult.value = null;
}

function openEditSource(s: any) {
  showEditSource.value = true;
  editSourceId.value = s.id;
  editSourceUrl.value = s.url;
  editSourceOriginalUrl.value = s.url;
  editSourceName.value = s.name;
  sourceTestResult.value = null;
}

async function testSource(targetUrl: string) {
  if (!targetUrl) return;
  testingSource.value = true;
  sourceTestResult.value = null;
  try {
    const { data } = await storeApi.testSource(targetUrl);
    sourceTestResult.value = data;
    if (data.ok) message.success(t('settings.msg.sourceTestOk', { count: data.templateCount }));
    else message.error(t('settings.msg.sourceTestFailed', { error: data.error }));
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || t('settings.msg.testFailed');
    sourceTestResult.value = { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
    message.error(t('settings.msg.sourceTestFailed', { error: sourceTestResult.value.error }));
  } finally {
    testingSource.value = false;
  }
}

async function addSource() {
  if (!newSourceUrl.value || !newSourceName.value) return;
  addingSource.value = true;
  try {
    await storeApi.addSource(newSourceUrl.value, newSourceName.value);
    message.success(t('settings.msg.sourceAdded'));
    showAddSource.value = false;
    newSourceUrl.value = '';
    newSourceName.value = '';
    sourceTestResult.value = null;
    await loadSources();
  } catch {} finally {
    addingSource.value = false;
  }
}

async function saveEditSource() {
  if (editSourceId.value == null) return;
  editingSource.value = true;
  try {
    await storeApi.updateSource(editSourceId.value, { url: editSourceUrl.value, name: editSourceName.value });
    message.success(t('settings.msg.sourceSaved'));
    showEditSource.value = false;
    sourceTestResult.value = null;
    await loadSources();
  } catch {} finally {
    editingSource.value = false;
  }
}

async function toggleSource(s: any) {
  try {
    await storeApi.updateSource(s.id, { enabled: s.enabled ? 0 : 1 });
    await loadSources();
  } catch {}
}

async function deleteSource(s: any) {
  try {
    await storeApi.deleteSource(s.id);
    message.success(t('settings.msg.sourceDeleted'));
    await loadSources();
  } catch {}
}

onMounted(async () => {
  await fetchSettings();
  if (!isWorkerPlatform.value) {
    fetchTasks();
  }
  loadTaskAccounts();
  loadSources();
});
</script>
