<template>
  <div class="page-view">
    <!-- 顶部操作栏 -->
    <n-space justify="space-between" align="center" :wrap="true" style="margin-bottom: 12px">
      <n-h2 style="margin: 0">{{ t('dns.title') }}</n-h2>
      <n-space>
        <n-button size="small" @click="dnsStore.fetchDomains(true)" :loading="dnsStore.domainsLoading">{{ t('common.refresh') }}</n-button>
        <n-button size="small" type="primary" @click="showAddDomainModal = true">{{ t('dns.addDomain') }}</n-button>
      </n-space>
    </n-space>

    <n-space align="center" style="margin-bottom: 12px" :wrap="true">
      <n-select
        v-model:value="selectedAccount"
        :options="accountOptions"
        :placeholder="t('dns.selectAccount')"
        style="width: 200px; max-width: 50vw"
        size="small"
        @update:value="onAccountChange"
      />
      <n-input
        v-model:value="searchQuery"
        :placeholder="t('dns.searchDomain')"
        clearable
        size="small"
        style="width: 200px"
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

          <div class="dns-zone-list" role="region" :aria-label="t('dns.domainList')" tabindex="0">
            <n-spin :show="dnsStore.domainsLoading">
              <!-- 所有账户模式：分组折叠 -->
              <template v-if="selectedAccount === '__all__'">
                <n-collapse v-if="groupedDomains.length > 0" :default-expanded-names="expandedGroups">
                  <n-collapse-item
                    v-for="group in groupedDomains"
                    :key="group.accountName"
                    :name="group.accountName"
                  >
                    <template #header>
                      <n-space align="center" :size="4">
                        <span>{{ group.accountName }}</span>
                        <n-text depth="3" style="font-size: 12px">({{ group.domains.length }})</n-text>
                      </n-space>
                    </template>
                    <n-list hoverable clickable>
                      <n-list-item
                        v-for="d in group.domains"
                        :key="zoneKey(d)"
                        @click="selectDomain(d)"
                        :style="{ background: dnsStore.currentDomain === d.name && dnsStore.currentContext.accountId === d.cfAccountId ? 'var(--n-color-hover)' : '' }"
                      >
                        <div style="display: flex; align-items: flex-start; gap: 8px; width: 100%">
                          <n-checkbox
                            v-if="!isDemoDomain(d)"
                            :checked="selectedDomains.has(zoneKey(d))"
                            @update:checked="(v: boolean) => toggleDomainSelect(zoneKey(d), v)"
                            @click.stop
                          />
                          <div style="flex: 1; min-width: 0">
                            <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ d.name }}</div>
                            <n-space align="center" :size="4" style="margin-top: 2px">
                              <span :style="{ color: statusColor(d.status), fontSize: '11px' }">●</span>
                              <n-text depth="3" style="font-size: 11px">{{ statusLabel(d.status) }}</n-text>
                              <n-text depth="3" style="font-size: 11px">· {{ d.accountName }}</n-text>
                            </n-space>
                          </div>
                        </div>
                      </n-list-item>
                    </n-list>
                  </n-collapse-item>
                </n-collapse>
              </template>

              <!-- 单账户模式：平铺列表 -->
              <template v-else>
                <n-list v-if="filteredDomains.length > 0" hoverable clickable>
                  <n-list-item
                    v-for="d in filteredDomains"
                    :key="zoneKey(d)"
                    @click="selectDomain(d)"
                    :style="{ background: dnsStore.currentDomain === d.name && dnsStore.currentContext.accountId === d.cfAccountId ? 'var(--n-color-hover)' : '' }"
                  >
                    <div style="display: flex; align-items: flex-start; gap: 8px; width: 100%">
                      <n-checkbox
                        v-if="!isDemoDomain(d)"
                        :checked="selectedDomains.has(zoneKey(d))"
                        @update:checked="(v: boolean) => toggleDomainSelect(zoneKey(d), v)"
                        @click.stop
                      />
                      <div style="flex: 1; min-width: 0">
                        <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ d.name }}</div>
                        <n-space align="center" :size="4" style="margin-top: 2px">
                          <span :style="{ color: statusColor(d.status), fontSize: '11px' }">●</span>
                          <n-text depth="3" style="font-size: 11px">{{ statusLabel(d.status) }}</n-text>
                        </n-space>
                      </div>
                    </div>
                  </n-list-item>
                </n-list>
              </template>

              <n-empty v-if="!dnsStore.domainsLoading && filteredDomains.length === 0" :description="t('dns.noDomain')" style="margin: 20px 0">
                <template #extra>
                  <n-button size="small" type="primary" @click="showAddDomainModal = true">{{ t('dns.addDomainBtn') }}</n-button>
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
              <n-text v-if="currentDomainInfo" depth="3" style="font-size: 12px">· {{ currentDomainInfo.accountName }}</n-text>
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
              <n-alert v-if="dnsStore.recordsError" type="error" :bordered="false">{{ dnsStore.recordsError }}</n-alert>
              <n-space align="center" style="margin-bottom: 8px; flex-shrink: 0">
                <n-button size="small" :disabled="batchRunning" @click="selectPageRecords">{{ t('dns.batch.selectPage') }}</n-button>
                <n-button size="small" :disabled="batchRunning" @click="selectedRecordIds = filteredRecords.map(r => r.id)">{{ t('dns.batch.selectAll', { count: filteredRecords.length }) }}</n-button>
                <n-button size="small" :disabled="batchRunning" @click="selectedRecordIds = []">{{ t('common.clearSelection') }}</n-button>
                <n-text>{{ t('dns.batch.selected', { count: selectedRecordIds.length }) }}</n-text>
                <n-button size="small" :disabled="!selectedRecordIds.length || currentDomainIsDemo || batchRunning" @click="showBatchRecordEdit = true">{{ t('dns.batch.edit') }}</n-button>
                <n-button size="small" type="error" :disabled="!selectedRecordIds.length || currentDomainIsDemo || batchRunning" @click="confirmRecordBatch('delete')">{{ t('common.delete') }}</n-button>
                <n-button size="small" :loading="dnsStore.loading" @click="dnsStore.fetchRecords(dnsStore.currentDomain)">{{ t('common.refresh') }}</n-button>
                <n-button size="small" type="primary" @click="openAddRecordModal">{{ t('dns.addRecord') }}</n-button>
              </n-space>
              <n-space align="center" style="margin-bottom: 8px; flex-shrink: 0">
                <n-input v-model:value="recordSearch" :placeholder="t('dns.multi.searchRecords')" clearable size="small" style="width: 220px" />
                <n-select v-model:value="recordType" :options="recordTypeOptions" :placeholder="t('dns.recordType')" clearable size="small" style="width: 120px" />
              </n-space>
              <n-progress v-if="batchRunning" type="line" :percentage="Math.round(batchCompleted / Math.max(batchTotal, 1) * 100)" :show-indicator="true" />
              <AutoFitTable
                style="flex: 1 1 0%; min-height: 0; margin-top: 0;"
                :columns="recordColumns"
                :data="filteredRecords"
                :loading="dnsStore.loading"
                :scroll-x="680"
                :pagination="{ page: recordPage, pageSize: recordPageSize, showSizePicker: true, pageSizes: [20, 50, 100], onUpdatePage: (page: number) => recordPage = page, onUpdatePageSize: (size: number) => { recordPageSize = size; recordPage = 1; } }"
                :row-key="(row: any) => row.id"
                v-model:checked-row-keys="selectedRecordIds"
              />
            </n-tab-pane>

            <!-- Tab 2: Zone 设置 -->
            <n-tab-pane name="settings" :tab="t('dns.zoneSettings')">
              <n-alert v-if="dnsStore.settingsError" type="error" :bordered="false">{{ dnsStore.settingsError }}</n-alert>
              <n-spin :show="dnsStore.settingsLoading">
                <div class="dns-tab-form-scroll">
                  <n-grid :cols="24" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
                    <!-- 左列：SSL/TLS 安全配置 -->
                    <n-gi span="24 m:12">
                      <div class="settings-group-card">
                        <div class="group-card-header">
                          <span class="group-card-icon">🔒</span>
                          <span class="group-card-title">{{ t('dns.sslTls') }}</span>
                        </div>
                        <n-form label-placement="left" label-width="120" size="small" :disabled="dnsStore.settingsLoading">
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
                        <n-form label-placement="left" label-width="120" size="small" :disabled="dnsStore.settingsLoading">
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
                    <n-button type="primary" :loading="savingSettings" @click="handleSaveSettings">{{ t('dns.saveSettings') }}</n-button>
                  </div>
                </div>
              </n-spin>
            </n-tab-pane>

            <!-- Tab 3: 缓存与状态 -->
            <n-tab-pane name="cache" :tab="t('dns.cacheAndStatus')">
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
                                <n-button size="small" type="warning">{{ t('dns.purgeAll') }}</n-button>
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
                  <n-button type="primary" :loading="savingSettings" @click="handleSaveSettings">{{ t('dns.saveSettings') }}</n-button>
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

    <DnsBatchDialog v-model:show="showMultiDns" :zones="multiTargets" :action="multiAction" @completed="onMultiCompleted" />
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

    <!-- 批量添加域名 Modal -->
    <n-modal v-model:show="showAddDomainModal" preset="dialog" :title="t('dns.addDomainModalTitle')" style="width: 520px; max-width: 95vw">
      <n-form :model="newDomain" label-placement="left" label-width="80">
        <n-form-item :label="t('dns.targetAccount')">
          <n-select
            v-model:value="newDomain.account_id"
            :options="availableAccounts"
            :placeholder="t('dns.selectAccount')"
            filterable
          />
        </n-form-item>
        <n-form-item :label="t('dns.zoneType')">
          <n-select v-model:value="newDomain.type" :options="zoneTypeOptions" />
        </n-form-item>
        <n-form-item :label="t('dns.domainListLabel')">
          <n-input
            v-model:value="newDomain.names"
            type="textarea"
            :placeholder="t('dns.domainListPlaceholder')"
            :rows="6"
          />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showAddDomainModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="creatingDomains" @click="handleCreateDomains">{{ t('common.create') }}</n-button>
      </template>
    </n-modal>

    <!-- 创建结果 Modal -->
    <n-modal v-model:show="showResultModal" preset="dialog" :title="t('dns.resultModalTitle')" style="width: 520px; max-width: 95vw">
      <div v-if="createResult">
        <div v-for="r in createResult.results" :key="r.name" style="margin-bottom: 12px; padding: 8px; border-radius: 4px; background: var(--n-color-modal);">
          <n-space align="center" :size="8">
            <span>{{ r.success ? '✅' : '❌' }}</span>
            <span style="font-weight: 500">{{ r.name }}</span>
          </n-space>
          <div v-if="r.success && r.name_servers?.length" style="margin-top: 4px; padding-left: 24px">
            <n-text depth="3" style="font-size: 12px">NS:</n-text>
            <div v-for="ns in r.name_servers" :key="ns" style="font-size: 12px; font-family: monospace">{{ ns }}</div>
            <n-button size="tiny" @click="copyNS(r.name_servers)">{{ t('dns.copyNs') }}</n-button>
          </div>
          <div v-if="!r.success && r.error" style="margin-top: 4px; padding-left: 24px">
            <n-text type="error" style="font-size: 12px">{{ t('dns.reason') }} {{ r.error }}</n-text>
          </div>
        </div>
        <n-divider style="margin: 8px 0" />
        <n-text depth="3">{{ t('dns.resultSummary', { total: createResult.total, succeeded: createResult.succeeded, failed: createResult.failed }) }}</n-text>
      </div>
      <template #action>
        <n-button @click="showResultModal = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>
    <n-modal v-model:show="showBatchRecordEdit" preset="dialog" :title="t('dns.batch.edit')" style="width: 480px; max-width: 95vw">
      <n-text>{{ t('dns.batch.selected', { count: selectedRecordIds.length }) }}</n-text>
      <n-form label-placement="left" label-width="100" style="margin-top: 12px">
        <n-form-item label="TTL"><n-input-number v-model:value="batchTtl" :min="1" :max="86400" /><n-button style="margin-left: 8px" :disabled="batchTtl !== 1 && batchTtl < 60" @click="confirmRecordBatch('ttl')">{{ t('common.save') }}</n-button></n-form-item>
        <n-form-item label="Proxy"><n-select v-model:value="batchProxy" :options="[{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }]" /><n-button style="margin-left: 8px" @click="confirmRecordBatch('proxy')">{{ t('common.save') }}</n-button></n-form-item>
      </n-form>
      <n-text depth="3">{{ t('dns.batch.proxyHint') }}</n-text>
    </n-modal>
    <n-modal v-model:show="showRecordBatchResult" preset="dialog" :title="t('dns.batch.result')" style="width: 760px; max-width: 95vw">
      <n-text>{{ t('dns.batch.summary', { total: recordBatchResults.length, success: recordBatchResults.filter(r => r.success).length, failed: recordBatchResults.filter(r => !r.success).length }) }}</n-text>
      <n-data-table :columns="recordBatchResultColumns" :data="recordBatchResults" :max-height="320" size="small" />
      <template #action><n-button @click="showRecordBatchResult = false">{{ t('common.close') }}</n-button></template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted, watch, reactive } from 'vue';
