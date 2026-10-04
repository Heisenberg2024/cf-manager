<template>
  <div class="page-view">
    <n-tabs type="line" animated>
      <!-- ============ 隧道管理 ============ -->
      <n-tab-pane name="tunnels" :tab="t('tunnels.tunnelManagement')">
        <div class="tunnel-tab-content">
          <n-space align="center">
            <n-select
              v-model:value="selectedAccountId"
              :options="accountOptions"
              :placeholder="t('tunnels.selectAccount')"
              style="width: 260px"
              @update:value="onAccountChange"
            />
            <n-button type="primary" size="small" :disabled="!selectedAccountId" @click="showCreateModal = true">{{ t('tunnels.createTunnel') }}</n-button>
            <n-button size="small" :disabled="!selectedAccountId" @click="openWizard">{{ t('tunnels.wizard') }}</n-button>
            <n-button size="small" @click="loadAccounts" :loading="loadingAccounts">{{ t('tunnels.refresh') }}</n-button>
          </n-space>

          <AutoFitTable
            :columns="tunnelColumns"
            :data="tunnels"
            :loading="loadingTunnels"
            :scroll-x="600"
          />
        </div>
      </n-tab-pane>

      <!-- ============ 规则引擎 ============ -->
      <n-tab-pane name="rules-engine" :tab="t('tunnels.rulesEngine')">
        <div class="tunnel-tab-content">
          <n-space align="center">
            <n-select
              v-model:value="selectedDomain"
              :options="domainOptions"
              :placeholder="t('tunnels.selectDomain')"
              filterable
              style="width: 220px"
              @update:value="onDomainChange"
            />
            <n-select
              v-model:value="selectedRulePhase"
              :options="rulePhaseOptions"
              :placeholder="t('tunnels.rulePhase')"
              style="width: 180px"
              @update:value="loadRules"
            />
            <n-button type="primary" size="small" :disabled="!selectedDomain || !selectedRulePhase" @click="openAddRule">{{ t('tunnels.addRule') }}</n-button>
            <n-button size="small" @click="loadDomains">{{ t('tunnels.refreshDomains') }}</n-button>
          </n-space>

          <n-alert v-if="isAccountLevelPhase" type="info" :bordered="false" style="margin-top: 4px">
            <span v-html="DOMPurify.sanitize(t('tunnels.accountLevelHint'))"></span>
          </n-alert>
          <AutoFitTable
            :columns="ruleColumns"
            :data="rules"
            :loading="loadingRules"
            :scroll-x="600"
          />
        </div>
      </n-tab-pane>
    </n-tabs>

    <!-- ============ 创建隧道 Modal ============ -->
    <n-modal v-model:show="showCreateModal" preset="dialog" :title="t('tunnels.createTunnelTitle')" style="width: 420px; max-width: 95vw">
      <n-form label-placement="left" label-width="80">
        <n-form-item :label="t('tunnels.tunnelName')">
          <n-input v-model:value="newTunnelName" :placeholder="t('tunnels.tunnelNamePlaceholder')" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showCreateModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="creating" @click="submitCreateTunnel">{{ t('common.create') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 一键回源向导 Modal ============ -->
    <n-modal v-model:show="showWizardModal" preset="dialog" :title="t('tunnels.wizardTitle')" style="width: 520px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item :label="t('tunnels.mode')">
          <n-radio-group v-model:value="wizard.mode">
            <n-radio value="create">{{ t('tunnels.modeCreate') }}</n-radio>
            <n-radio value="reuse">{{ t('tunnels.modeReuse') }}</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item v-if="wizard.mode === 'create'" :label="t('tunnels.wizardTunnelName')">
          <n-input v-model:value="wizard.tunnelName" :placeholder="t('tunnels.wizardTunnelNamePlaceholder')" />
        </n-form-item>
        <n-form-item v-if="wizard.mode === 'reuse'" :label="t('tunnels.selectTunnel')">
          <n-select
            v-model:value="wizard.tunnelId"
            :options="tunnelSelectOptions"
            :placeholder="t('tunnels.selectExistingTunnel')"
            filterable
          />
        </n-form-item>
        <n-form-item :label="t('tunnels.subdomain')">
          <n-input v-model:value="wizard.subdomain" :placeholder="t('tunnels.subdomainPlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('tunnels.domain')">
          <n-select v-model:value="wizard.domain" :options="zoneOptions" :placeholder="t('tunnels.selectDomain')" filterable />
        </n-form-item>
        <n-form-item :label="t('tunnels.protocol')">
          <n-radio-group v-model:value="wizard.protocol">
            <n-radio value="http">HTTP</n-radio>
            <n-radio value="https">HTTPS</n-radio>
            <n-radio value="tcp">TCP</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item :label="t('tunnels.port')">
          <n-input-number v-model:value="wizard.port" :min="1" :max="65535" style="width: 100%" />
        </n-form-item>
        <n-form-item :label="t('tunnels.path')">
          <n-input v-model:value="wizard.path" :placeholder="t('tunnels.pathPlaceholder')" />
        </n-form-item>
      </n-form>
      <n-alert v-if="wizard.mode === 'reuse'" type="info" :bordered="false" style="margin-top: 8px">
        {{ t('tunnels.reuseHint') }}
      </n-alert>
      <template #action>
        <n-space>
          <n-button @click="showWizardModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="wizardLoading" @click="submitWizard">{{ t('tunnels.execute') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 令牌 Modal ============ -->
    <n-modal v-model:show="showTokenModal" preset="dialog" :title="t('tunnels.tokenTitle')" style="width: 600px; max-width: 95vw">
      <n-space vertical>
        <n-input :value="tokenValue" readonly type="textarea" :rows="3" />
        <n-space>
          <n-button size="small" @click="copyToken">{{ t('tunnels.copyToken') }}</n-button>
        </n-space>
        <n-alert type="info" :bordered="false">
          {{ t('tunnels.tokenHint') }}<br />
          <code>cloudflared tunnel run --token {{ tokenValue ? '***' : '***' }}</code>
        </n-alert>
      </n-space>
      <template #action>
        <n-button @click="showTokenModal = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>

    <!-- ============ 连接信息 Modal ============ -->
    <n-modal v-model:show="showConnectionsModal" preset="dialog" :title="t('tunnels.connectionsTitle')" style="width: 600px; max-width: 95vw">
      <n-data-table :columns="connectionColumns" :data="connections" size="small" :bordered="false" />
      <template #action>
        <n-button @click="showConnectionsModal = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>

    <!-- ============ Ingress 配置 Modal ============ -->
    <n-modal v-model:show="showConfigModal" preset="dialog" :title="t('tunnels.configTitle', { name: configTunnelName })" style="width: 900px; max-width: 95vw">
      <n-spin :show="loadingConfig">
        <n-space vertical>
          <n-alert type="info" :bordered="false" style="margin-bottom: 8px">
            {{ t('tunnels.configHint') }}
          </n-alert>
          <div v-for="(entry, idx) in ingressEntries" :key="idx" style="display: flex; gap: 6px; align-items: center; width: 100%; flex-wrap: wrap">
            <n-input
              v-model:value="entry.subdomain"
              :placeholder="t('tunnels.subdomainPlaceholder2')"
              style="flex: 0.5; min-width: 80px"
              :disabled="idx === ingressEntries.length - 1 && !entry.domain"
            />
            <n-select
              v-model:value="entry.domain"
              :options="zoneOptions"
              :placeholder="t('tunnels.domainPlaceholder')"
              filterable
              style="flex: 0.7; min-width: 100px"
              :disabled="idx === ingressEntries.length - 1 && !entry.domain"
            />
            <n-input
              v-model:value="entry.path"
              :placeholder="t('tunnels.pathPlaceholder2')"
              style="flex: 0.5; min-width: 80px"
            />
            <n-select
              v-model:value="entry.protocol"
              :options="protocolOptions"
              style="flex: 0.4; min-width: 80px"
            />
            <n-input-number
              v-if="entry.protocol !== 'custom'"
              v-model:value="entry.port"
              :min="1"
              :max="65535"
              :placeholder="t('tunnels.port')"
              style="flex: 0.4; min-width: 70px"
            />
            <n-input
              v-else
              v-model:value="entry.customService"
              :placeholder="t('tunnels.customService')"
              style="flex: 0.6; min-width: 100px"
            />
            <n-button
              v-if="idx < ingressEntries.length - 1"
              size="small"
              quaternary
              type="error"
              @click="removeIngressEntry(idx)"
            >{{ t('common.delete') }}</n-button>
          </div>
          <n-space>
            <n-button size="small" @click="addIngressEntry">{{ t('tunnels.addRule') }}</n-button>
          </n-space>
        </n-space>
      </n-spin>
      <template #action>
        <n-space>
          <n-button @click="showConfigModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="savingConfig" @click="saveConfig">{{ t('tunnels.saveConfig') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 规则 Modal ============ -->
    <n-modal v-model:show="showRuleModal" preset="dialog" :title="editingRuleId ? t('tunnels.ruleModalTitleEdit') : t('tunnels.ruleModalTitleAdd')" style="width: 520px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item :label="t('tunnels.matchType')">
          <n-select
            v-model:value="ruleForm.matchType"
            :options="matchTypeOptions"
          />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'hostname' || ruleForm.matchType === 'hostAndPath'" :label="t('tunnels.subdomain')">
          <n-input v-model:value="ruleForm.subdomain" :placeholder="t('tunnels.subdomainPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'pathPrefix' || ruleForm.matchType === 'hostAndPath'" :label="t('tunnels.pathPrefixLabel')">
          <n-input v-model:value="ruleForm.pathValue" :placeholder="t('tunnels.pathPrefixPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'pathRegex'" :label="t('tunnels.pathRegexLabel')">
          <n-input v-model:value="ruleForm.pathValue" :placeholder="t('tunnels.pathRegexPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'custom'" :label="t('tunnels.expression')">
          <n-input v-model:value="ruleForm.expression" :placeholder="t('tunnels.expressionPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_origin'" :label="t('tunnels.originPort')">
          <n-input-number v-model:value="ruleForm.port" :min="1" :max="65535" style="width: 100%" />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_redirect'" :label="t('tunnels.redirectUrl')">
          <n-input v-model:value="ruleForm.redirectUrl" :placeholder="t('tunnels.redirectUrlPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_redirect'" :label="t('tunnels.statusCode')">
          <n-select v-model:value="ruleForm.redirectStatus" :options="statusCodeOptions" />
        </n-form-item>
        <!-- URL 重写 -->
        <template v-if="selectedRulePhase === 'http_request_transform'">
          <n-form-item :label="t('tunnels.rewriteType')">
            <n-select v-model:value="ruleForm.rewriteType" :options="rewriteTypeOptions" />
          </n-form-item>
          <n-form-item :label="ruleForm.rewriteType === 'path' ? t('tunnels.newPath') : t('tunnels.newQueryParam')">
            <n-input v-model:value="ruleForm.rewriteValue" :placeholder="ruleForm.rewriteType === 'path' ? t('tunnels.rewriteValuePlaceholder') : t('tunnels.rewriteQueryPlaceholder')" />
          </n-form-item>
        </template>
        <!-- 请求头/响应头转换 -->
        <template v-if="selectedRulePhase === 'http_request_late_transform' || selectedRulePhase === 'http_response_headers_transform'">
          <n-form-item :label="t('tunnels.headerOp')">
            <n-select v-model:value="ruleForm.headerOp" :options="headerOpOptions" />
          </n-form-item>
          <n-form-item :label="t('tunnels.headerName')">
            <n-input v-model:value="ruleForm.headerName" :placeholder="t('tunnels.headerNamePlaceholder')" />
          </n-form-item>
          <n-form-item v-if="ruleForm.headerOp !== 'remove'" :label="t('tunnels.headerValue')">
            <n-input v-model:value="ruleForm.headerValue" :placeholder="t('tunnels.headerValuePlaceholder')" />
          </n-form-item>
        </template>
        <!-- 缓存设置 -->
        <template v-if="selectedRulePhase === 'http_request_cache_settings'">
          <n-form-item :label="t('tunnels.enableCache')">
            <n-switch v-model:value="ruleForm.cacheEnabled" />
          </n-form-item>
          <n-form-item :label="t('tunnels.ttlMode')">
            <n-select v-model:value="ruleForm.cacheTtlMode" :options="ttlModeOptions" />
          </n-form-item>
          <n-form-item v-if="ruleForm.cacheTtlMode === 'custom'" :label="t('tunnels.edgeTtl')">
            <n-input-number v-model:value="ruleForm.cacheTtlValue" :min="0" style="width: 100%" />
          </n-form-item>
        </template>
        <!-- 速率限制 -->
        <template v-if="selectedRulePhase === 'http_ratelimit'">
          <n-form-item :label="t('tunnels.ratelimitAction')">
            <n-select v-model:value="ruleForm.ratelimitAction" :options="ratelimitActionOptions" />
          </n-form-item>
          <n-form-item :label="t('tunnels.ratelimitDimension')">
            <n-select v-model:value="ruleForm.ratelimitChars" multiple :options="ratelimitDimensionOptions" />
          </n-form-item>
          <n-form-item :label="t('tunnels.ratelimitPeriod')">
            <n-input-number v-model:value="ruleForm.ratelimitPeriod" :min="1" :max="86400" style="width: 100%" />
          </n-form-item>
          <n-form-item :label="t('tunnels.ratelimitCount')">
            <n-input-number v-model:value="ruleForm.ratelimitCount" :min="1" style="width: 100%" />
          </n-form-item>
          <n-form-item :label="t('tunnels.ratelimitMitigation')">
            <n-input-number v-model:value="ruleForm.ratelimitMitigation" :min="0" style="width: 100%" />
          </n-form-item>
        </template>
        <!-- 高级模式：原始 JSON -->
        <n-form-item v-if="needsAdvancedJson" :label="t('tunnels.advancedMode')">
          <n-switch v-model:value="ruleForm.showAdvancedJson" />
          <n-text depth="3" style="font-size: 12px; margin-left: 8px">{{ t('tunnels.advancedModeHint') }}</n-text>
        </n-form-item>
        <n-form-item v-if="ruleForm.showAdvancedJson && needsAdvancedJson" :label="t('tunnels.actionJson')">
          <n-input v-model:value="ruleForm.actionJson" :placeholder="actionJsonPlaceholder" type="textarea" :rows="3" />
        </n-form-item>
        <n-form-item :label="t('tunnels.ruleDescription')">
          <n-input v-model:value="ruleForm.description" :placeholder="t('tunnels.ruleDescPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="ruleExpressionPreview" :label="t('tunnels.generatedExpression')">
          <n-input :value="ruleExpressionPreview" readonly type="textarea" :rows="2" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showRuleModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="ruleSubmitting" @click="submitRule">{{ editingRuleId ? t('common.save') : t('common.create') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 向导结果 Modal ============ -->
    <n-modal v-model:show="showWizardResult" preset="dialog" :title="t('tunnels.wizardResultTitle')" style="width: 480px; max-width: 95vw">
      <n-descriptions label-placement="left" :column="1" bordered size="small">
        <n-descriptions-item :label="t('tunnels.tunnelId')">{{ wizardResult?.tunnelId }}</n-descriptions-item>
        <n-descriptions-item label="Hostname">{{ wizardResult?.hostname }}</n-descriptions-item>
        <n-descriptions-item :label="t('tunnels.cnameTarget')">{{ wizardResult?.cnameTarget }}</n-descriptions-item>
        <n-descriptions-item :label="t('tunnels.modeLabel')">{{ wizardResult?.mode === 'reuse' ? t('tunnels.modeReuseLabel') : t('tunnels.modeCreateLabel') }}</n-descriptions-item>
      </n-descriptions>
      <n-alert v-if="wizardResult?.mode === 'reuse'" type="info" :bordered="false" style="margin-top: 8px">
        {{ t('tunnels.wizardReuseHint') }}
      </n-alert>
      <n-alert v-else type="success" :bordered="false" style="margin-top: 8px">
        {{ t('tunnels.wizardCreateHint') }}
      </n-alert>
      <template #action>
        <n-button @click="showWizardResult = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, h, onMounted, watch, onBeforeUnmount } from 'vue';
import AutoFitTable from '../components/AutoFitTable.vue';
import { useI18n } from 'vue-i18n';
import DOMPurify from 'dompurify';
import { NButton, NSpace, NTag, NPopconfirm } from 'naive-ui';
import { cacheRuleParameters, headerRuleParameters } from '../utils/rulePayload';
import { createRequestScope } from '../utils/requestScope';
import { tunnelsApi } from '../api/tunnels';
import { dnsApi } from '../api/dns';
import { message } from '../utils/discreteApi';

const { t } = useI18n();

// ============ 隧道管理 ============
const selectedAccountId = ref<number | null>(null);
const requests = createRequestScope(() => String(selectedAccountId.value));
const accounts = ref<Array<{ id: number; name: string; account_id: string }>>([]);
const tunnels = ref<any[]>([]);
const loadingAccounts = ref(false);
const loadingTunnels = ref(false);

const accountOptions = computed(() =>
  accounts.value.map((a) => ({ label: `${a.name} (${a.account_id})`, value: a.id }))
);

async function loadAccounts() {
  loadingAccounts.value = true;
  try {
    const { data } = await tunnelsApi.getAccounts();
    accounts.value = data;
    if (accounts.value.length > 0 && !selectedAccountId.value) {
      selectedAccountId.value = accounts.value[0].id;
      await loadTunnels();
    }
  } catch {
    accounts.value = [];
  } finally {
    loadingAccounts.value = false;
  }
}

async function loadTunnels() {
  if (!selectedAccountId.value) { tunnels.value = []; return; }
  loadingTunnels.value = true;
  const request = requests.begin('loadTunnels');
  try {
    const { data } = await tunnelsApi.listTunnels(selectedAccountId.value);
    if (!request.current()) return;
    tunnels.value = data;
  } catch {
    if (!request.current()) return;
    tunnels.value = [];
  } finally {
    if (request.current()) loadingTunnels.value = false;
  }
}

async function onAccountChange() {
  requests.invalidate(); tunnels.value = []; loadingTunnels.value = false;
  showConfigModal.value = false; showTokenModal.value = false; showConnectionsModal.value = false;
  showWizardModal.value = false; showCreateModal.value = false; tokenValue.value = ''; tunnelZones.value = [];

  await loadTunnels();
}

// 创建隧道
const showCreateModal = ref(false);
const newTunnelName = ref('');
const creating = ref(false);

async function submitCreateTunnel() {
  if (!newTunnelName.value || !selectedAccountId.value) return;
  creating.value = true;
  try {
    await tunnelsApi.createTunnel(selectedAccountId.value, newTunnelName.value);
    message.success(t('tunnels.msg.tunnelCreated'));
    showCreateModal.value = false;
    newTunnelName.value = '';
    await loadTunnels();
  } catch {
    // error handled by interceptor
  } finally {
    creating.value = false;
  }
}

// 令牌
const showTokenModal = ref(false);
const tokenValue = ref('');

async function showToken(tunnelId: string) {
  if (!selectedAccountId.value) return;
  const request = requests.begin('showToken');
  try {
    const { data } = await tunnelsApi.getToken(selectedAccountId.value, tunnelId);
    if (!request.current()) return;
    tokenValue.value = data.token;
    showTokenModal.value = true;
  } catch {
    if (!request.current()) return;
    // error handled by interceptor
  }
}

function copyToken() {
  navigator.clipboard.writeText(tokenValue.value).then(() => message.success(t('tunnels.msg.copied')));
}

// 连接信息
const showConnectionsModal = ref(false);
const connections = ref<any[]>([]);

const connectionColumns = computed(() => [
  { title: 'ID', key: 'id', ellipsis: { tooltip: true } },
  { title: t('tunnels.table.colo'), key: 'colo_name' },
  { title: t('tunnels.table.version'), key: 'version' },
  { title: t('tunnels.table.ip'), key: 'ip' },
]);

async function showConnections(tunnelId: string) {
  if (!selectedAccountId.value) return;
  const request = requests.begin('showConnections');
  try {
    const { data } = await tunnelsApi.getConnections(selectedAccountId.value, tunnelId);
    if (!request.current()) return;
    connections.value = data;
    showConnectionsModal.value = true;
  } catch {
    if (!request.current()) return;
    // error handled by interceptor
  }
}

// 删除隧道
async function deleteTunnel(tunnelId: string) {
  if (!selectedAccountId.value) return;
  try {
    await tunnelsApi.deleteTunnel(selectedAccountId.value, tunnelId);
    message.success(t('tunnels.msg.tunnelDeleted'));
    await loadTunnels();
  } catch {
    // error handled by interceptor
  }
}

// Ingress 配置管理
const showConfigModal = ref(false);
const configTunnelId = ref('');
const configTunnelName = ref('');
const loadingConfig = ref(false);
const savingConfig = ref(false);
const ingressEntries = ref<Array<{ domain: string; subdomain: string; path: string; protocol: string; port: number; customService: string }>>([]);
const tunnelZones = ref<Array<{ id: string; name: string }>>([]);
const zoneOptions = computed(() => tunnelZones.value.map((z) => ({ label: z.name, value: z.name })));

const protocolOptions = computed(() => [
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'TCP', value: 'tcp' },
  { label: t('common.custom'), value: 'custom' },
]);

async function openConfig(tunnelId: string, name: string) {
  if (!selectedAccountId.value) return;
  configTunnelId.value = tunnelId;
  configTunnelName.value = name;
  showConfigModal.value = true;
  loadingConfig.value = true;
  const request = requests.begin('openConfig');
  try {
    const [configRes, zonesRes] = await Promise.all([
      tunnelsApi.getConfig(selectedAccountId.value, tunnelId),
      tunnelsApi.getZones(selectedAccountId.value),
    ]);
    if (!request.current()) return;
    tunnelZones.value = zonesRes.data || [];
    const ingress = configRes.data || [];
    ingressEntries.value = ingress.map((e: any) => {
      const hostname = e.hostname || '';
      const service = e.service || '';
      // 尝试从 service 解析出 protocol + port
      const m = service.match(/^(https?|tcp):\/\/localhost:(\d+)$/);
      const proto = m ? m[1] : 'custom';
      const port = m ? parseInt(m[2], 10) : 0;
      const customService = m ? '' : service;
      const path = e.path || '';
      // 从 hostname 中拆分出 domain (zone apex) 和 subdomain
      if (!hostname) return { domain: '', subdomain: '', path, protocol: proto, port, customService };
      const zone = tunnelZones.value.find((z) => hostname === z.name || hostname.endsWith('.' + z.name));
      if (zone) {
        const subdomain = hostname === zone.name ? '' : hostname.slice(0, -(zone.name.length + 1));
        return { domain: zone.name, subdomain, path, protocol: proto, port, customService };
      }
      // 未找到匹配的 zone，将整个 hostname 放入 subdomain
      return { domain: '', subdomain: hostname, path, protocol: proto, port, customService };
    });
    if (ingressEntries.value.length === 0) {
      ingressEntries.value = [{ domain: '', subdomain: '', path: '', protocol: 'custom', port: 0, customService: 'http_status:404' }];
    }
  } catch {
    if (!request.current()) return;
    ingressEntries.value = [{ domain: '', subdomain: '', path: '', protocol: 'custom', port: 0, customService: 'http_status:404' }];
    tunnelZones.value = [];
  } finally {
    if (request.current()) loadingConfig.value = false;
  }
}

function addIngressEntry() {
  // 在 catch-all 之前插入新规则
  const catchAll = ingressEntries.value[ingressEntries.value.length - 1];
  if (catchAll && !catchAll.domain) {
    ingressEntries.value.splice(ingressEntries.value.length - 1, 0, { domain: '', subdomain: '', path: '', protocol: 'http', port: 8080, customService: '' });
  } else {
    ingressEntries.value.push({ domain: '', subdomain: '', path: '', protocol: 'http', port: 8080, customService: '' });
  }
}

function removeIngressEntry(idx: number) {
  ingressEntries.value.splice(idx, 1);
}

async function saveConfig() {
  if (!selectedAccountId.value) return;
  savingConfig.value = true;
  try {
    // 确保最后一条是 catch-all
    const last = ingressEntries.value[ingressEntries.value.length - 1];
    if (last && last.domain) {
      ingressEntries.value.push({ domain: '', subdomain: '', path: '', protocol: 'custom', port: 0, customService: 'http_status:404' });
    }
    const ingress = ingressEntries.value.map((e) => {
      const entry: any = {};
      // 组合 domain + subdomain 为 hostname
      if (e.domain) {
        entry.hostname = e.subdomain ? `${e.subdomain}.${e.domain}` : e.domain;
      }
      if (e.path) entry.path = e.path;
      // 组合 service
      entry.service = e.protocol === 'custom' ? e.customService : `${e.protocol}://localhost:${e.port}`;
      return entry;
    });
    await tunnelsApi.updateConfig(selectedAccountId.value, configTunnelId.value, ingress);
    message.success(t('tunnels.msg.configSaved'));
    showConfigModal.value = false;
  } catch {
    // error handled by interceptor
  } finally {
    savingConfig.value = false;
  }
}

// 隧道表格列
const tunnelColumns = computed(() => [
  { title: t('tunnels.table.name'), key: 'name', ellipsis: { tooltip: true } },
  { title: t('tunnels.table.id'), key: 'id', ellipsis: { tooltip: true } },
  { title: t('tunnels.table.status'), key: 'status', render: (row: any) => h(NTag, { type: row.status === 'healthy' ? 'success' : 'default', size: 'small' }, { default: () => row.status || '-' }) },
  { title: t('tunnels.table.connections'), key: 'connections', render: (row: any) => row.connections?.length || 0 },
  {
    title: t('tunnels.table.actions'),
    key: 'actions',
    render: (row: any) => h(NSpace, { size: 'small' }, {
      default: () => [
        h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => showToken(row.id) }, { default: () => t('tunnels.table.token') }),
        h(NButton, { size: 'small', quaternary: true, type: 'info', onClick: () => openConfig(row.id, row.name) }, { default: () => t('tunnels.table.config') }),
        h(NButton, { size: 'small', quaternary: true, onClick: () => showConnections(row.id) }, { default: () => t('tunnels.table.connect') }),
        h(NPopconfirm, { onPositiveClick: () => deleteTunnel(row.id) }, {
          trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('tunnels.table.deleteConfirm', { name: row.name }),
        }),
      ],
    }),
  },
]);

// ============ 一键回源向导 ============
const showWizardModal = ref(false);
const wizardLoading = ref(false);
const wizard = reactive({
  mode: 'create' as 'create' | 'reuse',
  tunnelId: '',
  tunnelName: '',
  domain: '',
  subdomain: '',
  protocol: 'http',
  port: 8080,
  path: '',
});

const showWizardResult = ref(false);
const wizardResult = ref<{ tunnelId: string; hostname: string; cnameTarget: string; mode: string } | null>(null);

const tunnelSelectOptions = computed(() =>
  tunnels.value.map((t_val) => ({ label: `${t_val.name} (${t_val.id})`, value: t_val.id }))
);

function openWizard() {
  wizard.mode = 'create';
  wizard.tunnelId = '';
  wizard.tunnelName = '';
  wizard.domain = '';
  wizard.subdomain = '';
  wizard.protocol = 'http';
  wizard.port = 8080;
  wizard.path = '';
  showWizardModal.value = true;
  // 加载 zones 供域名选择
  if (selectedAccountId.value) {
    tunnelsApi.getZones(selectedAccountId.value).then(({ data }) => {
      tunnelZones.value = data || [];
    }).catch(() => { tunnelZones.value = []; });
  }
}

async function submitWizard() {
  if (!selectedAccountId.value || !wizard.domain || !wizard.port) return;
  wizardLoading.value = true;
  try {
    const hostname = wizard.subdomain ? `${wizard.subdomain}.${wizard.domain}` : wizard.domain;
    const payload: any = {
      mode: wizard.mode,
      hostname,
      port: wizard.port,
      protocol: wizard.protocol,
    };
    if (wizard.path) payload.path = wizard.path;
    if (wizard.mode === 'reuse') {
      payload.tunnelId = wizard.tunnelId;
    } else if (wizard.tunnelName) {
      payload.tunnelName = wizard.tunnelName;
    }
    const { data } = await tunnelsApi.runWizard(selectedAccountId.value, payload);
    wizardResult.value = data;
    showWizardModal.value = false;
    showWizardResult.value = true;
    await loadTunnels();
    message.success(t('tunnels.msg.wizardSuccess'));
  } catch {
    // error handled by interceptor
  } finally {
    wizardLoading.value = false;
  }
}

// ============ 回源规则 ============
const selectedDomain = ref<string | null>(null);
const selectedRulePhase = ref<string>('http_request_origin');
const rulePhaseOptions = computed(() => [
  { label: t('tunnels.rulePhases.origin'), value: 'http_request_origin' },
  { label: t('tunnels.rulePhases.redirect'), value: 'http_request_redirect' },
  { label: t('tunnels.rulePhases.transform'), value: 'http_request_transform' },
  { label: t('tunnels.rulePhases.requestHeaders'), value: 'http_request_late_transform' },
  { label: t('tunnels.rulePhases.responseHeaders'), value: 'http_response_headers_transform' },
  { label: t('tunnels.rulePhases.cacheSettings'), value: 'http_request_cache_settings' },
  { label: t('tunnels.rulePhases.firewall'), value: 'http_request_firewall_custom' },
  { label: t('tunnels.rulePhases.rateLimit'), value: 'http_ratelimit' },
]);
const domains = ref<any[]>([]);
const selectedZone = computed(() => domains.value.find(d => `${d.cfAccountId}:${d.id}` === selectedDomain.value));
const selectedDomainName = computed<string>(() => selectedZone.value?.name || '');
const ruleContext = computed(() => ({ accountId: selectedZone.value?.cfAccountId, zoneId: selectedZone.value?.id }));
const rules = ref<any[]>([]);
const loadingRules = ref(false);

const domainOptions = computed(() =>
  domains.value.map((d) => ({ label: `${d.name} (${d.accountName} / ${d.cfAccountId})`, value: `${d.cfAccountId}:${d.id}` }))
);

// 账户级 Phase 检测
const ACCOUNT_LEVEL_PHASES = new Set(['http_request_redirect', 'http_request_dynamic_redirect']);
const isAccountLevelPhase = computed(() => ACCOUNT_LEVEL_PHASES.has(selectedRulePhase.value));

async function loadDomains() {
  try {
    const { data } = await dnsApi.getDomains();
    domains.value = data;
  } catch {
    domains.value = [];
  }
}

async function onDomainChange() {
  await loadRules();
}

async function loadRules() {
  if (!selectedDomainName.value || !selectedRulePhase.value) { rules.value = []; return; }
  loadingRules.value = true;
  const request = requests.begin('loadRules', () => `${selectedDomain.value}:${selectedRulePhase.value}`);
  try {
    const { data } = await tunnelsApi.listRules(selectedDomainName.value, selectedRulePhase.value, ruleContext.value);
    if (!request.current()) return;
    rules.value = data;
  } catch {
    if (!request.current()) return;
    rules.value = [];
  } finally {
    if (request.current()) loadingRules.value = false;
  }
}

// 规则表单
const showRuleModal = ref(false);
const editingRuleId = ref<string | null>(null);
const originalRuleParams = ref<Record<string, unknown>>({});
const originalRuleEnabled = ref(true);
const ruleSubmitting = ref(false);
const ruleForm = reactive({
  matchType: 'hostname' as 'hostname' | 'pathPrefix' | 'pathRegex' | 'hostAndPath' | 'custom',
  subdomain: '',
  pathValue: '',
  expression: '',
  port: 80,
  description: '',
  redirectUrl: '',
  redirectStatus: 301,
  actionJson: '',
  showAdvancedJson: false,
  // URL 重写
  rewriteType: 'path' as 'path' | 'query',
  rewriteValue: '',
  // Header 转换
  headerOp: 'set' as 'set' | 'add' | 'remove',
  headerName: '',
  headerValue: '',
  // 缓存设置
  cacheEnabled: true,
  cacheTtlMode: 'respect_origin' as 'respect_origin' | 'custom',
  cacheTtlValue: 3600,
  // 速率限制
  ratelimitAction: 'block' as 'block' | 'challenge' | 'js_challenge',
  ratelimitChars: ['ip.src'] as string[],
  ratelimitPeriod: 60,
  ratelimitCount: 100,
  ratelimitMitigation: 60,
});

// 计算属性：各类 select 选项
const matchTypeOptions = computed(() => [
  { label: t('tunnels.matchTypes.hostname'), value: 'hostname' },
  { label: t('tunnels.matchTypes.pathPrefix'), value: 'pathPrefix' },
  { label: t('tunnels.matchTypes.pathRegex'), value: 'pathRegex' },
  { label: t('tunnels.matchTypes.hostAndPath'), value: 'hostAndPath' },
  { label: t('tunnels.matchTypes.custom'), value: 'custom' },
]);

const statusCodeOptions = computed(() => [
  { label: t('tunnels.status301'), value: 301 },
  { label: t('tunnels.status302'), value: 302 },
  { label: t('tunnels.status307'), value: 307 },
  { label: t('tunnels.status308'), value: 308 },
]);

const rewriteTypeOptions = computed(() => [
  { label: t('tunnels.rewritePath'), value: 'path' },
  { label: t('tunnels.rewriteQuery'), value: 'query' },
]);

const headerOpOptions = computed(() => [
  { label: t('tunnels.headerSet'), value: 'set' },
    { label: t('tunnels.headerRemove'), value: 'remove' },
]);

const ttlModeOptions = computed(() => [
  { label: t('tunnels.ttlRespectOrigin'), value: 'respect_origin' },
  { label: t('tunnels.ttlCustom'), value: 'custom' },
]);

const ratelimitActionOptions = computed(() => [
  { label: t('tunnels.ratelimitBlock'), value: 'block' },
  { label: t('tunnels.ratelimitChallenge'), value: 'challenge' },
  { label: t('tunnels.ratelimitJsChallenge'), value: 'js_challenge' },
]);

const ratelimitDimensionOptions = computed(() => [
  { label: t('tunnels.ratelimitIp'), value: 'ip.src' },
  { label: t('tunnels.ratelimitPath'), value: 'http.request.uri.path' },
  { label: t('tunnels.ratelimitHost'), value: 'http.host' },
]);

// 需要结构化表单的 Phase
const needsAdvancedJson = computed(() => [
  'http_request_transform',
  'http_request_late_transform',
  'http_response_headers_transform',
  'http_request_cache_settings',
  'http_ratelimit',
].includes(selectedRulePhase.value));

// 根据 phase 提供 action JSON 的占位提示
const actionJsonPlaceholder = computed(() => {
  switch (selectedRulePhase.value) {
    case 'http_request_transform':
      return '{"action":"rewrite","action_parameters":{"uri":{"path":{"expression":"${http.request.uri.path}"}}}}';
    case 'http_request_late_transform':
      return '{"action":"rewrite","action_parameters":{"headers":{"request":{"set":{"X-Custom-Header":"value"}}}}}';
    case 'http_response_headers_transform':
      return '{"action":"rewrite","action_parameters":{"headers":{"response":{"set":{"X-Frame-Options":"DENY"}}}}}';
    case 'http_request_cache_settings':
      return '{"action":"set_cache_settings","action_parameters":{"cache":true,"edge_ttl":{"mode":"respect_origin_ttl"}}}';
    case 'http_ratelimit':
      return '{"action":"block","action_parameters":{"characteristics":["ip"],"period":60,"requests_per_period":100}}';
    default:
      return '{"action":"rewrite","action_parameters":{...}}';
  }
});

// 根据 subdomain + selectedDomain 计算 hostname
const ruleHostname = computed(() => {
  if (!selectedDomainName.value) return '';
  return ruleForm.subdomain ? `${ruleForm.subdomain}.${selectedDomainName.value}` : selectedDomainName.value;
});

const ruleExpressionPreview = computed(() => {
  switch (ruleForm.matchType) {
    case 'hostname':
      if (!ruleHostname.value) return '';
      return `(http.host eq "${ruleHostname.value}")`;
    case 'pathPrefix':
      if (!ruleForm.pathValue) return '';
      return `(http.request.uri.path matches "^${ruleForm.pathValue}.*")`;
    case 'pathRegex':
      if (!ruleForm.pathValue) return '';
      return `(http.request.uri.path matches "${ruleForm.pathValue}")`;
    case 'hostAndPath':
      if (!ruleHostname.value || !ruleForm.pathValue) return '';
      return `(http.host eq "${ruleHostname.value}" and http.request.uri.path matches "^${ruleForm.pathValue}.*")`;
    case 'custom':
      return ruleForm.expression;
    default:
      return '';
  }
});

function openAddRule() {
  originalRuleParams.value = {}; originalRuleEnabled.value = true;
  editingRuleId.value = null;
  ruleForm.matchType = 'hostname';
  ruleForm.subdomain = '';
  ruleForm.pathValue = '';
  ruleForm.expression = '';
  ruleForm.port = 80;
  ruleForm.description = '';
  ruleForm.redirectUrl = '';
  ruleForm.redirectStatus = 301;
  ruleForm.actionJson = '';
  ruleForm.showAdvancedJson = false;
  ruleForm.rewriteType = 'path';
  ruleForm.rewriteValue = '';
  ruleForm.headerOp = 'set';
  ruleForm.headerName = '';
  ruleForm.headerValue = '';
  ruleForm.cacheEnabled = true;
  ruleForm.cacheTtlMode = 'respect_origin';
  ruleForm.cacheTtlValue = 3600;
  ruleForm.ratelimitAction = 'block';
  ruleForm.ratelimitChars = ['ip'];
  ruleForm.ratelimitPeriod = 60;
  ruleForm.ratelimitCount = 100;
  ruleForm.ratelimitMitigation = 60;
  showRuleModal.value = true;
}

function openEditRule(row: any) {
  originalRuleParams.value = { ...(row.action_parameters || {}) }; originalRuleEnabled.value = row.enabled !== false;
  editingRuleId.value = row.id;
  ruleForm.expression = row.expression || '';
  ruleForm.description = row.description || '';
  ruleForm.port = 80;
  ruleForm.redirectUrl = '';
  ruleForm.redirectStatus = 301;
  ruleForm.actionJson = '';

  // 解析 action_parameters 到表单字段
  const ap = row.action_parameters || {};
  if (ap.origin?.port) {
    ruleForm.port = ap.origin.port;
  }
  if (row.action === 'redirect' && ap.from_value) {
    ruleForm.redirectUrl = ap.from_value.target?.url || '';
    ruleForm.redirectStatus = ap.from_value.status_code || 301;
  }

  // 重置结构化表单字段
  ruleForm.showAdvancedJson = false;
  ruleForm.actionJson = '';
  ruleForm.rewriteType = 'path';
  ruleForm.rewriteValue = '';
  ruleForm.headerOp = 'set';
  ruleForm.headerName = '';
  ruleForm.headerValue = '';
  ruleForm.cacheEnabled = true;
  ruleForm.cacheTtlMode = 'respect_origin';
  ruleForm.cacheTtlValue = 3600;
  ruleForm.ratelimitAction = 'block';
  ruleForm.ratelimitChars = ['ip'];
  ruleForm.ratelimitPeriod = 60;
  ruleForm.ratelimitCount = 100;
  ruleForm.ratelimitMitigation = 60;

  // URL 重写
  if (ap.uri?.path?.expression) {
    ruleForm.rewriteType = 'path';
    ruleForm.rewriteValue = ap.uri.path.expression;
  } else if (ap.uri?.query?.expression) {
    ruleForm.rewriteType = 'query';
    ruleForm.rewriteValue = ap.uri.query.expression;
  }

  // Real CF header operations are keyed by header name, without request/response wrappers.
  const headers = Object.entries(ap.headers || {}) as Array<[string, { operation: string; value?: string; expression?: string }]>;
  if (headers.length === 1 && !headers[0][1].expression) {
    ruleForm.headerName = headers[0][0]; ruleForm.headerOp = headers[0][1].operation as 'set' | 'remove';
    ruleForm.headerValue = headers[0][1].value || '';
  }

  // 缓存设置
  if (typeof ap.cache === 'boolean') {
    ruleForm.cacheEnabled = ap.cache;
    if (ap.edge_ttl?.mode === 'override_origin' && ap.edge_ttl?.default != null) {
      ruleForm.cacheTtlMode = 'custom';
      ruleForm.cacheTtlValue = ap.edge_ttl.default;
    } else {
      ruleForm.cacheTtlMode = 'respect_origin';
    }
  }

  // 速率限制
  if (row.ratelimit?.characteristics || row.ratelimit?.period || row.ratelimit?.requests_per_period) {
    ruleForm.ratelimitAction = row.action || 'block';
    ruleForm.ratelimitChars = row.ratelimit?.characteristics?.filter((field: string) => field !== 'cf.colo.id') || ['ip.src'];
    ruleForm.ratelimitPeriod = row.ratelimit?.period || 60;
    ruleForm.ratelimitCount = row.ratelimit?.requests_per_period || 100;
    ruleForm.ratelimitMitigation = row.ratelimit?.mitigation_timeout ?? 60;
  }

  // 无法解析到结构化字段时，启用高级模式
  const hasStructured = ruleForm.rewriteValue || ruleForm.headerName ||
    (typeof ap.cache === 'boolean') || ap.characteristics ||
    ['route', 'redirect', 'block'].includes(row.action);
  if (!hasStructured && row.action) {
    ruleForm.showAdvancedJson = true;
    ruleForm.actionJson = JSON.stringify({ action: row.action, action_parameters: ap, ...(row.ratelimit ? { ratelimit: row.ratelimit } : {}) });
  }

  // 尝试从表达式解析出匹配类型和值
  const expr = row.expression || '';
  const hostMatch = expr.match(/http\.host eq "([^"]+)"/);
  const pathMatch = expr.match(/http\.request\.uri\.path matches "([^"]+)"/);
  if (hostMatch && pathMatch) {
    ruleForm.matchType = 'hostAndPath';
    ruleForm.pathValue = pathMatch[1].replace(/^\^/, '').replace(/\.\*$/, '');
  } else if (hostMatch) {
    ruleForm.matchType = 'hostname';
  } else if (pathMatch) {
    ruleForm.pathValue = pathMatch[1];
    if (pathMatch[1].startsWith('^')) {
      ruleForm.matchType = 'pathPrefix';
      ruleForm.pathValue = pathMatch[1].replace(/^\^/, '').replace(/\.\*$/, '');
    } else {
      ruleForm.matchType = 'pathRegex';
    }
  } else {
    ruleForm.matchType = 'custom';
  }

  // 从 hostname 中拆分出 subdomain
  if (hostMatch && selectedDomainName.value) {
    const fullHost = hostMatch[1];
    if (fullHost === selectedDomainName.value) {
      ruleForm.subdomain = '';
    } else if (fullHost.endsWith('.' + selectedDomainName.value)) {
      ruleForm.subdomain = fullHost.slice(0, -(selectedDomainName.value.length + 1));
    } else {
      ruleForm.subdomain = '';
      ruleForm.matchType = 'custom';
      ruleForm.expression = expr;
    }
  } else {
    ruleForm.subdomain = '';
  }

  showRuleModal.value = true;
}

