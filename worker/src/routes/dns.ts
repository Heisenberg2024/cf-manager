import { Hono } from 'hono';
import { getDnsDirectory } from '../services/dnsDirectory';
import { requireDnsBinding, recordPageQuery, parseZoneContext } from '../services/zoneDirectory';
import { dnsRecordId } from '../services/dnsRecord';
import type { Env } from '../types';
import { getActiveAccountsByFeature, addAuditLog, getAccountById } from '../db/models';
import { cfFetch, accountRequest } from '../services/cfApi';
import { listRules, createRule, updateRule, deleteRule } from '../services/rulesetService';
import { isDemoAccount } from '../services/demo';

import { mapConcurrent } from '../utils/concurrent';
import { getZoneSettingsRuntime } from '../services/zoneSettingsRuntime';

import { streamSSE } from 'hono/streaming';
import { previewBatch, verifyPreview, executeBatch, type BatchPreview } from '../services/dnsBatch';
import { dnsBatchRuntime, consumeDnsPreview } from '../services/dnsBatchRuntime';
import { errorDetails } from '../services/cfErrors';
import { changeZonePlan, createZonesWithPlan, getExistingZonePlanOptions, getZonePlanOptions, parseCreateZonesInput, parseZonePlan } from '../services/zonePlans';

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => { await next(); c.header('Cache-Control', c.req.path.endsWith('/batch/execute') ? 'no-store, no-transform' : 'no-store'); });
function zoneContext(c: { req: { query(name: string): string | undefined } }) {
  return parseZoneContext({ accountId: c.req.query('accountId'), zoneId: c.req.query('zoneId') });
}

async function getAccountZones(db: D1Database, encryptionKey: string, accountId: number, refresh = false, waitUntil?: (promise: Promise<unknown>) => void) {
  const account = requireDnsBinding(await getAccountById(db, accountId));
  return getDnsDirectory(db).list(account, await accountRequest(account, encryptionKey), { refresh, waitUntil });
}
async function getZoneSnapshots(db: D1Database, encryptionKey: string, refresh = false, accountId?: number, waitUntil?: (promise: Promise<unknown>) => void) {
  if (accountId !== undefined) return [await getAccountZones(db, encryptionKey, accountId, refresh, waitUntil)];
  return mapConcurrent(await getActiveAccountsByFeature(db, 'dns'), 3, async account => {
    try { return await getDnsDirectory(db).list(account, await accountRequest(account, encryptionKey), { refresh, waitUntil }); }
    catch { console.warn(`DNS Zone list failed for local Account ${account.id}`); return { zones: [], meta: { accountId: account.id, state: 'error' as const, error: 'Account Zone fetch failed' } }; }
  });
}
async function invalidateZonesCache(db: D1Database, accountId?: number, cloudflareAccountId?: string | null) { getDnsDirectory(db).invalidate(accountId, cloudflareAccountId); getZoneSettingsRuntime(db).invalidate(accountId,cloudflareAccountId); }
async function findAccountByDomain(db: D1Database, domain: string, encryptionKey: string, kv: KVNamespace, context: { accountId?: number; zoneId?: string } = {}) {
  context = parseZoneContext(context);
  const directory = getDnsDirectory(db);
  if (context.accountId && context.zoneId) {
    const account = requireDnsBinding(await getAccountById(db, context.accountId));
    return directory.resolve(account, await accountRequest(account, encryptionKey), domain, context.zoneId);
  }
  const snapshots = await getZoneSnapshots(db, encryptionKey, true, context.accountId);
  if (snapshots.some(snapshot => snapshot.meta.state === 'error')) throw Object.assign(new Error('Account scan incomplete; specify accountId and zoneId'), { statusCode: 503, code: 'INCOMPLETE_ACCOUNT_SCAN' });
  const zones = snapshots.flatMap(snapshot => snapshot.zones);
  const matches = zones.filter(z => z.name.toLowerCase() === domain.toLowerCase() && (!context.zoneId || z.id === context.zoneId));
  if (matches.length > 1) throw Object.assign(new Error(`Domain ${domain} has multiple local Account bindings; specify accountId and zoneId`), { statusCode: 409, code: 'AMBIGUOUS_ACCOUNT' });
  const zone = matches[0];
  if (!zone) throw Object.assign(new Error(`Domain ${domain} not found`), { statusCode: 404 });
  const account = requireDnsBinding(await getAccountById(db, zone.cfAccountId));
  return directory.resolve(account, await accountRequest(account, encryptionKey), domain, zone.id);
}