import { NButton, NSwitch, NTag, NText, NCheckbox, useMessage, useDialog } from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useDnsStore } from '../stores/dnsStore';
import AutoFitTable from '../components/AutoFitTable.vue';
import DnsBatchDialog from '../components/DnsBatchDialog.vue';
import DnsRecordFields from '../components/DnsRecordFields.vue';
import type { BatchAction, BatchZone } from '../shared/dnsBatch';
import { dnsApi } from '../api/dns';
import { accountsApi } from '../api/accounts';
import { buildDnsRecord, DNS_TYPES } from '../utils/dnsRecord';
import { runBatch, type BatchResult } from '../utils/batchOperation';
import type { ZoneContext } from '../api/dns';
import { loadDemoAccounts, isDemoAccount } from '../utils/demoAccounts';

const { t } = useI18n();
const dnsStore = useDnsStore();
const message = useMessage();
const dialog = useDialog();

// ===== 账户过滤 =====
const selectedAccount = ref<string>('');
const searchQuery = ref('');
const accountOptions = ref<{ label: string; value: string }[]>([]);
const availableAccounts = ref<{ label: string; value: number }[]>([]);

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
  // 账户筛选：选中具体账户时按账户名过滤
  if (selectedAccount.value && selectedAccount.value !== '__all__') {
    const opt = accountOptions.value.find(o => o.value === selectedAccount.value);
    if (opt) {
      list = list.filter((d: any) => String(d.cfAccountId) === opt.value);
    }
  }
  // 域名搜索过滤
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter((d: any) => d.name?.toLowerCase().includes(q));
  }
  return list;
});

