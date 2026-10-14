export type ScanState = 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'failed';
export interface ScanJob {
  jobId:string; state:ScanState; triggerReason:string; fullScan:boolean;
  createdAt:number; startedAt:number|null; finishedAt:number|null;
  total:number; completed:number; succeeded:number; failed:number; skipped:number;
  currentResource:Array<{accountId:number|null;accountName:string;metric:string}>;
  lastErrorKind:string|null; nextEligibleAt:number|null;
  resources:Array<{metric:string;total:number;succeeded:number;failed:number;skipped:number}>;
}
export interface ScanStatus {
  state:ScanState; job:ScanJob|null; latestFullScan:ScanJob|null;
  nextScanAt:number|null; autoCollect:boolean; execution:'background'|'request_batches';
  snapshotVersion?:string; lastSuccessfulScanAt?:number|null; pendingChanges?:boolean;
}
export interface ScanConfig {autoCollect:boolean;intervalHours:number;concurrency:number;startupDelayMs:number;windowUtc:string}
const number=(value:unknown,fallback:number,min:number,max:number)=>Number.isFinite(Number(value))&&value!==''&&value!==undefined?Math.max(min,Math.min(max,Math.floor(Number(value)))):fallback;
export function scanConfig(env:Record<string,unknown>={}):ScanConfig {
  return {autoCollect:env.DASHBOARD_AUTO_COLLECT!=='false',intervalHours:number(env.DASHBOARD_SCAN_INTERVAL_HOURS,24,1,720),concurrency:number(env.DASHBOARD_SCAN_CONCURRENCY,2,1,4),startupDelayMs:number(env.DASHBOARD_SCAN_STARTUP_DELAY,15,0,3600)*1000,windowUtc:typeof env.DASHBOARD_SCAN_WINDOW_UTC==='string'&&/^([01]\d|2[0-3])-([01]\d|2[0-3])$/.test(env.DASHBOARD_SCAN_WINDOW_UTC)?env.DASHBOARD_SCAN_WINDOW_UTC:''};
}
export function nextScanTime(now:number,config:ScanConfig):number {
  const due=now+config.intervalHours*3600000;
  if(!config.windowUtc)return due;
  const [start,end]=config.windowUtc.split('-').map(Number),hour=new Date(due).getUTCHours();
  if(start===end||(start<end?hour>=start&&hour<end:hour>=start||hour<end))return due;
  const next=new Date(due);next.setUTCHours(start!,0,0,0);if(next.getTime()<due)next.setUTCDate(next.getUTCDate()+1);return next.getTime();
}
