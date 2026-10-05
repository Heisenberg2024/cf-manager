import { Router, Request, Response, NextFunction } from 'express';
import { findAccountByDomain, getAllZones } from '../services/accountRouter';
import { listDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord } from '../services/dnsService';
import { getZoneSettings, updateProxyStatus, createZone, deleteZone, updateZoneSettings, purgeZoneCache, setZoneStatus, invalidateZonesCache } from '../services/zoneService';
import { getAccountById } from '../models/account';
import { createAuditLog } from '../models/auditLog';
import { isDemoAccountId } from './routeUtils';
import { listRules, createRule, updateRule, deleteRule } from '../services/rulesetService';

import { config } from '../config';
import { previewBatch, verifyPreview, executeBatch, type BatchPreview } from '../services/dnsBatch';
import { dnsBatchRuntime, consumeDnsPreview } from '../services/dnsBatchRuntime';
import { errorDetails } from '../services/cfErrors';

const router = Router();
function zoneContext(req: Request) {
  return { accountId: Number(req.query.accountId) || undefined, zoneId: typeof req.query.zoneId === 'string' ? req.query.zoneId : undefined };
}

router.post('/batch/preview', async (req, res, next) => {
  try { res.json(await previewBatch(req.body, dnsBatchRuntime(), config.encryptionKey)); } catch (error) { next(error); }
});
router.post('/batch/execute', async (req, res, next) => {
  try {
    const plan = req.body as BatchPreview;
    await verifyPreview(plan, config.encryptionKey);
    consumeDnsPreview(plan);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const emit = async (event: unknown) => {
      if (!res.destroyed) { res.write(`data: ${JSON.stringify(event)}\n\n`); (res as Response & { flush?: () => void }).flush?.(); }
    };
    const heartbeat = setInterval(() => { if (!res.destroyed) { res.write(': heartbeat\n\n'); (res as Response & { flush?: () => void }).flush?.(); } }, 10_000);
    try { await executeBatch(plan, dnsBatchRuntime(), emit); }
    catch (error) { await emit({ type: 'error', message: errorDetails(error).message }); }
    finally { clearInterval(heartbeat); if (!res.destroyed) res.end(); }
  } catch (error) { next(error); }
});

router.get('/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await getAllZones(req.query.refresh === 'true');
    res.json(zones);
  } catch (err) { next(err); }
});

router.get('/domains/:domain/records', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    const records = await listDnsRecords(account, zoneId);
    res.json(records);
  } catch (err) { next(err); }
});

router.post('/domains/:domain/records', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    const record = await createDnsRecord(account, zoneId, req.body);
    createAuditLog(account.id, 'create_dns', domain, `type=${req.body.type} name=${req.body.name}`, 'success');
    res.status(201).json(record);
  } catch (err) { next(err); }
});

router.put('/domains/:domain/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    const record = await updateDnsRecord(account, zoneId, req.params.id as string, req.body);
    createAuditLog(account.id, 'update_dns', domain, `record_id=${req.params.id} fields=${Object.keys(req.body).join(',')}`, 'success');
    res.json(record);
  } catch (err) { next(err); }
});

router.delete('/domains/:domain/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除 DNS 记录' } });
      return;
    }
    await deleteDnsRecord(account, zoneId, req.params.id as string);
    createAuditLog(account.id, 'delete_dns', domain, `record_id=${req.params.id}`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/domains/:domain/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    const settings = await getZoneSettings(account, zoneId);
    res.json(settings);
  } catch (err) { next(err); }
});

router.patch('/domains/:domain/proxy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.body.record_id || typeof req.body.proxied !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'record_id and proxied (boolean) are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    await updateProxyStatus(account, zoneId, req.body.record_id, req.body.proxied);
    res.json({ success: true });
  } catch (err) { next(err); }
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
router.post('/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { names, account_id, type } = req.body;
    if (!Array.isArray(names) || !names.length || !account_id) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'names (string[]) and account_id are required' } });
      return;
    }
    const account = getAccountById(parseInt(account_id, 10));
    if (!account) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
      return;
    }
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可创建 Zone' } });
      return;
    }
    const zoneType = type === 'partial' ? 'partial' : 'full';

    const results = await batchProcess(
      names as string[],
      (name) => createZone(account, name.trim(), zoneType as 'full' | 'partial')
    );

    const formatted = results.map(r => ({
      name: r.item,
      success: !r.error,
      ...(r.result ? { zone_id: r.result.zone_id, name_servers: r.result.name_servers } : {}),
      ...(r.error ? { error: r.error } : {}),
    }));

    invalidateZonesCache();
    createAuditLog(account.id, 'batch_create_zone', `accounts/${account_id}`, `created ${formatted.filter(r => r.success).length}/${names.length} zones: ${names.join(', ')}`, 'success');

    res.status(201).json({
      total: names.length,
      succeeded: formatted.filter(r => r.success).length,
      failed: formatted.filter(r => !r.success).length,
      results: formatted,
    });
  } catch (err) { next(err); }
});

