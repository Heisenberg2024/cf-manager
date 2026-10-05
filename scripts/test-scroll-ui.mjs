// Scroll regression: frozen frontend artifacts and synthetic read-only API fixtures.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist=mkdtempSync(resolve(tmpdir(),'cf-manager-scroll-'));
cpSync(resolve(root,'frontend/dist'),dist,{recursive:true});
const base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'';
const zh=JSON.parse(readFileSync(resolve(root,'frontend/src/i18n/locales/zh-CN.json'),'utf8'));
const rows=(prefix,count=100)=>Array.from({length:count},(_,i)=>`${prefix}-${String(i).padStart(3,'0')}`);
const accounts=[1,2].map(id=>({id,name:`Account ${id}`,account_id:String(id).repeat(32),credential_id:id+10,is_active:1,is_enabled:1,auth_type:'token',enabled_features:'dns,storage,ai,workers,browser_render',available_features:'r2',api_token:'***encrypted***'}));
const zones=rows('zone').map((name,i)=>({id:i.toString(16).padStart(32,'0'),name:`${name}.test`,cfAccountId:i<80?1:2,credentialId:i<80?11:12,accountName:i<80?'Account 1':'Account 2',status:'active',account:{id:String(i<80?1:2).repeat(32)}}));
const readme=rows('Paragraph',150).map(x=>`${x}: scroll fixture.\n\n`).join('')+'README_END';
let delayedDomains=false;
const server=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://local'),path=url.pathname;
  if(path==='/fixture/readme.md'){res.writeHead(200,{'Content-Type':'text/plain'});res.end(readme);return;}
  if(path.startsWith('/api/')){
   const api=path.slice(4),json=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data}));};
   if(req.method!=='GET' && !api.endsWith('/query')){res.writeHead(405);res.end();return;}
   if(api==='/settings')return json({platform:'docker',version:'2.5.2',demo_account_ids:''});
   if(api==='/accounts')return json({accounts,quota:[],total:2,counts:{all:2,active:2,unverified:0}});
   if(api==='/credentials')return json([]);
   if(api==='/dns/domains'){if(delayedDomains)await new Promise(r=>setTimeout(r,350));return json(zones);}
   if(api.includes('/records'))return json(rows('record').map((name,i)=>({id:name,type:'A',name:`${name}.${url.searchParams.get('zoneId')}.test`,content:'192.0.2.1',ttl:300,proxied:false})));
   if(/^\/storage\/\d+\/kv$/.test(api))return json(rows('namespace').map(name=>({id:name,title:name})));
   if(api.endsWith('/keys'))return json({keys:rows('key').map(name=>({name})),list_complete:true});
   if(/^\/storage\/\d+\/d1$/.test(api))return json([{uuid:'db-1',name:'scroll-db'}]);
   if(api.endsWith('/tables'))return json(rows('table').map(name=>({name})));
   if(api.endsWith('/query'))return json({results:[{id:1}],meta:{rows_read:1}});
   if(/^\/storage\/\d+\/r2$/.test(api))return json(rows('bucket').map(name=>({name})));
   if(api.endsWith('/objects'))return json({objects:rows('file').map(key=>({key,size:10})),delimited_prefixes:[]});
   if(api==='/store/init')return json({});
   if(api==='/store/templates')return json({sources:[],templates:rows('Template',60).map(id=>({sourceId:1,sourceName:'Fixture',sourceCount:1,template:{id,name:id,type:'worker',version:'1.0.0',description:'Scroll fixture',readmeUrl:'/fixture/readme.md',bindings:[],env:{}}}))});
   if(api==='/ai/usage')return json(rows('AI Account',60).map(accountName=>({accountName,totalNeurons:5,models:[]})));
   if(api==='/workers/summary')return json([{accountId:1,accountName:'Account 1',workerCount:100,pagesCount:0,requests:0}]);
   if(api==='/workers')return json(rows('worker').map(name=>({name,type:'worker',cfAccountId:1,accountName:'Account 1',status:'deployed'})));
   if(api==='/tunnels/accounts')return json(accounts);
   if(api.endsWith('/tunnels'))return json(rows('tunnel').map(id=>({id,name:id,status:'healthy',created_at:'2026-10-05T00:00:00Z'})));
   if(api==='/quota'||api.startsWith('/audit-log')||api==='/tasks')return json([]);
   return json([]);
  }
  const relative=base&&path.startsWith(base)?path.slice(base.length)||'/':path;
  let file=resolve(dist,'.'+relative);
  if(!file.startsWith(dist+'/')&&file!==dist){res.writeHead(403);res.end();return;}
  if(!existsSync(file)||!extname(file))file=resolve(dist,'index.html');
  res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
 }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser,page;
