import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const baseline=process.argv[2] || '43567701e1062837454b78125aa56f63935e40b5';
const output=process.argv[3] || resolve(root,'docs/performance-v2.7-baseline.json');
const temporary=mkdtempSync('/private/tmp/cf-manager-v27-baseline-');
function run(directory,label) {const report=resolve(temporary,`${label}.json`);execFileSync('npm',['test','--','tests/workersPerformance.test.ts'],{cwd:resolve(directory,'backend'),env:{...process.env,WORKERS_PERFORMANCE_OUTPUT:report},stdio:['ignore','pipe','pipe']});return JSON.parse(readFileSync(report,'utf8'));}
try {
 execFileSync('tar',['-x','-C',temporary],{input:execFileSync('git',['archive',baseline],{cwd:root,maxBuffer:30*1024*1024})});
 symlinkSync(resolve(root,'backend/node_modules'),resolve(temporary,'backend/node_modules'));
 cpSync(resolve(root,'backend/tests/workersPerformance.test.ts'),resolve(temporary,'backend/tests/workersPerformance.test.ts'));
 execFileSync('node',['scripts/sync-shared.js'],{cwd:temporary,stdio:['ignore','pipe','pipe']});
 const before=run(temporary,'before'),after=run(root,'after');
 const report={baseline,runtime:process.version,before,after};writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {rmSync(temporary,{recursive:true,force:true});}
