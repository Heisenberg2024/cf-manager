import { ZoneDirectory } from './zoneDirectory';
import { inventorySink, usageSink } from './dashboardCollector';
import { localSql } from './localSql';
const directories = new WeakMap<D1Database, ZoneDirectory>();
export function getDnsDirectory(db: D1Database): ZoneDirectory {
  let directory = directories.get(db);
  if (!directory) { directory = new ZoneDirectory(metric => console.info(JSON.stringify({ scope: 'dns_performance', ...metric }))); directory.inventory=inventorySink(localSql(db));directory.usage=usageSink(localSql(db)); directories.set(db, directory); }
  return directory;
}
