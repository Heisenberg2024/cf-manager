<template>
  <div class="page-view">
    <!-- 顶部操作栏 -->
    <n-space justify="space-between" align="center" :wrap="true" style="margin-bottom: 12px">
      <n-h2 style="margin: 0">{{ t('dns.title') }}</n-h2>
      <n-space>
        <n-button size="small" @click="dnsStore.fetchDomains(true)" :loading="dnsStore.domainsLoading">{{ t('common.refresh') }}</n-button>
        <n-button size="small" type="primary" @click="openAddDomains">{{ t('dns.addDomain') }}</n-button>
      </n-space>
    </n-space>

    <n-space align="center" style="margin-bottom: 12px" :wrap="true">
      <n-select
        v-model:value="selectedAccount"
        :options="accountOptions"
        :placeholder="t('dns.selectAccount')"
        :render-label="renderAccountLabel"
        :node-props="accountFilterNodeProps"
        filterable
        style="width: 480px; max-width: 100%"
        size="small"
        @update:value="onAccountChange"
        @search="accountFilterSearch = $event"
        @update:show="(show: boolean) => { if (!show) accountFilterSearch = ''; }"
      />
      <n-input
        v-model:value="searchQuery"
        :placeholder="t('dns.searchDomain')"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        clearable
        size="small"
        style="width: 320px; max-width: 100%"
      />
    </n-space>

    <n-grid class="dns-grid-container" :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
      <!-- 左侧域名列表 -->
      <n-gi span="24 m:7" class="dns-grid-col">
        <n-card size="small" class="dns-left-card" content-class="dns-list-content" content-style="display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 12px;">
          <template #header>
            <n-space align="center" justify="space-between" style="width: 100%">
              <span>{{ t('dns.domainList') }}</span>
              <n-text v-if="selectedDomains.size > 0" depth="3" style="font-size: 12px">
                {{ t('dns.selectedCount', { count: selectedDomains.size }) }}
              </n-text>
            </n-space>
          </template>
          <n-space class="dns-zone-actions" :size="6" align="center" style="margin-bottom: 10px">
            <n-button size="tiny" @click="selectMatchingDomains">{{ t('dns.multi.selectSearch', {count: filteredDomains.filter(d => !isDemoDomain(d)).length}) }}</n-button>
            <n-dropdown trigger="click" :options="multiDnsOptions" @select="openMultiDns"><n-button size="tiny" :disabled="!selectedDomains.size">{{ t('dns.multi.menu') }} ▾</n-button></n-dropdown>
            <n-button size="tiny" :disabled="!selectedDomains.size" @click="selectedDomains = new Set()">{{ t('dns.multi.clear') }}</n-button>
            <n-dropdown trigger="click" :options="[{key:'delete-zones', label:t('dns.multi.deleteZones')}]" @select="handleBatchDelete"><n-button size="tiny" :disabled="!selectedDomains.size">{{ t('dns.multi.more') }} ▾</n-button></n-dropdown>
          </n-space>

          <n-text v-if="dnsStore.domainsLoading && filteredDomains.length" depth="3">{{ t('dns.cacheStatus.refreshing') }}</n-text>
          <n-alert v-for="(error, id) in dnsStore.domainErrors" :key="id" type="warning" :bordered="false">{{ accounts.find(account => account.id === Number(id))?.name || id }}: {{ t('dns.cacheStatus.accountFailed') }}: {{ error }} <n-button size="tiny" @click="dnsStore.fetchDomains(true, [Number(id)])">{{ t('dns.cacheStatus.retry') }}</n-button></n-alert>
          <n-text v-if="Object.values(dnsStore.domainStates).includes('stale')" depth="3">{{ t('dns.cacheStatus.stale') }}</n-text>
          <div class="dns-zone-list" role="region" :aria-label="t('dns.domainList')" tabindex="0">
            <n-spin :show="false">
              <n-skeleton v-if="dnsStore.domainsLoading && !filteredDomains.length" :repeat="6" text />
              <!-- 所有账户模式：分组折叠 -->
              <template v-if="selectedAccount === '__all__'">
                <n-collapse v-if="groupedDomains.length > 0" :expanded-names="expandedGroups" @update:expanded-names="expandedGroups = $event">
                  <n-collapse-item
                    v-for="group in groupedDomains"
                    :key="group.accountId"
                    :name="group.accountId"
                  >
                    <template #header>
                      <n-space align="center" :size="4">
                        <span style="overflow-wrap: anywhere">{{ group.accountName }}</span>
                        <n-text depth="3" style="font-size: 12px">({{ group.domains.length }})</n-text>
                      </n-space>
                    </template>
                    <DnsZoneList :zones="group.domains" :selected="selectedDomains" :current-key="`${dnsStore.currentContext.accountId}:${dnsStore.currentContext.zoneId}`" :is-demo="isDemoDomain" :status-label="statusLabel" :status-color="statusColor" :plan-name="domainPlanName" @select="selectDomain" @toggle="(zone, checked) => toggleDomainSelect(zoneKey(zone), checked)" />
                  </n-collapse-item>
                </n-collapse>
              </template>

              <!-- 单账户模式：平铺列表 -->
              <template v-else>
                <DnsZoneList :zones="filteredDomains" :selected="selectedDomains" :current-key="`${dnsStore.currentContext.accountId}:${dnsStore.currentContext.zoneId}`" :is-demo="isDemoDomain" :status-label="statusLabel" :status-color="statusColor" :plan-name="domainPlanName" @select="selectDomain" @toggle="(zone, checked) => toggleDomainSelect(zoneKey(zone), checked)" />
              </template>

              <n-empty v-if="!dnsStore.domainsLoading && filteredDomains.length === 0" :description="t('dns.noDomain')" style="margin: 20px 0">
                <template #extra>
                  <n-button size="small" type="primary" @click="openAddDomains">{{ t('dns.addDomainBtn') }}</n-button>
                </template>
              </n-empty>
            </n-spin>
          </div>
        </n-card>
      </n-gi>

      <!-- 右侧详情面板 -->
      <n-gi span="24 m:17" class="dns-grid-col">
        <n-card v-if="dnsStore.currentDomain" size="small" class="dns-right-card" content-class="dns-detail-content" content-style="display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 12px;">
          <template #header>
            <n-space align="center">
              <span>{{ dnsStore.currentDomain }}</span>
              <n-tag v-if="currentDomainInfo" size="small" :bordered="false">{{ domainPlanName(currentDomainInfo) }}</n-tag>
              <n-button size="tiny" :disabled="currentDomainIsDemo" @click="openPlanChange([currentDomainInfo])">{{ t('dns.plans.change') }}</n-button>
              <n-text v-if="currentDomainInfo" depth="3" style="font-size: 12px; overflow-wrap: anywhere">{{ domainAccountLabel(currentDomainInfo) }}</n-text>
            </n-space>
          </template>

          <n-tabs
            v-model:value="activeTab"
            type="line"
            @update:value="onTabChange"
            class="dns-tabs"
            pane-wrapper-style="display: flex; flex-direction: column; flex: 1; min-height: 0;"
            pane-style="display: flex; flex-direction: column; flex: 1; min-height: 0;"
          >
            <!-- Tab 1: DNS 记录 -->
            <n-tab-pane name="records" :tab="t('dns.records')">
              <n-alert v-if="dnsStore.recordsError" type="error" :bordered="false">{{ dnsStore.recordsError }} <n-button size="tiny" @click="dnsStore.fetchRecords(dnsStore.currentDomain, dnsStore.currentContext, true)">{{ t('dns.cacheStatus.retry') }}</n-button></n-alert>
              <n-text v-if="dnsStore.loading && dnsStore.records.length" depth="3">{{ t('dns.cacheStatus.refreshing') }}</n-text>
              <n-space align="center" style="margin-bottom: 8px; flex-shrink: 0">
                <n-button size="small" :disabled="batchRunning" @click="selectPageRecords">{{ t('dns.batch.selectPage') }}</n-button>
                <n-button size="small" :disabled="batchRunning" @click="selectFilteredRecords">{{ t('dns.batch.selectAll', { count: filteredRecordTotal }) }}</n-button>
                <n-button size="small" :disabled="batchRunning" @click="recordSelectionScope = 'zone'; selectedRecordIds = []">{{ t('dns.paging.selectZone') }}</n-button>
                <n-button size="small" :disabled="batchRunning" @click="clearRecordSelection">{{ t('common.clearSelection') }}</n-button>
                <n-text>{{ t('dns.batch.selected', { count: recordSelectionCount }) }}</n-text>
                <n-button size="small" :disabled="!recordSelectionCount || currentDomainIsDemo || batchRunning" @click="showBatchRecordEdit = true">{{ t('dns.batch.edit') }}</n-button>
                <n-button size="small" type="error" :disabled="!recordSelectionCount || currentDomainIsDemo || batchRunning" @click="confirmRecordBatch('delete')">{{ t('common.delete') }}</n-button>
                <n-button size="small" :loading="dnsStore.loading" @click="dnsStore.fetchRecords(dnsStore.currentDomain, dnsStore.currentContext, true)">{{ t('common.refresh') }}</n-button>
                <n-button size="small" type="primary" @click="openAddRecordModal">{{ t('dns.addRecord') }}</n-button>
              </n-space>
              <n-space align="center" style="margin-bottom: 8px; flex-shrink: 0">
                <n-select v-model:value="recordSearchField" :options="[{label: t('dns.recordName'), value: 'nameContains'}, {label: t('dns.recordContent'), value: 'contentContains'}]" size="small" style="width: 120px" />
                <n-input v-model:value="recordSearch" :placeholder="t('dns.paging.search')" clearable size="small" style="width: 220px" />
                <n-select v-model:value="recordType" :options="recordTypeOptions" :placeholder="t('dns.recordType')" clearable size="small" style="width: 120px" />
              </n-space>
              <n-text depth="3">{{ t(`dns.paging.scope.${recordSelectionScope}`) }} · {{ t('dns.paging.total', { count: filteredRecordTotal }) }}</n-text>
              <n-text v-if="dnsStore.loading && !dnsStore.records.length" depth="3">{{ t('common.loading') }}</n-text>
              <AutoFitTable
                style="flex: 1 1 0%; min-height: 0; margin-top: 0;"
                :columns="recordColumns"
                :data="visibleRecords"
                :remote="dnsStore.recordMode === 'page'"
                :loading="false"
                :scroll-x="680"
                :pagination="{ page: recordPage, pageSize: recordPageSize, showSizePicker: true, pageSlot: 5, pageSizes: [20, 50, 100], itemCount: filteredRecordTotal, onUpdatePage: (page: number) => recordPage = page, onUpdatePageSize: (size: number) => { recordPageSize = size; recordPage = 1; } }"
                :row-key="(row: any) => row.id"
                :checked-row-keys="selectedRecordIds"
                @update:checked-row-keys="onRecordChecked"
              />
            </n-tab-pane>

            <!-- Tab 2: Zone 设置 -->
            <n-tab-pane name="settings" :tab="t('dns.zoneSettings')">
              <ZoneSettingsFeedback :saving="savingSettings" />
                <div class="dns-tab-form-scroll">
                  <n-grid :cols="24" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
                    <!-- 左列：SSL/TLS 安全配置 -->
                    <n-gi span="24 m:12">
                      <div class="settings-group-card">
                        <div class="group-card-header">
                          <span class="group-card-icon">🔒</span>
                          <span class="group-card-title">{{ t('dns.sslTls') }}</span>
                        </div>
                        <n-form label-placement="left" label-width="120" size="small" :disabled="savingSettings">
                          <n-form-item :label="t('dns.sslMode')">
                            <n-select v-model:value="zoneForm.ssl" :disabled="!settingEditable('ssl')" :options="sslOptions" />
                          </n-form-item>
                          <n-form-item :label="t('dns.alwaysHttps')">
                            <n-switch v-model:value="zoneForm.always_use_https" :disabled="!settingEditable('always_use_https')" :checked-value="'on'" :unchecked-value="'off'" />
                          </n-form-item>
                          <n-form-item :label="t('dns.autoHttpsRewrite')">
                            <n-switch v-model:value="zoneForm.automatic_https_rewrites" :disabled="!settingEditable('automatic_https_rewrites')" :checked-value="'on'" :unchecked-value="'off'" />
                          </n-form-item>
                          <n-form-item :label="t('dns.securityLevel')">
                            <n-select v-model:value="zoneForm.security_level" :disabled="!settingEditable('security_level')" :options="securityOptions" />
                          </n-form-item>
                        </n-form>
                      </div>
                    </n-gi>

                    <!-- 右列：性能与传输优化 -->
                    <n-gi span="24 m:12">
                      <div class="settings-group-card">
                        <div class="group-card-header">
                          <span class="group-card-icon">⚡</span>
                          <span class="group-card-title">{{ t('dns.performance') }}</span>
                        </div>
                        <n-form label-placement="left" label-width="120" size="small" :disabled="savingSettings">
                          <n-form-item v-if="dnsStore.zoneSettings.minify !== undefined" :label="`${t('dns.autoMinify')} (deprecated)`">
                            <n-space :size="12">
                              <n-checkbox v-model:checked="minifyJs" disabled>JS</n-checkbox>
                              <n-checkbox v-model:checked="minifyCss" disabled>CSS</n-checkbox>
                              <n-checkbox v-model:checked="minifyHtml" disabled>HTML</n-checkbox>
                            </n-space>
                          </n-form-item>
                          <n-form-item v-if="dnsStore.zoneSettings.brotli !== undefined" :label="`${t('dns.brotli')} (deprecated)`">
                            <n-switch v-model:value="zoneForm.brotli" :disabled="!settingEditable('brotli')" :checked-value="'on'" :unchecked-value="'off'" />
                          </n-form-item>
                          <n-form-item :label="t('dns.zeroRtt')">
                            <n-switch v-model:value="zoneForm.zero_rtt" :disabled="!settingEditable('zero_rtt')" :checked-value="'on'" :unchecked-value="'off'" />
                          </n-form-item>
                          <n-form-item v-if="dnsStore.zoneSettings.http2 !== undefined" label="HTTP/2">
                            <n-switch v-model:value="zoneForm.http2" :disabled="!settingEditable('http2')" checked-value="on" unchecked-value="off" />
                          </n-form-item>
                          <n-form-item v-if="dnsStore.zoneSettings.http3 !== undefined" label="HTTP/3">
                            <n-switch v-model:value="zoneForm.http3" :disabled="!settingEditable('http3')" checked-value="on" unchecked-value="off" />
                          </n-form-item>
                          <n-form-item v-if="dnsStore.zoneSettings.always_online !== undefined" label="Always Online">
                            <n-switch v-model:value="zoneForm.always_online" :disabled="!settingEditable('always_online')" checked-value="on" unchecked-value="off" />
                          </n-form-item>
                        </n-form>
                      </div>
                    </n-gi>
                  </n-grid>

                  <div class="settings-action-bar">
                    <n-text depth="3" style="font-size: 12px">{{ t('dns.saveSettingsHint', '修改配置后点击右侧保存即时生效') }}</n-text>
                    <n-button type="primary" :loading="savingSettings" :disabled="!dnsStore.settingsDirty.length || !!dnsStore.settingsConflicts.length || savingSettings" @click="handleSaveSettings">{{ t('dns.saveSettings') }}</n-button>
                  </div>
                </div>
            </n-tab-pane>

            <!-- Tab 3: 缓存与状态 -->
            <n-tab-pane name="cache" :tab="t('dns.cacheAndStatus')">
              <ZoneSettingsFeedback :saving="savingSettings" />
              <div class="dns-tab-form-scroll">
                <n-grid :cols="24" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
                  <!-- 左列：缓存策略设置 -->
                  <n-gi span="24 m:12">
                    <div class="settings-group-card">
                      <div class="group-card-header">
                        <span class="group-card-icon">⚡</span>
                        <span class="group-card-title">{{ t('dns.cacheSettings') }}</span>
                      </div>
                      <n-form label-placement="left" label-width="120" size="small">
                        <n-form-item :label="t('dns.cacheLevel')">
                          <n-select v-model:value="zoneForm.cache_level" :disabled="!settingEditable('cache_level')" :options="cacheLevelOptions" />
                        </n-form-item>
                        <n-form-item :label="t('dns.browserCacheTtl')">
                          <n-select v-model:value="zoneForm.browser_cache_ttl" :disabled="!settingEditable('browser_cache_ttl')" :options="browserTtlOptions" />
                        </n-form-item>
                        <n-form-item :label="t('dns.devMode')">
                          <n-space align="center">
                            <n-switch v-model:value="zoneForm.development_mode" :disabled="!settingEditable('development_mode')" :checked-value="'on'" :unchecked-value="'off'" />
                            <n-text depth="3" style="font-size: 12px">{{ t('dns.devModeHint') }}</n-text>
                          </n-space>
                        </n-form-item>
                      </n-form>
                    </div>
                  </n-gi>

                  <!-- 右列：缓存清理与状态 -->
                  <n-gi span="24 m:12">
                    <div class="settings-group-card">
                      <div class="group-card-header">
                        <span class="group-card-icon">🧹</span>
                        <span class="group-card-title">{{ t('dns.purgeCache') }}</span>
                      </div>
                      <n-form label-placement="left" label-width="100" size="small">
                        <n-form-item :label="t('dns.purgeMethod')">
                          <n-space align="center">
                            <n-popconfirm @positive-click="handlePurgeAll">
                              <template #trigger>
                                <n-button size="small" type="warning" :loading="purging" :disabled="purging">{{ t('dns.purgeAll') }}</n-button>
                              </template>
                              {{ t('dns.purgeAllConfirm') }}
                            </n-popconfirm>
                            <n-button size="small" @click="showUrlPurge = !showUrlPurge">{{ showUrlPurge ? t('dns.collapse') : t('dns.purgeByUrl') }}</n-button>
                          </n-space>
                        </n-form-item>
                        <div v-if="showUrlPurge" style="margin-bottom: 12px;">
                          <n-input
                            v-model:value="purgeUrls"
                            type="textarea"
                            :placeholder="t('dns.purgeUrlPlaceholder')"
                            :rows="3"
                          />
                          <n-button size="small" type="primary" :loading="purging" @click="handlePurgeUrls" style="margin-top: 8px;">{{ t('dns.purgeSpecifiedUrl') }}</n-button>
                        </div>

                <n-divider>{{ t('dns.zoneStatus') }}</n-divider>
                <n-form-item :label="t('dns.currentStatus')">
                  <n-space align="center">
                    <span :style="{ color: statusColor(currentDomainInfo?.status), fontSize: '14px' }">●</span>
                    <span>{{ statusLabel(currentDomainInfo?.status) }}</span>
                  </n-space>
                </n-form-item>
                <n-form-item label=" ">
                  <n-popconfirm @positive-click="handleToggleZoneStatus">
                    <template #trigger>
                      <n-button
                        size="small"
                        :type="currentDomainInfo?.status === 'paused' ? 'success' : 'error'"
                        :loading="togglingStatus"
                      >
                        {{ currentDomainInfo?.status === 'paused' ? t('dns.activateZone') : t('dns.pauseZone') }}
                      </n-button>
                    </template>
                    <template v-if="currentDomainInfo?.status === 'paused'">
                      {{ t('dns.activateConfirm') }}
                    </template>
                    <template v-else>
                      {{ t('dns.pauseWarning') }}
                    </template>
                  </n-popconfirm>
                        </n-form-item>
                      </n-form>
                    </div>
                  </n-gi>
                </n-grid>

                <div class="settings-action-bar" style="margin-top: 16px;">
                  <n-text depth="3" style="font-size: 12px">{{ t('dns.saveSettingsHint', '修改配置后点击右侧保存即时生效') }}</n-text>
                  <n-button type="primary" :loading="savingSettings" :disabled="!dnsStore.settingsDirty.length || !!dnsStore.settingsConflicts.length || savingSettings" @click="handleSaveSettings">{{ t('dns.saveSettings') }}</n-button>
                </div>
              </div>
            </n-tab-pane>
          </n-tabs>
        </n-card>

        <n-card v-else size="small" class="dns-right-card" content-class="dns-detail-content" content-style="display: flex; align-items: center; justify-content: center; flex: 1; min-height: 0;">
          <n-empty :description="t('dns.selectFromLeft')" style="margin: 40px 0" />
        </n-card>
      </n-gi>
    </n-grid>

    <DnsBatchDialog v-model:show="showMultiDns" :zones="multiTargets" :action="multiAction" :selection="multiSelection" :initial-changes="multiChanges" @completed="onMultiCompleted" />
    <!-- 添加 DNS 记录 Modal -->
    <n-modal v-model:show="showAddRecordModal" preset="dialog" :title="editingRecordId ? t('dns.editRecordModalTitle') : t('dns.addRecordModalTitle')" style="width: 520px; max-width: 95vw">
      <n-form ref="recordFormRef" :model="newRecord" :rules="recordRules" label-placement="left" label-width="80">
        <DnsRecordFields v-model="newRecord" :lock-type="!!editingRecordId" />
      </n-form>
      <template #action>
        <n-button @click="showAddRecordModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="addingRecord" @click="handleSubmitRecord">{{ editingRecordId ? t('common.save') : t('common.add') }}</n-button>
      </template>
    </n-modal>

    <!-- 域名操作共用同一面板，结果留在原弹窗 -->
    <DnsOperationModal v-model:show="showAddDomainModal" :title="t('dns.addDomainModalTitle')" :running="creatingDomains">
      <n-form v-if="!creatingDomains && !createResult" :model="newDomain" label-placement="top">
        <n-form-item :label="t('dns.targetAccount')">
          <n-select v-model:value="newDomain.account_id" :options="availableAccounts" :placeholder="t('dns.selectAccount')"
            :render-label="renderAccountLabel" :node-props="accountCreateNodeProps" filterable
            @search="accountCreateSearch = $event" @update:show="(show: boolean) => { if (!show) accountCreateSearch = ''; }" />
        </n-form-item>
        <n-form-item :label="t('dns.plans.label')">
          <n-select v-model:value="newDomain.plan" :options="planOptions" :loading="plansLoading" :disabled="!newDomain.account_id || plansLoading" />
        </n-form-item>
        <n-alert v-if="plansError" type="warning" :bordered="false" style="margin-bottom: 12px">{{ t('dns.plans.loadFailed') }} {{ plansError }}</n-alert>
        <n-alert v-if="newDomain.plan !== 'free'" type="info" :bordered="false" style="margin-bottom: 12px">{{ t('dns.plans.allocationHint') }}</n-alert>
        <n-text v-if="plansSource === 'new_zone'" depth="3">{{ t('dns.plans.newAccountHint') }}</n-text>
        <n-form-item :label="t('dns.zoneType')"><n-select v-model:value="newDomain.type" :options="zoneTypeOptions" /></n-form-item>
        <n-form-item :label="t('dns.domainListLabel')">
          <n-input v-model:value="newDomain.names" type="textarea" :placeholder="t('dns.domainListPlaceholder')" :rows="3" />
        </n-form-item>
      </n-form>
      <n-data-table :columns="createColumns" :data="createTableRows" :row-key="createRowKey" :max-height="320" :scroll-x="780" size="small" />
      <n-progress v-if="creatingDomains" style="margin-top: 12px" type="line" :percentage="Math.round(createRows.filter(row => !['ready', 'running'].includes(row.status)).length / Math.max(createRows.length, 1) * 100)" />
      <n-text v-if="createResult" style="display: block; margin-top: 12px">{{ t('dns.resultSummary', { total: createResult.total, succeeded: createResult.succeeded, failed: createResult.failed }) }}</n-text>
      <n-text v-if="createResult?.fallback_count" depth="3">{{ t('dns.plans.fallbackCount', { count: createResult.fallback_count }) }}</n-text>
      <n-text v-if="createResult?.pending_count" depth="3"> · {{ t('dns.plans.pendingCount', { count: createResult.pending_count }) }}</n-text>
      <template #action>
        <n-button v-if="!createResult" type="primary" :loading="creatingDomains" :disabled="plansLoading || creatingDomains" @click="handleCreateDomains">{{ t('common.create') }}</n-button>
      </template>
    </DnsOperationModal>
    <ZonePlanDialog v-model:show="showPlanChange" :targets="planChangeTargets" @completed="onPlanChanged" />
    <ZoneDeleteDialog v-model:show="showZoneDelete" :targets="zoneDeleteTargets" @completed="onZonesDeleted" />
    <ZoneBatchSettingsDialog v-model:show="showZoneOperations" :mode="zoneOperationMode" :targets="zoneOperationTargets" @completed="dnsStore.invalidateZoneSettings" />
    <n-modal v-model:show="showBatchRecordEdit" preset="dialog" :title="t('dns.batch.edit')" style="width: 480px; max-width: 95vw">
      <n-text>{{ t('dns.batch.selected', { count: recordSelectionCount }) }}</n-text>
      <n-form label-placement="left" label-width="100" style="margin-top: 12px">
        <n-form-item label="TTL"><n-input-number v-model:value="batchTtl" :min="1" :max="86400" /><n-button style="margin-left: 8px" :disabled="batchTtl !== 1 && batchTtl < 60" @click="confirmRecordBatch('ttl')">{{ t('common.save') }}</n-button></n-form-item>
        <n-form-item label="Proxy"><n-select v-model:value="batchProxy" :options="[{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }]" /><n-button style="margin-left: 8px" @click="confirmRecordBatch('proxy')">{{ t('common.save') }}</n-button></n-form-item>
      </n-form>
      <n-text depth="3">{{ t('dns.batch.proxyHint') }}</n-text>
    </n-modal>

  </div>
