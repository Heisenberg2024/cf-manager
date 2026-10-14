// Optional independently deployed Scheduled Worker. Pages itself does not support Cron Triggers.
import {dashboardScan,runDashboardScanBatch} from './src/services/dashboardScanRuntime';
import type {Env} from './src/types';
export default {
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){
    ctx.waitUntil((async()=>{await dashboardScan(env).schedule();await runDashboardScanBatch(env);})());
  },
} satisfies ExportedHandler<Env>;
