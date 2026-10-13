import { WorkerResources } from './workerResources';
import { dnsDirectory } from './dnsDirectory';
import { recordPerformance } from './performanceMetrics';
export const workerResources = new WorkerResources(dnsDirectory, metric => recordPerformance({ ...metric, scope: 'workers_performance' }));
