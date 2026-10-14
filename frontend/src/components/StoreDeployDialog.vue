<template>
  <n-modal v-model:show="visible" preset="card" :title="t('storeDeploy.title', { name: template?.name || '' })" style="width: 600px; max-width: 95vw" :mask-closable="false">
    <n-spin :show="deploying || preflighting">
      <n-form v-if="template" label-placement="top" size="small">
        <!-- Account -->
        <n-form-item :label="t('storeDeploy.targetAccount')" required>
          <n-select v-model:value="form.accountIds" :options="accountOptions" :render-label="renderAccountLabel" multiple filterable :placeholder="t('storeDeploy.targetAccountPlaceholder')" @update:value="onAccountChange" />
          <template v-if="needsR2 || isMultiAccount" #feedback>
            <n-text type="warning" depth="3" style="font-size: 12px">
              {{ needsR2 ? t('storeDeploy.r2Hint') : t('storeDeploy.multiAccountHint') }}
            </n-text>
          </template>
        </n-form-item>

        <!-- Name -->
        <n-form-item :label="t('storeDeploy.name')" required>
          <n-input v-model:value="form.name" :placeholder="t('storeDeploy.namePlaceholder')" @update:value="invalidatePreflight" />
        </n-form-item>

        <!-- Deploy type (hybrid only) -->
        <n-form-item v-if="template.type === 'hybrid'" :label="t('storeDeploy.deployMethod')" required>
          <n-radio-group v-model:value="deployType" @update:value="invalidatePreflight">
            <n-radio-button value="both">{{ t('storeDeploy.both') }}</n-radio-button>
            <n-radio-button value="worker">{{ t('storeDeploy.workerOnly') }}</n-radio-button>
            <n-radio-button value="pages">{{ t('storeDeploy.pagesOnly') }}</n-radio-button>
          </n-radio-group>
        </n-form-item>

        <!-- Observability: Worker 特性，hybrid 模式选「仅 Pages」时不显示 -->
        <n-form-item v-if="!isPagesOnly" :label="t('storeDeploy.observability')">
          <n-space align="center" :size="24">
            <n-space align="center" :size="8">
              <n-switch v-model:value="enableLogs" size="small" />
              <n-tooltip>
                <template #trigger>
                  <span style="font-size: 13px; cursor: help">{{ t('storeDeploy.logsLabel') }}</span>
                </template>
                {{ t('storeDeploy.logsTooltip') }}
              </n-tooltip>
            </n-space>
            <n-space align="center" :size="8">
              <n-switch v-model:value="enableTraces" size="small" />
              <n-tooltip>
                <template #trigger>
                  <span style="font-size: 13px; cursor: help">{{ t('storeDeploy.tracesLabel') }}</span>
                </template>
                {{ t('storeDeploy.tracesTooltip') }}
              </n-tooltip>
            </n-space>
          </n-space>
        </n-form-item>

        <!-- 1101 错误解决提示：仅在非「仅 Pages」部署时展示，告知用户 Worker 部署后遇到 1101 可通过添加自定义域名解决 -->
        <n-alert
          v-if="!isPagesOnly"
          type="info"
          :show-icon="true"
          style="font-size: 13px; margin: 4px 0 12px 0"
        >
          {{ t('storeDeploy.error1101Hint') }}
        </n-alert>



        <!-- Bindings -->
        <template v-if="template.bindings?.length">
          <n-divider>{{ t('storeDeploy.bindings') }}</n-divider>
          <n-form-item v-for="b in resourceBindings" :key="b.name" :label="`${b.name} (${b.type})`">
            <n-space vertical style="width: 100%">
              <n-select
                v-model:value="bindingSelections[b.name].value"
                :options="getResourceOptions(b)"
                :loading="resourceLoading[b.type]"
                :disabled="isMultiAccount"
                :placeholder="t('storeDeploy.selectResource')"
                @update:value="(val: string) => { onBindingSelect(b, val); invalidatePreflight(); }"
              />
              <!-- D1 init SQL checkbox -->
              <n-checkbox
                v-if="b.type === 'd1' && (b.initSqlUrl || b.initSql)"
                v-model:checked="bindingSelections[b.name].runInitSql"
                :disabled="isMultiAccount"
                @update:checked="invalidatePreflight"
              >
                {{ t('storeDeploy.runInitSql') }}
                <span style="color: var(--text-color-3); font-size: 12px">
                  ({{ bindingSelections[b.name].mode === 'existing' ? t('storeDeploy.runInitSqlReuseHint') : t('storeDeploy.runInitSqlNewHint') }})
                </span>
              </n-checkbox>
            </n-space>
          </n-form-item>
        </template>

        <!-- Secrets (var/prompt, secret !== false) -->
        <template v-if="secretBindings.length">
          <n-divider>{{ t('storeDeploy.secrets') }}</n-divider>
          <n-form-item v-for="b in secretBindings" :key="b.name" :required="b.required">
            <template #label>
              <span style="font-weight: 600">{{ b.title || b.name }}</span>
              <span v-if="b.title" style="color: var(--text-color-3); font-weight: normal; margin-left: 6px; font-size: 12px">{{ b.name }}</span>
            </template>
            <n-input v-model:value="secretValues[b.name]" type="password" show-password-on="click" :placeholder="t('storeDeploy.secretPlaceholder', { name: b.title || b.name })" @update:value="invalidatePreflight" />
          </n-form-item>
        </template>

        <!-- Plain config (var/prompt, secret === false) -->
        <template v-if="plainBindings.length">
          <n-divider>{{ t('storeDeploy.plainConfigs') }}</n-divider>
          <n-form-item v-for="b in plainBindings" :key="b.name" :required="b.required">
            <template #label>
              <span style="font-weight: 600">{{ b.title || b.name }}</span>
              <span v-if="b.title" style="color: var(--text-color-3); font-weight: normal; margin-left: 6px; font-size: 12px">{{ b.name }}</span>
            </template>
            <n-input v-model:value="secretValues[b.name]" :placeholder="t('storeDeploy.secretPlaceholder', { name: b.title || b.name })" @update:value="invalidatePreflight" />
          </n-form-item>
        </template>

        <!-- Env (read-only) -->
        <template v-if="template.env && Object.keys(template.env).length">
          <n-divider>{{ t('storeDeploy.envVars') }}</n-divider>
          <n-descriptions label-placement="left" :column="1" size="small" bordered>
            <n-descriptions-item v-for="(v, k) in template.env" :key="k" :label="k">{{ v }}</n-descriptions-item>
          </n-descriptions>
        </template>

        <!-- Crons (read-only) -->
        <template v-if="template.crons && template.crons.length">
          <n-divider>{{ t('storeDeploy.crons') }}</n-divider>
          <n-space>
            <n-tag v-for="cron in template.crons" :key="cron" type="warning" :bordered="false" round>{{ cron }}</n-tag>
          </n-space>
        </template>

        <!-- Preflight Results (仅在有警告或配置差异时展示) -->
        <template v-if="preflightResult && hasPreflightDetails">
          <n-divider>{{ t('storeDeploy.preflightResult') }}</n-divider>
          <n-space vertical :size="12">
            <n-space align="center" :size="8">
              <n-tag :type="preflightResult.workerExists ? 'warning' : 'success'" size="small" :bordered="false">
                {{ preflightResult.workerExists ? t('storeDeploy.workerExists') : t('storeDeploy.workerNew') }}
              </n-tag>
            </n-space>
            <template v-if="preflightResult.configDiff">
              <n-space vertical :size="4">
                <n-text v-if="preflightResult.configDiff.added.length" depth="2" style="font-size: 13px">
                  {{ t('storeDeploy.addedBindings', { items: preflightResult.configDiff.added.map((b: any) => `${b.name}(${b.type})`).join(', ') }) }}
                </n-text>
                <n-text v-if="preflightResult.configDiff.removed.length" type="warning" style="font-size: 13px">
                  {{ t('storeDeploy.removedBindings', { items: preflightResult.configDiff.removed.map((b: any) => `${b.name}(${b.type})`).join(', ') }) }}
                </n-text>
                <n-text v-if="preflightResult.configDiff.modified.length" type="warning" style="font-size: 13px">
                  {{ t('storeDeploy.modifiedBindings', { items: preflightResult.configDiff.modified.map((b: any) => `${b.name}(${b.type})`).join(', ') }) }}
                </n-text>
              </n-space>
            </template>
            <n-alert v-if="preflightResult.secretsOverride.length" type="warning" :show-icon="true" style="font-size: 13px">
              {{ t('storeDeploy.secretsOverride', { items: preflightResult.secretsOverride.join(', ') }) }}
            </n-alert>
            <n-alert
              v-for="(w, i) in preflightResult.warnings"
              :key="i"
              :type="w.includes('移除') || w.includes('无效') ? 'warning' : 'info'"
              :show-icon="true"
              style="font-size: 13px"
            >
              {{ w }}
            </n-alert>
          </n-space>
        </template>

        <!-- 多账户部署结果 -->
        <template v-if="batchDeployResults.length">
          <n-divider>{{ t('storeDeploy.deployResults') }}</n-divider>
          <n-space vertical :size="6">
            <n-space v-for="r in batchDeployResults" :key="`result-${r.accountId}`" align="center" :size="6">
              <n-tag :type="r.success ? 'success' : 'error'" size="small" :bordered="false">
                {{ r.success ? t('storeDeploy.success') : t('storeDeploy.failed') }}
              </n-tag>
              <n-text style="font-size: 13px">{{ r.accountName || t('storeDeploy.accountLabel', { id: r.accountId }) }}</n-text>
              <n-text v-if="!r.success" type="error" depth="3" style="font-size: 12px">{{ r.error }}</n-text>
            </n-space>
          </n-space>
        </template>
      </n-form>
    </n-spin>

    <template #footer>
      <n-space justify="end" :size="8">
        <n-button @click="visible = false">{{ t('common.cancel') }}</n-button>
        <!-- 预检通过且有细节需要确认时，展示「确认部署」+「返回修改」 -->
        <template v-if="preflightResult && hasPreflightDetails && preflightResult.canProceed">
          <n-button @click="invalidatePreflight">{{ t('storeDeploy.backToEdit') }}</n-button>
          <n-button type="primary" :loading="deploying" @click="handleDeploy">{{ t('storeDeploy.confirmDeploy') }}</n-button>
        </template>
        <!-- 正常流程：点击后自动先预检，通过则直接部署 -->
        <n-button v-else type="primary" :loading="preflighting || deploying" :disabled="!canDeploy" @click="handleDeploy">
          {{ preflighting ? t('storeDeploy.preflighting') : t('storeDeploy.confirmDeploy') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { useAccountLabels } from '../utils/useAccountLabels';
import { ref, computed, watch, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeApi } from '../api/store';
import { workersApi } from '../api/workers';
import { accountsApi } from '../api/accounts';
import { NTag } from 'naive-ui';
import { message } from '../utils/discreteApi';

const { t } = useI18n();
const { accountLabel, renderAccountOption } = useAccountLabels();

const props = defineProps<{ show: boolean; template: any }>();
const emit = defineEmits<{ 'update:show': [boolean]; deployed: [any] }>();

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
});