const groupedDomains = computed(() => {
  let list = allDomains.value;
  // 账户筛选：选中具体账户时仅保留该账户的域名
  if (selectedAccount.value && selectedAccount.value !== '__all__') {
    const opt = accountOptions.value.find(o => o.value === selectedAccount.value);
    if (opt) {
      list = list.filter((d: any) => String(d.cfAccountId) === opt.value);
    }
  }
  // 域名搜索过滤
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter((d: any) => d.name?.toLowerCase().includes(q));
  }
  const groups: Record<string, any[]> = {};
  for (const d of list) {
    const key = `${d.accountName || 'Unknown'} (${d.cfAccountId})`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  }
  return Object.entries(groups).map(([accountName, domains]) => ({ accountName, domains }));
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
  saveAccount(val);
  dnsStore.clearSelection();
  selectedRecordIds.value = [];
  if (val === '__all__') {
    expandedGroups.value = groupedDomains.value.map(g => g.accountName);
  }
}

const showMultiDns = ref(false);
const multiAction = ref<BatchAction>('create');
const multiTargets = ref<BatchZone[]>([]);
const multiDnsOptions = computed(() => ['create', 'update', 'delete', 'proxy', 'ttl'].map(key => ({key, label:t(`dns.multi.${key}`)})));
function selectMatchingDomains() {
  for(const domain of filteredDomains.value) if(!isDemoDomain(domain)) selectedDomains.value.add(zoneKey(domain));
  selectedDomains.value = new Set(selectedDomains.value);
}
function openMultiDns(key: string) {
  multiTargets.value = allDomains.value.filter(d => selectedDomains.value.has(zoneKey(d))).map(d => ({accountId:d.cfAccountId, credentialId:d.credentialId, zoneId:d.id, zoneName:d.name}));
  multiAction.value = key as BatchAction; showMultiDns.value = true;
}
async function onMultiCompleted(zones: BatchZone[]) { await dnsStore.invalidateRecords(zones); }
watch(() => dnsStore.domains, () => {
  const present = new Set(allDomains.value.map(zoneKey));
  selectedDomains.value = new Set([...selectedDomains.value].filter(key => present.has(key)));
});

