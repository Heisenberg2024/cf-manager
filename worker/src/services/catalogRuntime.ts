import { CatalogReader, type CatalogSnapshot } from './catalogReader';
import { validateCatalog, type Catalog } from './catalogValidator';
import { assertUrlSafe } from './ssrfGuard';
import { getCatalogSourceById, updateCatalogSource } from '../db/models';
import type { Env } from '../types';
export const CATALOG_URLS=['https://cf-store.surge.sh/catalog.json','https://cdn.jsdelivr.net/gh/hefy2027/cf-store@main/catalog.json','https://raw.githubusercontent.com/hefy2027/cf-store/main/catalog.json'];
const readers=new WeakMap<D1Database,CatalogReader<Catalog>>();
export function getCatalogReader(env:Env){let reader=readers.get(env.DB);if(!reader){reader=new CatalogReader<Catalog>({
 fetch:(url,init)=>fetch(url,init),safe:url=>assertUrlSafe(url,env),validate:validateCatalog,urls:s=>s.is_default?CATALOG_URLS:[s.url],
 async get(source){if(!env.KV)return null;const raw=await env.KV.get(`catalog:v210:${source.id}:${encodeURIComponent(source.url)}`);if(!raw)return null;try{const snapshot=JSON.parse(raw) as CatalogSnapshot<Catalog>;return Number.isFinite(snapshot.lastAttemptAt)&&(snapshot.catalog===null||validateCatalog(snapshot.catalog).valid)?snapshot:null;}catch{return null;}},
 async put(source,snapshot){const current=await getCatalogSourceById(env.DB,source.id);if(current?.url===source.url&&env.KV)await env.KV.put(`catalog:v210:${source.id}:${encodeURIComponent(source.url)}`,JSON.stringify(snapshot),{expirationTtl:7*86400});},
 async mark(source,snapshot){const current=await getCatalogSourceById(env.DB,source.id);if(current?.url!==source.url)return;await updateCatalogSource(env.DB,source.id,{last_status:snapshot.errorKind?'error':'ok',last_error:snapshot.errorKind,last_synced:snapshot.lastSuccessAt?new Date(snapshot.lastSuccessAt).toISOString():null,etag:snapshot.etag});},
 });readers.set(env.DB,reader);}return reader;}