const deploying = ref(false);
const preflighting = ref(false);
const preflightResult = ref<any>(null);
const deployType = ref<'worker' | 'pages' | 'both'>('both');
const enableLogs = ref(true);    // Workers 日志（默认开启）
const enableTraces = ref(true);  // Workers 跟踪（默认开启）
const accounts = ref<any[]>([]);
const form = ref({ accountIds: [] as number[], name: '' });
const bindingSelections = ref<Record<string, { value: string; mode: 'auto' | 'existing'; existingId?: string; runInitSql: boolean }>>({});
const secretValues = ref<Record<string, string>>({});
const resourceLoading = ref<Record<string, boolean>>({});
const existingResources = ref<Record<string, any[]>>({ kv: [], d1: [], r2: [] });
const batchDeployResults = ref<Array<{ accountId: number; accountName?: string; success: boolean; error?: string }>>([]);

// 模板是否需要 R2：存在 type 为 r2 的绑定
const needsR2 = computed(() =>
  (props.template?.bindings || []).some((b: any) => b.type === 'r2')
);

// 是否为「仅 Pages」部署：纯 pages 模板 或 hybrid 但选了仅 pages
// 这两种情况下 Workers 日志/跟踪不适用，需要隐藏「可观测性」区域
const isPagesOnly = computed(() =>
  props.template?.type === 'pages' ||
  (props.template?.type === 'hybrid' && deployType.value === 'pages')
);

