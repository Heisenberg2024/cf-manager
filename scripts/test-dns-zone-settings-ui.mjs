// Offline regression: temporary frontend, synthetic Accounts/Zones, isolated headless browser.
// FRONTEND_DIST=/path/to/dist PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-zone-settings-ui.mjs
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist=resolve(process.env.FRONTEND_DIST || resolve(root,'frontend/dist'));
const zh=JSON.parse(readFileSync(resolve(root,'frontend/src/i18n/locales/zh-CN.json')));
const base=readFileSync(resolve(dist,'index.html'),'utf8').includes('/admin/assets/')?'/admin':'';
const credentials=[{id:10,name:'Primary Credential'},{id:20,name:"Backup's Account"}];
const accounts=[1,2,3].map((id,index)=>({id,name:"Shared's Account",account_id:(index===2?'a':'ab'[index]).repeat(32),credential_id:index===2?20:10,is_active:1,is_enabled:1,is_demo:false,enabled_features:'dns,storage,workers,ai,browser_render',available_features:'r2'}));
const labels=['Shared｜Primary Credential',"Shared｜Backup's Account"];
const zones=[{id:'a',name:'first.test',cfAccountId:1},{id:'b',name:'second.test',cfAccountId:2},{id:'a',name:'first.test',cfAccountId:3},{id:'c',name:'third.test',cfAccountId:2}].map(zone=>({...zone,status:'active',plan:{name:'Free'},credentialId:accounts[zone.cfAccountId-1].credential_id}));
let writes=[],gets=[],remote={},scenario='ssl';
function reset(){writes=[];gets=[];remote=Object.fromEntries(['a','b','c'].map(id=>[id,{ssl:'full',http2:'on',always_use_https:'off',automatic_https_rewrites:'off',security_level:'medium'}]));}
reset();
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://fixture.local'),path=u.pathname.slice(4);
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(status<400?{success:true,data}:{success:false,error:data}));};
 if(u.pathname.startsWith('/api/')){
  if(path==='/accounts')return json({accounts,quota:[]});
  if(path==='/credentials'){await new Promise(r=>setTimeout(r,30));return json(credentials);}
  if(path==='/settings')return json({platform:'docker',version:'2.8.1',demo_account_ids:''});
  if(path==='/tunnels/accounts')return json(accounts);
  if(/^\/dns\/accounts\/\d+\/domains$/.test(path))return json({zones:zones.filter(zone=>zone.cfAccountId===Number(path.split('/')[3])),meta:{state:'fresh'}});
  if(path.includes('/dns/domains/')&&(path.endsWith('/settings')||path.endsWith('/purge-cache'))){
   const accountId=Number(u.searchParams.get('accountId')),zoneId=u.searchParams.get('zoneId');
   assert(zones.some(zone=>zone.id===zoneId&&zone.cfAccountId===accountId),'captured Account/Zone required');
   const settings=()=>({...remote[zoneId],__meta:Object.fromEntries(Object.keys(remote[zoneId]).map(key=>[key,{editable:true}]))});
   if(req.method==='GET'){gets.push({zoneId,refresh:u.searchParams.get('refresh')});return json(settings());}
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   writes.push({accountId,zoneId,body,method:req.method});await new Promise(r=>setTimeout(r,100));
   if(path.endsWith('/purge-cache')){
    assert.deepEqual(body,{purge_everything:true});
    if(zoneId==='a')return json({message:'Permission denied',code:'CF_PERMISSION'},403);
    if(zoneId==='b')return json({message:'Cache purge receipt lost',code:'CF_OUTCOME_UNCERTAIN'},502);
    return json({id:'purge-c-receipt'});
   }
   assert.deepEqual(Object.keys(body.changes),['ssl']);assert.deepEqual(body.baseline,{ssl:'full'});
   const result={updated:[],failed:[],errors:{},fields:{},settings:settings(),patchCount:1,conflictDetection:'non-atomic'};
   if(zoneId==='a'){result.failed=['ssl'];result.fields.ssl={status:'uncertain',reason:'Write not confirmed'};}
   else if(zoneId==='b'){result.failed=['ssl'];result.fields.ssl={status:'conflict',reason:'Remote settings changed'};}
   else{remote.c.ssl=body.changes.ssl;result.settings=settings();result.updated=['ssl'];result.fields.ssl={status:'updated',actual:body.changes.ssl};}
   return json(result);
  }
  if(path.endsWith('/records'))return json([]);
  if(path==='/workers/summary')return json([]);
  if(path==='/workers')return json([]);
  if(path==='/store/templates')return json({templates:[{template:{id:'fixture',name:'Fixture Worker',version:'1.0.0',type:'worker',source:{kind:'inline',code:'export default {}'},bindings:[]},sourceId:1,sourceName:'Fixture'}],sources:[]});
  if(path==='/store/init')return json({});
  if(path==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
  return json([]);
 }
 const asset=resolve(dist,u.pathname.slice(base.length).replace(/^\//,''));
 const file=existsSync(asset)&&extname(asset)?asset:resolve(dist,'index.html');
 const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'};
 res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
}catch(error){res.writeHead(500);res.end(String(error));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
async function openAccounts(page,selector,expected=labels){
 const select=page.locator(selector).first();await select.waitFor();const box=await select.boundingBox();assert(box.x>=0 && box.x+box.width<=page.viewportSize().width+1,`${selector} fits viewport`);await select.click();
 for(const label of expected)await page.locator('.n-base-select-menu:visible').getByText(label,{exact:false}).first().waitFor();
 await page.keyboard.press('Escape');
}
async function openBatch(page,title){
 await page.getByRole('button',{name:zh.dns.multi.menu+' ▾',exact:true}).click();
 await page.getByText(title,{exact:true}).click();
 const modal=page.locator('.n-modal').filter({hasText:title});await modal.waitFor();return modal;
}
try{
 browser=await chromium.launch({headless:true});
 for(const width of [1440,390])for(const dark of [false,true]){
  reset();scenario='ssl';
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:dark?'dark':'light',reducedMotion:'reduce'});
  await context.addInitScript(dark=>{localStorage.setItem('api_token','synthetic');localStorage.setItem('dns_selected_account','__all__');localStorage.setItem('themeMode',dark?'dark':'light');localStorage.setItem('app_locale','zh-CN');},dark);
  const page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}${base}/dns`);await page.getByText('third.test',{exact:true}).waitFor();
  await openAccounts(page,'.page-view > .n-space .n-select');
  await page.getByRole('button',{name:zh.dns.addDomain,exact:true}).click();await openAccounts(page,'.n-modal .n-select');await page.locator('.n-modal').getByRole('button',{name:zh.common.close,exact:true}).click();
  await page.getByRole('button',{name:zh.dns.multi.selectSearch.replace('{count}','4'),exact:true}).click();
  let modal=await openBatch(page,zh.dns.zoneOperations.sslTitle);
  await page.keyboard.press('Escape');assert.equal(await modal.count(),1);
  await page.mouse.click(2,2);assert.equal(await modal.count(),1);
  const button=modal.getByRole('button',{name:zh.dns.zoneOperations.execute,exact:true});assert(await button.isDisabled());
  await modal.locator('.n-select').first().click();await page.locator('.n-base-select-menu:visible').getByText('Full (Strict)',{exact:true}).click();
  await modal.getByRole('checkbox').click();await button.click();
  assert(await modal.getByRole('button',{name:zh.common.close,exact:true}).isDisabled());
  await modal.getByText(zh.dns.zoneOperations.summary.replace('{total}','4').replace('{success}','1').replace('{partial}','0').replace('{failed}','1').replace('{uncertain}','1').replace('{skipped}','1'),{exact:true}).waitFor();
  assert.deepEqual(writes.map(row=>row.zoneId).sort(),['a','b','c']);assert(gets.every(row=>row.refresh==='true'));
  assert.equal(await button.count(),0);
  const box=await modal.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1);
  await modal.getByRole('button',{name:zh.common.close,exact:true}).click();
  writes=[];scenario='purge';modal=await openBatch(page,zh.dns.zoneOperations.purgeTitle);
  await modal.getByRole('checkbox').click();await modal.getByRole('button',{name:zh.dns.zoneOperations.execute,exact:true}).click();
  await modal.getByText('请求回执：purge-c-receipt',{exact:true}).waitFor();
  assert.deepEqual(writes.map(row=>row.zoneId).sort(),['a','b','c']);
  assert.equal(await modal.getByRole('button',{name:zh.dns.zoneOperations.execute,exact:true}).count(),0);
  await modal.getByRole('button',{name:zh.common.close,exact:true}).click();
  // Account selectors across each feature retain authoritative Credential names.
  for(const [route,selector]of [['/storage','.storage-account-selector .n-select'],['/tunnels','.tunnel-tab-content .n-select'],['/browser-render','.page-view .n-select'],...['chat','image','audio','translate'].map(tab=>[`/ai?tab=${tab}`,'.n-tab-pane:visible .n-select'])]){
   await page.goto(`${origin}${base}${route}`);
   await openAccounts(page,selector,route.startsWith('/ai')?[labels[0]]:labels);
  }
  await page.goto(`${origin}${base}/workers`);await page.getByRole('button',{name:zh.workers.deploy,exact:true}).click();await openAccounts(page,'.n-modal .n-select');
  await page.goto(`${origin}${base}/store`);await page.getByRole('button',{name:zh.storeCard.deploy,exact:true}).first().click();await openAccounts(page,'.n-modal .n-select');
  await page.goto(`${origin}${base}/settings`);await page.getByRole('button',{name:zh.settings.addTask,exact:true}).click();await page.locator('.n-modal .n-select').first().click();await page.locator('.n-base-select-menu:visible').getByText(zh.settings.taskTypes.kvCleanup,{exact:true}).click();await openAccounts(page,'.n-modal .n-form-item:has(.n-form-item-label:has-text("'+zh.settings.account+'")) .n-select');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,dark,batchSSL:true,batchPurge:true,accountSelectors:12,simulated:true}));
  await context.close();
 }
}catch(error){const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){await page.screenshot({path:'/private/tmp/cf-manager-dns281-failure.png'});console.error((await page.locator('body').innerText()).slice(-3000));console.error(JSON.stringify({scenario,writes}));}throw error;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
