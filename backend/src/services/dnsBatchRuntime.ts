import { getAccountById } from '../models/account';
import { getDb } from '../db';
import { accountRequest } from './cfFactory';
import { createAuditLog } from '../models/auditLog';
import { isDemoAccountId } from '../routes/routeUtils';
import { batchError, type BatchRuntime, type BatchPreview } from './dnsBatch';
export function dnsBatchRuntime(): BatchRuntime {
  return {
    async resolve(zone) {
      const account = getAccountById(zone.accountId);
      if (!account || account.is_enabled === 0 || account.is_active === 0 || !(account.enabled_features ?? 'dns').split(',').includes('dns') || !account.account_id || account.credential_id !== zone.credentialId) throw batchError('Account unavailable or Credential binding changed');
      if (isDemoAccountId(account.id)) throw Object.assign(new Error('Demo Account DNS is read-only'), { statusCode: 403, code: 'DEMO_PROTECTED' });
      return { request: accountRequest(account), cloudflareAccountId: account.account_id, credentialId: account.credential_id };
    },
    async audit(item) {
      createAuditLog(item.zone.accountId, `batch_dns_${item.action}`, `${item.zone.zoneName}/${item.name}`, `zone=${item.zone.zoneId} record=${item.recordId || '-'} status=${item.status} http=${item.httpStatus || '-'} codes=${item.cfCodes?.join(',') || '-'}`, item.status === 'SUCCESS' || item.status === 'SKIPPED' ? 'success' : 'error');
    },
  };
}
export function consumeDnsPreview(plan: BatchPreview): void {
  const db = getDb();
  db.prepare('DELETE FROM dns_batch_executions WHERE expires_at < ?').run(Date.now());
  const result = db.prepare('INSERT OR IGNORE INTO dns_batch_executions (id, expires_at) VALUES (?, ?)').run(plan.id, plan.expiresAt);
  if (!result.changes) throw batchError('This preview has already been executed; preview again');
}