// ===== Tab =====
const activeTab = ref('records');

async function onTabChange(tab: string) {
  if (tab === 'settings' && dnsStore.currentDomain) {
    await dnsStore.fetchZoneSettings(dnsStore.currentDomain);
    syncZoneForm();
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
      await dnsApi.updateRecord(target.domain, editingRecordId.value, payload, target.context);
      message.success(t('dns.msg.recordUpdated'));
    } else {
      await dnsApi.createRecord(target.domain, payload, target.context);
      message.success(t('dns.msg.recordAdded'));
    }
    showAddRecordModal.value = false;
    editingRecordId.value = null;
    newRecord.value = { type: 'A', name: '', content: '', ttl: 300, proxied: true, priority: 10, weight: 0, port: 443 };
    if (dnsStore.isCurrent(target.domain, target.context)) await dnsStore.fetchRecords(target.domain, target.context);
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.saveFailed'));
  } finally {
    addingRecord.value = false;
  }
}

async function handleDeleteRecord(row: any, target = captureTarget()) {
  if (!dnsStore.currentDomain) return;
  try {
    await dnsApi.deleteRecord(target.domain, row.id, target.context);
    message.success(t('dns.msg.recordDeleted'));
    if (dnsStore.isCurrent(target.domain, target.context)) await dnsStore.fetchRecords(target.domain, target.context);
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.deleteFailed'));
  }
}

