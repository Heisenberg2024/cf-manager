import type { CfRequest } from './accountDiscovery';
import { CloudflareError, errorDetails } from './cfErrors';

export const ZONE_PLAN_IDS = ['free', 'lite', 'pro', 'pro_plus', 'business', 'enterprise', 'partners_free', 'partners_pro', 'partners_business', 'partners_enterprise'] as const;
export type ZonePlanId = typeof ZONE_PLAN_IDS[number];
export interface ZonePlan { id: string; name: string }
export interface ZonePlanOption extends ZonePlan {
  can_subscribe: boolean | null;
  price?: number;
  currency?: string;
  frequency?: string;
}
interface CfPlan { id?: string; legacy_id?: string; name?: string; public_name?: string; can_subscribe?: boolean; price?: number; currency?: string; frequency?: string }
interface CfZone { id: string; name?: string; account?: { id: string }; name_servers?: string[]; plan?: CfPlan }
export interface CreateZonesInput { names: string[]; account_id: number; type: 'full' | 'partial'; plan: ZonePlanId }
export interface CreateZoneResult {
  name: string;
  success: boolean;
  zone_created: boolean;
  outcome_uncertain?: boolean;
  zone_id?: string;
  name_servers?: string[];
  requested_plan: ZonePlanId;
  plan?: ZonePlan;
  fallback?: boolean;
  warning?: string;
  error?: string;
}

const planNames: Record<ZonePlanId, string> = {
  free: 'Free', lite: 'Lite', pro: 'Pro', pro_plus: 'Pro Plus', business: 'Business', enterprise: 'Enterprise',
  partners_free: 'Partners Free', partners_pro: 'Partners Pro', partners_business: 'Partners Business', partners_enterprise: 'Partners Enterprise',
};
function planId(plan?: CfPlan): string | undefined { return plan?.legacy_id || plan?.id; }
export function zonePlan(plan?: CfPlan): ZonePlan | undefined {
  const id = planId(plan);
  if (!id && !plan?.name && !plan?.public_name) return undefined;
  return { id: id || '', name: plan?.name || plan?.public_name || planNames[id as ZonePlanId] || id! };
}
function isFree(plan?: ZonePlan) { return plan?.id === 'free' || plan?.id === 'partners_free'; }
function validation(message: string): never { throw Object.assign(new Error(message), { code: 'VALIDATION_ERROR', statusCode: 400 }); }
export function parseCreateZonesInput(body: unknown): CreateZonesInput {
  const input = body as Partial<CreateZonesInput> | null;
  if (!input || !Array.isArray(input.names) || !input.names.length || input.names.some(name => typeof name !== 'string' || !name.trim())) validation('names must contain non-empty domain strings');
  const accountId = Number(input.account_id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) validation('account_id must be a local Account ID');
  const plan = input.plan ?? 'free';
  if (!ZONE_PLAN_IDS.includes(plan)) validation('Unsupported Zone plan');
  if (input.type !== undefined && input.type !== 'full' && input.type !== 'partial') validation('Unsupported Zone type');
  return { names: [...new Set(input.names.map(name => name.trim().toLowerCase()))], account_id: accountId, type: input.type || 'full', plan };
}

async function availablePlans(request: CfRequest, zoneId: string): Promise<ZonePlanOption[]> {
  const data = await request(`/zones/${zoneId}/available_plans`);
  if (!Array.isArray(data.result)) throw new CloudflareError(502, 'Unexpected available plans response');
  return (data.result as CfPlan[]).flatMap(plan => {
    // Subscription API expects the public rate_plan ID, not available_plans' opaque ID.
    const id = planId(plan);
    if (!ZONE_PLAN_IDS.includes(id as ZonePlanId)) return [];
    return [{ id: id!, name: plan.name || planNames[id as ZonePlanId], can_subscribe: typeof plan.can_subscribe === 'boolean' ? plan.can_subscribe : null,
      ...(typeof plan.price === 'number' ? { price: plan.price } : {}), ...(plan.currency ? { currency: plan.currency } : {}), ...(plan.frequency ? { frequency: plan.frequency } : {}) }];
  });
}
export async function getZonePlanOptions(request: CfRequest, cloudflareAccountId: string) {
  const data = await request(`/zones?account.id=${encodeURIComponent(cloudflareAccountId)}&per_page=1`);
  if (!Array.isArray(data.result)) throw new CloudflareError(502, 'Unexpected zones response');
  const zone = (data.result as CfZone[]).find(zone => zone.account?.id === cloudflareAccountId);
  if (data.result.length && !zone) throw new CloudflareError(502, 'Zone Account ownership could not be confirmed');
  if (!zone) return { plans: ['free', 'pro', 'business', 'enterprise'].map(id => ({ id, name: planNames[id as ZonePlanId], can_subscribe: null })), source: 'new_zone' };
  const plans = await availablePlans(request, zone.id);
  if (!plans.some(plan => plan.id === 'free')) plans.unshift({ id: 'free', name: 'Free', can_subscribe: true });
  return { plans, source: 'zone' };
}

