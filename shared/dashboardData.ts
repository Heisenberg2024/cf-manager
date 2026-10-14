import { auditPage, auditStats, positive, invalid, type LocalSql } from './auditQueries';
import { normalizeAccountName } from './accountName';

export const RESOURCE_METRICS = ['zones', 'workers', 'pages', 'tunnels', 'kv', 'd1', 'r2'] as const;
export type ResourceMetric = typeof RESOURCE_METRICS[number];
export type DataState = 'ready' | 'stale' | 'partial' | 'unknown' | 'loading' | 'error';
export interface DashboardAccount {
  id: number; name: string; account_id: string | null; credential_id: number | null; credential_name: string | null;
  is_active: number; is_enabled: number; enabled_features: string; access_status: string; last_checked_at: string | null;
  credential_status: string | null; credential_checked_at: string | null; worker_plan: string;
  has_credentials?:number; available_features?:string;
}
export interface ResourceSnapshot {
  account_id: number; cf_account_id: string; metric: ResourceMetric; identity: string;
  value: number | null; breakdown: string; fetched_at: number; last_success_at: number | null; error_kind: string | null;
  last_failed_at?:number|null; invalidated_at?:number|null; historical_value?:number|null;
}
export interface Metric {
  metric: string; value: number | null; state: DataState; source: 'local' | 'snapshot'; fetchedAt: number | null;
  lastSuccessAt: number | null; complete: boolean; coveredAccounts: number; totalAccounts: number; errorKind: string | null;
  breakdown: Record<string, number>;
  snapshotAgeMs?:number|null; refreshState?:'current'|'due'|'pending'|'failed'|'historical';
  lastFailedAt?:number|null; longUnupdated?:boolean; collectibleAccounts?:number; excludedAccounts?:number; historicalValue?:number|null;
}
export interface Attention {
  id: string; severity: 'critical' | 'warning' | 'info'; kind: string; source: string; accountId?: number;
  name: string; detectedAt: number | string | null; state: string; route: string;
}
export const META_SQL = `SELECT a.id,a.name,a.account_id,a.credential_id,a.is_active,a.is_enabled,a.enabled_features,a.available_features,a.access_status,a.last_checked_at,a.worker_plan,
  c.name AS credential_name,c.status AS credential_status,c.last_checked_at AS credential_checked_at,
  CASE WHEN COALESCE(c.auth_type,a.auth_type)='global_key'
    THEN CASE WHEN NULLIF(CASE WHEN c.id IS NOT NULL THEN c.api_key ELSE a.api_key END,'') IS NOT NULL AND NULLIF(CASE WHEN c.id IS NOT NULL THEN c.email ELSE a.email END,'') IS NOT NULL THEN 1 ELSE 0 END
    ELSE CASE WHEN NULLIF(CASE WHEN c.id IS NOT NULL THEN c.api_token ELSE a.api_token END,'') IS NOT NULL THEN 1 ELSE 0 END END AS has_credentials
  FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id ORDER BY a.name,a.id`;
