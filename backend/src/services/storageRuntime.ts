import {D1Resources} from './d1Resources';
import {StorageResources} from './storageResources';
import {dnsDirectory} from './dnsDirectory';
import {recordPerformance} from './performanceMetrics';
export const storageResources=new StorageResources(dnsDirectory,metric=>recordPerformance({scope:'storage_performance',...metric}));

export const d1Resources=new D1Resources(storageResources.cache);