function buildExpression(): string {
  return ruleExpressionPreview.value;
}
async function submitRule() {
  if (!selectedDomainName.value || !selectedRulePhase.value) return;
  const phase = selectedRulePhase.value;
  // 回源规则需要端口
  if (phase === 'http_request_origin' && !ruleForm.port) return;
  const expression = buildExpression();
  if (!expression) return;
  ruleSubmitting.value = true;
  try {
    // 根据 phase 确定 action 和 action_parameters
    let action = 'route';
    let action_parameters: any = {};
    let ratelimit: Record<string, unknown> | undefined;
    if (phase === 'http_request_origin') {
      action = 'route';
      action_parameters = { origin: { port: ruleForm.port } };
    } else if (phase === 'http_request_redirect') {
      action = 'redirect';
      action_parameters = { from_value: { target: { url: ruleForm.redirectUrl || '' }, status_code: ruleForm.redirectStatus || 301 } };
    } else if (phase === 'http_request_firewall_custom') {
      action = 'block';
      action_parameters = {};
    } else if (ruleForm.showAdvancedJson && ruleForm.actionJson) {
      // 高级模式：用户自定义 action + action_parameters
      const parsed = JSON.parse(ruleForm.actionJson);
      action = parsed.action || action;
      action_parameters = parsed.action_parameters || action_parameters;
      ratelimit = parsed.ratelimit;
    } else if (phase === 'http_request_transform') {
      // URL 重写
      action = 'rewrite';
      const key = ruleForm.rewriteType === 'path' ? 'path' : 'query';
      action_parameters = { uri: { [key]: { expression: ruleForm.rewriteValue } } };
    } else if (phase === 'http_request_late_transform' || phase === 'http_response_headers_transform') {
      // Header 转换
      action = 'rewrite';
      action_parameters = headerRuleParameters(ruleForm.headerName, ruleForm.headerOp === 'remove' ? 'remove' : 'set', ruleForm.headerValue || '');
    } else if (phase === 'http_request_cache_settings') {
      action = 'set_cache_settings';
      action_parameters = cacheRuleParameters(ruleForm.cacheEnabled, ruleForm.cacheTtlMode, ruleForm.cacheTtlValue, originalRuleParams.value);
    } else if (phase === 'http_ratelimit') {
      // 速率限制
      action = ruleForm.ratelimitAction;
      ratelimit = {
        characteristics: [...new Set(['cf.colo.id', ...ruleForm.ratelimitChars])],
        period: ruleForm.ratelimitPeriod,
        requests_per_period: ruleForm.ratelimitCount,
        mitigation_timeout: ruleForm.ratelimitMitigation,
      };
    }
    const payload = {
      expression,
      action,
      action_parameters: ruleForm.showAdvancedJson ? action_parameters : { ...originalRuleParams.value, ...action_parameters }, ratelimit, enabled: originalRuleEnabled.value,
      description: ruleForm.description || undefined,
    };
    if (editingRuleId.value) {
      await tunnelsApi.updateRule(selectedDomainName.value, phase, editingRuleId.value, payload, ruleContext.value);
      message.success(t('tunnels.msg.ruleUpdated'));
    } else {
      await tunnelsApi.createRule(selectedDomainName.value, phase, payload, ruleContext.value);
      message.success(t('tunnels.msg.ruleCreated'));
    }
    showRuleModal.value = false;
    await loadRules();
  } catch {
    // error handled by interceptor
  } finally {
    ruleSubmitting.value = false;
  }
}

