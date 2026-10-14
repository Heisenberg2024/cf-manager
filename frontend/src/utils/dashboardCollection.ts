import type { DashboardAccount, Metric, ResourceMetric } from '../shared/dashboardData';
/** A successful binding covers a real CF Account. Failed bindings may fall back to another credential. */
export function confirmedResourceKeys(accounts:DashboardAccount[], summaries:Array<{accountId:number;metrics:Metric[]}>,now=Date.now()):Set<string>{
 const keys=new Set<string>();
 const bindings=new Map(accounts.map(a=>[a.id,a]));
 for(const summary of summaries){const account=bindings.get(summary.accountId);if(!account?.account_id)continue;for(const m of summary.metrics)if(m.state==='ready'&&m.complete&&m.lastSuccessAt!==null&&now-m.lastSuccessAt<300000)keys.add(`${account.account_id}:${m.metric}`);}
 return keys;
}
export const collectionKey=(account:Pick<DashboardAccount,'account_id'>,metric:ResourceMetric)=>`${account.account_id}:${metric}`;

import type {ScanStatus} from '../shared/dashboardScanTypes';
const needsPoll=(status:ScanStatus)=>scanIsRunning(status.state)||status.state==='paused'&&!!status.job?.currentResource.length;
export const scanIsRunning=(state:ScanStatus['state'])=>state==='queued'||state==='running';
/** Polls only lightweight persisted status. Stop aborts reads and fences late responses, never pauses a job. */
export function createScanPoller(options:{read:(signal:AbortSignal)=>Promise<ScanStatus>;update:(status:ScanStatus)=>void|Promise<void>;error:(error:unknown)=>void;intervalMs?:number}){
 let timer:ReturnType<typeof setTimeout>|undefined,controller=new AbortController(),epoch=0;
 const stop=()=>{epoch++;if(timer)clearTimeout(timer);timer=undefined;controller.abort();controller=new AbortController();};
 const observe=async(status:ScanStatus)=>{stop();const generation=epoch;await options.update(status);if(generation===epoch&&needsPoll(status))timer=setTimeout(()=>{void poll(generation);},options.intervalMs??4000);};
 const poll=async(generation:number)=>{try{const value=await options.read(controller.signal);if(generation!==epoch)return;await options.update(value);if(generation===epoch&&needsPoll(value))timer=setTimeout(()=>{void poll(generation);},options.intervalMs??4000);}catch(error){if(generation===epoch&&!controller.signal.aborted)options.error(error);}};
 return {observe,stop};
}
