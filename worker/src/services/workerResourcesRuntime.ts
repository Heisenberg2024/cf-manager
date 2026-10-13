import { WorkerResources } from './workerResources';
import { getDnsDirectory } from './dnsDirectory';
const resources = new WeakMap<D1Database, WorkerResources>();
export function getWorkerResources(db: D1Database) {
  let value = resources.get(db);
  if (!value) { value = new WorkerResources(getDnsDirectory(db), metric => console.info(JSON.stringify({ scope: 'workers_performance', ...metric }))); resources.set(db, value); }
  return value;
}
