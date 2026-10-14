<template>
  <div class="audit-page" tabindex="0" @keydown="pageScrollKey">
    <div class="audit-heading">
      <div><h2>{{ t('audit.title') }}</h2><p>{{ t('audit.description') }}</p></div><n-button
        :loading="loading"
        @click="query"
      >
        {{ t('common.refresh') }}
      </n-button>
    </div>
    <n-card size="small">
      <div class="audit-filters">
        <n-select
          v-model:value="filters.accountId"
          clearable
          filterable
          :options="accounts"
          :placeholder="t('overview.allAccounts')"
        />
        <n-select
          v-model:value="filters.action"
          clearable
          filterable
          tag
          :options="actions"
          :placeholder="t('audit.action')"
        />
        <n-select
          v-model:value="filters.status"
          clearable
          :options="statusOptions"
          :placeholder="t('overview.status')"
        />
        <label>{{ t('audit.startDate') }} (UTC)<n-date-picker
          v-model:formatted-value="filters.startDate"
          type="date"
          value-format="yyyy-MM-dd"
          clearable
        /></label>
        <label>{{ t('audit.endDate') }} (UTC)<n-date-picker
          v-model:formatted-value="filters.endDate"
          type="date"
          value-format="yyyy-MM-dd"
          clearable
        /></label>
        <n-input
          v-model:value="filters.target"
          clearable
          :placeholder="t('audit.target')"
          @keyup.enter="query"
        />
        <n-button
          type="primary"
          :loading="loading"
          @click="query"
        >
          {{ t('audit.query') }}
        </n-button>
      </div>
    </n-card>
    <n-alert
      v-if="error"
      type="error"
    >
      {{ error }}
    </n-alert>
    <div class="audit-stats">
      <n-card
        v-for="key in ['total','success','error']"
        :key="key"
        size="small"
      >
        <n-statistic
          :label="t(`audit.${key}`)"
          :value="stats?.[key] ?? '—'"
        />
      </n-card>
    </div>
    <n-alert
      v-if="statsError"
      type="warning"
    >
      {{ statsError }}
    </n-alert>
    <div class="audit-distribution">
      <n-tag
        v-for="item in stats?.actions"
        :key="item.action"
        size="small"
      >
        {{ actionLabel(item.action) }} {{ item.count }}
      </n-tag>
    </div>
    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(row:AuditEvent)=>row.id"
      :scroll-x="1000"
      size="small"
    />
    <div class="audit-pagination">
      <span>{{ t('audit.page', {page:pageNumber}) }} · {{ t('audit.cursorNotice') }}</span><n-space>
        <n-button
          :disabled="!history.length || loading"
          @click="previous"
        >
          {{ t('audit.previous') }}
        </n-button><n-button
          :disabled="!nextCursor || loading"
          @click="next"
        >
          {{ t('audit.next') }}
        </n-button>
      </n-space>
    </div>
    <n-drawer
      :show="!!selected"
      :width="560"
      style="max-width:100vw"
      @update:show="(value:boolean)=>{if(!value)selected=null;}"
    >
      <n-drawer-content
        :title="t('audit.details')"
        closable
        body-content-style="min-width:0;overflow-wrap:anywhere"
      >
        <n-descriptions
          v-if="selected"
          :column="1"
          bordered
        >
          <n-descriptions-item :label="t('audit.time')">
            {{ formatCN(selected.created_at) }} (UTC+8)
          </n-descriptions-item><n-descriptions-item :label="t('overview.accounts')">
            {{ selected.account_name || '—' }} (#{{ selected.account_id || '—' }})
          </n-descriptions-item><n-descriptions-item :label="t('audit.action')">
            {{ actionLabel(selected.action) }}
          </n-descriptions-item><n-descriptions-item :label="t('audit.target')">
            {{ selected.target || '—' }}
          </n-descriptions-item><n-descriptions-item :label="t('overview.status')">
            {{ selected.status }}
          </n-descriptions-item>
        </n-descriptions>
        <p class="detail-hint">
          {{ t('audit.redactionNotice') }}
        </p><pre>{{ selected?.detail || '—' }}</pre>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>
<script setup lang="ts">
import {pageScrollKey} from '../utils/pageScrolling';
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { NButton, NTag } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import client from '../api/client';
import {useAccountLabels} from '../utils/useAccountLabels';
import {accountsApi} from '../api/accounts';
import type { AuditPage } from '../api/dashboard';
import type { AuditEvent, auditStats } from '../shared/auditQueries';
import { formatCN } from '../utils/dateFormat';
import { createRequestScope } from '../utils/requestScope';
const {t,te}=useI18n(),route=useRoute();
const {accountLabel,loadCredentialNames}=useAccountLabels();
const filters=reactive({accountId:route.query.accountId?Number(route.query.accountId):null as number|null,action:null as string|null,status:null as string|null,startDate:null as string|null,endDate:null as string|null,target:''});
const accounts=ref<Array<{label:string;value:number}>>([]),actions=ref<Array<{label:string;value:string}>>([]);
const rows=ref<AuditEvent[]>([]),selected=ref<AuditEvent|null>(null),loading=ref(false),error=ref(''),statsError=ref('');
const stats=ref<Awaited<ReturnType<typeof auditStats>>>();
const cursor=ref<string|null>(null),nextCursor=ref<string|null>(null),history=ref<Array<string|null>>([]),pageNumber=computed(()=>history.value.length+1);
let applied:Record<string,unknown>={};const controller=new AbortController();const requests=createRequestScope();
const actionLabel=(action:string)=>te(`dashboard.actions.${action}`)?t(`dashboard.actions.${action}`):action;
const statusOptions=computed(()=>[{label:t('overview.success'),value:'success'},{label:t('overview.failure'),value:'error'}]);
const columns=computed(()=>[
 {title:t('audit.time'),key:'created_at',width:170,render:(r:AuditEvent)=>formatCN(r.created_at)},
 {title:t('overview.accounts'),key:'account_name',width:180,ellipsis:{tooltip:true}},
 {title:t('audit.action'),key:'action',width:200,render:(r:AuditEvent)=>actionLabel(r.action)},
 {title:t('audit.target'),key:'target',width:260,ellipsis:{tooltip:true}},
 {title:t('overview.status'),key:'status',width:90,render:(r:AuditEvent)=>h(NTag,{type:r.status==='success'?'success':'error',size:'small'},()=>r.status==='success'?t('overview.success'):t('overview.failure'))},
 {title:t('audit.details'),key:'details',width:100,render:(r:AuditEvent)=>h(NButton,{text:true,type:'primary',onClick:()=>{selected.value=r;}},()=>t('audit.details'))},
]);
async function loadPage(){const request=requests.begin('page');loading.value=true;error.value='';selected.value=null;
 try{const {data}=await client.get<AuditPage>('/audit-log/page',{params:{...applied,limit:50,...(cursor.value?{cursor:cursor.value}:{})},signal:controller.signal,_silent:true});if(request.current()){rows.value=data.items;nextCursor.value=data.nextCursor;}}
 catch(e){if(request.current()&&!controller.signal.aborted){rows.value=[];nextCursor.value=null;error.value=(e as Error).message;}}finally{if(request.current())loading.value=false;}}
async function loadStats(){const request=requests.begin('stats');statsError.value='';try{const {data}=await client.get('/audit-log/stats',{params:applied,signal:controller.signal,_silent:true});if(request.current())stats.value=data;}catch(e){if(request.current()&&!controller.signal.aborted){stats.value=undefined;statsError.value=(e as Error).message;}}}
function query(){requests.invalidate();applied=Object.fromEntries(Object.entries(filters).filter(([,v])=>v!==''&&v!==null));cursor.value=null;history.value=[];rows.value=[];stats.value=undefined;void Promise.allSettled([loadPage(),loadStats()]);}
function next(){if(!nextCursor.value)return;history.value.push(cursor.value);cursor.value=nextCursor.value;void loadPage();}
function previous(){if(!history.value.length)return;cursor.value=history.value.pop()??null;void loadPage();}
function clear(){requests.invalidate();controller.abort();rows.value=[];selected.value=null;stats.value=undefined;accounts.value=[];actions.value=[];}
onMounted(()=>{query();const request=requests.begin('metadata');void Promise.allSettled([
 Promise.all([accountsApi.getOptions(),loadCredentialNames()]).then(([{data}])=>{if(request.current())accounts.value=data.accounts.map(a=>({label:accountLabel(a),value:a.id}));}),
 client.get<string[]>('/audit-log/actions',{signal:controller.signal,_silent:true}).then(({data})=>{if(request.current())actions.value=data.map(action=>({label:actionLabel(action),value:action}));}),
]);window.addEventListener('auth-expired',clear);});
onUnmounted(()=>{clear();window.removeEventListener('auth-expired',clear);});
</script>
<style scoped>
.audit-page{width:100%;max-width:100%;grid-template-columns:minmax(0,1fr);box-sizing:border-box;flex:1 1 0%;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;align-content:start;grid-auto-rows:max-content;padding-bottom:20px}
.audit-page:focus-visible{outline:2px solid var(--primary-color,#18a058);outline-offset:-2px}
@media(max-width:768px){.audit-page{height:auto;flex:none;overflow:visible}}
.audit-page>*{min-width:0;max-width:100%;box-sizing:border-box}

.audit-page{display:grid;gap:18px;min-width:0}.audit-heading,.audit-pagination{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h2,p{margin:0}.audit-heading p,.detail-hint,.audit-pagination>span{font-size:12px;opacity:.65;margin-top:6px}.audit-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:end}.audit-filters label{display:grid;font-size:12px;gap:4px;min-width:0}.audit-filters input[type=date]{font:inherit;background:transparent;color:inherit;border:1px solid rgba(128,128,128,.3);border-radius:4px;padding:6px;min-width:0}.audit-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.audit-distribution{display:flex;gap:6px;flex-wrap:wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}@media(max-width:800px){.audit-filters{grid-template-columns:1fr 1fr}}@media(max-width:500px){.audit-filters{grid-template-columns:1fr}.audit-stats{gap:6px}}
</style>
