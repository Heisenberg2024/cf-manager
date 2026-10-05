// Optional browser regression using built artifacts and synthetic API/CF state only.
// Run after backend + frontend build. Resolve Playwright via PLAYWRIGHT_MODULE or installed package.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dist=mkdtempSync('/private/tmp/cf-manager-ui-build-');cpSync(resolve(root,'frontend/dist'),dist,{recursive:true});
const base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'';
const zh=JSON.parse(readFileSync(resolve(root,'frontend/src/i18n/locales/zh-CN.json'),'utf8'));
const batch=require(resolve(root,'backend/dist/services/dnsBatch.js'));
const secret='synthetic-ui-key';
const accounts=Array.from({length:60},(_,i)=>({id:i+1,name:`Account ${i+1}`,credential_id:i+10,account_id:(i+101).toString(16).padStart(32,'0'),auth_type:'token',is_enabled:1,is_active:1,enabled_features:'dns,workers,ai,browser_render,storage',created_at:'2026-10-05T00:00:00Z',updated_at:'2026-10-05T00:00:00Z',available_features:'dns,workers,ai,browser_render,storage',worker_plan:'free',api_token:'***encrypted***'}));
const zones=['a.com','b.com','c.com','test.com'].map((name,i)=>({id:(i+1).toString(16).padStart(32,'0'),name,zoneName:name,accountId:i+1,cfAccountId:i+1,credentialId:i+10,accountName:`Account ${i+1}`,status:'active',account:{id:accounts[i].account_id}}));
const records=new Map(zones.map((z,i)=>[z.id,[...(i<2?[{id:`api-${i}`,type:'A',name:`api.${z.name}`,content:'1.2.3.4',ttl:300,proxied:false,comment:'keep'}]:[]),...Array.from({length:25},(_,n)=>({id:`row-${i}-${n}`,type:'A',name:`long-host-${n}.${z.name}`,content:'192.0.2.1',ttl:300,proxied:false}))]]));
let lastSpec,lastPlan,singleRequests=[],recordReads=0;const used=new Set();
const runtime={resolve:async target=>({credentialId:target.credentialId,cloudflareAccountId:accounts[target.accountId-1].account_id,request:async(path,init={})=>{
  await new Promise(r=>setTimeout(r,15));
  const url=new URL(path,'https://cf.test'),zone=zones.find(z=>path.startsWith(`/zones/${z.id}`));assert.equal(zone.accountId,target.accountId);assert.equal(zone.credentialId,target.credentialId);
  if(url.pathname===`/zones/${zone.id}`)return {result:{id:zone.id,name:zone.name,account:{id:accounts[target.accountId-1].account_id}}};
  const rows=records.get(zone.id),id=url.pathname.split('/')[4],method=init.method || 'GET';
  if(method==='GET'&&!id)return {result:structuredClone(rows.filter(r=>r.name===url.searchParams.get('name.exact'))),result_info:{total_pages:1}};
  const index=rows.findIndex(r=>r.id===id);
  if(method==='GET'){if(index<0)throw Object.assign(Error('Record not found'),{status:404});return {result:structuredClone(rows[index])};}
  if(method==='POST'){const row={id:`created-${rows.length}`,...JSON.parse(init.body)};rows.push(row);return {result:row};}
  if(method==='PATCH'){rows[index]={...rows[index],...JSON.parse(init.body)};return {result:rows[index]};}
  if(method==='DELETE'){rows.splice(index,1);return {result:null};}
 } }),audit:async()=>{}};
