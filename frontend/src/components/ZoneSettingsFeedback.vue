<template>
  <div style="margin-bottom: 12px; flex-shrink: 0">
    <n-space align="center">
      <n-button size="small" :loading="store.settingsLoading" :disabled="saving" @click="store.fetchZoneSettings(store.currentDomain,store.currentContext,true)">{{ t('common.refresh') }}</n-button>
      <n-button size="small" :disabled="!store.settingsDirty.length || saving" @click="store.cancelSettings()">{{ t('dns.settingsState.cancel') }}</n-button>
      <n-text v-if="store.settingsDirty.length" type="warning">{{ t('dns.settingsState.dirty',{count:store.settingsDirty.length}) }}</n-text>
      <n-text v-if="store.settingsLoading" depth="3">{{ Object.keys(store.zoneSettings).length ? t('dns.cacheStatus.refreshing') : t('common.loading') }}</n-text>
      <n-text v-if="saving" depth="3">{{ t('dns.settingsState.saving',{count:store.settingsDirty.length}) }} · {{ store.settingsProgress[store.settingsKey(store.currentDomain,store.currentContext)]?.completed || 0 }}/{{ store.settingsDirty.length }} · PATCH {{ store.settingsProgress[store.settingsKey(store.currentDomain,store.currentContext)]?.patchCount || 0 }}</n-text>
    </n-space>
    <n-alert v-if="store.settingsDraftLocked" type="warning" :bordered="false">{{ t('dns.settingsState.draftLimit') }}</n-alert>
    <n-alert v-if="store.settingsError" type="warning" :bordered="false">{{ store.settingsError }} · {{ t('dns.settingsState.stale') }}</n-alert>
    <n-alert v-if="store.settingsConflicts.length" type="warning" :bordered="false">{{ t('dns.settingsState.conflict') }}: {{ store.settingsConflicts.join(', ') }}</n-alert>
    <n-collapse v-if="Object.keys(store.zoneSettings.__meta || {}).length || Object.keys(store.settingsResults).length" style="margin-top: 8px">
      <n-collapse-item :title="t('dns.settingsState.fields')" name="fields">
        <div v-for="(meta,key) in store.zoneSettings.__meta" :key="key" style="margin-bottom: 6px; overflow-wrap: anywhere">
          <n-text>{{ key }} · {{ t(`dns.settingsState.${store.settingsResults[key]?.status || meta.state || (meta.editable ? 'available' : 'readonly')}`) }}</n-text>
          <n-text depth="3"> · {{ JSON.stringify(store.settingsResults[key]?.actual ?? store.zoneSettings[key]) ?? '—' }} · {{ store.settingsResults[key]?.reason || meta.reason || '' }}</n-text>
        </div>
        <n-text depth="3">{{ t('dns.settingsState.nonAtomic') }}</n-text>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>
<script setup lang="ts">
import {useI18n} from 'vue-i18n';
import {useDnsStore} from '../stores/dnsStore';
defineProps<{saving:boolean}>();
const store=useDnsStore();
const {t}=useI18n();
</script>
