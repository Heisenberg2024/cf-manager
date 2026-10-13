import type {TestHarness} from './dnsBatch.contract';
import type * as ZoneSettings from '../zoneSettings';
import type {BoundReadCache} from '../resourceCache';
import type {ZoneDirectory} from '../zoneDirectory';
import type {CfRequest} from '../accountDiscovery';
type Implementation={readZoneSettings:typeof ZoneSettings.readZoneSettings;writeZoneSettings:typeof ZoneSettings.writeZoneSettings;ZoneSettingsRuntime:new(...args:ConstructorParameters<typeof ZoneSettings.ZoneSettingsRuntime>)=>Pick<ZoneSettings.ZoneSettingsRuntime,'read'|'write'|'invalidate'>;BoundReadCache:new(...args:ConstructorParameters<typeof BoundReadCache>)=>Pick<BoundReadCache,'read'|'invalidate'|'size'|'bytes'>;ZoneDirectory:new(...args:ConstructorParameters<typeof ZoneDirectory>)=>{scheduler:Pick<import('../readScheduler').ReadScheduler,'run'>}};
const account={id:1,name:'fixture',credential_id:10,account_id:'cf-a',api_token:'synthetic',is_active:1,enabled_features:'dns'};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
export function zoneSettingsContract(label:string,implementation:Implementation,harness:TestHarness){
 const {describe,it,expect}=harness;
 const {readZoneSettings,writeZoneSettings,ZoneSettingsRuntime,BoundReadCache,ZoneDirectory}=implementation;
 function fixture(){
  const values:Record<string,unknown>={ssl:'full',cache_level:'aggressive',http2:'on'};const calls:Array<{path:string;method:string}>=[];
  const request:CfRequest=async(path,init)=>{calls.push({path,method:init?.method || 'GET'});const key=path.split('/').at(-1)!;
   if(init?.method==='PATCH')values[key]=JSON.parse(String(init.body)).value;
   return {result:key==='settings'?Object.entries(values).map(([id,value])=>({id,value,editable:true})):{id:key,value:values[key],editable:true}};
  };return {values,calls,request};
 }
 describe(`${label} Zone settings v2.8 contracts`,()=>{
  it('shares cold reads and cached tab revisits, and keeps identities distinct',async()=>{
   const f=fixture(),runtime=new ZoneSettingsRuntime(new ZoneDirectory());
   await Promise.all(Array.from({length:10},()=>runtime.read(account,f.request,'a')));expect(f.calls).toHaveLength(1);
   await runtime.read(account,f.request,'a');expect(f.calls).toHaveLength(1);
   await runtime.read({...account,id:2,credential_id:20},f.request,'a');await runtime.read(account,f.request,'b');await runtime.read({...account,api_token:'changed'},f.request,'a');expect(f.calls).toHaveLength(4);
  });
  it('reports real field progress without retrying after a stream consumer disconnects',async()=>{const f=fixture();const events:any[]=[];const result=await writeZoneSettings(f.request,'a',{ssl:'strict'},{ssl:'full'},event=>{events.push(event);if(event.stage==='saving')throw Error('stream closed');});expect(events.map(event=>event.stage)).toEqual(['checking','saving','confirming','done']);expect(events.at(-1)).toMatchObject({completed:1,patchCount:1,status:'updated'});expect(result.updated).toEqual(['ssl']);expect(f.calls.filter(call=>call.method==='PATCH')).toHaveLength(1);});
  it('performs no upstream calls for empty or baseline-identical saves',async()=>{
   const f=fixture();expect((await writeZoneSettings(f.request,'a',{})).patchCount).toBe(0);
   const result=await writeZoneSettings(f.request,'a',{ssl:'full'},{ssl:'full'});expect(result.fields.ssl.status).toBe('unchanged');expect(f.calls).toHaveLength(0);
  });
  it('reads and confirms only changed fields, with ordered per-field receipts',async()=>{
   const f=fixture();const result=await writeZoneSettings(f.request,'a',{ssl:'strict',cache_level:'basic'},{ssl:'full',cache_level:'aggressive'});
   expect(result.patchCount).toBe(2);expect(result.updated).toEqual(['ssl','cache_level']);expect(f.calls).toHaveLength(6);expect(f.calls.some(c=>c.path.endsWith('/settings'))).toBe(false);
  });
  it('stops all writes on a dirty baseline conflict and returns actual remote values',async()=>{
   const f=fixture();f.values.ssl='flexible';const result=await writeZoneSettings(f.request,'a',{ssl:'strict',cache_level:'basic'},{ssl:'full',cache_level:'aggressive'});
   expect(result.patchCount).toBe(0);expect(result.settings.ssl).toBe('flexible');expect(result.fields.ssl.status).toBe('conflict');expect(result.conflictDetection).toBe('non-atomic');
  });
  it('returns partial successes beside unavailable, forbidden and rate-limited fields',async()=>{
   const f=fixture();const request:CfRequest=async(path,init)=>{if(path.endsWith('/cache_level'))throw Object.assign(Error('HTTP 403 denied'),{statusCode:403});if(path.endsWith('/http2')&&init?.method)throw Object.assign(Error('HTTP 429'),{statusCode:429});return f.request(path,init);};
   const result=await writeZoneSettings(request,'a',{ssl:'strict',cache_level:'basic',http2:'off'});
   expect(result.updated).toEqual(['ssl']);expect(result.fields.cache_level.status).toBe('unavailable');expect(result.fields.http2.status).toBe('failed');
  });
  it('never repeats an uncertain PATCH and can recover success through a read',async()=>{
   const f=fixture();let patches=0;const request:CfRequest=async(path,init)=>{if(init?.method){patches++;throw new DOMException('timeout','TimeoutError');}return f.request(path,init);};
   const uncertain=await writeZoneSettings(request,'a',{ssl:'strict'});expect(uncertain.fields.ssl.status).toBe('uncertain');expect(patches).toBe(1);
   const recovered=await writeZoneSettings(async(path,init)=>{if(init?.method){f.values.ssl='strict';throw Object.assign(Error('5xx'),{statusCode:503});}return f.request(path,init);},'a',{ssl:'strict'});expect(recovered.updated).toEqual(['ssl']);
  });
  it('keeps confirmation failure unconfirmed instead of claiming success',async()=>{
   const f=fixture();let confirmation=false;const result=await writeZoneSettings(async(path,init)=>{if(confirmation)throw Error('network offline');const value=await f.request(path,init);if(init?.method)confirmation=true;return value;},'a',{ssl:'strict'});
   expect(result.fields.ssl.status).toBe('uncertain');expect(result.updated).toHaveLength(0);
  });
  it('falls back only on unsupported legacy API and bounds individual concurrency',async()=>{
   const f=fixture();let active=0,maximum=0,bulk=0;const request:CfRequest=async(path,init)=>{if(path.endsWith('/settings')){bulk++;throw Object.assign(Error('gone'),{statusCode:410});}active++;maximum=Math.max(active,maximum);await Promise.resolve();active--;return f.request(path,init);};
   const settings=await readZoneSettings(request,'a',{keys:['ssl','http2']});expect(settings.__source).toBe('individual');expect(maximum).toBe(1);expect(bulk).toBe(1);
   const runtime=new ZoneSettingsRuntime(new ZoneDirectory());await runtime.read(account,request,'a');await runtime.read(account,request,'a',{refresh:true});expect(bulk).toBe(2);
  });
  it('does not infer default values or edit permission from absent/error fields',async()=>{
   const value=await readZoneSettings(async(path)=>{if(path.endsWith('/settings'))throw Object.assign(Error('gone'),{statusCode:404});if(path.endsWith('/ssl'))return {result:{id:'ssl',value:'full'}};throw Object.assign(Error('Forbidden'),{statusCode:403});},'a',{keys:['ssl','http2']});
   expect(value.ssl).toBe('full');expect(value.__meta.ssl.editable).toBe(false);expect(Object.hasOwn(value,'http2')).toBe(false);expect(value.__meta.http2.state).toBe('unavailable');
   await expect(readZoneSettings(async()=>{throw Object.assign(Error('Forbidden'),{statusCode:403});},'a')).rejects.toThrow('Forbidden');
   await expect(readZoneSettings(async(path)=>path.endsWith('/settings')?{result:[]}:{result:{id:'ssl'}},'a',{keys:['ssl']})).rejects.toThrow('No Zone settings');
  });
  it('retains stale snapshots with refresh errors and clears all on reset',async()=>{
   const cache=new BoundReadCache(new ZoneDirectory(),undefined,0,180000);let fail=false;const load=async()=>{if(fail)throw Error('offline');return {ssl:'full'};};await cache.read(account,'zone:a',load);fail=true;
   let pending:Promise<unknown>|undefined;const stale=await cache.read(account,'zone:a',load,{waitUntil:p=>{pending=p;}});expect(stale.value.ssl).toBe('full');await pending;
   expect((await cache.read(account,'zone:a',load)).cache.error).toContain('offline');cache.invalidate();expect(cache.size).toBe(0);
  });
  it('invalidates aliases and fences late fills without evicting unrelated Zones',async()=>{
   const cache=new BoundReadCache(new ZoneDirectory());await cache.read(account,'zone:b',async()=>({ssl:'full'}));await cache.read({...account,id:2},'zone:a',async()=>({ssl:'full'}));
   const slow=deferred<{ssl:string}>(),started=deferred<void>();const pending=cache.read(account,'zone:a',()=>{started.resolve();return slow.promise;});await started.promise;expect(cache.size).toBe(2);cache.invalidate(1,'cf-a','zone:a');slow.resolve({ssl:'strict'});await pending;expect(cache.size).toBe(1);
   let reads=0;const load=async()=>{reads++;return {ssl:'flexible'};};await cache.read(account,'zone:a',load);expect(reads).toBe(1);
  });
  it('respects entry and byte budgets and clones display snapshots',async()=>{
   const cache=new BoundReadCache(new ZoneDirectory(),undefined,30000,180000,2,2000);const load=async()=>({ssl:'full'});
   const first=await cache.read(account,'zone:a',load);first.value.ssl='off';expect((await cache.read(account,'zone:a',load)).value.ssl).toBe('full');
   for(const zone of ['b','c','d'])await cache.read(account,`zone:${zone}`,load);expect(cache.size).toBe(2);await cache.read(account,'large',async()=>({value:'x'.repeat(2000)}));expect(cache.bytes<=2000).toBe(true);
  });
  it('blocks concurrent writes to the same real Zone across local aliases',async()=>{
   const f=fixture(),slow=deferred<any>(),runtime=new ZoneSettingsRuntime(new ZoneDirectory());const pending=runtime.write(account,async(path,init)=>init?.method?slow.promise:f.request(path,init),'a',{ssl:'strict'});
   await expect(runtime.write({...account,id:2},f.request,'a',{ssl:'strict'})).rejects.toThrow('already saving');slow.resolve({result:{id:'ssl',value:'strict'}});await pending;
  });
  it('one cancelled reader cannot cancel another consumer of the same snapshot',async()=>{
   const cache=new BoundReadCache(new ZoneDirectory()),slow=deferred<string>(),controller=new AbortController();
   const a=cache.read(account,'zone:a',()=>slow.promise,{signal:controller.signal});const b=cache.read(account,'zone:a',()=>slow.promise);await Promise.resolve();await Promise.resolve();controller.abort();slow.resolve('full');await expect(a).rejects.toThrow();expect((await b).value).toBe('full');
  });
 });
}
