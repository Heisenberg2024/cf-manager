// Real wheel/keyboard/CDP touch input against synthetic local data. Never connects to Cloudflare.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {dashboardDb} from '../shared/tests/dashboard.fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(resolve(root,'backend/package.json'));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {dashboardOverview,dashboardTrends}=require(resolve(root,'backend/dist/services/dashboardData.js'));
const {dashboardResources}=require(resolve(root,'backend/dist/services/dashboardCollector.js'));
const {ZoneDirectory}=require(resolve(root,'backend/dist/services/zoneDirectory.js'));
const {WorkerResources}=require(resolve(root,'backend/dist/services/workerResources.js'));
const {StorageResources}=require(resolve(root,'backend/dist/services/storageResources.js'));
const {D1Resources}=require(resolve(root,'backend/dist/services/d1Resources.js'));
const {TunnelResources}=require(resolve(root,'backend/dist/services/tunnelResources.js'));
const {auditPage,auditStats}=require(resolve(root,'backend/dist/services/auditQueries.js'));
const f=dashboardDb();f.accounts(60);f.logs(150);
f.sqlite.prepare("UPDATE accounts SET access_status='unavailable' WHERE id%7=0").run();
f.sqlite.prepare("UPDATE audit_log SET target=? WHERE id>100").run('很长的字段'.repeat(80));
for(let i=0;i<7;i++)f.sqlite.prepare("INSERT INTO quota_usage(account_id,resource,date,count) VALUES(1,'workers_requests',?,?)").run(`2026-10-${String(8+i).padStart(2,'0')}`,100+i);
const zones=new ZoneDirectory(),storage=new StorageResources(zones),runtime={db:f.db,accounts:()=>f.db.all('SELECT a.*,c.api_token FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id'),request:async()=>async()=>{throw Error('CF calls forbidden in scroll test');},zones,workers:new WorkerResources(zones),storage,d1:new D1Resources(storage.cache),tunnels:new TunnelResources(zones)};
const idle={state:'idle',job:null,latestFullScan:null,nextScanAt:null,autoCollect:false,execution:'background'};
const temp=mkdtempSync('/private/tmp/cfm-dashboard-scroll-'),dist=resolve(temp,'dist');cpSync(process.env.FRONTEND_DIST||resolve(root,'frontend/dist'),dist,{recursive:true});
const base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'';
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://fixture'),params=Object.fromEntries(u.searchParams),path=u.pathname;const json=data=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({success:true,data}));};
 if(path.startsWith('/api/')){
  if(path==='/api/settings')return json({platform:'docker',version:'synthetic'});
  if(path.startsWith('/api/dashboard/scan/'))return json(idle);
  if(path==='/api/dashboard/overview')return json(await dashboardOverview(f.db,params));
  if(path==='/api/dashboard/resources')return json(await dashboardResources(runtime));
  if(path==='/api/dashboard/trends')return json(await dashboardTrends(f.db,params));
  if(path==='/api/dashboard/activity')return json(await auditPage(f.db,{limit:6}));
  if(path==='/api/audit-log/page'){const data=await auditPage(f.db,params);if(data.items[0])data.items[0].account_name='合成测试长账户名称'.repeat(150);return json(data);}
  if(path==='/api/audit-log/stats')return json(await auditStats(f.db,params));
  if(path==='/api/audit-log/actions')return json(['create_worker','delete_worker']);
  if(path==='/api/accounts/options')return json(await runtime.accounts());
  if(path==='/api/credentials')return json(await f.db.all('SELECT id,name FROM credentials'));
  return json([]);
 }
 const p=path.slice(base.length),file=resolve(dist,p.startsWith('/assets/')?p.slice(1):'index.html');res.writeHead(200,{'Content-Type':extname(file)==='.js'?'application/javascript':extname(file)==='.css'?'text/css':'text/html'});res.end(readFileSync(file));
 }catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,results=[];let browser,page;
