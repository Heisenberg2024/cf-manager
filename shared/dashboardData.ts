import { auditPage, auditStats, positive, invalid, type LocalSql } from './auditQueries';
import { normalizeAccountName } from './accountName';

export const RESOURCE_METRICS = ['zones', 'workers', 'pages', 'tunnels', 'kv', 'd1', 'r2'] as const;
export type ResourceMetric = typeof RESOURCE_METRICS[number];
export type DataState = 'ready' | 'stale' | 'partial' | 'unknown' | 'loading' | 'error';
export interface DashboardAccount {
  id: number; name: string; account_id: string | null; credential_id: number | null; credential_name: string | null;
  is_active: number; is_enabled: number; enabled_features: string; access_status: string; last_checked_at: string | null;
  credential_status: string | null; credential_checked_at: string | null; worker_plan: string;
}
export interface ResourceSnapshot {
  account_id: number; cf_account_id: string; metric: ResourceMetric; identity: string;
  value: number | null; breakdown: string; fetched_at: number; last_success_at: number | null; error_kind: string | null;
}
export interface Metric {
  metric: string; value: number | null; state: DataState; source: 'local' | 'snapshot'; fetchedAt: number | null;
  lastSuccessAt: number | null; complete: boolean; coveredAccounts: number; totalAccounts: number; errorKind: string | null;
  breakdown: Record<string, number>;
}
export interface Attention {
  id: string; severity: 'critical' | 'warning' | 'info'; kind: string; source: string; accountId?: number;
  name: string; detectedAt: number | string | null; state: string; route: string;
}
export const META_SQL = `SELECT a.id,a.name,a.account_id,a.credential_id,a.is_active,a.is_enabled,a.enabled_features,a.access_status,a.last_checked_at,a.worker_plan,
  c.name AS credential_name,c.status AS credential_status,c.last_checked_at AS credential_checked_at
  FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id ORDER BY a.name,a.id`;
export function selectedAccount(query: Record<string, unknown>) { return query.accountId ? positive(query.accountId) : undefined; }
export async function dashboardAccounts(db: LocalSql): Promise<DashboardAccount[]> {
  return (await db.all<DashboardAccount>(META_SQL)).map(a => ({ ...a, name: normalizeAccountName(a.name) }));
}
export function inResourceScope(account:DashboardAccount,metric:ResourceMetric):boolean {
  const feature=metric==='zones'?'dns':['workers','pages'].includes(metric)?'workers':['kv','d1','r2'].includes(metric)?'storage':null;
  return !feature||account.enabled_features.split(',').includes(feature);
}
export function supports(account: DashboardAccount, metric: ResourceMetric): boolean {
  return inResourceScope(account,metric)&&!!account.account_id&&account.is_enabled!==0&&account.is_active!==0;
}
export function aggregateResources(accounts: DashboardAccount[], snapshots: ResourceSnapshot[], now = Date.now()): Metric[] {
  return RESOURCE_METRICS.map(metric => {
    const eligible = accounts.filter(a => inResourceScope(a, metric));
    const groups = new Map<string, DashboardAccount[]>();
    for (const a of eligible) groups.set(a.account_id||`unbound:${a.id}`, [...(groups.get(a.account_id||`unbound:${a.id}`) ?? []), a]);
    const confirmed: ResourceSnapshot[] = []; let failures = 0;
    for (const [cfId, bindings] of groups) {
      const rows = snapshots.filter(s => s.metric === metric && s.cf_account_id === cfId && bindings.some(a => a.id === s.account_id));
      // One complete successful binding covers the real Account, even if another credential failed.
      const success = rows.filter(s => s.value !== null && s.last_success_at !== null).sort((a,b) => b.last_success_at! - a.last_success_at!)[0];
      if (success) confirmed.push(success); else if (rows.some(s => !!s.error_kind)) failures++;
    }
    const complete = confirmed.length === groups.size;
    const stale = confirmed.some(s => now - s.last_success_at! >= 300000 || !!s.error_kind);
    const timestamps = confirmed.map(s => s.last_success_at!);
    const attempts = snapshots.filter(s => s.metric === metric && eligible.some(a => a.id === s.account_id)).map(s => s.fetched_at);
    const breakdown: Record<string, number> = {};
    for (const row of confirmed) {
      try { for (const [key, val] of Object.entries(JSON.parse(row.breakdown))) if (typeof val === 'number') breakdown[key] = (breakdown[key] ?? 0) + val; } catch { /* legacy invalid summary is ignored */ }
    }
    return { metric, value: confirmed.length ? confirmed.reduce((n,s) => n + s.value!, 0) : groups.size === 0 ? 0 : null,
      state: complete ? stale ? 'stale' : 'ready' : confirmed.length ? 'partial' : failures ? 'error' : 'unknown', source: 'snapshot',
      fetchedAt: attempts.length ? Math.max(...attempts) : null, lastSuccessAt: timestamps.length ? Math.min(...timestamps) : null,
      complete, coveredAccounts: confirmed.length, totalAccounts: groups.size, errorKind: failures || confirmed.some(s => s.error_kind) ? 'resource_read_failed' : null, breakdown };
  });
}
export async function dashboardOverview(db: LocalSql, query: Record<string, unknown>) {
  const accountId = selectedAccount(query), all = await dashboardAccounts(db);
  const accounts = all.filter(a => !accountId || a.id === accountId);
  const issues: Attention[] = [];
  for (const a of accounts) {
    if (['unauthorized','unavailable','error'].includes(a.access_status)) issues.push({ id:`access-${a.id}`,severity:'critical',kind:'accountAccess',source:'accounts',accountId:a.id,name:a.name,detectedAt:a.last_checked_at,state:a.access_status,route:'/accounts' });
    if (a.credential_status && ['invalid','expired','disabled'].includes(a.credential_status)) issues.push({id:`credential-${a.credential_id}`,severity:'critical',kind:'credential',source:'credentials',accountId:a.id,name:a.name,detectedAt:a.credential_checked_at,state:a.credential_status,route:'/accounts'});
    if (!a.last_checked_at || Date.now()-new Date(a.last_checked_at).getTime()>30*86400000) issues.push({id:`verification-${a.id}`,severity:'info',kind:'verification',source:'accounts',accountId:a.id,name:a.name,detectedAt:a.last_checked_at,state:'unknown',route:'/accounts'});
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
    counts:{verified:accounts.filter(a=>a.access_status==='available'&&a.is_active!==0&&a.is_enabled!==0).length,bindings:accounts.length,cloudflareAccounts:new Set(accounts.map(a=>a.account_id).filter(Boolean)).size,enabled:accounts.filter(a=>a.is_active!==0&&a.is_enabled!==0).length,disabled:accounts.filter(a=>a.is_enabled===0).length,unverified:accounts.filter(a=>a.access_status!=='available').length},issues:uniqueIssues };
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
export async function saveResourceSnapshot(db:LocalSql, row:ResourceSnapshot) {
  await db.run(`INSERT INTO resource_summaries (account_id,cf_account_id,metric,identity,value,breakdown,fetched_at,last_success_at,error_kind) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,metric) DO UPDATE SET cf_account_id=excluded.cf_account_id,identity=excluded.identity,value=excluded.value,breakdown=excluded.breakdown,fetched_at=excluded.fetched_at,last_success_at=excluded.last_success_at,error_kind=excluded.error_kind
    WHERE resource_summaries.fetched_at <= excluded.fetched_at`,[row.account_id,row.cf_account_id,row.metric,row.identity,row.value,row.breakdown,row.fetched_at,row.last_success_at,row.error_kind]);
}
