import type { DashboardAccount, Metric, ResourceMetric } from '../shared/dashboardData';
/** A successful binding covers a real CF Account. Failed bindings may fall back to another credential. */
export function confirmedResourceKeys(accounts:DashboardAccount[], summaries:Array<{accountId:number;metrics:Metric[]}>,now=Date.now()):Set<string>{
 const keys=new Set<string>();
 const bindings=new Map(accounts.map(a=>[a.id,a]));
 for(const summary of summaries){const account=bindings.get(summary.accountId);if(!account?.account_id)continue;for(const m of summary.metrics)if(m.state==='ready'&&m.complete&&m.lastSuccessAt!==null&&now-m.lastSuccessAt<300000)keys.add(`${account.account_id}:${m.metric}`);}
 return keys;
}
export const collectionKey=(account:Pick<DashboardAccount,'account_id'>,metric:ResourceMetric)=>`${account.account_id}:${metric}`;