const before=process.env.EXPECT_SCROLL_FAILURE==='true';
async function realWheel(owner,amount=650){const box=await owner.boundingBox();assert(box);await page.mouse.move(Math.min(box.x+box.width/2,page.viewportSize().width-25),Math.max(80,box.y+80));await page.mouse.wheel(0,amount);await page.waitForTimeout(160);}
async function bottom(owner,last){for(let i=0;i<16;i++){await realWheel(owner,2200);const reached=await owner.evaluate(e=>e.scrollTop+e.clientHeight>=e.scrollHeight-3);if(reached)break;}const visible=await last.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=-1&&r.bottom<=innerHeight+1;});assert(visible,'Last row/pagination must be reachable through wheel input');}
async function touch(owner){await owner.evaluate(e=>{e.scrollTop=0;});const box=await owner.boundingBox();assert(box);const session=await page.context().newCDPSession(page);const x=Math.min(180,box.x+box.width/2),y=Math.min(600,box.y+box.height-100);await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=6;i++){await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*55}]});await page.waitForTimeout(30);}await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(180);const top=await owner.evaluate(e=>e.scrollTop);assert(top>0,'Native touch gesture must move the mobile scroll owner');await session.detach();return top;}
try{browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
for(const viewport of [{width:1440,height:900},{width:1024,height:768},{width:768,height:1024},{width:390,height:844}])for(const dark of [false,true]){
 const mobile=viewport.width<=768,context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,colorScheme:dark?'dark':'light'});page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(({dark})=>{localStorage.setItem('api_token','synthetic');localStorage.setItem('app_locale','zh-CN');localStorage.setItem('themeMode',dark?'dark':'light');},{dark});
 for(const route of ['dashboard','audit-logs']){
  await page.goto(`${origin}${base}/${route==='dashboard'?'':route}`);const rootSelector=route==='dashboard'?'.overview-page':'.audit-page';await page.locator(rootSelector).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.n-data-table-tbody tr').length>0);if(route==='audit-logs')assert.equal(await page.locator('.n-data-table-tbody tr').count(),50);else{assert.equal(await page.locator('.usage-trend').count(),5);assert.ok(await page.locator('.attention-item').count()>0);assert.equal(await page.locator('.activity-list>div').count(),6);}
  const owner=page.locator(mobile?'.mobile-layout':rootSelector);const metric=await owner.evaluate(e=>({height:e.clientHeight,total:e.scrollHeight,overflow:getComputedStyle(e).overflowY}));await owner.evaluate(e=>{e.scrollTop=0;});await realWheel(owner);const wheelTop=await owner.evaluate(e=>e.scrollTop);
  if(before){if(!mobile)assert.equal(wheelTop,0,'Baseline should reproduce desktop scroll failure');else assert(wheelTop>0,'Baseline mobile layout already owns scroll');results.push({viewport,dark,route,baselineFailure:!mobile,metric,wheelTop});continue;}
  assert(wheelTop>0,`${route} ${viewport.width}: wheel did not move ${JSON.stringify(metric)}`);assert(['auto','scroll'].includes(metric.overflow));
  const ancestorTops=await page.evaluate(selector=>{const node=document.querySelector(selector);const values=[];for(let e=node?.parentElement;e;e=e.parentElement)values.push({top:e.scrollTop,overflow:getComputedStyle(e).overflowY});return values;},mobile?'.mobile-layout':rootSelector);assert(ancestorTops.every(e=>e.top===0),'Outer scroll must not compete with page scrolling');
  await owner.evaluate(e=>{e.scrollTop=0;});await page.locator(rootSelector).focus();await page.keyboard.press('PageDown');await page.waitForTimeout(200);const pageDownTop=await owner.evaluate(e=>e.scrollTop);assert(pageDownTop>0,`${route}: PageDown did not scroll`);
  await page.keyboard.press('Control+End');await page.waitForTimeout(200);await page.keyboard.press('End');await page.waitForTimeout(150);const endTop=await owner.evaluate(e=>e.scrollTop);assert(await owner.evaluate(e=>e.scrollTop+e.clientHeight>=e.scrollHeight-3),`${route}: keyboard End must reach the bottom`);await owner.evaluate(e=>{e.scrollTop=0;});
  const last=route==='dashboard'?page.locator('.activity-list>div').last():page.locator('.audit-pagination');await bottom(owner,last);
  let nextPage=false,drawerTop=null,touchTop=null;
  if(route==='audit-logs'){const first=await page.locator('.n-data-table-tbody tr').first().textContent();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(first=>document.querySelector('.n-data-table-tbody tr')?.textContent!==first,first);await realWheel(owner,-10000);assert((await owner.evaluate(e=>e.scrollTop))<wheelTop);await bottom(owner,page.locator('.audit-pagination'));nextPage=true;
   await page.getByRole('button',{name:'上一页',exact:true}).click();await page.waitForTimeout(150);await realWheel(owner,-10000);await page.getByRole('button',{name:'详情',exact:true}).first().click();await page.locator('.n-drawer').waitFor();assert(!(await page.locator('.n-drawer').textContent()).includes('never-return-me'));assert((await page.locator('.n-drawer').boundingBox()).width<=viewport.width);const candidates=page.locator('.n-drawer-body-content-wrapper,.n-drawer .n-scrollbar-container');for(let i=0;i<await candidates.count();i++){const drawer=candidates.nth(i);if(await drawer.evaluate(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight+10)){await realWheel(drawer);drawerTop=await drawer.evaluate(e=>e.scrollTop);assert(drawerTop>0,'Drawer body must scroll independently');break;}}assert(drawerTop>0,'Long-field Drawer must have an independent scroll owner');await page.locator('.n-drawer .n-base-close').click();await page.locator('.n-drawer').waitFor({state:'hidden'});await page.waitForFunction(()=>[...document.querySelectorAll('.n-drawer-mask')].every(e=>e.getClientRects().length===0));
  }
  if(mobile)touchTop=await touch(owner);
  const horizontal=await page.evaluate(selector=>({document:document.documentElement.scrollWidth>innerWidth+1,module:[...document.querySelectorAll(`${selector},${selector}>*`)].some(e=>e.getBoundingClientRect().right>innerWidth+1)}),rootSelector);assert.deepEqual(horizontal,{document:false,module:false});results.push({viewport,dark,route,metric,wheelTop,pageDownTop,endTop,nextPage,drawerTop,touchTop});
 }
 assert.deepEqual(errors,[]);await context.close();
}
writeFileSync(process.env.UI_REPORT||resolve(root,'docs/dashboard-scroll-v2.10.1.json'),JSON.stringify({synthetic:true,baseline:before,results},null,2)+'\n');console.log(JSON.stringify({passed:true,cases:results.length,baseline:before}));
}catch(e){if(page&&!page.isClosed()){console.error(await page.locator('.overview-page,.audit-page,.mobile-layout,.n-drawer-body-content-wrapper').evaluateAll(rows=>rows.map(e=>({class:e.className,top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight,overflow:getComputedStyle(e).overflowY}))));await page.screenshot({path:'/private/tmp/cfm-dashboard-scroll-failure.png'});}throw e;
}finally{await browser?.close();await new Promise(r=>server.close(r));f.sqlite.close();rmSync(temp,{recursive:true,force:true});}
