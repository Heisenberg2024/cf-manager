import { beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
const mocks=vi.hoisted(()=>({get:vi.fn(),active:vi.fn(),request:vi.fn(),write:vi.fn()}));
vi.mock('../db/models',()=>({getAccountById:mocks.get,getActiveAccountsByFeature:mocks.active,addAuditLog:vi.fn()}));
vi.mock('../services/cfApi',()=>({accountRequest:mocks.request,cfFetch:mocks.write,cfFetchAll:vi.fn(),cfFetchRaw:vi.fn()}));
vi.mock('../services/demo',()=>({demoDestructiveGuard:()=>async(_c:any,next:any)=>next()}));
import routes from '../routes/workers';
import { getWorkerResources } from '../services/workerResourcesRuntime';
import { getDnsDirectory } from '../services/dnsDirectory';
const app=new Hono().route('/workers',routes);app.onError((e:any,c)=>c.json({error:e.message},e.statusCode || 500));
const env={DB:{},ENCRYPTION_KEY:'synthetic'} as any;const calls:string[]=[];
const accounts=[1,2].map(id=>({id,name:`A${id}`,credential_id:id,account_id:`cf-${id}`,api_token:'synthetic',is_active:1,is_enabled:1,enabled_features:'dns,workers'}));
beforeEach(()=>{vi.clearAllMocks();calls.length=0;getWorkerResources(env.DB).invalidate();getDnsDirectory(env.DB).invalidate();mocks.get.mockImplementation(async(_db,id)=>accounts.find(a=>a.id===id));mocks.active.mockResolvedValue(accounts);mocks.request.mockImplementation(async a=>async(path:string)=>{calls.push(`${a.id}:${path}`);if(path==='/graphql')return {data:{viewer:{accounts:[{workers:[],pages:[]}]}}};if(path==='/zones/foreign')return {result:{id:'foreign',account:{id:'cf-2'}}};if(path.startsWith('/zones?'))return {result:[{id:'zone-a',name:'a.test',account:{id:a.account_id}}]};return {result:[{id:'w',name:'p'}],result_info:{total_pages:1}};});});
describe('Worker Workers read HTTP parity',()=>{
 it('keeps legacy arrays and shares counts with the current account list',async()=>{
  const result=await app.request('/workers/summary?accountId=1',{},env);expect(result.headers.get('cache-control')).toBe('no-store');expect(await result.json()).toMatchObject([{accountId:1,workerCount:1,pagesCount:1}]);
  const list=await app.request('/workers?accountId=1',{},env);expect(await list.json()).toHaveLength(2);expect(calls).toHaveLength(3);
  const detailed=await app.request('/workers?accountId=1&details=true',{},env);expect(await detailed.json()).toMatchObject({items:[{cfAccountId:1},{cfAccountId:1}],states:[{accountId:1,workers:'ready',pages:'ready'}]});expect(calls).toHaveLength(3);
 });
 it('invalidates the affected resource list after an actual delete route',async()=>{
  mocks.write.mockResolvedValue({});
  await (await app.request('/workers/summary?accountId=1',{},env)).json();
  const deleted=await app.request('/workers/1/workers/w',{method:'DELETE'},env);
  expect(deleted.status).toBe(200);
  await (await app.request('/workers?accountId=1',{},env)).json();
  expect(calls.filter(p=>p.includes('/workers/scripts'))).toHaveLength(2);expect(calls.filter(p=>p.endsWith('/graphql'))).toHaveLength(1);
 });
 it('validates account parameters, isolates Zone reads and refuses a foreign route write',async()=>{
  expect((await app.request('/workers/summary?accountId=bad',{},env)).status).toBe(400);
  const zones=await app.request('/workers/1/resources/zones',{},env);expect(await zones.json()).toMatchObject([{cfAccountId:1}]);expect(calls.every(p=>p.startsWith('1:/zones?account.id=cf-1'))).toBe(true);
  const write=await app.request('/workers/1/workers/w/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zone_id:'foreign',pattern:'a.test/*'})},env);expect(write.status).toBe(409);expect(mocks.write).not.toHaveBeenCalled();
 });
 it('isolates credential-construction failures in legacy all-account reads',async()=>{
  const original=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async(a:any)=>{if(a.id===2)throw Error('credential unavailable');return original(a);});
  const result=await app.request('/workers/summary',{},env);
  expect(result.status).toBe(200);expect(await result.json()).toMatchObject([{accountId:1,workerCount:1},{accountId:2,workerCount:null,pagesCount:null}]);
 });
 it('returns unknown on read failure while preserving successful peer resources',async()=>{
  mocks.request.mockImplementation(async()=>async(path:string)=>{if(path.includes('workers/scripts') || path==='/graphql')throw Object.assign(Error('permission'),{statusCode:403});return {result:[{name:'p'}]};});
  const result=await app.request('/workers/summary?accountId=1',{},env);expect(await result.json()).toMatchObject([{workerCount:null,pagesCount:1,requests:null,states:{workers:'permission'}}]);
 });
});
