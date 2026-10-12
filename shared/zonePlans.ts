import type { CfRequest } from './accountDiscovery';
import { CloudflareError, errorDetails } from './cfErrors';

export const ZONE_PLAN_IDS = ['free', 'lite', 'pro', 'pro_plus', 'business', 'enterprise', 'partners_free', 'partners_pro', 'partners_business', 'partners_enterprise'] as const;
export type ZonePlanId = typeof ZONE_PLAN_IDS[number];
export interface ZonePlan { id: string; name: string }
export interface ZonePlanOption extends ZonePlan {
  can_subscribe: boolean | null;
  /** ID from available_rate_plans, distinct from available_plans' opaque product ID. */
  rate_plan_id?: string;
  price?: number;
  currency?: string;
  frequency?: string;
}
export interface ChangeZonePlanResult {
  success: boolean;
  zone_id: string;
  requested_plan: ZonePlanId;
  previous_plan?: ZonePlan;
  plan?: ZonePlan;
  unchanged?: boolean;
  activation_pending?: boolean;
  outcome_uncertain?: boolean;
  warning?: string;
  error?: string;
  http_status?: number;
}
interface CfPlan { id?: string; legacy_id?: string; name?: string; public_name?: string; can_subscribe?: boolean; price?: number; currency?: string; frequency?: string }
interface CfZone { id: string; name?: string; account?: { id: string }; name_servers?: string[]; plan?: CfPlan }
export interface CreateZonesInput { names: string[]; account_id: number; type: 'full' | 'partial'; plan: ZonePlanId }
export interface CreateZoneResult {
  name: string;
  success: boolean;
  zone_created: boolean;
  outcome_uncertain?: boolean;
  activation_pending?: boolean;
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
function knownPlanId(value?: string): ZonePlanId | undefined {
  const id = typeof value === 'string' ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : undefined;
  const aliases: Record<string, ZonePlanId> = { cf_free: 'free', cf_biz: 'business', cf_pro: 'pro', cf_pro_20_20: 'pro', cf_ent: 'enterprise', cf_lite: 'lite', cf_pro_plus: 'pro_plus' };
  if (id && aliases[id]) return aliases[id];
  return ZONE_PLAN_IDS.includes(id as ZonePlanId) ? id as ZonePlanId : undefined;
}
function planId(plan?: CfPlan): string | undefined {
  if (!plan) return undefined;
  const known = knownPlanId(plan.legacy_id) || knownPlanId(plan.id);
  if (known) return known;
  // Match only website tier names, never an arbitrary Enterprise add-on or a UUID.
  for (const value of [plan.name, plan.public_name]) {
    if (typeof value !== 'string') continue;
    const name = value.trim().replace(/\s+(?:website\s+)?plan$/i, '').replace(/\s+website$/i, '');
    const id = knownPlanId(name);
    if (id) return id;
  }
  return plan.legacy_id || plan.id;
}
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
  const read = async (endpoint: string): Promise<CfPlan[]> => {
    const plans: CfPlan[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await request(`/zones/${zoneId}/${endpoint}${page === 1 ? '' : `?page=${page}`}`);
      if (!Array.isArray(data.result)) throw new CloudflareError(502, 'Unexpected available plans response');
      plans.push(...data.result as CfPlan[]);
      const info = data.result_info;
      const pages = info?.total_pages || (info?.total_count && info.per_page ? Math.ceil(info.total_count / info.per_page) : 1);
      if (page >= pages) return plans;
    }
    throw new CloudflareError(502, 'Available plans pagination limit exceeded');
  };
  const sources = await Promise.allSettled([read('available_plans'), read('available_rate_plans')]);
  if (sources.every(source => source.status === 'rejected')) throw (sources[0] as PromiseRejectedResult).reason;
  const options = new Map<string, ZonePlanOption>();
  sources.forEach((source, index) => {
    if (source.status !== 'fulfilled') return;
    for (const plan of source.value) {
      const id = planId(plan);
      if (!ZONE_PLAN_IDS.includes(id as ZonePlanId)) continue;
      // The rate-plan endpoint lists subscribable plans and supplies their actual subscription ID.
      // Legacy can_subscribe is only a hint, not proof of exhausted account entitlements.
      const option: ZonePlanOption = { id: id!, name: plan.name || plan.public_name || planNames[id as ZonePlanId],
        can_subscribe: typeof plan.can_subscribe === 'boolean' ? plan.can_subscribe : index === 1 ? true : null,
        rate_plan_id: index === 1 && plan.id ? plan.id : id!,
        ...(typeof plan.price === 'number' ? { price: plan.price } : {}), ...(plan.currency ? { currency: plan.currency } : {}), ...(plan.frequency ? { frequency: plan.frequency } : {}) };
      options.set(id!, { ...options.get(id!), ...option });
    }
  });
  return [...options.values()];
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

export function parseZonePlan(body: unknown): ZonePlanId {
  const plan = (body as { plan?: unknown } | null)?.plan;
  if (!ZONE_PLAN_IDS.includes(plan as ZonePlanId)) validation('Unsupported Zone plan');
  return plan as ZonePlanId;
}

/** Existing Zones must use their own options, rather than an arbitrary Zone in the Account. */
export async function getExistingZonePlanOptions(request: CfRequest, accountId: string, zoneId: string) {
  const zone = await readZone(request, zoneId, accountId);
  const plans = await availablePlans(request, zoneId);
  if (!plans.some(plan => plan.id === 'free')) plans.unshift({ id: 'free', name: 'Free', can_subscribe: true });
  return { plans, plan: zonePlan(zone.plan) };
}

/** Explicit plan change only. Never downgrade an existing Zone as an implicit quota fallback. */
export async function changeZonePlan(request: CfRequest, accountId: string, zoneId: string, plan: ZonePlanId, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<ChangeZonePlanResult> {
  parseZonePlan({ plan });
  const zone = await readZone(request, zoneId, accountId);
  const previous = zonePlan(zone.plan);
  if (!previous) throw new CloudflareError(502, 'Current Zone plan could not be confirmed');
  const result: ChangeZonePlanResult = { success: false, zone_id: zoneId, requested_plan: plan, previous_plan: previous, plan: previous };
  if (previous.id === plan || (plan === 'free' && isFree(previous))) return { ...result, success: true, unchanged: true };
  let attempted = false;
  const matches = () => result.plan?.id === plan || (plan === 'free' && isFree(result.plan));
  // Read-only confirmation tolerates short propagation delays. Never repeat the subscription write.
  const confirm = async (delays: number[]) => {
    let readError = '';
    for (const delay of delays) {
      if (delay) await wait(delay);
      try {
        result.plan = zonePlan((await readZone(request, zoneId, accountId)).plan);
        readError = '';
        if (matches()) return '';
      } catch (error) { readError = errorDetails(error).message; }
    }
    return readError;
  };
  try {
    // Free remains usable when Billing Read/available_plans is denied; CF authorizes the write.
    let option: ZonePlanOption | undefined;
    if (plan !== 'free') {
      // An unavailable/missing legacy hint must not override the user's selected tier or known contract.
      // If billing reads are denied, the public tier ID is still an explicit, valid subscription request.
      try { option = (await availablePlans(request, zoneId)).find(option => option.id === plan); } catch { /* The write returns the authoritative permissions/capacity result. */ }
    }
    result.plan = undefined;
    attempted = true;
    await request(`/zones/${zoneId}/subscription`, {
      method: isFree(previous) && plan !== 'free' ? 'POST' : 'PUT',
      body: JSON.stringify({ rate_plan: { id: option?.rate_plan_id || plan }, ...(option?.frequency ? { frequency: option.frequency } : {}) }),
    });
    // Successful submission is authoritative even when Zone.plan is stale or the downgrade is scheduled.
    const readError = await confirm([0, 250, 750]);
    result.success = true;
    result.outcome_uncertain = false;
    if (!matches()) {
      result.activation_pending = true;
      result.warning = `Cloudflare 已接受套餐修改，实际套餐尚待同步或生效。请稍后刷新核实，勿重复提交。${readError ? ` ${readError}` : ''}`;
    }
  } catch (error) {
    const detail = errorDetails(error);
    result.error = detail.message;
    result.http_status = detail.statusCode;
    result.outcome_uncertain = attempted && (['network', 'timeout'].includes(detail.kind) || detail.statusCode >= 500);
    if (attempted) {
      await confirm(result.outcome_uncertain ? [0, 250, 750] : [0]);
      // A lost write response is recoverable when the target plan is actually observed.
      if (result.outcome_uncertain && matches()) {
        result.success = true;
        result.outcome_uncertain = false;
        result.error = undefined;
        result.http_status = undefined;
        result.warning = `套餐写入响应异常，但已读取确认目标套餐生效。${detail.message}`;
      }
    }
  }
  return result;
}
function capacityFailure(error: unknown): boolean {
  const detail = errorDetails(error);
  if (![400, 403, 409, 422].includes(detail.statusCode)) return false;
  return /(?:zone|plan|enterprise|subscription|entitlement).{0,100}(?:quota|capacity|slots?|limit).{0,60}(?:exceed|exhaust|reach|insufficient)|(?:insufficient|no remaining|no available).{0,80}(?:zone slots?|entitlements?|enterprise slots?)|(?:quota|capacity).{0,60}(?:exceeded|exhausted)/i.test(detail.message);
}

/** Sequential, independent creations. Only an explicit capacity rejection enables Free fallback. */
export async function createZonesWithPlan(request: CfRequest, cloudflareAccountId: string, input: CreateZonesInput, wait?: (ms: number) => Promise<void>) {
  if (!cloudflareAccountId) validation('Account is missing its Cloudflare Account ID');
  const results: CreateZoneResult[] = [];
  let capacityExhausted = false;
  for (const name of input.names) {
    const result: CreateZoneResult = { name, success: false, zone_created: false, requested_plan: input.plan };
    results.push(result);
    try {
      const data = await request('/zones', { method: 'POST', body: JSON.stringify({ name, account: { id: cloudflareAccountId }, type: input.type }) });
      let zone = data.result as CfZone | undefined;
      if (!zone?.id) throw new CloudflareError(502, 'Zone creation result is unknown; refresh before retrying');
      result.zone_created = true; result.zone_id = zone.id; result.name_servers = zone.name_servers || [];
      if (!zone.plan || zone.account?.id !== cloudflareAccountId) zone = await readZone(request, zone.id, cloudflareAccountId);
      result.plan = zonePlan(zone.plan);
      if (!result.plan) throw new CloudflareError(502, 'Current Zone plan could not be confirmed');
      if (input.plan === result.plan.id || (input.plan === 'free' && isFree(result.plan))) { result.success = true; continue; }
      // Do not downgrade an unexpected paid plan on the newly created Zone.
      if (!isFree(result.plan)) throw new CloudflareError(409, 'New Zone already has a different paid plan; review it in Cloudflare');
      if (capacityExhausted) {
        result.success = true; result.fallback = true;
        result.warning = 'Cloudflare 已明确拒绝所选套餐的容量，当前域名使用 Free 套餐';
        continue;
      }
      const change = await changeZonePlan(request, cloudflareAccountId, zone.id, input.plan, wait);
      result.plan = change.plan; result.success = change.success;
      result.activation_pending = change.activation_pending; result.outcome_uncertain = change.outcome_uncertain;
      result.warning = change.warning; result.error = change.error;
      if (!change.success && capacityFailure({ statusCode: change.http_status, message: change.error })) {
        capacityExhausted = true;
        if (isFree(result.plan)) {
          result.success = true; result.fallback = true; result.warning = change.error; result.error = undefined;
        }
      }
    } catch (error) {
      const detail = errorDetails(error);
      result.error = detail.message;
      if (!result.zone_created && (['network', 'timeout'].includes(detail.kind) || detail.statusCode >= 500)) result.outcome_uncertain = true;
      // Preserve this domain's receipt and continue with the next distinct input. Never repeat its create/write.
    }
  }
  return { total: results.length, succeeded: results.filter(result => result.success).length, failed: results.filter(result => !result.success).length,
    fallback_count: results.filter(result => result.fallback).length, pending_count: results.filter(result => result.activation_pending).length, results };
}
