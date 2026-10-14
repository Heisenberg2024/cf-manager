import {execFileSync} from 'node:child_process';
import {mkdtempSync,symlinkSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temporary=mkdtempSync('/private/tmp/cfm-dashboard-before-');
try{execFileSync('tar',['-x','-C',temporary],{input:execFileSync('git',['archive','c7beed928915f3c4793a6962a4489dd941cf528a'],{cwd:root,maxBuffer:30*1024*1024})});symlinkSync(resolve(root,'frontend/node_modules'),resolve(temporary,'frontend/node_modules'));
execFileSync('npm',['run','build'],{cwd:resolve(temporary,'frontend'),stdio:'pipe'});
const chunks=readdirSync(resolve(temporary,'frontend/dist/assets')).filter(n=>n.endsWith('.js')).map(name=>{const data=readFileSync(resolve(temporary,'frontend/dist/assets',name));return {name,bytes:data.length,gzipBytes:gzipSync(data).length};});writeFileSync(resolve(root,'docs/performance-v2.10-chunks-before.json'),JSON.stringify({baseline:'c7beed9',chunks},null,2)+'\n');
execFileSync('node',[resolve(root,'scripts/test-dashboard-ui.mjs')],{cwd:root,env:{...process.env,BASELINE_UI:'true',FRONTEND_DIST:resolve(temporary,'frontend/dist'),UI_REPORT:resolve(root,'docs/performance-v2.10-ui-before.json')},stdio:'inherit'});
}finally{rmSync(temporary,{recursive:true,force:true});}
