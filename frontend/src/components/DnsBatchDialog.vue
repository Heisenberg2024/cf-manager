<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    :title="t('dns.multi.title')"
    :mask-closable="!running"
    :close-on-esc="!running"
    :closable="!running"
    style="width: 1000px; max-width: 96vw"
  >
    <n-space
      align="center"
      style="margin-bottom: 12px"
    >
      <n-tag :type="step === 'configure' ? 'info' : 'default'">
        1 {{ t('dns.multi.configure') }}
      </n-tag><span>→</span><n-tag :type="step === 'preview' ? 'info' : 'default'">
        2 Preview
      </n-tag><span>→</span><n-tag :type="step === 'confirm' ? 'warning' : 'default'">
        3 {{ t('dns.multi.confirm') }}
      </n-tag><span>→</span><n-tag :type="step === 'execute' ? 'info' : 'default'">
        4 {{ t('dns.multi.execute') }}
      </n-tag><span>→</span><n-tag :type="step === 'result' ? 'info' : 'default'">
        5 {{ t('dns.multi.result') }}
      </n-tag>
    </n-space>
    <n-text>{{ t('dns.multi.selected', { count: targets.length }) }} · {{ t(`dns.multi.${operation}`) }}</n-text>
    <div class="batch-body">
      <n-form
        v-if="step === 'configure'"
        label-placement="left"
        label-width="120"
        style="margin-top: 12px"
      >
        <template v-if="operation !== 'create'">
          <n-form-item :label="t('dns.recordType')">
            <n-select
              v-model:value="types"
              multiple
              :options="typeOptions"
            />
          </n-form-item>
          <n-form-item label="Host">
            <n-input
              v-model:value="host"
              :placeholder="t('dns.multi.hostHint')"
            />
          </n-form-item>
          <n-form-item :label="t('dns.multi.currentContent')">
            <n-input
              v-model:value="currentContent"
              clearable
              :placeholder="t('dns.multi.optionalExact')"
            />
          </n-form-item>
        </template>
        <template v-if="operation === 'update'">
          <n-form-item :label="t('dns.multi.fields')">
            <n-checkbox-group v-model:value="fields">
              <n-space>
                <n-checkbox
                  v-for="f in patchFields"
                  :key="f"
                  :value="f"
                  :label="f"
                />
              </n-space>
            </n-checkbox-group>
          </n-form-item>
          <DnsRecordFields
            v-model="record"
            :fields="fields"
            patch
          />
        </template>
        <DnsRecordFields
          v-else-if="operation === 'create'"
          v-model="record"
        />
        <DnsRecordFields
          v-else-if="operation === 'proxy'"
          v-model="record"
          :fields="['proxied']"
          patch
        />
        <DnsRecordFields
          v-else-if="operation === 'ttl'"
          v-model="record"
          :fields="['ttl']"
          patch
        />
        <n-form-item
          v-if="operation === 'create'"
          :label="t('dns.multi.duplicatePolicy')"
        >
          <n-select
            v-model:value="policy"
            :options="policies"
          />
        </n-form-item>
        <n-text depth="3">
          {{ t('dns.multi.hostHint') }} {{ t('dns.multi.patchHint') }}
        </n-text>
      </n-form>
      <template v-else>
        <n-alert
          v-if="step === 'confirm'"
          :type="operation === 'delete' ? 'error' : 'warning'"
          style="margin: 12px 0"
          :title="t('dns.multi.confirmTitle')"
        >
          {{ t('dns.multi.confirmSummary', { zones: targets.length, records: actionable, missing: counts.NOT_FOUND, conflicts: counts.CONFLICT }) }}
          <div>{{ items.filter(i => ['READY', 'FOUND'].includes(i.status)).slice(0, 5).map(i => i.name).join(' · ') }}</div>
          <n-checkbox
            v-model:checked="confirmed"
            style="margin-top: 8px"
          >
            {{ t('dns.multi.confirmChecked', { count: actionable }) }}
          </n-checkbox>
        </n-alert>
        <n-space
          align="center"
          style="margin: 12px 0"
        >
          <n-text>{{ t(step === 'execute' ? 'dns.multi.progress' : step === 'result' ? 'dns.multi.progressDone' : 'dns.multi.previewCount', { done: completed, total: items.length }) }}</n-text><n-text>{{ t('dns.multi.summary', { success: counts.SUCCESS, skipped: counts.SKIP + counts.SKIPPED, conflict: counts.CONFLICT, failed: counts.ERROR + counts.FAILED, missing: counts.NOT_FOUND }) }}</n-text><n-select
            v-model:value="filter"
            :options="filterOptions"
            style="width: 160px"
            size="small"
          />
        </n-space>
        <n-progress
          v-if="running"
          type="line"
          :percentage="Math.round(completed / Math.max(1, items.length) * 100)"
        />
        <n-data-table
          :columns="columns"
          :data="filteredItems"
          :row-key="(row: BatchItem) => row.id"
          :max-height="360"
          :scroll-x="1050"
          :pagination="{ pageSize: 20 }"
          size="small"
        />
        <n-alert
          v-if="step === 'result'"
          :type="counts.FAILED || counts.CONFLICT || counts.NOT_FOUND || streamError ? 'warning' : 'success'"
          style="margin-top: 12px"
        >
          {{ streamError || t(counts.FAILED || counts.CONFLICT || counts.NOT_FOUND ? 'dns.multi.completedErrors' : 'dns.multi.completed') }}
        </n-alert>
      </template>
    </div>
    <template #footer>
      <n-space justify="end">
        <n-button
          :disabled="running"
          @click="visible = false"
        >
          {{ t('common.close') }}
        </n-button>
        <n-button
          v-if="step === 'preview' || step === 'confirm'"
          @click="step = 'configure'; preview = null"
        >
          {{ t('dns.multi.back') }}
        </n-button>
        <n-button
          v-if="step === 'configure'"
          type="primary"
          :loading="previewing"
          @click="makePreview"
        >
          Preview
        </n-button>
        <n-button
          v-if="step === 'preview'"
          type="primary"
          :disabled="!actionable"
          @click="step = 'confirm'; confirmed = false"
        >
          {{ t('dns.multi.confirm') }}
        </n-button>
        <n-button
          v-if="step === 'confirm'"
          :type="operation === 'delete' ? 'error' : 'primary'"
          :disabled="!confirmed"
          @click="execute"
        >
          {{ t('dns.multi.executeCount', {count: actionable}) }}
        </n-button>
        <n-button
          v-if="step === 'result'"
          @click="reset"
        >
          {{ t('dns.multi.newPreview') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>
<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import DnsRecordFields from './DnsRecordFields.vue';
import { DNS_TYPES, type DnsRecordForm, type DnsRecordInput } from '../utils/dnsRecord';
import { summarizeBatch, validateBatchSpec, type BatchAction, type BatchZone, type BatchPreview, type BatchItem, type BatchSpec } from '../shared/dnsBatch';
import { dnsApi } from '../api/dns';
const visible = defineModel<boolean>('show', { required: true });
const props = defineProps<{ zones: BatchZone[]; action: BatchAction }>();
const emit = defineEmits<{ completed: [zones: BatchZone[]] }>();
const { t } = useI18n(); const message = useMessage();
const targets = ref<BatchZone[]>([]); const operation = ref<BatchAction>('create');
const step = ref<'configure' | 'preview' | 'confirm' | 'execute' | 'result'>('configure');
const types = ref<string[]>(['A']); const host = ref('www'); const currentContent = ref('');
const record = ref<DnsRecordForm>({ type: 'A', name: 'www', content: '', ttl: 1, proxied: true, priority: 10, weight: 0, port: 443, flags: 0, tag: 'issue', comment: '' });
const fields = ref<string[]>(['content']); const policy = ref<'skip' | 'update' | 'create'>('skip');
const preview = ref<BatchPreview | null>(null); const items = ref<BatchItem[]>([]); const filter = ref('all');
const previewing = ref(false); const running = ref(false); const completed = ref(0); const confirmed = ref(false); const streamError = ref('');
let generation = 0;
const counts = computed(() => summarizeBatch(items.value));
const actionable = computed(() => counts.value.READY + counts.value.FOUND);
const typeOptions = DNS_TYPES.map(value => ({ label: value, value }));
const patchFields = computed(() => ['content', 'ttl', 'proxied', 'comment', ...(['MX','SRV'].includes(record.value.type) ? ['priority'] : []), ...(record.value.type === 'SRV' ? ['weight','port'] : []), ...(record.value.type === 'CAA' ? ['flags','tag'] : [])]);
const policies = computed(() => ['skip','update','create'].map(value => ({ label: t(`dns.multi.policy.${value}`), value })));
const filterOptions = computed(() => ['all','success','failed','skipped','conflict','missing'].map(value => ({label: t(`dns.multi.filter.${value}`), value})));
const filteredItems = computed(() => items.value.filter(i => filter.value === 'all' || ({success:['SUCCESS'], failed:['FAILED','ERROR'], skipped:['SKIPPED','SKIP'], conflict:['CONFLICT'], missing:['NOT_FOUND']} as Record<string,string[]>)[filter.value]?.includes(i.status)));
const columns = computed<DataTableColumns<BatchItem>>(() => [
 {title: t('dns.multi.zone'), key: 'zone', width: 180, render: r => `${r.zone.zoneName} (#${r.zone.accountId})`},
 {title: 'DNS', key: 'name', width: 190, ellipsis: {tooltip: true}},
 {title: t('dns.multi.action'), key: 'action', width: 90, render: r => r.operation === 'POST' ? 'CREATE' : r.operation === 'DELETE' ? 'DELETE' : r.operation === 'PATCH' ? 'PATCH' : r.action.toUpperCase()},
 {title: t('dns.multi.change'), key: 'after', width: 240, render: r => r.action === 'delete' ? `${r.type} ${r.before?.content || JSON.stringify(r.before?.data || '')}` : Object.entries(r.after || {}).map(([k,v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')},
 {title: t('dns.multi.result'), key: 'status', width: 110, render: r => h(NTag,{size:'small',type:['SUCCESS','READY','FOUND'].includes(r.status)?'success':['FAILED','ERROR','CONFLICT'].includes(r.status)?'error':'default'},()=>r.status)},
 {title: t('dns.multi.detail'), key: 'message', minWidth: 240, render: r => [r.httpStatus ? `HTTP ${r.httpStatus}` : '',r.cfCodes?.length ? `CF ${r.cfCodes.join(',')}` : '',r.message].filter(Boolean).join(' · ')},
]);
function reset() { policy.value = 'skip'; ++generation; previewing.value = false; preview.value = null; items.value = []; step.value = 'configure'; filter.value = 'all'; completed.value = 0; confirmed.value = false; streamError.value = ''; }
watch(visible, show => { if(show) { reset(); targets.value = props.zones.map(z => ({...z})); operation.value = props.action; if(operation.value === 'proxy') types.value=['A','AAAA','CNAME']; } else ++generation; });
watch(types, value => { if(value.length && (value.length === 1 || !value.includes(record.value.type))) record.value.type = value[0]!; },{deep:true});
watch(() => record.value.type, () => { fields.value = fields.value.filter(f => patchFields.value.includes(f)); });
watch([record, types, host, currentContent, fields, policy], () => { if(step.value === 'configure') { ++generation; previewing.value = false; preview.value = null; } }, {deep: true});
function spec(): BatchSpec {
 const changes: DnsRecordInput = {};
 const keys = operation.value === 'proxy' ? ['proxied'] : operation.value === 'ttl' ? ['ttl'] : fields.value;
 for(const key of keys) {
   if(['weight','port','flags','tag'].includes(key)) { changes.data = {...changes.data,[key]:record.value[key as keyof DnsRecordForm] as string | number}; }
   else Object.assign(changes,{[key]:record.value[key as keyof DnsRecordForm]});
 }
 return validateBatchSpec({ zones: targets.value, action: operation.value, match: {host: operation.value === 'create' ? record.value.name : host.value, types: operation.value === 'create' ? [record.value.type] : types.value, ...(currentContent.value ? {currentContent: currentContent.value} : {})}, ...(operation.value === 'create' ? {record:record.value,conflictPolicy:policy.value} : operation.value === 'delete' ? {} : {changes}) });
}
async function makePreview() {
 const identity = ++generation; previewing.value = true;
 try { const {data} = await dnsApi.previewBatch(spec()); if(identity !== generation) return; preview.value = data; items.value = data.items; step.value = 'preview'; }
 catch(error: unknown) { if(identity === generation) message.error((error as {errorMessage?: string}).errorMessage || (error as Error).message); }
 finally { if(identity === generation) previewing.value=false; }
}
async function execute() {
 if(!preview.value || !confirmed.value || running.value) return;
 running.value=true; step.value='execute'; const targetsSnapshot=targets.value.map(z=>({...z}));
 try { await dnsApi.executeBatch(preview.value,event=>{
   if(event.items) items.value=event.items;
   if(event.item) { const index=items.value.findIndex(i=>i.id===event.item!.id); if(index>=0) items.value[index]=event.item; }
   completed.value=event.completed ?? completed.value;
 }); } catch(error: unknown) { streamError.value=(error as Error).message; }
 finally { running.value=false; step.value='result'; preview.value=null; emit('completed', targetsSnapshot); }
}
</script>
<style scoped>
.batch-body { max-height: 65vh; overflow: auto; }
</style>
