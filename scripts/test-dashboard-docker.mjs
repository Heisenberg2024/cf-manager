// Isolated Docker acceptance using the real Express executor/SQLite, with ALL Cloudflare I/O replaced.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image=process.argv[2]||'cf-manager:codex-v2.10.1',prefix=`cfm-scan-${randomUUID().slice(0,8)}`,volume=`${prefix}-data`,containers=[],temp=mkdtempSync('/private/tmp/cfm-docker-scan-');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const script=resolve(temp,'fixture.cjs');
writeFileSync(script,`
const {initDb,getDb}=require('/app/dist/db');initDb();const db=getDb();
if(!db.prepare('SELECT id FROM accounts LIMIT 1').get())db.transaction(()=>{for(let i=1;i<=4;i++){db.prepare("INSERT INTO credentials(id,name,auth_type,api_token,status) VALUES(?,?,'token','synthetic-ciphertext','active')").run(i,'Synthetic Credential '+i);db.prepare("INSERT INTO accounts(id,name,account_id,credential_id,auth_type,enabled_features,access_status,last_checked_at) VALUES(?,?,?,?,'token','dns,workers,storage','available',CURRENT_TIMESTAMP)").run(i,'Synthetic Account '+i,i.toString(16).padStart(32,'0'),i);}})();
const factory=require('/app/dist/services/cfFactory');factory.getCfClient=()=>{throw Error('Synthetic test forbids real Cloudflare SDK I/O');};
factory.accountRequest=a=>async(path,init={})=>{
 init.signal?.throwIfAborted();if(init.method&&init.method!=='GET')throw Error('Inventory must only issue GET');
 const metric=path.startsWith('/zones')?'zones':path.includes('workers/scripts')?'workers':path.includes('pages/projects')?'pages':path.includes('cfd_tunnel')?'tunnels':path.includes('kv/namespaces')?'kv':path.includes('d1/database')?'d1':'r2';
 const key='fixture_calls/'+a.id+'/'+metric;db.prepare("INSERT INTO app_settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run(key);
 await new Promise((yes,no)=>{const timer=setTimeout(yes,600);init.signal?.addEventListener('abort',()=>{clearTimeout(timer);no(init.signal.reason);},{once:true});});
 if(metric==='zones')return {result:[{id:'z1',name:'synthetic.test',status:'active',account:{id:a.account_id}}],result_info:{total_count:1,total_pages:1}};
 if(metric==='pages'){if(path.includes('per_page'))throw Error('Pages cannot send per_page');return {result:[{id:'p1',name:'synthetic-page'}],result_info:{page:1,per_page:10,count:1,total_pages:1,total_count:1}};}
 if(metric==='tunnels')return {result:[{id:'t1',status:'healthy'}],result_info:{total_count:1,total_pages:1}};
 if(metric==='d1')return {result:[{uuid:'db1'}],result_info:{total_pages:1}};
 if(metric==='r2')return {result:[],result_info:{is_truncated:false}};
 return {result:[{id:'resource1'}],result_info:{total_pages:1}};
};
const runtime=require('/app/dist/services/dashboardRuntime').dashboardRuntime;runtime.request=async a=>factory.accountRequest(a);
require('/app/dist/index');
`);
function start(label){const name=`${prefix}-${label}`;containers.push(name);docker('create','--name',name,'-p','127.0.0.1::3000','-v',`${volume}:/app/data`,'-e','DB_PATH=/app/data/cf-manager.db','-e','ENCRYPTION_KEY=synthetic-key','-e','API_SECRET=synthetic-secret','-e','FILE_LOGGING=false','-e','DOTENV_CONFIG_QUIET=true','-e','DASHBOARD_SCAN_STARTUP_DELAY=0','-e','DASHBOARD_SCAN_CONCURRENCY=2',image,'node','/app/fixture.cjs');docker('cp',script,`${name}:/app/fixture.cjs`);docker('start',name);const info=JSON.parse(docker('inspect',name))[0];return {name,url:`http://127.0.0.1:${info.NetworkSettings.Ports['3000/tcp'][0].HostPort}`};}
const headers={Authorization:'Bearer synthetic-secret','Content-Type':'application/json'};
async function status(c){const r=await fetch(c.url+'/api/dashboard/scan/status',{headers});if(!r.ok)throw Error('Status '+r.status);return (await r.json()).data;}
async function wait(c,predicate,max=150000){const started=Date.now();for(;;){try{const s=await status(c);if(predicate(s))return s;}catch{}if(Date.now()-started>max)throw Error('Timed out: '+docker('logs',c.name));await sleep(250);}}
let report;
try{docker('volume','create',volume);const first=start('first');await wait(first,s=>s.job?.completed>=2&&s.job.currentResource.length>0);const original=await status(first);assert(original.job.completed<28);const checkpoints=JSON.parse(docker('exec',first.name,'node','-e',"const {getDb}=require('/app/dist/db');console.log(JSON.stringify(getDb().prepare(\"SELECT account_id,metric FROM dashboard_scan_items WHERE state='completed'\").all()))"));
 const overview=await fetch(first.url+'/api/dashboard/overview',{headers});assert.equal((await overview.json()).data.counts.bindings,4);
 docker('kill','--signal','KILL',first.name);const restartAt=Date.now(),second=start('restart');const resumed=await wait(second,s=>s.job?.jobId===original.job.jobId);assert(resumed.job.completed>=original.job.completed);const recovered=await wait(second,s=>s.state==='completed');assert.equal(recovered.job.completed,28);assert.equal(recovered.job.succeeded,28);
 const calls=JSON.parse(docker('exec',second.name,'node','-e',"const {getDb}=require('/app/dist/db');console.log(JSON.stringify(getDb().prepare(\"SELECT key,CAST(value AS INTEGER) AS count FROM app_settings WHERE key LIKE 'fixture_calls/%'\").all()))"));for(const item of checkpoints)assert.equal(calls.find(c=>c.key===`fixture_calls/${item.account_id}/${item.metric}`).count,1,'Completed resources must not be reread after restart');
 const resources=await fetch(second.url+'/api/dashboard/resources',{headers});assert((await resources.json()).data.metrics.every(m=>m.complete&&m.state==='ready'));
 await fetch(second.url+'/api/dashboard/scan/start',{method:'POST',headers,body:'{"reason":"manual","force":true}'});await wait(second,s=>s.job?.currentResource.length>0);const graceful=await status(second);docker('stop','--time','28',second.name);const gracefulStart=Date.now(),third=start('graceful-restart');const restored=await wait(third,s=>s.job?.jobId===graceful.job.jobId);assert(restored.job.completed>=graceful.job.completed);const final=await wait(third,s=>s.state==='completed');assert.equal(final.job.completed,28);
 report={synthetic:true,image,accounts:4,total:28,crash:{jobId:original.job.jobId,completedBeforeKill:original.job.completed,recoveredState:recovered.state,resumeMs:recovered.job.finishedAt-restartAt,completedResourcesNotReread:true,leaseMs:90000},graceful:{jobId:graceful.job.jobId,completedBeforeStop:graceful.job.completed,completed:final.job.completed,resumeMs:final.job.finishedAt-gracefulStart},simulatedCloudflareCalls:calls.reduce((n,c)=>n+c.count,0),realCloudflareCalls:0};
 writeFileSync('docs/dashboard-docker-v2.10.1.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{for(const name of containers)try{docker('rm','-f',name);}catch{}try{docker('volume','rm',volume);}catch{}rmSync(temp,{recursive:true,force:true});}
