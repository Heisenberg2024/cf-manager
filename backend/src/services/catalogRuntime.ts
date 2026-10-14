import { CatalogReader, type CatalogSourceRef } from './catalogReader';
import { validateCatalog, type Catalog } from './catalogValidator';
import { assertUrlSafe } from './ssrfGuard';
import { getCatalogSourceById, updateCatalogSource } from '../models/catalogSource';
export const CATALOG_URLS=['https://cf-store.surge.sh/catalog.json','https://cdn.jsdelivr.net/gh/hefy2027/cf-store@main/catalog.json','https://raw.githubusercontent.com/hefy2027/cf-store/main/catalog.json'];
export const catalogReader=new CatalogReader<Catalog>({
 fetch:(url,init)=>fetch(url,init),safe:async url=>{const u=new URL(url);if(['localhost','127.0.0.1'].includes(u.hostname)&&u.protocol!=='http:')throw Error('Unsafe local catalog URL');await assertUrlSafe(url);},
 validate:validateCatalog,urls:s=>s.is_default?CATALOG_URLS:[s.url],
 async mark(source:CatalogSourceRef,snapshot){const current=getCatalogSourceById(source.id);if(current?.url!==source.url)return;updateCatalogSource(source.id,{last_status:snapshot.errorKind?'error':'ok',last_error:snapshot.errorKind,last_synced:snapshot.lastSuccessAt?new Date(snapshot.lastSuccessAt).toISOString():null,etag:snapshot.etag});},
});
