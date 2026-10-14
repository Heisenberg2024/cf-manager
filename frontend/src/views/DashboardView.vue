<template>
  <div class="overview-page" tabindex="0" @keydown="pageScrollKey">
    <header class="overview-header">
      <div class="overview-heading">
        <h2>{{ t('overview.title') }}</h2>
        <p>{{ t('overview.subtitle') }}</p>
        <small>{{ t('overview.lastConfirmed') }} {{ time(recentSuccess) }}</small>
      </div>
      <div class="overview-filters">
        <n-select v-model:value="accountId" clearable filterable :options="accountOptions" :placeholder="t('overview.allAccounts')" :aria-label="t('overview.allAccounts')" />
        <n-button :loading="busy.overview" @click="reload()"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
        <n-dropdown trigger="click" :options="menuOptions" @select="snapshotDrawer=true;scanAction(()=>dashboardApi.scanStatus(controller.signal))">
          <n-button :aria-label="t('overview.more')"><template #icon><n-icon :component="EllipsisHorizontalOutline" /></template></n-button>
        </n-dropdown>
      </div>
    </header>
    <n-alert v-if="errors.overview" type="error" :title="t('overview.moduleError')">{{ errors.overview }}</n-alert>
    <div class="overview-cards">
      <button v-for="card in cards" :key="card.key" class="overview-card" :data-card="card.key" :title="metricDetail(card.keys)" @click="navigateCard(card)">
        <span class="card-heading">{{ card.title }}<n-icon :component="card.icon" /></span>
        <div v-if="card.key==='storage'" class="storage-values">
          <div v-for="key in ['kv','d1','r2']" :key="key"><strong :class="{'large-resource-count':metricValue(key).length>8}">{{ metricValue(key) }}</strong><span>{{ key.toUpperCase() }}</span></div>
        </div>
        <strong v-else class="card-value">{{ card.value }}</strong>
        <div class="card-support"><p v-for="line in card.lines" :key="line">{{ line }}</p><p v-if="resourceNote(card.keys)" class="resource-error">{{ resourceNote(card.keys) }} · {{ t('overview.syncFailed') }}</p><p v-else-if="card.keys.some(k=>metric(k)?.historicalValue!=null)" class="muted">{{ t('overview.historical') }} · {{ t('overview.pendingSync') }}</p></div>
      </button>
    </div>
    <n-alert v-if="errors.resources" type="warning" :title="t('overview.moduleError')">{{ errors.resources }}</n-alert>
    <div class="dashboard-two-column visualization-grid">
      <n-card size="small" class="dashboard-panel">
        <div class="panel-heading"><h3>{{ t('overview.usageTrends') }}</h3><n-radio-group v-model:value="days" size="small"><n-radio-button :value="7">7 {{ t('overview.days') }}</n-radio-button><n-radio-button :value="30">30 {{ t('overview.days') }}</n-radio-button></n-radio-group></div>
        <n-select v-model:value="usageKey" size="small" :options="usageOptions" class="metric-selector" :aria-label="t('overview.usageMetric')" />
        <n-alert v-if="errors.trends" type="warning">{{ errors.trends }}</n-alert>
        <n-skeleton v-else-if="busy.trends && !trends" height="200px" />
        <UsageTrend v-else :title="t(`overview.metrics.${usageKey}`)" :unit="usageKey==='browser_render_seconds'?t('overview.seconds'):usageKey==='ai_neurons'?'Neurons':t('overview.requests')" :points="usagePoints(usageKey)" :start-date="trends?.startDate" :end-date="trends?.endDate" />
        <p class="panel-note">UTC · {{ t('overview.usageDisclaimer') }}</p>
      </n-card>
      <n-card size="small" class="dashboard-panel">
        <div class="panel-heading"><h3>{{ t('overview.resourceDistribution') }}</h3><span class="distribution-total">{{ distributionTotal.value===null?'—':`${distributionTotal.partial?'≥ ':''}${distributionTotal.value.toLocaleString()}` }} <small>{{ t('overview.entities') }}</small></span></div>
        <div class="resource-distribution">
          <button v-for="(item,index) in distribution" :key="item.metric" class="distribution-row" :data-metric="item.metric" :title="metricDetail([item.metric])" @click="go(item.metric==='zones'?'/dns':['workers','pages'].includes(item.metric)?'/workers':item.metric==='tunnels'?'/tunnels':'/storage')">
            <span class="distribution-label"><i :style="{background:distributionColors[index]}" />{{ t(`overview.metrics.${item.metric}`) }}</span>
            <span class="distribution-bar"><i v-if="item.share!==null" :style="{width:`${item.share*100}%`,background:distributionColors[index]}" /></span>
            <strong>{{ item.value===null?'—':`${item.complete?'':'≥ '}${item.value.toLocaleString()}` }}</strong>
          </button>
          <n-empty v-if="!distribution.length" size="small" :description="t('overview.states.unknown')" />
        </div>
        <p class="panel-note">{{ t('overview.distributionHint') }}</p>
      </n-card>
    </div>
    <div class="dashboard-two-column">
      <n-card size="small" class="dashboard-panel">
        <section ref="attentionElement" class="attention-section">
          <div class="panel-heading"><h3>{{ t('overview.attention') }}</h3><span class="muted">{{ issues.length }}</span></div>
          <n-empty v-if="!issues.length" size="small" :description="t('overview.noKnownIssues')" />
          <div v-else class="attention-list">
            <button v-for="issue in issues.slice(0,8)" :key="issue.id" class="attention-item" @click="go(issue.route,issue.accountId)">
              <i class="status-dot" :class="issue.severity" /><div><b>{{ t(`overview.issueKinds.${issue.kind}`) }}</b><span>{{ issue.name }} · {{ te(`overview.metrics.${issue.source}`)?t(`overview.metrics.${issue.source}`):issue.state }}</span></div><small>{{ time(issue.detectedAt) }}</small><n-icon :component="ArrowForwardOutline" />
            </button>
          </div>
        </section>
      </n-card>
      <n-card size="small" class="dashboard-panel">
        <div class="panel-heading"><h3>{{ t('overview.recentActivity') }}</h3><n-button text type="primary" @click="go('/audit-logs')">{{ t('overview.allAudit') }}</n-button></div>
        <n-alert v-if="errors.activity" type="warning">{{ errors.activity }}</n-alert>
        <n-empty v-else-if="!activity.length" size="small" :description="t('overview.noHistory')" />
        <div v-else class="activity-list">
          <div v-for="event in activity.slice(0,8)" :key="event.id">
            <i class="status-dot" :class="event.status==='success'?'success':'critical'" /><div class="activity-content"><b>{{ actionLabel(event.action) }}</b><span>{{ event.account_name || '—' }}<template v-if="event.target"> · {{ event.target }}</template></span></div><div class="activity-meta"><span>{{ event.status==='success'?t('overview.success'):t('overview.failure') }}</span><small>{{ time(event.created_at) }}</small></div>
          </div>
        </div>
      </n-card>
    </div>
    <n-card size="small" class="dashboard-panel account-summary">
      <div class="panel-heading"><h3>{{ t('overview.accountSummary') }}</h3><n-input v-model:value="search" clearable :placeholder="t('overview.searchAccounts')" style="max-width:240px" /></div>
      <n-data-table :columns="accountColumns" :data="filteredAccounts" :pagination="{pageSize:10}" :row-key="(a:DashboardAccount)=>a.id" :scroll-x="760" size="small" />
    </n-card>
    <DashboardSnapshotDrawer v-model:show="snapshotDrawer" :scan="scan" :account-id="accountId" :busy="busy.scan" :error="errors.scan" @collect="collect" @pause="pauseCollection" @resume="resumeCollection" />
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
              {{ accountState(detailAccount) }}
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
              {{ m.value ?? '—' }} · {{ t(`overview.states.${m.state}`) }}<br>{{ t('overview.lastConfirmed') }} {{ time(m.lastSuccessAt) }}<span v-if="m.lastFailedAt"><br>{{ t('overview.lastFailed') }} {{ time(m.lastFailedAt) }}</span><span v-if="m.refreshState==='pending'"><br>{{ t('overview.pendingSync') }}</span><span v-if="m.longUnupdated"><br>{{ t('overview.longUnupdated') }}</span><span v-if="m.historicalValue!==null && m.historicalValue!==undefined"><br>{{ t('overview.historical') }} {{ m.historicalValue }}</span>
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
import {pageScrollKey} from '../utils/pageScrolling';
import { computed, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { dashboardApi, type Overview, type ResourceOverview, type Trends } from '../api/dashboard';
import { type DashboardAccount, type Attention } from '../shared/dashboardData';
import type { AuditEvent } from '../shared/auditQueries';
import { formatCN } from '../utils/dateFormat';
import { createRequestScope } from '../utils/requestScope';
import { createScanPoller } from '../utils/dashboardCollection';
import type {ScanStatus} from '../shared/dashboardScanTypes';
import UsageTrend from '../components/UsageTrend.vue';
import DashboardSnapshotDrawer from '../components/DashboardSnapshotDrawer.vue';
import {inventoryTotal,entityDistribution,attentionPriority} from '../utils/dashboardPresentation';
import {PeopleOutline,GlobeOutline,CodeSlashOutline,GitNetworkOutline,ServerOutline,AlertCircleOutline,RefreshOutline,EllipsisHorizontalOutline,ArrowForwardOutline} from '@vicons/ionicons5';
const {t,te}=useI18n(), router=useRouter();
const overview=ref<Overview>(),resources=ref<ResourceOverview>(),trends=ref<Trends>(),activity=ref<AuditEvent[]>([]);

const accountId=ref<number|null>(null),days=ref(7),usageKey=ref('workers_requests'),snapshotDrawer=ref(false),search=ref('');
const detailAccountId=ref<number|null>(null);
const detailAccount=computed(()=>overview.value?.accounts.find(a=>a.id===detailAccountId.value));
const detailMetrics=computed(()=>resources.value?.accounts.find(a=>a.accountId===detailAccountId.value)?.metrics??[]);
const busy=reactive<Record<string,boolean>>({}),errors=reactive<Record<string,string>>({});
const requests=createRequestScope(()=>String(accountId.value));let controller=new AbortController();
const scan=ref<ScanStatus>(),attentionElement=ref<HTMLElement>();
let lastScanProgress='';
const scanPoller=createScanPoller({read:async signal=>(await dashboardApi.scanStatus(signal)).data,update:async state=>{scan.value=state;const key=`${state.snapshotVersion}:${state.job?.jobId}:${state.job?.completed}`;if(key!==lastScanProgress){lastScanProgress=key;await Promise.allSettled([load('resources'),load('trends')]);}},error:e=>{errors.scan=(e as Error).message;},idleIntervalMs:30000});
const accountOptions=computed(()=>(allAccounts.value.length?allAccounts.value:overview.value?.accounts??[]).map(a=>({label:`${a.name}｜${a.credential_name??`#${a.credential_id}`}`,value:a.id})));
// Preserve filter choices when the overview response contains only the selected binding.
const allAccounts=ref<DashboardAccount[]>([]);
watch(()=>overview.value?.accounts,rows=>{if(rows&&accountId.value===null)allAccounts.value=rows;});
const issues=computed<Attention[]>(()=>[...(overview.value?.issues??[]),...(resources.value?.issues??[])].sort((a,b)=>attentionPriority(a)-attentionPriority(b)));
const usageKeys=['workers_requests','ai_neurons','browser_render_seconds'];
const time=(value:unknown)=>value?formatCN(value as string|number):'—';
const metric=(key:string)=>resources.value?.metrics.find(m=>m.metric===key);
const breakdownValue=(key:string,part:string)=>metric(key)?.value===null||!metric(key)?'—':metric(key)?.breakdown[part]??(key==='tunnels'&&part==='unknown'?metric(key)?.breakdown.abnormalOrUnknown??0:0);
const metricValue=(key:string)=>{const m=metric(key);return m?.value===null||!m?'—':`${m.complete?'':'≥ '}${m.value.toLocaleString()}`;};
const usagePoints=(key:string)=>(trends.value?.usage??[]).filter(p=>p.resource===key);

const actionLabel=(action:string)=>te(`dashboard.actions.${action}`)?t(`dashboard.actions.${action}`):action;
const recentSuccess=computed(()=>{const times=(resources.value?.accounts.flatMap(a=>a.metrics)??[]).map(m=>m.lastSuccessAt).filter((n):n is number=>n!==null);return times.length?Math.max(...times):null;});
const usageOptions=computed(()=>usageKeys.map(value=>({value,label:t(`overview.metrics.${value}`)})));
const menuOptions=computed(()=>[{key:'snapshot',label:t('overview.resourceCollection')}]);
const groupValue=(keys:string[])=>{const total=inventoryTotal(keys.map(metric));return total.value===null?(keys.some(k=>metric(k)?.historicalValue!=null)?`~ ${keys.reduce((sum,k)=>sum+(metric(k)?.historicalValue??0),0).toLocaleString()}`:'—'):`${total.partial?'≥ ':''}${total.value.toLocaleString()}`;};
const resourceNote=(keys:string[])=>keys.filter(k=>metric(k)?.errorKind).map(k=>t(`overview.metrics.${k}`)).join(' / ');
const cards=computed(()=>[
 {key:'accounts',title:t('overview.accounts'),icon:PeopleOutline,value:overview.value?.counts.bindings??'—',route:'/accounts',keys:[],lines:[`${t('overview.realAccounts')} ${overview.value?.counts.cloudflareAccounts??'—'}`,`${t('overview.verified')} ${overview.value?.counts.verified??'—'} · ${t('overview.disabledOrUnverified')} ${overview.value?overview.value.accounts.filter(a=>a.is_enabled===0||a.is_active===0||a.access_status!=='available'||a.has_credentials===0||['invalid','expired','disabled'].includes(a.credential_status??'')).length:'—'}`]},
 {key:'zones',title:'DNS Zones',icon:GlobeOutline,value:groupValue(['zones']),route:'/dns',keys:['zones'],lines:[`Active ${breakdownValue('zones','active')} · Pending ${breakdownValue('zones','pending')} · Paused ${breakdownValue('zones','paused')}`]},
 {key:'workersPages',title:'Workers / Pages',icon:CodeSlashOutline,value:groupValue(['workers','pages']),route:'/workers',keys:['workers','pages'],lines:[`Workers ${metricValue('workers')} · Pages ${metricValue('pages')}`]},
 {key:'tunnels',title:'Tunnels',icon:GitNetworkOutline,value:groupValue(['tunnels']),route:'/tunnels',keys:['tunnels'],lines:[`Healthy ${breakdownValue('tunnels','healthy')} · ${t('overview.abnormal')} ${breakdownValue('tunnels','abnormal')} · ${t('overview.states.unknown')} ${breakdownValue('tunnels','unknown')} · Inactive ${breakdownValue('tunnels','inactive')}`]},
 {key:'storage',title:'Storage',icon:ServerOutline,value:'',route:'/storage',keys:['kv','d1','r2'],lines:[t('overview.storageEntities')]},
 {key:'attention',title:t('overview.pendingIssues'),icon:AlertCircleOutline,value:overview.value&&resources.value?issues.value.length:'—',route:'',keys:[],lines:[t('overview.knownIssues')]},
]);
const distribution=computed(()=>entityDistribution(resources.value?.metrics??[]));
const distributionTotal=computed(()=>inventoryTotal(resources.value?.metrics??[]));
const distributionColors=['#5b88d5','#8e78cb','#ae87ce','#55a89b','#d7a15b','#7895a5','#b77a86'];
const metricDetail=(keys:string[])=>keys.map(k=>{const m=metric(k);return `${t(`overview.metrics.${k}`)}: ${metricValue(k)} · ${t('overview.coverage')} ${m?.coveredAccounts??0}/${m?.totalAccounts??'—'} · ${t('overview.lastConfirmed')} ${time(m?.lastSuccessAt)}${m?.longUnupdated?' · '+t('overview.longUnupdated'):''}${m?.refreshState==='pending'?' · '+t('overview.pendingSync'):''}${m?.historicalValue!==null&&m?.historicalValue!==undefined?' · '+t('overview.historical')+' '+m.historicalValue:''}${m?.errorKind?' · '+t('overview.syncFailed'):''}`;}).join('\n');
const navigateCard=(card:typeof cards.value[number])=>card.route?go(card.route):attentionElement.value?.scrollIntoView({behavior:'smooth',block:'start'});
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
async function scanAction(action:()=>ReturnType<typeof dashboardApi.scanStatus>){
  const request=requests.begin('scan');errors.scan='';busy.scan=true;
  try{const {data}=await action();if(request.current())await scanPoller.observe(data);}
  catch(e){if(request.current()&&!controller.signal.aborted)errors.scan=(e as Error).message;}
  finally{if(request.current())busy.scan=false;}
}
function pauseCollection(){return scanAction(()=>dashboardApi.scanPause(controller.signal));}
function resumeCollection(){return scanAction(()=>dashboardApi.scanResume(controller.signal));}
function collect(refresh:boolean,all=false){
  return scanAction(()=>dashboardApi.scanStart({reason:'manual',force:refresh,...(!all&&accountId.value?{accountId:accountId.value}:{})},controller.signal));
}
const filteredAccounts=computed(()=>(overview.value?.accounts??[]).filter(a=>`${a.name} ${a.account_id} ${a.credential_name}`.toLowerCase().includes(search.value.toLowerCase())));
const rowCount=(id:number,key:string)=>{const m=resources.value?.accounts.find(a=>a.accountId===id)?.metrics.find(m=>m.metric===key);return m?.value??'—';};
const accountState=(a:DashboardAccount)=>a.is_enabled===0?t('overview.disabled'):['invalid','expired','disabled'].includes(a.credential_status??'')?t('overview.credentialError'):a.has_credentials===0?t('overview.noCredential'):a.is_active===0||a.access_status==='unknown'?t('overview.unverified'):a.access_status==='available'?t('overview.accountAvailable'):t('overview.accountUnavailable');
const accountColumns=computed(()=>[
  {title:t('overview.accounts'),key:'name',width:190,sorter:(a:DashboardAccount,b:DashboardAccount)=>a.name.localeCompare(b.name),render:(a:DashboardAccount)=>h(NButton,{text:true,type:'primary',onClick:()=>{detailAccountId.value=a.id;}},()=>`${a.name}｜${a.credential_name??'#'+a.credential_id}`)},
  {title:t('overview.status'),key:'access_status',width:130,render:accountState},
  {title:'Workers / Pages',key:'workers',width:140,render:(a:DashboardAccount)=>`${rowCount(a.id,'workers')} / ${rowCount(a.id,'pages')}`},
  {title:'Zones',key:'zones',width:80,render:(a:DashboardAccount)=>rowCount(a.id,'zones')},
  {title:t('overview.lastCheck'),key:'last_checked_at',width:170,render:(a:DashboardAccount)=>a.access_status==='available'?time(a.last_checked_at):'—'},
]);
watch(accountId,()=>{detailAccountId.value=null;requests.invalidate();scanPoller.stop();overview.value=undefined;resources.value=undefined;trends.value=undefined;activity.value=[];reload();void scanAction(()=>dashboardApi.scanStatus(controller.signal));});
watch(days,()=>{trends.value=undefined;void load('trends');});
function clearSession(){snapshotDrawer.value=false;detailAccountId.value=null;requests.invalidate();controller.abort();controller=new AbortController();scanPoller.stop();scan.value=undefined;lastScanProgress='';overview.value=undefined;resources.value=undefined;trends.value=undefined;activity.value=[];allAccounts.value=[];}
onMounted(()=>{reload();void scanAction(()=>dashboardApi.scanStart({reason:'auto'},controller.signal));window.addEventListener('auth-expired',clearSession);window.addEventListener('session-cleared',clearSession);});
onUnmounted(()=>{clearSession();window.removeEventListener('auth-expired',clearSession);window.removeEventListener('session-cleared',clearSession);});
</script>
<style scoped>
.overview-page{width:100%;max-width:100%;box-sizing:border-box;flex:1 1 0%;height:100%;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;grid-auto-rows:max-content;gap:22px;padding-bottom:24px}
.overview-page:focus-visible{outline:2px solid var(--primary-color,#18a058);outline-offset:-2px}.overview-page>*{min-width:0;max-width:100%;box-sizing:border-box}
h2,h3,p{margin:0}h2{font-size:26px;font-weight:650;letter-spacing:-.4px}h3{font-size:16px;font-weight:600}.muted{font-size:12px;opacity:.6}
.overview-header{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap}.overview-heading>p{font-size:13px;opacity:.65;margin:4px 0 8px}.overview-heading>small{font-size:11px;opacity:.5}.overview-filters{display:flex;align-items:center;gap:10px;min-width:0}.overview-filters>.n-select{width:260px;max-width:100%}
.overview-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.overview-card{font:inherit;color:inherit;text-align:left;border:1px solid var(--border-color,rgba(128,128,128,.18));border-radius:12px;background:var(--glass-card-bg);padding:20px;display:flex;flex-direction:column;gap:14px;min-height:170px;min-width:0;cursor:pointer;box-sizing:border-box}.overview-card:hover{border-color:var(--primary-color,#18a058)}.overview-card:focus-visible{outline:2px solid var(--primary-color,#18a058);outline-offset:2px}.card-heading{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;gap:10px}.card-heading .n-icon{font-size:20px;opacity:.5}.card-value{font-size:34px;font-weight:650;letter-spacing:-.8px;line-height:1.2}.card-support{font-size:12px;line-height:1.8;opacity:.7;margin-top:auto}.card-support>p{overflow-wrap:anywhere}.resource-error{color:var(--error-color,#c75d57)}.storage-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.storage-values>div{display:flex;flex-direction:column;gap:3px;min-width:0}.storage-values strong{font-size:29px;line-height:1.4;font-weight:650;letter-spacing:-.5px}.storage-values strong.large-resource-count{font-size:18px;overflow-wrap:anywhere}.storage-values span{font-size:11px;opacity:.55}
.dashboard-two-column{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;min-width:0}.dashboard-panel{min-width:0;border-radius:12px}.panel-heading{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:18px}.panel-note{font-size:11px;line-height:1.6;opacity:.5;margin-top:16px}.metric-selector{max-width:240px;margin-bottom:16px}.distribution-total{font-size:18px;font-weight:600}.distribution-total small{font-size:11px;opacity:.5;font-weight:400}.resource-distribution{display:grid;gap:14px;padding:8px 0}.distribution-row{font:inherit;font-size:12px;color:inherit;border:0;background:transparent;padding:0;display:grid;grid-template-columns:minmax(80px,110px) minmax(30px,1fr) minmax(30px,58px);align-items:center;gap:14px;cursor:pointer;text-align:left;min-width:0}.distribution-label{display:flex;align-items:center;gap:8px}.distribution-label>i{width:7px;height:7px;border-radius:50%;flex:none}.distribution-bar{display:block;height:7px;background:rgba(128,128,128,.08);border-radius:5px;overflow:hidden}.distribution-bar>i{display:block;height:100%;border-radius:5px}.distribution-row>strong{text-align:right;font-weight:500}.distribution-row:hover{opacity:.7}
.attention-section{scroll-margin-top:16px}.attention-list,.activity-list{display:grid;gap:0}.attention-item{font:inherit;color:inherit;background:transparent;border:0;border-bottom:1px solid rgba(128,128,128,.12);padding:13px 0;display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;width:100%;min-width:0}.attention-item>div{min-width:0;flex:1}.attention-item b,.activity-content b{display:block;font-size:12px;font-weight:500}.attention-item span,.activity-content span{display:block;font-size:11px;opacity:.6;overflow-wrap:anywhere;margin-top:4px}.attention-item small{font-size:10px;opacity:.5;flex:none}.attention-item>.n-icon{opacity:.4;flex:none}.status-dot{display:block;width:6px;height:6px;border-radius:50%;background:#7e96a6;flex:none}.status-dot.critical{background:#c66c68}.status-dot.warning{background:#cf9a4e}.status-dot.success{background:#5da68d}.activity-list>div{display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(128,128,128,.12);padding:13px 0;min-width:0}.activity-content{min-width:0;flex:1}.activity-meta{text-align:right;font-size:11px;flex:none}.activity-meta small{display:block;font-size:10px;opacity:.5;margin-top:4px}.attention-item:last-child,.activity-list>div:last-child{border-bottom:0}
@media(max-width:1100px){.overview-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-filters>.n-select{width:230px}}
@media(max-width:768px){.overview-page{height:auto;flex:none;overflow:visible}.dashboard-two-column{grid-template-columns:minmax(0,1fr)}.overview-header{gap:16px}.overview-filters{width:100%}.overview-filters>.n-select{flex:1;width:0;min-width:0}}
@media(max-width:600px){.overview-cards{grid-template-columns:minmax(0,1fr)}.overview-card{padding:18px;min-height:158px}.overview-page{gap:18px}h2{font-size:23px}.attention-item{flex-wrap:wrap}.attention-item small{margin-left:16px;width:100%}.attention-item>.n-icon{display:none}.activity-meta{max-width:95px}.distribution-row{gap:10px;grid-template-columns:95px minmax(25px,1fr) 45px}}
</style>