const errors=[];
async function wheel(locator,label){
 await locator.waitFor();
 await locator.scrollIntoViewIfNeeded();
 // Wait for the loading overlay's leave transition before sending a real wheel event.
 await page.waitForFunction(()=>[...document.querySelectorAll('.n-spin-body')].every(e=>e.getClientRects().length===0));
 const metrics=await locator.evaluate(e=>({h:e.clientHeight,total:e.scrollHeight,overflow:getComputedStyle(e).overflowY}));
 assert(metrics.h>30 && metrics.total>metrics.h+30,`${label}: unbounded or insufficient content ${JSON.stringify(metrics)}`);
 assert(['auto','scroll'].includes(metrics.overflow),`${label}: no scroll owner`);
 await locator.evaluate(e=>{e.scrollTop=0;});
 const box=await locator.boundingBox();assert(box);await page.mouse.move(box.x+box.width/2,box.y+Math.min(80,box.height/2));await page.mouse.wheel(0,500);
 await page.waitForFunction(selector=>document.querySelector(selector)?.scrollTop>0,await locator.evaluate(e=>{e.dataset.scrollCheck='current';return '[data-scroll-check="current"]';}));
 await locator.evaluate(e=>{delete e.dataset.scrollCheck;});
 const moved=await locator.evaluate(e=>e.scrollTop);assert(moved>0,`${label}: wheel did not scroll`);console.log(`PASS scroll: ${label}`);
}
async function tableWheel(label){
 const candidates=page.locator('.n-data-table .n-scrollbar-container');
 await candidates.first().waitFor();
 for(let i=0;i<await candidates.count();i++) {
  if(await candidates.nth(i).evaluate(e=>e.clientHeight>30&&e.scrollHeight>e.clientHeight+30)) {await wheel(candidates.nth(i),label);return;}
 }
 throw new Error(`${label}: missing bounded table scroll container`);
}

