import type {CfRequest} from './accountDiscovery';
import type {DnsBinding} from './zoneDirectory';
import type {BoundReadCache} from './resourceCache';
import {requireStorageBinding} from './storageResources';
import {authorizeSql,boundQueryResult,quoteIdentifier} from './d1SqlPolicy';
import {errorDetails} from './cfErrors';
const base=(account:DnsBinding)=>`/accounts/${encodeURIComponent(account.account_id!)}/d1/database`;
const path=(account:DnsBinding,db:string)=>`${base(account)}/${encodeURIComponent(db)}`;
async function query(request:CfRequest,url:string,sql:string,params:unknown[]=[],signal?:AbortSignal){return boundQueryResult(await request(`${url}/query`,{method:'POST',body:JSON.stringify({sql,params}),signal,retry:false,maxResponseBytes:4*1024*1024}));}
type Options={refresh?:boolean;signal?:AbortSignal};
export class D1Resources {
 constructor(private cache:Pick<BoundReadCache,'read'|'invalidate'|'uncached'>){}
 async databases(account:DnsBinding,request:CfRequest,options:Options={}){
  requireStorageBinding(account);const {value}=await this.cache.read(account,'d1:list',async signal=>{
   const rows:any[]=[];for(let page=1;page<=1000;page++){const data=await request(`${base(account)}?page=${page}&per_page=100`,{signal});if(!Array.isArray(data.result))throw Error('Invalid D1 database list');rows.push(...data.result);const info=data.result_info;if((info?.total_pages!==undefined&&page>=info.total_pages)||(info?.total_count!==undefined&&rows.length>=info.total_count)||(!info?.total_pages&&info?.total_count===undefined&&data.result.length<100))return rows;}throw Error('D1 database pagination limit exceeded');
  },options);return value;
 }
 async tables(account:DnsBinding,request:CfRequest,db:string,options:Options={}){
  requireStorageBinding(account);const {value}=await this.cache.read(account,`d1:${db}/tables`,async signal=>{const result=await query(request,path(account,db),"SELECT name,type FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",[],signal);if(result.meta.result_truncated)throw Object.assign(Error('Table metadata exceeds 1000 entries; use a filtered custom SQL query'),{statusCode:400});return result.results;},options);return value;
 }
 async schema(account:DnsBinding,request:CfRequest,db:string,table:string,options:Options={}){
  requireStorageBinding(account);const {value}=await this.cache.read(account,`d1:${db}/schema:${JSON.stringify(table)}`,async signal=>(await query(request,path(account,db),`PRAGMA table_info(${quoteIdentifier(table)})`,[],signal)).results,options);return value;
 }
 invalidate(accountId?:number,cfAccountId?:string|null,db?:string){this.cache.invalidate(accountId,cfAccountId,db?`d1:${db}`:undefined);if(db)this.cache.invalidate(accountId,cfAccountId,'d1:list');}
 async execute(account:DnsBinding,request:CfRequest,db:string,body:{sql:unknown;params?:unknown;allowWrite?:unknown},demo=false,signal?:AbortSignal){
  requireStorageBinding(account);const policy=authorizeSql(body.sql,body.allowWrite,demo),params=body.params ?? [];
  if(!Array.isArray(params)||params.length>100||params.some(value=>value!==null&&!['string','number','boolean'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value))))throw Object.assign(Error('D1 parameters must be at most 100 scalar values'),{statusCode:400,code:'VALIDATION_ERROR'});
  if(new TextEncoder().encode(JSON.stringify(params)).length>2*1024*1024)throw Object.assign(Error('D1 parameters exceed 2 MiB'),{statusCode:400,code:'VALIDATION_ERROR'});
  if(!policy.readOnly){
   const detail=(await request(path(account,db),{retry:false})).result as {uuid?:string;id?:string};
   if(detail?.uuid!==db&&detail?.id!==db)throw Object.assign(Error('Database does not belong to the selected Account'),{statusCode:409,code:'D1_OWNERSHIP_MISMATCH'});
  }
  try{return {result:policy.readOnly?await this.cache.uncached(account,readSignal=>query(request,path(account,db),body.sql as string,params,readSignal),signal):await query(request,path(account,db),body.sql as string,params),policy};}
  catch(error){const detail=errorDetails(error),uncertain=!policy.readOnly&&(detail.statusCode>=500||detail.kind==='network'||detail.kind==='timeout');
   throw Object.assign(Error((error as {code?:string}).code==='D1_RESULT_LIMIT'?'D1 result exceeds 4 MiB; add LIMIT. A write result is not confirmed.':uncertain?'D1 execution result unknown; inspect the database before retrying':`D1 query failed (HTTP ${detail.statusCode}); check permissions and SQL`),{statusCode:detail.statusCode,code:uncertain?'D1_OUTCOME_UNCERTAIN':'D1_QUERY_FAILED',operation:policy.operation});
  }finally{if(!policy.readOnly)this.invalidate(account.id,account.account_id,db);}
 }
 async tablePage(account:DnsBinding,request:CfRequest,db:string,table:string,options:{limit?:unknown;cursor?:unknown;signal?:AbortSignal}={}){
  requireStorageBinding(account);const limit=Number(options.limit ?? 100);if(!Number.isInteger(limit)||limit<1||limit>200)throw Object.assign(Error('Table page size must be 1–200'),{statusCode:400});
  const schema=await this.schema(account,request,db,table,{signal:options.signal});
  const {value:tableRows}=await this.cache.read(account,`d1:${db}/table:${JSON.stringify(table)}`,async signal=>{
   const rows=(await query(request,path(account,db),`PRAGMA table_list(${quoteIdentifier(table)})`,[],signal)).results;
   const version=(await query(request,path(account,db),'PRAGMA schema_version',[],signal)).results[0]?.schema_version;
   if(!Number.isSafeInteger(version))throw Object.assign(Error('Schema version unavailable for stable paging'),{statusCode:400});return rows.map((row:any)=>({...row,schemaVersion:version}));
  },{signal:options.signal});
  const tableInfo=tableRows.find((row:any)=>row.name===table&&row.schema==='main'&&row.type==='table');
  if(!schema.length||!tableInfo)throw Object.assign(Error('Table unavailable for paging'),{statusCode:400});
  const names=new Set(schema.map((column:any)=>String(column.name).toLowerCase()));let keys:string[];
  if(tableInfo.wr===0){const rowid=['rowid','_rowid_','oid'].find(name=>!names.has(name));if(!rowid)throw Object.assign(Error('Hidden rowid is shadowed; use custom SQL with an explicit stable sort'),{statusCode:400});keys=[rowid];}
  else if(tableInfo.wr===1){const pk=schema.filter((column:any)=>column.pk>0).sort((a:any,b:any)=>a.pk-b.pk);if(!pk.length||pk.some((column:any)=>!/^(?:INT(?:EGER)?|TEXT)$/i.test(column.type)))throw Object.assign(Error('This primary key type cannot safely use keyset pagination; use custom SQL'),{statusCode:400});keys=pk.map((column:any)=>column.name);}
  else throw Object.assign(Error('Cannot establish stable table ordering'),{statusCode:400});
  const schemaHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([schema,tableInfo.wr,tableInfo.schemaVersion])))),byte=>byte.toString(16).padStart(2,'0')).join('');
  const identity=JSON.stringify([account.id,account.credential_id,account.account_id,db,table,schemaHash,keys]);let values:string[]=[];
  if(options.cursor!==undefined&&options.cursor!==''){
   try{if(typeof options.cursor!=='string'||options.cursor.length>32000)throw Error();const cursor=JSON.parse(options.cursor);if(cursor.identity!==identity||!Array.isArray(cursor.values)||cursor.values.length!==keys.length||cursor.values.some((v:unknown)=>typeof v!=='string'))throw Error();values=cursor.values;}catch{throw Object.assign(Error('Cursor target/schema changed; restart table browsing'),{statusCode:409,code:'D1_CURSOR_MISMATCH'});}
  }
  const aliases=keys.map((_,i)=>{let alias=`__cfm_cursor_${i}`;while(names.has(alias.toLowerCase()))alias+='_';return alias;});
  const selected=keys.map((key,i)=>`CAST(${quoteIdentifier(key)} AS TEXT) AS ${quoteIdentifier(aliases[i]!)}`).join(',');
  const order=keys.map(quoteIdentifier).join(','),where=values.length?` WHERE (${order}) > (${keys.map(()=>'?').join(',')})`:'';
  const result=await this.cache.uncached(account,signal=>query(request,path(account,db),`SELECT *,${selected} FROM ${quoteIdentifier(table)}${where} ORDER BY ${order} LIMIT ?`,[...values,limit+1],signal),options.signal);
  const more=result.results.length>limit,raw=result.results.slice(0,limit),last=raw.at(-1);
  const cursor=more&&last?JSON.stringify({identity,values:aliases.map(alias=>last[alias])}):undefined;
  if(cursor&&cursor.length>32000)throw Object.assign(Error('Primary key cursor exceeds 32 KiB; use custom SQL with explicit pagination'),{statusCode:400});
  const rows=raw.map((row:any)=>{const copy={...row};for(const alias of aliases)delete copy[alias];return copy;});
  return {...result,results:rows,meta:{...result.meta,paging:'keyset',has_more:more,cursor,limit,order:keys,snapshot:false}};
 }
}
