import NodeCache from 'node-cache';
import { getActiveAccounts, getActiveAccountsByFeature, isPaidPlan, getAccountById, Account, AccountFeature } from '../models/account';
import { accountRequest } from './cfFactory';
import { dnsDirectory } from './dnsDirectory';
import { requireDnsBinding, parseZoneContext, type ZoneSnapshot } from './zoneDirectory';
import { isPaidModelName } from './aiService';
import { getAccountQuota, ResourceType } from './quotaTracker';
import { getQuotaTodayByResource } from '../models/quotaUsage';
import { appLogger } from './logger';
import pricingData from '../data/model-pricing.json';
import { mapConcurrent } from '../utils/concurrent';

const QUOTA_CACHE_TTL = 60;  // 1 minute
const AI_CACHE_KEY = 'ai_neuron_snapshot';
const AI_CACHE_TTL = 600; // 10 min

/** Threshold for cache affinity: prefer last-used account if it's within this many neurons of the best. */
const CACHE_AFFINITY_THRESHOLD = 10000;

/** Track the last successfully used AI account for cache-affine routing. */
let lastUsedAiAccount: { id: number; time: number } | null = null;

/** Check if a model supports prompt caching (has cachedInput in pricing). */
function modelSupportsCaching(model: string): boolean {
  return !!(pricingData.models[model as keyof typeof pricingData.models] as any)?.cachedInput;
}

interface AiSnapshotEntry {
  account: Account;
  used: number;
  _optimistic?: number;  // 乐观预估量，在 updateAiCacheAfterUsage 时修正
}

const quotaCache = new NodeCache({ stdTTL: QUOTA_CACHE_TTL });

export async function getAccountZones(accountId: number, refresh = false) {
  const account = requireDnsBinding(getAccountById(accountId));
  return dnsDirectory.list(account, accountRequest(account), { refresh });
}
export async function getZoneSnapshots(refresh = false, accountId?: number): Promise<ZoneSnapshot[]> {
  if (accountId !== undefined) return [await getAccountZones(accountId, refresh)];
  return mapConcurrent(getActiveAccountsByFeature('dns'), 3, async account => {
    try { return await dnsDirectory.list(account, accountRequest(account), { refresh }); }
    catch { appLogger.warn(`DNS Zone list failed for local Account ${account.id}`); return { zones: [], meta: { accountId: account.id, state: 'error', error: 'Account Zone fetch failed' } }; }
  });
}
export async function getAllZones(refresh = false, accountId?: number) {
  return (await getZoneSnapshots(refresh, accountId)).flatMap(snapshot => snapshot.zones);
}
export async function findAccountByDomain(domain: string, context: { accountId?: number; zoneId?: string } = {}): Promise<{ account: Account; zoneId: string }> {
  context = parseZoneContext(context);
  if (context.accountId && context.zoneId) {
    const account = requireDnsBinding(getAccountById(context.accountId));
    return dnsDirectory.resolve(account, accountRequest(account), domain, context.zoneId);
  }
  // Legacy callers still detect ambiguity, then validate the selected binding live.
  const snapshots = await getZoneSnapshots(true, context.accountId);
  if (snapshots.some(snapshot => snapshot.meta.state === 'error')) throw Object.assign(new Error('Account scan incomplete; specify accountId and zoneId'), { statusCode: 503, code: 'INCOMPLETE_ACCOUNT_SCAN' });
  const zones = snapshots.flatMap(snapshot => snapshot.zones);
  const matches = zones.filter(z => z.name.toLowerCase() === domain.toLowerCase() && (!context.zoneId || z.id === context.zoneId));
  if (matches.length > 1) throw Object.assign(new Error(`Domain ${domain} has multiple local Account bindings; specify accountId and zoneId`), { statusCode: 409, code: 'AMBIGUOUS_ACCOUNT' });
  const zone = matches[0];
  if (!zone) throw Object.assign(new Error(`Domain ${domain} not found in any account`), { statusCode: 404, code: 'DOMAIN_NOT_FOUND' });
  const account = requireDnsBinding(getAccountById(zone.cfAccountId));
  return dnsDirectory.resolve(account, accountRequest(account), domain, zone.id);
}

const RESOURCE_FEATURE_MAP: Record<ResourceType, AccountFeature> = {
  ai_neurons: 'ai',
  workers_requests: 'workers',
  browser_render_seconds: 'browser_render',
};

function getAiAccountSnapshot(): AiSnapshotEntry[] {
  const cached = quotaCache.get<AiSnapshotEntry[]>(AI_CACHE_KEY);
  if (cached && cached.length > 0) {
    appLogger.debug(`[AccountRouter] Using cached AI snapshot: ${cached.length} accounts, first=${cached[0]?.account.name}, used=${cached[0]?.used}`);
    return cached;
  }

  const accounts = getActiveAccountsByFeature('ai');
  appLogger.info(`[AccountRouter] Found ${accounts.length} active accounts with AI feature`);
  
  const usageRows = getQuotaTodayByResource('ai_neurons');
  const usageMap = new Map(usageRows.map(r => [r.account_id, r]));

  const ranked = accounts
    .map(account => {
      const usage = usageMap.get(account.id);
      const used = usage?.count || 0;
      const exhausted = usage?.exhausted === 1;
      appLogger.debug(`[AccountRouter] Account ${account.name}: used=${used}, exhausted=${exhausted}`);
      return { account, used, exhausted };
    })
    .filter(r => !r.exhausted)
    .sort((a, b) => a.used - b.used)
    .map(r => ({ account: r.account, used: r.used }));

  appLogger.info(`[AccountRouter] Final ranked list: ${ranked.map(r => `${r.account.name}(${r.used})`).join(', ')}`);

  quotaCache.set(AI_CACHE_KEY, ranked, AI_CACHE_TTL);
  return ranked;
}