</template>

<script setup lang="ts">
import DnsZoneList from '../components/DnsZoneList.vue';
import { ref, h, computed, onMounted, onUnmounted, watch } from 'vue';
import { NButton, NSwitch, NTag, NText, NCheckbox, useMessage, useDialog } from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules, SelectNodeProps } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useDnsStore } from '../stores/dnsStore';
import AutoFitTable from '../components/AutoFitTable.vue';
import DnsBatchDialog from '../components/DnsBatchDialog.vue';
import DnsRecordFields from '../components/DnsRecordFields.vue';
import ZonePlanDialog from '../components/ZonePlanDialog.vue';
import ZoneDeleteDialog from '../components/ZoneDeleteDialog.vue';
import ZoneBatchSettingsDialog from '../components/ZoneBatchSettingsDialog.vue';
import type { ZoneOperationTarget } from '../utils/zoneOperations';
import { useAccountLabels } from '../utils/useAccountLabels';
import DnsOperationModal from '../components/DnsOperationModal.vue';
import { dnsPlanOptionLabel, dnsPlanTierLabel } from '../utils/dnsPlanLabel';
import type { BatchAction, BatchZone, BatchSelection } from '../shared/dnsBatch';
import { dnsApi } from '../api/dns';
import { accountsApi } from '../api/accounts';
import { buildDnsRecord, DNS_TYPES } from '../utils/dnsRecord';
import type { DeleteZonesResult, PlanChangeTarget, ZoneContext } from '../api/dns';
import { setDemoAccounts, isDemoAccount } from '../utils/demoAccounts';
import type { DnsAccountIdentity } from '../utils/dnsAccountLabel';
import ZoneSettingsFeedback from '../components/ZoneSettingsFeedback.vue';
import { zonePlan, type CreateZoneResult, type ZonePlanId, type ZonePlanOption } from '../shared/zonePlans';

