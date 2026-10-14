import {invalid, type LocalSql} from './auditQueries';
import {dashboardAccounts,RESOURCE_METRICS,supports,type ResourceMetric,type ResourceSnapshot} from './dashboardData';
import {collectResource,currentSnapshots,snapshotStatements,snapshotContext,snapshotBindingSql,type DashboardRuntime} from './dashboardCollector';
import {bindingSignature} from './zoneDirectory';
import {errorDetails,redact} from './cfErrors';
import {nextScanTime,type ScanConfig,type ScanJob,type ScanStatus} from './dashboardScanTypes';

type Statement={sql:string;params?:unknown[]};
type JobRow={id:string;state:ScanJob['state'];trigger_reason:string;full_scan:number;created_at:number;started_at:number|null;finished_at:number|null;last_error_kind:string|null};
type Item={job_id:string;cf_account_id:string;metric:ResourceMetric;account_id:number|null;identity:string;state:string;force:number;attempts:number;attempted_bindings:string;lease_token:string|null;lease_until:number|null;next_eligible_at:number;revision:number;error_kind:string|null};
type Dirty={account_id:number;metric:string;revision:number};
export interface ScanStart {reason?:'auto'|'manual'|'startup'|'periodic'|'incremental';accountId?:number;metrics?:ResourceMetric[];force?:boolean}
export interface ScanBudget {maxItems?:number;maxRequests?:number;durationMs?:number;signal?:AbortSignal}
const ACTIVE="active_key='global'";
/** DB transactions serialize planning; a persisted lease serializes executors across processes/isolates.
 * Resource reads run inside the existing low priority schedulers, never inside another ReadScheduler slot. */