// 预检结果是否有需要用户确认的细节（配置差异、Secrets 覆盖、警告）
const hasPreflightDetails = computed(() => {
  if (!preflightResult.value) return false;
  return !!(
    preflightResult.value.configDiff ||
    preflightResult.value.secretsOverride?.length ||
    preflightResult.value.warnings?.length
  );
});

// 精确判断账户是否开通 R2：避免 '-r2' 被 includes('r2') 误匹配
function hasR2Feature(account: any): boolean {
  const features = (account.available_features || '').split(',').filter(Boolean);
  return features.includes('r2') && !features.includes('-r2');
}

const accountOptions = computed(() => {
  const list = accounts.value
    // 需要 R2 时只保留已开通 R2 的账户，其余不可选
    .filter((a) => !needsR2.value || hasR2Feature(a))
    .map((a) => ({ label: accountLabel(a), value: a.id }));
  return list;
});

function renderAccountLabel(option: { label: string; value: number }, selected: boolean) {
  const account = accounts.value.find((a: any) => a.id === option.value);
  if (!account) return renderAccountOption(option, selected);
  if (hasR2Feature(account)) {
    return h('span', { style: 'display: inline-flex; align-items: center; gap: 4px' }, [
      renderAccountOption(option, selected),
      h(NTag, { size: 'tiny', type: 'success', bordered: false }, { default: () => 'R2' }),
    ]);
  }
  return renderAccountOption(option, selected);
}