export async function selectBestAccount(
  resource: ResourceType,
  excludeIds?: Set<number>,
  model?: string
): Promise<Account | null> {
  if (resource === 'ai_neurons') {
    const snapshot = getAiAccountSnapshot();
    // 付费模型（require_workers_paid）只允许付费计划账号承接；未标注/标为 free 的账号不可用。
    // 付费模型名单由 getAvailableModels 刷新（缓存未建立时 isPaidModelName 返回 false，行为不变）。
    const list = isPaidModelName(model)
      ? snapshot.filter(r => isPaidPlan(r.account.worker_plan))
      : snapshot;
    if (list.length === 0) {
      appLogger.warn(`[AccountRouter] Paid model "${model}" requested but no paid-plan account is available`);
      return null;
    }
    // 按实际用量 + 乐观预估量排序，避免并发选中同一账户
    list.sort((a, b) => (a.used + (a._optimistic || 0)) - (b.used + (b._optimistic || 0)));

    const best = list.find(r => !excludeIds?.has(r.account.id));
    if (!best) return null;

    const supportsCaching = model ? modelSupportsCaching(model) : false;

    // 缓存模型：优先复用最近使用的账户（软粘性），提升缓存命中率
    if (supportsCaching && lastUsedAiAccount) {
      const recent = list.find(r => r.account.id === lastUsedAiAccount!.id && !excludeIds?.has(r.account.id));
      if (recent && recent !== best) {
        const bestScore = best.used + (best._optimistic || 0);
        const recentScore = (recent.used || 0) + (recent._optimistic || 0);
        if (recentScore - bestScore <= CACHE_AFFINITY_THRESHOLD) {
          // 粘性：recent 没比 best 贵太多，值得为了缓存命中复用
          appLogger.debug(`[AccountRouter] Cache affinity: reusing ${recent.account.name} (gap=${recentScore - bestScore} <= ${CACHE_AFFINITY_THRESHOLD})`);
          recent._optimistic = (recent._optimistic || 0) + 1000;
          lastUsedAiAccount = { id: recent.account.id, time: Date.now() };
          return recent.account;
        }
      }
    }

    // 选 best（无缓存 或 缓存模型但粘性不划算）
    const selected = best;
    selected._optimistic = (selected._optimistic || 0) + 1000;
    if (supportsCaching) {
      lastUsedAiAccount = { id: selected.account.id, time: Date.now() };
    }
    appLogger.debug(`[AccountRouter] Selected account: ${selected.account.name} (optimistic +1000, total optimistic: ${selected._optimistic})`);
    return selected.account;
  }

  // 非 ai_neurons 分支保持原逻辑
  const cacheKey = `best_account_${resource}`;
  const cached = quotaCache.get<{ account: Account }>(cacheKey);
  if (cached) return cached.account;

  const feature = RESOURCE_FEATURE_MAP[resource];
  const accounts = feature ? getActiveAccountsByFeature(feature) : getActiveAccounts();
  if (accounts.length === 0) return null;

  let best = accounts[0];
  let bestRemaining = -1;

  for (const account of accounts) {
    const { remaining } = getAccountQuota(account.id, resource);
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      best = account;
    }
  }

  quotaCache.set(cacheKey, { account: best });
  return best;
}

export function invalidateAiCache(): void {
  quotaCache.del(AI_CACHE_KEY);
}

export function updateAiCacheAfterUsage(accountId: number, neurons: number): void {
  const list = quotaCache.get<AiSnapshotEntry[]>(AI_CACHE_KEY);
  if (!list) {
    appLogger.warn(`[AccountRouter] updateAiCacheAfterUsage: cache not found for account ${accountId}`);
    return;
  }
  const item = list.find(r => r.account.id === accountId);
  if (item) {
    const oldUsed = item.used;
    const oldOptimistic = item._optimistic || 0;
    // 加固用量，清除乐观预估
    item.used += neurons;
    delete item._optimistic;
    // 重新按实际用量 + 剩余乐观预估排序
    list.sort((a, b) => (a.used + (a._optimistic || 0)) - (b.used + (b._optimistic || 0)));
    appLogger.info(`[AccountRouter] Updated cache: ${item.account.name} ${oldUsed} → ${item.used} (+${neurons} real, cleared ${oldOptimistic} optimistic), new order: ${list.map(r => `${r.account.name}(${r.used}+${r._optimistic || 0})`).join(', ')}`);
  } else {
    appLogger.warn(`[AccountRouter] updateAiCacheAfterUsage: account ${accountId} not found in cache`);
  }
}

export function removeAccountFromAiCache(accountId: number): void {
  const list = quotaCache.get<AiSnapshotEntry[]>(AI_CACHE_KEY);
  if (list) {
    const idx = list.findIndex(r => r.account.id === accountId);
    if (idx >= 0) {
      const removed = list.splice(idx, 1)[0];
      if (list.length === 0) {
        quotaCache.del(AI_CACHE_KEY);
      }
      appLogger.info(`[AccountRouter] Removed account ${accountId} (${removed.account.name}) from AI cache, ${list.length} remaining`);
    } else {
      appLogger.debug(`[AccountRouter] removeAccountFromAiCache: account ${accountId} not in cache`);
    }
  } else {
    appLogger.debug(`[AccountRouter] removeAccountFromAiCache: cache not found`);
  }
}

export function clearCache(resource?: ResourceType): void {
  if (resource) {
    if (resource === 'ai_neurons') {
      invalidateAiCache();
    } else {
      const cacheKey = `best_account_${resource}`;
      quotaCache.del(cacheKey);
    }
  } else {
    // Clear all caches (backward compatibility)
    dnsDirectory.invalidate();
    quotaCache.flushAll();
  }
}
