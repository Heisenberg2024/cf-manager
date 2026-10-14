// Same synthetic transport for v2.8.2 verbatim services and current shared runtimes.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(resolve(root, 'backend/package.json')), ts = require('typescript');
const temporary = mkdtempSync('/private/tmp/cfm-tunnels-benchmark-'), baseline = '7a317de40bb05ea93834ed1ecc75e039e1c8da3e';
const { TunnelResources } = require(resolve(root, 'backend/dist/services/tunnelResources.js'));
const { RulesResources } = require(resolve(root, 'backend/dist/services/rulesResources.js'));
const { ZoneDirectory } = require(resolve(root, 'backend/dist/services/zoneDirectory.js'));
const account = i => ({ id: i + 1, name: 'fixture', account_id: `${i + 1}`.padStart(32, '0'), credential_id: i + 10, is_enabled: 1, is_active: 1, enabled_features: 'dns' });
const compile = (source, file) => writeFileSync(resolve(temporary, file), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
compile(execFileSync('git', ['show', `${baseline}:backend/src/services/tunnelService.ts`], { cwd: root, encoding: 'utf8' }).replaceAll("'./", "'./old-").replace("'../models/account'", "'./old-account'"), 'old-tunnelService.cjs');
compile(execFileSync('git', ['show', `${baseline}:backend/src/services/rulesetService.ts`], { cwd: root, encoding: 'utf8' }).replaceAll("'./", "'./old-"), 'old-rulesetService.cjs');
writeFileSync(resolve(temporary, 'old-cfFactory.js'), 'exports.getCfClient=(a)=>globalThis.cfmBenchmark.sdk(a);exports.accountRequest=()=>globalThis.cfmBenchmark.request;');
writeFileSync(resolve(temporary, 'old-account.js'), 'exports.getAllAccounts=()=>[];');
writeFileSync(resolve(temporary, 'old-accountZones.js'), `exports.accountZones=async(d,a,r)=>(await d.list(a,r)).zones;`);
writeFileSync(resolve(temporary, 'old-dnsDirectory.js'), 'exports.dnsDirectory={list:(...args)=>globalThis.cfmBenchmark.directory.list(...args)};');
const oldTunnel = require(resolve(temporary, 'old-tunnelService.cjs')), oldRules = require(resolve(temporary, 'old-rulesetService.cjs'));
const metrics = [], output = [];
function environment(zonesCount, ingressCount, mixed = false) {
  let calls = 0; const kinds = {}; const directory = new ZoneDirectory(e => metrics.push(e));
  const config = { originRequest: { noTLSVerify: true }, ingress: [...Array.from({ length: ingressCount }, (_, i) => ({ hostname: `h${i}.zone0.test`, path: '^/api', service: 'ssh://host:22', originRequest: { connectTimeout: 10 } })), { service: 'http_status:503' }] };
  const tunnelRows = Array.from({ length: 5 }, (_, i) => ({ id: `t${i + 1}`, name: `fixture-${i}`, config_src: 'cloudflare' }));
  const delay = async (kind, a = account(0)) => { calls++; kinds[kind] = (kinds[kind] || 0) + 1; await new Promise(r => setTimeout(r, mixed && a.id % 5 === 0 ? 8 : 1)); if (mixed && a.id % 7 === 0) throw Object.assign(Error('Synthetic 403'), { statusCode: 403 }); };
  const zones = a => Array.from({ length: zonesCount }, (_, i) => ({ id: `z${i}`, name: `zone${i}.test`, account: { id: a.account_id } }));
  const rule = { id: 'rs1', phase: 'http_request_origin', kind: 'zone', rules: [{ id: 'r1', action: 'route', expression: 'true' }] };
  const rulesets = [rule, { id: 'rs2', phase: 'http_request_transform', kind: 'zone', rules: [{ id: 'r2', action: 'rewrite', expression: 'true' }] }];
  const request = async (path, init = {}) => {
    const u = new URL(path, 'https://fixture'), i = Math.max(0, Number(u.pathname.split('/')[2]) - 1), a = u.pathname.startsWith('/accounts/') ? account(i) : account(0);
    if (u.pathname === '/zones') { await delay('zones', a); const page = Number(u.searchParams.get('page') || 1), rows = zones(a).slice((page - 1) * 50, page * 50); return { result: rows, result_info: { total_pages: Math.ceil(zonesCount / 50) } }; }
    if (u.pathname.endsWith('/cfd_tunnel')) { await delay('tunnels', a); return { result: tunnelRows, result_info: { total_pages: 1, total_count: tunnelRows.length } }; }
    if (u.pathname.endsWith('/configurations')) { await delay('config', a); return { result: { config, version: 1 } }; }
    if (u.pathname.endsWith('/rulesets')) { await delay('ruleset_ids', a); return { result: rulesets.map(r => ({ ...r, rules: undefined })) }; }
    if (/\/rs[12]$/.test(u.pathname)) { await delay('rule_detail', a); return { result: rulesets.find(r => u.pathname.endsWith('/' + r.id)) }; }
    if (u.pathname.includes('/dns_records')) { await delay('dns', a); return { result: [], result_info: { total_pages: 1 } }; }
    throw Error(`Unknown synthetic path ${path}`);
  };
  const sdk = a => ({ zeroTrust: { tunnels: { cloudflared: { list: async function* () { await delay('tunnels', a); for (const row of tunnelRows) yield row; }, configurations: { get: async () => { await delay('config', a); return { config }; } } } } }, rulesets: { list: async function* () { await delay('ruleset_ids', a); for (const row of rulesets) yield row; }, get: async id => { await delay('rule_detail', a); return rulesets.find(r => r.id === id); } }, dns: { records: { list: async function* () { await delay('dns', a); } } } });
  const tunnel = new TunnelResources(directory, e => metrics.push(e)), rules = new RulesResources(directory, e => metrics.push(e));
  globalThis.cfmBenchmark = { sdk, request, directory };
  return { request, tunnel, rules, config, get calls() { return calls; }, kinds, directory };
}
async function measure(name, run, rounds = 10) {
  const values = []; let calls, kinds, bytes;
  for (let i = 0; i < rounds; i++) { const f = run.fixture(); const start = performance.now(); await run.work(f); values.push(performance.now() - start); calls = f.calls; kinds = f.kinds; bytes = (f.tunnel.cache.bytes + f.rules.cache.bytes); }
  values.sort((a, b) => a - b); return { name, rounds, calls, kinds, p50Ms: values[Math.floor(values.length / 2)], p95Ms: values[Math.min(values.length - 1, Math.floor(values.length * .95))], cacheBytes: bytes };
}
try {
  for (const count of [20, 60]) for (const old of [true, false]) {
    output.push(await measure(`${old ? 'v2.8.2' : 'v2.9'} current Account / ${count} Accounts`, { fixture: () => environment(100, 50), work: async f => { if (old) { await oldTunnel.listTunnels(account(0)); await Promise.all(Array.from({ length: count }, (_, i) => f.directory.list(account(i), f.request))); } else await f.tunnel.list(account(0), f.request); } }));
    output.push(await measure(`${old ? 'v2.8.2' : 'v2.9'} mixed Accounts ${count}`, { fixture: () => environment(100, 50, true), work: f => Promise.allSettled(Array.from({ length: count }, (_, i) => old ? oldTunnel.listTunnels(account(i)) : f.tunnel.list(account(i), f.request))) }));
  }
  for (const zones of [100, 1000]) for (const entries of [50, 100]) for (const old of [true, false]) output.push(await measure(`${old ? 'v2.8.2' : 'v2.9'} configured hostnames ${zones} Zones / ${entries} Ingress`, { fixture: () => environment(zones, entries), work: f => old ? oldTunnel.listTunnelHostnames(account(0), 't1') : f.tunnel.hostnames(account(0), f.request, 't1') }, 3));
  for (const old of [true, false]) {
    output.push(await measure(`${old ? 'v2.8.2' : 'v2.9'} 10 cold duplicate Tunnel reads`, { fixture: () => environment(100, 50), work: f => Promise.all(Array.from({ length: 10 }, () => old ? oldTunnel.listTunnels(account(0)) : f.tunnel.list(account(0), f.request))) }));
    output.push(await measure(`${old ? 'v2.8.2' : 'v2.9'} 10 repeated Rules reads`, { fixture: () => environment(100, 50), work: async f => { for (let i = 0; i < 10; i++) { if (old) await oldRules.listRules(account(0), 'z1', 'http_request_origin'); else await f.rules.list(account(0), f.request, 'z1', 'http_request_origin'); } } }));
    output.push(await measure(`${old ? 'v2.8.2' : 'v2.9'} 10 alternating Rules phases`, { fixture: () => environment(100, 50), work: async f => { for (let i = 0; i < 10; i++) { const phase = i % 2 ? 'http_request_origin' : 'http_request_transform'; if (old) await oldRules.listRules(account(0), 'z1', phase); else await f.rules.list(account(0), f.request, 'z1', phase); } } }));
  }
  const eventCounts = {}; for (const e of metrics) eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
  writeFileSync(resolve(root, 'docs/performance-v2.9.json'), JSON.stringify({ simulated: true, baseline, runtime: process.version, transport: '5 Tunnels per Account, 2 Rules phases; 1 ms timer per synthetic CF request; mixed every fifth Account 8 ms, every seventh 403; old services exported verbatim; hostnames compare old DNS discovery to new configured-only display', scheduler: 'global 6 / Account 2; cached bytes estimates UTF-16; latency is local fixture, not production', results: output, eventCounts, processHeapBytes: process.memoryUsage().heapUsed }, null, 2) + '\n');
  console.log(JSON.stringify(output));
} finally { delete globalThis.cfmBenchmark; rmSync(temporary, { recursive: true, force: true }); }