const resourceBindings = computed(() =>
  (props.template?.bindings || []).filter((b: any) => ['kv', 'd1', 'r2'].includes(b.type))
);

const secretBindings = computed(() =>
  (props.template?.bindings || []).filter((b: any) => b.type === 'var' && b.action === 'prompt' && b.secret !== false)
);

// 明文 var（需手填但作为普通环境变量写入，前端显示普通文本框）
const plainBindings = computed(() =>
  (props.template?.bindings || []).filter((b: any) => b.type === 'var' && b.action === 'prompt' && b.secret === false)
);

const canDeploy = computed(() => {
  if (!form.value.accountIds.length || !form.value.name) return false;
  for (const b of [...secretBindings.value, ...plainBindings.value]) {
    if (b.required && !secretValues.value[b.name]) return false;
  }
  return true;
});

// 是否为多账户部署模式
const isMultiAccount = computed(() => form.value.accountIds.length > 1);

function getResourceOptions(binding: any) {
  const resources = existingResources.value[binding.type] || [];
  const title = binding.title || `${props.template?.id}-${binding.name.toLowerCase()}`;
  const options = [{ label: t('storeDeploy.autoCreate', { name: title }), value: '__auto__' }];
  for (const r of resources) {
    const label = r.title || r.name || r.id;
    options.push({ label, value: r.id || r.uuid || r.name });
  }
  return options;
}

function onBindingSelect(binding: any, value: string) {
  if (value === '__auto__') {
    bindingSelections.value[binding.name].mode = 'auto';
    bindingSelections.value[binding.name].existingId = undefined;
    bindingSelections.value[binding.name].runInitSql = true;
  } else {
    bindingSelections.value[binding.name].mode = 'existing';
    bindingSelections.value[binding.name].existingId = value;
    bindingSelections.value[binding.name].runInitSql = false;
  }
}

