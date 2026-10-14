import { ZoneDirectory } from './zoneDirectory';
import { recordPerformance } from './performanceMetrics';
export const dnsDirectory = new ZoneDirectory(recordPerformance);

import { inventorySink, usageSink } from './dashboardCollector';
import { localSql } from './localSql';
dnsDirectory.inventory=inventorySink(localSql);
dnsDirectory.usage=usageSink(localSql);
