#!/usr/bin/env node
// 版本化 D1 迁移运行器（P1-17 / P1-18 / P1-19）
//
// 设计：
// - 每张迁移按文件名版本号（NNNN_*.sql）有序、且仅执行一次，执行情况记入 _migrations 表。
// - _migrations 缺失时自动建表；已记录的版本跳过。
// - D1 不支持 ADD COLUMN IF NOT EXISTS，且现有生产库已含全部列，因此对「列/表已存在、
//   重复列、约束冲突」类幂等错误视为成功并照常记录（兼容旧库），其余错误必须中断部署。
// - 全新库：schema.sql 已含全部列，本运行器对每个历史迁移命中「已存在」后记录为已应用，
//   不会真正改结构（解决 P1-19 对全新库全是废语句的冗余问题）。
//
// 用法（CI 部署由 action.yml 调用）：
//   node worker/scripts/migrate.mjs            # 默认 --remote，库名取 $D1_NAME 或 cfmgr
//   WRANGLER_LOCAL=1 node worker/scripts/migrate.mjs   # 本地 --local
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');
const DB_NAME = process.env.D1_NAME || 'cfmgr';
const REMOTE_FLAG = process.env.WRANGLER_LOCAL ? [] : ['--remote'];

// 优先用全局 wrangler，缺失时回退 npx（本地开发）
function resolveWrangler() {
  try {
    execFileSync('wrangler', ['--version'], { stdio: 'ignore' });
    return { bin: 'wrangler', prefix: [] };
  } catch {
    return { bin: 'npx', prefix: ['wrangler'] };
  }
}
const W = resolveWrangler();

function runWrangler(args, capture = false) {
  const opts = { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' };
  return execFileSync(W.bin, [...W.prefix, ...args], opts);
}

function ensureMigrationsTable() {
  runWrangler([
    'd1', 'execute', DB_NAME,
    '--command', 'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
    ...REMOTE_FLAG,
  ]);
}

function appliedVersions() {
  try {
    const out = runWrangler(
      ['d1', 'execute', DB_NAME, '--command', 'SELECT version FROM _migrations', ...REMOTE_FLAG, '--json'],
      true,
    );
    const data = JSON.parse(out);
    const rows = Array.isArray(data) ? data[0]?.results : [];
    return new Set((rows || []).map((r) => r.version));
  } catch (e) {
    throw new Error('Cannot read D1 migration history; refusing to guess applied versions', { cause: e });
  }
}

function runStatement(stmt) {
  try {
    // capture=true：失败时需拿到子进程 stderr 才能识别「列/表已存在」等幂等错误，
    // 否则 stdio='ignore' 时 e.stderr 为 undefined，正则永远匹配不上，误判为致命错误。
    runWrangler(['d1', 'execute', DB_NAME, '--command', stmt, ...REMOTE_FLAG], true);
    return { ok: true };
  } catch (e) {
    const msg = String((e && (e.stderr || e.stdout)) || e.message || '');
    // 删列迁移天然不可幂等：全新库的 schema.sql 已不含该列，DROP COLUMN 会报「no such column」。
    // 仅对 DROP COLUMN 语句放宽这一条，避免误吞其他迁移里的真实列名错误。
    const isDropColumn = /^\s*ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN\b/i.test(stmt);
    if (isDropColumn && /no such column/i.test(msg)) {
      return { ok: true, idempotent: true };
    }
    if (/already exists|duplicate column|duplicate.*name/i.test(msg)) {
      return { ok: true, idempotent: true };
    }
    return { ok: false, msg };
  }
}

function recordVersion(version) {
  runWrangler([
    'd1', 'execute', DB_NAME,
    '--command', `INSERT OR IGNORE INTO _migrations (version) VALUES ('${version}')`,
    ...REMOTE_FLAG,
  ]);
}

function main() {
  console.log(`=== D1 版本化迁移：${DB_NAME} (${REMOTE_FLAG.length ? 'remote' : 'local'}) ===`);
  ensureMigrationsTable();
  const applied = appliedVersions();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.log('（无迁移文件）');
  }

  let appliedCount = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/i, '');
    if (applied.has(version)) {
      console.log(`  ✓ ${version} (已应用，跳过)`);
      continue;
    }
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = content
      .split(';')
      .map((s) => s.replace(/--.*$/gm, '').trim())
      .filter(Boolean);
    console.log(`  ▶ ${version} (${statements.length} 条语句)`);
    for (const stmt of statements) {
      const r = runStatement(stmt);
      if (!r.ok) {
        console.error(`::error::迁移 ${version} 失败: ${stmt}\n${r.msg}`);
        process.exit(1);
      }
    }
    recordVersion(version);
    appliedCount++;
  }
  console.log(`=== 迁移完成：${appliedCount} 个新迁移已应用 / 共 ${files.length} 个 ===`);
}

main();