const { t } = useI18n();
const dnsStore = useDnsStore();
let viewActive = true;
onUnmounted(() => { viewActive = false; });
const message = useMessage();
const dialog = useDialog();

// ===== 账户过滤 =====
const selectedAccount = ref<string>('');
const searchQuery = ref('');
const debouncedSearch = ref('');
let searchTimer: ReturnType<typeof setTimeout>;
watch(searchQuery, value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { debouncedSearch.value = value; }, 150); });
onUnmounted(() => clearTimeout(searchTimer));
const domainSearchTerms = computed(() => [...new Set(debouncedSearch.value.split(/\r\n|\r|\n/).map(term => term.trim().toLowerCase()).filter(Boolean))]);
const accounts = ref<Array<DnsAccountIdentity & { is_enabled?: number; is_active?: number; enabled_features?: string }>>([]);
const isDnsBindingAvailable = (account: typeof accounts.value[number]) => account.is_enabled !== 0 && account.is_active !== 0 && !!account.account_id && (account.enabled_features ?? 'dns').split(',').includes('dns');
const dnsAccounts = computed(() => accounts.value.filter(isDnsBindingAvailable));
const accountFilterSearch = ref('');
const accountCreateSearch = ref('');
const { accountLabel, loadCredentialNames } = useAccountLabels();
const accountOptions = computed(() => [
  { label: t('dns.allAccounts'), value: '__all__' },
  ...accounts.value.map(account => ({ label: accountLabel(account), value: String(account.id), disabled: !isDnsBindingAvailable(account) })),
]);
const availableAccounts = computed(() => accounts.value.filter(account => account.account_id).map(account => ({
  label: accountLabel(account), value: account.id, disabled: account.is_enabled === 0 || isDemoAccount(account.id),
})));
function accountOptionNodeProps(option: Parameters<SelectNodeProps>[0], choices: Array<{ label: string; value: string | number }>, query: string) {
  const value = 'value' in option ? option.value : undefined;
  const visible = choices.filter(choice => choice.value !== '__all__' && choice.label.toLowerCase().includes(query.toLowerCase()));
  const index = visible.findIndex(choice => choice.value === value);
  if (index < 0) return {};
  const account = accounts.value.find(account => String(account.id) === String(value));
  return {
    class: index % 2 ? 'dns-account-option dns-account-option--striped' : 'dns-account-option',
    title: `${visible[index].label}\nAccount ID: ${account?.account_id || '—'}\n${t('dns.plans.credential')} #${account?.credential_id ?? '?'}`,
  };
}
const accountFilterNodeProps: SelectNodeProps = option => accountOptionNodeProps(option, accountOptions.value, accountFilterSearch.value);
const accountCreateNodeProps: SelectNodeProps = option => accountOptionNodeProps(option, availableAccounts.value, accountCreateSearch.value);
function renderAccountLabel(option: { label?: string | number; value?: string | number }, selected: boolean) {
  const account = accounts.value.find(account => String(account.id) === String(option.value));
  const title = account ? `${option.label}\nAccount ID: ${account.account_id || '—'}\n${t('dns.plans.credential')} #${account.credential_id ?? '?'}` : String(option.label || '');
  return h('span', { title, style: selected ? '' : 'white-space: normal; overflow-wrap: anywhere; display: block' }, option.label);
}
function domainAccountLabel(domain: any) {
  const account = accounts.value.find(account => account.id === domain.cfAccountId);
  return accountLabel(account || { id: domain.cfAccountId, name: domain.accountName, credential_id: domain.credentialId, account_id: domain.account?.id });
}
function domainPlanName(domain: any) { return zonePlan(domain.plan)?.name || t('dns.plans.unknown'); }