async function deleteRule(ruleId: string) {
  if (!selectedDomainName.value || !selectedRulePhase.value) return;
  try {
    await tunnelsApi.deleteRule(selectedDomainName.value, selectedRulePhase.value, ruleId, ruleContext.value);
    message.success(t('tunnels.msg.ruleDeleted'));
    await loadRules();
  } catch {
    // error handled by interceptor
  }
}

// 规则表格列
const ruleColumns = computed(() => [
  { title: t('tunnels.table.description'), key: 'description', ellipsis: { tooltip: true }, render: (row: any) => row.description || '-' },
  { title: t('tunnels.table.expression'), key: 'expression', ellipsis: { tooltip: true } },
  { title: t('tunnels.table.action'), key: 'action', render: (row: any) => h(NTag, { size: 'small' }, { default: () => row.action || '-' }) },
  { title: t('tunnels.table.params'), key: 'params', ellipsis: { tooltip: true }, render: (row: any) => JSON.stringify(row.action_parameters || {}).slice(0, 60) },
  { title: t('tunnels.table.status'), key: 'enabled', render: (row: any) => h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small' }, { default: () => row.enabled ? t('tunnels.table.enabled') : t('tunnels.table.disabled') }) },
  {
    title: t('tunnels.table.actions'),
    key: 'actions',
    render: (row: any) => h(NSpace, { size: 'small' }, {
      default: () => [
        h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => openEditRule(row) }, { default: () => t('common.edit') }),
        h(NPopconfirm, { onPositiveClick: () => deleteRule(row.id) }, {
          trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('tunnels.table.ruleDeleteConfirm'),
        }),
      ],
    }),
  },
]);

watch(() => [selectedDomain.value, selectedRulePhase.value], () => { rules.value = []; showRuleModal.value = false; });
onBeforeUnmount(() => requests.invalidate());

// ============ 初始化 ============
onMounted(async () => {
  await loadAccounts();
  await loadDomains();
});
</script>

<style scoped>
.tunnel-tab-content {
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1 1 0%;
  min-height: 0;
  height: 100%;
}
</style>

<style scoped>
.page-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}
</style>
