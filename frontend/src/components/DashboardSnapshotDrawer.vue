<template>
  <n-drawer :show="show" :width="520" style="max-width:100vw" @update:show="$emit('update:show',$event)">
    <n-drawer-content :title="t('overview.resourceCollection')" closable body-content-style="overflow-wrap:anywhere">
      <n-alert v-if="error" type="warning" style="margin-bottom:16px">{{ error }}</n-alert>
      <n-descriptions :column="1" bordered>
        <n-descriptions-item :label="t('overview.status')">{{ t(`overview.scan.states.${scan?.state??'idle'}`) }}</n-descriptions-item>
        <n-descriptions-item :label="t('overview.lastSuccessfulScan')">{{ time(scan?.lastSuccessfulScanAt) }}</n-descriptions-item>
        <n-descriptions-item :label="t('overview.scan.lastFull')">{{ time(scan?.latestFullScan?.finishedAt) }} <template v-if="scan?.latestFullScan">· {{ t(`overview.scan.states.${scan.latestFullScan.state}`) }}</template></n-descriptions-item>
        <n-descriptions-item :label="t('overview.scan.next')">{{ time(scan?.nextScanAt) }}</n-descriptions-item>
        <n-descriptions-item v-if="scan?.job?.lastErrorKind" :label="t('overview.lastError')">{{ scan.job.lastErrorKind }}</n-descriptions-item>
      </n-descriptions>
      <div v-if="scan?.job" class="scan-progress">
        <strong>{{ scan.job.completed }} / {{ scan.job.total }}</strong>
        <n-progress type="line" :percentage="scan.job.total ? Math.floor(scan.job.completed/scan.job.total*100) : 0" :show-indicator="false" />
        <p>{{ t('overview.success') }} {{ scan.job.succeeded }} · {{ t('overview.failure') }} {{ scan.job.failed }} · {{ t('overview.scan.skipped') }} {{ scan.job.skipped }}</p>
        <p v-for="current in scan.job.currentResource" :key="`${current.accountId}:${current.metric}`">{{ current.accountName }} / {{ t(`overview.metrics.${current.metric}`) }}</p>
        <p v-if="scan.job.nextEligibleAt">{{ t('overview.scan.cooldown') }} {{ time(scan.job.nextEligibleAt) }}</p>
        <ul><li v-for="item in scan.job.resources" :key="item.metric">{{ t(`overview.metrics.${item.metric}`) }} · {{ item.succeeded }} / {{ item.total }} · {{ t('overview.failure') }} {{ item.failed }} · {{ t('overview.scan.skipped') }} {{ item.skipped }}</li></ul>
      </div>
      <div class="scan-actions">
        <n-button :disabled="running || scan?.state==='paused' || busy" @click="$emit('collect',false,false)">{{ t('overview.collectMissing') }}</n-button>
        <n-button :disabled="!accountId || running || scan?.state==='paused' || busy" @click="$emit('collect',true,false)">{{ t('overview.forceCurrent') }}</n-button>
        <n-button :disabled="running || scan?.state==='paused' || busy" @click="$emit('collect',true,true)">{{ t('overview.scan.forceAll') }}</n-button>
        <n-button v-if="running" :loading="busy" @click="$emit('pause')">{{ t('overview.pause') }}</n-button>
        <n-button v-if="scan?.state==='paused'" :loading="busy" @click="$emit('resume')">{{ t('overview.scan.resume') }}</n-button>
      </div>
      <p class="hint">{{ t('overview.collectionHint') }}</p>
      <p v-if="scan?.execution==='request_batches'" class="hint">{{ t('overview.scan.pagesHint') }}</p>
    </n-drawer-content>
  </n-drawer>
</template>
<script setup lang="ts">
import {computed} from 'vue';
import {useI18n} from 'vue-i18n';
import type {ScanStatus} from '../shared/dashboardScanTypes';
import {scanIsRunning} from '../utils/dashboardCollection';
import {formatCN} from '../utils/dateFormat';
const props=defineProps<{show:boolean;scan?:ScanStatus;accountId:number|null;busy?:boolean;error?:string}>();
defineEmits<{'update:show':[boolean];collect:[boolean,boolean];pause:[];resume:[]}>();
const {t}=useI18n(),running=computed(()=>!!props.scan&&scanIsRunning(props.scan.state));
const time=(value?:number|null)=>value?formatCN(value):'—';
</script>
<style scoped>
.scan-progress{margin:22px 0;font-size:13px}.scan-progress>strong{display:block;font-size:22px;margin-bottom:12px}.scan-progress p{margin:8px 0}.scan-progress ul{padding-left:18px;line-height:1.9}.scan-actions{display:grid;gap:10px;margin-top:20px}.hint{font-size:12px;opacity:.65;line-height:1.7;margin-top:16px}
</style>