export function selectedAccount(query: Record<string, unknown>) { return query.accountId ? positive(query.accountId) : undefined; }
export async function dashboardAccounts(db: LocalSql): Promise<DashboardAccount[]> {
  return (await db.all<DashboardAccount>(META_SQL)).map(a => ({ ...a, name: normalizeAccountName(a.name) }));
}
export function inResourceScope(account:DashboardAccount,metric:ResourceMetric):boolean {
  const feature=metric==='zones'?'dns':['workers','pages'].includes(metric)?'workers':['kv','d1','r2'].includes(metric)?'storage':null;
  return (metric!=='r2'||!account.available_features?.split(',').includes('-r2'))&&(!feature||account.enabled_features.split(',').includes(feature));
}
export function isUnavailableSnapshot(snapshot:ResourceSnapshot):boolean {return snapshot.metric==='r2'&&['not_applicable','permission'].includes(snapshot.error_kind??'');}
export function supports(account: DashboardAccount, metric: ResourceMetric): boolean {
  return inResourceScope(account,metric)&&!!account.account_id&&account.has_credentials!==0&&account.is_enabled!==0&&account.is_active!==0&&!['invalid','expired','disabled'].includes(account.credential_status??'');
}
/** API TTL belongs to the resource readers. Inventory age only schedules collection, never changes a successful count to an error. */
export function snapshotPolicy(intervalHours=24) {const refreshMs=Math.max(1,intervalHours)*3600000;return {refreshMs,longUnupdatedMs:refreshMs*2};}
export function aggregateResources(accounts: DashboardAccount[], snapshots: ResourceSnapshot[], now = Date.now(), intervalHours=24): Metric[] {
  const policy=snapshotPolicy(intervalHours);
  return RESOURCE_METRICS.map(metric => {
    const scoped = accounts.filter(a => inResourceScope(a, metric));
    const eligible = scoped.filter(a=>!snapshots.some(s=>s.account_id===a.id&&s.metric===metric&&isUnavailableSnapshot(s)));
    const noR2Accounts=metric==='r2'&&eligible.length===0;
    const groups = new Map<string, DashboardAccount[]>();
    for (const a of eligible) groups.set(a.account_id||`unbound:${a.id}`, [...(groups.get(a.account_id||`unbound:${a.id}`) ?? []), a]);
    const confirmed: ResourceSnapshot[] = []; const historical:ResourceSnapshot[]=[]; let failures = 0;
    for (const [cfId, bindings] of groups) {
      const rows = snapshots.filter(s => s.metric === metric && s.cf_account_id === cfId && bindings.some(a => a.id === s.account_id));
      // One complete successful binding covers the real Account, even if another credential failed.
      const success = rows.filter(s => s.value !== null && s.last_success_at !== null).sort((a,b) => b.last_success_at! - a.last_success_at!||Number(!!a.error_kind)-Number(!!b.error_kind)||b.fetched_at-a.fetched_at||a.account_id-b.account_id)[0];
      if (success) confirmed.push(success); else if (rows.some(s => !!s.error_kind&&!['invalidated','legacy_unverified'].includes(s.error_kind))) failures++;
      if(!success){const old=rows.find(s=>s.historical_value!==undefined&&s.historical_value!==null);if(old)historical.push(old);}
    }
    const complete = confirmed.length === groups.size && (groups.size>0||accounts.length===0||noR2Accounts);
    const failed = failures>0||confirmed.some(s=>!!s.error_kind&&!['invalidated','legacy_unverified'].includes(s.error_kind));
    const pending = confirmed.some(s=>!!s.invalidated_at||s.error_kind==='invalidated');
    const timestamps = confirmed.map(s => s.last_success_at!);
    const attempts = snapshots.filter(s => s.metric === metric && eligible.some(a => a.id === s.account_id)).map(s => s.fetched_at);
    const breakdown: Record<string, number> = {};
    for (const row of confirmed) {
      try { for (const [key, val] of Object.entries(JSON.parse(row.breakdown))) if (typeof val === 'number') breakdown[key] = (breakdown[key] ?? 0) + val; } catch { /* legacy invalid summary is ignored */ }
    }
    return { metric, value: confirmed.length ? confirmed.reduce((n,s) => n + s.value!, 0) : accounts.length===0||noR2Accounts ? 0 : null,
      state: complete ? failed ? 'error' : 'ready' : confirmed.length ? 'partial' : failures ? 'error' : 'unknown', source: 'snapshot',
      fetchedAt: attempts.length ? Math.max(...attempts) : null, lastSuccessAt: timestamps.length ? Math.min(...timestamps) : null,
      complete, coveredAccounts: confirmed.length, totalAccounts: groups.size, errorKind: failed ? 'resource_read_failed' : null, breakdown,
      snapshotAgeMs:timestamps.length?Math.max(0,now-Math.min(...timestamps)):null,
      refreshState:failed?'failed':pending?'pending':historical.length?'historical':timestamps.some(t=>now-t>=policy.refreshMs)?'due':'current',
      longUnupdated:timestamps.some(t=>now-t>=policy.longUnupdatedMs),lastFailedAt:Math.max(0,...snapshots.filter(s=>s.metric===metric&&eligible.some(a=>a.id===s.account_id)).map(s=>s.last_failed_at??0))||null,
      collectibleAccounts:[...groups.values()].filter(group=>group.some(a=>supports(a,metric))).length,
      excludedAccounts:[...groups.values()].filter(group=>!group.some(a=>supports(a,metric))).length,
      historicalValue:historical.length?historical.reduce((sum,s)=>sum+s.historical_value!,0):null };
  });
}
export async function dashboardOverview(db: LocalSql, query: Record<string, unknown>) {
  const accountId = selectedAccount(query), all = await dashboardAccounts(db);
  const accounts = all.filter(a => !accountId || a.id === accountId);
  const issues: Attention[] = [];
  for (const a of accounts) {
    if (['unauthorized','unavailable','error'].includes(a.access_status)) issues.push({ id:`access-${a.id}`,severity:'critical',kind:'accountAccess',source:'accounts',accountId:a.id,name:a.name,detectedAt:a.last_checked_at,state:a.access_status,route:'/accounts' });
    if (a.credential_status && ['invalid','expired','disabled'].includes(a.credential_status)) issues.push({id:`credential-${a.credential_id}`,severity:'critical',kind:'credential',source:'credentials',accountId:a.id,name:a.name,detectedAt:a.credential_checked_at,state:a.credential_status,route:'/accounts'});
  }
  const quotas = await db.all<{account_id:number;resource:string;count:number;exhausted:number}>('SELECT account_id,resource,count,exhausted FROM quota_usage WHERE date = ?' + (accountId ? ' AND account_id = ?' : ''), [new Date().toISOString().slice(0,10), ...(accountId ? [accountId] : [])]);
  for (const q of quotas.filter(q=>q.exhausted===1)) issues.push({id:`quota-${q.account_id}-${q.resource}`,severity:'warning',kind:'quota',source:'quota_usage',accountId:q.account_id,name:accounts.find(a=>a.id===q.account_id)?.name ?? String(q.account_id),detectedAt:new Date().toISOString().slice(0,10),state:q.resource,route:'/accounts'});
  const catalog = await db.all<{id:number;name:string;last_status:string;last_synced:string|null}>("SELECT id,name,last_status,last_synced FROM catalog_sources WHERE enabled = 1");
  if (!accountId) for (const s of catalog.filter(s=>s.last_status==='error')) issues.push({id:`catalog-${s.id}`,severity:'warning',kind:'catalog',source:'catalog_sources',name:s.name,detectedAt:null,state:'error',route:'/store'});
  const recentErrors=await auditPage(db,{...(accountId?{accountId}:{}),status:'error',startDate:new Date(Date.now()-7*86400000).toISOString().slice(0,10),limit:5});
  for(const event of recentErrors.items){let unknown=false;try{unknown=JSON.parse(event.detail??'{}').status==='unknown';}catch{/* safe legacy redaction */}
    issues.push({id:`audit-${event.id}`,severity:unknown?'critical':'warning',kind:unknown?'unknownWrite':'recentAuditFailure',source:'audit_log',accountId:event.account_id??undefined,name:event.account_name??event.action,detectedAt:event.created_at,state:unknown?'unknown':'recorded_error',route:'/audit-logs'});
  }
  const uniqueIssues = [...new Map(issues.map(i=>[i.id,i])).values()];
  return { fetchedAt:Date.now(),source:'local',localHealth:'ready',remoteHealth:'unknown',accounts,quota:quotas,
    counts:{verified:accounts.filter(a=>a.access_status==='available'&&a.has_credentials!==0&&a.is_active!==0&&a.is_enabled!==0&&!['invalid','expired','disabled'].includes(a.credential_status??'')).length,bindings:accounts.length,cloudflareAccounts:new Set(accounts.map(a=>a.account_id).filter(Boolean)).size,enabled:accounts.filter(a=>a.is_active!==0&&a.is_enabled!==0).length,disabled:accounts.filter(a=>a.is_enabled===0).length,unverified:accounts.filter(a=>a.access_status!=='available'||a.has_credentials===0||a.is_active===0||['invalid','expired','disabled'].includes(a.credential_status??'')).length},issues:uniqueIssues };
}
export async function dashboardTrends(db: LocalSql, query: Record<string, unknown>) {
  const days = Number(query.days ?? 7); if (![7,30].includes(days)) invalid('Days must be 7 or 30');
  const accountId = selectedAccount(query), end = new Date(), start = new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()-days+1));
  const startDate = start.toISOString().slice(0,10), endDate = end.toISOString().slice(0,10);
  // quota_usage mixes locally tracked and previously synchronized values and has no provenance timestamps.
  // MAX per real Account avoids summing duplicate credential bindings. This is recorded usage, not billing.
  const usage = await db.all<{date:string;resource:string;count:number}>(`SELECT date,resource,SUM(used) AS count FROM (
    SELECT q.date,q.resource,COALESCE(a.account_id,'local:'||a.id) AS identity,MAX(q.count) AS used
    FROM quota_usage q JOIN accounts a ON a.id=q.account_id WHERE q.date >= ? AND q.date <= ? ${accountId ? 'AND a.id = ?' : ''}
    GROUP BY q.date,q.resource,identity) GROUP BY date,resource ORDER BY date`,[startDate,endDate,...(accountId?[accountId]:[])]);
  const audit = await auditStats(db,{...query,startDate,endDate});
  return {days,startDate,endDate,timezone:'UTC',usage,usageSource:'quota_usage: recorded local/synchronized usage; provenance unavailable; MAX per real Account',limits:null,audit};
}
export async function saveResourceSnapshot(db:LocalSql, row:ResourceSnapshot,guard?:{sql:string;params:unknown[]}) {
  await db.run(`INSERT INTO resource_summaries (account_id,cf_account_id,metric,identity,value,breakdown,fetched_at,last_success_at,error_kind,last_failed_at,invalidated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? ${guard?`WHERE ${guard.sql}`:''}
    ON CONFLICT(account_id,metric) DO UPDATE SET cf_account_id=excluded.cf_account_id,identity=excluded.identity,
    value=CASE WHEN excluded.error_kind IS NOT NULL AND resource_summaries.identity=excluded.identity THEN resource_summaries.value ELSE excluded.value END,
    breakdown=CASE WHEN excluded.error_kind IS NOT NULL AND resource_summaries.identity=excluded.identity THEN resource_summaries.breakdown ELSE excluded.breakdown END,
    last_success_at=CASE WHEN excluded.error_kind IS NOT NULL AND resource_summaries.identity=excluded.identity THEN resource_summaries.last_success_at ELSE excluded.last_success_at END,
    fetched_at=excluded.fetched_at,error_kind=excluded.error_kind,last_failed_at=COALESCE(excluded.last_failed_at,resource_summaries.last_failed_at),invalidated_at=excluded.invalidated_at
    WHERE resource_summaries.fetched_at < excluded.fetched_at OR (resource_summaries.fetched_at=excluded.fetched_at AND resource_summaries.invalidated_at IS NULL)`,[row.account_id,row.cf_account_id,row.metric,row.identity,row.value,row.breakdown,row.fetched_at,row.last_success_at,row.error_kind,row.last_failed_at??null,row.invalidated_at??null,...(guard?.params??[])]);
}
