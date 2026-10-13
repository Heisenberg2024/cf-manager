import {D1Resources} from './d1Resources';
import {StorageResources} from './storageResources';
import {getDnsDirectory} from './dnsDirectory';
const runtimes=new WeakMap<D1Database,StorageResources>();
export function getStorageResources(db:D1Database){let value=runtimes.get(db);if(!value){value=new StorageResources(getDnsDirectory(db),metric=>console.info(JSON.stringify({scope:'storage_performance',...metric})));runtimes.set(db,value);}return value;}

const databases=new WeakMap<D1Database,D1Resources>();
export function getD1Resources(db:D1Database){let value=databases.get(db);if(!value){value=new D1Resources(getStorageResources(db).cache);databases.set(db,value);}return value;}
