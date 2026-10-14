// Same fixture runs against baseline routes/services and the working tree.
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pagesEnvelope } from '../../shared/tests/cloudflareWorkerResources.fixture';
const mocks=vi.hoisted(()=>({accounts:[] as any[],calls:[] as string[],request:vi.fn(),sdk:vi.fn(),proxy:vi.fn()}));
vi.mock('../src/models/account',()=>({getActiveAccountsByFeature:()=>mocks.accounts,getAccountById:(id:number)=>mocks.accounts.find(a=>a.id===id)}));
vi.mock('../src/models/auditLog',()=>({createAuditLog:vi.fn()}));
vi.mock('../src/db',()=>({default:{}}));
vi.mock('../src/services/logger',()=>({appLogger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()},apiLogger:{info:vi.fn()}}));
vi.mock('../src/services/cfFactory',()=>({accountRequest:mocks.request,getCfClient:mocks.sdk,getAuthHeaders:()=>({})}));
vi.mock('../src/services/proxyService',()=>({proxyFetch:mocks.proxy,buildCurlCommand:()=>''}));
vi.mock('../src/routes/routeUtils',()=>({getAccountOr404:(req:any)=>mocks.accounts.find(a=>a.id===Number(req.params.accountId)),demoDestructiveGuard:(_req:any,_res:any,next:any)=>next()}));
import routes from '../src/routes/workers';
let server:Server,base:string;const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const data=(kind:string)=>kind==='usage'?{data:{viewer:{accounts:[{workers:[{sum:{requests:10}}],pages:[]}]}}}: kind==='pages'?pagesEnvelope(1,3):{result:Array.from({length:5},(_,i)=>({id:`w${i}`}))};
beforeAll(async()=>{const app=express();app.use(express.json());app.use('/workers',routes);app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.statusCode||500).json({error:e.message}));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));base=`http://127.0.0.1:${(server.address() as any).port}`;});
afterAll(()=>new Promise<void>(r=>server.close(()=>r())));
it('measures cold/warm/concurrent reads with 20 and 60 synthetic Accounts',async()=>{
 const optimized=existsSync(new URL('../src/services/workerResourcesRuntime.ts',import.meta.url));
 const runtimePath = new URL('../src/services/workerResourcesRuntime.ts',import.meta.url).pathname;
 const runtime=optimized?await import(/* @vite-ignore */ runtimePath):undefined;
 const result:any={optimized,scenario:'Local synthetic CF transport; 2ms fast, 20ms slow and explicit 403 Accounts. Not production P95.',samples:[]};
 for(const count of [20,60]) {
  mocks.accounts=Array.from({length:count},(_,i)=>({id:i+1,name:`Account ${i+1}`,account_id:`cf-${i+1}`,credential_id:i+1,is_active:1,is_enabled:1,enabled_features:'dns,workers',api_token:'synthetic'}));
  const read=async(account:any,kind:string)=>{mocks.calls.push(`${account.id}:${kind}`);await delay(count===60 && account.id%5===0?20:2);if(count===60 && account.id%7===0)throw Object.assign(Error('synthetic permission failure'),{statusCode:403});return data(kind);};
  mocks.request.mockImplementation((account:any)=>async(path:string)=>read(account,path==='/graphql'?'usage':path.includes('/workers/scripts')?'workers':'pages'));
  mocks.sdk.mockImplementation((account:any)=>({workers:{scripts:{list:async function*(){for(const row of (await read(account,'workers')).result!)yield row;}}},pages:{projects:{list:async function*(){for(const row of (await read(account,'pages')).result!)yield row;}}}}));
  mocks.proxy.mockImplementation(async(_url:any,_init:any,_timeout:any,_unused:any,account:any)=>({ok:true,status:200,json:async()=>read(account,'usage')}));
  const times:number[]=[];let coldCalls=0;
  for(let sample=0;sample<10;sample++) {
   runtime?.workerResources.invalidate();mocks.calls.length=0;
   const started=performance.now();const summary=await fetch(`${base}/workers/summary`);expect(summary.status).toBe(200);await summary.json();
   const list=await fetch(`${base}/workers?accountId=1`);expect((await list.json()).length).toBe(8);times.push(performance.now()-started);coldCalls=mocks.calls.length;
  }
  const beforeWarm=mocks.calls.length;await (await fetch(`${base}/workers/summary`)).json();await (await fetch(`${base}/workers?accountId=1`)).json();const warmCalls=mocks.calls.length-beforeWarm;
  runtime?.workerResources.invalidate();mocks.calls.length=0;const start=performance.now();
  const first=optimized?fetch(`${base}/workers?accountId=1`):fetch(`${base}/workers/summary`).then(async r=>{await r.json();return fetch(`${base}/workers?accountId=1`);});await (await first).json();const firstCurrentMs=performance.now()-start;
  runtime?.workerResources.invalidate();mocks.calls.length=0;await Promise.all(Array.from({length:5},async()=>{await (await fetch(`${base}/workers/summary`)).json();}));const mergedCalls=mocks.calls.length;
  times.sort((a,b)=>a-b);result.samples.push({accounts:count,coldCalls,warmCalls,concurrent5Calls:mergedCalls,firstCurrentMs,p50Ms:times[4],p95Ms:times[9]});
 }
 if(process.env.WORKERS_PERFORMANCE_OUTPUT)writeFileSync(process.env.WORKERS_PERFORMANCE_OUTPUT,JSON.stringify(result,null,2));
 expect(result.samples).toHaveLength(2);
},30000);

// This resource-only fixture has no local SQL database; persistence has dedicated HTTP/isolate integration coverage.
vi.mock('../src/services/dashboardCollector',async importOriginal=>({...await importOriginal<object>(),inventorySink:()=>async()=>{}}));
