import { ZoneSettingsRuntime } from './zoneSettings';
import { dnsDirectory } from './dnsDirectory';
import { recordPerformance } from './performanceMetrics';
export const zoneSettingsRuntime = new ZoneSettingsRuntime(dnsDirectory,recordPerformance);
