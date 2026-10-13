import { ZoneSettingsRuntime } from './zoneSettings';
import { getDnsDirectory } from './dnsDirectory';
const runtimes = new WeakMap<D1Database,ZoneSettingsRuntime>();
export function getZoneSettingsRuntime(db:D1Database) {
  let runtime=runtimes.get(db);
  if(!runtime){runtime=new ZoneSettingsRuntime(getDnsDirectory(db),metric=>console.info(JSON.stringify({scope:'dns_performance',...metric})));runtimes.set(db,runtime);}
  return runtime;
}
