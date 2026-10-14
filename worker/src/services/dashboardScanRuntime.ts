import {DashboardScan} from './dashboardScan';
import {scanConfig} from './dashboardScanTypes';
import {dashboardRuntime} from './dashboardRuntime';
import type {Env} from '../types';
export function dashboardScan(env:Env){return new DashboardScan(dashboardRuntime(env),scanConfig(env as unknown as Record<string,unknown>),'request_batches');}
/** One resource, <=35 external requests, <=20s wall time. No recursion and no isolate-owned timer. */
export async function runDashboardScanBatch(env:Env,schedule=false){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Worker batch deadline','TimeoutError')),20000);try{const scan=dashboardScan(env);if(schedule)await scan.schedule();return await scan.runBatch({maxItems:1,maxRequests:35,durationMs:20000,signal:controller.signal});}finally{clearTimeout(timer);}}