export class DashboardScan {
  constructor(readonly runtime:DashboardRuntime,readonly config:ScanConfig,readonly execution:ScanStatus['execution']='background',private now=()=>Date.now()){}
  private get db():LocalSql{return this.runtime.db;}
  private async batch(statements:Statement[]){if(!this.db.batch)throw Error('Dashboard scan requires atomic SQL batch');await this.db.batch(statements);}
  private async active(){return (await this.db.all<JobRow>(`SELECT * FROM dashboard_scan_jobs WHERE ${ACTIVE}`))[0];}
  private async view(row:JobRow):Promise<ScanJob>{
    const sums=await this.db.all<{metric:string;total:number;succeeded:number;failed:number;skipped:number;next_at:number|null}>(`SELECT metric,COUNT(*) AS total,SUM(state='completed') AS succeeded,SUM(state='failed') AS failed,SUM(state='skipped') AS skipped,MIN(CASE WHEN state='queued' THEN next_eligible_at END) AS next_at FROM dashboard_scan_items WHERE job_id=? GROUP BY metric`,[row.id]);
    const running=await this.db.all<{accountId:number|null;accountName:string;metric:string}>(`SELECT i.account_id AS accountId,COALESCE(a.name,'—') AS accountName,i.metric FROM dashboard_scan_items i LEFT JOIN accounts a ON a.id=i.account_id WHERE i.job_id=? AND i.state='running'`,[row.id]);
    const sum=(key:'total'|'succeeded'|'failed'|'skipped')=>sums.reduce((n,r)=>n+r[key],0);
    const eligible=sums.map(r=>r.next_at).filter((n):n is number=>n!==null);
    return {jobId:row.id,state:row.state,triggerReason:row.trigger_reason,fullScan:!!row.full_scan,createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at,total:sum('total'),completed:sum('succeeded')+sum('failed')+sum('skipped'),succeeded:sum('succeeded'),failed:sum('failed'),skipped:sum('skipped'),currentResource:running.map(r=>({...r,accountName:redact(r.accountName)})),lastErrorKind:row.last_error_kind,nextEligibleAt:eligible.length?Math.max(this.now(),Math.min(...eligible)):null,resources:sums.map(({next_at:_,...r})=>r)};
  }
  async status():Promise<ScanStatus>{
    const row=await this.active()??(await this.db.all<JobRow>('SELECT * FROM dashboard_scan_jobs ORDER BY created_at DESC,id DESC LIMIT 1'))[0];
    const last=(await this.db.all<JobRow>('SELECT * FROM dashboard_scan_jobs WHERE full_scan=1 AND finished_at IS NOT NULL ORDER BY finished_at DESC,id DESC LIMIT 1'))[0];
    const control=(await this.db.all<{next_full_at:number}>('SELECT next_full_at FROM dashboard_scan_control WHERE id=1'))[0];
    return {state:row?.state??'idle',job:row?await this.view(row):null,latestFullScan:last?await this.view(last):null,nextScanAt:this.config.autoCollect&&control?.next_full_at?control.next_full_at:null,autoCollect:this.config.autoCollect,execution:this.execution};
  }
  async start(options:ScanStart={}):Promise<ScanStatus>{
    const reason=options.reason??'manual',automatic=reason!=='manual';
    if(!['auto','manual','startup','periodic','incremental'].includes(reason))invalid('Invalid scan trigger');
    if(options.metrics!==undefined&&!Array.isArray(options.metrics))invalid('Expected a resource metric array');
    if(options.metrics?.some(m=>!RESOURCE_METRICS.includes(m)))invalid('Invalid resource metric');
    if(automatic&&!this.config.autoCollect)return this.status();
    const now=this.now(),existing=await this.active();
    // Manual invocations reuse an existing job, including an explicitly paused one.
    if(existing&&reason==='manual')return this.status();
    const [metadata,bindings,dirty,control]=await Promise.all([dashboardAccounts(this.db),this.runtime.accounts(),this.db.all<Dirty>('SELECT * FROM dashboard_scan_dirty'),this.db.all<{next_full_at:number}>('SELECT next_full_at FROM dashboard_scan_control WHERE id=1')]);
    const full=!options.accountId&&!options.metrics?.length&&(reason==='manual'||(reason!=='incremental'&&(control[0]?.next_full_at??0)<=now));
    const eligible=metadata.filter(a=>!['disabled','expired','invalid'].includes(a.credential_status??''));
    const identities=new Map<number,string>();await Promise.all(bindings.map(async a=>identities.set(a.id,await bindingSignature(a))));
    const stored=await this.db.all<ResourceSnapshot>('SELECT * FROM resource_summaries');
    const snapshots=await currentSnapshots(this.runtime,bindings,stored);
    const recent=await this.db.all<Item>(`SELECT i.* FROM dashboard_scan_items i JOIN dashboard_scan_jobs j ON j.id=i.job_id WHERE i.state='failed' OR i.next_eligible_at>?`,[now]);
    const recentKeys=new Set(recent.map(i=>`${i.cf_account_id}:${i.metric}:${i.identity}`)),rateKeys=new Set(recent.filter(i=>i.error_kind==='rate_limited'&&i.next_eligible_at>now).map(i=>`${i.cf_account_id}:${i.metric}:${i.identity}`));
    const cooldowns=new Map<string,number>();for(const i of recent)if(i.error_kind==='rate_limited'&&i.next_eligible_at>now)cooldowns.set(i.cf_account_id,Math.max(cooldowns.get(i.cf_account_id)??0,i.next_eligible_at));
    const groups=new Map<string,{accountId:number;cfId:string;metric:ResourceMetric;identity:string;fresh:boolean;changed:boolean;force:boolean}>();
    for(const a of eligible)for(const metric of options.metrics?.length?options.metrics:RESOURCE_METRICS){
      if(options.accountId&&a.id!==options.accountId||!supports(a,metric)||!identities.has(a.id))continue;
      const key=`${a.account_id}:${metric}`;if(groups.has(key))continue;
      const aliases=eligible.filter(b=>b.account_id===a.account_id&&supports(b,metric)&&(!options.accountId||b.id===options.accountId));
      const changed=dirty.some(d=>aliases.some(b=>b.id===d.account_id)&&(d.metric==='*'||d.metric===metric));
      const resourceChanged=dirty.some(d=>aliases.some(b=>b.id===d.account_id)&&d.metric===metric);
      const freshRow=snapshots.find(s=>s.cf_account_id===a.account_id&&s.metric===metric&&aliases.some(b=>b.id===s.account_id)&&s.identity===identities.get(s.account_id)&&s.value!==null&&!s.error_kind&&s.last_success_at!==null&&now-s.last_success_at<300000);
      const fresh=!!freshRow;
      if(!full&&!changed&&fresh&&!options.force)continue;
      if(!full&&!changed&&(reason==='periodic'||['auto','startup'].includes(reason)&&snapshots.some(s=>s.cf_account_id===a.account_id&&s.metric===metric&&s.last_success_at!==null&&s.identity===identities.get(s.account_id))))continue;
      if(!changed&&aliases.some(b=>{const key=`${a.account_id}:${metric}:${identities.get(b.id)}`;return rateKeys.has(key)||automatic&&!full&&recentKeys.has(key);}))continue;
      if(reason==='incremental'&&!changed)continue;
      groups.set(key,{accountId:freshRow?.account_id??a.id,cfId:a.account_id!,metric,identity:identities.get(freshRow?.account_id??a.id)!,fresh,changed,force:options.force===true||resourceChanged&&!fresh});
    }
    const consumed=dirty.filter(d=>(!options.accountId||d.account_id===options.accountId)&&(!options.metrics?.length||d.metric!=='*'&&options.metrics.includes(d.metric as ResourceMetric)));
    const clearDirty:Statement[]=consumed.length?[{sql:`DELETE FROM dashboard_scan_dirty WHERE EXISTS(SELECT 1 FROM json_each(?) r WHERE dashboard_scan_dirty.account_id=json_extract(r.value,'$.account_id') AND dashboard_scan_dirty.metric=json_extract(r.value,'$.metric') AND dashboard_scan_dirty.revision=json_extract(r.value,'$.revision'))`,params:[JSON.stringify(consumed)]}]:[];
    if(!groups.size){
      // Disabled/deleted targets have no work; clear only the revisions we observed.
      if(clearDirty.length)await this.batch(clearDirty);
      return this.status();
    }
    const id=crypto.randomUUID(),statements:Statement[]=[{sql:`INSERT OR IGNORE INTO dashboard_scan_jobs(id,active_key,state,trigger_reason,full_scan,created_at) VALUES(?,'global','queued',?,?,?)`,params:[id,reason,Number(full),now]}];
    // JSON table-valued input keeps planning well below D1 Free's 50 queries/invocation.
    // Encrypted auth cells are transient SQL guards; INSERT persists only queue metadata.
    statements.push(...snapshotStatements(snapshots,bindings,stored));
    const entries=[...groups.values()].map(g=>({context:snapshotContext(bindings.find(a=>a.id===g.accountId)!),cfId:g.cfId,metric:g.metric,accountId:g.accountId,identity:g.identity,state:g.fresh&&!g.force?'skipped':'queued',force:Number(g.force),finishedAt:g.fresh&&!g.force?now:null,nextEligibleAt:cooldowns.get(g.cfId)??0}));
    for(let n=0;n<entries.length;n+=2000){
      statements.push({sql:`INSERT INTO dashboard_scan_items(job_id,cf_account_id,metric,account_id,identity,state,force,finished_at,next_eligible_at)
        SELECT (SELECT id FROM dashboard_scan_jobs WHERE ${ACTIVE}),json_extract(s.value,'$.cfId'),json_extract(s.value,'$.metric'),a.id,json_extract(s.value,'$.identity'),CASE WHEN json_extract(s.value,'$.state')='skipped' AND ${snapshotBindingSql(k=>`json_extract(s.value,'$.context.${k}')`)} THEN 'skipped' ELSE 'queued' END,json_extract(s.value,'$.force'),json_extract(s.value,'$.finishedAt'),json_extract(s.value,'$.nextEligibleAt') FROM json_each(?) s LEFT JOIN accounts a ON a.id=json_extract(s.value,'$.accountId') LEFT JOIN credentials c ON c.id=a.credential_id WHERE 1
        ON CONFLICT(job_id,cf_account_id,metric) DO UPDATE SET revision=dashboard_scan_items.revision+1,force=MAX(dashboard_scan_items.force,excluded.force),state=CASE WHEN dashboard_scan_items.state='running' THEN 'running' ELSE excluded.state END,attempts=CASE WHEN dashboard_scan_items.state='running' THEN dashboard_scan_items.attempts ELSE 0 END,attempted_bindings='[]',next_eligible_at=MAX(dashboard_scan_items.next_eligible_at,excluded.next_eligible_at),finished_at=excluded.finished_at
        WHERE EXISTS(SELECT 1 FROM dashboard_scan_dirty d JOIN accounts a ON a.id=d.account_id WHERE a.account_id=excluded.cf_account_id AND (d.metric='*' OR d.metric=excluded.metric))`,params:[JSON.stringify(entries.slice(n,n+2000))]});
    }
    if(full){statements.push({sql:`UPDATE dashboard_scan_jobs SET full_scan=1 WHERE ${ACTIVE}`});statements.push({sql:'UPDATE dashboard_scan_control SET next_full_at=? WHERE id=1',params:[nextScanTime(now,this.config)]});}
    statements.push(...clearDirty);
    statements.push({sql:`DELETE FROM dashboard_scan_jobs WHERE active_key IS NULL AND finished_at<? AND id NOT IN (SELECT job_id FROM dashboard_scan_items WHERE next_eligible_at>?) AND id NOT IN (SELECT id FROM dashboard_scan_jobs WHERE full_scan=1 ORDER BY finished_at DESC LIMIT 1)`,params:[now-30*86400000,now]});
    // Atomic on SQLite and D1: no executor can see a partially planned job.
    await this.batch(statements);
    await this.finish();return this.status();
  }
  async schedule(){
    if(!this.config.autoCollect)return;
    const control=(await this.db.all<{next_full_at:number}>('SELECT next_full_at FROM dashboard_scan_control WHERE id=1'))[0];
    const dirty=(await this.db.all('SELECT account_id FROM dashboard_scan_dirty LIMIT 1')).length;
    if((control?.next_full_at??0)<=this.now()||dirty)await this.start({reason:(control?.next_full_at??0)<=this.now()?'periodic':'incremental'});
  }
  async collectOne(accountId:number,metric:ResourceMetric,refresh=false){
    if(!RESOURCE_METRICS.includes(metric))invalid('Invalid resource metric');
    const busy=await this.db.all(`SELECT i.job_id FROM dashboard_scan_items i JOIN dashboard_scan_jobs j ON j.id=i.job_id WHERE j.active_key='global' AND i.cf_account_id=(SELECT account_id FROM accounts WHERE id=?) AND i.metric=? AND i.state IN ('queued','running')`,[accountId,metric]);
    if(busy.length)throw Object.assign(Error('Resource is already queued; use dashboard scan status'),{statusCode:409,code:'SCAN_IN_PROGRESS'});
    const token=crypto.randomUUID(),now=this.now();
    await this.db.run('UPDATE dashboard_scan_control SET executor_token=?,executor_until=? WHERE id=1 AND executor_until<=?',[token,now+90000,now]);
    if(!await this.owns(token))throw Object.assign(Error('Another inventory read is running; retry after it finishes'),{statusCode:409,code:'SCAN_IN_PROGRESS'});
    try{return await collectResource(this.runtime,accountId,metric,refresh,{snapshotGuard:{sql:'EXISTS(SELECT 1 FROM dashboard_scan_control WHERE id=1 AND executor_token=? AND executor_until>?)',params:[token,this.now()]}});}
    finally{await this.db.run('UPDATE dashboard_scan_control SET executor_token=NULL,executor_until=0 WHERE id=1 AND executor_token=?',[token]);}
  }
  async pause(){await this.db.run(`UPDATE dashboard_scan_jobs SET state='paused' WHERE ${ACTIVE}`);return this.status();}
  async resume(){await this.db.run(`UPDATE dashboard_scan_jobs SET state='queued' WHERE ${ACTIVE} AND state='paused'`);return this.status();}
  private async finish(){
    await this.db.run(`UPDATE dashboard_scan_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM dashboard_scan_items WHERE job_id=dashboard_scan_jobs.id AND state='failed') THEN CASE WHEN EXISTS(SELECT 1 FROM dashboard_scan_items WHERE job_id=dashboard_scan_jobs.id AND (state='completed' OR state='skipped' AND error_kind IS NULL)) THEN 'completed_with_errors' ELSE 'failed' END ELSE 'completed' END,finished_at=?,last_error_kind=COALESCE((SELECT error_kind FROM dashboard_scan_items WHERE job_id=dashboard_scan_jobs.id AND state='failed' ORDER BY finished_at DESC LIMIT 1),last_error_kind),active_key=NULL WHERE ${ACTIVE} AND state!='paused' AND NOT EXISTS(SELECT 1 FROM dashboard_scan_items WHERE job_id=dashboard_scan_jobs.id AND state IN ('queued','running'))`,[this.now()]);
  }
  private async owns(token:string){return !!(await this.db.all('SELECT id FROM dashboard_scan_control WHERE id=1 AND executor_token=? AND executor_until>?',[token,this.now()])).length;}
  async runBatch(budget:ScanBudget={}):Promise<number>{
    if(budget.signal?.aborted)return 0;
    const initial=await this.active();if(!initial||initial.state==='paused')return 0;
    if(!(await this.db.all(`SELECT job_id FROM dashboard_scan_items WHERE job_id=? AND (state='queued' AND next_eligible_at<=? OR state='running' AND lease_until<=?) LIMIT 1`,[initial.id,this.now(),this.now()])).length){await this.finish();return 0;}
    const token=crypto.randomUUID(),now=this.now(),duration=Math.min(25000,budget.durationMs??22000),deadline=now+duration;
    await this.db.run('UPDATE dashboard_scan_control SET executor_token=?,executor_until=? WHERE id=1 AND executor_until<=?',[token,now+90000,now]);
    if(!await this.owns(token))return 0;
    try{
      const job=await this.active();if(!job||job.state==='paused')return 0;
      await this.db.run(`UPDATE dashboard_scan_items SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_kind='executor_lost',lease_token=NULL,lease_until=NULL WHERE job_id=? AND state='running' AND lease_until<=?`,[job.id,now]);
      const pending=await this.db.all<Item>(`SELECT * FROM dashboard_scan_items WHERE job_id=? AND state='queued' AND next_eligible_at<=? ORDER BY attempts,cf_account_id,metric LIMIT 100`,[job.id,now]);
      const picked:Item[]=[],seen=new Set<string>();
      for(const item of pending){if(seen.has(item.cf_account_id))continue;seen.add(item.cf_account_id);picked.push(item);if(picked.length>=Math.min(this.config.concurrency,budget.maxItems??this.config.concurrency))break;}
      await Promise.all(picked.map(item=>this.execute(item,token,deadline,budget)));
      await this.finish();return picked.length;
    }finally{await this.db.run('UPDATE dashboard_scan_control SET executor_token=NULL,executor_until=0 WHERE id=1 AND executor_token=?',[token]);}
  }
  private async execute(item:Item,token:string,deadline:number,budget:ScanBudget){
    if(budget.signal?.aborted||this.now()>=deadline||!await this.owns(token))return;
    const [metadata,bindings]=await Promise.all([dashboardAccounts(this.db),this.runtime.accounts()]);
    const candidates=bindings.filter(a=>a.account_id===item.cf_account_id&&metadata.some(m=>m.id===a.id&&supports(m,item.metric)&&!['disabled','expired','invalid'].includes(m.credential_status??'')));
    const attempted=JSON.parse(item.attempted_bindings) as string[];
    let chosen:typeof candidates[number]|undefined,identity='';
    for(const a of candidates){const signature=await bindingSignature(a);if(!attempted.includes(signature)){chosen=a;identity=signature;break;}}
    if(!chosen){const unavailable=metadata.some(a=>a.account_id===item.cf_account_id&&supports(a,item.metric));await this.db.run(`UPDATE dashboard_scan_items SET state=?,finished_at=?,error_kind=? WHERE job_id=? AND cf_account_id=? AND metric=? AND state='queued'`,[candidates.length||unavailable?'failed':'skipped',this.now(),candidates.length?'permission':unavailable?'invalid':'account_unavailable',item.job_id,item.cf_account_id,item.metric]);return;}
    await this.db.run(`UPDATE dashboard_scan_items SET state='running',account_id=?,identity=?,attempts=attempts+1,lease_token=?,lease_until=? WHERE job_id=? AND cf_account_id=? AND metric=? AND state='queued' AND revision=? AND EXISTS(SELECT 1 FROM dashboard_scan_jobs WHERE id=dashboard_scan_items.job_id AND active_key='global' AND state!='paused')`,[chosen.id,identity,token,this.now()+90000,item.job_id,item.cf_account_id,item.metric,item.revision]);
    const claimed=(await this.db.all<Item>('SELECT * FROM dashboard_scan_items WHERE job_id=? AND cf_account_id=? AND metric=?',[item.job_id,item.cf_account_id,item.metric]))[0];if(claimed?.lease_token!==token)return;
    await this.db.run(`UPDATE dashboard_scan_jobs SET state=CASE WHEN state='paused' THEN state ELSE 'running' END,started_at=COALESCE(started_at,?) WHERE id=?`,[this.now(),item.job_id]);
    const fence=async()=>await this.owns(token)&&!!(await this.db.all('SELECT job_id FROM dashboard_scan_items WHERE job_id=? AND cf_account_id=? AND metric=? AND lease_token=? AND revision=?',[item.job_id,item.cf_account_id,item.metric,token,item.revision])).length;
    let state='completed',kind:string|null,next=0;
    try{
      const snapshotGuard={sql:`EXISTS(SELECT 1 FROM dashboard_scan_control WHERE id=1 AND executor_token=? AND executor_until>?) AND EXISTS(SELECT 1 FROM dashboard_scan_items WHERE job_id=? AND cf_account_id=? AND metric=? AND lease_token=? AND revision=?)`,params:[token,this.now(),item.job_id,item.cf_account_id,item.metric,token,item.revision]};
      const result=await collectResource(this.runtime,chosen.id,item.metric,!!item.force,{deadline,maxRequests:budget.maxRequests??35,signal:budget.signal,canCommit:fence,expectedIdentity:identity,snapshotGuard}) as ResourceSnapshot & {nextEligibleAt?:number};
      kind=result.error_kind;
      if(kind){state='failed';next=this.now()+(kind==='permission'||kind==='invalid'?this.config.intervalHours*3600000:900000);
        if(['permission','invalid'].includes(kind)&&candidates.some(a=>a.id!==chosen!.id)&&claimed.attempts<3){state='queued';next=0;}
        if(kind==='rate_limited'){next=Math.max(this.now()+300000,result.nextEligibleAt??0);if(claimed.attempts<3)state='queued';await this.db.run(`UPDATE dashboard_scan_items SET next_eligible_at=MAX(next_eligible_at,?) WHERE job_id=? AND cf_account_id=? AND state='queued'`,[next,item.job_id,item.cf_account_id]);}
      }
    }catch(error){kind=errorDetails(error).kind;state='failed';next=this.now()+900000;if((error as {statusCode?:number}).statusCode===409){state=claimed.attempts<3?'queued':'failed';kind='identity_changed';next=0;}}
    if(budget.signal?.aborted&&(budget.signal.reason as {name?:string})?.name!=='TimeoutError'){state='queued';kind='executor_stopped';next=0;}
    if(!await this.owns(token))return;
    const tried=state==='queued'&&['permission','invalid'].includes(kind??'')?JSON.stringify([...attempted,identity]):'[]';
    // A mutation merged while we read must run again; never claim its new revision completed.
    await this.db.run(`UPDATE dashboard_scan_items SET attempts=CASE WHEN ?='executor_stopped' THEN MAX(0,attempts-1) ELSE attempts END,state=CASE WHEN revision!=? THEN 'queued' ELSE ? END,error_kind=?,next_eligible_at=?,attempted_bindings=?,lease_token=NULL,lease_until=NULL,finished_at=CASE WHEN revision!=? OR ?='queued' THEN NULL ELSE ? END WHERE job_id=? AND cf_account_id=? AND metric=? AND lease_token=?`,[kind,item.revision,state,kind,next,tried,item.revision,state,this.now(),item.job_id,item.cf_account_id,item.metric,token]);
    if(kind)await this.db.run('UPDATE dashboard_scan_jobs SET last_error_kind=? WHERE id=?',[kind,item.job_id]);
  }
}