const server=createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://local');
  if(u.pathname.startsWith('/api/')) {
   let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
   const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status<400?{success:true,data}:{success:false,error:data}));};
   const path=u.pathname.slice(4);
   if(path==='/settings')return json({platform:'docker',version:'2.5.1',demo_account_ids:'',proxy_enabled:false});
   if(path==='/accounts')return json({accounts:u.searchParams.has('page')?accounts.slice((Number(u.searchParams.get('page'))-1)*Number(u.searchParams.get('pageSize')||10),Number(u.searchParams.get('page'))*Number(u.searchParams.get('pageSize')||10)):accounts,quota:[],total:accounts.length,counts:{all:accounts.length,active:accounts.length,unverified:0}});
   if(path==='/credentials')return json([]);
   if(path==='/quota')return json(accounts.map(a=>({accountId:a.id,accountName:a.name,resources:[{resource:'ai_neurons',count:5,limit:10000}]})));
   if(path.startsWith('/audit-log'))return json([]);
   if(path==='/dns/domains')return json(zones);
   if(path==='/dns/batch/preview'){lastSpec=body;lastPlan=await batch.previewBatch(body,runtime,secret);return json(lastPlan);}
   if(path==='/dns/batch/execute'){
    await batch.verifyPreview(body,secret);if(used.has(body.id))return json({message:'Already executed'},400);used.add(body.id);
    res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});
    await batch.executeBatch(body,runtime,async event=>{res.write(`data: ${JSON.stringify(event)}\n\n`);});res.end();return;
   }
   if(path.startsWith('/dns/domains/')&&path.endsWith('/settings'))return json({ssl:'full',cache_level:'aggressive',__meta:{ssl:{editable:true},cache_level:{editable:true}}});
   if(path.endsWith('/proxy')){const zone=zones.find(z=>z.id===u.searchParams.get('zoneId')),row=records.get(zone.id).find(r=>r.id===body.record_id);row.proxied=body.proxied;singleRequests.push({path,body,method:req.method});return json({success:true});}
   if(path.includes('/records')){
    const zone=zones.find(z=>z.id===u.searchParams.get('zoneId')),rows=records.get(zone.id),id=path.split('/')[5];
    if(req.method==='GET'){recordReads++;return json(rows);}
    singleRequests.push({path,body,method:req.method});
    if(req.method==='POST')rows.push({id:'single-created',...body});
    if(req.method==='PUT'){const i=rows.findIndex(r=>r.id===id);rows[i]={...rows[i],...body};}
    if(req.method==='DELETE'){const i=rows.findIndex(r=>r.id===id);rows.splice(i,1);}
    return json({success:true});
   }
   if(path==='/workers/summary')return json([{accountId:1,accountName:'Account 1',requests:0,workerCount:1,pagesCount:0}]);
   if(path==='/workers')return json([{name:'ui-worker',type:'worker',cfAccountId:1,accountName:'Account 1',status:'deployed'}]);
   if(path.endsWith('/routes'))return json(Array.from({length:50},(_,i)=>({id:`route-${i}`,pattern:`route-${i}.a.com/*`,script:'ui-worker'})));
   if(path.endsWith('/config'))return json({vars:[]});
   if(path.endsWith('/resources/zones'))return json(zones.filter(z=>z.accountId===Number(path.split('/')[2])).map(z=>({id:z.id,name:z.name,status:z.status})));
   return json([]);
  }
  const requestPath=base&&u.pathname.startsWith(base)?u.pathname.slice(base.length)||'/':u.pathname;
  let file=resolve(dist,'.'+requestPath);if(!file.startsWith(dist+ '/')&&file!==dist){res.writeHead(403);res.end();return;}if(!existsSync(file)||!extname(file))file=resolve(dist,'index.html');
  res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
 }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:{message:String(e)}}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const output=process.env.UI_TEST_OUTPUT || '/private/tmp/cf-manager-dns-ui';mkdirSync(output,{recursive:true});
