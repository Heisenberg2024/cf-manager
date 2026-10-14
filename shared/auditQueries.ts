import { redact } from './cfErrors';

/** Small SQL boundary shared by SQLite and D1. All values are bound parameters. */
export interface LocalSql {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}
export function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'VALIDATION_ERROR' });
}
export function positive(value: unknown, fallback?: number): number {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) invalid('Expected a positive integer');
  return n;
}
export interface AuditFilter { accountId?: number; action?: string; status?: string; start?: string; end?: string; target?: string }
function dateBound(value: unknown, end: boolean): string | undefined {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) invalid('Use a UTC date or an ISO timestamp with timezone');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || (value.length === 10 && date.toISOString().slice(0, 10) !== value)) invalid('Invalid date');
  if (end && value.length === 10) date.setUTCDate(date.getUTCDate() + 1);
  // Events have second precision. Round fractional boundaries up for half-open intervals.
  if (date.getUTCMilliseconds()) date.setTime(Math.ceil(date.getTime() / 1000) * 1000);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
export function auditFilter(query: Record<string, unknown>): AuditFilter {
  const filter: AuditFilter = {};
  if (query.accountId !== undefined && query.accountId !== '') filter.accountId = positive(query.accountId);
  for (const key of ['action', 'target'] as const) {
    const value = query[key];
    if (value !== undefined && value !== '') {
      if (typeof value !== 'string' || value.length > 200) invalid(`Invalid ${key}`);
      filter[key] = value;
    }
  }
  if (query.status !== undefined && query.status !== '') {
    if (!['success', 'error'].includes(String(query.status))) invalid('Invalid status');
    filter.status = String(query.status);
  }
  filter.start = dateBound(query.startDate, false); filter.end = dateBound(query.endDate, true);
  if (filter.start && filter.end && filter.start >= filter.end) invalid('Invalid date range');
  return filter;
}
export function auditWhere(filter: AuditFilter) {
  const clauses: string[] = [], params: unknown[] = [];
  for (const [field, value] of [['account_id', filter.accountId], ['action', filter.action], ['status', filter.status]] as const) {
    if (value !== undefined) { clauses.push(`l.${field} = ?`); params.push(value); }
  }
  if (filter.start) { clauses.push('l.created_at >= ?'); params.push(filter.start); }
  if (filter.end) { clauses.push('l.created_at < ?'); params.push(filter.end); }
  if (filter.target) { clauses.push("l.target LIKE ? ESCAPE '\\'"); params.push(`%${filter.target.replace(/[\\%_]/g, '\\$&')}%`); }
  return { clauses, params };
}
export interface AuditEvent { id: number; account_id: number | null; account_name: string | null; action: string; target: string | null; detail: string | null; status: string; created_at: string }

/** Legacy free-form details may contain arbitrary env/config values. Only known safe fields leave DB. */
export function safeAuditEvent<T extends AuditEvent>(row: T): T {
  let detail: string | null = null;
  if (row.detail) {
    try {
      if(row.detail.length>8192)throw new Error('Large legacy detail');
      const parsed = JSON.parse(row.detail);
      const safe: Record<string, unknown> = {};
      for (const key of ['status', 'step', 'count', 'success', 'failed', 'total', 'durationMs', 'errorKind', 'code', 'recovered']) {
        const v = parsed?.[key];
        if (typeof v === 'number' || typeof v === 'boolean') safe[key] = v;
        else if (key==='status' && typeof v==='string' && ['success','error','unknown','partial','ready','conflict','activation_pending','invalid','permission','timeout','network'].includes(v)) safe[key]=v;
      }
      detail = Object.keys(safe).length ? JSON.stringify(safe, null, 2) : '[Details withheld: legacy free-form configuration]';
    } catch { detail = '[Details withheld: legacy free-form configuration]'; }
  }
  return { ...row, account_name: row.account_name ? redact(row.account_name) : null, action: redact(row.action), target: row.target ? redact(row.target).split('?')[0]!.slice(0, 240) : null, detail };
}
type Cursor = { version: 1; scope: string; anchor: number; date: string; id: number };
export async function auditPage(db: LocalSql, query: Record<string, unknown>) {
  const filter = auditFilter(query), scope = JSON.stringify(filter);
  const limit = positive(query.limit, 50); if (limit > 200) invalid('Limit must be 1–200');
  const { clauses, params } = auditWhere(filter);
  let cursor: Cursor | undefined;
  if (query.cursor !== undefined && query.cursor !== '') {
    try { if (typeof query.cursor !== 'string' || query.cursor.length > 4000) throw 0; cursor = JSON.parse(decodeURIComponent(query.cursor)); } catch { invalid('Invalid cursor'); }
    if (!cursor || cursor.version !== 1 || cursor.scope !== scope || !Number.isSafeInteger(cursor.anchor) || cursor.anchor < 0 || !Number.isSafeInteger(cursor.id) || cursor.id < 1 || cursor.id > cursor.anchor || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cursor.date)) invalid('Cursor does not match filters');
  }
  const anchor = cursor?.anchor ?? (await db.all<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log'))[0]!.id;
  clauses.push('l.id <= ?'); params.push(anchor);
  if (cursor) { clauses.push('(l.created_at, l.id) < (?, ?)'); params.push(cursor.date, cursor.id); }
  const rows = await db.all<AuditEvent>(`SELECT l.*, a.name AS account_name FROM audit_log l LEFT JOIN accounts a ON a.id = l.account_id WHERE ${clauses.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`, [...params, limit + 1]);
  const more = rows.length > limit, items = rows.slice(0, limit).map(safeAuditEvent), last = items.at(-1);
  return { items, nextCursor: more && last ? encodeURIComponent(JSON.stringify({ version: 1, scope, anchor, date: last.created_at, id: last.id })) : null, timezone: 'UTC' };
}
export async function auditStats(db: LocalSql, query: Record<string, unknown>) {
  const filter = auditFilter(query), { clauses, params } = auditWhere(filter);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all<{ date: string; action: string; status: string; count: number }>(`SELECT substr(l.created_at,1,10) AS date, l.action, l.status, COUNT(*) AS count FROM audit_log l ${where} GROUP BY substr(l.created_at,1,10), l.action, l.status ORDER BY date`, params);
  const daily = new Map<string, { date: string; success: number; error: number }>(), actions = new Map<string, number>();
  let total = 0, success = 0, error = 0;
  for (const row of rows) {
    const day = daily.get(row.date) ?? { date: row.date, success: 0, error: 0 };
    if (row.status === 'success') { success += row.count; day.success += row.count; } else { error += row.count; day.error += row.count; }
    daily.set(row.date, day); total += row.count; actions.set(row.action, (actions.get(row.action) ?? 0) + row.count);
  }
  return { total, success, error, daily: [...daily.values()], actions: [...actions].map(([action, count]) => ({ action: redact(action), count })).sort((a, b) => b.count - a.count), timezone: 'UTC', source: 'audit_log' };
}
