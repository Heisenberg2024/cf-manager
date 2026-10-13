import type { TestHarness } from './dnsBatch.contract';
import type { WorkerResources } from '../workerResources';
import type { ZoneDirectory } from '../zoneDirectory';
import type { accountZones, liveAccountZone } from '../accountZones';
import type { CfRequest } from '../accountDiscovery';
import { cloudflareWorkerFixture, pagesEnvelope } from './cloudflareWorkerResources.fixture';
type Implementation = { WorkerResources: new (...args: ConstructorParameters<typeof WorkerResources>) => Pick<WorkerResources, 'invalidate' | 'list' | 'summary' | 'read'>; ZoneDirectory: new (...args: ConstructorParameters<typeof ZoneDirectory>) => Pick<ZoneDirectory, 'list' | 'all' | 'request'> & {scheduler: Pick<import('../readScheduler').ReadScheduler, 'run'>}; accountZones: typeof accountZones; liveAccountZone: typeof liveAccountZone };
const account = { id: 1, name: 'A', account_id: 'cf-a', credential_id: 10, api_token: 'synthetic', is_active: 1, is_enabled: 1, enabled_features: 'dns,workers' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export function workerResourcesContract(label: string, implementation: Implementation, harness: TestHarness) {
 const { describe, it, expect } = harness, { WorkerResources, ZoneDirectory, accountZones, liveAccountZone } = implementation;
 const fixture = () => cloudflareWorkerFixture();
 describe(`${label} Workers/Pages resource cache and Account Zones`,()=>{
  it('shares lists with summary, reads all Pages pages and independently caches usage',async()=>{
   const f=fixture(), cache=new WorkerResources(new ZoneDirectory());
   const [list,summary]=await Promise.all([cache.list(account,f.request),cache.summary(account,f.request)]);
   expect(list.items).toHaveLength(41);expect(summary).toMatchObject({workerCount:21,pagesCount:20,requests:10,cpuTimeMs:1,states:{workers:'ready',pages:'ready'}});
   expect(f.calls.filter(path=>path!=='/graphql').sort()).toEqual(['/accounts/cf-a/pages/projects?page=1','/accounts/cf-a/pages/projects?page=2','/accounts/cf-a/workers/scripts']);
   expect(f.headers[0]?.get('X-Auth-Key')).toBe('synthetic-global-key');expect(f.headers[0]?.get('X-Auth-Email')).toBe('synthetic@example.invalid');expect(f.headers[0]?.has('Authorization')).toBe(false);
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
  it('reproduces Code 8000024 for the old per_page=100 request and recovers on forced refresh',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());
   const broken: CfRequest=(path,init)=>f.request(path.includes('/pages/projects')?`${path}&per_page=100`:path,init);
   await expect(cache.read(account,broken,'pages')).rejects.toThrow('Code 8000024');
   const summary=await cache.summary(account,f.request,{usage:false});
   expect(summary).toMatchObject({workerCount:21,pagesCount:null,states:{workers:'ready',pages:'error'}});
   const partial=await cache.list(account,f.request);expect(partial.items).toHaveLength(21);expect(partial.states).toEqual({workers:'ready',pages:'error'});
   expect(f.calls.filter(path=>path.includes('/pages/projects'))).toEqual(['/accounts/cf-a/pages/projects?page=1&per_page=100']);
   const complete=await cache.summary(account,f.request,{refresh:true,usage:false});
   expect(complete).toMatchObject({workerCount:21,pagesCount:20,states:{workers:'ready',pages:'ready'}});
   expect((await cache.list(account,f.request)).items).toHaveLength(41);
   expect(f.calls.filter(path=>path.includes('/pages/projects'))).toEqual(['/accounts/cf-a/pages/projects?page=1&per_page=100','/accounts/cf-a/pages/projects?page=1','/accounts/cf-a/pages/projects?page=2']);
  });
  it('waits for the second page before returning or caching a successful Pages list',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory()),second=deferred<void>(),release=deferred<void>();let complete=false;
   const request: CfRequest=async(path,init)=>{if(path.endsWith('?page=2')){second.resolve();await release.promise;}return f.request(path,init);};
   const pending=cache.read<unknown[]>(account,request,'pages').then(rows=>{complete=true;return rows;});
   await second.promise;expect(complete).toBe(false);expect(f.calls).toEqual(['/accounts/cf-a/pages/projects?page=1']);
   release.resolve();expect(await pending).toHaveLength(20);expect(await cache.read(account,f.request,'pages')).toHaveLength(20);expect(f.calls).toHaveLength(2);
  });
  it('discards the first ten Pages if the second page fails and preserves the 21 Workers',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());
   const request: CfRequest=async(path,init)=>{if(path.endsWith('?page=2'))throw new DOMException('upstream timeout','TimeoutError');return f.request(path,init);};
   expect(await cache.summary(account,request,{usage:false})).toMatchObject({workerCount:21,pagesCount:null,states:{workers:'ready',pages:'timeout'}});
   const partial=await cache.list(account,request);expect(partial.items).toHaveLength(21);expect(partial.items.filter(row=>row.type==='pages')).toEqual([]);expect(partial.states).toEqual({workers:'ready',pages:'timeout'});
   expect(await cache.read(account,f.request,'pages',{refresh:true})).toHaveLength(20);expect((await cache.list(account,f.request)).items).toHaveLength(41);
  });
  const malformed: Array<[string,(data:any,page:number)=>void]> = [
   ['missing result_info',data=>{delete data.result_info;}],
   ...['page','per_page','count','total_count','total_pages'].map(field=>[`missing ${field}`,(data:any)=>{delete data.result_info[field];}] as [string,(data:any)=>void]),
   ['non-array result',data=>{data.result=null;}],
   ['failed envelope',data=>{data.success=false;}],
   ['errors in envelope',data=>{data.errors=[{code:8000024,message:'invalid'}];}],
   ['wrong page',data=>{data.result_info.page=0;}],
   ['repeated reported page',(data,page)=>{if(page===2)data.result_info.page=1;}],
   ['missing second-page metadata',(data,page)=>{if(page===2)delete data.result_info;}],
   ['empty second page',(data,page)=>{if(page===2){data.result=[];data.result_info.count=0;}}],
   ['short first page',data=>{data.result.pop();data.result_info.count--;}],
   ['wrong count',data=>{data.result_info.count=9;}],
   ['premature final page',data=>{data.result_info.total_pages=1;}],
   ['excess pages',data=>{data.result_info.total_pages=3;}],
   ['too small total_count',data=>{data.result_info.total_count=19;}],
   ['too large total_count',data=>{data.result_info.total_count=21;}],
   ['negative total_count',data=>{data.result_info.total_count=-1;}],
   ['fractional total_count',data=>{data.result_info.total_count=20.5;}],
   ['string total_count',data=>{data.result_info.total_count='20';}],
   ['unsafe total_count',data=>{data.result_info.total_count=Number.MAX_SAFE_INTEGER+1;}],
   ['zero page size',data=>{data.result_info.per_page=0;}],
   ['changed page size',(data,page)=>{if(page===2)data.result_info.per_page=11;}],
   ['changed total_count',(data,page)=>{if(page===2)Object.assign(data.result_info,{total_count:30,total_pages:3});}],
   ['repeated projects',(data,page)=>{if(page===2)data.result=pagesEnvelope(1).result;}],
   ['duplicate project ID',(data,page)=>{if(page===2)data.result[0].id='project-0';}],
   ['duplicate project name',(data,page)=>{if(page===2)data.result[0].name='pages-0';}],
   ['invalid project identity',data=>{data.result[0].name='';}],
   ['pagination limit',data=>{Object.assign(data.result_info,{total_count:10010,total_pages:1001});}],
  ];
  for(const [name,mutate] of malformed) it(`rejects ${name} without caching partial Pages as complete`,async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());
   const request: CfRequest=async(path,init)=>{const data=await f.request(path,init);mutate(data,Number(new URL(path,'https://synthetic.invalid').searchParams.get('page')));return data;};
   await expect(cache.read(account,request,'pages')).rejects.toThrow('Pages pagination');
   const calls=f.calls.length;await expect(cache.read(account,f.request,'pages')).rejects.toThrow('Pages pagination');expect(f.calls).toHaveLength(calls);
   expect(await cache.read(account,f.request,'pages',{refresh:true})).toHaveLength(20);expect(f.calls).toHaveLength(calls+2);
  });
  it('follows the reported default page size rather than hard-coding ten',async()=>{
   const calls:string[]=[],cache=new WorkerResources(new ZoneDirectory());
   const request: CfRequest=async path=>{calls.push(path);return pagesEnvelope(Number(new URL(path,'https://synthetic.invalid').searchParams.get('page')),14,7);};
   expect(await cache.read(account,request,'pages')).toHaveLength(14);expect(calls).toEqual(['/accounts/cf-a/pages/projects?page=1','/accounts/cf-a/pages/projects?page=2']);
  });
  for(const totalPages of [0,1]) it(`accepts a verified zero-resource account with total_pages=${totalPages}`,async()=>{
   const f=cloudflareWorkerFixture('cf-a',0,0),cache=new WorkerResources(new ZoneDirectory());
   const request: CfRequest=async(path,init)=>{const data=await f.request(path,init);if(data.result_info)data.result_info.total_pages=totalPages;return data;};
   expect(await cache.summary(account,request,{usage:false})).toMatchObject({workerCount:0,pagesCount:0,states:{workers:'ready',pages:'ready'}});
   expect((await cache.list(account,request)).items).toEqual([]);expect([...f.calls].sort()).toEqual(['/accounts/cf-a/pages/projects?page=1','/accounts/cf-a/workers/scripts']);
  });
  it('does not read an account without a Cloudflare Account binding',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());
   expect(await cache.summary({...account,account_id:null},f.request,{usage:false})).toMatchObject({workerCount:null,pagesCount:null,states:{workers:'error',pages:'error'}});expect(f.calls).toEqual([]);
  });
  it('isolates distinct CF Accounts and same-Account credentials, including negative caches',async()=>{
   const cache=new WorkerResources(new ZoneDirectory()),a=fixture(),b=cloudflareWorkerFixture('cf-b',2,1),alias=fixture();
   const other={...account,id:2,account_id:'cf-b'},credential={...account,id:3,credential_id:20,api_token:'different'};
   await cache.summary(account,a.request,{usage:false});expect(await cache.summary(other,b.request,{usage:false})).toMatchObject({workerCount:2,pagesCount:1});
   const failed: CfRequest=async()=>{throw Object.assign(Error('permission'),{statusCode:403});};
   expect(await cache.summary(credential,failed,{usage:false})).toMatchObject({workerCount:null,pagesCount:null});
   expect(await cache.summary(account,a.request,{usage:false})).toMatchObject({workerCount:21,pagesCount:20});expect(a.calls).toHaveLength(3);expect(b.calls).toHaveLength(2);
   expect(await cache.summary(credential,alias.request,{refresh:true,usage:false})).toMatchObject({workerCount:21,pagesCount:20});expect(alias.calls).toHaveLength(3);
   const replaced={...account,credential_id:99};await cache.summary(replaced,a.request,{usage:false});expect(a.calls).toHaveLength(6);
  });
  it('keeps failed resources unknown, retains successful peers and dampens failure storms',async()=>{
   const f=fixture(),cache=new WorkerResources(new ZoneDirectory());let failures=0;
   const request: CfRequest=async(path,init)=>{if(path.includes('workers/scripts') || path==='/graphql'){failures++;throw Object.assign(new Error('synthetic secret upstream body'),{statusCode:403});}return f.request(path,init);};
   const summary=await cache.summary(account,request);expect(summary.workerCount).toBe(null);expect(summary.requests).toBe(null);expect(summary.pagesCount).toBe(20);expect(summary.states.workers).toBe('permission');
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
