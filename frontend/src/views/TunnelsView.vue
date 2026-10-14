<template>
  <div class="page-view">
    <n-tabs v-model:value="activeTab" type="line" @update:value="onTabChange">
      <!-- ============ 隧道管理 ============ -->
      <n-tab-pane name="tunnels" :tab="t('tunnels.tunnelManagement')">
        <div class="tunnel-tab-content">
          <n-space align="center">
            <n-select
              :value="selectedAccountId"
              :options="accountOptions"
              :render-label="renderAccountOption"
              :placeholder="t('tunnels.selectAccount')"
              filterable
              style="width: 480px; max-width: 100%"
              @update:value="selectAccount"
            />
            <n-button type="primary" size="small" :disabled="!selectedAccountId" @click="showCreateModal = true">{{ t('tunnels.createTunnel') }}</n-button>
            <n-button size="small" :disabled="!selectedAccountId" @click="openWizard">{{ t('tunnels.wizard') }}</n-button>
            <n-button size="small" @click="refreshTunnels" :loading="loadingAccounts || loadingTunnels">{{ t('tunnels.refresh') }}</n-button>
          </n-space>

          <n-alert v-if="tunnelError" type="error">{{ tunnelError }} <n-button size="small" @click="loadTunnels(true)">重试</n-button></n-alert>
          <n-text v-if="tunnelsFetchedAt" depth="3">读取时间：{{ new Date(tunnelsFetchedAt).toLocaleTimeString() }}</n-text>
          <AutoFitTable
            :columns="tunnelColumns"
            :data="tunnels"
            :loading="loadingTunnels && tunnels.length === 0"
            :scroll-x="600"
          />
        </div>
      </n-tab-pane>

      <!-- ============ 规则引擎 ============ -->
      <n-tab-pane name="rules-engine" :tab="t('tunnels.rulesEngine')">
        <div class="tunnel-tab-content">
          <n-space align="center">
            <n-select :value="selectedRuleAccountId" :options="accountOptions" :render-label="renderAccountOption" filterable style="width: 380px; max-width: 100%" @update:value="changeRuleAccount" />
            <n-select v-if="!isAccountLevelPhase"
              :value="selectedDomain"
              :options="domainOptions"
              :placeholder="t('tunnels.selectDomain')"
              filterable
              style="width: 220px"
              @update:value="onDomainChange"
            />
            <n-select
              :value="selectedRulePhase"
              :options="rulePhaseOptions"
              :placeholder="t('tunnels.rulePhase')"
              style="width: 180px"
              @update:value="changeRulePhase"
            />
            <n-button type="primary" size="small" :disabled="!ruleTargetReady || !!ruleError || loadingRules" @click="openAddRule">{{ t('tunnels.addRule') }}</n-button>
            <n-button size="small" @click="loadDomains(true)">{{ t('tunnels.refreshDomains') }}</n-button>
          </n-space>

          <n-button size="small" :disabled="!ruleTargetReady" @click="loadRules(true)">刷新规则</n-button>
          <n-alert v-if="ruleError || domainsError" type="error">{{ ruleError || domainsError }} <n-button size="small" @click="loadRules(true)">重试规则</n-button></n-alert>
          <n-text depth="3">{{ ruleError && !rulesFetchedAt ? '数量未确认' : rules.length + ' 条规则' }}{{ loadingRules ? ' · 刷新中' : '' }} · {{ isAccountLevelPhase ? 'Account' : 'Zone' }} · {{ rulesFetchedAt ? new Date(rulesFetchedAt).toLocaleTimeString() : '未加载' }}</n-text>
          <n-alert v-if="isAccountLevelPhase" type="info" :bordered="false" style="margin-top: 4px">
            <span v-html="DOMPurify.sanitize(t('tunnels.accountLevelHint'))"></span>
          </n-alert>
          <AutoFitTable
            :columns="ruleColumns"
            :data="rules"
            :loading="loadingRules && rules.length === 0"
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
    <n-modal v-model:show="showWizardModal" preset="dialog" :mask-closable="false" :close-on-esc="false" :closable="!wizardLoading" :title="t('tunnels.wizardTitle')" style="width: 520px; max-width: 95vw">
      <n-alert v-if="zonesError" type="error">{{ zonesError }} <n-button @click="readWizardZones">重试域名列表</n-button></n-alert>
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
          <n-button :disabled="wizardLoading" @click="showWizardModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="wizardLoading" :disabled="!wizard.domain || !wizard.port" @click="submitWizard">{{ t('tunnels.execute') }}</n-button>
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
      <n-button size="small" @click="showConnections(connectionsTunnelId, true)">刷新连接</n-button>
      <n-text depth="3">读取时间：{{ new Date(connectionsFetchedAt).toLocaleTimeString() }}</n-text>
      <n-data-table :columns="connectionColumns" :data="connections" size="small" :bordered="false" />
      <template #action>
        <n-button @click="showConnectionsModal = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>

    <!-- Full baseline and immutable unknown fields survive visual edits. -->
    <n-modal :show="showConfigModal" preset="dialog" :mask-closable="false" :close-on-esc="false" :closable="!savingConfig" :title="t('tunnels.configTitle', { name: configTunnelName })" style="width: 900px; max-width: 95vw" @update:show="closeConfig">
      <div style="max-height: 65vh; overflow: auto">
        <n-space vertical>
          <n-alert :type="configError ? 'error' : 'info'">{{ configStatus }}{{ configDirty ? ' · 有未保存修改' : '' }}{{ configError ? ' · ' + configError : '' }}</n-alert>
          <n-space>
            <n-button size="small" :loading="loadingConfig" :disabled="savingConfig" @click="readConfig">重新读取配置</n-button>
            <n-button size="small" :disabled="savingConfig" @click="readConfigZones">重试域名列表</n-button>
            <n-button size="small" :disabled="!configBaseline || savingConfig" @click="discardConfig">放弃草稿 / 使用远程配置</n-button>
          </n-space>
          <n-alert v-if="zonesError" type="warning">{{ zonesError }}（域名选择不可用，已读取配置保留）</n-alert>
          <n-alert type="info">保留全部高级字段。保存会重新检查远程基线；检查与 PUT 之间仍可能发生并发变化。</n-alert>
          <div v-for="(entry, idx) in ingressEntries" :key="entry.key" class="ingress-row">
            <n-text>{{ idx + 1 }}{{ idx === ingressEntries.length - 1 ? ' · Catch-all' : '' }}</n-text>
            <n-input v-model:value="entry.hostname" placeholder="完整 hostname（路径规则可为空）" :disabled="!configBaseline || savingConfig || idx === ingressEntries.length - 1" />
            <n-select v-if="idx < ingressEntries.length - 1" :options="zoneOptions" :disabled="!!zonesError || savingConfig" placeholder="选择域名（可选，填入 hostname）" clearable @update:value="(value: string | null) => { if (value) entry.hostname = value }" />
            <n-input v-model:value="entry.path" placeholder="Path / 正则" :disabled="!configBaseline || savingConfig || idx === ingressEntries.length - 1" />
            <n-input v-model:value="entry.service" placeholder="原始 service，例如 tcp://host:22、http_status:404" :disabled="!configBaseline || savingConfig" />
            <n-space v-if="idx < ingressEntries.length - 1">
              <n-button size="tiny" :disabled="idx === 0 || savingConfig" @click="moveIngress(idx, -1)">上移</n-button>
              <n-button size="tiny" :disabled="idx >= ingressEntries.length - 2 || savingConfig" @click="moveIngress(idx, 1)">下移</n-button>
              <n-button size="tiny" type="error" :disabled="savingConfig" @click="removeIngressEntry(idx)">删除</n-button>
            </n-space>
            <details><summary>完整规则 / 高级字段</summary><pre>{{ JSON.stringify(entry.original, null, 2) }}</pre></details>
          </div>
          <n-button v-if="configBaseline && !ingressEntries.length" size="small" :disabled="savingConfig" @click="initializeIngress">为已确认空配置添加 Catch-all</n-button>
          <n-button v-else size="small" :disabled="!configBaseline || savingConfig" @click="addIngressEntry">添加规则</n-button>
          <details v-if="configBaseline" :open="configDirty"><summary>保存前后完整配置 Diff</summary><div class="config-diff"><pre>{{ JSON.stringify(configBaseline.config, null, 2) }}</pre><pre>{{ JSON.stringify(configDraft, null, 2) }}</pre></div></details>
          <details v-if="configRemote"><summary>最新 Cloudflare 配置</summary><pre>{{ JSON.stringify(configRemote.config, null, 2) }}</pre></details>
        </n-space>
      </div>
      <template #action><n-space>
        <n-button :disabled="savingConfig" @click="closeConfig">取消</n-button>
        <n-button type="primary" :loading="savingConfig" :disabled="!canSaveConfig" @click="confirmSaveConfig">保存配置</n-button>
      </n-space></template>
    </n-modal>

    <!-- ============ 规则 Modal ============ -->
    <n-modal :show="showRuleModal" @update:show="closeRule" :mask-closable="false" :close-on-esc="false" :closable="!ruleSubmitting" preset="dialog" :title="editingRuleId ? t('tunnels.ruleModalTitleEdit') : t('tunnels.ruleModalTitleAdd')" style="width: 520px; max-width: 95vw">
      <n-form v-if="!editingRuleId" label-placement="left" label-width="100">
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
        <n-form-item v-if="selectedRulePhase === 'http_request_dynamic_redirect'" :label="t('tunnels.redirectUrl')">
          <n-input v-model:value="ruleForm.redirectUrl" :placeholder="t('tunnels.redirectUrlPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_dynamic_redirect'" :label="t('tunnels.statusCode')">
          <n-select v-model:value="ruleForm.redirectStatus" :options="statusCodeOptions" />
        </n-form-item>
        <n-form-item v-if="isAccountLevelPhase" label="Bulk Redirect List">
          <n-input v-model:value="ruleForm.redirectListName" placeholder="已有 redirect list 名称" />
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
        <n-form-item  :label="t('tunnels.advancedMode')">
          <n-switch v-model:value="ruleForm.showAdvancedJson" />
          <n-text depth="3" style="font-size: 12px; margin-left: 8px">{{ t('tunnels.advancedModeHint') }}</n-text>
        </n-form-item>
        <n-form-item v-if="ruleForm.showAdvancedJson" :label="t('tunnels.actionJson')">
          <n-input v-model:value="ruleForm.actionJson" :placeholder="actionJsonPlaceholder" type="textarea" :rows="3" />
        </n-form-item>
        <n-form-item :label="t('tunnels.ruleDescription')">
          <n-input v-model:value="ruleForm.description" :placeholder="t('tunnels.ruleDescPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="ruleExpressionPreview" :label="t('tunnels.generatedExpression')">
          <n-input :value="ruleExpressionPreview" readonly type="textarea" :rows="2" />
        </n-form-item>
      </n-form>
      <n-space v-if="editingRuleId" vertical>
        <n-alert type="info">完整 JSON 编辑保留未修改的高级字段，保存前会检查远程冲突。</n-alert>
        <n-input v-model:value="ruleDraftJson" type="textarea" :autosize="{ minRows: 8, maxRows: 20 }" :disabled="ruleSubmitting" />
        <details><summary>原始规则</summary><pre>{{ JSON.stringify(originalRule, null, 2) }}</pre></details>
      </n-space>
      <n-space>
        <n-button size="small" :disabled="ruleSubmitting" @click="loadRules(true)">读取实际规则（保留草稿）</n-button>
        <n-button size="small" :disabled="ruleSubmitting || !!ruleError" @click="discardRuleDraft">放弃草稿 / 使用最新规则</n-button>
      </n-space>
      <details><summary>最新 Cloudflare 规则</summary><pre>{{ JSON.stringify(editingRuleId ? rules.find(row => row.id === editingRuleId) : rules, null, 2) }}</pre></details>
      <n-alert v-if="ruleSaveError" type="error">{{ ruleSaveError }}</n-alert>
      <template #action>
        <n-space>
          <n-button @click="closeRule">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="ruleSubmitting" :disabled="ruleSaveBlocked || (editingRuleId !== null && !ruleDirty)" @click="submitRule">{{ editingRuleId ? t('common.save') : t('common.create') }}</n-button>
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
      <n-alert v-if="wizardResult?.status !== 'success'" type="warning">{{ wizardResult?.status }} · {{ wizardResult?.message }}<pre>{{ wizardResult?.residuals }}</pre>请核实远程资源后再执行。</n-alert>
      <n-alert v-else type="success" :bordered="false" style="margin-top: 8px">
        {{ t('tunnels.wizardCreateHint') }}
      </n-alert>
      <details v-if="wizardResult?.baseline"><summary>复用 Tunnel 原始配置 / 待核实配置</summary><pre>{{ JSON.stringify({ baseline: wizardResult.baseline, attempted: wizardResult.attemptedConfig }, null, 2) }}</pre></details>
      <template #action>
        <n-button @click="showWizardResult = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { requestedAccountId } from '../utils/accountContext';
