import { errorDetails } from './cfErrors';
export interface CatalogSourceRef {id:number;url:string;is_default?:number;name?:string}
export interface CatalogSnapshot<T> {catalog:T|null;lastSuccessAt:number|null;lastAttemptAt:number;etag:string|null;etagUrl:string|null;errorKind:string|null}
export interface CatalogResult<T> extends CatalogSnapshot<T>{state:'ready'|'empty'|'stale'|'unknown'|'error';sourceId:number}
export interface CatalogPort<T> {
 fetch:(url:string,init:RequestInit)=>Promise<Response>;safe:(url:string)=>Promise<void>|void;
 validate:(value:unknown)=>{valid:boolean;errors:string[]};urls:(source:CatalogSourceRef)=>string[];
 get?:(source:CatalogSourceRef)=>Promise<CatalogSnapshot<T>|null>;put?:(source:CatalogSourceRef,snapshot:CatalogSnapshot<T>)=>Promise<void>;
 mark:(source:CatalogSourceRef,snapshot:CatalogSnapshot<T>)=>Promise<void>;
}
const failure=(kind:string)=>Object.assign(new Error(kind),{catalogKind:kind});
/** One deadline and bounded streaming body across the complete redirect chain. */
export async function boundedCatalogFetch(url:string,port:Pick<CatalogPort<unknown>,'safe'|'fetch'>,options:{etag?:string|null;timeoutMs?:number;maxBytes?:number}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??8000),maxBytes=options.maxBytes??5*1024*1024;
 const abort=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(failure('timeout')),{once:true}));
 try{return await Promise.race([(async()=>{let current=url;for(let hop=0;hop<=3;hop++){
  const parsed=new URL(current);if(parsed.username||parsed.password||current.length>2048)throw failure('unsafe_url');
  if(hop>0&&(parsed.protocol!=='https:'||['localhost','127.0.0.1'].includes(parsed.hostname)))throw failure('unsafe_redirect');await port.safe(current);controller.signal.throwIfAborted();
  const response=await port.fetch(current,{redirect:'manual',signal:controller.signal,headers:hop===0&&options.etag?{'If-None-Match':options.etag}:{}});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location||hop===3)throw failure('redirect');current=new URL(location,current).href;continue;}
  if(response.status===304)return {status:304,text:'',etag:response.headers.get('etag'),url:current};
  if(!response.ok){await response.body?.cancel();throw failure(`http_${response.status}`);}
  if(Number(response.headers.get('content-length')||0)>maxBytes){await response.body?.cancel();throw failure('size');}
  const reader=response.body?.getReader();if(!reader)throw failure('empty_body');let length=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();controller.signal.throwIfAborted();if(done)break;length+=value.byteLength;if(length>maxBytes)throw failure('size');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {status:response.status,text:new TextDecoder().decode(bytes),etag:response.headers.get('etag'),url:current};
 }throw failure('redirect');})(),abort]);}finally{clearTimeout(timer);controller.abort();}
}
export async function mapCatalogSources<T,R>(items:T[],run:(item:T)=>Promise<R>,concurrency=3):Promise<R[]>{
 const output:R[]=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(next<items.length){const index=next++;output[index]=await run(items[index]!);}}));return output;
}
export class CatalogReader<T extends {templates:unknown[]}> {
 private entries=new Map<string,CatalogSnapshot<T>>();private flights=new Map<string,Promise<CatalogSnapshot<T>>>();private revisions=new Map<number,number>();
 private running=0;private waiting:Array<()=>void>=[];
 constructor(private port:CatalogPort<T>,private freshMs=300000,private timeoutMs=8000){}
 private key(s:CatalogSourceRef){return `${s.id}:${s.url}`;}
 invalidate(id:number){this.revisions.set(id,(this.revisions.get(id)??0)+1);for(const key of this.entries.keys())if(key.startsWith(`${id}:`))this.entries.delete(key);}
 async seed(source:CatalogSourceRef,catalog:T,etag:string|null=null,etagUrl=source.url){const entry={catalog,etag,etagUrl,lastSuccessAt:Date.now(),lastAttemptAt:Date.now(),errorKind:null};this.remember(this.key(source),entry);await this.port.put?.(source,entry);await this.port.mark(source,entry);}
 private view(source:CatalogSourceRef,s:CatalogSnapshot<T>|null):CatalogResult<T>{const value=s??{catalog:null,lastSuccessAt:null,lastAttemptAt:0,etag:null,etagUrl:null,errorKind:null};return {...value,sourceId:source.id,state:value.catalog?(value.errorKind||Date.now()-(value.lastSuccessAt??0)>=this.freshMs?'stale':value.catalog.templates.length?'ready':'empty'):value.errorKind?'error':'unknown'};}
 async read(source:CatalogSourceRef,options:{force?:boolean;cacheOnly?:boolean;waitUntil?:(work:Promise<unknown>)=>void}={}):Promise<CatalogResult<T>>{
  const key=this.key(source),revision=this.revisions.get(source.id)??0;let saved=this.entries.get(key)??null;
  if(!saved)try{saved=await this.port.get?.(source)??null;}catch{saved={catalog:null,lastSuccessAt:null,lastAttemptAt:Date.now(),etag:null,etagUrl:null,errorKind:'cache'};}
  if(revision!==(this.revisions.get(source.id)??0))return this.view(source,null);
  if(saved&&!this.entries.has(key))this.remember(key,saved);
  if(options.cacheOnly)return this.view(source,saved);
  if(!options.force&&saved?.catalog){if(Date.now()-(saved.lastSuccessAt??0)>=this.freshMs&&Date.now()-saved.lastAttemptAt>5000){const work=this.refresh(source,saved);options.waitUntil?.(work);void work.catch(()=>{});}return this.view(source,saved);}
  if(!options.force&&saved?.errorKind&&Date.now()-saved.lastAttemptAt<5000)return this.view(source,saved);
  return this.view(source,await this.refresh(source,saved));
 }
 private remember(key:string,value:CatalogSnapshot<T>){this.entries.delete(key);this.entries.set(key,value);let bytes=[...this.entries.values()].reduce((n,s)=>n+JSON.stringify(s).length*2,0);while(this.entries.size>100||bytes>16*1024*1024){const oldest=this.entries.keys().next().value!;bytes-=JSON.stringify(this.entries.get(oldest)).length*2;this.entries.delete(oldest);}}
 private refresh(source:CatalogSourceRef,saved:CatalogSnapshot<T>|null):Promise<CatalogSnapshot<T>>{
  const key=this.key(source),revision=this.revisions.get(source.id)??0,flightKey=`${revision}:${key}`;const prior=this.flights.get(flightKey);if(prior)return prior;
  const work=(async()=>{
   if(this.running>=3)await new Promise<void>(resolve=>this.waiting.push(resolve));else this.running++;
   try{let result:CatalogSnapshot<T>|undefined,lastError='fetch';
    for(const url of this.port.urls(source))try{
     const response=await boundedCatalogFetch(url,this.port,{timeoutMs:this.timeoutMs,etag:saved?.catalog&&saved.etagUrl===url?saved.etag:null});
     let catalog:T;if(response.status===304){if(!saved?.catalog)throw failure('unusable_304');catalog=saved.catalog;}else{
      let value:unknown;try{value=JSON.parse(response.text);}catch{throw failure('json');}const validation=this.port.validate(value);if(!validation.valid)throw failure('schema');catalog=value as T;
     }
     result={catalog,lastSuccessAt:Date.now(),lastAttemptAt:Date.now(),etag:response.etag??(response.status===304?saved?.etag:null)??null,etagUrl:response.url,errorKind:null};break;
    }catch(error){lastError=(error as {catalogKind?:string}).catalogKind??errorDetails(error).kind;}
    result??={catalog:saved?.catalog??null,lastSuccessAt:saved?.lastSuccessAt??null,lastAttemptAt:Date.now(),etag:saved?.etag??null,etagUrl:saved?.etagUrl??null,errorKind:lastError};
    if((this.revisions.get(source.id)??0)===revision){try{await this.port.put?.(source,result);await this.port.mark(source,result);}catch{result={...result,errorKind:result.errorKind??'persistence'};}this.remember(key,result);}return result;
   }finally{const next=this.waiting.shift();if(next)next();else this.running--;}
  })();this.flights.set(flightKey,work);void work.finally(()=>{if(this.flights.get(flightKey)===work)this.flights.delete(flightKey);}).catch(()=>{});return work;
 }
}