/** Mutation receipts can invalidate one inventory without affecting unrelated products. */
export async function markScanDirty(db:LocalSql,accountId:number,metric:ResourceMetric){
  const insert:Statement={sql:`INSERT INTO dashboard_scan_dirty(account_id,metric) SELECT id,? FROM accounts WHERE id=? ON CONFLICT(account_id,metric) DO UPDATE SET revision=revision+1`,params:[metric,accountId]};
  const update:Statement={sql:`UPDATE resource_summaries SET error_kind='invalidated',fetched_at=MAX(fetched_at,CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)) WHERE cf_account_id=(SELECT account_id FROM accounts WHERE id=?) AND metric=?`,params:[accountId,metric]};
  const fence:Statement={sql:`UPDATE dashboard_scan_items SET revision=revision+1,force=1,state=CASE WHEN state='running' THEN 'running' ELSE 'queued' END,attempts=CASE WHEN state='running' THEN attempts ELSE 0 END,finished_at=NULL WHERE job_id=(SELECT id FROM dashboard_scan_jobs WHERE active_key='global') AND cf_account_id=(SELECT account_id FROM accounts WHERE id=?) AND metric=?`,params:[accountId,metric]};
  if(db.batch)await db.batch([insert,update,fence]);else{for(const s of [insert,update,fence])await db.run(s.sql,s.params);}
}