import { useAccountLabels } from '../utils/useAccountLabels';
import { ref, reactive, computed, h, onMounted, watch, onBeforeUnmount } from 'vue';
import AutoFitTable from '../components/AutoFitTable.vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useI18n } from 'vue-i18n';
import DOMPurify from 'dompurify';
import { NButton, NSpace, NTag, NPopconfirm } from 'naive-ui';
import { cacheRuleParameters, headerRuleParameters } from '../utils/rulePayload';
import { createRequestScope } from '../utils/requestScope';
import { tunnelsApi } from '../api/tunnels';
import { dnsApi } from '../api/dns';
import { canonical, validateConfig, type Ingress, type TunnelConfig, type TunnelSnapshot } from '../shared/tunnelConfig';
import { tunnelDraft, tunnelDirty, tunnelCanSave } from '../utils/tunnelDraft';
import { message, dialog } from '../utils/discreteApi';

const { t } = useI18n();
const activeTab = ref('tunnels');
const errorText = (error: any) => error?.response?.data?.error?.message || error?.message || '读取失败';
function guardDiscard(run: () => void) { if (configDirty.value || ruleDirty.value) dialog.warning({ title: '有未保存修改', content: '继续将丢弃当前草稿。', positiveText: '丢弃并继续', negativeText: '保留草稿', onPositiveClick: run }); else run(); }
function selectAccount(id: number) { guardDiscard(() => { selectedAccountId.value = id; void onAccountChange(); }); }
function onTabChange() { if (activeTab.value === 'rules-engine' && !domains.value.length) { selectedRuleAccountId.value ||= selectedAccountId.value; void loadDomains(); } }
const { accountLabel, renderAccountOption } = useAccountLabels();

