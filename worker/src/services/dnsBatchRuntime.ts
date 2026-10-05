import { getAccountById, addAuditLog } from '../db/models';
import { accountRequest } from './cfApi';
import { isDemoAccount } from './demo';
import type { Env } from '../types';
import { batchError, type BatchRuntime, type BatchPreview } from './dnsBatch';
export function dnsBatchRuntime(env: Env): BatchRuntime {
  return {
    async resolve(zone) {
      const account = await getAccountById(env.DB, zone.accountId);
      if (!account || account.is_enabled === 0 || account.is_active === 0 || !(account.enabled_features ?? 'dns').split(',').includes('dns') || !account.account_id || account.credential_id !== zone.credentialId) throw batchError('Account unavailable or Credential binding changed');
      if (isDemoAccount(account.id, env.DEMO_ACCOUNT_IDS)) throw Object.assign(new Error('Demo Account DNS is read-only'), { statusCode: 403, code: 'DEMO_PROTECTED' });
      return { request: await accountRequest(account, env.ENCRYPTION_KEY), cloudflareAccountId: account.account_id, credentialId: account.credential_id };
    },
    async audit(item) {
      await addAuditLog(env.DB, { account_id: item.zone.accountId, action: `batch_dns_${item.action}`, target: `${item.zone.zoneName}/${item.name}`, detail: `zone=${item.zone.zoneId} record=${item.recordId || '-'} status=${item.status} http=${item.httpStatus || '-'} codes=${item.cfCodes?.join(',') || '-'}`, status: item.status === 'SUCCESS' || item.status === 'SKIPPED' ? 'success' : 'error' });
    },
  };
}
export async function consumeDnsPreview(env: Env, plan: BatchPreview): Promise<void> {
  await env.DB.prepare('DELETE FROM dns_batch_executions WHERE expires_at < ?').bind(Date.now()).run();
  const result = await env.DB.prepare('INSERT OR IGNORE INTO dns_batch_executions (id, expires_at) VALUES (?, ?)').bind(plan.id, plan.expiresAt).run();
  if (!result.meta.changes) throw batchError('This preview has already been executed; preview again');
}