app.post('/batch/preview', async c => c.json(await previewBatch(await c.req.json(), dnsBatchRuntime(c.env), c.env.ENCRYPTION_KEY)));
app.post('/batch/execute', async c => {
  const plan = await c.req.json<BatchPreview>();
  await verifyPreview(plan, c.env.ENCRYPTION_KEY);
  await consumeDnsPreview(c.env, plan);
  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-store, no-transform');
  return streamSSE(c, async stream => {
    const emit = async (event: unknown) => { if (!stream.aborted) await stream.writeSSE({ data: JSON.stringify(event) }); };
    const heartbeat = setInterval(() => { if (!stream.aborted) void stream.write(': heartbeat\n\n').catch(() => {}); }, 10_000);
    try { await executeBatch(plan, dnsBatchRuntime(c.env), emit); }
    catch (error) { await emit({ type: 'error', message: errorDetails(error).message }); }
    finally { clearInterval(heartbeat); }
  });
});

app.get('/domains', async (c) => {
  const snapshots = await getZoneSnapshots(c.env.DB, c.env.ENCRYPTION_KEY, c.req.query('refresh') === 'true', zoneContext(c).accountId, promise => c.executionCtx.waitUntil(promise));
  c.header('X-DNS-Failed-Accounts', snapshots.filter(snapshot => snapshot.meta.state === 'error').map(snapshot => snapshot.meta.accountId).join(','));
  c.header('X-DNS-Stale-Accounts', snapshots.filter(snapshot => snapshot.meta.state === 'stale').map(snapshot => snapshot.meta.accountId).join(','));
  return c.json(snapshots.flatMap(snapshot => snapshot.zones), snapshots.some(snapshot => snapshot.meta.state === 'error') ? 206 : 200);
});

app.get('/accounts/:accountId/domains', async c => c.json(await getAccountZones(c.env.DB, c.env.ENCRYPTION_KEY, Number(c.req.param('accountId')), c.req.query('refresh') === 'true', promise => c.executionCtx.waitUntil(promise))));

app.get('/domains/:domain/records', async (c) => {
  const pageQuery = recordPageQuery(c.req.query());
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (pageQuery) {
    return c.json(await getDnsDirectory(c.env.DB).page(account, await accountRequest(account, c.env.ENCRYPTION_KEY), `/zones/${encodeURIComponent(zoneId)}/dns_records?${pageQuery}`, c.req.raw.signal));
  }
  return c.json(await getDnsDirectory(c.env.DB).all(account, await accountRequest(account, c.env.ENCRYPTION_KEY), `/zones/${zoneId}/dns_records`, 500, { signal: c.req.raw.signal }));
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
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_dns', target: domain, detail: `type=${body.type} name=${body.name}`, status: 'success' });
  return c.json(data.result, 201);
});

app.put('/domains/:domain/records/:id', async (c) => {
  const domain = c.req.param('domain');
  const recordId = dnsRecordId(c.req.param('id'));
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改 DNS 记录' } }, 403);
  }
  const body = await c.req.json();
  const data = await cfFetch(account, `/zones/${zoneId}/dns_records/${recordId}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_dns', target: domain, detail: `record_id=${recordId} fields=${Object.keys(body).join(',')}`, status: 'success' });
  return c.json(data.result);
});

app.delete('/domains/:domain/records/:id', async (c) => {
  const domain = c.req.param('domain');
  const recordId = dnsRecordId(c.req.param('id'));
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
  return c.json(await getZoneSettingsRuntime(c.env.DB).read(account,await accountRequest(account,c.env.ENCRYPTION_KEY),zoneId,{refresh:c.req.query('refresh')==='true',signal:c.req.raw.signal,waitUntil:promise=>{try{c.executionCtx.waitUntil(promise);}catch{ /* Local adapters have no execution context. */ }}}));
});

app.patch('/domains/:domain/proxy', async (c) => {
  const body = await c.req.json();
  if (!body.record_id || typeof body.proxied !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'record_id and proxied (boolean) are required' } }, 400);
  }
  body.record_id = dnsRecordId(body.record_id);
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改 DNS 代理状态' } }, 403);
  }
  const data = await cfFetch(account, `/zones/${zoneId}/dns_records/${body.record_id}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ proxied: body.proxied }),
  });
  return c.json({ success: true, data: { success: true, record: data.result } });
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
      error: s.status === 'rejected' ? errorDetails((s as PromiseRejectedResult).reason).message : undefined,
    })));
  }
  return results;
}

// 批量创建 Zone
app.post('/domains', async (c) => {
  const body = await c.req.json();
  const input = parseCreateZonesInput(body);
  const account = await getAccountById(c.env.DB, input.account_id);
  if (!account) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
  }
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可创建 Zone' } }, 403);
  }
  const result = await createZonesWithPlan(await accountRequest(account, c.env.ENCRYPTION_KEY), account.account_id || '', input);

  await invalidateZonesCache(c.env.DB, account.id, account.account_id);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'batch_create_zone', target: `accounts/${input.account_id}`, detail: `plan=${input.plan}; succeeded ${result.succeeded}/${result.total}; Free fallback ${result.fallback_count}; pending ${result.pending_count}; ${result.results.map(row => `${row.name}: ${row.plan?.name || 'unknown'}${row.activation_pending ? ' (pending)' : row.error ? ' (failed)' : ''}`).join(', ')}`, status: result.failed ? 'error' : 'success' });
  return c.json(result, 201);
});