// ============ 隧道管理 ============
const selectedAccountId = ref<number | null>(null);
const requests = createRequestScope(() => String(selectedAccountId.value));
const accounts = ref<Array<{ id: number; name: string; account_id: string; credential_id?: number }>>([]);
const tunnels = ref<any[]>([]);
const loadingAccounts = ref(false);
const loadingTunnels = ref(false);
const tunnelError = ref('');
const tunnelsFetchedAt = ref(0);

const accountOptions = computed(() =>
  accounts.value.map((a) => ({ label: accountLabel(a), value: a.id }))
);

async function loadAccounts() {
  loadingAccounts.value = true;
  try {
    const { data } = await tunnelsApi.getAccounts();
    accounts.value = data;
    if (accounts.value.length > 0 && !selectedAccountId.value) {
      selectedAccountId.value = accounts.value.find(a=>a.id===requestedAccountId())?.id ?? accounts.value[0].id;
      await loadTunnels();
    }
  } catch {
    accounts.value = [];
  } finally {
    loadingAccounts.value = false;
  }
}

async function refreshTunnels() { await loadAccounts(); await loadTunnels(true); }
async function loadTunnels(refresh = false) {
  if (!selectedAccountId.value) { tunnels.value = []; return; }
  loadingTunnels.value = true;
  const request = requests.begin('loadTunnels');
  try {
    const { data } = await tunnelsApi.listTunnels(selectedAccountId.value, refresh);
    if (!request.current()) return;
    tunnels.value = data; tunnelError.value = ''; tunnelsFetchedAt.value = Date.now();
  } catch (error) {
    if (!request.current()) return;
    tunnelError.value = errorText(error);
  } finally {
    if (request.current()) loadingTunnels.value = false;
  }
}

