import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync,writeFileSync,cpSync,mkdtempSync,rmSync } from 'node:fs';
import { resolve,dirname,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import { dashboardDb } from '../shared/tests/dashboard.fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(resolve(root,'backend/package.json'));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {dashboardOverview,dashboardTrends}=require(resolve(root,'backend/dist/services/dashboardData.js'));
const {dashboardResources,collectResource}=require(resolve(root,'backend/dist/services/dashboardCollector.js'));
const {auditPage,auditStats}=require(resolve(root,'backend/dist/services/auditQueries.js'));
const {ZoneDirectory}=require(resolve(root,'backend/dist/services/zoneDirectory.js'));
const {WorkerResources}=require(resolve(root,'backend/dist/services/workerResources.js'));
const {StorageResources}=require(resolve(root,'backend/dist/services/storageResources.js'));
const {D1Resources}=require(resolve(root,'backend/dist/services/d1Resources.js'));
const {TunnelResources}=require(resolve(root,'backend/dist/services/tunnelResources.js'));
const temporary=mkdtempSync('/private/tmp/cfm-dashboard-ui-'),dist=resolve(temporary,'dist');cpSync(process.env.FRONTEND_DIST||resolve(root,'frontend/dist'),dist,{recursive:true});
const base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'',baseline=process.env.BASELINE_UI==='true';
let fixture,runtime,calls=[],cf=0,delay=0,failTrends=false;
function reset(n){fixture?.sqlite.close();fixture=dashboardDb();fixture.accounts(n);if(n){fixture.logs(150);for(let day=0;day<30;day++){const date=new Date(Date.now()-day*86400000).toISOString().slice(0,10);for(const [index,resource] of ['workers_requests','ai_neurons','browser_render_seconds'].entries())fixture.sqlite.prepare('INSERT INTO quota_usage(account_id,resource,date,count) VALUES(1,?,?,?)').run(resource,date,(day+1)*(index+1)*37);fixture.sqlite.prepare("INSERT INTO audit_log(account_id,action,target,status,created_at) VALUES(1,'create_worker','recorded-resource',?,?)").run(day%3?'success':'error',date+' 00:00:00');}}const zones=new ZoneDirectory(),storage=new StorageResources(zones);cf=0;calls=[];delay=0;failTrends=false;runtime={db:fixture.db,accounts:()=>fixture.db.all('SELECT a.*,c.api_token FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id'),request:async a=>async path=>{cf++;await new Promise(r=>setTimeout(r,25));if(path.startsWith('/zones'))return {result:[{id:`z${a.id}`,name:'zone.test',status:'active',account:{id:a.account_id}}],result_info:{total_pages:1}};if(path.includes('pages/projects'))return {result:[],result_info:{page:1,per_page:10,total_pages:0,total_count:0,count:0}};return {result:[],result_info:{total_pages:1}};},zones,workers:new WorkerResources(zones),storage,d1:new D1Resources(storage.cache),tunnels:new TunnelResources(zones)};}
reset(20);
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://fixture'),params=Object.fromEntries(u.searchParams),path=u.pathname;
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(status<400?{success:true,data}:{success:false,error:{message:'Synthetic failure'}}));};
 if(path.startsWith('/api/')){calls.push({path,params});const started=performance.now();
 if(path==='/api/settings')return json({platform:'docker',version:baseline?'2.9.0':'2.10.0'});
 if(path==='/api/accounts'){const accounts=(await runtime.accounts()).map(a=>({...a,worker_plan:'paid',api_token:'***encrypted***',api_key:null,is_demo:false}));const page=Number(params.page||1),size=Number(params.pageSize||10);return json({accounts:accounts.slice((page-1)*size,page*size),quota:accounts.map(a=>({accountId:a.id,resources:[{resource:'ai_neurons',count:12345,limit:10000,limitSource:'internal_policy',officialLimit:null}]})),total:accounts.length,counts:{all:accounts.length,active:accounts.length,unverified:0}});}
 if(path==='/api/accounts/options')return json((await runtime.accounts()).map(a=>({id:a.id,localAccountId:a.id,name:a.name,account_id:a.account_id,cfAccountId:a.account_id,credentialId:a.credential_id,credential_id:a.credential_id,isActive:true,isEnabled:true,is_active:1,is_enabled:1,enabledFeatures:['dns','workers','storage'],enabled_features:'dns,workers,storage'})));
 if(path==='/api/dashboard/overview'){if(delay)await new Promise(r=>setTimeout(r,params.accountId==='1'?delay:0));return json(await dashboardOverview(fixture.db,params));}
 if(path==='/api/dashboard/resources')return json(await dashboardResources(runtime,params.accountId?Number(params.accountId):undefined));
 if(path==='/api/dashboard/trends')return json(failTrends?null:await dashboardTrends(fixture.db,params),failTrends?500:200);
 if(path==='/api/dashboard/activity')return json(await auditPage(fixture.db,{accountId:params.accountId,limit:6}));
 if(path==='/api/dashboard/collect'){let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);return json(await collectResource(runtime,body.accountId,body.metric,body.refresh));}
 if(path==='/api/audit-log/page')return json(await auditPage(fixture.db,params));
 if(path==='/api/audit-log/stats')return json(await auditStats(fixture.db,params));
 if(path==='/api/audit-log/actions')return json(['create_worker','delete_worker']);
 if(path==='/api/audit-log')return json((await auditPage(fixture.db,{limit:100})).items);
 if(path==='/api/quota')return json((await runtime.accounts()).map(a=>({accountId:a.id,accountName:a.name,resources:[{resource:'workers_requests',count:1000,limit:100000,remaining:99000,exhausted:false}]})));
 return json([]);
 }
 const p=path.slice(base.length),file=resolve(dist,p.startsWith('/assets/')?p.slice(1):'index.html');res.writeHead(200,{'Content-Type':extname(file)==='.js'?'application/javascript':extname(file)==='.css'?'text/css':'text/html'});res.end(readFileSync(file));
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:{message:error.message}}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,report=[];let browser;
try{browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
for(const n of (baseline?[20,60,120]:[0,20,60,120]))for(const width of (baseline?[1440,390]:[1440,1024,768,390]))for(const dark of [false,true]){
 reset(n);const context=await browser.newContext({viewport:{width,height:1000},colorScheme:dark?'dark':'light'}),page=await context.newPage(),errors=[],scripts=[];page.on('response',response=>{if(new URL(response.url()).pathname.endsWith('.js'))scripts.push(response.body().then(data=>({bytes:data.length,gzipBytes:gzipSync(data).length})));});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({dark})=>{localStorage.setItem('api_token','synthetic');localStorage.setItem('app_locale','zh-CN');localStorage.setItem('themeMode',dark?'dark':'light');},{dark});
 const started=performance.now();await page.goto(`${origin}${base}/`);if(baseline)await page.getByText('Account 1',{exact:true}).first().waitFor();else await page.locator('.overview-card strong').first().waitFor();if(!baseline)await page.waitForFunction(()=>document.querySelector('.overview-card strong')?.textContent!=='—');
 const firstMs=performance.now()-started;let chartVisibleMs=null;if(!baseline&&n){await page.locator('.usage-trend > svg').first().waitFor();chartVisibleMs=performance.now()-started;}await page.waitForTimeout(60);const chartCount=baseline?0:await page.locator('.usage-trend > svg').count();const heap=(await(await context.newCDPSession(page)).send('Runtime.getHeapUsage')).usedSize,firstCalls=calls.length,initialCF=cf;const js=await Promise.all(scripts);const initialJsBytes=js.reduce((n,s)=>n+s.bytes,0),initialJsGzipBytes=js.reduce((n,s)=>n+s.gzipBytes,0);
 if(!baseline){assert.equal(cf,0,'Dashboard must not access Cloudflare implicitly');assert.equal(await page.locator('.overview-card').count(),6);assert.equal(await page.locator('.activity-list>div').count(),n?6:0);assert.equal(await page.locator('.n-data-table-tbody tr').count(),n?10:0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.overview-page,.overview-page>*,.audit-page,.audit-page>*')].some(e=>e.getBoundingClientRect().right>innerWidth+1)),false,'Visible module bounds must fit viewport');
 if(n===20&&width===1440&&!dark){assert.equal(cf,0);await page.screenshot({path:resolve(root,'docs/dashboard-v2.10-desktop.png'),fullPage:true});
 delay=1000;const selector=page.locator('.overview-filters .n-select').first();await selector.click();await page.locator('.n-base-select-option').filter({hasText:'Account 1｜Credential 1'}).first().click();await page.waitForTimeout(180);await selector.click();await selector.locator('input').first().fill('Account 2');await page.locator('.n-base-select-option').filter({hasText:'Account 2｜Credential 2'}).first().click();await page.waitForTimeout(1200);assert.ok((await page.locator('.n-data-table-tbody').textContent()).includes('Account 2'));assert.equal(cf,0);await page.goto(`${origin}${base}/`);await page.waitForFunction(()=>document.querySelector('.overview-card strong')?.textContent==='20');
 await page.getByRole('button',{name:'采集缺失 / 过期快照',exact:true}).click();await page.getByRole('button',{name:'暂停采集',exact:true}).click();await page.waitForTimeout(200);const count=cf;await page.waitForTimeout(200);assert.equal(cf,count,'pause stops subsequent jobs');assert.ok(cf<140);
 await page.goto(`${origin}${base}/audit-logs`);await page.getByRole('button',{name:'下一页',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.n-data-table-tbody tr').length===50);const firstText=await page.locator('.n-data-table-tbody tr').first().textContent();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForTimeout(100);assert.notEqual(await page.locator('.n-data-table-tbody tr').first().textContent(),firstText);await page.getByRole('button',{name:'详情',exact:true}).first().click();await page.locator('.n-drawer').waitFor();assert.equal((await page.locator('.n-drawer').textContent()).includes('never-return-me'),false);
 }
 if(n===20&&width===390&&!dark)await page.screenshot({path:resolve(root,'docs/dashboard-v2.10-mobile.png'),fullPage:true});
 if(n===20&&!(width===1440&&!dark)){const before=cf;await page.locator('.n-data-table-tbody button').first().click();await page.locator('.n-drawer').waitFor();assert.ok((await page.locator('.n-drawer').boundingBox()).width<=width);assert.equal(cf,before);await page.locator('.n-drawer .n-base-close').click();}
 if(n===20&&width===1440&&!dark){const before=cf;await page.goto(`${origin}${base}/accounts`);await page.getByText('12,345 Neurons',{exact:true}).first().waitFor();assert.equal(await page.locator('.n-data-table .n-progress').count(),0);assert.equal(cf,before);}
 if(n===20){await page.goto(`${origin}${base}/audit-logs`);await page.waitForFunction(()=>document.querySelectorAll('.n-data-table-tbody tr').length===50);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.overview-page,.overview-page>*,.audit-page,.audit-page>*')].some(e=>e.getBoundingClientRect().right>innerWidth+1)),false,'Visible module bounds must fit viewport');if(width===390&&!dark)await page.screenshot({path:resolve(root,'docs/audit-v2.10-mobile.png'),fullPage:true});}
 assert.deepEqual(errors,[]);
 }
 report.push({n,width,dark,firstMs,initialApi:firstCalls,initialCloudflare:initialCF,heapBytes:heap,initialJsBytes,initialJsGzipBytes,chartCount,chartVisibleMs});await context.close();
}
writeFileSync(process.env.UI_REPORT||resolve(root,`docs/performance-v2.10-ui${baseline?'-before':''}.json`),JSON.stringify({synthetic:true,baseline,report},null,2)+'\n');console.log(JSON.stringify({cases:report.length,passed:true}));
}finally{await browser?.close();await new Promise(r=>server.close(r));fixture?.sqlite.close();rmSync(temporary,{recursive:true,force:true});}
