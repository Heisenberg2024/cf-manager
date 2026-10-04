import { Hono } from 'hono';
import type { Env } from '../types';
import { getActiveAccountsByFeature, addAuditLog, getAccountById } from '../db/models';
import { cfFetch, cfFetchAll, accountRequest } from '../services/cfApi';
import { listRules, createRule, updateRule, deleteRule } from '../services/rulesetService';
import { isDemoAccount } from '../services/demo';

import { mapConcurrent } from '../utils/concurrent';
import { readZoneSettings, writeZoneSettings } from '../services/zoneSettings';

const app = new Hono<{ Bindings: Env }>();
function zoneContext(c: { req: { query(name: string): string | undefined } }) {
  return { accountId: Number(c.req.query('accountId')) || undefined, zoneId: c.req.query('zoneId') };
}

const ZONES_CACHE_KEY = 'dns_zones_all';
const ZONES_CACHE_TTL = 300; // 5 minutes

async function getAllZones(db: D1Database, encryptionKey: string, kv: KVNamespace, refresh = false): Promise<any[]> {
  const cached = await kv.get(ZONES_CACHE_KEY, 'json');
  if (cached && !refresh) return cached as any[];

  const accounts = await getActiveAccountsByFeature(db, 'dns');
  const results = await mapConcurrent(accounts, 3, async (account) => {
    try {
      if (!account.account_id) return [];
      const zones = await cfFetchAll<any>(account, `/zones?account.id=${account.account_id}`, encryptionKey, 50);
      return zones.filter(z => z.account?.id === account.account_id).map(z => ({ ...z, status: z.paused ? 'paused' : z.status, cfAccountId: account.id, accountName: account.name }));
    } catch (e) {
      console.error(`Failed to fetch zones for ${account.name}: ${e}`);
      return [];
    }
  });
  const allZones = results.flat();

  await kv.put(ZONES_CACHE_KEY, JSON.stringify(allZones), { expirationTtl: ZONES_CACHE_TTL });
  return allZones;
}

async function invalidateZonesCache(kv: KVNamespace) {
  await kv.delete(ZONES_CACHE_KEY);
}

async function findAccountByDomain(db: D1Database, domain: string, encryptionKey: string, kv: KVNamespace, context: { accountId?: number; zoneId?: string } = {}) {
  const zones = await getAllZones(db, encryptionKey, kv);
  const matches = zones.filter((z: any) => z.name === domain && (!context.accountId || z.cfAccountId === context.accountId) && (!context.zoneId || z.id === context.zoneId));
  if (matches.length > 1) throw Object.assign(new Error(`Domain ${domain} has multiple local Account bindings; specify accountId and zoneId`), { statusCode: 409, code: 'AMBIGUOUS_ACCOUNT' });
  const zone = matches[0];
  if (!zone) throw Object.assign(new Error(`Domain ${domain} not found`), { statusCode: 404 });
  const accounts = await getActiveAccountsByFeature(db, 'dns');
  const account = accounts.find(a => a.id === zone.cfAccountId);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return { account, zoneId: zone.id };
}

app.get('/domains', async (c) => {
  const zones = await getAllZones(c.env.DB, c.env.ENCRYPTION_KEY, c.env.KV, c.req.query('refresh') === 'true');
  return c.json(zones);
});

app.get('/domains/:domain/records', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  return c.json(await cfFetchAll(account, `/zones/${zoneId}/dns_records`, c.env.ENCRYPTION_KEY, 100));
});

app.post('/domains/:domain/records', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可新增 DNS 记录' } }, 403);
  }
  const body = await c.req.json();
  const data = await cfFetch(account, `/zones/${zoneId}/dns_records`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_dns', target: domain, detail: `${body.type} ${body.name} → ${body.content}`, status: 'success' });
  return c.json(data.result, 201);
});

