import type { TestHarness } from './dnsBatch.contract';
import type { WorkerResources } from '../workerResources';
import type { ZoneDirectory } from '../zoneDirectory';
import type { accountZones, liveAccountZone } from '../accountZones';
import type { CfRequest } from '../accountDiscovery';
type Implementation = { WorkerResources: new (...args: ConstructorParameters<typeof WorkerResources>) => Pick<WorkerResources, 'invalidate' | 'list' | 'summary' | 'read'>; ZoneDirectory: new (...args: ConstructorParameters<typeof ZoneDirectory>) => Pick<ZoneDirectory, 'list' | 'all' | 'request'> & {scheduler: Pick<import('../readScheduler').ReadScheduler, 'run'>}; accountZones: typeof accountZones; liveAccountZone: typeof liveAccountZone };
const account = { id: 1, name: 'A', account_id: 'cf-a', credential_id: 10, api_token: 'synthetic', is_active: 1, is_enabled: 1, enabled_features: 'dns,workers' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export function workerResourcesContract(label: string, implementation: Implementation, harness: TestHarness) {
 const { describe, it, expect } = harness, { WorkerResources, ZoneDirectory, accountZones, liveAccountZone } = implementation;
 function fixture() {
  const calls: string[] = [];
  const request: CfRequest = async path => {
   calls.push(path);
   if(path==='/graphql') return {data:{viewer:{accounts:[{workers:[{sum:{requests:7,cpuTimeUs:1000}}],pages:[{sum:{requests:3}}]}]}}} as any;
   const url=new URL(path,'https://synthetic.invalid'), page=Number(url.searchParams.get('page') || 1);
   if(path.includes('/pages/projects')) return {result:Array.from({length:page===1?100:50},(_,i)=>({name:`p${page}-${i}`})),result_info:{total_pages:2,total_count:150}};
   return {result:[{id:'worker'}],result_info:{total_pages:1}};
  };
  return {calls,request};
 }
 describe(`${label} Workers/Pages resource cache and Account Zones`,()=>{
  it('shares lists with summary, reads all Pages pages and independently caches usage',async()=>{
   const f=fixture(), cache=new WorkerResources(new ZoneDirectory());
   const [list,summary]=await Promise.all([cache.list(account,f.request),cache.summary(account,f.request)]);
   expect(list.items).toHaveLength(151);expect(summary).toMatchObject({workerCount:1,pagesCount:150,requests:10,cpuTimeMs:1});
   expect(f.calls).toHaveLength(4);await cache.summary(account,f.request);await cache.list(account,f.request);expect(f.calls).toHaveLength(4);
  });
  it('does not retain a resource list larger than the memory budget',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory(),undefined,30000,120000,16);
   await cache.list(account,f.request);await cache.list(account,f.request);expect(f.calls).toHaveLength(6);
  });
  it('can omit GraphQL completely for counts-only summary',async()=>{
   const f=fixture(), cache=new WorkerResources(new ZoneDirectory());const value=await cache.summary(account,f.request,{usage:false});
   expect(f.calls.filter(p=>p==='/graphql')).toHaveLength(0);expect(value.requests).toBe(null);expect(value.states.usage).toBe('pending');
  });
  it('keeps failed resources unknown, retains successful peers and dampens failure storms',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());let failures=0;
   const request: CfRequest=async(path,init)=>{if(path.includes('workers/scripts') || path==='/graphql'){failures++;throw Object.assign(new Error('synthetic secret upstream body'),{statusCode:403});}return f.request(path,init);};
   const summary=await cache.summary(account,request);expect(summary.workerCount).toBe(null);expect(summary.requests).toBe(null);expect(summary.pagesCount).toBe(150);expect(summary.states.workers).toBe('permission');
   await Promise.all(Array.from({length:10},()=>cache.summary(account,request)));expect(failures).toBe(2);
  });
  it('isolates credentials and invalidates resource aliases while preserving usage',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());await cache.summary(account,f.request);
   const alias={...account,id:2,credential_id:20};await cache.summary(alias,f.request);expect(f.calls).toHaveLength(8);
   cache.invalidate(1,account.account_id);await cache.summary(alias,f.request);expect(f.calls).toHaveLength(11);
   await cache.summary({...alias,api_token:'changed'},f.request);expect(f.calls).toHaveLength(15);
  });
  it('fences late reads after writes and allows fresh loads of empty resources',async()=>{
   const old=deferred<any>(),started=deferred<void>(),cache=new WorkerResources(new ZoneDirectory());
   const pending=cache.read(account,async()=>{started.resolve();return old.promise;},'workers');await started.promise;
   cache.invalidate(1,account.account_id);await cache.read(account,async()=>({result:[]}),'workers');old.resolve({result:[{id:'old'}]});await pending;
   expect(await cache.read(account,async()=>({result:[{id:'should-not-load'}]}),'workers')).toEqual([]);
  });
  it('lets one consumer cancel without cancelling a shared live list',async()=>{
   const old=deferred<any>(),started=deferred<void>(),merged=deferred<void>(),cache=new WorkerResources(new ZoneDirectory(metric=>{if(metric.event==='read_merged') merged.resolve();}));let calls=0;
   const request: CfRequest=async()=>{calls++;started.resolve();return old.promise;};const controller=new AbortController();
   const a=cache.read(account,request,'workers',{signal:controller.signal});const b=cache.read(account,request,'workers');await Promise.all([started.promise,merged.promise]);
   const rejected=expect(a).rejects.toThrow();controller.abort();old.resolve({result:[]});await rejected;expect(await b).toEqual([]);expect(calls).toBe(1);
  });
  it('applies independent expiry and does not bypass cooldown on explicit refresh',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory(),undefined,-1,120000);await cache.summary(account,f.request);await cache.summary(account,f.request);expect(f.calls).toHaveLength(7);
   let attempts=0;const request: CfRequest=async()=>{attempts++;throw Object.assign(new Error('rate limit'),{statusCode:429});};
   await expect(cache.read(account,request,'workers')).rejects.toThrow();await expect(cache.read(account,request,'workers',{refresh:true})).rejects.toThrow();expect(attempts).toBe(1);
  });
  it('scopes Zone reads to one Account and reuses its existing DNS directory',async()=>{
   const directory=new ZoneDirectory();const calls:string[]=[];
   const request: CfRequest=async path=>{calls.push(path);return {result:[{id:'z',name:'a.test',status:'active',account:{id:'cf-a'}},{id:'foreign',name:'a.test',account:{id:'cf-b'}}]};};
   expect(await accountZones(directory,account,request)).toHaveLength(1);await accountZones(directory,account,request);expect(calls).toHaveLength(1);expect(calls[0]).toContain('account.id=cf-a');
   await accountZones(directory,{...account,enabled_features:'workers'},request);expect(calls[1]).toContain('account.id=cf-a');
  });
  it('rejects stale foreign Zone identities live and blocks traversal paths',async()=>{
   const directory=new ZoneDirectory();await expect(liveAccountZone(directory,account,async()=>({result:{id:'z',name:'a.test',account:{id:'cf-b'}}}),'z')).rejects.toThrow('does not belong');
   await expect(liveAccountZone(directory,account,async()=>({result:{}}),'../z')).rejects.toThrow('Invalid Zone');
  });
 });
}
