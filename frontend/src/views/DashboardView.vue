<template>
  <div class="overview-page">
    <header class="overview-header">
      <div>
        <h2>{{ t('overview.title') }}</h2><div class="muted">
          v{{ version || '—' }} · {{ t('overview.localHealth') }}: {{ overview ? t('overview.states.ready') : '—' }} · {{ t('overview.updated') }} {{ time(overview?.fetchedAt) }}
        </div>
      </div>
      <n-button
        :loading="busy.overview"
        @click="reload"
      >
        {{ t('common.refresh') }}
      </n-button>
    </header>
    <div class="overview-filters">
      <n-select
        v-model:value="accountId"
        clearable
        filterable
        :options="accountOptions"
        :placeholder="t('overview.allAccounts')"
      />
      <n-select
        v-model:value="product"
        :options="productOptions"
      />
      <n-radio-group
        v-model:value="days"
        size="small"
      >
        <n-radio-button :value="7">
          7 {{ t('overview.days') }}
        </n-radio-button><n-radio-button :value="30">
          30 {{ t('overview.days') }}
        </n-radio-button>
      </n-radio-group>
    </div>
    <n-alert
      v-if="errors.overview"
      type="error"
      :title="t('overview.moduleError')"
    >
      {{ errors.overview }}
    </n-alert>
    <div class="overview-cards">
      <button
        class="overview-card"
        @click="go('/accounts')"
      >
        <span>{{ t('overview.accounts') }}</span><strong>{{ overview?.counts.bindings ?? '—' }}</strong><p>{{ t('overview.realAccounts') }} {{ overview?.counts.cloudflareAccounts ?? '—' }}</p><small>{{ t('overview.verified') }} {{ overview?.counts.verified ?? '—' }} · {{ t('overview.enabled') }} {{ overview?.counts.enabled ?? '—' }} · {{ t('overview.disabled') }} {{ overview?.counts.disabled ?? '—' }} · {{ t('overview.unverified') }} {{ overview?.counts.unverified ?? '—' }}</small>
      </button>
      <button
        v-for="group in visibleGroups"
        :key="group.key"
        class="overview-card"
        @click="go(group.route)"
      >
        <span>{{ t(`overview.${group.key}`) }}</span>
        <div
          v-for="key in group.metrics"
          :key="key"
          class="metric-line"
        >
          <b>{{ t(`overview.metrics.${key}`) }}</b><strong>{{ metricValue(key) }}</strong><n-tag
            size="small"
            :type="metric(key)?.state === 'ready' ? 'success' : 'default'"
          >
            {{ t(`overview.states.${metric(key)?.state ?? (busy.resources?'loading':'unknown')}`) }}
          </n-tag>
        </div>
        <p
          v-for="key in group.metrics"
          :key="`coverage-${key}`"
          class="metric-coverage"
        >
          {{ t(`overview.metrics.${key}`) }} · {{ t('overview.coverage') }} {{ metric(key)?.coveredAccounts ?? 0 }}/{{ metric(key)?.totalAccounts ?? '—' }} · {{ time(metric(key)?.lastSuccessAt) }}<template v-if="key==='zones'">
            · Active {{ breakdownValue(key,'active') }} / Pending {{ breakdownValue(key,'pending') }} / Paused {{ breakdownValue(key,'paused') }}
          </template><template v-if="key==='tunnels'">
            · Healthy {{ breakdownValue(key,'healthy') }} / {{ t('overview.unknownOrAbnormal') }} {{ breakdownValue(key,'abnormalOrUnknown') }}
          </template>
        </p>
        <small>{{ t('overview.snapshotSource') }}</small>
      </button>
      <button
        class="overview-card"
        @click="attentionElement?.scrollIntoView({behavior:'smooth'})"
      >
        <span>{{ t('overview.attention') }}</span><strong>{{ overview && resources ? issues.length : '—' }}</strong><p>{{ t('overview.knownIssues') }}</p><small>{{ t('overview.unknownNotice') }}</small>
      </button>
    </div>
    <n-alert
      v-if="errors.resources"
      type="warning"
      :title="t('overview.moduleError')"
    >
      {{ errors.resources }}
    </n-alert>
    <n-card size="small">
      <div class="collection-toolbar">
        <div>
          <strong>{{ t('overview.resourceCollection') }}</strong><p class="muted">
            {{ t('overview.collectionHint') }}
          </p>
        </div><n-space>
          <n-button
            v-if="!collecting"
            size="small"
            :disabled="!overview"
            @click="collect(false)"
          >
            {{ t('overview.collectMissing') }}
          </n-button><n-button
            v-if="!collecting"
            size="small"
            :disabled="!overview"
            @click="collect(true)"
          >
            {{ t('overview.forceCollect') }}
          </n-button><n-button
            v-else
            size="small"
            @click="pauseCollection"
          >
            {{ t('overview.pause') }}
          </n-button><span v-if="progress.total">{{ progress.done }}/{{ progress.total }} · {{ progress.label }}</span>
        </n-space>
      </div>
    </n-card>
    <section>
      <div class="section-heading">
        <h3>{{ t('overview.usageTrends') }}</h3><span class="muted">UTC · {{ t('overview.usageDisclaimer') }}</span>
      </div>
      <n-alert
        v-if="errors.trends"
        type="warning"
      >
        {{ errors.trends }}
      </n-alert>
      <div
        v-else
        class="trend-grid"
      >
        <n-card
          v-for="key in usageKeys"
          :key="key"
          size="small"
        >
          <n-skeleton
            v-if="busy.trends && !trends"
            height="145px"
          /><UsageTrend
            v-else
            :title="t(`overview.metrics.${key}`)"
            :unit="key==='browser_render_seconds' ? t('overview.seconds') : key==='ai_neurons' ? 'Neurons' : t('overview.requests')"
            :points="usagePoints(key)"
          />
        </n-card>
      </div>
    </section>
    <section class="audit-trends">
      <n-card
        size="small"
        :title="t('overview.auditTrends')"
      >
        <p class="muted">
          {{ t('overview.auditDisclaimer') }} · UTC
        </p><div class="trend-grid two">
          <UsageTrend
            :title="t('overview.success')"
            :unit="t('overview.operations')"
            :points="auditPoints('success')"
          /><UsageTrend
            :title="t('overview.failure')"
            :unit="t('overview.operations')"
            :points="auditPoints('error')"
          />
        </div><div class="action-distribution">
          <n-tag
            v-for="item in trends?.audit.actions.slice(0,10)"
            :key="item.action"
            size="small"
          >
            {{ actionLabel(item.action) }} {{ item.count }}
          </n-tag>
        </div>
      </n-card>
    </section>
    <section ref="attentionElement">
      <div class="section-heading">
        <h3>{{ t('overview.attention') }}</h3><span class="muted">{{ t('overview.knownIssues') }}</span>
      </div><n-empty
        v-if="!issues.length"
        :description="t('overview.noKnownIssues')"
      /><div
        v-else
        class="attention-list"
      >
        <button
          v-for="issue in issues.slice(0,8)"
          :key="issue.id"
          class="attention-item"
          @click="go(issue.route,issue.accountId)"
        >
          <n-tag
            size="small"
            :type="issue.severity==='critical'?'error':issue.severity==='warning'?'warning':'info'"
          >
            {{ t(`overview.severity.${issue.severity}`) }}
          </n-tag><b>{{ t(`overview.issueKinds.${issue.kind}`) }}</b><span>{{ issue.name }} · {{ issue.source }} · {{ issue.state }}</span><small>{{ time(issue.detectedAt) }}</small>
        </button>
      </div><p class="muted">
        {{ t('overview.remoteHealthNotice') }}
      </p>
    </section>
    <section>
      <div class="section-heading">
        <h3>{{ t('overview.accountSummary') }}</h3><n-input
          v-model:value="search"
          clearable
          :placeholder="t('overview.searchAccounts')"
          style="max-width:260px"
        />
      </div><n-data-table
        :columns="accountColumns"
        :data="filteredAccounts"
        :pagination="{pageSize:10}"
        :row-key="(a:DashboardAccount)=>a.id"
        :scroll-x="1060"
        size="small"
      />
    </section>
    <section>
      <div class="section-heading">
        <h3>{{ t('overview.recentActivity') }}</h3><n-button
          text
          type="primary"
          @click="go('/audit-logs')"
        >
          {{ t('overview.allAudit') }}
        </n-button>
      </div><n-alert
        v-if="errors.activity"
        type="warning"
      >
        {{ errors.activity }}
      </n-alert><n-empty
        v-else-if="!activity.length"
        :description="t('overview.noHistory')"
      /><div
        v-else
        class="activity-list"
      >
        <div
          v-for="event in activity"
          :key="event.id"
        >
          <small>{{ time(event.created_at) }}</small><span>{{ event.account_name || '—' }}</span><b>{{ actionLabel(event.action) }}</b><span class="activity-target">{{ event.target || '—' }}</span><n-tag
            size="small"
            :type="event.status==='success'?'success':'error'"
          >
            {{ event.status==='success'?t('overview.success'):t('overview.failure') }}
          </n-tag>
        </div>
      </div>
    </section>
    <n-drawer
      :show="!!detailAccount"
      :width="560"
      style="max-width:100vw"
      @update:show="(show:boolean)=>{if(!show)detailAccountId=null;}"
    >
      <n-drawer-content
        :title="t('overview.accountDetails')"
        closable
        body-content-style="overflow-wrap:anywhere"
      >
        <template v-if="detailAccount">
          <n-descriptions
            :column="1"
            bordered
          >
            <n-descriptions-item :label="t('overview.accounts')">
              {{ detailAccount.name }} (#{{ detailAccount.id }})
            </n-descriptions-item>
            <n-descriptions-item label="CF Account ID">
              {{ detailAccount.account_id || t('overview.states.unknown') }}
            </n-descriptions-item>
            <n-descriptions-item :label="t('overview.credential')">
              {{ detailAccount.credential_name || '—' }} (#{{ detailAccount.credential_id || '—' }})
            </n-descriptions-item>
            <n-descriptions-item :label="t('overview.status')">
              {{ detailAccount.access_status }} · {{ detailAccount.is_enabled===0?t('overview.disabled'):detailAccount.is_active===0?t('overview.unverified'):t('overview.enabled') }}
            </n-descriptions-item>
            <n-descriptions-item :label="t('overview.features')">
              {{ detailAccount.enabled_features }}
            </n-descriptions-item>
            <n-descriptions-item :label="t('overview.lastCheck')">
              {{ detailAccount.access_status==='available'?time(detailAccount.last_checked_at):'—' }}
            </n-descriptions-item>
            <n-descriptions-item
              v-for="m in detailMetrics"
              :key="m.metric"
              :label="t(`overview.metrics.${m.metric}`)"
            >
              {{ m.value ?? '—' }} · {{ t(`overview.states.${m.state}`) }} · {{ time(m.lastSuccessAt) }}
            </n-descriptions-item>
          </n-descriptions>
          <p
            class="muted"
            style="margin-top:12px"
          >
            {{ t('overview.snapshotSource') }} · {{ t('overview.remoteHealthNotice') }}
          </p>
          <n-button
            style="margin-top:12px"
            type="primary"
            @click="go('/accounts',detailAccount.id)"
          >
            {{ t('overview.manageAccount') }}
          </n-button>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>
<script setup lang="ts">
import { inject, type Ref, computed, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { dashboardApi, type Overview, type ResourceOverview, type Trends } from '../api/dashboard';
import { RESOURCE_METRICS, supports, type ResourceMetric, type DashboardAccount, type Attention } from '../shared/dashboardData';
import type { AuditEvent } from '../shared/auditQueries';
import { formatCN } from '../utils/dateFormat';
import { createRequestScope } from '../utils/requestScope';
import { confirmedResourceKeys, collectionKey } from '../utils/dashboardCollection';
import UsageTrend from '../components/UsageTrend.vue';
const {t,te}=useI18n(), router=useRouter();
const overview=ref<Overview>(),resources=ref<ResourceOverview>(),trends=ref<Trends>(),activity=ref<AuditEvent[]>([]);
const version=inject<Ref<string>>('appVersion',ref(''));
const accountId=ref<number|null>(null),product=ref('all'),days=ref(7),search=ref('');
const detailAccountId=ref<number|null>(null);
const detailAccount=computed(()=>overview.value?.accounts.find(a=>a.id===detailAccountId.value));
const detailMetrics=computed(()=>resources.value?.accounts.find(a=>a.accountId===detailAccountId.value)?.metrics??[]);
const busy=reactive<Record<string,boolean>>({}),errors=reactive<Record<string,string>>({});
const requests=createRequestScope(()=>String(accountId.value));let controller=new AbortController(),collectionEpoch=0;
const collecting=ref(false),progress=reactive({done:0,total:0,label:''}),attentionElement=ref<HTMLElement>();
const groups=[{key:'zones',route:'/dns',metrics:['zones']},{key:'workersPages',route:'/workers',metrics:['workers','pages']},{key:'tunnels',route:'/tunnels',metrics:['tunnels']},{key:'storage',route:'/storage',metrics:['kv','d1','r2']}];
const visibleGroups=computed(()=>groups.filter(g=>product.value==='all'||g.key===product.value));
const productOptions=computed(()=>[{label:t('overview.allProducts'),value:'all'},...groups.map(g=>({label:t(`overview.${g.key}`),value:g.key}))]);
const accountOptions=computed(()=>(allAccounts.value.length?allAccounts.value:overview.value?.accounts??[]).map(a=>({label:`${a.name}｜${a.credential_name??`#${a.credential_id}`}`,value:a.id})));
// Preserve filter choices when the overview response contains only the selected binding.
const allAccounts=ref<DashboardAccount[]>([]);
watch(()=>overview.value?.accounts,rows=>{if(rows&&accountId.value===null)allAccounts.value=rows;});
const issues=computed<Attention[]>(()=>[...(overview.value?.issues??[]),...(resources.value?.issues??[])].sort((a,b)=>({critical:0,warning:1,info:2}[a.severity]-{critical:0,warning:1,info:2}[b.severity])));
const usageKeys=['workers_requests','ai_neurons','browser_render_seconds'];
const time=(value:unknown)=>value?formatCN(value as string|number):'—';
const metric=(key:string)=>resources.value?.metrics.find(m=>m.metric===key);
const breakdownValue=(key:string,part:string)=>metric(key)?.value===null||!metric(key)?'—':metric(key)?.breakdown[part]??0;
const metricValue=(key:string)=>{const m=metric(key);return m?.value===null||!m?'—':`${m.complete?'':t('overview.atLeast')}${m.value.toLocaleString()}`;};
const usagePoints=(key:string)=>(trends.value?.usage??[]).filter(p=>p.resource===key);
const auditPoints=(key:'success'|'error')=>(trends.value?.audit.daily??[]).map(p=>({date:p.date,count:p[key]}));
const actionLabel=(action:string)=>te(`dashboard.actions.${action}`)?t(`dashboard.actions.${action}`):action;
function go(path:string,id?:number){router.push({path,query:(id||accountId.value)?{accountId:id||accountId.value!}:{}});}
async function load(module:'overview'|'resources'|'trends'|'activity'){
  const request=requests.begin(module,()=>`${accountId.value}:${module==='trends'?days.value:''}`);busy[module]=true;errors[module]='';
  try{const params={...(accountId.value?{accountId:accountId.value}:{}),days:days.value};
    if(module==='overview'){const {data}=await dashboardApi.overview(params,controller.signal);if(request.current())overview.value=data;}
    if(module==='resources'){const {data}=await dashboardApi.resources(params,controller.signal);if(request.current())resources.value=data;}
    if(module==='trends'){const {data}=await dashboardApi.trends(params,controller.signal);if(request.current())trends.value=data;}
    if(module==='activity'){const {data}=await dashboardApi.activity(params,controller.signal);if(request.current())activity.value=data.items;}
  }catch(e){if(request.current()&&!controller.signal.aborted)errors[module]=(e as Error).message;}finally{if(request.current())busy[module]=false;}
}
function reload(){void Promise.allSettled(['overview','resources','trends','activity'].map(m=>load(m as 'overview')));}
function pauseCollection(){collectionEpoch++;collecting.value=false;}
async function collect(refresh:boolean){
  const epoch=++collectionEpoch;collecting.value=true;
  const keys=visibleGroups.value.flatMap(g=>g.metrics) as ResourceMetric[];
  const jobs=(overview.value?.accounts??[]).flatMap(a=>RESOURCE_METRICS.filter(m=>keys.includes(m)&&supports(a,m)).map(metric=>({account:a,metric})));
  progress.done=0;progress.total=jobs.length;
  const confirmed=refresh?new Set<string>():confirmedResourceKeys(overview.value?.accounts??[],resources.value?.accounts??[]);
  try{for(const job of jobs){if(epoch!==collectionEpoch)break;const key=collectionKey(job.account,job.metric);if(confirmed.has(key)){progress.done++;continue;}progress.label=`${job.account.name} · ${t(`overview.metrics.${job.metric}`)}`;try{const {data}=await dashboardApi.collect(job.account.id,job.metric,refresh,controller.signal);if(!data.error_kind&&data.value!==null)confirmed.add(key);}catch{/* independent failures remain visible in local summaries */}if(epoch!==collectionEpoch)break;progress.done++;await load('resources');}}
  finally{if(epoch===collectionEpoch){collecting.value=false;progress.label=t('overview.collectionDone');}}
}
const filteredAccounts=computed(()=>(overview.value?.accounts??[]).filter(a=>`${a.name} ${a.account_id} ${a.credential_name}`.toLowerCase().includes(search.value.toLowerCase())));
const rowCount=(id:number,key:string)=>{const m=resources.value?.accounts.find(a=>a.accountId===id)?.metrics.find(m=>m.metric===key);return m?.value??'—';};
const accountColumns=computed(()=>[
  {title:t('overview.accounts'),key:'name',width:190,sorter:(a:DashboardAccount,b:DashboardAccount)=>a.name.localeCompare(b.name),render:(a:DashboardAccount)=>h(NButton,{text:true,type:'primary',onClick:()=>{detailAccountId.value=a.id;}},()=>`${a.name}｜${a.credential_name??'#'+a.credential_id}`)},
  {title:'CF Account',key:'account_id',width:150,render:(a:DashboardAccount)=>a.account_id?`${a.account_id.slice(0,6)}…${a.account_id.slice(-4)}`:'—'},
  {title:t('overview.status'),key:'access_status',width:130,render:(a:DashboardAccount)=>a.is_enabled===0?t('overview.disabled'):a.access_status==='available'?t('overview.states.ready'):a.access_status},
  {title:'Workers / Pages',key:'workers',width:140,render:(a:DashboardAccount)=>`${rowCount(a.id,'workers')} / ${rowCount(a.id,'pages')}`},
  {title:'Zones',key:'zones',width:80,render:(a:DashboardAccount)=>rowCount(a.id,'zones')},
  {title:t('overview.todayRecorded'),key:'usage',width:220,render:(a:DashboardAccount)=>(overview.value?.quota??[]).filter(q=>q.account_id===a.id).map(q=>`${t(`overview.metrics.${q.resource}`)}: ${q.count.toLocaleString()}`).join(' · ')||'—'},
  {title:t('overview.lastCheck'),key:'last_checked_at',width:170,render:(a:DashboardAccount)=>a.access_status==='available'?time(a.last_checked_at):'—'},
]);
watch(accountId,()=>{detailAccountId.value=null;requests.invalidate();pauseCollection();progress.done=0;progress.total=0;progress.label='';overview.value=undefined;resources.value=undefined;trends.value=undefined;activity.value=[];reload();});
watch(days,()=>{trends.value=undefined;void load('trends');});
function clearSession(){detailAccountId.value=null;requests.invalidate();controller.abort();controller=new AbortController();pauseCollection();overview.value=undefined;resources.value=undefined;trends.value=undefined;activity.value=[];allAccounts.value=[];}
onMounted(()=>{reload();window.addEventListener('auth-expired',clearSession);});
onUnmounted(()=>{clearSession();window.removeEventListener('auth-expired',clearSession);});
</script>
<style scoped>
.overview-page{width:100%;max-width:100%;grid-template-columns:minmax(0,1fr);box-sizing:border-box}
.overview-page>*{min-width:0;max-width:100%;box-sizing:border-box}

.overview-page{display:grid;gap:22px;min-width:0;padding-bottom:20px}.overview-header,.section-heading,.collection-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h2,h3,p{margin:0}h2{font-size:24px}h3{font-size:17px}.muted,.metric-coverage{font-size:12px;opacity:.65}.overview-filters{display:grid;grid-template-columns:minmax(180px,320px) minmax(150px,220px) auto;gap:12px;align-items:center}.overview-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.overview-card{font:inherit;color:inherit;text-align:left;border:1px solid var(--border-color,rgba(128,128,128,.2));border-radius:10px;background:var(--glass-card-bg);padding:18px;display:flex;flex-direction:column;gap:10px;cursor:pointer;min-width:0}.overview-card:hover{border-color:var(--primary-color,#18a058)}.overview-card>strong{font-size:30px;font-weight:650}.overview-card>span{font-weight:600}.overview-card small,.metric-coverage{font-size:11px;opacity:.65;overflow-wrap:anywhere}.metric-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.metric-line b{font-size:12px;opacity:.7}.metric-line strong{font-size:22px;margin-left:auto}.trend-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.trend-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.section-heading{margin-bottom:12px}.action-distribution{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.attention-list{display:grid;gap:8px}.attention-item{font:inherit;color:inherit;background:transparent;border:1px solid rgba(128,128,128,.18);border-radius:8px;display:flex;gap:10px;align-items:center;text-align:left;padding:12px;cursor:pointer;flex-wrap:wrap}.attention-item span{overflow-wrap:anywhere}.attention-item small{margin-left:auto;opacity:.6}.activity-list{display:grid;gap:1px}.activity-list>div{display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(128,128,128,.15);padding:12px 0;flex-wrap:wrap}.activity-target{min-width:0;flex:1;overflow-wrap:anywhere}.activity-list small{opacity:.65}.collection-toolbar p{margin-top:4px}@media(max-width:1100px){.overview-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.trend-grid{grid-template-columns:1fr}.overview-filters{grid-template-columns:1fr 1fr}.overview-filters>*:last-child{grid-column:1/-1}}@media(max-width:600px){.overview-cards,.trend-grid.two,.overview-filters{grid-template-columns:1fr}.overview-header h2{font-size:21px}.overview-card{padding:15px}.overview-page{gap:18px}}
</style>
