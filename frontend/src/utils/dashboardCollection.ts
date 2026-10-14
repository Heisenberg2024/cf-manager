import { snapshotPolicy, type DashboardAccount, type Metric, type ResourceMetric } from '../shared/dashboardData';
/** A successful binding covers a real CF Account. Failed bindings may fall back to another credential. */
export function confirmedResourceKeys(accounts:DashboardAccount[], summaries:Array<{accountId:number;metrics:Metric[]}>,now=Date.now()):Set<string>{
 const keys=new Set<string>();
 const bindings=new Map(accounts.map(a=>[a.id,a]));
 for(const summary of summaries){const account=bindings.get(summary.accountId);if(!account?.account_id)continue;for(const m of summary.metrics)if(m.state==='ready'&&m.complete&&m.refreshState!=='pending'&&m.lastSuccessAt!==null&&now-m.lastSuccessAt<snapshotPolicy().refreshMs)keys.add(`${account.account_id}:${m.metric}`);}
 return keys;
}
export const collectionKey=(account:Pick<DashboardAccount,'account_id'>,metric:ResourceMetric)=>`${account.account_id}:${metric}`;

import type {ScanStatus} from '../shared/dashboardScanTypes';
const needsPoll=(status:ScanStatus)=>scanIsRunning(status.state)||status.state==='paused'&&!!status.job?.currentResource.length;
export const scanIsRunning=(state:ScanStatus['state'])=>state==='queued'||state==='running';
/** Polls only lightweight persisted status. Stop aborts reads and fences late responses, never pauses a job. */
export function createScanPoller(options:{read:(signal:AbortSignal)=>Promise<ScanStatus>;update:(status:ScanStatus)=>void|Promise<void>;error:(error:unknown)=>void;intervalMs?:number;idleIntervalMs?:number}){
 let timer:ReturnType<typeof setTimeout>|undefined,controller=new AbortController(),epoch=0;
 const stop=()=>{epoch++;if(timer)clearTimeout(timer);timer=undefined;controller.abort();controller=new AbortController();};
 const schedule=(status:ScanStatus,generation:number)=>{const interval=needsPoll(status)?options.intervalMs??4000:options.idleIntervalMs;if(generation===epoch&&interval)timer=setTimeout(()=>{void poll(generation);},interval);};
 const observe=async(status:ScanStatus)=>{stop();const generation=epoch;await options.update(status);schedule(status,generation);};
 const poll=async(generation:number)=>{try{const value=await options.read(controller.signal);if(generation!==epoch)return;await options.update(value);schedule(value,generation);}catch(error){if(generation===epoch&&!controller.signal.aborted){options.error(error);if(options.idleIntervalMs)timer=setTimeout(()=>{void poll(generation);},options.idleIntervalMs);}}};
 return {observe,stop};
}
