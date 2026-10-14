// Local browser simulation only. No production credentials or Cloudflare writes.
import {createServer} from 'node:http';
import {readFileSync,existsSync,cpSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary=mkdtempSync('/private/tmp/cf-manager-v27-ui-'),dist=resolve(temporary,'dist');
cpSync(process.env.FRONTEND_DIST || resolve(root,'frontend/dist'),dist,{recursive:true});
const esbuild=require(resolve(root,'worker/node_modules/esbuild'));
await esbuild.build({stdin:{contents:"export * from './shared/workerResources';export * from './shared/zoneDirectory';export * from './shared/dnsBatch';",resolveDir:root},bundle:true,platform:'node',format:'esm',outfile:resolve(temporary,'fixture.mjs')});
const {WorkerResources,ZoneDirectory,previewBatch,executeBatch}=await import(resolve(temporary,'fixture.mjs'));
const zh=JSON.parse(readFileSync(resolve(root,'frontend/src/i18n/locales/zh-CN.json'))),base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'';
const baseline=process.env.BASELINE_UI==='true';
const accounts=Array.from({length:60},(_,i)=>({id:i+1,name:`Account ${i+1}`,account_id:String(i+1).padStart(32,'0'),credential_id:i+1,is_active:1,is_enabled:1,enabled_features:'dns,workers'}));
const zones=Array.from({length:1000},(_,i)=>({id:String(i+1).padStart(32,'0'),name:`a1-${String(i).padStart(3,'0')}.test`,cfAccountId:1,credentialId:1,accountName:'Account 1',account:{id:accounts[0].account_id},status:'active',plan:{name:'Free'}}));
let size=10000,accountCount=20,cache;let apiCalls=[],cfCalls=0,recordRows=0,preview;
const rows=()=>Array.from({length:size},(_,i)=>({id:`record-${i}`,type:i%10===0?'TXT':'A',name:`r-${i}.a1-000.test`,content:i%10===0?'fixture-text':'192.0.2.1',ttl:300,proxied:false}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function request(account) {return async path=>{cfCalls++;await sleep(accountCount===60 && account.id%5===0?250:5);if(accountCount===60 && account.id%7===0)throw Object.assign(Error('Synthetic permission denied'),{statusCode:403});if(path==='/graphql')return {data:{viewer:{accounts:[{workers:[],pages:[]}]}}};return {result:Array.from({length:3},(_,i)=>({id:`worker-${i}`,name:`project-${i}`,subdomain:`project-${i}.pages.dev`,created_on:'2026-10-13'})),...(path.includes('/pages/projects') ? {result_info:{page:Number(new URL(path,'https://fixture').searchParams.get('page')||1),per_page:10,count:3,total_pages:1,total_count:3}} : {})};};}
const runtime={resolve:async target=>({credentialId:target.credentialId,cloudflareAccountId:accounts[target.accountId-1].account_id,request:async(path,init={})=>{const u=new URL(path,'https://fixture.invalid');if(u.pathname===`/zones/${target.zoneId}`)return {result:{id:target.zoneId,name:target.zoneName,account:{id:accounts[target.accountId-1].account_id}}};const id=u.pathname.split('/')[4];if(id)return {result:rows().find(r=>r.id===id)};const all=rows().filter(r=>(!u.searchParams.has('type') || r.type===u.searchParams.get('type'))&&(!u.searchParams.has('name.contains') || r.name.includes(u.searchParams.get('name.contains'))));const per=Number(u.searchParams.get('per_page')||500),page=Number(u.searchParams.get('page')||1);return {result:all.slice((page-1)*per,page*per),result_info:{total_pages:Math.ceil(all.length/per)}};}}),audit:async()=>{}};
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://fixture.local'),path=u.pathname.slice(4);const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status<400?{success:true,data}:{success:false,error:{message:data}}));};
 if(u.pathname.startsWith('/api/')) {
  apiCalls.push({path,query:u.search,method:req.method});let text='';for await(const part of req)text+=part;const body=text?JSON.parse(text):{};
  if(path==='/settings')return send({platform:'docker',version:'synthetic'});
  if(path==='/accounts/options')return send(accounts.slice(0,accountCount));
  if(path==='/accounts')return send({accounts:accounts.slice(0,accountCount)});
  if(path==='/credentials')return send(accounts.map(a=>({id:a.id,name:`Credential ${a.id}`})));
  if(path.includes('/dns/accounts/')){await sleep(10);return send({zones:Number(path.split('/')[3])===1?zones:[],meta:{state:'fresh'}});}
  if(path.endsWith('/records')){
   const all=rows().filter(r=>(!u.searchParams.has('type')||r.type===u.searchParams.get('type'))&&(!u.searchParams.has('nameContains')||r.name.toLowerCase().includes(u.searchParams.get('nameContains').toLowerCase()))&&(!u.searchParams.has('contentContains')||r.content.toLowerCase().includes(u.searchParams.get('contentContains').toLowerCase())));
   const page=Number(u.searchParams.get('page')||1),per=Number(u.searchParams.get('perPage')||500);
   await sleep(u.searchParams.has('page')?10:10*Math.ceil(size/500));const chunk=u.searchParams.has('page')?all.slice((page-1)*per,page*per):all;recordRows+=chunk.length;
   return send(u.searchParams.has('page')?{records:chunk,meta:{scope:'page',page,per_page:per,total_count:all.length,total_pages:Math.ceil(all.length/per)}}:chunk);
  }
  if(path==='/dns/batch/preview'){preview=await previewBatch(body,runtime,'fixture-secret');return send(preview);}
  if(path==='/dns/batch/execute'){res.writeHead(200,{'Content-Type':'text/event-stream'});await executeBatch(body,runtime,async e=>res.write(`data: ${JSON.stringify(e)}\n\n`));res.end();return;}
  if(path==='/workers/summary'){
   const id=Number(u.searchParams.get('accountId'));const targets=id?[accounts[id-1]]:accounts.slice(0,accountCount);
   return send(await Promise.all(targets.map(a=>cache.summary(a,request(a)))));
  }
  if(path==='/workers'){
   const id=Number(u.searchParams.get('accountId')||1),result=await cache.list(accounts[id-1],request(accounts[id-1]));
   return send(u.searchParams.get('details')==='true'?{items:result.items,states:[{accountId:id,...result.states}]}:result.items);
  }
  if(path.endsWith('/settings'))return send({bindings:[{name:'PUBLIC',type:'plain_text',text:'safe'},{name:'PASSWORD',type:'secret_text',text:'DO-NOT-CACHE'}]});
  if(path.endsWith('/secrets'))return send([{name:'PASSWORD',type:'secret_text'}]);
  if(path.endsWith('/config'))return send({vars:[{name:'PUBLIC',value:'safe'},{name:'PASSWORD',secret:true}]});
  if(path.endsWith('/project'))return send({name:'project-0',subdomain:'project-0.pages.dev',production_branch:'main',deployment_configs:{production:{env_vars:{PUBLIC:{type:'plain_text',value:'safe'},PASSWORD:{type:'secret_text',value:'DO-NOT-CACHE'}}}}});
  if(path.endsWith('/schedules'))return send({schedules:[{cron:'0 * * * *'}]});
  if(path.endsWith('/resources/zones'))return send(zones);
  if(path.endsWith('/content'))return send('export default {fetch(){return new Response("fixture")}}');
  return send([]);
 }
 const candidate=resolve(dist,'.'+(u.pathname.slice(base.length)||'/'));const file=existsSync(candidate)&&extname(candidate)?candidate:resolve(dist,'index.html');res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,report={source:'Local isolated Chromium simulation, not production latency or P95',baseline,dns:[],workers:[]};let browser,currentPage;
try {
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,headless:true});
 for(const width of (process.env.UI_WIDTHS?process.env.UI_WIDTHS.split(',').map(Number):[1440,390])) for(size of [100,1000,10000]) {
  apiCalls=[];recordRows=0;cache=new WorkerResources(new ZoneDirectory());
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});await context.addInitScript(()=>{localStorage.setItem('api_token','fixture');localStorage.setItem('app_locale','zh-CN');localStorage.setItem('dns_selected_account','1');});
  const page=currentPage=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`${origin}${base}/dns`);const list=page.locator('.dns-zone-list');await list.getByText('a1-000.test',{exact:true}).waitFor();assert(await list.locator('.n-list-item').count()<40);
  const started=Date.now();await list.getByText('a1-000.test',{exact:true}).click();await page.getByText('r-1.a1-000.test',{exact:true}).waitFor();const firstScreenMs=Date.now()-started;
  const firstPayloadRows=recordRows;assert.equal(firstPayloadRows,baseline?size:Math.min(size,500));
  const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');const heap=(await cdp.send('Runtime.getHeapUsage')).usedSize;
  const pager=page.locator('.dns-right-card .n-pagination-item').filter({hasText:/^2$/}),box=await pager.boundingBox();let interactionMs=null;
  if(!baseline || (box && box.x>=0 && box.x+box.width<=width)) {const interact=Date.now();await pager.click();await page.getByText('r-20.a1-000.test',{exact:true}).waitFor();interactionMs=Date.now()-interact;}
  const initialReads=apiCalls.filter(c=>c.path.endsWith('/records')).length;assert.equal(initialReads,1);
  if(!baseline && size===10000) {
   await page.getByRole('button',{name:zh.dns.batch.selectPage,exact:true}).click();
   await page.locator('.dns-right-card .n-pagination-item').filter({hasText:/^500$/}).click();await page.getByText('r-9980.a1-000.test',{exact:true}).waitFor();await page.getByRole('button',{name:zh.dns.batch.selectPage,exact:true}).click();
   assert.equal(apiCalls.filter(c=>c.path.endsWith('/records')).length,2);
   await page.locator('.dns-right-card').getByRole('button',{name:zh.common.delete,exact:true}).first().click();await page.locator('.n-modal').getByRole('button',{name:'Preview',exact:true}).click();await page.locator('.n-modal').getByRole('button',{name:zh.dns.multi.confirm,exact:true}).waitFor();
   assert.equal(preview.spec.selection.kind,'ids');assert.equal(preview.items.filter(i=>i.status==='FOUND').length,40);assert(preview.items.some(i=>i.recordId==='record-9980'));
   await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();await page.locator('.n-modal').waitFor({state:'hidden'});
   await page.getByPlaceholder(zh.dns.paging.search,{exact:true}).fill('r-999');await page.getByText('r-999.a1-000.test',{exact:true}).waitFor();await page.getByText(zh.dns.paging.total.replace('{count}','11'),{exact:false}).waitFor();
   assert.equal(apiCalls.filter(c=>c.path.endsWith('/records')).at(-1).query.includes('nameContains=r-999'),true);
   await page.getByRole('button',{name:zh.dns.batch.selectAll.replace('{count}','11'),exact:true}).click();await page.locator('.dns-right-card .n-data-table-tr').nth(1).getByRole('checkbox').click();
   await page.locator('.dns-right-card').getByRole('button',{name:zh.common.delete,exact:true}).first().click();await page.locator('.n-modal').getByRole('button',{name:'Preview',exact:true}).click();await page.locator('.n-modal').getByRole('button',{name:zh.dns.multi.confirm,exact:true}).waitFor();assert.equal(preview.spec.selection.kind,'ids');assert.equal(preview.spec.selection.recordIds.length,1);
   await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();await page.locator('.n-modal').waitFor({state:'hidden'});
  }
  if(!baseline) assert.equal(await page.locator('.dns-right-card .n-skeleton, .dns-right-card .n-data-table .n-spin-body').count(),0);assert.deepEqual(errors,[]);
  report.dns.push({width,records:size,firstScreenMs,interactionMs,firstPayloadRows,jsHeapUsedBytes:heap,recordRequests:apiCalls.filter(c=>c.path.endsWith('/records')).length});await page.screenshot({path:resolve(temporary,`dns-${width}-${size}.png`)});await context.close();
 }
 for(accountCount of (baseline?[]:[20,60])) {
  apiCalls=[];cfCalls=0;cache=new WorkerResources(new ZoneDirectory());const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});await context.addInitScript(()=>{localStorage.setItem('api_token','fixture');localStorage.setItem('app_locale','zh-CN');});const page=currentPage=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const started=Date.now();await page.goto(`${origin}${base}/workers`);await page.locator('.n-data-table').getByText('worker-0',{exact:true}).waitFor();const firstScreenMs=Date.now()-started;
  assert.equal(await page.locator('.worker-compact-card').count(),accountCount);const before=apiCalls.filter(c=>c.path==='/workers').length;
  await page.locator('.worker-compact-card').filter({hasText:'Account 2'}).first().click();await page.waitForTimeout(100);await page.locator('.worker-compact-card').filter({hasText:'Account 1'}).first().click();await page.waitForTimeout(100);assert.equal(apiCalls.filter(c=>c.path==='/workers').length,before+1);
  const row=page.locator('.n-data-table-tr').filter({hasText:'worker-0'});const settingsBefore=apiCalls.length;await row.getByRole('button',{name:zh.workers.table.settingsBtn,exact:true}).click();const drawer=page.locator('.n-drawer');await drawer.getByText('PUBLIC',{exact:true}).waitFor();await page.waitForTimeout(100);const initialDrawerReads=apiCalls.slice(settingsBefore).map(c=>c.path);
  assert.equal(initialDrawerReads.filter(p=>p.endsWith('/settings')||p.endsWith('/secrets')).length,2);assert.equal(initialDrawerReads.filter(p=>/\/(schedules|domains|subdomain|content|deployments|resources\/zones)$/.test(p)).length,0);
  await drawer.getByText(zh.workerSettings.tabs.schedules,{exact:true}).click();await drawer.getByText('0 * * * *',{exact:true}).waitFor();const schedules=apiCalls.filter(c=>c.path.endsWith('/schedules')).length;
  await drawer.getByText(zh.workerSettings.tabs.secrets,{exact:true}).click();await drawer.getByText('PUBLIC',{exact:true}).waitFor();await drawer.getByText(zh.workerSettings.tabs.schedules,{exact:true}).click();await page.waitForTimeout(100);assert.equal(apiCalls.filter(c=>c.path.endsWith('/schedules')).length,schedules);
  assert.equal(await drawer.getByText('DO-NOT-CACHE',{exact:true}).count(),0);await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
  const pages=page.locator('.n-data-table-tr').filter({hasText:'project-0'}),pagesBefore=apiCalls.length;await pages.getByRole('button',{name:zh.workers.table.settingsBtn,exact:true}).click();await page.locator('.n-drawer').getByText('project-0.pages.dev',{exact:true}).first().waitFor();await page.waitForTimeout(100);
  const initialPagesReads=apiCalls.slice(pagesBefore).filter(c=>c.path.includes('/pages/')).map(c=>c.path);assert.equal(initialPagesReads.length,1);assert(initialPagesReads[0].endsWith('/project'));
  await page.locator('.n-drawer').getByText(zh.pagesSettings.tabs.domains,{exact:true}).click();await page.waitForTimeout(100);assert.equal(apiCalls.filter(c=>c.path.includes('/pages/')&&c.path.endsWith('/domains')).length,1);
  assert.deepEqual(errors,[]);report.workers.push({accounts:accountCount,firstScreenMs,initialDrawerReads,initialPagesReads,upstreamCallsAtCapture:cfCalls});await context.close();
 }
 writeFileSync(process.env.UI_REPORT || resolve(root,'docs/performance-v2.7-ui.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));console.log(`PASS v2.7 synthetic browser matrix; screenshots: ${temporary}`);
} catch(error) {if(currentPage && !currentPage.isClosed()) {await currentPage.screenshot({path:'/private/tmp/cf-v27-ui-failure.png'});console.error((await currentPage.locator('body').innerText()).slice(-2000));}throw error;} finally {await browser?.close();await new Promise(r=>server.close(r));if(process.env.KEEP_UI_ARTIFACTS!=='true')rmSync(temporary,{recursive:true,force:true});}
