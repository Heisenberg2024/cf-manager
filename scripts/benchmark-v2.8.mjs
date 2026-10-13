import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'backend/package.json'));
const ts = require('typescript');
const baseline = '79978a9a2f5e22571f4a3856f28432d4bc52fae7';
const temporary = mkdtempSync('/private/tmp/cf-manager-v28-benchmark-');
function load(name, old) {
  const file = resolve(temporary, `${old ? 'old' : 'new'}-${name}.cjs`);
  let source = old ? execFileSync('git', ['show', `${baseline}:shared/${name}.ts`], {cwd: root, encoding:'utf8'}) : readFileSync(resolve(root, `shared/${name}.ts`), 'utf8');
  source = source.replace(/from '\.\/([^']+)'/g, (_, dep) => `from './${old ? 'old' : 'new'}-${dep}.cjs'`);
  writeFileSync(file, ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText);
  return require(file);
}
async function measure(old) {
  if(!old)load('zoneSettingsEvents',false);load('cfErrors',old); load('readScheduler',old); load('zoneDirectory',old);
  if(!old) load('resourceCache',false);
  const {readZoneSettings,writeZoneSettings} = load('zoneSettings',old);
  const results = [];
  for (const count of [20,60]) {
    let calls = 0, patches = 0;
    const read = async (_path, init) => { calls++; if(init?.method === 'PATCH') patches++; await new Promise(r=>setTimeout(r,2)); return {result:[{id:'ssl',value:'full',editable:true},{id:'cache_level',value:'aggressive',editable:true}]}; };
    const {ZoneDirectory}=require(resolve(temporary,`${old?'old':'new'}-zoneDirectory.cjs`));const directory=new ZoneDirectory();
    let cache;
    if (!old) { try { const {BoundReadCache} = load('resourceCache',false); cache = new BoundReadCache(directory); } catch(error) { if(error.code !== 'ENOENT') throw error; } }
    const binding=i=>({id:i+1,name:'fixture',account_id:`cf-${i}`,credential_id:i+1,is_active:1,enabled_features:'dns'});
    const settings = i => cache ? cache.read(binding(i),`zone:z-${i}`,(signal)=>readZoneSettings((path,init)=>read(path,{...init,signal}),`z-${i}`)).then(x=>x.value) : readZoneSettings(directory.wrap(binding(i),read),`z-${i}`);
    const times = []; let firstCalls=0;
    for(let n=0;n<10;n++){ cache?.invalidate(); calls=0; const start=performance.now(); await Promise.all(Array.from({length:count},(_,i)=>settings(i))); times.push(performance.now()-start); firstCalls=calls; }
    calls=0; const revisitStart=performance.now(); await Promise.all(Array.from({length:count},(_,i)=>settings(i))); const revisit={calls,durationMs:performance.now()-revisitStart};
    cache?.invalidate(); calls=0; await Promise.all(Array.from({length:10},()=>settings(0))); const concurrentCalls=calls;
    calls=0;patches=0;await writeZoneSettings(read,'z-0',{}); const noChanges={calls,patches};
    times.sort((a,b)=>a-b); results.push({accounts:count,coldCalls:firstCalls,p50Ms:times[4],p95Ms:times[9],revisit,concurrentCalls,noChanges,cacheEntries:cache?.size ?? 0});
  }
  return results;
}
async function matrix(old,count,zones=count,mixed=false) {
  load('cfErrors',old);load('readScheduler',old);const {ZoneDirectory}=load('zoneDirectory',old);
  if(!old){load('zoneSettingsEvents',false);load('resourceCache',false);}
  const {readZoneSettings,ZoneSettingsRuntime}=load('zoneSettings',old),directory=new ZoneDirectory(),runtime=old?undefined:new ZoneSettingsRuntime(directory);
  let calls=0;const times=[];const binding=i=>({id:i+1,name:'fixture',account_id:`cf-${i}`,credential_id:i+1,is_active:1,enabled_features:'dns'});
  const read=i=>{const account=binding(i%count),request=async()=>{calls++;await new Promise(r=>setTimeout(r,mixed&&account.id%5===0?20:2));if(mixed&&account.id%7===0)throw Object.assign(Error('Synthetic permission denied'),{statusCode:403});return {result:[{id:'ssl',value:'full',editable:true}]};};return runtime?runtime.read(account,request,`zone-${i}`):readZoneSettings(directory.wrap(account,request),`zone-${i}`);};
  let results,coldCalls;
  for(let n=0;n<10;n++){runtime?.invalidate();calls=0;const start=performance.now();results=await Promise.allSettled(Array.from({length:zones},(_,i)=>read(i)));times.push(performance.now()-start);coldCalls=calls;}
  calls=0;const start=performance.now();await Promise.allSettled(Array.from({length:zones},(_,i)=>read(i)));const revisit={calls,durationMs:performance.now()-start};times.sort((a,b)=>a-b);
  return {accounts:count,zones,mixed,coldCalls,failedZones:results.filter(x=>x.status==='rejected').length,p50Ms:times[4],p95Ms:times[9],revisit,cacheEntries:runtime?.cache.size || 0,cacheEstimatedBytes:runtime?.cache.bytes || 0};
}
try { const before=await measure(true),after=await measure(false);const zoneMatrix=[];for(const count of [20,60])for(const [zones,mixed] of [[100,false],[1000,false],[count,true]])zoneMatrix.push({before:await matrix(true,count,zones,mixed),after:await matrix(false,count,zones,mixed)}); const report={simulated:true,baseline,runtime:process.version,fixture:'2ms per request; same v2.7 ReadScheduler on both sides; 10 cold samples; P95=max; excludes common live ownership GET; no production accounts',before,after,zoneMatrix}; const output=process.argv[2]||resolve(root,'docs/performance-v2.8-baseline.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2)); }
finally {rmSync(temporary,{recursive:true,force:true});}
