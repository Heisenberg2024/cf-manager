import type { ApiError } from '../api/client';
import type { ZoneSettingsSnapshot, ZoneSettingsResult } from '../shared/zoneSettingsEvents';
import { runBatch } from './batchOperation';

export interface ZoneOperationTarget { name: string; accountId: number; zoneId: string; accountLabel: string }
export interface ZoneOperationRow {
  target: ZoneOperationTarget;
  status: 'ready' | 'running' | 'success' | 'unchanged' | 'partial' | 'failed' | 'uncertain' | 'skipped';
  before?: ZoneSettingsSnapshot;
  result?: ZoneSettingsResult;
  receipt?: string;
  error?: string;
}
export function zoneOperationRows(targets: ZoneOperationTarget[]): ZoneOperationRow[] {
  const seen = new Set<string>();
  return targets.map(target => {
    const duplicate = seen.has(target.zoneId);
    seen.add(target.zoneId);
    return { target: { ...target }, status: duplicate ? 'skipped' : 'ready' };
  });
}
export function zoneOperationError(row: ZoneOperationRow, error: unknown) {
  const failure = error as ApiError;
  row.error = failure.errorMessage || failure.message || String(error);
  const status = failure.response?.status;
  row.status = !status || status >= 500 ? 'uncertain' : 'failed';
}
export function settingsOperationResult(row: ZoneOperationRow, result: ZoneSettingsResult, changes: Record<string, unknown>) {
  row.result = result;
  const fields = Object.keys(changes).map(key => result.fields?.[key]);
  if (fields.some(field => !field || field.status === 'uncertain')) row.status = 'uncertain';
  else if (fields.every(field => field?.status === 'unchanged')) row.status = 'unchanged';
  else if (fields.every(field => field?.status === 'updated' || field?.status === 'unchanged')) row.status = 'success';
  else row.status = fields.some(field => field?.status === 'updated' || field?.status === 'unchanged') ? 'partial' : 'failed';
}
/** Targets are captured before execution; each actual Zone is submitted once and failures stay per row. */
export async function runZoneOperations(rows: ZoneOperationRow[], operation: (row: ZoneOperationRow) => Promise<void>, onProgress: (completed: number) => void) {
  const pending = rows.filter(row => row.status === 'ready');
  const alreadyCompleted = rows.length - pending.length;
  onProgress(alreadyCompleted);
  await runBatch(pending, async row => {
    row.status = 'running';
    try { await operation(row); }
    catch (error) { zoneOperationError(row, error); }
  }, completed => onProgress(alreadyCompleted + completed));
}
