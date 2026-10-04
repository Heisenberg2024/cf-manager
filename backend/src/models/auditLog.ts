import { getDb } from '../db';
import { redact } from '../services/cfErrors';

export interface AuditLog {
  id: number;
  account_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  status: 'success' | 'error';
  created_at: string;
}

export function createAuditLog(
  accountId: number | null,
  action: string,
  target: string | null,
  detail: string | null,
  status: 'success' | 'error'
): void {
  getDb()
    .prepare('INSERT INTO audit_log (account_id, action, target, detail, status) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, action, target === null ? null : redact(target), detail === null ? null : redact(detail), status);
}

export interface AuditLogWithName extends AuditLog {
  account_name: string | null;
}

export function getRecentLogs(limit: number = 20): AuditLogWithName[] {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  return getDb()
    .prepare(
      `SELECT a.*, acc.name AS account_name
       FROM audit_log a
       LEFT JOIN accounts acc ON a.account_id = acc.id
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(safeLimit) as AuditLogWithName[];
}

export interface LogFilter {
  action?: string;
  startDate?: string;  // YYYY-MM-DD
  endDate?: string;    // YYYY-MM-DD
  limit?: number;
}

export function queryLogs(filter: LogFilter = {}): AuditLogWithName[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.action) {
    conditions.push('a.action = ?');
    params.push(filter.action);
  }
  if (filter.startDate) {
    conditions.push('date(a.created_at) >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate) {
    conditions.push('date(a.created_at) <= ?');
    params.push(filter.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 500);

  return getDb()
    .prepare(
      `SELECT a.*, acc.name AS account_name
       FROM audit_log a
       LEFT JOIN accounts acc ON a.account_id = acc.id
       ${where}
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(...params, limit) as AuditLogWithName[];
}

export function getDistinctActions(): string[] {
  return getDb()
    .prepare('SELECT DISTINCT action FROM audit_log ORDER BY action')
    .all()
    .map((r: any) => r.action) as string[];
}