// 批量删除 Zone
router.delete('/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { domains } = req.body;
    if (!Array.isArray(domains) || !domains.length) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domains (string[]) is required' } });
      return;
    }

    const selections: Array<{ name: string; accountId?: number; zoneId?: string }> = domains.map((item: string | { name: string; accountId?: number; zoneId?: string }) => typeof item === 'string' ? { name: item, ...zoneContext(req) } : item);
    const results = await batchProcess(
      selections,
      async (selection) => {
        const domain = selection.name;
        const { account, zoneId } = await findAccountByDomain(domain, selection);
        if (isDemoAccountId(account.id)) {
          throw new Error('DEMO_PROTECTED: 演示账户不可删除 Zone');
        }
        await deleteZone(account, zoneId);
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

    invalidateZonesCache();
    const succeeded = results.filter(r => !r.error);
    if (succeeded.length > 0) {
      const firstAccount = succeeded[0].result!.account;
      createAuditLog(firstAccount.id, 'batch_delete_zone', 'multiple', `deleted ${succeeded.length}/${domains.length} zones: ${selections.map(s => `${s.name} (Account ${s.accountId || ''})`).join(', ')}`, 'success');
    }

    res.json({
      total: domains.length,
      succeeded: formatted.filter(r => r.success).length,
      failed: formatted.filter(r => !r.success).length,
      results: formatted,
    });
  } catch (err) { next(err); }
});

// 更新 Zone 设置
router.patch('/domains/:domain/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    const result = await updateZoneSettings(account, zoneId, req.body);
    createAuditLog(account.id, 'update_zone_settings', domain, `updated: ${result.updated.join(', ') || 'none'}${result.failed.length ? `, failed: ${result.failed.join(', ')}` : ''}`, result.failed.length ? 'error' : 'success');
    res.json(result);
  } catch (err) { next(err); }
});

// 清除 Zone 缓存
router.post('/domains/:domain/purge-cache', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    const result = await purgeZoneCache(account, zoneId, req.body);
    createAuditLog(account.id, 'purge_cache', domain, req.body.purge_everything ? 'purge_everything' : `purge ${(req.body.files || []).length} URLs`, 'success');
    res.json(result);
  } catch (err) { next(err); }
});

// 暂停/激活 Zone
router.patch('/domains/:domain/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    if (typeof req.body.paused !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'paused (boolean) is required' } });
      return;
    }
    await setZoneStatus(account, zoneId, req.body.paused);
    createAuditLog(account.id, 'update_zone_status', domain, `paused=${req.body.paused}`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ 通用规则引擎 ============

router.get('/domains/:domain/rules/:phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    res.json(await listRules(account, zoneId, req.params.phase as string));
  } catch (err) { next(err); }
});

router.post('/domains/:domain/rules/:phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { description, expression, action, action_parameters, enabled, ratelimit } = req.body;
    if (!expression || !action) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    const rule = await createRule(account, zoneId, req.params.phase as string, { description, expression, action, action_parameters, enabled, ratelimit });
    createAuditLog(account.id, 'create_rule', req.params.domain as string, `phase=${req.params.phase} action=${action}`, 'success');
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/domains/:domain/rules/:phase/:ruleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { description, expression, action, action_parameters, enabled, ratelimit } = req.body;
    if (!expression || !action) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    const rule = await updateRule(account, zoneId, req.params.phase as string, req.params.ruleId as string, { description, expression, action, action_parameters, enabled, ratelimit });
    createAuditLog(account.id, 'update_rule', req.params.domain as string, `phase=${req.params.phase} rule_id=${req.params.ruleId}`, 'success');
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/domains/:domain/rules/:phase/:ruleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除规则' } });
      return;
    }
    await deleteRule(account, zoneId, req.params.phase as string, req.params.ruleId as string);
    createAuditLog(account.id, 'delete_rule', req.params.domain as string, `phase=${req.params.phase} rule_id=${req.params.ruleId}`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