const STORAGE_KEY = 'dns_selected_account';
function loadSavedAccount(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function saveAccount(val: string) {
  try { localStorage.setItem(STORAGE_KEY, val); } catch { /* ignore */ }
}

// ===== 域名列表 =====
const selectedDomains = ref<Set<string>>(new Set());
const expandedGroups = ref<string[]>([]);

const allDomains = computed(() =>
  dnsStore.domains.map((d: any) =>
    typeof d === 'string' ? { name: d, status: '', accountName: '', cfAccountId: 0 } : d
  )
);

const filteredDomains = computed(() => {
  let list = allDomains.value;
  // 账户筛选仍使用本地绑定 ID。
  if (selectedAccount.value && selectedAccount.value !== '__all__') {
    const opt = accountOptions.value.find(o => o.value === selectedAccount.value);
    if (opt) {
      list = list.filter((d: any) => String(d.cfAccountId) === opt.value);
    }
  }
  // 域名搜索过滤
  if (domainSearchTerms.value.length) {
    list = list.filter((d: any) => domainSearchTerms.value.some(term => d.name?.toLowerCase().includes(term)));
  }
  return list;
});

const groupedDomains = computed(() => {
  const groups: Record<string, any[]> = {};
  for (const d of filteredDomains.value) {
    const key = String(d.cfAccountId);
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  }
  return Object.entries(groups).map(([accountId, domains]) => ({ accountId, accountName: domainAccountLabel(domains[0]), domains }));
});

const currentDomainInfo = computed(() =>
  allDomains.value.find((d: any) => d.name === dnsStore.currentDomain && d.cfAccountId === dnsStore.currentContext.accountId && d.id === dnsStore.currentContext.zoneId)
);

function isDemoDomain(d: any): boolean {
  return d.cfAccountId ? isDemoAccount(d.cfAccountId) : false;
}

function statusColor(status?: string): string {
  switch (status) {
    case 'active': return 'var(--theme-success)';
    case 'pending': return 'var(--theme-warning)';
    case 'paused': return 'var(--n-text-color-disabled, #999)';
    case 'moved': return 'var(--theme-error)';
    case 'initializing': return 'var(--theme-info)';
    default: return 'var(--n-text-color-disabled, #999)';
  }
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'active': return t('dns.statusActive');
    case 'pending': return t('dns.statusPending');
    case 'paused': return t('dns.statusPaused');
    case 'moved': return t('dns.statusMoved');
    case 'initializing': return t('dns.statusInitializing');
    default: return status || t('common.unknown');
  }
}

