// Reproduce the real pre-optimization implementation without touching the user's checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineRef = process.argv[2] || '7d45afd49ca307ca3264ef8c23ab5e3a7da51b6a';
const output = process.argv[3] || '/private/tmp/cf-manager-dns-benchmark.json';
const temporary = mkdtempSync('/private/tmp/cf-manager-dns-baseline-');
function run(cwd, name) {
  const resultPath = resolve(temporary, `${name}.json`);
  execFileSync('npm', ['test', '--', 'tests/dnsPerformance.test.ts', '--reporter=dot'], { cwd, env: { ...process.env, DNS_PERFORMANCE_OUTPUT: resultPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(readFileSync(resultPath, 'utf8'));
}
try {
  const archive = execFileSync('git', ['archive', baselineRef], { cwd: root, maxBuffer: 30 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', temporary], { input: archive });
  symlinkSync(resolve(root, 'backend/node_modules'), resolve(temporary, 'backend/node_modules'));
  cpSync(resolve(root, 'backend/tests/dnsPerformance.test.ts'), resolve(temporary, 'backend/tests/dnsPerformance.test.ts'));
  execFileSync('node', ['scripts/sync-shared.js'], { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
  const before = run(resolve(temporary, 'backend'), 'before');
  const after = run(resolve(root, 'backend'), 'after');
  const result = { baselineRef, runtime: process.version, scenario: '20 Accounts, 600 Zones, synthetic 5ms/page; local Vitest, not production latency', before, after };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
