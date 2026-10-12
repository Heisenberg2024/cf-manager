import type { CfRequest } from '../accountDiscovery';
import { CloudflareError } from '../cfErrors';

export function fakeZonePlans(options: { capacity?: number; rejectCapacity?: boolean; billingDenied?: boolean; upgradeError?: Error; noActivation?: boolean; activationDelayReads?: number; emptyAccount?: boolean; failedName?: string; wrongOwner?: boolean; enterpriseLegacyId?: string; enterpriseRateId?: string; enterpriseName?: string; omitLegacyEnterprise?: boolean } = {}) {
  const accountId = 'a'.repeat(32);
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const zones = new Map<string, { id: string; name: string; account: { id: string }; plan: { id: string; legacy_id: string; name: string }; name_servers: string[] }>();
  let used = 0;
  const free = { id: 'opaque-free-id', legacy_id: 'free', name: 'Free' };
  const paid = { id: 'opaque-enterprise-id', legacy_id: options.enterpriseLegacyId || 'enterprise', name: options.enterpriseName || 'Enterprise' };
  const pending = new Map<string, { plan: typeof free; reads: number }>();
  const request: CfRequest = async (path, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path.startsWith('/zones?')) return { result: options.emptyAccount ? [] : [{ id: 'sample', account: { id: accountId } }] };
    if (path.endsWith('/available_plans')) {
      if (options.billingDenied) throw new CloudflareError(403, 'Billing Read permission missing');
      return { result: [{ ...free, can_subscribe: true, price: 0 }, ...options.omitLegacyEnterprise ? [] : [{ ...paid, can_subscribe: options.rejectCapacity || used < (options.capacity ?? 3), price: 0, frequency: 'monthly' }]] };
    }
    if (path.endsWith('/available_rate_plans')) {
      if (options.billingDenied) throw new CloudflareError(403, 'Billing Read permission missing');
      return { result: [{ id: 'free', name: 'Free', price: 0 }, { id: options.enterpriseRateId || 'enterprise', name: options.enterpriseName || 'Enterprise', price: 0, frequency: 'monthly' }] };
    }
    if (path === '/zones' && method === 'POST') {
      if (body.name === options.failedName) throw new CloudflareError(409, 'Domain already exists');
      if ((body.account as { id: string }).id !== accountId) throw new Error('Wrong Account in create body');
      const id = `zone-${zones.size + 1}`;
      const zone = { id, name: String(body.name), account: { id: options.wrongOwner ? 'b'.repeat(32) : accountId }, plan: { ...free }, name_servers: ['ns.example.test'] };
      zones.set(id, zone);
      return { result: structuredClone(zone) };
    }
    const id = path.split('/')[2];
    const zone = zones.get(id);
    if (!zone) throw new Error(`Unexpected request ${path}`);
    if (path.endsWith('/subscription')) {
      if (options.upgradeError) throw options.upgradeError;
      const plan = (body?.rate_plan as { id: string }).id;
      if (plan !== 'free' && plan !== (options.enterpriseRateId || 'enterprise')) throw new CloudflareError(400, 'Unknown subscription rate plan');
      if (plan !== 'free') {
        if (used >= (options.capacity ?? 3)) throw new CloudflareError(400, 'Enterprise zone quota exceeded');
        used++;
      }
      if (!options.noActivation) {
        const target = { ...(plan === 'free' ? free : paid) };
        if (options.activationDelayReads) pending.set(id, { plan: target, reads: options.activationDelayReads });
        else zone.plan = target;
      }
      return { result: { rate_plan: { id: plan }, state: 'Provisioned' } };
    }
    const activation = pending.get(id);
    if (activation) {
      if (activation.reads > 0) activation.reads--;
      else { zone.plan = activation.plan; pending.delete(id); }
    }
    return { result: structuredClone(zone) };
  };
  return { accountId, request, calls, zones };
}
