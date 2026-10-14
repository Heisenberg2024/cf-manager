/** Actual Express/SQLite routes; synthetic CF transport and temporary DB only, no build needed. */
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(resolve(root,'backend/package.json'));
require('ts-node').register({project:resolve(root,'backend/tsconfig.json'),transpileOnly:true});
const temporary=mkdtempSync('/private/tmp/cfm-usage-r2-');
// Stub configuration before loading application modules; never read the real .env or database.
require.cache[resolve(root,'backend/src/config.ts')]={exports:{config:{port:0,encryptionKey:'synthetic',apiSecret:'synthetic',dbPath:resolve(temporary,'fixture.db'),logDir:temporary,fileLogging:false,proxyUrl:'',demoAccountIds:'',workerDeployUrlAllowlist:'',dashboardScan:{DASHBOARD_AUTO_COLLECT:'true',DASHBOARD_SCAN_STARTUP_DELAY:'0'}}}};
const {initDb,getDb}=require(resolve(root,'backend/src/db.ts'));
initDb();const db=getDb();
const {dashboardRuntime:runtime}=require(resolve(root,'backend/src/services/dashboardRuntime.ts'));
const {dashboardScan:scan,dashboardScanExecutor:executor}=require(resolve(root,'backend/src/services/dashboardScanRuntime.ts'));
const credentials=db.prepare("INSERT INTO credentials(id,name,auth_type,api_token,status) VALUES(?,?,'token','synthetic','active')");
const accounts=db.prepare("INSERT INTO accounts(id,name,auth_type,credential_id,account_id,access_status,available_features) VALUES(?,?,'token',?,?,'available',?)");
for(let id=1;id<=10;id++){credentials.run(id,`Credential ${id}`);accounts.run(id,`Account ${id}`,id,id.toString(16).padStart(32,'0'),id<=2?'r2':'-r2');}
const calls=[];
runtime.request=async a=>async(path)=>{
 calls.push({accountId:a.id,path});
 if(path==='/graphql')return {data:{viewer:{accounts:[{workers:[{sum:{requests:a.id<=2?a.id*120:0}}],pages:[{sum:{requests:a.id<=2?a.id*5:0}}]}]}}};
 if(path.startsWith('/zones'))return {result:[],result_info:{total_pages:1,total_count:0}};
 if(path.includes('workers/scripts'))return {result:[{id:'worker1'}]};
 if(path.includes('pages/projects'))return {result:[],result_info:{page:1,per_page:10,count:0,total_pages:1,total_count:0}};
 if(path.includes('r2/buckets')){assert.ok(a.id<=2);return {result:[{name:'bucket1'},{name:'bucket2'}],result_info:{is_truncated:false}};}
 return {result:[],result_info:{total_pages:1,total_count:0}};
};
executor.wake=()=>{};
const express=require('express'),app=express();app.use(express.json());
app.use('/api',require(resolve(root,'backend/src/middleware/responseWrapper.ts')).responseWrapper);
app.use('/api',require(resolve(root,'backend/src/middleware/auth.ts')).authMiddleware);
app.use('/api/dashboard',require(resolve(root,'backend/src/routes/dashboard.ts')).default);
app.use('/api',require(resolve(root,'backend/src/middleware/errorHandler.ts')).errorHandler);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const api=async(path,body)=>{const response=await fetch(`${origin}/api/dashboard${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,200);return (await response.json()).data;};
try{
 assert.deepEqual((await api('/trends?days=7')).usage,[]);
 await api('/scan/start',{reason:'auto'});
 for(let n=0;n<100;n++){if(!['running','queued'].includes((await scan.status()).state))break;await scan.runBatch();}
 const state=await api('/scan/status');assert.equal(state.job.failed,0);assert.equal(state.state,'completed');
 const trend7=await api('/trends?days=7'),trend30=await api('/trends?days=30');
 assert.deepEqual(trend7.usage,[{date:new Date().toISOString().slice(0,10),resource:'workers_requests',count:375}]);
 assert.deepEqual(trend30.usage,trend7.usage);assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_usage').get().n,10);
 const resources=await api('/resources'),r2=resources.metrics.find(m=>m.metric==='r2');
 assert.deepEqual({value:r2.value,total:r2.totalAccounts,covered:r2.coveredAccounts,state:r2.state,error:r2.errorKind},{value:4,total:2,covered:2,state:'ready',error:null});
 assert.deepEqual(resources.issues.filter(i=>i.source==='r2'),[]);assert.equal(calls.filter(c=>c.path.includes('r2/buckets')).length,2);
 const before=calls.length;await api('/scan/start',{reason:'auto'});await api('/resources');await api('/trends?days=7');assert.equal(calls.length,before);
 const report={synthetic:true,source:'current TypeScript Express routes / isolated on-disk SQLite',accounts:10,r2ReadableAccounts:2,r2Buckets:r2.value,usage:trend7.usage,observedAccounts:10,scanFailures:0,r2Failures:0,extraCfCallsAfterReload:0};
 writeFileSync(resolve(root,'docs/dashboard-usage-r2-v2.10.2.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await new Promise(r=>server.close(r));db.close();rmSync(temporary,{recursive:true,force:true});}
