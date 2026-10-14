import {DashboardScan} from './dashboardScan';
import {scanConfig} from './dashboardScanTypes';
import {dashboardRuntime} from './dashboardRuntime';
import {config} from '../config';
import {appLogger} from './logger';
import {errorDetails} from './cfErrors';
export const dashboardScan=new DashboardScan(dashboardRuntime,scanConfig(config.dashboardScan));
/** A managed executor: tracks the running batch, stops claims on shutdown and lets leases recover crashes. */
export class DashboardScanExecutor {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending:Promise<void>|undefined;
  private stopping=false;
  private controller=new AbortController();
  private nextScheduleCheck=0;
  private firstCheck=true;
  constructor(private scan:DashboardScan,private onError:(kind:string)=>void=kind=>appLogger.warn(`[Dashboard scan] ${kind}`)){}
  start(){this.controller=new AbortController();this.stopping=false;this.timer=setTimeout(()=>this.tick(),this.scan.config.startupDelayMs);}
  wake(){if(this.stopping||this.pending)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>this.tick(),0);}
  private tick(){
    if(this.stopping||this.pending)return;
    this.pending=this.work().catch(e=>this.onError(errorDetails(e).kind)).finally(()=>{this.pending=undefined;if(!this.stopping)this.timer=setTimeout(()=>this.tick(),1500);});
  }
  private async work(){
    const now=Date.now();
    if(this.scan.config.autoCollect){
      if(now>=this.nextScheduleCheck){this.nextScheduleCheck=now+60000;if(this.firstCheck){this.firstCheck=false;await this.scan.start({reason:'startup'});}else await this.scan.schedule();}
      else if((await this.scan.runtime.db.all('SELECT account_id FROM dashboard_scan_dirty LIMIT 1')).length)await this.scan.start({reason:'incremental'});
    }
    if(!this.stopping)await this.scan.runBatch({signal:this.controller.signal});
  }
  async stop(){this.stopping=true;if(this.timer)clearTimeout(this.timer);this.controller.abort();await this.pending;}
}
export const dashboardScanExecutor=new DashboardScanExecutor(dashboardScan);