function toggleDomainSelect(name: string, checked: boolean) {
  if (checked) selectedDomains.value.add(name);
  else selectedDomains.value.delete(name);
  selectedDomains.value = new Set(selectedDomains.value);
}

function zoneKey(zone: any): string { return `${zone.cfAccountId}:${zone.id}`; }
function selectDomain(zone: any) {
  dnsStore.fetchRecords(zone.name, { accountId: zone.cfAccountId, zoneId: zone.id });
  activeTab.value = 'records';
}

function onAccountChange(val: string) {
  dnsStore.setDomainScope(val === '__all__' ? dnsAccounts.value.map(account => account.id) : [Number(val)]);
  void dnsStore.fetchDomains();
  saveAccount(val);
  dnsStore.clearSelection();
  selectedRecordIds.value = [];
  if (val === '__all__') {
    expandedGroups.value = groupedDomains.value.map(g => g.accountId);
  }
}

const showMultiDns = ref(false);
const multiAction = ref<BatchAction>('create');
const multiSelection = ref<BatchSelection>();
const multiChanges = ref<{ ttl?: number; proxied?: boolean }>();
const multiTargets = ref<BatchZone[]>([]);
const multiDnsOptions = computed(() => [
  ...['create', 'update', 'delete', 'proxy', 'ttl'].map(key => ({key, label:t(`dns.multi.${key}`)})),
  { key: 'plan', label: t('dns.plans.batchChange') },
  { key: 'ssl', label: t('dns.zoneOperations.sslTitle') },
  { key: 'purge', label: t('dns.zoneOperations.purgeTitle') },
]);
const showZoneOperations = ref(false);
const zoneOperationMode = ref<'ssl' | 'purge'>('ssl');
const zoneOperationTargets = ref<ZoneOperationTarget[]>([]);
const showPlanChange = ref(false);
const planChangeTargets = ref<PlanChangeTarget[]>([]);
function openPlanChange(domains: any[]) {
  planChangeTargets.value = domains.filter(domain => domain && !isDemoDomain(domain)).map(domain => ({ name: domain.name, accountId: domain.cfAccountId, zoneId: domain.id, accountLabel: domainAccountLabel(domain), plan: zonePlan(domain.plan) }));
  if (planChangeTargets.value.length) showPlanChange.value = true;
}
async function onPlanChanged() {
  try { await dnsStore.fetchDomains(true); } catch { message.warning(t('dns.plans.refreshFailed')); }
}
function selectMatchingDomains() {
  clearTimeout(searchTimer); debouncedSearch.value = searchQuery.value;
  for(const domain of filteredDomains.value) if(!isDemoDomain(domain)) selectedDomains.value.add(zoneKey(domain));
  selectedDomains.value = new Set(selectedDomains.value);
}
function openMultiDns(key: string) {
  multiSelection.value = undefined; multiChanges.value = undefined;
  if (key === 'ssl' || key === 'purge') {
    zoneOperationTargets.value = allDomains.value.filter(domain => selectedDomains.value.has(zoneKey(domain)) && !isDemoDomain(domain)).map(domain => ({ name: domain.name, accountId: domain.cfAccountId, zoneId: domain.id, accountLabel: domainAccountLabel(domain) }));
    zoneOperationMode.value = key;
    if (zoneOperationTargets.value.length) showZoneOperations.value = true;
    return;
  }
  if (key === 'plan') { openPlanChange(allDomains.value.filter(domain => selectedDomains.value.has(zoneKey(domain)))); return; }
  multiTargets.value = allDomains.value.filter(d => selectedDomains.value.has(zoneKey(d))).map(d => ({accountId:d.cfAccountId, credentialId:d.credentialId, zoneId:d.id, zoneName:d.name}));
  multiAction.value = key as BatchAction; showMultiDns.value = true;
}
async function onMultiCompleted(zones: BatchZone[]) { clearRecordSelection(); await dnsStore.invalidateRecords(zones); }
watch(() => dnsStore.domains, () => {
  const present = new Set(allDomains.value.map(zoneKey));
  selectedDomains.value = new Set([...selectedDomains.value].filter(key => present.has(key)));
});

// ===== Tab =====
const activeTab = ref('records');

async function onTabChange(tab: string) {
  if ((tab === 'settings' || tab === 'cache') && dnsStore.currentDomain) {
    await dnsStore.fetchZoneSettings(dnsStore.currentDomain);
  }
}

// ===== DNS 记录 =====
const showAddRecordModal = ref(false);
const addingRecord = ref(false);
const editingRecordId = ref<string | null>(null);
const recordFormRef = ref<FormInst | null>(null);
const recordTarget = ref<{ domain: string; context: ZoneContext }>({ domain: '', context: {} });
function captureTarget() { return { domain: dnsStore.currentDomain, context: { ...dnsStore.currentContext } }; }
const newRecord = ref<any>({ type: 'A', name: '', content: '', ttl: 300, proxied: true, priority: 10, weight: 0, port: 443 });
const recordRules: FormRules = {
  type: { required: true, message: t('dns.recordTypeRequired'), trigger: 'change' },
  name: { required: true, message: t('dns.recordNameRequired'), trigger: 'blur' },
  content: { required: true, message: t('dns.recordContentRequired'), trigger: 'blur' },
};



watch(() => newRecord.value.type, type => { if (!['A', 'AAAA', 'CNAME'].includes(type)) newRecord.value.proxied = false; });

// 关闭代理时，若 TTL 仍是「自动」（1），恢复为默认 300，避免输入框被 clamp 成 60
watch(() => newRecord.value.proxied, (proxied) => {
  if (!proxied && newRecord.value.ttl === 1) {
    newRecord.value.ttl = 300;
  }
});

function buildRecordPayload() {
  return buildDnsRecord(newRecord.value, recordTarget.value.domain);
}

function openAddRecordModal() {
  recordTarget.value = captureTarget();
  editingRecordId.value = null;
  newRecord.value = { type: 'A', name: '', content: '', ttl: 300, proxied: true, priority: 10, weight: 0, port: 443 };
  showAddRecordModal.value = true;
}

async function handleSubmitRecord() {
  if (!dnsStore.currentDomain) return;
  try {
    await recordFormRef.value?.validate();
  } catch {
    return;
  }
  addingRecord.value = true;
  try {
    const target = { domain: recordTarget.value.domain, context: { ...recordTarget.value.context } };
    const payload = buildRecordPayload();
    if (editingRecordId.value) {
      await dnsStore.saveRecord(target.domain, target.context, payload, editingRecordId.value);
      message.success(t('dns.msg.recordUpdated'));
    } else {
      await dnsStore.saveRecord(target.domain, target.context, payload);
      message.success(t('dns.msg.recordAdded'));
    }
    showAddRecordModal.value = false;
    editingRecordId.value = null;
    newRecord.value = { type: 'A', name: '', content: '', ttl: 300, proxied: true, priority: 10, weight: 0, port: 443 };
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.saveFailed'));
  } finally {
    addingRecord.value = false;
  }
}

async function handleDeleteRecord(row: any, target = captureTarget()) {
  if (!dnsStore.currentDomain) return;
  try {
    await dnsStore.removeRecord(target.domain, target.context, row.id);
    message.success(t('dns.msg.recordDeleted'));
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.deleteFailed'));
  }
}

