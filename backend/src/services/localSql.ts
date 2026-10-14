import { getDb } from '../db';
import type { LocalSql } from './auditQueries';
export const localSql: LocalSql = {
  async all<T>(sql: string, params: unknown[] = []) { return getDb().prepare(sql).all(...params) as T[]; },
  async run(sql, params = []) { getDb().prepare(sql).run(...params); },
  async batch(statements) { const db=getDb();db.transaction(()=>{for(const s of statements)db.prepare(s.sql).run(...(s.params??[]));})(); },
};