app.put('/domains/:domain/records/:id', async (c) => {
  const domain = c.req.param('domain');
  const recordId = c.req.param('id');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改 DNS 记录' } }, 403);
  }
  const body = await c.req.json();
  const data = await cfFetch(account, `/zones/${zoneId}/dns_records/${recordId}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_dns', target: domain, detail: `${body.type || ''} ${body.name || ''} → ${body.content || ''}`, status: 'success' });
  return c.json(data.result);
});

app.delete('/domains/:domain/records/:id', async (c) => {
  const domain = c.req.param('domain');
  const recordId = c.req.param('id');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除 DNS 记录' } }, 403);
  }
  await cfFetch(account, `/zones/${zoneId}/dns_records/${recordId}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_dns', target: domain, detail: `record_id=${recordId}`, status: 'success' });
  return c.json({ success: true });
});

app.get('/domains/:domain/settings', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  return c.json(await readZoneSettings(await accountRequest(account, c.env.ENCRYPTION_KEY), zoneId));
});

app.patch('/domains/:domain/proxy', async (c) => {
  const body = await c.req.json();
  if (!body.record_id || typeof body.proxied !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'record_id and proxied (boolean) are required' } }, 400);
  }
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改 DNS 代理状态' } }, 403);
  }
  await cfFetch(account, `/zones/${zoneId}/dns_records/${body.record_id}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ proxied: body.proxied }),
  });
  return c.json({ success: true });
});

// ============ Zone 管理 ============

/** 批量并发处理辅助函数 */
async function batchProcess<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 3
): Promise<Array<{ item: T; result?: R; error?: string }>> {
  const results: Array<{ item: T; result?: R; error?: string }> = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled.map((s, j) => ({
      item: batch[j],
      result: s.status === 'fulfilled' ? (s as PromiseFulfilledResult<R>).value : undefined,
      error: s.status === 'rejected' ? String((s as PromiseRejectedResult).reason) : undefined,
    })));
  }
  return results;
}

// 批量创建 Zone
app.post('/domains', async (c) => {
  const body = await c.req.json();
  const { names, account_id, type } = body;
  if (!Array.isArray(names) || !names.length || !account_id) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'names (string[]) and account_id are required' } }, 400);
  }

  const account = await getAccountById(c.env.DB, parseInt(account_id, 10));
  if (!account) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
  }
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可创建 Zone' } }, 403);
  }
  const zoneType = type === 'partial' ? 'partial' : 'full';

  const results = await batchProcess(
    names as string[],
    async (name) => {
      const data = await cfFetch<any>(account, '/zones', c.env.ENCRYPTION_KEY, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), account: { id: account.account_id }, type: zoneType }),
      });
      return { zone_id: data.result?.id || '', name_servers: data.result?.name_servers || [] };
    }
  );

  const formatted = results.map(r => ({
    name: r.item,
    success: !r.error,
    ...(r.result ? { zone_id: r.result.zone_id, name_servers: r.result.name_servers } : {}),
    ...(r.error ? { error: r.error } : {}),
  }));

  await invalidateZonesCache(c.env.KV);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'batch_create_zone', target: `accounts/${account_id}`, detail: `created ${formatted.filter(r => r.success).length}/${names.length} zones: ${names.join(', ')}`, status: 'success' });

  return c.json({
    total: names.length,
    succeeded: formatted.filter(r => r.success).length,
    failed: formatted.filter(r => !r.success).length,
    results: formatted,
  }, 201);
});

// 批量删除 Zone
app.delete('/domains', async (c) => {
  const body = await c.req.json();
  const { domains } = body;
  if (!Array.isArray(domains) || !domains.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'domains (string[]) is required' } }, 400);
  }

  const selections: Array<{ name: string; accountId?: number; zoneId?: string }> = domains.map((item: string | { name: string; accountId?: number; zoneId?: string }) => typeof item === 'string' ? { name: item, ...zoneContext(c) } : item);
  const results = await batchProcess(
    selections,
    async (selection) => {
      const domain = selection.name;
      const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, selection);
      if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
        throw new Error('DEMO_PROTECTED: 演示账户不可删除 Zone');
      }
      await cfFetch(account, `/zones/${zoneId}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
      return { domain, account };
    }
  );

  const formatted = results.map(r => ({
    name: r.item.name,
    accountId: r.item.accountId,
    zoneId: r.item.zoneId,
    success: !r.error,
    ...(r.error ? { error: r.error } : {}),
  }));

  await invalidateZonesCache(c.env.KV);
  const succeeded = results.filter(r => !r.error);
  if (succeeded.length > 0) {
    const firstAccount = succeeded[0].result!.account;
    await addAuditLog(c.env.DB, { account_id: firstAccount.id, action: 'batch_delete_zone', target: 'multiple', detail: `deleted ${succeeded.length}/${domains.length} zones: ${selections.map(s => `${s.name} (Account ${s.accountId || ''})`).join(', ')}`, status: 'success' });
  }

  return c.json({
    total: domains.length,
    succeeded: formatted.filter(r => r.success).length,
    failed: formatted.filter(r => !r.success).length,
    results: formatted,
  });
});

