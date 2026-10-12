import { ZoneDirectory } from './zoneDirectory';
import { recordPerformance } from './performanceMetrics';
export const dnsDirectory = new ZoneDirectory(recordPerformance);
