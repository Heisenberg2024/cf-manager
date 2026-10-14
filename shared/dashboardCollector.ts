import type { LocalSql } from './auditQueries';
import { invalid } from './auditQueries';
import { aggregateResources, dashboardAccounts, RESOURCE_METRICS, saveResourceSnapshot, supports, inResourceScope, isUnavailableSnapshot, type ResourceMetric, type ResourceSnapshot, type Attention } from './dashboardData';
import { bindingSignature, type DnsBinding, type ZoneDirectory } from './zoneDirectory';
import type { WorkerResources } from './workerResources';
import type { StorageResources } from './storageResources';
import type { TunnelResources } from './tunnelResources';
import type { D1Resources } from './d1Resources';
import type { CfRequest } from './accountDiscovery';
import { errorDetails, isR2Unavailable } from './cfErrors';
import { snapshotIdentity, type InventorySink, type UsageSink } from './snapshotIdentity';
import { snapshotPolicy } from './dashboardData';
export interface DashboardRuntime {
  intervalHours?:number; recordWorkersUsage?:boolean; db: LocalSql; accounts(): Promise<DnsBinding[]>; request(account:DnsBinding): Promise<CfRequest>;
  zones:Pick<ZoneDirectory,'peek'|'list'|'all'>; workers:Pick<WorkerResources,'peek'|'read'>; tunnels:Pick<TunnelResources,'list'> & {cache:Pick<StorageResources['cache'],'peek'>}; storage:Pick<StorageResources,'allBuckets'> & {cache:Pick<StorageResources['cache'],'peek'>}; d1:Pick<D1Resources,'databases'>;
}
export function snapshotContext(a:DnsBinding){return {accountId:a.id,cfId:a.account_id,credentialId:a.credential_id??null,apiToken:a.api_token??null,apiKey:a.api_key??null,email:a.email??null,authType:a.auth_type??null,epoch:a.snapshot_epoch??0,proxyEnabled:a.proxy_enabled??null,proxyUrl:a.proxy_url??null,features:a.enabled_features};}
export function snapshotBindingSql(context:(key:string)=>string){return `a.id IS ${context('accountId')} AND a.account_id IS ${context('cfId')} AND a.credential_id IS ${context('credentialId')} AND (CASE WHEN c.id IS NOT NULL THEN c.api_token ELSE a.api_token END) IS ${context('apiToken')} AND (CASE WHEN c.id IS NOT NULL THEN c.api_key ELSE a.api_key END) IS ${context('apiKey')} AND (CASE WHEN c.id IS NOT NULL THEN c.email ELSE a.email END) IS ${context('email')} AND COALESCE(c.auth_type,a.auth_type) IS ${context('authType')} AND a.snapshot_epoch IS ${context('epoch')} AND a.proxy_enabled IS ${context('proxyEnabled')} AND a.proxy_url IS ${context('proxyUrl')} AND a.is_enabled!=0 AND a.is_active!=0 AND a.enabled_features IS ${context('features')} AND COALESCE(c.status,'unknown') NOT IN ('invalid','expired','disabled')`;}
function bindingGuard(a:DnsBinding){return {sql:`EXISTS(SELECT 1 FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id WHERE ${snapshotBindingSql(()=>'?')})`,params:Object.values(snapshotContext(a))};}
/** Persist reused complete module snapshots atomically with planning, including on a different Pages isolate. */
export function snapshotStatements(snapshots:ResourceSnapshot[],accounts:DnsBinding[],stored:ResourceSnapshot[]){
 const rows=snapshots.filter(s=>s.value!==null&&s.last_success_at!==null&&!s.error_kind&&!s.invalidated_at&&!stored.some(old=>old.account_id===s.account_id&&old.metric===s.metric&&old.identity===s.identity&&old.fetched_at>=s.fetched_at)).flatMap(s=>{const a=accounts.find(a=>a.id===s.account_id);return a?[{snapshot:s,context:snapshotContext(a)}]:[];});
 const statements:Array<{sql:string;params:unknown[]}>=[];
 for(let n=0;n<rows.length;n+=2000){statements.push({sql:`INSERT INTO resource_summaries(account_id,cf_account_id,metric,identity,value,breakdown,fetched_at,last_success_at,error_kind)
 SELECT json_extract(s.value,'$.snapshot.account_id'),json_extract(s.value,'$.snapshot.cf_account_id'),json_extract(s.value,'$.snapshot.metric'),json_extract(s.value,'$.snapshot.identity'),json_extract(s.value,'$.snapshot.value'),json_extract(s.value,'$.snapshot.breakdown'),json_extract(s.value,'$.snapshot.fetched_at'),json_extract(s.value,'$.snapshot.last_success_at'),NULL FROM json_each(?) s JOIN accounts a ON a.id=json_extract(s.value,'$.snapshot.account_id') LEFT JOIN credentials c ON c.id=a.credential_id WHERE ${snapshotBindingSql(k=>`json_extract(s.value,'$.context.${k}')`)}
 ON CONFLICT(account_id,metric) DO UPDATE SET cf_account_id=excluded.cf_account_id,identity=excluded.identity,value=excluded.value,breakdown=excluded.breakdown,fetched_at=excluded.fetched_at,last_success_at=excluded.last_success_at,error_kind=NULL WHERE resource_summaries.invalidated_at IS NULL AND resource_summaries.fetched_at<=excluded.fetched_at`,params:[JSON.stringify(rows.slice(n,n+2000))]});}
 return statements;
}
export async function recordInventoryList(db:LocalSql,a:DnsBinding,metric:ResourceMetric,rows:unknown[],startedAt:number){
 const row:ResourceSnapshot={account_id:a.id,cf_account_id:a.account_id!,metric,identity:await snapshotIdentity(a),...counts(metric,rows),fetched_at:startedAt,last_success_at:Date.now(),error_kind:null};
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
    if(metric==='tunnels'){const state=row.status==='healthy'?'healthy':['degraded','down'].includes(String(row.status))?'abnormal':row.status==='inactive'?'inactive':'unknown';breakdown[state]=(breakdown[state]??0)+1;}
  }
  return {value:seen.size,breakdown:JSON.stringify(breakdown)};
}
/** GETs use persisted rows only. Legacy v1 is trusted only after its exact authentication signature matches. */
export async function currentSnapshots(runtime:DashboardRuntime,accounts:DnsBinding[],storedRows?:ResourceSnapshot[]) {
 const stored=storedRows??await runtime.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries');
 const withRows=accounts.filter(a=>stored.some(s=>s.account_id===a.id));
 const identities=new Map(await Promise.all(withRows.map(async a=>[a.id,{current:await snapshotIdentity(a),legacy:stored.some(s=>s.account_id===a.id&&!s.identity.startsWith('inventory:'))?await bindingSignature(a):undefined,epoch:a.snapshot_epoch??0,cf:a.account_id}] as const)));
 return stored.flatMap(s=>{
  const identity=identities.get(s.account_id);if(!identity||s.cf_account_id!==identity.cf)return [];
  if(s.identity===identity.current)return [s];
  if(s.identity===identity.legacy&&identity.epoch===0)return [{...s,identity:identity.current}];
  // Old metadata-dependent signatures cannot prove current ownership. Keep a labelled historical value until collected.
  if(!s.identity.startsWith('inventory:'))return [{...s,value:null,historical_value:s.value,error_kind:s.error_kind==='invalidated'?null:s.error_kind,invalidated_at:s.invalidated_at??s.fetched_at}];
  return [];
 });
}
/** Only complete remote reads notify this sink; cached hits and partial cursor pages never renew confirmation time. */
export function inventorySink(db:LocalSql):InventorySink {
 return async(a,metric,rows,startedAt,confirmedAt,error)=>{
  if(rows) {const row:ResourceSnapshot={account_id:a.id,cf_account_id:a.account_id!,metric,identity:await snapshotIdentity(a),...counts(metric,rows),fetched_at:startedAt,last_success_at:confirmedAt,error_kind:null};await saveResourceSnapshot(db,row,bindingGuard(a));}
  else {const kind=resourceFailureKind(metric,error);const identity=await snapshotIdentity(a);const row:ResourceSnapshot={account_id:a.id,cf_account_id:a.account_id!,metric,identity,value:null,breakdown:'{}',fetched_at:startedAt,last_success_at:null,error_kind:kind,last_failed_at:kind==='not_applicable'?null:confirmedAt};await saveResourceSnapshot(db,row,bindingGuard(a));}
 };
}
function resourceFailureKind(metric:ResourceMetric,error:unknown):string {
 const kind=errorDetails(error).kind;
 if(metric!=='r2')return kind;
 if(isR2Unavailable(error))return 'not_applicable';
 // Some auth failures use HTTP 403; retain them as actionable instead of scope exclusions.
 return kind==='permission'?'invalid':kind;
}
/** Successful module reads and quota sync share the persisted UTC history consumed by Dashboard. */
export function usageSink(db:LocalSql):UsageSink {
 return async(a,date,requests)=>{
  if(!Number.isFinite(requests)||requests<0)return;
  const guard=bindingGuard(a);
  await db.run(`INSERT INTO quota_usage(account_id,resource,date,count) SELECT ?,'workers_requests',?,? WHERE ${guard.sql}
    ON CONFLICT(account_id,resource,date) DO UPDATE SET count=MAX(quota_usage.count,excluded.count)`,[a.id,date,requests,...guard.params]);
 };
}
export async function dashboardResources(runtime:DashboardRuntime,accountId?:number){
  const [metadata,bindings]=await Promise.all([dashboardAccounts(runtime.db),runtime.accounts()]);
  const accounts=bindings.filter(a=>!accountId||a.id===accountId), metas=metadata.filter(a=>!accountId||a.id===accountId);
  const snapshots=await currentSnapshots(runtime,accounts);
  const metrics=aggregateResources(metas,snapshots,Date.now(),runtime.intervalHours);
  const accountMetrics=metas.map(a=>({accountId:a.id,metrics:aggregateResources([a],snapshots.filter(s=>s.account_id===a.id),Date.now(),runtime.intervalHours)}));
  const issues:Attention[]=snapshots.filter(s=>s.error_kind&&!['invalidated','legacy_unverified'].includes(s.error_kind)&&!isUnavailableSnapshot(s)&&metas.some(a=>a.id===s.account_id&&inResourceScope(a,s.metric))).map(s=>({id:`read-${s.account_id}-${s.metric}`,severity:'warning',kind:'resourceRead',source:s.metric,accountId:s.account_id,name:metas.find(a=>a.id===s.account_id)?.name??String(s.account_id),detectedAt:s.last_failed_at??s.fetched_at,state:s.error_kind!, route:metricRoute(s.metric)}));
  const owners=new Map<string,{account:typeof metas[number];metric:typeof metrics[number]}>();
  for(const summary of accountMetrics){const account=metas.find(a=>a.id===summary.accountId)!;for(const metric of summary.metrics){if(!account.account_id||!['zones','tunnels'].includes(metric.metric)||metric.value===null||metric.lastSuccessAt===null)continue;const key=`${account.account_id}:${metric.metric}`,old=owners.get(key);if(!old||metric.lastSuccessAt>old.metric.lastSuccessAt!||metric.lastSuccessAt===old.metric.lastSuccessAt&&(Number(!!metric.errorKind)<Number(!!old.metric.errorKind)||metric.errorKind===old.metric.errorKind&&((metric.fetchedAt??0)>(old.metric.fetchedAt??0)||metric.fetchedAt===old.metric.fetchedAt&&account.id<old.account.id)))owners.set(key,{account,metric});}}
  for(const [key,{account,metric:m}] of owners){const count=m.metric==='zones'?m.breakdown.pending:m.breakdown.abnormal;if(count)issues.push({id:`health-${key}`,severity:'warning',kind:m.metric==='zones'?'zonePending':'tunnelHealth',source:m.metric,accountId:account.id,name:`${account.name} · ${count}`,detectedAt:m.lastSuccessAt,state:m.metric==='zones'?'pending':'unhealthy',route:metricRoute(m.metric)});}
  return {metrics,issues,accounts:accountMetrics,fetchedAt:Date.now(),source:'snapshot'};
}
export function metricRoute(metric:string){return metric==='zones'?'/dns':['workers','pages'].includes(metric)?'/workers':metric==='tunnels'?'/tunnels':'/storage';}
const flights=new WeakMap<LocalSql,Map<string,Promise<unknown>>>();
export async function collectResource(runtime:DashboardRuntime,accountId:number,metric:ResourceMetric,refresh=false,options:{deadline?:number;maxRequests?:number;signal?:AbortSignal;canCommit?:()=>Promise<boolean>;expectedIdentity?:string;snapshotGuard?:{sql:string;params:unknown[]}}={}){
  if(!RESOURCE_METRICS.includes(metric))invalid('Invalid resource metric');
  const account=(await runtime.accounts()).find(a=>a.id===accountId),metadata=(await dashboardAccounts(runtime.db)).find(a=>a.id===accountId);
  if(!account||!metadata)throw Object.assign(new Error('Account not found'),{statusCode:404});
  if(!supports(metadata,metric))throw Object.assign(new Error('Account or product is disabled/unverified'),{statusCode:409});
  const identity=await snapshotIdentity(account),key=`${identity}:${metric}`;
  if(options.expectedIdentity&&identity!==options.expectedIdentity)throw Object.assign(new Error('Account changed before collection'),{statusCode:409});
  let map=flights.get(runtime.db);if(!map){map=new Map();flights.set(runtime.db,map);}const pending=map.get(key);if(pending)return pending;
  const task=(async()=>{
    const previous=(await currentSnapshots(runtime,[account],await runtime.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries WHERE account_id=? AND metric=?',[accountId,metric]))).find(s=>s.identity===identity);
    let calls=0;
    const syncUsage=async()=>{
      if(metric!=='workers'||!runtime.recordWorkersUsage)return;
      const date=new Date().toISOString().slice(0,10);
      if(!refresh&&(await runtime.db.all("SELECT account_id FROM quota_usage WHERE account_id=? AND resource='workers_requests' AND date=?",[accountId,date])).length)return;
      const remaining=Math.min(12000,(options.deadline??Infinity)-Date.now());if(remaining<=0||options.signal?.aborted)return;
      const timeoutSignal=AbortSignal.timeout(remaining),signal=options.signal?AbortSignal.any([options.signal,timeoutSignal]):timeoutSignal;
      try{const raw=await runtime.request(account);const request:CfRequest=async(path,init)=>{if(++calls>(options.maxRequests??35))throw Object.assign(new Error('Dashboard collection request budget exceeded'),{statusCode:429});return raw(path,{...init,retry:false});};await runtime.workers.read(account,request,'usage',{background:true,signal,refresh});}
      catch{/* Usage and inventory are separate observations. Failed analytics never manufactures a zero or erases inventory. */}
    };
    if(!refresh&&previous?.last_success_at&&!previous.error_kind&&!previous.invalidated_at&&Date.now()-previous.last_success_at<snapshotPolicy(runtime.intervalHours).refreshMs){await syncUsage();return previous;}
    const started=Math.max(Date.now(),(previous?.fetched_at??0)+1);let row:ResourceSnapshot & {nextEligibleAt?:number};
    const deadline=Math.min(Date.now()+25000,options.deadline??Infinity),scope=new AbortController();
    const signal=options.signal?AbortSignal.any([scope.signal,options.signal]):scope.signal;
    const timeout=new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    const scopeTimer=setTimeout(()=>scope.abort(new DOMException('Collection deadline exceeded','TimeoutError')),Math.max(0,deadline-Date.now()));
    try{
      signal.throwIfAborted();const raw=await Promise.race([runtime.request(account),timeout]);
      const request:CfRequest=async(path,init)=>{
        if(++calls>(options.maxRequests??35))throw Object.assign(new Error('Dashboard collection subrequest budget exceeded'),{statusCode:429,kind:'budget'});
        const remaining=deadline-Date.now();if(remaining<=0)throw Object.assign(new Error('Collection deadline exceeded'),{name:'TimeoutError'});
        const controller=new AbortController(),cancel=()=>controller.abort(new DOMException('Collection deadline exceeded','TimeoutError'));if(init?.signal?.aborted||signal.aborted)cancel();init?.signal?.addEventListener('abort',cancel,{once:true});signal.addEventListener('abort',cancel,{once:true});
        const timer=setTimeout(cancel,Math.min(15000,remaining));try{return await raw(path,{...init,signal:controller.signal,retry:false});}finally{clearTimeout(timer);init?.signal?.removeEventListener('abort',cancel);signal.removeEventListener('abort',cancel);}
      };
      // Persist only awaited complete reads. Module SWR must not outlive a Worker collection invocation.
      let fetchedAt=Date.now();
      const read=async()=>{let result:unknown[];
      if(metric==='zones'){const snapshot=await runtime.zones.list(account,request,{refresh:true,background:true,signal,inventory:false});result=snapshot.zones;fetchedAt=snapshot.meta.fetchedAt!;if(snapshot.meta.state==='stale')throw Object.assign(new Error('Resource refresh is pending'),{kind:'stale'});}
      else if(metric==='workers'||metric==='pages'){result=await runtime.workers.read(account,request,metric,{refresh:true,background:true,signal,inventory:false});fetchedAt=Date.now();}
      else if(metric==='tunnels'){const s=await runtime.tunnels.list(account,request,true,true,signal,false);result=s.value;fetchedAt=s.cache.fetchedAt;if(s.cache.state==='stale')throw Object.assign(new Error('Resource refresh is pending'),{kind:'stale'});}
      else if(metric==='r2')result=await runtime.storage.allBuckets(account,request,{refresh:true,background:true,signal,inventory:false});
      else if(metric==='d1'){result=await runtime.d1.databases(account,request,{refresh:true,background:true,signal,inventory:false});fetchedAt=Date.now();}
      else result=await runtime.zones.all(account,request,`/accounts/${encodeURIComponent(account.account_id!)}/storage/kv/namespaces`,50,{background:true,signal,inventory:false});
      return result;};
      // Bound the await even when another foreground consumer owns a shared module flight.
      const result=await Promise.race([read(),timeout]);
      if(metric==='kv'||metric==='r2')fetchedAt=Date.now();
      row={account_id:accountId,cf_account_id:account.account_id!,metric,identity,...counts(metric,result),fetched_at:started,last_success_at:fetchedAt,error_kind:null};
    }catch(error){const kind=resourceFailureKind(metric,error);row={account_id:accountId,cf_account_id:account.account_id!,metric,identity,value:previous?.value??null,breakdown:previous?.breakdown??'{}',fetched_at:started,last_success_at:previous?.last_success_at??null,error_kind:kind,last_failed_at:kind==='not_applicable'?null:Date.now(),nextEligibleAt:Date.now()+((error as {retryAfterMs?:number}).retryAfterMs??0)};}finally{clearTimeout(scopeTimer);}
    // Never install results under a changed/deleted binding, even if the read completed late.
    const current=(await runtime.accounts()).find(a=>a.id===accountId);
    const currentMeta=(await dashboardAccounts(runtime.db)).find(a=>a.id===accountId);
    if(!current||!currentMeta||!supports(currentMeta,metric)||await snapshotIdentity(current)!==identity||options.canCommit&&!await options.canCommit())throw Object.assign(new Error('Account changed during collection'),{statusCode:409});
    const identityGuard=bindingGuard(account);
    const guard=options.snapshotGuard?{sql:`${identityGuard.sql} AND (${options.snapshotGuard.sql})`,params:[...identityGuard.params,...options.snapshotGuard.params]}:identityGuard;
    await saveResourceSnapshot(runtime.db,row,guard);
    const saved=(await runtime.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries WHERE account_id=? AND metric=?',[accountId,metric]))[0];
    if(!saved||saved.identity!==identity||saved.fetched_at!==started||saved.invalidated_at)throw Object.assign(new Error('Account or resource changed during snapshot commit'),{statusCode:409});
    await syncUsage();
    return row;
  })();map.set(key,task);try{return await task;}finally{if(map.get(key)===task)map.delete(key);}
}
