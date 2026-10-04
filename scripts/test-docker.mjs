#!/usr/bin/env node
// Isolated local acceptance. Creates only task-owned containers/volumes, never calls Cloudflare.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const image = process.argv[2] || 'cf-manager:codex-audit';
const prefix = `cfmgr-test-${Date.now()}`;
const containers = [];
const volumes = [];
const directories = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function logs(name) { const result = spawnSync('docker', ['logs', name], { encoding: 'utf8' }); return `${result.stdout || ''}${result.stderr || ''}`; }
const env = ['-e', 'ENCRYPTION_KEY=test-key', '-e', 'API_SECRET=test-secret', '-e', 'TZ=Asia/Singapore'];
const hardened = ['--user', '1000:1000', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=64m,noexec,nosuid,nodev', '--pids-limit', '200'];
async function start(label, flags = [], variables = []) {
  const name = `${prefix}-${label}`;
  containers.push(name);
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::3000', ...env, ...variables, ...flags, image);
  const started = JSON.parse(docker('inspect', name))[0];
  if (!started.State.Running) throw new Error(`${label} failed: ${logs(name)}`);
  const port = started.NetworkSettings.Ports['3000/tcp'][0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const health = await fetch(`${url}/api/health`);
      if (health.ok && (await health.json()).db_connected) return { name, url };
    } catch { /* Wait for Node startup. */ }
    if (JSON.parse(docker('inspect', name))[0].State.Running === false) throw new Error(`${label} failed: ${logs(name)}`);
    await pause(250);
  }
  throw new Error(`${label} did not become healthy`);
}
function assertRuntime(name) {
  assert.equal(docker('exec', name, 'node', '-e', 'process.stdout.write(String(process.getuid()))'), '1000');
  assert.equal(docker('exec', name, 'sh', '-c', 'test -d "$LOG_DIR" && test ! -d /data/logs && echo ok'), 'ok');
  assert.equal(docker('exec', name, 'stat', '-c', '%u', '/app', '/app/dist', '/app/node_modules'), '0\n0\n0');
  assert.ok(!logs(name).includes('setgroups'));
  assert.equal(JSON.parse(docker('exec', name, 'wget', '-qO-', 'http://localhost:3000/api/health')).db_connected, true);
}
async function api(url, path, method = 'GET') {
  const response = await fetch(`${url}/api${path}`, { method, headers: { Authorization: 'Bearer test-secret' } });
  assert.ok(response.ok, `${path}: ${response.status}`);
  const result = await response.json();
  return result.data;
}
try {
  const normal = await start('default');
  assertRuntime(normal.name);
  console.log('PASS default image runs as UID 1000, logs in data volume, local DB health');
  docker('rm', '-f', normal.name);

  const volume = `${prefix}-data`; volumes.push(volume); docker('volume', 'create', volume);
  const seed = `${prefix}-seed`; containers.push(seed);
  docker('run', '--name', seed, ...env, '-v', `${volume}:/app/data`, '--entrypoint', 'node', image, '-e', `
    const Database = require('better-sqlite3');
    const { encrypt } = require('./dist/services/encryptionService');
    const db = new Database('/app/data/cf-manager.db');
    db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, auth_type TEXT NOT NULL, api_token TEXT, api_key TEXT, email TEXT, account_id TEXT, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    db.prepare('INSERT INTO accounts (id, name, auth_type, api_token, account_id) VALUES (77, ?, ?, ?, ?)').run('Legacy', 'token', encrypt('fixture-cloudflare-token'), 'a'.repeat(32));
    db.close();
  `);
  const locked = await start('hardened', [...hardened, '-v', `${volume}:/app/data`], ['-e', 'DB_PATH=/app/data/cf-manager.db', '-e', 'LOG_DIR=/app/data/logs']);
  assertRuntime(locked.name);
  const state = JSON.parse(docker('inspect', locked.name))[0];
  assert.equal(state.HostConfig.ReadonlyRootfs, true); assert.deepEqual(state.HostConfig.CapDrop, ['ALL']);
  assert.ok(state.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(docker('exec', locked.name, 'node', '-e', "try { require('fs').writeFileSync('/app/should-not-write', 'x'); process.exit(1); } catch(e) { if(e.code !== 'EROFS') process.exit(2); console.log('read-only'); }"), 'read-only');
  let accounts = (await api(locked.url, '/accounts')).accounts;
  assert.equal(accounts[0].id, 77); assert.ok(accounts[0].credential_id); assert.equal(accounts[0].api_token, '***encrypted***');
  docker('exec', locked.name, 'node', '-e', `const { initDb } = require('./dist/db'); initDb(); const { createAccount } = require('./dist/models/account'); const { encrypt } = require('./dist/services/encryptionService'); createAccount({ name: 'Sibling', auth_type: 'token', api_token: encrypt('fixture-cloudflare-token'), account_id: 'b'.repeat(32) });`);
  const credentials = await api(locked.url, '/credentials'); assert.equal(credentials.length, 1); assert.equal(credentials[0].accounts.length, 2);
  assert.ok(!JSON.stringify(credentials).includes('fixture-cloudflare-token'));
  await api(locked.url, '/accounts/77', 'DELETE');
  accounts = (await api(locked.url, '/accounts')).accounts; assert.equal(accounts.length, 1); assert.equal(accounts[0].name, 'Sibling');
  console.log('PASS UID 1000 + read_only + cap_drop ALL + no-new-privileges + init + tmpfs; legacy migration; independent binding deletion');
  docker('rm', '-f', locked.name);

  const restarted = await start('restart', [...hardened, '-v', `${volume}:/app/data`]);
  assert.equal((await api(restarted.url, '/accounts')).accounts[0].name, 'Sibling');
  assert.equal((await api(restarted.url, '/credentials')).length, 1);
  console.log('PASS persistent SQLite survives recreation and repeated migration');
  docker('rm', '-f', restarted.name);

  const root = await start('root', ['--user', '0:0', '--read-only', '--tmpfs', '/app/data:uid=0,gid=0,mode=0700', '--tmpfs', '/tmp:size=64m,noexec,nosuid,nodev']);
  // docker exec defaults to configured root; inspect the application's process, not the exec user.
  assert.ok(docker('exec', root.name, 'sh', '-c', 'cat /proc/1/status').includes('Uid:\t1000\t1000\t1000\t1000'));
  console.log('PASS explicit root startup repairs data only and drops to UID 1000 with read-only /app');
  docker('rm', '-f', root.name);

  const custom = await start('custom', [...hardened, '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700'], ['-e', 'DB_PATH=/app/data/nested/custom.db', '-e', 'LOG_DIR=']);
  assert.equal(docker('exec', custom.name, 'sh', '-c', 'test -f /app/data/nested/custom.db && test -d /app/data/nested/logs && echo ok'), 'ok');
  console.log('PASS custom DB_PATH derives LOG_DIR correctly');
  docker('rm', '-f', custom.name);

  const stdoutOnly = await start('stdout-only', [...hardened, '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700'], ['-e', 'FILE_LOGGING=false', '-e', 'LOG_DIR=/unwritable-logs']);
  assert.equal(docker('exec', stdoutOnly.name, 'node', '-e', "console.log(require('fs').existsSync('/unwritable-logs'))"), 'false');
  console.log('PASS stdout-only mode does not require a writable LOG_DIR');
  docker('rm', '-f', stdoutOnly.name);

  // The checkout lives in Colima's shared home mount; /private/tmp may exist only on the host.
  const bindRoot = mkdtempSync(resolve('.docker-test-')); directories.push(bindRoot); chmodSync(bindRoot, 0o755);
  const bindData = `${bindRoot}/data`; mkdirSync(bindData); chmodSync(bindData, 0o777);
  const bind = await start('bind', [...hardened, '-v', `${bindData}:/app/data`]);
  assertRuntime(bind.name);
  console.log('PASS explicit host bind mount under hardened non-root settings');
  docker('rm', '-f', bind.name);

  const denied = `${prefix}-unwritable`; containers.push(denied);
  docker('run', '-d', '--name', denied, ...env, ...hardened, '--tmpfs', '/app/data:uid=0,gid=0,mode=0500', image);
  for (let attempt = 0; attempt < 40 && JSON.parse(docker('inspect', denied))[0].State.Running; attempt++) await pause(100);
  const failure = JSON.parse(docker('inspect', denied))[0].State;
  assert.equal(failure.ExitCode, 1);
  const failureLogs = logs(denied);
  assert.ok(failureLogs.includes('/app/data is not writable by UID 1000'), failureLogs); assert.ok(!failureLogs.includes('node_modules')); assert.ok(!failureLogs.includes('setgroups'));
  console.log('PASS unwritable data exits clearly without recursive chown /app or su-exec');
  console.log('Docker acceptance complete; no real Cloudflare requests were made.');
} finally {
  for (const name of containers) { try { docker('rm', '-f', name); } catch { /* Already removed. */ } }
  for (const volume of volumes) { try { docker('volume', 'rm', volume); } catch { /* Keep diagnostics if cleanup fails. */ } }
  for (const directory of directories) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Keep diagnostics if cleanup fails. */ } }
}