async function handleProxyToggle(row: any, proxied: boolean) {
  if (!dnsStore.currentDomain) return;
  try {
    const target = captureTarget();
    await dnsStore.toggleProxy(target.domain, target.context, row.id, proxied);
    message.success(t('dns.msg.proxyUpdated'));
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.updateFailed'));
  }
}

const currentDomainIsDemo = computed(() => {
  const d = currentDomainInfo.value;
  return d ? isDemoDomain(d) : false;
});

const selectedRecordIds = ref<string[]>([]);
const recordSearch = ref('');
const recordType = ref<string | null>(null);
const recordTypeOptions = DNS_TYPES.map(value => ({ label: value, value }));
const recordSearchField = ref<'nameContains' | 'contentContains'>('nameContains');
const recordSelectionScope = ref<'ids' | 'filter' | 'zone'>('ids');
const recordSelectionCount = computed(() => recordSelectionScope.value === 'ids' ? selectedRecordIds.value.length : recordSelectionScope.value === 'filter' ? filteredRecordTotal.value : dnsStore.recordMode === 'page' ? dnsStore.zoneRecordTotal : dnsStore.records.length);
const recordPage = ref(1);
const recordPageSize = ref(20);
const appliedRecordSearch = ref('');
const filterSpec = computed(() => ({ ...(recordType.value ? { type: recordType.value } : {}), ...(appliedRecordSearch.value ? { [recordSearchField.value]: appliedRecordSearch.value } : {}) }));
const filteredRecords = computed(() => dnsStore.recordMode === 'page' ? dnsStore.records : dnsStore.records.filter(r => (!recordType.value || r.type === recordType.value) && (!appliedRecordSearch.value || String(recordSearchField.value === 'nameContains' ? r.name : r.content || '').toLowerCase().includes(appliedRecordSearch.value.toLowerCase()))));
const filteredRecordTotal = computed(() => dnsStore.recordMode === 'page' ? dnsStore.recordTotal : filteredRecords.value.length);
const visibleRecords = computed(() => dnsStore.recordMode === 'page' ? filteredRecords.value.slice(((recordPage.value - 1) * recordPageSize.value) % 500, ((recordPage.value - 1) * recordPageSize.value) % 500 + recordPageSize.value) : filteredRecords.value);
let recordSearchTimer: ReturnType<typeof setTimeout>;
function onRecordChecked(keys: Array<string | number>) { recordSelectionScope.value = 'ids'; selectedRecordIds.value = keys.map(String); }
function clearRecordSelection() { selectedRecordIds.value = []; recordSelectionScope.value = 'ids'; }
function selectFilteredRecords() {
  clearTimeout(recordSearchTimer); appliedRecordSearch.value = recordSearch.value.trim();
  recordSelectionScope.value = 'filter'; selectedRecordIds.value = [];
  if (dnsStore.recordMode === 'page') { recordPage.value = 1; void dnsStore.fetchRecordWindow(1, filterSpec.value); }
}
watch([recordSearch, recordType, recordSearchField], () => {
  clearTimeout(recordSearchTimer); clearRecordSelection(); recordPage.value = 1;
  recordSearchTimer = setTimeout(() => { appliedRecordSearch.value = recordSearch.value.trim(); if (dnsStore.recordMode === 'page') void dnsStore.fetchRecordWindow(1, filterSpec.value); }, 200);
});
watch(filteredRecordTotal, total => { recordPage.value = Math.min(recordPage.value, Math.max(1, Math.ceil(total / recordPageSize.value))); });
watch([recordPage, recordPageSize], () => { if (dnsStore.recordMode === 'page') void dnsStore.fetchRecordWindow(Math.floor(((recordPage.value - 1) * recordPageSize.value) / 500) + 1, filterSpec.value); });
onUnmounted(() => clearTimeout(recordSearchTimer));

const batchRunning = computed(() => showMultiDns.value);
const showBatchRecordEdit = ref(false);
const batchTtl = ref(300);
const batchProxy = ref('on');
watch(() => `${dnsStore.currentDomain}:${dnsStore.currentContext.accountId}:${dnsStore.currentContext.zoneId}`, () => { clearTimeout(recordSearchTimer); clearRecordSelection(); recordSearch.value = ''; appliedRecordSearch.value = ''; recordType.value = null; recordPage.value = 1; showAddRecordModal.value = false; });
function selectPageRecords() {
  recordSelectionScope.value = 'ids';
  const rows = dnsStore.recordMode === 'page' ? visibleRecords.value : filteredRecords.value.slice((recordPage.value - 1) * recordPageSize.value, recordPage.value * recordPageSize.value);
  selectedRecordIds.value = [...new Set([...selectedRecordIds.value, ...rows.map(row => row.id)])];
}
function confirmRecordBatch(action: 'delete' | 'ttl' | 'proxy') {
  if (!recordSelectionCount.value || batchRunning.value || currentDomainIsDemo.value || !currentDomainInfo.value) return;
  const zone = currentDomainInfo.value;
  multiTargets.value = [{accountId: zone.cfAccountId, credentialId: zone.credentialId, zoneId: zone.id, zoneName: zone.name}];
  multiSelection.value = recordSelectionScope.value === 'ids' ? {kind: 'ids', recordIds: [...selectedRecordIds.value]} : recordSelectionScope.value === 'filter' ? {kind: 'filter', filter: {...filterSpec.value}} : {kind: 'zone'};
  multiChanges.value = action === 'ttl' ? {ttl: batchTtl.value} : action === 'proxy' ? {proxied: batchProxy.value === 'on'} : undefined;
  multiAction.value = action; showBatchRecordEdit.value = false; showMultiDns.value = true;
}

const recordColumns = computed<DataTableColumns<any>>(() => [
  { type: 'selection', width: 40, disabled: () => currentDomainIsDemo.value || batchRunning.value },
  { title: t('dns.recordType'), key: 'type', width: 80, render: (row) => h(NTag, { size: 'small', type: 'info' }, { default: () => row.type }) },
  { title: t('dns.recordName'), key: 'name', width: 180, ellipsis: { tooltip: true } },
  { title: t('dns.recordContent'), key: 'content', minWidth: 180, ellipsis: { tooltip: true } },
  { title: t('dns.ttl'), key: 'ttl', width: 80, render: (row) => row.ttl === 1 ? t('dns.ttlAuto') : String(row.ttl) },
  {
    title: t('dns.proxied'), key: 'proxied', width: 80,
    render: (row) => h(NSwitch, { value: row.proxied, loading: dnsStore.proxyPending.has(`${dnsStore.currentContext.accountId}:${dnsStore.currentContext.zoneId}:${dnsStore.currentDomain}:${row.id}`), disabled: currentDomainIsDemo.value || !['A', 'AAAA', 'CNAME'].includes(row.type) || batchRunning.value, onUpdateValue: (v: boolean) => handleProxyToggle(row, v), size: 'small' }),
  },
  {
    title: t('common.actions'), key: 'actions', width: 120,
    render: (row) => currentDomainIsDemo.value ? null : h('div', { style: 'display: flex; gap: 4px' }, [
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => handleEditRecord(row) }, { default: () => t('common.edit') }),
      h(NButton, {
        size: 'tiny', type: 'error', quaternary: true,
        onClick: () => {
          const target = captureTarget();
          dialog.warning({
            title: t('dns.msg.deleteConfirm'),
            content: t('dns.msg.deleteRecordConfirm', { type: row.type, name: row.name, content: row.content }),
            positiveText: t('common.delete'),
            negativeText: t('common.cancel'),
            onPositiveClick: () => handleDeleteRecord(row, target),
          });
        }
      }, { default: () => t('common.delete') }),
    ]),
  },
]);

// 将 Cloudflare 返回的完整 FQDN 名称转为相对名称（与新增时的填写习惯一致）
function toRecordName(name: string, zone: string): string {
  if (!name || !zone) return name || '';
  // 根记录（name 等于 zone 本身）显示为 @
  if (name === zone) return '@';
  // 去掉 zone 后缀，例如 www.example.com -> www
  if (name.endsWith(`.${zone}`)) return name.slice(0, -(zone.length + 1));
  return name;
}