let browser,page;const errors=[];const profiles=[];
async function measure(trigger,popup,label) {
 await popup.waitFor();await page.waitForTimeout(300);
 const a=await trigger.boundingBox(),b=await popup.boundingBox();assert(a&&b,`${label}: missing bounds`);
 const gapX=Math.max(0,a.x-(b.x+b.width),b.x-(a.x+a.width)),gapY=Math.max(0,a.y-(b.y+b.height),b.y-(a.y+a.height));
 assert(gapX<45&&gapY<45,`${label}: detached popup ${JSON.stringify({a,b,gapX,gapY})}`);
 const transform=await popup.evaluate(e=>getComputedStyle(e.closest('.v-binder-follower-content')).transform);assert.notEqual(transform,'none',`${label}: follower transform lost`);
 const point={x:Math.max(1,b.x+Math.min(20,b.width/2)),y:Math.max(1,b.y+Math.min(20,b.height/2))};
 assert(await popup.evaluate((e,p)=>{const at=document.elementFromPoint(p.x,p.y);return at&&e.contains(at);},point),`${label}: overlay occluded`);

}
async function near(trigger,popup,label) {
 await measure(trigger,popup,label);
 const size=page.viewportSize(), delta=label.startsWith('Tooltip')?1:30;await page.setViewportSize({width:size.width+delta,height:size.height+(delta===1?1:20)});await measure(trigger,popup,label+' resize');await page.setViewportSize(size);await measure(trigger,popup,label+' restore');
 console.log(`PASS positioning: ${label}`);
}

