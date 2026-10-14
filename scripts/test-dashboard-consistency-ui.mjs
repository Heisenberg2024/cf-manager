/** Real Express routes + one isolated on-disk SQLite database + fresh browser contexts.
 * Only the Cloudflare transport is synthetic; never loads a user's database or credentials.
 * BACKEND_ROOT/FRONTEND_DIST select the frozen v2.10.1 baseline for the same measurement.
 */
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),baseline=process.env.BASELINE_UI==='true';
const backend=resolve(process.env.BACKEND_ROOT||resolve(root,'backend')),dist=resolve(process.env.FRONTEND_DIST||resolve(root,'frontend/dist'));
const temporary=mkdtempSync('/private/tmp/cfm-snapshot-http-');
Object.assign(process.env,{DB_PATH:resolve(temporary,'fixture.db'),ENCRYPTION_KEY:'synthetic-test-key',API_SECRET:'synthetic',FILE_LOGGING:'false',DASHBOARD_AUTO_COLLECT:'true',DASHBOARD_SCAN_STARTUP_DELAY:'0'});
const require=createRequire(resolve(backend,'package.json')),express=require('express'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {initDb,getDb}=require(resolve(backend,'dist/db.js'));initDb();const sqlite=getDb();
const {dashboardRuntime:runtime}=require(resolve(backend,'dist/services/dashboardRuntime.js'));
const {dashboardScan:scan,dashboardScanExecutor:executor}=require(resolve(backend,'dist/services/dashboardScanRuntime.js'));
const {dashboardResources}=require(resolve(backend,'dist/services/dashboardCollector.js'));
let cf=0,latency=1,active=0,maxActive=0,calls=[],pending,extraWorker=false;
const transport=a=>async path=>{
 cf++;active++;maxActive=Math.max(maxActive,active);try{await new Promise(r=>setTimeout(r,latency));
 if(a.id%11===0&&path.includes('pages/projects'))throw Object.assign(Error('Synthetic Pages permission failure'),{statusCode:403});
 if(path.startsWith('/zones'))return {result:[{id:'z1',name:`zone-${a.id}.test`,status:a.id%7===0?'pending':'active',paused:a.id%13===0,account:{id:a.account_id}}],result_info:{total_pages:1,total_count:1}};
 if(path.includes('workers/scripts'))return {result:[{id:'w1'},{id:'w2'},...(extraWorker?[{id:'w3'}]:[])]};
 if(path.includes('pages/projects'))return {result:[{id:'p1',name:'project1'}],result_info:{page:1,per_page:10,count:1,total_pages:1,total_count:1}};
 if(path.includes('cfd_tunnel'))return {result:[{id:'t1',status:'healthy'},{id:'t2',status:'inactive'},{id:'t3'}],result_info:{total_pages:1,total_count:3}};
 if(path.includes('r2/buckets'))return {result:[{name:'bucket1'},{name:'bucket2'}],result_info:{is_truncated:false}};
 if(path.includes('d1/database'))return {result:[{uuid:'d1'},{uuid:'d2'},{uuid:'d3'}],result_info:{total_pages:1,total_count:3}};
 return {result:[{id:'kv1'},{id:'kv2'}],result_info:{total_pages:1,total_count:2}};
 }finally{active--;}
};
runtime.request=async a=>transport(a);
const pump=()=>{if(pending)return;pending=(async()=>{for(let i=0;i<2000;i++){const state=await scan.status();if(!['queued','running'].includes(state.state))return;if(!await scan.runBatch({maxItems:2,durationMs:10000}))return;await new Promise(r=>setTimeout(r,1));}throw Error('Scan failed to terminate');})().finally(()=>pending=undefined);};
executor.wake=pump;
async function seed(n){if(pending)await pending;sqlite.exec('DELETE FROM accounts;DELETE FROM credentials;DELETE FROM audit_log;DELETE FROM dashboard_scan_jobs;UPDATE dashboard_scan_control SET next_full_at=0,executor_token=NULL,executor_until=0;');
 const credential=sqlite.prepare("INSERT INTO credentials(id,name,auth_type,api_token,status) VALUES(?,?,'token','synthetic',?)"),account=sqlite.prepare("INSERT INTO accounts(id,name,credential_id,account_id,auth_type,is_enabled,access_status,last_checked_at) VALUES(?,?,?,?,'token',?,'available',CURRENT_TIMESTAMP)");
 for(let id=1;id<=n;id++){credential.run(id,`Credential ${id}`,id%23===0?'invalid':'active');account.run(id,`Account ${id}`,id,(id%10===0?id-1:id).toString(16).padStart(32,'0'),id%17===0?0:1);}
 const quota=sqlite.prepare('INSERT INTO quota_usage(account_id,resource,date,count) VALUES(1,?,?,?)');if(n){for(let day=0;day<30;day++){if(day%5===2)continue;const date=new Date(Date.now()-day*86400000).toISOString().slice(0,10);for(const [index,key] of ['workers_requests','ai_neurons','browser_render_seconds'].entries())quota.run(key,date,(day+3)*(index+1)*37);}
 const log=sqlite.prepare("INSERT INTO audit_log(account_id,action,target,status,created_at) VALUES(1,'test_operation',?,?,?)");for(let i=0;i<100;i++)log.run(`resource-${i}`,i%19===0?'error':'success',new Date(Date.now()-i*60000).toISOString().replace('T',' ').slice(0,19));}
 runtime.zones.invalidate();runtime.workers.invalidate();runtime.storage.cache.invalidate();runtime.tunnels.cache.invalidate();cf=0;maxActive=0;extraWorker=false;
 await scan.start({reason:'manual',force:true});pump();if(pending)await pending;
 // Mix recently confirmed and old success records, while retaining genuine failure states.
 sqlite.exec('UPDATE resource_summaries SET last_success_at=last_success_at-CASE WHEN account_id%9=0 THEN 49*3600000 WHEN account_id%3=0 THEN 360000 ELSE 60000 END WHERE last_success_at IS NOT NULL;');
 runtime.zones.invalidate();runtime.workers.invalidate();runtime.storage.cache.invalidate();runtime.tunnels.cache.invalidate();
}
const app=express();app.use(express.json());app.use('/api',(req,_res,next)=>{calls.push({path:req.path,method:req.method,query:req.query});next();});
app.use('/api',require(resolve(backend,'dist/middleware/responseWrapper.js')).responseWrapper);app.use('/api',require(resolve(backend,'dist/middleware/auth.js')).authMiddleware);
app.use('/api/dashboard',require(resolve(backend,'dist/routes/dashboard.js')).default);app.use('/api/audit-log',require(resolve(backend,'dist/routes/audit.js')).default);
app.get('/api/settings',(_req,res)=>res.json({platform:'docker',version:baseline?'2.10.1':'2.10.2'}));
app.get('/api/accounts/options',async(_req,res)=>res.json((await runtime.accounts()).map(a=>({id:a.id,name:a.name,credential_id:a.credential_id,credential_name:a.credential_name,account_id:a.account_id,is_active:a.is_active,is_enabled:a.is_enabled,enabled_features:a.enabled_features}))));
app.get('/api/credentials',(_req,res)=>res.json(sqlite.prepare('SELECT id,name,status FROM credentials').all()));
app.get('/api/accounts',async(req,res)=>{const rows=(await runtime.accounts()).map(({api_token:_,api_key:__,email:___,...a})=>a);const page=Number(req.query.page||1),pageSize=Number(req.query.pageSize||10);res.json({accounts:rows.slice((page-1)*pageSize,page*pageSize),quota:[],total:rows.length,counts:{all:rows.length,active:rows.length,unverified:0}});});
app.get('/api/*path',(_req,res)=>res.json([]));
app.use('/api',require(resolve(backend,'dist/middleware/errorHandler.js')).errorHandler);
app.use((req,res)=>{const path=decodeURIComponent(req.path),file=resolve(dist,path.includes('/assets/')?path.slice(path.indexOf('assets/')):'index.html');res.type(extname(file)).send(readFileSync(file));});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const origin=`http://127.0.0.1:${server.address().port}`,base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'',headers={Authorization:'Bearer synthetic'};
const api=async(path,method='GET',body)=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,200);return (await response.json()).data;};
const percentiles=values=>{const v=[...values].sort((a,b)=>a-b);return {samples:v.length,p50:v[Math.floor((v.length-1)*.5)],p95:v[Math.ceil((v.length-1)*.95)]};};
const persisted=metrics=>metrics.map(({snapshotAgeMs:_,...m})=>m);
const report={synthetic:true,backend:'real Express / better-sqlite3, isolated temporary DB',baseline,viewportCases:[],http:[],consistency:[],cold:[]};let browser;
const screenshotDir=resolve(root,'docs/screenshots');mkdirSync(screenshotDir,{recursive:true});
async function context(width,dark){const ctx=await browser.newContext({viewport:{width,height:1000},colorScheme:dark?'dark':'light'});await ctx.addInitScript(dark=>{localStorage.setItem('api_token','synthetic');localStorage.setItem('app_locale','zh-CN');localStorage.setItem('themeMode',dark?'dark':'light');},dark);return ctx;}
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 for(const n of [0,20,60,120]){
  await seed(n);const scanCF=cf,beforeJobs=sqlite.prepare('SELECT COUNT(*) n FROM dashboard_scan_jobs').get().n;
  const samples=[];for(let i=0;i<40;i++){const start=performance.now();await api('/dashboard/resources');samples.push(performance.now()-start);}report.http.push({n,...percentiles(samples)});
  for(const width of [1440,1024,768,390])for(const dark of [false,true]){
   calls=[];const cfBefore=cf,ctx=await context(width,dark),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const performanceSession=await ctx.newCDPSession(page);await performanceSession.send('Performance.enable');const start=performance.now();await page.goto(origin+base+'/');await page.waitForFunction(n=>document.querySelector('.overview-card strong')?.textContent===String(n),n);await page.locator('.overview-card').last().waitFor();const firstMs=performance.now()-start;
   await page.waitForTimeout(100);assert.equal(await page.locator('.overview-card').count(),6);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.overview-page,.overview-page>*')].some(e=>e.getBoundingClientRect().right>innerWidth+1)),false);
   if(!baseline){assert.equal(await page.locator('.overview-page .scan-progress').count(),0);assert.equal(await page.getByText('已过期',{exact:true}).count(),0);const cols=await page.locator('.overview-cards').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length);assert.equal(cols,width===1440?3:width===390?1:2);
    if(n){assert.equal(await page.locator('.resource-distribution .distribution-row').count(),7);await page.locator('.usage-trend > svg').waitFor();assert.ok(await page.locator('.usage-trend circle title').count());}
   }
   assert.equal(cf,cfBefore,'Opening another browser must not create a full scan');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM dashboard_scan_jobs').get().n,beforeJobs);
   const heap=(await performanceSession.send('Runtime.getHeapUsage')).usedSize;const perf=Object.fromEntries((await performanceSession.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
   if(n===20&&(width===1440||width===390)){await page.screenshot({path:resolve(screenshotDir,`dashboard-${baseline?'v2.10.1':'v2.10.2'}-${width===1440?'desktop':'mobile'}-${dark?'dark':'light'}.png`)});}
   // Real mouse wheel: large page content must reach the account summary without clipping.
   await page.waitForTimeout(200);await page.locator('.overview-page').hover();await page.mouse.wheel(0,650);await page.waitForTimeout(180);
   const scroll=await page.evaluate(()=>({desktop:document.querySelector('.overview-page').scrollTop,mobile:document.querySelector('.mobile-layout')?.scrollTop??0}));if(n)assert.ok(scroll.desktop>0||scroll.mobile>0);
   if(n===20&&width===390&&!dark){const cdp=await ctx.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:170,y:820}]});for(const y of [700,540,380,210])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:170,y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
   assert.deepEqual(errors,[]);report.viewportCases.push({n,width,dark,firstMs,heapBytes:heap,renderMs:(perf.LayoutDuration+perf.RecalcStyleDuration)*1000,scriptMs:perf.ScriptDuration*1000,taskMs:perf.TaskDuration*1000,cfOnOpen:cf-cfBefore,scanCF,maxActive,scroll});await ctx.close();
  }
  if(!n)continue;
  // A completes a real persistent job; B starts with no browser cache and must share its resource rows/timestamps.
  const a=await context(1440,false),b=await context(1440,false),pageA=await a.newPage(),pageB=await b.newPage();await pageA.goto(origin+base+'/');await pageA.locator('.overview-card').first().waitFor();const resourcesA=await api('/dashboard/resources'),cfBefore=cf;
  await pageB.goto(origin+base+'/');await pageB.locator('.overview-card').first().waitFor();const resourcesB=await api('/dashboard/resources');assert.deepEqual(persisted(resourcesB.metrics),persisted(resourcesA.metrics));assert.equal(cf,cfBefore);
  const accountProducts=resourcesB.accounts.flatMap(a=>a.metrics);const expected=accountProducts.filter(m=>m.value!==null&&!m.errorKind).length,stable=accountProducts.filter(m=>m.value!==null&&!m.errorKind&&m.state!=='stale').length;
  if(!baseline)assert.equal(stable,expected);
  // Plain module reads use the existing reader and must not invalidate unrelated summaries.
  const account=(await runtime.accounts()).find(a=>a.id===1),prior=await dashboardResources(runtime);extraWorker=true;await runtime.workers.read(account,transport(account),'workers',{refresh:true});extraWorker=false;
  const afterModule=await api('/dashboard/resources');if(!baseline){assert.equal(afterModule.metrics[1].value,prior.metrics[1].value+1);for(const i of [0,2,3,4,5,6])assert.equal(afterModule.metrics[i].value,prior.metrics[i].value);}
  sqlite.prepare("UPDATE accounts SET name='Renamed',updated_at='2030-01-01',last_checked_at=CURRENT_TIMESTAMP WHERE id=1").run();const renamed=await api('/dashboard/resources');if(!baseline)assert.equal(renamed.metrics[1].value,afterModule.metrics[1].value);
  report.consistency.push({n,crossBrowser:true,cfOnNewBrowser:cf-cfBefore-1,successfulProducts:expected,ageCorrectProducts:stable,moduleReadPersisted:sqlite.prepare("SELECT value FROM resource_summaries WHERE account_id=1 AND metric='workers'").get().value===3,metadataPreserved:renamed.metrics[1].value===afterModule.metrics[1].value});
  if(n===20&&!baseline){await pageA.getByRole('button',{name:'刷新',exact:true}).click();await pageA.waitForTimeout(150);const before=cf;assert.equal(await pageA.locator('.overview-page .scan-progress').count(),0);
   await pageA.getByRole('button',{name:'更多操作',exact:true}).click();await pageA.getByText('资源快照采集',{exact:true}).click();await pageA.locator('.n-drawer').waitFor();assert.equal(cf,before);assert.ok(await pageA.getByRole('button',{name:'强制扫描当前账号',exact:true}).isDisabled());
   latency=100;await pageA.getByRole('button',{name:'强制扫描全部账号',exact:true}).click();await pageA.getByRole('button',{name:'暂停采集',exact:true}).click();await pageA.waitForTimeout(100);assert.equal((await api('/dashboard/scan/status')).state,'paused');latency=1;await pageA.getByRole('button',{name:'恢复扫描',exact:true}).click();if(pending)await pending;await pageA.locator('.n-drawer .n-base-close').click();await pageA.locator('.n-drawer').waitFor({state:'hidden'});
   await pageA.locator('.overview-filters .n-select').click();await pageA.locator('.overview-filters .n-select input').first().fill('Account 2');await pageA.locator('.n-base-select-option').filter({hasText:'Account 2｜Credential 2'}).first().click();await pageA.waitForTimeout(150);
   await pageA.getByRole('button',{name:'更多操作',exact:true}).click();await pageA.getByText('资源快照采集',{exact:true}).click();const scopeBefore=cf;await pageA.getByRole('button',{name:'强制扫描当前账号',exact:true}).click();if(pending)await pending;const scoped=await api('/dashboard/scan/status');assert.equal(scoped.job.total,7);assert.equal(cf-scopeBefore,7);await pageA.locator('.n-drawer .n-base-close').click();await pageA.locator('.n-drawer').waitFor({state:'hidden'});
   await pageA.locator('.overview-filters .n-select').click();await pageA.locator('.overview-filters .n-select input').first().fill('Renamed');await pageA.locator('.n-base-select-option').filter({hasText:'Renamed｜Credential 1'}).first().click();await pageA.getByText('30 天',{exact:true}).click();await pageA.waitForFunction(()=>document.querySelectorAll('.usage-trend circle').length>10);assert.ok(calls.some(c=>c.path==='/dashboard/trends'&&c.query.days==='30'&&c.query.accountId==='1'));
   for(const [key,route] of [['accounts','/accounts'],['zones','/dns'],['workersPages','/workers'],['tunnels','/tunnels'],['storage','/storage']]){await pageA.goto(origin+base+'/');await pageA.locator(`[data-card="${key}"]`).click();await pageA.waitForURL(`**${base}${route}`);}
   await pageA.goto(origin+base+'/');await pageA.locator('[data-card="attention"]').click();await pageA.waitForTimeout(200);assert.ok(await pageA.locator('.overview-page').evaluate(e=>e.scrollTop>0));
   await pageA.goto(origin+base+'/audit-logs');await pageA.waitForFunction(()=>document.querySelectorAll('.n-data-table-tbody tr').length===50);const first=await pageA.locator('.n-data-table-tbody tr').first().textContent();await pageA.getByRole('button',{name:'下一页',exact:true}).click();await pageA.waitForTimeout(100);assert.notEqual(await pageA.locator('.n-data-table-tbody tr').first().textContent(),first);
   await pageA.getByRole('button',{name:'详情',exact:true}).first().click();await pageA.locator('.n-drawer').waitFor();assert.equal((await pageA.locator('.n-drawer').textContent()).includes('synthetic-test-key'),false);
  }
  await a.close();await b.close();
 }
 // Slow first collection: locally available account counts render while the server is waiting on CF.
 if(!baseline){for(const n of [20,60,120]){await seed(n);sqlite.exec('DELETE FROM resource_summaries;DELETE FROM dashboard_scan_jobs;UPDATE dashboard_scan_control SET next_full_at=0;');latency=500;cf=0;const ctx=await context(1440,false),page=await ctx.newPage();const start=performance.now();await page.goto(origin+base+'/');await page.waitForFunction(n=>document.querySelector('[data-card="accounts"] strong')?.textContent===String(n),n);const firstMs=performance.now()-start;assert.ok(firstMs<2000);assert.equal(await page.locator('.overview-page .scan-progress').count(),0);const state=await api('/dashboard/scan/status');assert.ok(state.job.completed<state.job.total);report.cold.push({n,firstMs,completedAtFirstPaint:state.job.completed,total:state.job.total});await api('/dashboard/scan/pause','POST');await ctx.close();latency=1;if(pending)await pending;}}
 writeFileSync(process.env.UI_REPORT||resolve(root,`docs/dashboard-consistency-v2.10.2${baseline?'-before':''}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,cases:report.viewportCases.length,consistency:report.consistency,cold:report.cold}));
}finally{if(pending)await pending;await browser?.close();await new Promise(r=>server.close(r));sqlite.close();rmSync(temporary,{recursive:true,force:true});}