function handleEditRecord(row: any) {
  recordTarget.value = captureTarget();
  editingRecordId.value = row.id;
  newRecord.value = {
    type: row.type,
    name: toRecordName(row.name, dnsStore.currentDomain),
    content: row.type === 'SRV' ? row.data?.target || '' : row.type === 'CAA' ? row.data?.value || '' : row.content,
    ttl: row.ttl,
    proxied: row.proxied,
    priority: row.data?.priority ?? row.priority ?? 10,
    weight: row.data?.weight ?? 0,
    port: row.data?.port ?? 443,
    flags: row.data?.flags ?? 0, tag: row.data?.tag ?? 'issue', comment: row.comment ?? '',
  };
  showAddRecordModal.value = true;
}

// ===== Zone 设置 =====
const savingSettings = computed(()=>dnsStore.settingsPending.has(dnsStore.settingsKey(dnsStore.currentDomain,dnsStore.currentContext)));
const zoneForm = computed(()=>dnsStore.settingForm);
const minifyJs = ref(false);
const minifyCss = ref(false);
const minifyHtml = ref(false);

const sslOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Flexible', value: 'flexible' },
  { label: 'Full', value: 'full' },
  { label: 'Full (Strict)', value: 'strict' },
];
const securityOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Essentially Off', value: 'essentially_off' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Under Attack', value: 'under_attack' },
];
const cacheLevelOptions = [
  { label: 'Basic', value: 'basic' },
  { label: 'Simplified', value: 'simplified' },
  { label: 'Aggressive', value: 'aggressive' },
];
const browserTtlOptions = [
  { label: 'Respect Existing', value: 0 },
  { label: '30s', value: 30 }, { label: '1m', value: 60 }, { label: '5m', value: 300 },
  { label: '20m', value: 1200 }, { label: '30m', value: 1800 }, { label: '1h', value: 3600 },
  { label: '2h', value: 7200 }, { label: '3h', value: 10800 }, { label: '4h', value: 14400 },
  { label: '8h', value: 28800 }, { label: '12h', value: 43200 }, { label: '16h', value: 57600 },
  { label: '1d', value: 86400 },
];

function settingEditable(key: string): boolean { return !savingSettings.value && !dnsStore.settingsDraftLocked && dnsStore.zoneSettings.__meta?.[key]?.editable === true; }
watch(() => dnsStore.zoneSettings, () => {minifyJs.value=dnsStore.zoneSettings.minify?.js==='on';minifyCss.value=dnsStore.zoneSettings.minify?.css==='on';minifyHtml.value=dnsStore.zoneSettings.minify?.html==='on';});
watch([activeTab,()=>`${dnsStore.currentDomain}:${dnsStore.currentContext.accountId}:${dnsStore.currentContext.zoneId}`],()=>{if(activeTab.value==='settings'||activeTab.value==='cache')void onTabChange(activeTab.value);});
async function handleSaveSettings() {
  if (!dnsStore.currentDomain || savingSettings.value) return;
  if(!dnsStore.settingsDirty.length){message.info(t('dns.settingsState.noChanges'));return;}
  const domain=dnsStore.currentDomain;
  try {
    const settings=Object.fromEntries(dnsStore.settingsDirty.map(key=>[key,zoneForm.value[key]]));
    const result=await dnsStore.updateZoneSettings(domain,settings);
    if(result.failed?.length)message.warning(Object.entries(result.errors || {}).map(([key,error])=>`${key}: ${error}`).join('; '));
    else if(!result.updated?.length)message.info(t('dns.settingsState.noChanges'));
    else message.success(t('dns.msg.settingsUpdated'));
  }catch(error:any){message.error(error.errorMessage || error.message);}
}

// ===== 缓存清除 =====
const showUrlPurge = ref(false);
const purgeUrls = ref('');
const purging = ref(false);

async function handlePurgeAll() {
  if (!dnsStore.currentDomain || purging.value) return;
  purging.value = true;
  try {
    await dnsStore.purgeZoneCache(dnsStore.currentDomain, { purge_everything: true });
    message.success(t('dns.msg.cachePurged'));
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.purgeFailed'));
  } finally {
    purging.value = false;
  }
}

async function handlePurgeUrls() {
  if (!dnsStore.currentDomain || purging.value) return;
  const files = purgeUrls.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!files.length) {
    message.warning(t('dns.msg.urlRequired'));
    return;
  }
  purging.value = true;
  try {
    await dnsStore.purgeZoneCache(dnsStore.currentDomain, { files });
    message.success(t('dns.msg.urlPurged', { count: files.length }));
    purgeUrls.value = '';
    showUrlPurge.value = false;
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.purgeFailed'));
  } finally {
    purging.value = false;
  }
}

// ===== Zone 状态 =====
const togglingStatus = ref(false);

async function handleToggleZoneStatus() {
  if (!dnsStore.currentDomain || !currentDomainInfo.value || togglingStatus.value) return;
  const isPaused = currentDomainInfo.value.paused === true || currentDomainInfo.value.status === 'paused';
  togglingStatus.value = true;
  try {
    await dnsStore.updateZoneStatus(dnsStore.currentDomain, !isPaused);
    message.success(!isPaused ? t('dns.msg.zonePaused') : t('dns.msg.zoneActivated'));
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.operationFailed'));
  } finally {
    togglingStatus.value = false;
  }
}

// ===== 批量添加域名 =====
const showAddDomainModal = ref(false);
const creatingDomains = ref(false);
const newDomain = ref<{ account_id: number | null; type: 'full' | 'partial'; names: string; plan: ZonePlanId }>({ account_id: null, type: 'full', names: '', plan: 'free' });
const plans = ref<ZonePlanOption[]>([]);
const plansLoading = ref(false);
const plansError = ref('');
const plansSource = ref('');
let planRequest = 0;
const planOptions = computed(() => {
  const options = plans.value.map(plan => ({ value: plan.id, label: `${dnsPlanOptionLabel(plan, t)}${plan.can_subscribe === false && plan.id !== 'free' ? ` · ${t('dns.plans.unavailable')}` : ''}` }));
  // Unknown/partial billing reads must not hide a tier the user knows their Account can use.
  for (const [value, label] of [['free', 'Free'], ['pro', 'Pro'], ['business', 'Business'], ['enterprise', 'Enterprise']]) {
    if (!options.some(option => option.value === value)) options.push({ value: value!, label: dnsPlanTierLabel({ id: value!, name: label! }, t) });
  }
  return options;
});
watch([showAddDomainModal, () => newDomain.value.account_id], async ([show, accountId]) => {
  const identity = ++planRequest;
  plans.value = []; plansError.value = ''; plansSource.value = ''; plansLoading.value = false;
  newDomain.value.plan = 'free';
  if (!show || !accountId) return;
  plansLoading.value = true;
  try {
    const { data } = await dnsApi.getPlans(accountId);
    if (identity !== planRequest) return;
    plans.value = data.plans; plansSource.value = data.source;
  } catch (error: any) {
    if (identity === planRequest) plansError.value = error.errorMessage || error.message;
  } finally { if (identity === planRequest) plansLoading.value = false; }
});
const createResult = ref<Awaited<ReturnType<typeof dnsStore.createDomains>> | null>(null);
type CreateStatus = 'ready' | 'running' | 'success' | 'pending' | 'failed' | 'uncertain';
interface CreateRow { name: string; accountLabel: string; requestedPlan: ZonePlanId; status: CreateStatus; result?: CreateZoneResult }
const createRows = ref<CreateRow[]>([]);
const inputDomainNames = computed(() => [...new Set(newDomain.value.names.split('\n').map(name => name.trim().toLowerCase()).filter(Boolean))]);
const createTableRows = computed<CreateRow[]>(() => creatingDomains.value || createResult.value ? createRows.value : inputDomainNames.value.map(name => ({ name, accountLabel: availableAccounts.value.find(account => account.value === newDomain.value.account_id)?.label || '—', requestedPlan: newDomain.value.plan, status: 'ready' })));
const createRowKey = (row: CreateRow) => row.name;
const createColumns = computed<DataTableColumns<CreateRow>>(() => [
  { title: t('dns.plans.domain'), key: 'name', width: 220, render: row => h('div', [h('div', row.name), h(NText, { depth: 3, style: 'font-size: 11px; overflow-wrap: anywhere' }, () => row.accountLabel), ...(row.result?.name_servers?.length ? [h('div', { style: 'font-family: monospace; font-size: 11px; overflow-wrap: anywhere; white-space: pre-line' }, row.result.name_servers.join('\n')), h(NButton, { size: 'tiny', onClick: () => copyNS(row.result!.name_servers!) }, () => t('dns.copyNs'))] : [])]) },
  { title: t('dns.plans.targetPlan'), key: 'target', width: 110, render: row => zonePlan({ id: row.requestedPlan })?.name || row.requestedPlan },
  { title: t('dns.plans.actual'), key: 'actual', width: 130, render: row => row.result?.zone_created ? h(NText, { style: 'overflow-wrap: anywhere' }, () => row.result?.plan?.name || t('dns.plans.unknown')) : '—' },
  { title: t('dns.plans.status'), key: 'status', width: 130, render: row => h(NTag, { size: 'small', type: row.status === 'failed' ? 'error' : ['pending', 'uncertain'].includes(row.status) ? 'warning' : 'default' }, () => t(row.status === 'running' ? 'dns.zoneBatch.processing' : `dns.plans.states.${row.status}`)) },
  { title: t('dns.reason'), key: 'reason', render: row => h(NText, { type: row.status === 'failed' ? 'error' : 'warning', style: 'overflow-wrap: anywhere' }, () => [row.result?.zone_created && !row.result.success ? t('dns.plans.createdButFailed') : '', row.result?.outcome_uncertain ? t(row.result.zone_created ? 'dns.plans.changeUncertain' : 'dns.plans.creationUncertain') : '', row.result?.error || row.result?.warning || ''].filter(Boolean).join(' ')) },
]);
function openAddDomains() {
  if (creatingDomains.value) return;
  createResult.value = null; createRows.value = []; showAddDomainModal.value = true;
}
const zoneTypeOptions = computed(() => [
  { label: t('dns.zoneTypeFull'), value: 'full' },
  { label: t('dns.zoneTypePartial'), value: 'partial' },
]);

