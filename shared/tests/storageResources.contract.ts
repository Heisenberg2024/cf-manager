import type {TestHarness} from './dnsBatch.contract';
import type * as Resources from '../storageResources';
import type {ZoneDirectory} from '../zoneDirectory';
import type {CfRequest} from '../accountDiscovery';
type Implementation={StorageResources:new(...args:ConstructorParameters<typeof Resources.StorageResources>)=>Pick<Resources.StorageResources,'page'|'allBuckets'|'invalidate'>;normalizeStoragePage:typeof Resources.normalizeStoragePage;pageOptions:typeof Resources.pageOptions;ZoneDirectory:new(...args:ConstructorParameters<typeof ZoneDirectory>)=>{scheduler:Pick<import('../readScheduler').ReadScheduler,'run'>}};
const account={id:1,name:'fixture',account_id:'cf-a',credential_id:10,api_token:'synthetic',is_active:1,is_enabled:1,enabled_features:'storage'};
export function storageResourcesContract(label:string,implementation:Implementation,harness:TestHarness){
 const {describe,it,expect}=harness,{StorageResources,ZoneDirectory,normalizeStoragePage,pageOptions}=implementation;
 describe(`${label} Storage pagination and snapshots`,()=>{
  it('accepts the official R2 array wire format and legacy object envelope',()=>{
   expect(normalizeStoragePage({result:[{key:'a /%?#中文'}],result_info:{delimited:['a/','a/'],cursor:'next',is_truncated:true}},'objects')).toMatchObject({items:[{key:'a /%?#中文'}],prefixes:['a/'],cursor:'next',is_truncated:true});
   expect(normalizeStoragePage({result:{objects:[{key:'a'}],delimited_prefixes:['dir/'],cursor:'next',truncated:true}},'objects').prefixes).toEqual(['dir/']);
  });
  it('does not terminate an empty page that has an advancing cursor',()=>{
   expect(normalizeStoragePage({result:[],result_info:{cursor:'next',is_truncated:true}},'objects').is_truncated).toBe(true);
   expect(normalizeStoragePage({result:{buckets:[]},result_info:{cursor:'next'}},'buckets').cursor).toBe('next');
  });
  it('rejects missing, malformed and repeated pagination cursors',()=>{
   for(const info of [{is_truncated:true},{is_truncated:'yes',cursor:'next'},{is_truncated:true,cursor:'old'},{cursor:42}])expect(()=>normalizeStoragePage({result:[],result_info:info},'objects','old')).toThrow();
   expect(()=>normalizeStoragePage({result:{}},'kv')).toThrow();
  });
  it('fully pages buckets through an empty middle page and preserves unique names',async()=>{
   const runtime=new StorageResources(new ZoneDirectory());const calls:string[]=[];const request:CfRequest=async path=>{calls.push(path);const cursor=new URL(path,'https://fixture.invalid').searchParams.get('cursor');return {result:{buckets:cursor==='empty'?[]:[{name:cursor==='last'?'last':'first'}]},result_info:{cursor:cursor==='last'?'':cursor==='empty'?'last':'empty'}};};
   expect((await runtime.allBuckets(account,request)).map(b=>b.name)).toEqual(['first','last']);expect(calls).toHaveLength(3);
  });
  it('caches only visited pages, merges cold readers and isolates prefix/cursor/credential',async()=>{
   const runtime=new StorageResources(new ZoneDirectory());let calls=0;const request:CfRequest=async()=>{calls++;return {result:[{name:'key'}],result_info:{cursor:''}};};
   await Promise.all(Array.from({length:10},()=>runtime.page(account,request,'kv','ns')));await runtime.page(account,request,'kv','ns');expect(calls).toBe(1);
   await runtime.page(account,request,'kv','ns',{prefix:'p/'});await runtime.page(account,request,'kv','ns',{cursor:'next'});await runtime.page({...account,credential_id:11},request,'kv','ns');expect(calls).toBe(4);
  });
  it('precisely invalidates the affected resource and its credential aliases',async()=>{
   const runtime=new StorageResources(new ZoneDirectory());let calls=0;const request:CfRequest=async()=>{calls++;return {result:[{key:'a'}]};};
   await runtime.page(account,request,'objects','one');await runtime.page({...account,id:2},request,'objects','one');await runtime.page(account,request,'objects','two');runtime.invalidate(account.id,account.account_id,'objects','one');
   await runtime.page(account,request,'objects','two');expect(calls).toBe(3);await runtime.page(account,request,'objects','one');await runtime.page({...account,id:2},request,'objects','one');expect(calls).toBe(5);
  });
  it('never caches failures as successful empty pages and supports live refresh',async()=>{
   const runtime=new StorageResources(new ZoneDirectory());let calls=0;const request:CfRequest=async()=>{calls++;if(calls===1)throw Object.assign(Error('Forbidden'),{statusCode:403});return {result:[{name:'a'}]};};
   await expect(runtime.page(account,request,'kv','ns')).rejects.toThrow('Forbidden');await runtime.page(account,request,'kv','ns');await runtime.page(account,request,'kv','ns',{refresh:true});expect(calls).toBe(3);
  });
  it('escapes exact resource paths and validates pagination limits',async()=>{
   const runtime=new StorageResources(new ZoneDirectory());let target='';await runtime.page(account,async path=>{target=path;return {result:[]};},'objects','bucket',{prefix:'dir /%?#中文/',cursor:'a+/=','delimiter':'/',limit:100});
   const url=new URL(target,'https://fixture.invalid');expect(url.searchParams.get('prefix')).toBe('dir /%?#中文/');expect(url.searchParams.get('cursor')).toBe('a+/=');
   for(const limit of [0,-1,1001,1.2,'abc'])expect(()=>pageOptions({limit})).toThrow();expect(()=>pageOptions({delimiter:'//'})).toThrow();
  });
  it('rejects disabled or non-storage bindings without upstream requests',async()=>{
   const runtime=new StorageResources(new ZoneDirectory());let calls=0;const request:CfRequest=async()=>{calls++;return {result:[]};};
   for(const patch of [{is_enabled:0},{account_id:null},{enabled_features:'workers'}])await expect(runtime.page({...account,...patch},request,'kv','ns')).rejects.toThrow();expect(calls).toBe(0);
  });
 });
}
