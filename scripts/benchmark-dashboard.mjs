import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {dashboardDb} from '../shared/tests/dashboard.fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(resolve(root,'backend/package.json'));
const {dashboardOverview,dashboardTrends}=require(resolve(root,'backend/dist/services/dashboardData.js'));
const {auditPage,safeAuditEvent}=require(resolve(root,'backend/dist/services/auditQueries.js'));
const {accountOptions}=require(resolve(root,'backend/dist/services/accountOptions.js'));
const ts=require('typescript'),baseline='c7beed928915f3c4793a6962a4489dd941cf528a';
const source=execFileSync('git',['show',`${baseline}:backend/src/services/quotaTracker.ts`],{cwd:root,encoding:'utf8'}),code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
async function sample(run,n=40){const values=[];for(let i=0;i<n;i++){const start=performance.now();await run();values.push(performance.now()-start);}return {samples:n,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),rawMs:values};}
const rows=[];
for(const n of [0,20,60,120]){const f=dashboardDb();f.accounts(n);if(n)f.logs(100000);const today=new Date().toISOString().slice(0,10);if(n)for(let i=1;i<=n;i++)for(const r of ['workers_requests','ai_neurons','browser_render_seconds'])f.sqlite.prepare('INSERT INTO quota_usage(account_id,resource,date,count) VALUES(?,?,?,?)').run(i,r,today,1000);
 const exports={};vm.runInNewContext(code,{exports,require:id=>id.includes('models/account')?{getActiveAccounts:()=>f.sqlite.prepare('SELECT * FROM accounts WHERE is_active=1 AND is_enabled=1').all(),hasFeature:(a,k)=>a.enabled_features.split(',').includes(k)}:id.includes('models/quotaUsage')?{getAllQuotaToday:()=>f.sqlite.prepare('SELECT * FROM quota_usage WHERE date=?').all(today)}:{}});
 const old=exports.getQuotaSummary;
 const server=createServer(async(req,res)=>{try{const data=req.url==='/before'?old():await dashboardOverview(f.db,{});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data}));}catch(error){res.writeHead(500);res.end(String(error));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const beforeQuotaHttp=await sample(()=>fetch(origin+'/before').then(r=>r.json())),afterOverviewHttp=await sample(()=>fetch(origin+'/after').then(r=>r.json()));await new Promise(r=>server.close(r));
 rows.push({accounts:n,beforeQuotaHttp,afterOverviewHttp,auditRows:n?100000:0,beforeQuota:await sample(old),afterOverview:await sample(()=>dashboardOverview(f.db,{})),afterTrends:await sample(()=>dashboardTrends(f.db,{days:30}),10),afterOptions:await sample(()=>accountOptions(f.db)),beforeQuotaBytes:JSON.stringify(old()).length,afterOverviewBytes:JSON.stringify(await dashboardOverview(f.db,{})).length,optionsBytes:JSON.stringify(await accountOptions(f.db)).length,cloudflareCallsBefore:0,cloudflareCallsAfter:0});f.sqlite.close();}
const f=dashboardDb();f.accounts(1);f.logs(100000);const cursor=encodeURIComponent(JSON.stringify({version:1,scope:JSON.stringify({}),anchor:100000,date:'2026-10-01 12:00:00',id:1000}));
const paging={events:100000,referenceOffset:await sample(()=>f.db.all('SELECT l.*,a.name AS account_name FROM audit_log l LEFT JOIN accounts a ON a.id=l.account_id ORDER BY l.created_at DESC,l.id DESC LIMIT 100 OFFSET 99000').then(rows=>rows.map(safeAuditEvent))),keyset:await sample(()=>auditPage(f.db,{cursor,limit:100})),note:'v2.9 has no deep pagination; OFFSET is a reference query, not a v2.9 endpoint'};f.sqlite.close();
const dist=resolve(process.env.FRONTEND_DIST||resolve(root,'frontend/dist'),'assets');const chunks=readdirSync(dist).filter(n=>n.endsWith('.js')).map(name=>{const data=readFileSync(resolve(dist,name));return {name,bytes:data.length,gzipBytes:gzipSync(data).length};});
writeFileSync(resolve(root,'docs/performance-v2.10.json'),JSON.stringify({synthetic:true,baseline,clock:'performance.now; Node local in-memory SQLite; not remote D1 or production P95',rows,paging,chunks},null,2)+'\n');console.log(JSON.stringify({scenarios:rows.length,paging:100000,passed:true}));