async function onAccountChange() {
  configBaseline.value = null; configRemote.value = null; ingressEntries.value = [];
  requests.invalidate(); tunnels.value = []; loadingTunnels.value = false; tunnelError.value = ''; tunnelsFetchedAt.value = 0;
  showConfigModal.value = false; showTokenModal.value = false; showConnectionsModal.value = false;
  showWizardModal.value = false; wizardLoading.value = false; showCreateModal.value = false; tokenValue.value = ''; tunnelZones.value = [];

  await loadTunnels();
}

// 创建隧道
const showCreateModal = ref(false);
const newTunnelName = ref('');
const creating = ref(false);

async function submitCreateTunnel() {
  if (!newTunnelName.value || !selectedAccountId.value) return;
  creating.value = true;
  const request = requests.begin('createTunnel');
  try {
    await tunnelsApi.createTunnel(selectedAccountId.value, newTunnelName.value);
    if (!request.current()) return;
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
  showTokenModal.value = true; tokenValue.value = '';
  const request = requests.begin('showToken', () => `${showTokenModal.value}:${selectedAccountId.value}`);
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
const connectionsFetchedAt = ref(0), connectionsTunnelId = ref('');

const connectionColumns = computed(() => [
  { title: 'ID', key: 'id', ellipsis: { tooltip: true } },
  { title: t('tunnels.table.colo'), key: 'colo_name' },
  { title: t('tunnels.table.version'), key: 'version' },
  { title: t('tunnels.table.ip'), key: 'ip' },
]);

async function showConnections(tunnelId: string, refresh = false) {
  if (!selectedAccountId.value) return;
  if (connectionsTunnelId.value !== tunnelId) { connections.value = []; connectionsFetchedAt.value = 0; }
  connectionsTunnelId.value = tunnelId; showConnectionsModal.value = true;
  const request = requests.begin('showConnections', () => `${showConnectionsModal.value}:${selectedAccountId.value}:${connectionsTunnelId.value}`);
  try {
    const { data } = await tunnelsApi.getConnections(selectedAccountId.value, tunnelId, refresh);
    if (!request.current()) return;
    connectionsTunnelId.value = tunnelId; connections.value = data.value; connectionsFetchedAt.value = data.cache.fetchedAt;
    showConnectionsModal.value = true;
  } catch {
    if (!request.current()) return;
    // error handled by interceptor
  }
}

// 删除隧道
async function deleteTunnel(tunnelId: string) {
  if (!selectedAccountId.value) return;
  const request = requests.begin('deleteTunnel');
  try {
    await tunnelsApi.deleteTunnel(selectedAccountId.value, tunnelId);
    if (!request.current()) return;
    message.success(t('tunnels.msg.tunnelDeleted'));
    await loadTunnels();
  } catch {
    // error handled by interceptor
  }
}

// Config and Zone reads have independent state and a modal-bound response fence.
const showConfigModal = ref(false);
const configTunnelId = ref(''), configTunnelName = ref('');
const loadingConfig = ref(false), savingConfig = ref(false);
const configBaseline = ref<TunnelSnapshot | null>(null), configRemote = ref<TunnelSnapshot | null>(null);
const configError = ref(''), zonesError = ref('');
const configBlocked = ref(false), clock = ref(Date.now());
const configTimer = setInterval(() => { clock.value = Date.now(); }, 1000);
const configRequests = createRequestScope(() => `${showConfigModal.value}:${selectedAccountId.value}:${configTunnelId.value}`);
let entrySerial = 0;
const ingressEntries = ref<Array<{ key: number; original: Ingress; hostname: string; path: string; service: string }>>([]);
const tunnelZones = ref<Array<{ id: string; name: string }>>([]);
const zoneOptions = computed(() => tunnelZones.value.map(z => ({ label: z.name, value: z.name })));
const configDraft = computed<TunnelConfig | null>(() => tunnelDraft(configBaseline.value, ingressEntries.value));
const configDirty = computed(() => showConfigModal.value && tunnelDirty(configBaseline.value, configDraft.value));
const configStatus = computed(() => loadingConfig.value ? '加载中' : configError.value ? '加载失败 / 需核实' : !configBaseline.value ? '配置未加载' : clock.value - configBaseline.value.fetchedAt > 30000 ? '已过期（请重新读取）' : '已加载');
const canSaveConfig = computed(() => tunnelCanSave({ baseline: configBaseline.value, dirty: configDirty.value, blocked: configBlocked.value, loading: loadingConfig.value, saving: savingConfig.value, now: clock.value }));
function fillConfig(data: TunnelSnapshot) {
  configBaseline.value = JSON.parse(JSON.stringify(data));
  ingressEntries.value = data.config.ingress.map(original => ({ key: ++entrySerial, original: JSON.parse(JSON.stringify(original)), hostname: original.hostname || '', path: original.path || '', service: original.service }));
}
async function openConfig(id: string, name: string) {
  configRequests.invalidate(); configTunnelId.value = id; configTunnelName.value = name;
  configBaseline.value = null; configRemote.value = null; ingressEntries.value = []; configError.value = ''; configBlocked.value = true;
  showConfigModal.value = true;
  await Promise.allSettled([readConfig(), readConfigZones()]);
}
async function readConfig() {
  if (!selectedAccountId.value) return;
  const request = configRequests.begin('config'); loadingConfig.value = true;
  try {
    const { data } = await tunnelsApi.getConfig(selectedAccountId.value, configTunnelId.value);
    if (!request.current()) return;
    validateConfig(data.config, true); configRemote.value = data;
    if (configDirty.value && canonical(data.config) !== canonical(configBaseline.value?.config)) { configError.value = '远程配置已变化，草稿保留；请比较最新配置后放弃或重新编辑'; configBlocked.value = true; }
    else { if (configDirty.value) configBaseline.value = data; else fillConfig(data); configError.value = ''; configBlocked.value = false; }
    clock.value = Date.now();
  } catch (error) { if (request.current()) { configError.value = errorText(error); configBlocked.value = true; } }
  finally { if (request.current()) loadingConfig.value = false; }
}
async function readConfigZones() {
  if (!selectedAccountId.value) return;
  const request = configRequests.begin('zones');
  try { const { data } = await tunnelsApi.getZones(selectedAccountId.value); if (request.current()) { tunnelZones.value = data; zonesError.value = ''; } }
  catch (error) { if (request.current()) { zonesError.value = errorText(error); tunnelZones.value = []; } }
}
function discardConfig() { if (configRemote.value) { fillConfig(configRemote.value); configError.value = ''; configBlocked.value = false; } }
function closeConfig() { if (savingConfig.value) return; guardDiscard(() => { showConfigModal.value = false; configRequests.invalidate(); }); }
function initializeIngress() { ingressEntries.value = [{ key: ++entrySerial, original: { service: 'http_status:404' }, hostname: '', path: '', service: 'http_status:404' }]; }
function addIngressEntry() { ingressEntries.value.splice(Math.max(0, ingressEntries.value.length - 1), 0, { key: ++entrySerial, original: { service: 'http://localhost:8080' }, hostname: '', path: '', service: 'http://localhost:8080' }); }
function removeIngressEntry(idx: number) { if (idx < ingressEntries.value.length - 1) ingressEntries.value.splice(idx, 1); }
function moveIngress(idx: number, direction: number) { const next = idx + direction; if (next < 0 || next >= ingressEntries.value.length - 1) return; const [entry] = ingressEntries.value.splice(idx, 1); if (entry) ingressEntries.value.splice(next, 0, entry); }
function confirmSaveConfig() { if (!canSaveConfig.value) return; dialog.warning({ title: '确认完整配置差异', content: '将保存上方 Diff 中的完整配置，并在保存前检查远程基线。', positiveText: '保存', negativeText: '取消', onPositiveClick: saveConfig }); }
async function saveConfig() {
  if (!canSaveConfig.value || !selectedAccountId.value || !configBaseline.value || !configDraft.value) return;
  const accountId = selectedAccountId.value, id = configTunnelId.value;
  const request = configRequests.begin('save'); savingConfig.value = true;
  try {
    validateConfig(configDraft.value);
    const { data } = await tunnelsApi.updateConfig(accountId, id, configDraft.value, configBaseline.value);
    if (!request.current()) return;
    if (data.snapshot) configRemote.value = data.snapshot;
    if (data.status !== 'success') { configBlocked.value = true; configError.value = data.message || '写入结果未确认，请重新读取'; return; }
    fillConfig(data.snapshot); configError.value = ''; message.success(t('tunnels.msg.configSaved')); clock.value = Date.now();
  } catch (error) { if (request.current()) { configError.value = errorText(error); configBlocked.value = true; } }
  finally { if (request.current()) savingConfig.value = false; }
}
watch(showConfigModal, show => { if (!show) { configRequests.invalidate(); loadingConfig.value = false; savingConfig.value = false; } });
watch(showTokenModal, show => { if (!show) tokenValue.value = ''; });

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
const wizardResult = ref<any>(null);

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
  showWizardModal.value = true; zonesError.value = ''; tunnelZones.value = [];
  void readWizardZones();
}
async function readWizardZones() {
  if (!selectedAccountId.value) return;
  const request = requests.begin('wizardZones', () => `${showWizardModal.value}:${selectedAccountId.value}`);
  try { const { data } = await tunnelsApi.getZones(selectedAccountId.value); if (request.current()) { tunnelZones.value = data || []; zonesError.value = ''; } }
  catch (error) { if (request.current()) { tunnelZones.value = []; zonesError.value = errorText(error); } }
}

async function submitWizard() {
  if (!selectedAccountId.value || !wizard.domain || !wizard.port || wizardLoading.value) return;
  wizardLoading.value = true;
  const request = requests.begin('wizard', () => `${selectedAccountId.value}`);
  const accountId = selectedAccountId.value;
  try {
    const hostname = wizard.subdomain ? `${wizard.subdomain}.${wizard.domain}` : wizard.domain;
    const payload: any = {
      zoneId: tunnelZones.value.find(z => z.name === wizard.domain)?.id,
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
    const { data } = await tunnelsApi.runWizard(accountId, payload);
    if (!request.current()) return;
    wizardResult.value = data;
    showWizardModal.value = false;
    showWizardResult.value = true;
    await loadTunnels();
    if (data.status === 'success') message.success(t('tunnels.msg.wizardSuccess'));
  } catch {
    // error handled by interceptor
  } finally {
    if (request.current()) wizardLoading.value = false;
  }
}

// ============ 回源规则 ============
const selectedDomain = ref<string | null>(null);
const selectedRuleAccountId = ref<number | null>(null);
const domainsError = ref(''), ruleError = ref(''), rulesFetchedAt = ref(0);
const selectedRulePhase = ref<string>('http_request_origin');
const rulePhaseOptions = computed(() => [
  { label: t('tunnels.rulePhases.origin'), value: 'http_request_origin' },
  { label: t('tunnels.rulePhases.redirect') + ' (Account)', value: 'http_request_redirect' },
  { label: 'Single Redirect (Zone)', value: 'http_request_dynamic_redirect' },
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
const ruleContext = computed(() => ({ accountId: selectedRuleAccountId.value || undefined, zoneId: isAccountLevelPhase.value ? undefined : selectedZone.value?.id }));
const ruleTargetReady = computed(() => !!selectedRuleAccountId.value && (isAccountLevelPhase.value || !!selectedZone.value));
const rules = ref<any[]>([]);
const loadingRules = ref(false);

const domainOptions = computed(() =>
  domains.value.map((d) => ({ label: `${d.name} (${d.accountName} / ${d.cfAccountId})`, value: `${d.cfAccountId}:${d.id}` }))
);

// 账户级 Phase 检测
const ACCOUNT_LEVEL_PHASES = new Set(['http_request_redirect']);
const isAccountLevelPhase = computed(() => ACCOUNT_LEVEL_PHASES.has(selectedRulePhase.value));

async function changeRuleAccount(id: number) { guardDiscard(() => { selectedRuleAccountId.value = id; selectedDomain.value = null; domains.value = []; rules.value = []; showRuleModal.value = false; void loadDomains(); }); }
function changeRulePhase(phase: string) { guardDiscard(() => { selectedRulePhase.value = phase; rules.value = []; showRuleModal.value = false; if (isAccountLevelPhase.value) void loadRules(); else if (!domains.value.length) void loadDomains(); else void loadRules(); }); }
async function loadDomains(refresh = false) {
  if (!selectedRuleAccountId.value || activeTab.value !== 'rules-engine') return;
  if (isAccountLevelPhase.value) { await loadRules(refresh); return; }
  const accountId = selectedRuleAccountId.value;
  const request = requests.begin('ruleZones', () => `${activeTab.value}:${selectedRuleAccountId.value}`);
  try {
    const { data } = await dnsApi.getAccountDomains(accountId, refresh);
    if (!request.current()) return;
    if (data.meta?.state === 'error') throw Error(data.meta.error || 'Zone 读取失败');
    domains.value = data.zones; domainsError.value = '';
    if (!domains.value.some(d => `${d.cfAccountId}:${d.id}` === selectedDomain.value)) selectedDomain.value = domains.value[0] ? `${accountId}:${domains.value[0].id}` : null;
    await loadRules(refresh);
  } catch (error) { if (request.current()) domainsError.value = errorText(error); }
}
function onDomainChange(domain: string) { guardDiscard(() => { selectedDomain.value = domain; rules.value = []; showRuleModal.value = false; void loadRules(); }); }
async function loadRules(refresh = false) {
  if (!ruleTargetReady.value) { rules.value = []; return; }
  loadingRules.value = true;
  const request = requests.begin('loadRules', () => `${selectedRuleAccountId.value}:${selectedDomain.value}:${selectedRulePhase.value}`);
  try {
    const { data } = await tunnelsApi.listRules(selectedDomainName.value, selectedRulePhase.value, ruleContext.value, refresh);
    if (!request.current()) return;
    rules.value = data; ruleError.value = ''; rulesFetchedAt.value = Date.now();
  } catch (error) { if (request.current()) ruleError.value = errorText(error); }
  finally { if (request.current()) loadingRules.value = false; }
}

// 规则表单
const showRuleModal = ref(false);
const editingRuleId = ref<string | null>(null);
const originalRuleParams = ref<Record<string, unknown>>({});
const originalRuleEnabled = ref(true);
const ruleSubmitting = ref(false);
const originalRule = ref<any>(null), ruleDraftJson = ref(''), ruleSaveError = ref('');
const ruleSaveBlocked = ref(false), ruleNewBaseline = ref('');
const ruleDirty = computed(() => showRuleModal.value && (editingRuleId.value ? canonical(originalRule.value) !== (() => { try { return canonical(JSON.parse(ruleDraftJson.value)); } catch { return ruleDraftJson.value; } })() : canonical(ruleForm) !== ruleNewBaseline.value));
function discardRuleDraft() { if (editingRuleId.value) { const actual = rules.value.find(row => row.id === editingRuleId.value); if (actual) openEditRule(actual); } else openAddRule(); }
function closeRule() { if (!ruleSubmitting.value) guardDiscard(() => { showRuleModal.value = false; }); }

const ruleForm = reactive({
  matchType: 'hostname' as 'hostname' | 'pathPrefix' | 'pathRegex' | 'hostAndPath' | 'custom',
  subdomain: '',
  pathValue: '',
  expression: '',
  port: 80,
  description: '',
  redirectUrl: '',
  redirectListName: '',
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
      return ruleForm.expression || (isAccountLevelPhase.value && !ruleForm.showAdvancedJson && /^[a-z][a-z\d_]{0,49}$/.test(ruleForm.redirectListName) ? `http.request.full_uri in $${ruleForm.redirectListName}` : '');
    default:
      return '';
  }
});

function openAddRule() {
  ruleSaveBlocked.value = false; ruleSaveError.value = ''; originalRule.value = null; ruleDraftJson.value = '';

  originalRuleParams.value = {}; originalRuleEnabled.value = true;
  editingRuleId.value = null;
  ruleForm.matchType = isAccountLevelPhase.value ? 'custom' : 'hostname';
  ruleForm.redirectListName = '';
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
  ruleNewBaseline.value = canonical(ruleForm);
  showRuleModal.value = true;
}

function openEditRule(row: any) {
  originalRule.value = JSON.parse(JSON.stringify(row)); ruleDraftJson.value = JSON.stringify(row, null, 2); ruleSaveError.value = ''; ruleSaveBlocked.value = false;

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
  if (!ruleTargetReady.value || ruleSubmitting.value || ruleSaveBlocked.value) return;
  const phase = selectedRulePhase.value;
  const domain = selectedDomainName.value, context = { ...ruleContext.value };
  const request = requests.begin('ruleSave', () => `${selectedRuleAccountId.value}:${selectedDomain.value}:${selectedRulePhase.value}:${showRuleModal.value}`);
  if (editingRuleId.value) {
    ruleSubmitting.value = true;
    try {
      const parsed = JSON.parse(ruleDraftJson.value);
      const { data } = await tunnelsApi.updateRule(domain, phase, editingRuleId.value, { ...parsed, baseline: originalRule.value }, context);
      if (!request.current()) return;
      if (data.status !== 'success') { ruleSaveBlocked.value = true; ruleSaveError.value = data.message || '写入未确认，请读取实际规则'; return; }
      showRuleModal.value = false; await loadRules(true);
    } catch (error) { if (request.current()) { ruleSaveError.value = errorText(error); ruleSaveBlocked.value = true; } }
    finally { ruleSubmitting.value = false; }
    return;
  }
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
    if (ruleForm.showAdvancedJson && ruleForm.actionJson) {
      const parsed = JSON.parse(ruleForm.actionJson); action = parsed.action; action_parameters = parsed.action_parameters; ratelimit = parsed.ratelimit;
    } else if (phase === 'http_request_origin') {
      action = 'route';
      action_parameters = { origin: { port: ruleForm.port } };
    } else if (phase === 'http_request_redirect') {
      if (!/^[a-z][a-z\d_]{0,49}$/.test(ruleForm.redirectListName)) { ruleSaveError.value = '请输入有效的已有 Bulk Redirect List 名称'; return; }
      action = 'redirect'; action_parameters = { from_list: { name: ruleForm.redirectListName, key: 'http.request.full_uri' } };
    } else if (phase === 'http_request_dynamic_redirect') {
      action = 'redirect';
      action_parameters = { from_value: { target: { url: ruleForm.redirectUrl || '' }, status_code: ruleForm.redirectStatus || 301 } };
    } else if (phase === 'http_request_firewall_custom') {
      action = 'block';
      action_parameters = {};
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
      const { data } = await tunnelsApi.createRule(domain, phase, payload, context);
      if (!request.current()) return;
      if (data.status !== 'success') { ruleSaveBlocked.value = true; ruleSaveError.value = data.message || '写入未确认'; return; }
      message.success(t('tunnels.msg.ruleCreated'));
    }
    showRuleModal.value = false;
    await loadRules(true);
  } catch (error) {
    if (request.current()) { ruleSaveError.value = errorText(error); ruleSaveBlocked.value = true; }
  } finally {
    ruleSubmitting.value = false;
  }
}

async function deleteRule(ruleId: string) {
  if (!ruleTargetReady.value || ruleSubmitting.value) return;
  const phase = selectedRulePhase.value, domain = selectedDomainName.value, accountId = selectedRuleAccountId.value;
  try {
    const { data } = await tunnelsApi.deleteRule(selectedDomainName.value, selectedRulePhase.value, ruleId, ruleContext.value, rules.value.find(r => r.id === ruleId));
    if (selectedRulePhase.value !== phase || selectedDomainName.value !== domain || selectedRuleAccountId.value !== accountId) return;
    if (data.status !== 'success') { ruleError.value = data.message || '删除结果未确认'; return; }
    message.success(t('tunnels.msg.ruleDeleted'));
    await loadRules(true);
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

watch(() => [selectedDomain.value, selectedRulePhase.value, selectedRuleAccountId.value], () => { ruleError.value = ''; rulesFetchedAt.value = 0; });
onBeforeRouteLeave(() => { if (!configDirty.value && !ruleDirty.value) return true; return new Promise<boolean>(resolve => { dialog.warning({ title: '有未保存修改', content: '离开页面将丢弃当前草稿。', positiveText: '丢弃并离开', negativeText: '继续编辑', onPositiveClick: () => resolve(true), onNegativeClick: () => resolve(false), onClose: () => resolve(false) }); }); });
function beforeUnload(event: BeforeUnloadEvent) { if (configDirty.value || ruleDirty.value) { event.preventDefault(); event.returnValue = ''; } }
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); requests.invalidate(); configRequests.invalidate(); clearInterval(configTimer); tokenValue.value = ''; });

// ============ 初始化 ============
onMounted(async () => {
  await loadAccounts();
});
</script>

<style scoped>
.ingress-row { padding: 8px; border: 1px solid var(--border-color); display: grid; gap: 6px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.config-diff { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
@media (max-width: 600px) { .config-diff { grid-template-columns: 1fr; } }
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