async function handleProxyToggle(row: any, proxied: boolean) {
  if (!dnsStore.currentDomain) return;
  try {
    const target = captureTarget();
    await dnsApi.updateProxy(target.domain, row.id, proxied, target.context);
    if (dnsStore.isCurrent(target.domain, target.context)) await dnsStore.fetchRecords(target.domain, target.context);
    message.success(t('dns.msg.proxyUpdated'));
  } catch (err: any) {
    message.error(err?.response?.data?.error?.message || t('dns.msg.updateFailed'));
  }
}

const currentDomainIsDemo = computed(() => {
  const d = currentDomainInfo.value;
  return d ? isDemoDomain(d) : false;
});

interface DnsRow { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean }
const selectedRecordIds = ref<string[]>([]);
const recordSearch = ref('');
const recordType = ref<string | null>(null);
const recordTypeOptions = DNS_TYPES.map(value => ({ label: value, value }));
const filteredRecords = computed(() => dnsStore.records.filter(r => (!recordType.value || r.type === recordType.value) && (!recordSearch.value || `${r.name} ${r.content || ''} ${JSON.stringify(r.data || '')}`.toLowerCase().includes(recordSearch.value.toLowerCase()))));
const recordPage = ref(1);
watch([recordSearch, recordType], () => { recordPage.value = 1; });
const recordPageSize = ref(20);
const batchRunning = ref(false);
const batchCompleted = ref(0);
const batchTotal = ref(0);
const showBatchRecordEdit = ref(false);
const showRecordBatchResult = ref(false);
const recordBatchResults = ref<Array<BatchResult<DnsRow, unknown>>>([]);
const batchTtl = ref(300);
const batchProxy = ref('on');
watch(() => [dnsStore.currentDomain, dnsStore.currentContext.accountId, dnsStore.currentContext.zoneId], () => { selectedRecordIds.value = []; recordPage.value = 1; showAddRecordModal.value = false; });
function selectPageRecords() {
  selectedRecordIds.value = filteredRecords.value.slice((recordPage.value - 1) * recordPageSize.value, recordPage.value * recordPageSize.value).map(row => row.id);
}
function confirmRecordBatch(action: 'delete' | 'ttl' | 'proxy') {
  const ids = new Set(selectedRecordIds.value);
  const rows: DnsRow[] = dnsStore.records.filter(row => ids.has(row.id)).map(row => ({ ...row }));
  if (!rows.length || batchRunning.value || currentDomainIsDemo.value) return;
  const target = captureTarget();
  const ttl = batchTtl.value;
  const proxied = batchProxy.value === 'on';
  dialog.warning({
    title: action === 'delete' ? t('common.delete') : t('dns.batch.edit'),
    content: t('dns.batch.confirm', { action: action === 'delete' ? t('common.delete') : action === 'ttl' ? `TTL ${ttl}` : `Proxy ${proxied ? 'on' : 'off'}`, count: rows.length, domain: target.domain, account: currentDomainInfo.value?.accountName || target.context.accountId, records: rows.slice(0, 8).map(row => `${row.type} ${row.name} → ${row.content}`).join('; '), more: rows.length > 8 ? t('dns.batch.more', { count: rows.length - 8 }) : '' }),
    positiveText: t('common.confirm'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      showBatchRecordEdit.value = false;
      batchRunning.value = true; batchCompleted.value = 0; batchTotal.value = rows.length;
      try {
        recordBatchResults.value = await runBatch(rows, async row => {
          if (action === 'delete') return dnsApi.deleteRecord(target.domain, row.id, target.context);
          if (action === 'proxy') {
            if (!['A', 'AAAA', 'CNAME'].includes(row.type)) throw new Error(t('dns.batch.proxyUnsupported', { name: row.name, type: row.type }));
            return dnsApi.updateRecord(target.domain, row.id, { proxied }, target.context);
          }
          if (row.proxied && ttl !== 1) throw new Error(t('dns.batch.proxyTtl', { name: row.name }));
          return dnsApi.updateRecord(target.domain, row.id, { ttl }, target.context);
        }, count => { batchCompleted.value = count; });
        if (dnsStore.isCurrent(target.domain, target.context)) { await dnsStore.fetchRecords(target.domain, target.context); selectedRecordIds.value = []; }
        showRecordBatchResult.value = true;
      } finally { batchRunning.value = false; }
    },
  });
}
const recordBatchResultColumns = computed<DataTableColumns<BatchResult<DnsRow, unknown>>>(() => [
  { title: t('dns.recordName'), key: 'name', render: row => `${row.item.type} ${row.item.name}` },
  { title: t('common.result'), key: 'success', render: row => row.success ? t('common.success') : t('common.error') },
  { title: t('common.message'), key: 'error' },
]);