async function readZone(request: CfRequest, id: string, accountId: string): Promise<CfZone> {
  const data = await request(`/zones/${id}`);
  const zone = data.result as CfZone | undefined;
  if (zone?.id !== id || zone.account?.id !== accountId) throw new CloudflareError(502, 'Zone Account ownership could not be confirmed');
  return zone;
}
function capacityFailure(error: unknown): boolean {
  const detail = errorDetails(error);
  if (![400, 403, 409, 422].includes(detail.statusCode)) return false;
  return /(?:zone|plan|enterprise|subscription|entitlement).{0,100}(?:quota|capacity|slots?|limit).{0,60}(?:exceed|exhaust|reach|insufficient)|(?:insufficient|no remaining|no available).{0,80}(?:zone slots?|entitlements?|enterprise slots?)|(?:quota|capacity).{0,60}(?:exceeded|exhausted)/i.test(detail.message);
}

/** Sequential allocation: Cloudflare is the authority for contract capacity; never guess a remaining count. */
export async function createZonesWithPlan(request: CfRequest, cloudflareAccountId: string, input: CreateZonesInput) {
  if (!cloudflareAccountId) validation('Account is missing its Cloudflare Account ID');
  const results: CreateZoneResult[] = [];
  // Check billing reads before creating anything when the account already has a Zone.
  if (input.plan !== 'free') await getZonePlanOptions(request, cloudflareAccountId);
  let unavailable = false;
  let stopReason = '';
  for (const name of input.names) {
    const result: CreateZoneResult = { name, success: false, zone_created: false, requested_plan: input.plan };
    results.push(result);
    if (stopReason) { result.error = `未处理：${stopReason}`; continue; }
    try {
      const data = await request('/zones', { method: 'POST', body: JSON.stringify({ name, account: { id: cloudflareAccountId }, type: input.type }) });
      let zone = data.result as CfZone | undefined;
      if (!zone?.id) throw new CloudflareError(502, 'Zone creation result is unknown; refresh before retrying');
      result.zone_created = true; result.zone_id = zone.id; result.name_servers = zone.name_servers || [];
      if (!zone.plan || zone.account?.id !== cloudflareAccountId) zone = await readZone(request, zone.id, cloudflareAccountId);
      result.plan = zonePlan(zone.plan);
      if (!result.plan) throw new CloudflareError(502, 'Current Zone plan could not be confirmed');
      if (input.plan === result.plan.id || (input.plan === 'free' && isFree(result.plan))) { result.success = true; continue; }
      // A newly created zone is expected to be Free. Never downgrade an unexpected paid plan.
      if (!isFree(result.plan)) throw new CloudflareError(409, 'New Zone already has a different paid plan; review it in Cloudflare');
      if (input.plan === 'free') { result.success = true; continue; }
      if (!unavailable) {
        const plan = (await availablePlans(request, zone.id)).find(plan => plan.id === input.plan);
        if (!plan || plan.can_subscribe === false) unavailable = true;
        else {
          if (plan.can_subscribe !== true) throw new CloudflareError(502, 'Plan availability could not be confirmed');
          result.plan = undefined;
          try {
            await request(`/zones/${zone.id}/subscription`, { method: 'POST', body: JSON.stringify({ rate_plan: { id: plan.id }, ...(plan.frequency ? { frequency: plan.frequency } : {}) }) });
          } catch (error) {
            if (!capacityFailure(error)) throw error;
            unavailable = true;
            result.warning = errorDetails(error).message;
          }
          // Read after a successful write or an explicit capacity rejection; never assume activation.
          zone = await readZone(request, zone.id, cloudflareAccountId);
          result.plan = zonePlan(zone.plan);
          if (!result.plan) throw new CloudflareError(502, 'Zone plan after subscription could not be confirmed');
          if (!unavailable && result.plan.id !== input.plan) throw new CloudflareError(409, 'Requested plan is not active; review the Zone subscription in Cloudflare');
        }
      }
      if (unavailable) {
        if (!isFree(result.plan)) throw new CloudflareError(409, 'Free fallback could not be confirmed');
        result.fallback = true;
        result.warning ||= '所选套餐不可订阅或名额不足，已使用 Free 套餐';
      }
      result.success = true;
    } catch (error) {
      const detail = errorDetails(error);
      result.error = detail.message;
      if (!result.zone_created && (['network', 'timeout'].includes(detail.kind) || detail.statusCode >= 500)) result.outcome_uncertain = true;
      // Ambiguous writes and plan failures stop the batch. Existing zones remain visible with their IDs.
      if (result.zone_created || ['network', 'timeout', 'rate_limited', 'permission', 'invalid'].includes(detail.kind) || detail.statusCode >= 500) stopReason = result.error;
    }
  }
  return { total: results.length, succeeded: results.filter(result => result.success).length, failed: results.filter(result => !result.success).length,
    fallback_count: results.filter(result => result.fallback).length, results };
}
