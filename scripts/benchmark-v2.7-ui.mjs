// Build the baseline in an isolated read-only Git export; use exactly the same DNS browser fixture.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const baseline=process.argv[2] || '43567701e1062837454b78125aa56f63935e40b5';
const temporary=mkdtempSync('/private/tmp/cf-manager-v27-browser-baseline-');
try {
 execFileSync('tar',['-x','-C',temporary],{input:execFileSync('git',['archive',baseline],{cwd:root,maxBuffer:30*1024*1024})});
 symlinkSync(resolve(root,'frontend/node_modules'),resolve(temporary,'frontend/node_modules'));
 execFileSync('npm',['run','build'],{cwd:resolve(temporary,'frontend'),stdio:['ignore','pipe','pipe']});
 execFileSync('node',[resolve(root,'scripts/test-v2.7-ui.mjs')],{cwd:root,env:{...process.env,BASELINE_UI:'true',FRONTEND_DIST:resolve(temporary,'frontend/dist'),UI_REPORT:resolve(root,'docs/performance-v2.7-ui-before.json')},stdio:'inherit'});
}finally{rmSync(temporary,{recursive:true,force:true});}
