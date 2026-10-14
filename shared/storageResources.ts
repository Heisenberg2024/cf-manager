import type {CfRequest} from './accountDiscovery';
import type {DnsBinding} from './zoneDirectory';
import type {ReadMetric,ReadScheduler} from './readScheduler';
import {BoundReadCache} from './resourceCache';
export interface StoragePage {items:any[];prefixes:string[];cursor?:string;is_truncated:boolean}
export interface PageOptions {prefix?:string;delimiter?:string;cursor?:string;limit?:number;refresh?:boolean;background?:boolean;signal?:AbortSignal}
const invalid=(message:string)=>Object.assign(new Error(message),{statusCode:502,code:'CF_INVALID_PAGINATION'});
export function requireStorageBinding<T extends DnsBinding>(account:T):T {
 if(!account.account_id||account.is_active===0||account.is_enabled===0||!account.enabled_features.split(',').includes('storage'))throw Object.assign(new Error('Account unavailable or Storage feature disabled'),{statusCode:409});return account;
}
export function pageOptions(query:Record<string,unknown>):PageOptions {
 const limit=Number(query.limit ?? 100);
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw Object.assign(new Error('Invalid storage page limit (1–1000)'),{statusCode:400});
 for(const key of ['prefix','cursor','delimiter'])if(query[key]!==undefined&&(typeof query[key]!=='string'||String(query[key]).length>4096))throw Object.assign(new Error(`Invalid ${key}`),{statusCode:400});
 if(query.delimiter!==undefined&&String(query.delimiter).length>1)throw Object.assign(new Error('Delimiter must be a single character'),{statusCode:400});
 return {limit,prefix:query.prefix as string|undefined,cursor:query.cursor as string|undefined,delimiter:query.delimiter as string|undefined,refresh:query.refresh===true||query.refresh==='true'};
}
export function normalizeStoragePage(data:any,kind:'kv'|'objects'|'buckets',previous=''):StoragePage {
 const raw=data.result,info=data.result_info || {};
 const items=kind==='kv'?raw:kind==='buckets'?(Array.isArray(raw)?raw:raw?.buckets):(Array.isArray(raw)?raw:raw?.objects);
 if(!Array.isArray(items))throw invalid('Unexpected storage list response');
 const cursor=info.cursor ?? (Array.isArray(raw)?undefined:raw?.cursor);
 const truncated=info.is_truncated ?? (Array.isArray(raw)?undefined:raw?.is_truncated ?? raw?.truncated);
 if(cursor!==undefined&&cursor!==null&&typeof cursor!=='string')throw invalid('Invalid pagination cursor');
 if(truncated!==undefined&&typeof truncated!=='boolean')throw invalid('Invalid truncation flag');
 const more=truncated ?? !!cursor;
 if(more&&(!cursor||cursor===previous))throw invalid('Truncated page has no advancing cursor');
 const prefixes=kind==='objects'?(info.delimited ?? raw?.delimited_prefixes ?? raw?.delimited ?? []):[];
 if(!Array.isArray(prefixes)||prefixes.some(p=>typeof p!=='string'))throw invalid('Invalid directory prefixes');
 const identity=kind==='kv'?'name':kind==='objects'?'key':'name';
 if(items.some(row=>!row||typeof row[identity]!=='string'))throw invalid('Invalid storage resource identity');
 return {items,prefixes:[...new Set(prefixes)],cursor:more?cursor:undefined,is_truncated:more};
}
export class StorageResources {
 readonly cache:BoundReadCache;
 constructor(directory:{scheduler:Pick<ReadScheduler,'run'>},metric:(event:ReadMetric)=>void=()=>{}){this.cache=new BoundReadCache(directory,metric,30000,30000,300,8*1024*1024);}
 async page(account:DnsBinding,request:CfRequest,kind:'kv'|'objects'|'buckets',resource:string,options:PageOptions={}){
  requireStorageBinding(account);options={...pageOptions(options as Record<string,unknown>),signal:options.signal,background:options.background};
  const base=`/accounts/${encodeURIComponent(account.account_id!)}`;
  const path=kind==='kv'?`${base}/storage/kv/namespaces/${encodeURIComponent(resource)}/keys`:kind==='objects'?`${base}/r2/buckets/${encodeURIComponent(resource)}/objects`:`${base}/r2/buckets`;
  const query=new URLSearchParams({[kind==='kv'?'limit':'per_page']:String(options.limit)});
  if(options.prefix)query.set('prefix',options.prefix);if(options.cursor)query.set('cursor',options.cursor);if(kind==='objects')query.set('delimiter',options.delimiter ?? '/');
  const scope=`${kind}:${encodeURIComponent(resource)}/${JSON.stringify([options.prefix||'',options.delimiter ?? '/',options.cursor||'',options.limit])}`;
  const {value,cache}=await this.cache.read(account,scope,async signal=>normalizeStoragePage(await request(`${path}?${query}`,{signal}),kind,options.cursor),options);
  return {...value,meta:cache};
 }
 async allBuckets(account:DnsBinding,request:CfRequest,options:PageOptions={}) {
  const buckets=new Map<string,any>();let cursor:string|undefined;const seen=new Set<string>();
  for(let page=0;page<1000;page++){const result=await this.page(account,request,'buckets','',{...options,cursor,limit:1000});for(const row of result.items)buckets.set(row.name,row);if(!result.is_truncated)return [...buckets.values()];if(seen.has(result.cursor!))throw invalid('Repeated bucket cursor');seen.add(result.cursor!);cursor=result.cursor;}
  throw invalid('Bucket pagination limit exceeded');
 }
 invalidate(accountId?:number,cfAccountId?:string|null,kind?:'kv'|'objects'|'buckets',resource=''){this.cache.invalidate(accountId,cfAccountId,kind?`${kind}:${encodeURIComponent(resource)}`:undefined);}
}
