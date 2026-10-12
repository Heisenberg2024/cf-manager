import { ZoneDirectory } from './zoneDirectory';
const directories = new WeakMap<D1Database, ZoneDirectory>();
export function getDnsDirectory(db: D1Database): ZoneDirectory {
  let directory = directories.get(db);
  if (!directory) { directory = new ZoneDirectory(metric => console.info(JSON.stringify({ scope: 'dns_performance', ...metric }))); directories.set(db, directory); }
  return directory;
}
