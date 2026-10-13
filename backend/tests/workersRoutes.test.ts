import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
const mocks=vi.hoisted(()=>({get:vi.fn(),active:vi.fn(),request:vi.fn(),cf:vi.fn()}));
vi.mock('../src/models/account',()=>({getAccountById:mocks.get,getActiveAccountsByFeature:mocks.active}));
vi.mock('../src/models/auditLog',()=>({createAuditLog:vi.fn()}));
vi.mock('../src/db',()=>({default:{}}));
vi.mock('../src/services/cfFactory',()=>({accountRequest:mocks.request,getCfClient:mocks.cf,getAuthHeaders:vi.fn()}));
vi.mock('../src/services/logger',()=>({appLogger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()},apiLogger:{info:vi.fn()}}));
import routes from '../src/routes/workers';
import { workerResources } from '../src/services/workerResourcesRuntime';
import { dnsDirectory } from '../src/services/dnsDirectory';
import { editPagesProject } from '../src/services/pagesService';
import { appLogger } from '../src/services/logger';
let server:Server,base:string;const calls:string[]=[];
const accounts=[1,2].map(id=>({id,name:`A${id}`,credential_id:id,account_id:`cf-${id}`,api_token:'synthetic',is_active:1,is_enabled:1,enabled_features:'dns,workers'}));
beforeAll(async()=>{const app=express();app.use(express.json());app.use('/workers',routes);app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.statusCode || 500).json({error:e.message}));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));base=`http://127.0.0.1:${(server.address() as any).port}`;});
afterAll(()=>new Promise<void>(r=>server.close(()=>r())));
beforeEach(()=>{vi.clearAllMocks();calls.length=0;workerResources.invalidate();dnsDirectory.invalidate();mocks.get.mockImplementation(id=>accounts.find(a=>a.id===id));mocks.active.mockReturnValue(accounts);mocks.request.mockImplementation(a=>async(path:string)=>{calls.push(`${a.id}:${path}`);if(path==='/graphql')return {data:{viewer:{accounts:[{workers:[],pages:[]}]}}};if(path==='/zones/foreign')return {result:{id:'foreign',account:{id:'cf-2'}}};if(path.startsWith('/zones?'))return {result:[{id:'zone-a',name:'a.test',account:{id:a.account_id}}]};return {result:[{id:'w',name:'p'}],result_info:{total_pages:1}};});});
describe('Docker Workers read routes and redacted Pages edits',()=>{
 it('keeps legacy arrays and shares counts with the current account list',async()=>{
  const result=await fetch(`${base}/workers/summary?accountId=1`);expect(result.headers.get('cache-control')).toBe('no-store');expect(await result.json()).toMatchObject([{accountId:1,workerCount:1,pagesCount:1}]);
  const list=await fetch(`${base}/workers?accountId=1`);expect(await list.json()).toHaveLength(2);expect(calls).toHaveLength(3);
  const detailed=await fetch(`${base}/workers?accountId=1&details=true`);expect(await detailed.json()).toMatchObject({items:[{cfAccountId:1},{cfAccountId:1}],states:[{accountId:1,workers:'ready',pages:'ready'}]});expect(calls).toHaveLength(3);
 });
 it('invalidates the affected resource list after an actual delete route',async()=>{
  mocks.cf.mockReturnValue({workers:{scripts:{delete:vi.fn(async()=>({}))}}});
  await (await fetch(`${base}/workers/summary?accountId=1`)).json();
  const deleted=await fetch(`${base}/workers/1/workers/w`,{method:'DELETE'});
  expect(deleted.status).toBe(200);
  await (await fetch(`${base}/workers?accountId=1`)).json();
  expect(calls.filter(p=>p.includes('/workers/scripts'))).toHaveLength(2);expect(calls.filter(p=>p.endsWith('/graphql'))).toHaveLength(1);
 });
 it('validates account parameters, isolates Zone reads and refuses a foreign route write',async()=>{
  expect((await fetch(`${base}/workers/summary?accountId=bad`)).status).toBe(400);
  const zones=await fetch(`${base}/workers/1/resources/zones`);expect(await zones.json()).toMatchObject([{cfAccountId:1}]);expect(calls.every(p=>p.startsWith('1:/zones?account.id=cf-1'))).toBe(true);
  const write=await fetch(`${base}/workers/1/workers/w/routes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zone_id:'foreign',pattern:'a.test/*'})});expect(write.status).toBe(409);expect(mocks.cf).not.toHaveBeenCalled();
 });
 it('isolates credential-construction failures in legacy all-account reads',async()=>{
  const original=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((a:any)=>{if(a.id===2)throw Error('credential unavailable');return original(a);});
  const result=await fetch(`${base}/workers/summary`);
  expect(result.status).toBe(200);expect(await result.json()).toMatchObject([{accountId:1,workerCount:1},{accountId:2,workerCount:null,pagesCount:null}]);
 });
 it('returns unknown on read failure while preserving successful peer resources',async()=>{
  mocks.request.mockImplementation(()=>async(path:string)=>{if(path.includes('workers/scripts') || path==='/graphql')throw Object.assign(Error('permission'),{statusCode:403});return {result:[{name:'p'}]};});
  const result=await fetch(`${base}/workers/summary?accountId=1`);expect(await result.json()).toMatchObject([{workerCount:null,pagesCount:1,requests:null,states:{workers:'permission'}}]);
 });
 it('keeps Pages edit bound to the selected Account even if the body contains another account_id',async()=>{
  const edit=vi.fn(async()=>({name:'project'}));mocks.cf.mockReturnValue({pages:{projects:{edit}}});
  await editPagesProject(accounts[0] as any,'project',{account_id:'cf-2',deployment_configs:{production:{}}});
  expect(edit).toHaveBeenCalledWith('project',expect.objectContaining({account_id:'cf-1'}));
 });
 it('never logs submitted or returned Pages environment variables',async()=>{
  const edit=vi.fn(async()=>({deployment_configs:{production:{env_vars:{TOKEN:{value:'returned-secret'}}}}}));mocks.cf.mockReturnValue({pages:{projects:{edit}}});const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  await editPagesProject(accounts[0] as any,'project',{deployment_configs:{production:{env_vars:{TOKEN:{value:'submitted-secret'}}}}});expect(edit).toHaveBeenCalledOnce();expect(log).not.toHaveBeenCalled();expect(appLogger.info).not.toHaveBeenCalled();log.mockRestore();
 });
});