// 任何表单变更都需要清除预检结果
function invalidatePreflight() {
  preflightResult.value = null;
}

async function onAccountChange() {
  invalidatePreflight();
  batchDeployResults.value = [];
  const selectedIds = form.value.accountIds;
  if (!selectedIds.length) return;
  // 多账户模式下，加载第一个账户的资源供参考（所有账户都会使用 auto 模式）
  const firstId = selectedIds[0];
  const neededTypes = (Array.from(new Set((props.template?.bindings || []).map((b: any) => b.type)))).filter((ty: any) => ty === 'kv' || ty === 'd1' || ty === 'r2') as ('kv' | 'd1' | 'r2')[];
  if (neededTypes.length === 0) return;
  for (const ty of neededTypes) {
    resourceLoading.value[ty] = true;
    try {
      if (ty === 'kv') {
        const { data } = await workersApi.getKvNamespaces(firstId);
        existingResources.value.kv = data as any[];
      } else if (ty === 'd1') {
        const { data } = await workersApi.getD1Databases(firstId);
        existingResources.value.d1 = data as any[];
      } else if (ty === 'r2') {
        const { data } = await workersApi.getR2Buckets(firstId, { _silent: true });
        existingResources.value.r2 = data as any[];
      }
    } catch {
      existingResources.value[ty] = [];
    } finally {
      resourceLoading.value[ty] = false;
    }
  }
}

function buildSelections(): Record<string, any> {
  const selections: Record<string, any> = {};
  for (const [name, sel] of Object.entries(bindingSelections.value)) {
    const entry: any = {
      mode: sel.mode,
      existingId: sel.existingId,
    };
    // auto 模式下不发送 runInitSql，让后端自行判断：
    // 新建 DB 默认执行 init SQL，已有 DB 不执行（除非用户显式勾选）
    if (sel.mode === 'existing') {
      entry.runInitSql = sel.runInitSql;
    }
    selections[name] = entry;
  }
  return selections;
}

/**
 * 统一部署入口 — 点击「确认部署」时自动先预检：
 * 多账户模式：逐个预检并部署，显示每个账户的结果
 * 单账户模式：保持原有两阶段流程
 */
async function handleDeploy() {
  if (!canDeploy.value) return;

  // 多账户模式：逐个预检 + 部署
  if (isMultiAccount.value) {
    await doBatchDeploy();
    return;
  }

  // 单账户模式：保持原有流程
  // 情况 1：已有预检结果且用户已确认
  if (preflightResult.value?.canProceed && hasPreflightDetails.value) {
    await doDeploy(form.value.accountIds[0]);
    return;
  }

  // 情况 2：先预检
  preflighting.value = true;
  try {
    const selections = buildSelections();
    const { data: pfData } = await storeApi.preflight({
      accountId: form.value.accountIds[0],
      templateId: props.template.id,
      name: form.value.name,
      bindingSelections: selections,
      secretValues: secretValues.value,
      deployType: props.template.type === 'hybrid' ? deployType.value : undefined,
    });
    preflightResult.value = pfData;

    if (!pfData.canProceed) {
      message.error(t('storeDeploy.msg.preflightFailed'));
      return;
    }

    if (!hasPreflightDetails.value) {
      preflighting.value = false;
      await doDeploy(form.value.accountIds[0]);
    }
  } catch (e: any) {
    preflightResult.value = null;
    message.error(t('storeDeploy.msg.preflightError', { error: e.errorMessage || e.message || t('common.unknown') }));
  } finally {
    preflighting.value = false;
  }
}