// 更新 Zone 设置
app.patch('/domains/:domain/settings', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const body = await c.req.json();

  const result = await writeZoneSettings(await accountRequest(account, c.env.ENCRYPTION_KEY), zoneId, body);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_zone_settings', target: domain, detail: `updated: ${result.updated.join(', ')}; failed: ${result.failed.join(', ')}`, status: result.failed.length ? 'error' : 'success' });
  return c.json(result);
});

// 清除 Zone 缓存
app.post('/domains/:domain/purge-cache', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const body = await c.req.json();
  const data = await cfFetch<any>(account, `/zones/${zoneId}/purge_cache`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'purge_cache', target: domain, detail: body.purge_everything ? 'purge_everything' : `purge ${(body.files || []).length} URLs`, status: 'success' });
  return c.json({ id: data.result?.id || '' });
});

// 暂停/激活 Zone
app.patch('/domains/:domain/status', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const body = await c.req.json();
  if (typeof body.paused !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'paused (boolean) is required' } }, 400);
  }
  await cfFetch(account, `/zones/${zoneId}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ paused: body.paused }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_zone_status', target: domain, detail: `paused=${body.paused}`, status: 'success' });
  return c.json({ success: true });
});

// ============ 通用规则引擎 ============

app.get('/domains/:domain/rules/:phase', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  return c.json(await listRules(account, zoneId, c.req.param('phase'), c.env.ENCRYPTION_KEY));
});

app.post('/domains/:domain/rules/:phase', async (c) => {
  const body = await c.req.json();
  const { description, expression, action, action_parameters, enabled, ratelimit } = body;
  if (!expression || !action) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } }, 400);
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const rule = await createRule(account, zoneId, c.req.param('phase'), { description, expression, action, action_parameters, enabled, ratelimit }, c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_rule', target: c.req.param('domain'), detail: `phase=${c.req.param('phase')} action=${action}`, status: 'success' });
  return c.json(rule, 201);
});

app.put('/domains/:domain/rules/:phase/:ruleId', async (c) => {
  const body = await c.req.json();
  const { description, expression, action, action_parameters, enabled, ratelimit } = body;
  if (!expression || !action) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } }, 400);
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const rule = await updateRule(account, zoneId, c.req.param('phase'), c.req.param('ruleId'), { description, expression, action, action_parameters, enabled, ratelimit }, c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_rule', target: c.req.param('domain'), detail: `phase=${c.req.param('phase')} rule_id=${c.req.param('ruleId')}`, status: 'success' });
  return c.json(rule);
});

app.delete('/domains/:domain/rules/:phase/:ruleId', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除 WAF 规则' } }, 403);
  }
  await deleteRule(account, zoneId, c.req.param('phase'), c.req.param('ruleId'), c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_rule', target: c.req.param('domain'), detail: `phase=${c.req.param('phase')} rule_id=${c.req.param('ruleId')}`, status: 'success' });
  return c.json({ success: true });
});

export default app;