async function handleCreateDomains() {
  if (creatingDomains.value || plansLoading.value) return;
  if (!newDomain.value.account_id) {
    message.warning(t('dns.msg.accountRequired'));
    return;
  }
  const names = newDomain.value.names.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) {
    message.warning(t('dns.msg.domainRequired'));
    return;
  }
  const uniqueNames = inputDomainNames.value;
  createRows.value = createTableRows.value.map(row => ({ ...row }));
  creatingDomains.value = true;
  try {
    const result = await dnsStore.createDomains({
      names: uniqueNames,
      account_id: newDomain.value.account_id,
      type: newDomain.value.type,
      plan: newDomain.value.plan,
    }, (name, receipt) => {
      const row = createRows.value.find(item => item.name === name);
      if (!row) return;
      row.result = receipt;
      row.status = !receipt ? 'running' : receipt.outcome_uncertain ? 'uncertain' : receipt.activation_pending ? 'pending' : receipt.success ? 'success' : 'failed';
    });
    createResult.value = result;
    newDomain.value = { account_id: null, type: 'full', names: '', plan: 'free' };
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.createFailed'));
  } finally {
    creatingDomains.value = false;
  }
}

function copyNS(ns: string[]) {
  navigator.clipboard.writeText(ns.join('\n')).then(() => {
    message.success(t('dns.msg.nsCopied'));
  }).catch(() => {
    message.error(t('dns.msg.copyFailed'));
  });
}

// ===== 批量删除域名 =====
const showZoneDelete = ref(false);
const zoneDeleteTargets = ref<PlanChangeTarget[]>([]);
function handleBatchDelete() {
  zoneDeleteTargets.value = allDomains.value.filter(domain => selectedDomains.value.has(zoneKey(domain)) && !isDemoDomain(domain)).map(domain => ({ name: domain.name, accountId: domain.cfAccountId, zoneId: domain.id, accountLabel: domainAccountLabel(domain), plan: zonePlan(domain.plan) }));
  if (zoneDeleteTargets.value.length) showZoneDelete.value = true;
}
async function onZonesDeleted(result: DeleteZonesResult) {
  dnsStore.forgetDeletedZones(result.results);
  const deleted = new Set(result.results.filter(row => row.success).map(row => `${row.accountId}:${row.zoneId}`));
  selectedDomains.value = new Set([...selectedDomains.value].filter(key => !deleted.has(key)));
  try { await dnsStore.fetchDomains(true); } catch { message.warning(t('dns.zoneBatch.refreshFailed')); }
}

// ===== 加载账户列表 =====
async function loadAccounts() {
  // Credential labels enrich the UI independently; a slow credential response does not delay Zones.
  void loadCredentialNames();
  try { const { data } = await accountsApi.getAll(); if (!viewActive) return; accounts.value = data?.accounts || []; setDemoAccounts(data?.accounts || []); }
  catch { if (!viewActive) return; accounts.value = []; }
  dnsStore.configureAccounts(dnsAccounts.value.map(account => ({ ...account })));
}

// ===== 搜索时自动展开分组 =====
watch(groupedDomains, (groups, previous) => {
  if (selectedAccount.value === '__all__') { const old = new Set(previous.map(group => group.accountId)); expandedGroups.value = [...new Set([...expandedGroups.value, ...groups.filter(group => !old.has(group.accountId)).map(group => group.accountId)])]; }
});
watch(debouncedSearch, (val) => {
  if (val && selectedAccount.value === '__all__') {
    expandedGroups.value = groupedDomains.value.map(g => g.accountId);
  }
});

// ===== 初始化 =====
onMounted(async () => {
  await loadAccounts();
  if (!viewActive) return;
  const saved = loadSavedAccount();
  if (saved && (saved === '__all__' || dnsAccounts.value.some(account => String(account.id) === saved))) {
    selectedAccount.value = saved;
  } else if (dnsAccounts.value.length) {
    selectedAccount.value = String(dnsAccounts.value[0].id);
  } else {
    selectedAccount.value = '__all__';
  }

  onAccountChange(selectedAccount.value);
});
</script>

<style scoped>
:global(.dns-account-option--striped:not(.n-base-select-option--pending):not(.n-base-select-option--selected)) {
  background-color: var(--app-bg);
}

.dns-grid-container {
  flex: 1 1 0%;
  min-height: 0;
  height: 100% !important;
  grid-template-rows: minmax(0, 1fr) !important;
  box-sizing: border-box;
}

.dns-grid-col {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.dns-left-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dns-left-card :deep(.dns-list-content) {
  flex: 1 1 0%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dns-zone-actions {
  flex-shrink: 0;
}

.dns-zone-list {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.dns-right-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dns-right-card :deep(.dns-detail-content) {
  flex: 1 1 0%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dns-tabs {
  flex: 1 1 0%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dns-tabs :deep(.n-tab-pane) {
  flex: 1 1 0%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dns-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1 1 0%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dns-right-card :deep(.n-pagination) {
  max-width: 100%;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.dns-tab-form-scroll {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
  padding-bottom: 16px;
  display: flex;
  flex-direction: column;
}

.settings-group-card {
  background: var(--app-bg-secondary);
  border: 1px solid var(--app-border-light);
  border-radius: 12px;
  padding: 16px;
  height: 100%;
  box-sizing: border-box;
  transition: all 0.2s ease;
}

.settings-group-card:hover {
  border-color: var(--theme-primary-hover);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
}

.group-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--app-border-input);
}

.group-card-icon {
  font-size: 16px;
}

.group-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text-heading);
}

.dns-tab-form-scroll :deep(.n-form-item) {
  margin-bottom: 12px !important;
}

.settings-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
  padding: 12px 16px;
  background: var(--glass-card-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  box-shadow: var(--glass-shadow);
}
/* Naive UI 的 m 断点为 1024px；上下排列时分别限定两个面板高度。 */
@media (max-width: 1023px) {
  .dns-grid-container {
    flex: 0 0 auto;
    height: auto !important;
    grid-template-rows: none !important;
  }

  .dns-grid-col {
    height: auto;
  }

  .dns-left-card {
    height: clamp(300px, 50dvh, 420px);
  }

  .dns-right-card {
    height: clamp(480px, 70dvh, 720px);
  }
}
</style>