try {
 browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:1100,height:650},{width:900,height:700},{width:390,height:844}]) {
  const context=await browser.newContext({viewport,reducedMotion:'reduce'});await context.addInitScript(()=>{localStorage.setItem('api_token','synthetic');localStorage.setItem('app_locale','zh-CN');localStorage.setItem('dns_selected_account','__all__');});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text());});
  await page.goto(origin+base+'/dns');await page.locator('.dns-zone-list .n-list-item').nth(99).waitFor();
  const toolbar=page.locator('.dns-zone-actions'),before=await toolbar.boundingBox();
  await wheel(page.locator('.dns-zone-list'),`DNS grouped ${viewport.width}x${viewport.height}`);assert.deepEqual(await toolbar.boundingBox(),before,'DNS toolbar moved with list');
  await page.locator('.dns-zone-list').evaluate(e=>{e.scrollTop=0;});await page.locator('.dns-zone-list').focus();await page.keyboard.press('PageDown');await page.waitForFunction(()=>document.querySelector('.dns-zone-list').scrollTop>0);console.log(`PASS keyboard: DNS ${viewport.width}`);
  await page.locator('.dns-zone-list').evaluate(e=>{e.scrollTop=e.scrollHeight;});await page.locator('.dns-zone-list .n-list-item').last().click();
  await page.locator('.dns-zone-list .n-list-item').last().getByRole('checkbox').click();await page.getByText('已选择 1 个域名',{exact:true}).waitFor();
  const account=page.locator('.page-view > .n-space .n-select').first();await account.click();await page.locator('.n-base-select-menu:visible').getByText('Account 1',{exact:true}).click();
  await page.locator('.dns-zone-list .n-list-item').nth(79).waitFor();await wheel(page.locator('.dns-zone-list'),`DNS single Account ${viewport.width}`);
  delayedDomains=true;await page.getByRole('button',{name:zh.common.refresh,exact:true}).first().click();await page.locator('.dns-zone-list .n-spin-content--spinning').waitFor();await page.locator('.dns-zone-list .n-spin-content--spinning').waitFor({state:'hidden'});delayedDomains=false;
  await page.getByPlaceholder(zh.dns.searchDomain).fill('zone-079');await page.locator('.dns-zone-list .n-list-item').getByRole('checkbox').click();await page.getByPlaceholder(zh.dns.searchDomain).fill('');await page.getByText('已选择 2 个域名',{exact:true}).waitFor();
  await page.locator('.dns-zone-list .n-list-item').last().click();await tableWheel('DNS records independent');
  await page.goto(origin+base+'/storage');await page.getByText('namespace-099',{exact:true}).waitFor();await wheel(page.locator('.storage-left-card .storage-card-content'),'KV namespace list');await page.getByText('namespace-099',{exact:true}).click();await tableWheel('KV keys');
  await page.getByText(zh.storage.d1,{exact:true}).first().click();await page.locator('.d1-toolbar-row .n-select').click();await page.locator('.n-base-select-menu:visible').getByText('scroll-db',{exact:true}).click();await page.getByText('table-099',{exact:true}).waitFor();await wheel(page.locator('.storage-list-scroll'),'D1 table list');
  await page.getByText(zh.storage.r2,{exact:true}).first().click();await page.getByText('bucket-099',{exact:true}).waitFor();await wheel(page.locator('.storage-left-card .storage-card-content'),'R2 bucket list');await page.getByText('bucket-099',{exact:true}).click();await page.getByText('file-099',{exact:true}).waitFor();await tableWheel('R2 objects');
  await page.goto(origin+base+'/store');await page.getByText('Template-059',{exact:true}).waitFor();await wheel(page.locator(viewport.width<=768?'.mobile-layout':'.page-view'),'Store template list');await page.getByText('Template-059',{exact:true}).click();await page.getByText('README_END',{exact:true}).waitFor();await wheel(page.locator('.detail-readme'),'Store README');
  const footer=await page.locator('.detail-footer').boundingBox();assert(footer && footer.y+footer.height<=viewport.height+1,'Store deploy footer below viewport');await page.locator('.n-drawer-header__close').click();
  if(viewport.width>768){
   await page.goto(origin+base+'/ai');await page.getByText('AI Account-059',{exact:true}).waitFor();await wheel(page.locator('.ai-stats-cards'),'AI stats');
   await page.goto(origin+base+'/settings');await wheel(page.locator('.page-view'),'Settings');
   await page.goto(origin+base+'/workers');await page.getByText('worker-099',{exact:true}).waitFor();await tableWheel('Worker table');
   await page.goto(origin+base+'/tunnels');await page.getByText('tunnel-099',{exact:true}).first().waitFor();await tableWheel('Tunnel table');
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS all long-list scroll regressions');
}catch(error){
 if(page&&!page.isClosed()){console.error('Scroll failure metrics:',await page.locator('.page-view, .dns-grid-container, .dns-zone-list, .ai-stats-cards, .storage-grid-container, .storage-left-card, .storage-list-scroll').evaluateAll(els=>els.map(e=>({class:e.className,h:e.clientHeight,total:e.scrollHeight,top:e.scrollTop,overflow:getComputedStyle(e).overflowY,rect:e.getBoundingClientRect().toJSON()}))));await page.screenshot({path:resolve(tmpdir(),'cf-manager-scroll-failure.png'),fullPage:true});}
 throw error;
}finally {await browser?.close();await new Promise(r=>server.close(r));rmSync(dist,{recursive:true,force:true});}
