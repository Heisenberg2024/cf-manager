#!/usr/bin/env node
// Exercises the image's compiled resource reader without credentials, volumes or networking.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../worker/package.json', import.meta.url));
const { buildSync } = require('esbuild');
const version = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').match(/^##\s+\[(\d+\.\d+\.\d+)\]/m)[1];
const fixture = buildSync({ entryPoints: [new URL('../shared/tests/cloudflareWorkerResources.fixture.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const input = `
const assert = require('node:assert/strict');
const { WorkerResources } = require('./dist/services/workerResources');
const { ZoneDirectory } = require('./dist/services/zoneDirectory');
const { VERSION } = require('./dist/version');
const fixtureModule = { exports: {} };
(function(module) { ${fixture} })(fixtureModule);
const { cloudflareWorkerFixture, pagesEnvelope } = fixtureModule.exports;
const account = { id: 1, name: 'Synthetic', account_id: 'cf-a', credential_id: 10, auth_type: 'global_key', api_key: 'synthetic-ciphertext', email: 'synthetic@example.invalid', is_active: 1, is_enabled: 1, enabled_features: 'workers' };
(async () => {
  assert.equal(VERSION, ${JSON.stringify(version)});
  const f = cloudflareWorkerFixture(), cache = new WorkerResources(new ZoneDirectory());
  const [summary, list] = await Promise.all([cache.summary(account, f.request, { usage: false }), cache.list(account, f.request)]);
  assert.equal(summary.workerCount, 21); assert.equal(summary.pagesCount, 20); assert.equal(list.items.length, 41);
  assert.deepEqual([...f.calls].sort(), ['/accounts/cf-a/pages/projects?page=1', '/accounts/cf-a/pages/projects?page=2', '/accounts/cf-a/workers/scripts']);
  console.log('PASS image version, SinglePage Workers, 10 + 10 Pages, 41 resources and shared requests');

  cache.invalidate();
  const broken = (path, init) => f.request(path.includes('/pages/projects') ? path + '&per_page=100' : path, init);
  await assert.rejects(cache.read(account, broken, 'pages'), /Code 8000024/);
  const failed = await cache.summary(account, f.request, { usage: false });
  assert.equal(failed.workerCount, 21); assert.equal(failed.pagesCount, null); assert.equal(failed.states.pages, 'error');
  const beforeRefresh = f.calls.length;
  assert.equal((await cache.list(account, f.request)).items.length, 21); assert.equal(f.calls.length, beforeRefresh);
  assert.equal((await cache.list(account, f.request, { refresh: true })).items.length, 41); assert.equal(f.calls.length, beforeRefresh + 3);
  console.log('PASS Code 8000024, ordinary negative cache, confirmed Workers and forced upstream refresh');

  cache.invalidate();
  const duplicate = async (path, init) => {
    const data = await f.request(path, init);
    if (path.endsWith('?page=2')) data.result = pagesEnvelope(1).result;
    return data;
  };
  const incomplete = await cache.summary(account, duplicate, { usage: false });
  assert.equal(incomplete.workerCount, 21); assert.equal(incomplete.pagesCount, null);
  assert.equal((await cache.list(account, duplicate)).items.length, 21);
  console.log('PASS duplicate second page cannot become a complete successful Pages cache');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
const result = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'node', process.argv[2] || 'cf-manager:codex-v2.8.2', '-'], { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