async function doDeploy(accountId: number) {
  deploying.value = true;
  try {
    const selections = buildSelections();

    const result = await storeApi.deploy({
      accountId,
      templateId: props.template.id,
      name: form.value.name,
      bindingSelections: selections,
      secretValues: secretValues.value,
      deployType: props.template.type === 'hybrid' ? deployType.value : undefined,
      logs: enableLogs.value,
      traces: enableTraces.value,
    });

    emit('deployed', result);
    visible.value = false;
  } catch (e: any) {
    const errData = e?.response?.data?.error;
    emit('deployed', {
      success: false,
      error: e.errorMessage || e.message,
      rolledBack: errData?.rolledBack,
      rollbackErrors: errData?.rollbackErrors,
    });
  } finally {
    deploying.value = false;
  }
}

/**
 * 多账户批量部署：调用后端 /store/deploy-batch 一次性完成预检 + 部署
 */
async function doBatchDeploy() {
  deploying.value = true;
  batchDeployResults.value = [];
  const selections = buildSelections();

  try {
    const { data } = await storeApi.deployBatch({
      deployments: form.value.accountIds.map(accountId => ({
        accountId,
        templateId: props.template.id,
        name: form.value.name,
        bindingSelections: selections,
        secretValues: secretValues.value,
        deployType: props.template.type === 'hybrid' ? deployType.value : undefined,
        logs: enableLogs.value,
        traces: enableTraces.value,
      })),
    });

    const results = (Array.isArray(data) ? data : []).map((r: any) => {
      const accountName = r.accountName || accounts.value.find((a: any) => a.id === r.accountId)?.name;
      return {
        accountId: r.accountId,
        accountName: accountName || t('storeDeploy.accountLabel', { id: r.accountId }),
        success: r.success,
        error: r.error,
      };
    });

    batchDeployResults.value = results;
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      message.success(t('storeDeploy.msg.batchSuccess', { success: successCount, total: results.length }));
      emit('deployed', { success: true, batchResults: results });
      visible.value = false;
    } else {
      message.warning(t('storeDeploy.msg.batchPartial', { success: successCount, failed: failCount }));
      emit('deployed', { success: false, batchResults: results });
    }
  } catch (e: any) {
    batchDeployResults.value = form.value.accountIds.map(accountId => {
      const account = accounts.value.find((a: any) => a.id === accountId);
      return {
        accountId,
        accountName: account?.name || t('storeDeploy.accountLabel', { id: accountId }),
        success: false,
        error: e.errorMessage || e.message || t('storeDeploy.msg.batchFailed', { error: '' }),
      };
    });
    message.error(t('storeDeploy.msg.batchFailed', { error: e.errorMessage || e.message || t('common.unknown') }));
  } finally {
    deploying.value = false;
  }
}

// Reset form when template changes
watch(() => props.template, (tmpl) => {
  if (tmpl) {
    form.value.name = tmpl.id;
    form.value.accountIds = [];
    secretValues.value = {};
    bindingSelections.value = {};
    existingResources.value = { kv: [], d1: [], r2: [] };
    enableLogs.value = true;
    enableTraces.value = true;
    preflightResult.value = null;
    batchDeployResults.value = [];
    const prefilledSecrets: Record<string, string> = {};
    for (const b of (tmpl.bindings || [])) {
      if (['kv', 'd1', 'r2'].includes(b.type)) {
        bindingSelections.value[b.name] = { value: '__auto__', mode: 'auto', runInitSql: b.type === 'd1' };
      } else if (b.type === 'var' && b.action === 'prompt' && b.value) {
        // var 绑定有默认值时预填到输入框
        prefilledSecrets[b.name] = b.value;
      }
    }
    secretValues.value = prefilledSecrets;
    loadAccounts();
  }
}, { immediate: true });

// 多账户模式：强制把所有 binding 切换为 auto 模式（每个账户独立创建或按名称复用）
watch(isMultiAccount, (multi) => {
  if (!multi) return;
  for (const b of resourceBindings.value) {
    bindingSelections.value[b.name] = {
      value: '__auto__',
      mode: 'auto',
      runInitSql: b.type === 'd1',
    };
  }
});

async function loadAccounts() {
  try {
    const { data } = await accountsApi.getOptions('workers');
    accounts.value = Array.isArray(data) ? data : ((data as any).accounts || []);
  } catch {}
}
</script>
