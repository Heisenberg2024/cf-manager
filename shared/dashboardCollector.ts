import type { LocalSql } from './auditQueries';
import { invalid } from './auditQueries';
import { aggregateResources, dashboardAccounts, RESOURCE_METRICS, saveResourceSnapshot, supports, type ResourceMetric, type ResourceSnapshot, type Attention } from './dashboardData';
import { bindingSignature, type DnsBinding, type ZoneDirectory } from './zoneDirectory';
import type { WorkerResources } from './workerResources';
import type { StorageResources } from './storageResources';
import type { TunnelResources } from './tunnelResources';
import type { D1Resources } from './d1Resources';
import type { CfRequest } from './accountDiscovery';
import { errorDetails } from './cfErrors';
export interface DashboardRuntime {
  db: LocalSql; accounts(): Promise<DnsBinding[]>; request(account:DnsBinding): Promise<CfRequest>;
  zones:Pick<ZoneDirectory,'peek'|'list'|'all'>; workers:Pick<WorkerResources,'peek'|'read'>; tunnels:Pick<TunnelResources,'list'> & {cache:Pick<StorageResources['cache'],'peek'>}; storage:Pick<StorageResources,'allBuckets'> & {cache:Pick<StorageResources['cache'],'peek'>}; d1:Pick<D1Resources,'databases'>;
}
export function snapshotContext(a:DnsBinding){return {accountId:a.id,cfId:a.account_id,credentialId:a.credential_id??null,apiToken:a.api_token??null,apiKey:a.api_key??null,email:a.email??null,authType:a.auth_type??null,updatedAt:a.updated_at??null,proxyEnabled:a.proxy_enabled??null,proxyUrl:a.proxy_url??null,features:a.enabled_features};}
export function snapshotBindingSql(context:(key:string)=>string){return `a.id IS ${context('accountId')} AND a.account_id IS ${context('cfId')} AND a.credential_id IS ${context('credentialId')} AND (CASE WHEN c.id IS NOT NULL THEN c.api_token ELSE a.api_token END) IS ${context('apiToken')} AND (CASE WHEN c.id IS NOT NULL THEN c.api_key ELSE a.api_key END) IS ${context('apiKey')} AND (CASE WHEN c.id IS NOT NULL THEN c.email ELSE a.email END) IS ${context('email')} AND COALESCE(c.auth_type,a.auth_type) IS ${context('authType')} AND a.updated_at IS ${context('updatedAt')} AND a.proxy_enabled IS ${context('proxyEnabled')} AND a.proxy_url IS ${context('proxyUrl')} AND a.is_enabled!=0 AND a.is_active!=0 AND a.enabled_features IS ${context('features')} AND COALESCE(c.status,'unknown') NOT IN ('invalid','expired','disabled')`;}
function bindingGuard(a:DnsBinding){return {sql:`EXISTS(SELECT 1 FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id WHERE ${snapshotBindingSql(()=>'?')})`,params:Object.values(snapshotContext(a))};}
/** Persist reused complete module snapshots atomically with planning, including on a different Pages isolate. */
export function snapshotStatements(snapshots:ResourceSnapshot[],accounts:DnsBinding[],stored:ResourceSnapshot[]){
 const rows=snapshots.filter(s=>s.value!==null&&s.last_success_at!==null&&!s.error_kind&&!stored.some(old=>old.account_id===s.account_id&&old.metric===s.metric&&old.identity===s.identity&&old.fetched_at>=s.fetched_at)).flatMap(s=>{const a=accounts.find(a=>a.id===s.account_id);return a?[{snapshot:s,context:snapshotContext(a)}]:[];});
 const statements:Array<{sql:string;params:unknown[]}>=[];
 for(let n=0;n<rows.length;n+=2000){statements.push({sql:`INSERT INTO resource_summaries(account_id,cf_account_id,metric,identity,value,breakdown,fetched_at,last_success_at,error_kind)
 SELECT json_extract(s.value,'$.snapshot.account_id'),json_extract(s.value,'$.snapshot.cf_account_id'),json_extract(s.value,'$.snapshot.metric'),json_extract(s.value,'$.snapshot.identity'),json_extract(s.value,'$.snapshot.value'),json_extract(s.value,'$.snapshot.breakdown'),json_extract(s.value,'$.snapshot.fetched_at'),json_extract(s.value,'$.snapshot.last_success_at'),NULL FROM json_each(?) s JOIN accounts a ON a.id=json_extract(s.value,'$.snapshot.account_id') LEFT JOIN credentials c ON c.id=a.credential_id WHERE ${snapshotBindingSql(k=>`json_extract(s.value,'$.context.${k}')`)}
 ON CONFLICT(account_id,metric) DO UPDATE SET cf_account_id=excluded.cf_account_id,identity=excluded.identity,value=excluded.value,breakdown=excluded.breakdown,fetched_at=excluded.fetched_at,last_success_at=excluded.last_success_at,error_kind=NULL WHERE resource_summaries.fetched_at<=excluded.fetched_at`,params:[JSON.stringify(rows.slice(n,n+2000))]});}
 return statements;
}
export async function recordInventoryList(db:LocalSql,a:DnsBinding,metric:ResourceMetric,rows:unknown[],startedAt:number){
 const row:ResourceSnapshot={account_id:a.id,cf_account_id:a.account_id!,metric,identity:await bindingSignature(a),...counts(metric,rows),fetched_at:startedAt,last_success_at:Date.now(),error_kind:null};
 await saveResourceSnapshot(db,row,bindingGuard(a));
}
function counts(metric:ResourceMetric,rows:unknown[]) {
  const seen=new Set<string>(), breakdown:Record<string,number>={};
  for(const item of rows){
    const row=item as Record<string,unknown>;
    const id = metric==='r2' ? row.name : metric==='d1' ? row.uuid : row.id ?? (metric==='pages'?row.name:undefined);
    if(typeof id!=='string'||!id)throw Object.assign(new Error('Missing resource identity'),{statusCode:502});
    if(seen.has(id))continue; seen.add(id);
    if(metric==='zones'){const state=row.paused ? 'paused' : typeof row.status==='string'?row.status:'unknown';breakdown[state]=(breakdown[state]??0)+1;}
    if(metric==='tunnels'){const state=row.status==='healthy'?'healthy':'abnormalOrUnknown';breakdown[state]=(breakdown[state]??0)+1;}
  }
  return {value:seen.size,breakdown:JSON.stringify(breakdown)};
}
export async function currentSnapshots(runtime:DashboardRuntime,accounts:DnsBinding[],storedRows?:ResourceSnapshot[]) {
  const stored=storedRows??await runtime.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries');
  const rows:ResourceSnapshot[]=[];
  for(const account of accounts){
    const identity=await bindingSignature(account);
    rows.push(...stored.filter(s=>s.account_id===account.id&&s.identity===identity&&s.cf_account_id===account.account_id));
    const add=(metric:ResourceMetric,value:unknown[]|null,fetchedAt:number,errorKind:string|null=null,failedAt?:number)=>{
      const index=rows.findIndex(s=>s.account_id===account.id&&s.metric===metric),prior=rows[index];
      if(!errorKind&&prior&&prior.last_success_at!==null&&prior.last_success_at>=fetchedAt)return;
      if(errorKind&&prior&&prior.fetched_at>(failedAt??fetchedAt))return;
      try{const summary=value?counts(metric,value):{value:prior?.value??null,breakdown:prior?.breakdown??'{}'};
        const next={account_id:account.id,cf_account_id:account.account_id!,metric,identity,...summary,fetched_at:failedAt??fetchedAt,last_success_at:value?fetchedAt:prior?.last_success_at??null,error_kind:errorKind};
        if(index>=0)rows[index]=next;else rows.push(next);
      }catch{/* incomplete cache is not counted */}
    };
    // Peeks never schedule requests or refresh stale entries.
    const zone=await runtime.zones.peek(account);if(zone)add('zones',zone.zones,zone.meta.fetchedAt!,zone.meta.error??null,(zone.meta as {failedAt?:number}).failedAt);
    for(const kind of ['workers','pages'] as const){const result=await runtime.workers.peek(account,kind);if(result)add(kind,result.value,result.fetchedAt,result.errorKind??null);}
    const tunnel=await runtime.tunnels.cache.peek<unknown[]>(account,'tunnel/list');if(tunnel)add('tunnels',tunnel.value,tunnel.fetchedAt,tunnel.error?'resource_read_failed':null,tunnel.failedAt);
    const d1=await runtime.storage.cache.peek<unknown[]>(account,'d1:list');
    if(d1&&Array.isArray(d1.value))add('d1',d1.value,d1.fetchedAt,d1.error?'resource_read_failed':null,d1.failedAt);
    // Only a complete cached bucket cursor chain can supply a count. A partial page never means zero.
    for(const limit of [1000,100]){
      const buckets:unknown[]=[],seen=new Set<string>();let cursor='',fetchedAt=Infinity,failedAt=0,errorKind:string|null=null;
      for(let page=0;page<35;page++){
        const cached=await runtime.storage.cache.peek<{items:unknown[];is_truncated:boolean;cursor?:string}>(account,`buckets:/`+JSON.stringify(['','/',cursor,limit]));
        if(!cached||!Array.isArray(cached.value.items))break;
        buckets.push(...cached.value.items);fetchedAt=Math.min(fetchedAt,cached.fetchedAt);if(cached.error){errorKind='resource_read_failed';failedAt=Math.max(failedAt,cached.failedAt??cached.fetchedAt);}
        if(!cached.value.is_truncated){add('r2',buckets,fetchedAt,errorKind,failedAt||undefined);break;}
        if(!cached.value.cursor||seen.has(cached.value.cursor))break;seen.add(cached.value.cursor);cursor=cached.value.cursor;
      }
    }

  }
  return rows;
}
export async function dashboardResources(runtime:DashboardRuntime,accountId?:number){
  const [metadata,bindings]=await Promise.all([dashboardAccounts(runtime.db),runtime.accounts()]);
  const accounts=bindings.filter(a=>!accountId||a.id===accountId), metas=metadata.filter(a=>!accountId||a.id===accountId);
  const snapshots=await currentSnapshots(runtime,accounts);
  const metrics=aggregateResources(metas,snapshots);
  const issues:Attention[]=snapshots.filter(s=>s.error_kind).map(s=>({id:`read-${s.account_id}-${s.metric}`,severity:'warning',kind:'resourceRead',source:s.metric,accountId:s.account_id,name:metas.find(a=>a.id===s.account_id)?.name??String(s.account_id),detectedAt:s.fetched_at,state:s.error_kind!, route:metricRoute(s.metric)}));
  for(const m of metrics)if(m.metric==='zones'&&m.breakdown.pending)issues.push({id:'pending-zones',severity:'warning',kind:'zonePending',source:'zones',accountId:accountId??0,name:String(m.breakdown.pending),detectedAt:m.lastSuccessAt!,state:'pending',route:'/dns'});
  for(const m of metrics)if(m.state==='stale')issues.push({id:`stale-${m.metric}`,severity:'info',kind:'staleSnapshot',source:m.metric,accountId:accountId??0,name:m.metric,detectedAt:m.lastSuccessAt!,state:'stale',route:metricRoute(m.metric)});
  return {metrics,issues,accounts:metas.map(a=>({accountId:a.id,metrics:aggregateResources([a],snapshots.filter(s=>s.account_id===a.id))})),fetchedAt:Date.now(),source:'snapshot'};
}
export function metricRoute(metric:string){return metric==='zones'?'/dns':['workers','pages'].includes(metric)?'/workers':metric==='tunnels'?'/tunnels':'/storage';}
const flights=new WeakMap<LocalSql,Map<string,Promise<unknown>>>();
export async function collectResource(runtime:DashboardRuntime,accountId:number,metric:ResourceMetric,refresh=false,options:{deadline?:number;maxRequests?:number;signal?:AbortSignal;canCommit?:()=>Promise<boolean>;expectedIdentity?:string;snapshotGuard?:{sql:string;params:unknown[]}}={}){
  if(!RESOURCE_METRICS.includes(metric))invalid('Invalid resource metric');
  const account=(await runtime.accounts()).find(a=>a.id===accountId),metadata=(await dashboardAccounts(runtime.db)).find(a=>a.id===accountId);
  if(!account||!metadata)throw Object.assign(new Error('Account not found'),{statusCode:404});
  if(!supports(metadata,metric))throw Object.assign(new Error('Account or product is disabled/unverified'),{statusCode:409});
  const identity=await bindingSignature(account),key=`${identity}:${metric}`;
  if(options.expectedIdentity&&identity!==options.expectedIdentity)throw Object.assign(new Error('Account changed before collection'),{statusCode:409});
  let map=flights.get(runtime.db);if(!map){map=new Map();flights.set(runtime.db,map);}const pending=map.get(key);if(pending)return pending;
  const task=(async()=>{
    const previous=(await runtime.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries WHERE account_id=? AND metric=?',[accountId,metric])).find(s=>s.identity===identity);
    if(!refresh&&previous?.last_success_at&&!previous.error_kind&&Date.now()-previous.last_success_at<300000)return previous;
    const started=Math.max(Date.now(),(previous?.fetched_at??0)+1);let row:ResourceSnapshot & {nextEligibleAt?:number};
    const deadline=Math.min(Date.now()+25000,options.deadline??Infinity),scope=new AbortController();
    const signal=options.signal?AbortSignal.any([scope.signal,options.signal]):scope.signal;
    const timeout=new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    const scopeTimer=setTimeout(()=>scope.abort(new DOMException('Collection deadline exceeded','TimeoutError')),Math.max(0,deadline-Date.now()));
    try{
      signal.throwIfAborted();const raw=await Promise.race([runtime.request(account),timeout]);let calls=0;
      const request:CfRequest=async(path,init)=>{
        if(++calls>(options.maxRequests??35))throw Object.assign(new Error('Dashboard collection subrequest budget exceeded'),{statusCode:429,kind:'budget'});
        const remaining=deadline-Date.now();if(remaining<=0)throw Object.assign(new Error('Collection deadline exceeded'),{name:'TimeoutError'});
        const controller=new AbortController(),cancel=()=>controller.abort(new DOMException('Collection deadline exceeded','TimeoutError'));if(init?.signal?.aborted||signal.aborted)cancel();init?.signal?.addEventListener('abort',cancel,{once:true});signal.addEventListener('abort',cancel,{once:true});
        const timer=setTimeout(cancel,Math.min(15000,remaining));try{return await raw(path,{...init,signal:controller.signal,retry:false});}finally{clearTimeout(timer);init?.signal?.removeEventListener('abort',cancel);signal.removeEventListener('abort',cancel);}
      };
      // Persist only awaited complete reads. Module SWR must not outlive a Worker collection invocation.
      let fetchedAt=Date.now();
      const read=async()=>{let result:unknown[];
      if(metric==='zones'){const snapshot=await runtime.zones.list(account,request,{refresh:true,background:true,signal});result=snapshot.zones;fetchedAt=snapshot.meta.fetchedAt!;if(snapshot.meta.state==='stale')throw Object.assign(new Error('Resource refresh is pending'),{kind:'stale'});}
      else if(metric==='workers'||metric==='pages'){result=await runtime.workers.read(account,request,metric,{refresh:true,background:true,signal});fetchedAt=(await runtime.workers.peek(account,metric))?.fetchedAt??started;}
      else if(metric==='tunnels'){const s=await runtime.tunnels.list(account,request,true,true,signal);result=s.value;fetchedAt=s.cache.fetchedAt;if(s.cache.state==='stale')throw Object.assign(new Error('Resource refresh is pending'),{kind:'stale'});}
      else if(metric==='r2')result=await runtime.storage.allBuckets(account,request,{refresh:true,background:true,signal});
      else if(metric==='d1'){result=await runtime.d1.databases(account,request,{refresh:true,background:true,signal});const cached=await runtime.storage.cache.peek<unknown[]>(account,'d1:list');fetchedAt=cached?.fetchedAt??started;}
      else result=await runtime.zones.all(account,request,`/accounts/${encodeURIComponent(account.account_id!)}/storage/kv/namespaces`,50,{background:true,signal});
      return result;};
      // Bound the await even when another foreground consumer owns a shared module flight.
      const result=await Promise.race([read(),timeout]);
      row={account_id:accountId,cf_account_id:account.account_id!,metric,identity,...counts(metric,result),fetched_at:started,last_success_at:fetchedAt,error_kind:null};
    }catch(error){row={account_id:accountId,cf_account_id:account.account_id!,metric,identity,value:previous?.value??null,breakdown:previous?.breakdown??'{}',fetched_at:started,last_success_at:previous?.last_success_at??null,error_kind:errorDetails(error).kind,nextEligibleAt:Date.now()+((error as {retryAfterMs?:number}).retryAfterMs??0)};}finally{clearTimeout(scopeTimer);}
    // Never install results under a changed/deleted binding, even if the read completed late.
    const current=(await runtime.accounts()).find(a=>a.id===accountId);
    const currentMeta=(await dashboardAccounts(runtime.db)).find(a=>a.id===accountId);
    if(!current||!currentMeta||!supports(currentMeta,metric)||await bindingSignature(current)!==identity||options.canCommit&&!await options.canCommit())throw Object.assign(new Error('Account changed during collection'),{statusCode:409});
    const identityGuard=bindingGuard(account);
    const guard=options.snapshotGuard?{sql:`${identityGuard.sql} AND (${options.snapshotGuard.sql})`,params:[...identityGuard.params,...options.snapshotGuard.params]}:identityGuard;
    await saveResourceSnapshot(runtime.db,row,guard);
    const saved=(await runtime.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries WHERE account_id=? AND metric=?',[accountId,metric]))[0];
    if(!saved||saved.identity!==identity||saved.fetched_at<started)throw Object.assign(new Error('Account changed during snapshot commit'),{statusCode:409});
    return row;
  })();map.set(key,task);try{return await task;}finally{if(map.get(key)===task)map.delete(key);}
}