async function dismiss(){await page.mouse.click(225,80);await page.keyboard.press('Escape');await page.waitForTimeout(200);}
async function selectPopup(trigger,label) {await trigger.click();const popup=page.locator('.n-base-select-menu:visible').last();await near(trigger,popup,label);return popup;}
async function openBatch(action){await page.getByRole('button',{name:/批量 DNS ▾/}).click();await page.locator('.n-dropdown-menu:visible').getByText(zh.dns.multi[action],{exact:true}).click();await page.getByText(zh.dns.multi.title,{exact:true}).waitFor();}
async function confirmBatch(){await page.locator('.n-modal').getByRole('button',{name:'Preview',exact:true}).click();await page.locator('.n-modal').getByRole('button',{name:zh.dns.multi.confirm,exact:true}).click();const execute=page.locator('.n-modal').getByRole('button',{name:/确认执行/});assert(await execute.isDisabled());await page.locator('.n-modal .n-checkbox').last().click();await execute.click();await page.locator('.n-modal').getByText(/执行完成/).waitFor();}
try{
 browser=await chromium.launch({headless:true});
 for(const motion of ['no-preference','reduce'])for(const zoom of [1,1.25,1.5]) {
  const profile=mkdtempSync('/private/tmp/cf-manager-zoom-');profiles.push(profile);mkdirSync(resolve(profile,'Default'));writeFileSync(resolve(profile,'Default/Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(zoom)/Math.log(1.2)}}}));
  const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',viewport:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:motion,locale:'zh-CN'});
  await context.addInitScript(()=>{localStorage.setItem('app_locale','zh-CN');localStorage.setItem('api_token','synthetic-ui-secret');localStorage.setItem('dns_selected_account','__all__');});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});await page.goto(origin+base+'/dns');assert(Math.abs(await page.evaluate(()=>devicePixelRatio)-zoom)<0.01,'native browser zoom was not applied');
  const accountSelect=page.locator('.page-view > .n-space .n-select').first();await selectPopup(accountSelect,`DNS Account Select motion=${motion} zoom=${zoom}`);await dismiss();
  const lang=page.locator('button[title="Language"]');await lang.click();await near(lang,page.locator('.n-dropdown-menu:visible'),`Header Dropdown ${motion}/${zoom}`);
  await page.setViewportSize({width:1200,height:900});await near(lang,page.locator('.n-dropdown-menu:visible'),'Header resize');await dismiss();
  
  const theme=page.locator(`button[title="${zh.theme.theme}"]`);await theme.click();await near(theme,page.locator('.theme-panel:visible'),`Raw Popover ${motion}`);await dismiss();
  for(const name of ['a.com','b.com'])await page.locator('.n-list-item').filter({hasText:name}).getByRole('checkbox').click();
  await page.getByPlaceholder(zh.dns.searchDomain).fill('test');await page.locator('.n-list-item').filter({hasText:'test.com'}).getByRole('checkbox').click();await page.getByPlaceholder(zh.dns.searchDomain).fill('');await page.getByText('已选择 3 个域名',{exact:true}).waitFor();console.log('PASS DNS selection survives search');
  await page.getByRole('button',{name:zh.dns.multi.clear,exact:true}).click();
  for(const name of ['a.com','b.com','c.com'])await page.locator('.n-list-item').filter({hasText:name}).getByRole('checkbox').click();
  const batchTrigger=page.getByRole('button',{name:/批量 DNS ▾/});await batchTrigger.click();await near(batchTrigger,page.locator('.n-dropdown-menu:visible'),`Batch Dropdown ${motion}`);await dismiss();
  await openBatch('create');const dialogType=page.locator('.n-modal .n-select').first();await selectPopup(dialogType,`Dialog Select ${motion}`);
  await page.locator('.n-base-select-menu:visible').getByText('SRV',{exact:true}).click();await selectPopup(dialogType,'Dialog complex form');assert(await page.locator('.batch-body').evaluate(e=>{const before=e.scrollTop;e.scrollTop+=80;return e.scrollTop-before;})>0,'Dialog did not scroll');await near(dialogType,page.locator('.n-base-select-menu:visible'),'Dialog scroll');await page.locator('.n-base-select-menu:visible').getByText('A',{exact:true}).click();await page.locator('.n-modal').getByRole('switch').click();
  await page.locator('.n-modal').getByPlaceholder(zh.dns.recordContentPlaceholder).fill('1.2.3.4');
  if(motion==='no-preference' && zoom===1){
   await confirmBatch();assert.deepEqual(lastSpec.zones.map(z=>z.accountId),[1,2,3]);for(const z of zones.slice(0,3))assert(records.get(z.id).some(r=>r.name===`www.${z.name}`));console.log('PASS DNS Batch Create preview/confirm/execute/results multi-Account');
  }
  await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();
  if(motion==='no-preference' && zoom===1){
   await page.locator('.n-list-item').filter({hasText:'a.com'}).click();const beforeReads=recordReads;
   await openBatch('update');await selectPopup(page.locator('.n-modal .n-select').first(),'Dialog MultiSelect');await page.keyboard.press('Escape');await page.locator('.n-modal .n-form-item').filter({hasText:'Host'}).locator('input').fill('api');await page.locator('.n-modal').getByPlaceholder(zh.dns.recordContentPlaceholder).fill('5.6.7.8');await confirmBatch();
   assert.deepEqual(lastPlan.items.map(i=>i.status),['FOUND','FOUND','NOT_FOUND']);assert(recordReads>beforeReads);assert.equal(records.get(zones[0].id).find(r=>r.id==='api-0').content,'5.6.7.8');await page.screenshot({path:resolve(output,'batch-result.png')});console.log('PASS DNS Batch Update partial not-found/current Zone refresh');await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();
   for(const operation of ['proxy','ttl','delete']) {
    await openBatch(operation);await page.locator('.n-modal .n-form-item').filter({hasText:'Host'}).locator('input').fill(operation==='proxy'?'api':'long-host-0');
    if(operation==='ttl')await page.locator('.n-modal .n-input-number input').fill('600');
    if(operation==='delete')await page.locator('.n-modal').getByPlaceholder(zh.dns.multi.optionalExact).fill('192.0.2.1');
    await confirmBatch();
    if(operation==='proxy')assert.deepEqual(lastSpec.changes,{proxied:true});
    if(operation==='ttl')assert.deepEqual(lastSpec.changes,{ttl:600});
    if(operation==='delete')for(const z of zones.slice(0,3))assert(!records.get(z.id).some(r=>r.name===`long-host-0.${z.name}`));
    await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();await page.locator('.n-modal').waitFor({state:'hidden'});console.log(`PASS DNS Batch ${operation} full UI`);
   }
   await page.getByRole('button',{name:zh.dns.addRecord,exact:true}).click();await page.locator('.n-dialog .n-form-item').filter({hasText:zh.dns.recordName}).locator('input').fill('single');await page.locator('.n-dialog').getByPlaceholder(zh.dns.recordContentPlaceholder).fill('192.0.2.50');await page.locator('.n-dialog').getByRole('button',{name:zh.common.add,exact:true}).click();await page.locator('.n-dialog').waitFor({state:'hidden'});await page.getByPlaceholder(zh.dns.multi.searchRecords).fill('single');await page.getByText('single.a.com',{exact:true}).waitFor();assert(singleRequests.some(r=>r.method==='POST'&&r.body.name==='single.a.com'));const singleRow=page.locator('.dns-right-card .n-data-table-tr').filter({hasText:'single.a.com'});
   await singleRow.getByRole('button',{name:zh.common.edit,exact:true}).click();await page.locator('.n-dialog').getByPlaceholder(zh.dns.recordContentPlaceholder).fill('192.0.2.51');await page.locator('.n-dialog').getByRole('button',{name:zh.common.save,exact:true}).click();await page.locator('.n-dialog').waitFor({state:'hidden'});
   await singleRow.getByRole('switch').click();await page.waitForFunction(()=>document.querySelector('.dns-right-card .n-switch')?.getAttribute('aria-checked')==='false');
   await singleRow.getByRole('checkbox').click();await page.getByRole('button',{name:zh.dns.batch.edit,exact:true}).click();const ttlForm=page.locator('.n-dialog .n-form-item').filter({hasText:'TTL'});await ttlForm.locator('input').fill('600');await ttlForm.getByRole('button',{name:zh.common.save,exact:true}).click();await page.locator('.n-dialog').getByRole('button',{name:zh.common.confirm,exact:true}).click();await page.getByText(zh.dns.batch.result,{exact:true}).waitFor();assert(singleRequests.some(r=>r.method==='PUT'&&JSON.stringify(r.body)==='{"ttl":600}'));await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();
   await singleRow.getByRole('button',{name:zh.common.delete,exact:true}).click();await page.locator('.n-dialog').getByRole('button',{name:zh.common.delete,exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.dns-right-card .n-data-table')?.textContent.includes('single.a.com'));
   await page.getByPlaceholder(zh.dns.multi.searchRecords).fill('');await page.locator('.dns-right-card .n-pagination-item').filter({hasText:/^2$/}).click();await page.getByRole('button',{name:zh.dns.batch.selectPage,exact:true}).click();const count=await page.locator('.dns-right-card .n-data-table-tr').count()-1;assert(count>0&&count<20);await page.locator('.dns-right-card').getByRole('button',{name:zh.common.delete,exact:true}).first().click();await page.locator('.n-dialog').getByRole('button',{name:zh.common.confirm,exact:true}).click();await page.getByText(zh.dns.batch.result,{exact:true}).waitFor();await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();
   console.log('PASS single-Zone create/edit/delete/batch-delete/Proxy/TTL/search/pagination');
  }
  await page.goto(origin+base+'/accounts');const select=page.locator('.n-select').first();await selectPopup(select,`Account Select ${motion}`);await page.locator('.n-base-select-menu:visible').getByText('20 / 页',{exact:true}).click();
  const tableMore=page.locator('.n-data-table').getByRole('button',{name:zh.accounts.table.more,exact:true}).nth(5);await tableMore.click();await near(tableMore,page.locator('.n-dropdown-menu:visible'),`Table Dropdown ${motion}`);
  assert(await tableMore.evaluate(e=>{let p=e.parentElement;while(p){if(p.scrollHeight>p.clientHeight+40&&/(auto|scroll)/.test(getComputedStyle(p).overflowY)){const before=p.scrollTop;p.scrollTop+=20;return p.scrollTop-before;}p=p.parentElement;}return 0;})>0,'Table did not scroll');await near(tableMore,page.locator('.n-dropdown-menu:visible'),'Table internal scroll');await dismiss();
  await page.goto(origin+base+'/workers');const card=page.locator('.worker-compact-card').first();await card.click();await page.locator('.n-data-table').getByRole('button',{name:zh.workers.table.settingsBtn,exact:true}).first().click();await page.locator('.n-drawer').waitFor();await page.locator('.n-drawer').getByText(zh.workerSettings.tabs.routes,{exact:true}).click();const drawerSelect=page.locator('.n-drawer .n-select').first();await selectPopup(drawerSelect,`Drawer Select ${motion}`);await page.locator('.n-base-select-menu:visible').getByText(/^a\.com \(/).click();await page.locator('.n-drawer').getByRole('button',{name:zh.workerSettings.loadRoutes,exact:true}).click();await page.getByText('route-49.a.com/*',{exact:true}).waitFor();await selectPopup(drawerSelect,'Drawer with long table');assert(await drawerSelect.evaluate(e=>{let p=e.parentElement;while(p){if(p.scrollHeight>p.clientHeight+40&&/(auto|scroll)/.test(getComputedStyle(p).overflowY)){const before=p.scrollTop;p.scrollTop+=20;return p.scrollTop-before;}p=p.parentElement;}return 0;})>0,'Drawer did not scroll');await near(drawerSelect,page.locator('.n-base-select-menu:visible'),'Drawer scroll');await page.keyboard.press('Escape');await page.goto(origin+base+'/workers');
  const popButton=page.locator('.n-data-table').getByRole('button',{name:zh.common.delete,exact:true}).first();await popButton.click();await near(popButton,page.locator('.n-popover:visible'),`Popconfirm ${motion}`);await dismiss();
  await page.goto(origin+base+'/');const date=page.locator('.n-date-picker').first();await date.click();await near(date,page.locator('.n-date-panel:visible'),`Date Picker ${motion}`);await dismiss();
  await page.goto(origin+base+'/');const quotaCard=page.locator('.compact-card').nth(5);await quotaCard.click();await near(quotaCard,page.locator('.n-popover:visible'),'Popover in scrolling page');assert(await quotaCard.evaluate(e=>{let p=e.parentElement;while(p){if(p.scrollHeight>p.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(p).overflowY)){const before=p.scrollTop;p.scrollTop+=20;return p.scrollTop-before;}p=p.parentElement;}return 0;})>0,'Page scroll container did not scroll');await near(quotaCard,page.locator('.n-popover:visible'),'Page internal scroll');await dismiss();const dot=page.locator('.compact-card__dot').first();await dot.waitFor();{await dot.hover();await near(dot,page.locator('.n-popover:visible'),`Tooltip ${motion}`);assert(await dot.evaluate(e=>{let p=e.parentElement;while(p){if(p.scrollHeight>p.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(p).overflowY)){const before=p.scrollTop;p.scrollTop+=1;return p.scrollTop-before;}p=p.parentElement;}return 0;})>0);await near(dot,page.locator('.n-popover:visible'),'Tooltip scroll');await page.mouse.move(240,80);}
  await context.close();
 }
 // Responsive DNS layout and batch modal at mobile width.
 const mobile=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});await mobile.addInitScript(()=>{localStorage.setItem('app_locale','zh-CN');localStorage.setItem('api_token','synthetic');localStorage.setItem('dns_selected_account','__all__');});page=await mobile.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});await page.goto(origin+base+'/dns');await page.locator('.n-list-item').first().getByRole('checkbox').click();await openBatch('ttl');await page.screenshot({path:resolve(output,'mobile-batch.png')});assert((await page.locator('.n-modal').boundingBox()).width<=390);console.log('PASS mobile batch layout');await mobile.close();
 assert.deepEqual(errors,[]);console.log('PASS all browser regressions');
}catch(e){console.error('Browser errors:',errors);if(page&&!page.isClosed()){console.error((await page.locator('body').innerText()).slice(-2000));await page.screenshot({path:resolve(output,'failure.png')});}throw e;}
finally{await page?.context().close().catch(()=>{});await browser?.close();for(const profile of profiles)rmSync(profile,{recursive:true,force:true});rmSync(dist,{recursive:true,force:true});await new Promise(r=>server.close(r));}
