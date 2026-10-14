#!/usr/bin/env node
// CI 门禁（P1-17）：比对 backend 与 worker 的数据库结构。
//
// 校验目标：
// 1) backend/src/db.ts 的建表语句 与 worker/src/db/schema.sql 的「共享表」列集合必须一致
//    （scheduled_tasks / task_executions 为 backend 独有，自然不参与比对）。
// 2) worker/src/db/migrations/*.sql 增加的列必须已经存在于 worker schema.sql
//    （schema.sql 是「当前完整 schema」的单一真相源，迁移只是把旧库补齐到该真相源，
//     不允许迁移引入 schema.sql 中不存在的列 —— 解决 P1-19 冗余/漂移风险）。
//
// 任一不一致即退出码 1，使 PR 状态检查变红，阻断合并。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_DB = join(ROOT, 'backend', 'src', 'db.ts');
const WORKER_SCHEMA = join(ROOT, 'worker', 'src', 'db', 'schema.sql');
const WORKER_MIGRATIONS = join(ROOT, 'worker', 'src', 'db', 'migrations');

// 提取 CREATE TABLE 块 -> Map<表名, Set<列名>>
function extractTables(sql) {
  const tables = new Map();
  const re = /CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_]\w*)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    const open = sql.indexOf('(', m.index);
    let depth = 0;
    let end = -1;
    for (let j = open; j < sql.length; j++) {
      const ch = sql[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    const body = sql.slice(open + 1, end);
    const cols = new Set();
    let buf = '';
    let d = 0;
    let inStr = false;
    for (let j = 0; j < body.length; j++) {
      const ch = body[j];
      if (inStr) {
        if (ch === "'") {
          if (body[j + 1] === "'") {
            buf += "''";
            j++;
            continue;
          }
          inStr = false;
        }
        buf += ch;
        continue;
      }
      if (ch === "'") {
        inStr = true;
        buf += ch;
        continue;
      }
      if (ch === '(') d++;
      else if (ch === ')') d--;
      if (ch === ',' && d === 0) {
        pushCol(buf, cols);
        buf = '';
      } else buf += ch;
    }
    pushCol(buf, cols);
    tables.set(name, cols);
  }
  return tables;
}

function pushCol(seg, cols) {
  const s = seg.trim().replace(/--.*$/, '').trim();
  if (!s) return;
  const upper = s.toUpperCase();
  if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX)/.test(upper)) return;
  const name = s.split(/\s+/)[0].replace(/[`"]/g, '');
  if (name) cols.add(name);
}

let errors = 0;
const backend = extractTables(readFileSync(BACKEND_DB, 'utf8'));
const worker = extractTables(readFileSync(WORKER_SCHEMA, 'utf8'));

const backendOnly=new Set(['scheduled_tasks','task_executions','_migrations']);
for(const t of backend.keys())if(!worker.has(t)&&!backendOnly.has(t)){errors++;console.error(`::error::backend 表 ${t} 缺少 worker schema 对应表`);}
for(const t of worker.keys())if(!backend.has(t)){errors++;console.error(`::error::worker 表 ${t} 缺少 backend base CREATE 对应表`);}
const shared = [...backend.keys()].filter((k) => worker.has(k));
console.log('比对共享表（backend ∩ worker）：');
for (const t of shared) {
  const b = backend.get(t);
  const w = worker.get(t);
  const onlyB = [...b].filter((c) => !w.has(c));
  const onlyW = [...w].filter((c) => !b.has(c));
  if (onlyB.length || onlyW.length) {
    errors++;
    console.error(
      `::error::表 ${t} 列不一致 — backend 独有: [${onlyB.join(', ')}]; worker 独有: [${onlyW.join(', ')}]`,
    );
  } else {
    console.log(`  ✓ ${t} (${b.size} 列一致)`);
  }
}

if (existsSync(WORKER_MIGRATIONS)) {
  const files = readdirSync(WORKER_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const re = /ALTER TABLE ([A-Za-z_]\w*)\s+ADD COLUMN (?:IF NOT EXISTS )?([A-Za-z_]\w*)/gi;
  for (const f of files) {
    const content = readFileSync(join(WORKER_MIGRATIONS, f), 'utf8');
    for(const [t,cols] of extractTables(content))if(!worker.has(t)||[...cols].some(c=>!worker.get(t).has(c))){errors++;console.error(`::error::迁移 ${f} 的 CREATE TABLE ${t} 超出 worker schema`);}
    let mm;
    while ((mm = re.exec(content))) {
      const t = mm[1];
      const col = mm[2];
      if (!worker.has(t) || !worker.get(t).has(col)) {
        errors++;
        console.error(
          `::error::迁移 ${f} 为 ${t} 增加列 ${col}，但该列不在 worker schema.sql（schema.sql 应为当前完整 schema）`,
        );
      }
    }
  }
}

if (errors) {
  console.error(`\n架构比对失败：${errors} 处不一致`);
  process.exit(1);
}
console.log('\n架构比对通过：backend 与 worker 共享表结构一致，worker 迁移未超出 schema.sql 范围');