const recordColumns = computed<DataTableColumns<any>>(() => [
  { type: 'selection', width: 40, disabled: () => currentDomainIsDemo.value || batchRunning.value },
  { title: t('dns.recordType'), key: 'type', width: 80, render: (row) => h(NTag, { size: 'small', type: 'info' }, { default: () => row.type }) },
  { title: t('dns.recordName'), key: 'name', width: 180, ellipsis: { tooltip: true } },
  { title: t('dns.recordContent'), key: 'content', minWidth: 180, ellipsis: { tooltip: true } },
  { title: t('dns.ttl'), key: 'ttl', width: 80, render: (row) => row.ttl === 1 ? t('dns.ttlAuto') : String(row.ttl) },
  {
    title: t('dns.proxied'), key: 'proxied', width: 80,
    render: (row) => h(NSwitch, { value: row.proxied, disabled: currentDomainIsDemo.value || !['A', 'AAAA', 'CNAME'].includes(row.type) || batchRunning.value, onUpdateValue: (v: boolean) => handleProxyToggle(row, v), size: 'small' }),
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
const savingSettings = ref(false);
const zoneForm = reactive<Record<string, any>>({});
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

function syncZoneForm() {
  for (const key of Object.keys(zoneForm)) delete zoneForm[key];
  for (const [key, value] of Object.entries(dnsStore.zoneSettings)) if (key !== '__meta') zoneForm[key] = value;
  minifyJs.value = dnsStore.zoneSettings.minify?.js === 'on';
  minifyCss.value = dnsStore.zoneSettings.minify?.css === 'on';
  minifyHtml.value = dnsStore.zoneSettings.minify?.html === 'on';
}
function settingEditable(key: string): boolean { return !dnsStore.settingsLoading && !dnsStore.settingsError && dnsStore.zoneSettings.__meta?.[key]?.editable === true; }
watch(() => dnsStore.zoneSettings, syncZoneForm);
async function handleSaveSettings() {
  if (!dnsStore.currentDomain) return;
  const domain = dnsStore.currentDomain;
  savingSettings.value = true;
  try {
    const settings = Object.fromEntries(Object.entries(zoneForm).filter(([key, value]) => settingEditable(key) && JSON.stringify(value) !== JSON.stringify(dnsStore.zoneSettings[key])));
    const result = await dnsStore.updateZoneSettings(domain, settings);
    if (result.failed?.length) message.warning(Object.entries(result.errors || {}).map(([key, error]) => `${key}: ${error}`).join('; '));
    else message.success(t('dns.msg.settingsUpdated'));
  } finally { savingSettings.value = false; }
}

// ===== 缓存清除 =====
const showUrlPurge = ref(false);
const purgeUrls = ref('');
const purging = ref(false);

async function handlePurgeAll() {
  if (!dnsStore.currentDomain) return;
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
  if (!dnsStore.currentDomain) return;
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
  if (!dnsStore.currentDomain || !currentDomainInfo.value) return;
  const isPaused = currentDomainInfo.value.status === 'paused';
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
const newDomain = ref<{ account_id: number | null; type: 'full' | 'partial'; names: string }>({ account_id: null, type: 'full', names: '' });
const showResultModal = ref(false);
const createResult = ref<any>(null);
const zoneTypeOptions = computed(() => [
  { label: t('dns.zoneTypeFull'), value: 'full' },
  { label: t('dns.zoneTypePartial'), value: 'partial' },
]);

async function handleCreateDomains() {
  if (!newDomain.value.account_id) {
    message.warning(t('dns.msg.accountRequired'));
    return;
  }
  const names = newDomain.value.names.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) {
    message.warning(t('dns.msg.domainRequired'));
    return;
  }
  const uniqueNames = [...new Set(names)];
  creatingDomains.value = true;
  try {
    const result = await dnsStore.createDomains({
      names: uniqueNames,
      account_id: newDomain.value.account_id,
      type: newDomain.value.type,
    });
    createResult.value = result;
    showResultModal.value = true;
    showAddDomainModal.value = false;
    newDomain.value = { account_id: null, type: 'full', names: '' };
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
function handleBatchDelete() {
  const domains = allDomains.value.filter(d => selectedDomains.value.has(zoneKey(d))).map(d => ({ name: d.name, accountId: d.cfAccountId, zoneId: d.id }));
  if (!domains.length) return;
  dialog.warning({
    title: t('dns.msg.batchDeleteTitle'),
    content: `${t('dns.msg.batchDeleteConfirm', { count: domains.length })} ${domains.map(d => `${d.name} (Account ${d.accountId})`).join(', ')}`,
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        const result = await dnsStore.deleteDomains(domains);
        message.success(t('dns.msg.batchDeleteComplete', { succeeded: result.succeeded, failed: result.failed }));
        selectedDomains.value = new Set();
      } catch (err: any) {
        message.error(err?.response?.data?.error?.message || t('dns.msg.deleteFailed'));
      }
    },
  });
}

// ===== 加载账户列表 =====
async function loadAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    const accounts = data?.accounts || [];
    accountOptions.value = [
      { label: t('dns.allAccounts'), value: '__all__' },
      ...accounts.map((a: any) => ({ label: a.name, value: String(a.id) })),
    ];
    availableAccounts.value = accounts
      .filter((a: any) => a.account_id)
      .map((a: any) => ({ label: a.name, value: a.id }));
  } catch {
    accountOptions.value = [{ label: t('dns.allAccounts'), value: '__all__' }];
  }
}

// ===== 搜索时自动展开分组 =====
watch(searchQuery, (val) => {
  if (val && selectedAccount.value === '__all__') {
    expandedGroups.value = groupedDomains.value.map(g => g.accountName);
  }
});

// ===== 初始化 =====
onMounted(async () => {
  loadDemoAccounts();
  await loadAccounts();
  await dnsStore.fetchDomains();

  const saved = loadSavedAccount();
  if (saved && accountOptions.value.some(o => o.value === saved)) {
    selectedAccount.value = saved;
  } else if (accountOptions.value.length > 1) {
    selectedAccount.value = accountOptions.value[1].value;
  } else {
    selectedAccount.value = '__all__';
  }

  expandedGroups.value = groupedDomains.value.map(g => g.accountName);
});
</script>

<style scoped>
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