app.get('/accounts/:accountId/plans', async (c) => {
  const account = await getAccountById(c.env.DB, Number(c.req.param('accountId')));
  if (!account?.account_id) return c.json({ error: { code: 'NOT_FOUND', message: 'Account with Cloudflare Account ID not found' } }, 404);
  return c.json(await getZonePlanOptions(await accountRequest(account, c.env.ENCRYPTION_KEY), account.account_id));
});

app.get('/domains/:domain/plans', async c => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  return c.json(await getExistingZonePlanOptions(await accountRequest(account, c.env.ENCRYPTION_KEY), account.account_id || '', zoneId));
});

app.patch('/domains/:domain/plan', async c => {
  const plan = parseZonePlan(await c.req.json());
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改 Zone 套餐' } }, 403);
  const result = await changeZonePlan(await accountRequest(account, c.env.ENCRYPTION_KEY), account.account_id || '', zoneId, plan);
  await invalidateZonesCache(c.env.DB, account.id, account.account_id);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'change_zone_plan', target: domain, detail: `zone=${zoneId}; requested=${plan}; actual=${result.plan?.id || 'unknown'}; pending=${!!result.activation_pending}; uncertain=${!!result.outcome_uncertain}`, status: result.success ? 'success' : 'error' });
  return c.json({ success: true, data: result });
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
      try { await cfFetch(account, `/zones/${zoneId}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' }); } finally { await invalidateZonesCache(c.env.DB, account.id, account.account_id); }
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

  if(isDemoAccount(account.id,c.env.DEMO_ACCOUNT_IDS)) return c.json({error:{code:'DEMO_PROTECTED',message:'演示账户不可修改 Zone 设置'}},403);
  if(c.req.header('Accept')?.includes('text/event-stream'))return streamSSE(c,async stream=>{
    const emit=async(event:unknown)=>{try{await stream.writeSSE({data:JSON.stringify(event)});}catch{/* The client may have changed views. */}};
    try{const result=await getZoneSettingsRuntime(c.env.DB).write(account,getDnsDirectory(c.env.DB).wrap(account,await accountRequest(account,c.env.ENCRYPTION_KEY)),zoneId,body,emit);await addAuditLog(c.env.DB,{account_id:account.id,action:'update_zone_settings',target:domain,detail:`updated: ${result.updated.join(', ')}; failed: ${result.failed.join(', ')}`,status:result.failed.length?'error':'success'});await emit({type:'done',result});}
    catch(error){await emit({type:'error',message:errorDetails(error).message});}
  });
  const result = await getZoneSettingsRuntime(c.env.DB).write(account,getDnsDirectory(c.env.DB).wrap(account,await accountRequest(account,c.env.ENCRYPTION_KEY)),zoneId,body);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_zone_settings', target: domain, detail: `updated: ${result.updated.join(', ')}; failed: ${result.failed.join(', ')}`, status: result.failed.length ? 'error' : 'success' });
  return c.json(result);
});

// 清除 Zone 缓存
app.post('/domains/:domain/purge-cache', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const body = await c.req.json();
  if(isDemoAccount(account.id,c.env.DEMO_ACCOUNT_IDS)) return c.json({error:{code:'DEMO_PROTECTED',message:'演示账户不可清除缓存'}},403);
  const data = await cfFetch<any>(account, `/zones/${zoneId}/purge_cache`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'purge_cache', target: domain, detail: body.purge_everything ? 'purge_everything' : `purge ${(body.files || []).length} URLs`, status: 'success' });
  if(!data.result?.id) return c.json({error:{code:'CF_OUTCOME_UNCERTAIN',message:'Cache purge receipt missing; execution result unknown'}},502);
  return c.json({ id: data.result.id });
});

// 暂停/激活 Zone
app.patch('/domains/:domain/status', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY, c.env.KV, zoneContext(c));
  const body = await c.req.json();
  if (typeof body.paused !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'paused (boolean) is required' } }, 400);
  }
  if(isDemoAccount(account.id,c.env.DEMO_ACCOUNT_IDS)) return c.json({error:{code:'DEMO_PROTECTED',message:'演示账户不可修改 Zone 状态'}},403);
  let receipt;
  try { receipt=await cfFetch<any>(account, `/zones/${zoneId}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ paused: body.paused }),
  }); } catch(error) { await invalidateZonesCache(c.env.DB, account.id, account.account_id); throw error; }
  if(receipt.result?.id!==zoneId || receipt.result?.paused!==body.paused){await invalidateZonesCache(c.env.DB,account.id,account.account_id);return c.json({error:{code:'CF_OUTCOME_UNCERTAIN',message:'Zone status result not confirmed; refresh before retrying'}},502);}
  getDnsDirectory(c.env.DB).updateZone(account,zoneId,receipt.result);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_zone_status', target: domain, detail: `paused=${body.paused}`, status: 'success' });
  return c.json({ success: true,id:receipt.result.id,paused:receipt.result.paused,status:receipt.result.status });
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
