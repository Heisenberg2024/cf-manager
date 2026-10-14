import { Router, Request, Response, NextFunction } from 'express';
import { findAccountByDomain, getZoneSnapshots, getAccountZones } from '../services/accountRouter';
import { listDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord } from '../services/dnsService';
import { getZoneSettings, updateProxyStatus, deleteZone, updateZoneSettings, purgeZoneCache, setZoneStatus, invalidateZonesCache } from '../services/zoneService';
import { getAccountById } from '../models/account';
import { createAuditLog } from '../models/auditLog';
import { isDemoAccountId } from './routeUtils';
import { listRules, createRule, updateRule, deleteRule } from '../services/rulesetService';

import { config } from '../config';
import { previewBatch, verifyPreview, executeBatch, type BatchPreview } from '../services/dnsBatch';
import { dnsBatchRuntime, consumeDnsPreview } from '../services/dnsBatchRuntime';
import { errorDetails } from '../services/cfErrors';
import { accountRequest } from '../services/cfFactory';
import { changeZonePlan, createZonesWithPlan, getExistingZonePlanOptions, getZonePlanOptions, parseCreateZonesInput, parseZonePlan } from '../services/zonePlans';
import { recordPageQuery, parseZoneContext } from '../services/zoneDirectory';
import { dnsDirectory } from '../services/dnsDirectory';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
function zoneContext(req: Request) {
  return parseZoneContext(req.query);
}

router.post('/batch/preview', async (req, res, next) => {
  try { res.json(await previewBatch(req.body, dnsBatchRuntime(), config.encryptionKey)); } catch (error) { next(error); }
});
router.post('/batch/execute', async (req, res, next) => {
  try {
    const plan = req.body as BatchPreview;
    await verifyPreview(plan, config.encryptionKey);
    consumeDnsPreview(plan);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
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
    const snapshots = await getZoneSnapshots(req.query.refresh === 'true', parseZoneContext(req.query).accountId);
    res.setHeader('X-DNS-Failed-Accounts', snapshots.filter(snapshot => snapshot.meta.state === 'error').map(snapshot => snapshot.meta.accountId).join(','));
    res.setHeader('X-DNS-Stale-Accounts', snapshots.filter(snapshot => snapshot.meta.state === 'stale').map(snapshot => snapshot.meta.accountId).join(','));
    if (snapshots.some(snapshot => snapshot.meta.state === 'error')) res.status(206);
    res.json(snapshots.flatMap(snapshot => snapshot.zones));
  } catch (err) { next(err); }
});

router.get('/accounts/:accountId/domains', async (req, res, next) => {
  try { res.json(await getAccountZones(Number(req.params.accountId), req.query.refresh === 'true')); } catch (error) { next(error); }
});

router.get('/accounts/:accountId/plans', async (req, res, next) => {
  try {
    const account = getAccountById(Number(req.params.accountId));
    if (!account?.account_id) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account with Cloudflare Account ID not found' } }); return; }
    res.json(await getZonePlanOptions(accountRequest(account), account.account_id));
  } catch (error) { next(error); }
});

router.get('/domains/:domain/plans', async (req, res, next) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    res.json(await getExistingZonePlanOptions(accountRequest(account), account.account_id || '', zoneId));
  } catch (error) { next(error); }
});

router.patch('/domains/:domain/plan', async (req, res, next) => {
  try {
    const plan = parseZonePlan(req.body);
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改 Zone 套餐' } }); return;
    }
    const result = await changeZonePlan(accountRequest(account), account.account_id || '', zoneId, plan);
    invalidateZonesCache(account.id, account.account_id);
    createAuditLog(account.id, 'change_zone_plan', domain, `zone=${zoneId}; requested=${plan}; actual=${result.plan?.id || 'unknown'}; pending=${!!result.activation_pending}; uncertain=${!!result.outcome_uncertain}`, result.success ? 'success' : 'error');
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.get('/domains/:domain/records', async (req: Request, res: Response, next: NextFunction) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const pageQuery = recordPageQuery(req.query);
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    if (pageQuery) {
      res.json(await dnsDirectory.page(account, accountRequest(account), `/zones/${encodeURIComponent(zoneId)}/dns_records?${pageQuery}`, controller.signal)); return;
    }
    const records = await listDnsRecords(account, zoneId, controller.signal);
    res.json(records);
  } catch (err) { next(err); }
});

router.post('/domains/:domain/records', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: 'Demo Account DNS is read-only' } }); return; }
    const record = await createDnsRecord(account, zoneId, req.body);
    createAuditLog(account.id, 'create_dns', domain, `type=${req.body.type} name=${req.body.name}`, 'success');
    res.status(201).json(record);
  } catch (err) { next(err); }
});

router.put('/domains/:domain/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain, zoneContext(req));
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: 'Demo Account DNS is read-only' } }); return; }
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
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const settings = await getZoneSettings(account, zoneId,{refresh:req.query.refresh==='true',signal:controller.signal});
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
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: 'Demo Account DNS is read-only' } }); return; }
    const record = await updateProxyStatus(account, zoneId, req.body.record_id, req.body.proxied);
    res.json({ success: true, data: { success: true, record } });
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
      error: s.status === 'rejected' ? errorDetails((s as PromiseRejectedResult).reason).message : undefined,
    })));
  }
  return results;
}

// 批量创建 Zone
router.post('/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseCreateZonesInput(req.body);
    const account = getAccountById(input.account_id);
    if (!account) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
      return;
    }
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可创建 Zone' } });
      return;
    }
    const result = await createZonesWithPlan(accountRequest(account), account.account_id || '', input);

    invalidateZonesCache(account.id, account.account_id);
    createAuditLog(account.id, 'batch_create_zone', `accounts/${input.account_id}`, `plan=${input.plan}; succeeded ${result.succeeded}/${result.total}; Free fallback ${result.fallback_count}; pending ${result.pending_count}; ${result.results.map(row => `${row.name}: ${row.plan?.name || 'unknown'}${row.activation_pending ? ' (pending)' : row.error ? ' (failed)' : ''}`).join(', ')}`, result.failed ? 'error' : 'success');
    res.status(201).json(result);
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
        try { await deleteZone(account, zoneId); } finally { invalidateZonesCache(account.id, account.account_id); }
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
    if(isDemoAccountId(account.id)){res.status(403).json({error:{code:'DEMO_PROTECTED',message:'演示账户不可修改 Zone 设置'}});return;}
    if(req.headers.accept?.includes('text/event-stream')){
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});res.flushHeaders();
      const emit=(event:unknown)=>{if(!res.destroyed)res.write(`data: ${JSON.stringify(event)}\n\n`);};
      const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},10000);
      try{const result=await updateZoneSettings(account,zoneId,req.body,emit);createAuditLog(account.id,'update_zone_settings',domain,`updated: ${result.updated.join(', ')}; failed: ${result.failed.join(', ')}`,result.failed.length?'error':'success');emit({type:'done',result});}
      catch(error){emit({type:'error',message:errorDetails(error).message});}
      finally{clearInterval(heartbeat);res.end();}return;
    }
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
    if(isDemoAccountId(account.id)){res.status(403).json({error:{code:'DEMO_PROTECTED',message:'演示账户不可清除缓存'}});return;}
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
    if(isDemoAccountId(account.id)){res.status(403).json({error:{code:'DEMO_PROTECTED',message:'演示账户不可修改 Zone 状态'}});return;}
    let receipt;
    try { receipt=await setZoneStatus(account, zoneId, req.body.paused); dnsDirectory.updateZone(account,zoneId,receipt); } catch(error) { invalidateZonesCache(account.id, account.account_id); throw error; }
    createAuditLog(account.id, 'update_zone_status', domain, `paused=${req.body.paused}`, 'success');
    res.json({ success: true, ...receipt });
  } catch (err) { next(err); }
});

// ============ 通用规则引擎 ============

router.get('/domains/:domain/rules/:phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    res.json(await listRules(account, zoneId, req.params.phase as string, req.query.refresh === 'true'));
  } catch (err) { next(err); }
});

router.post('/domains/:domain/rules/:phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { expression, action } = req.body;
    if (!expression || !action) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改规则' } }); return; }
    const rule = await createRule(account, zoneId, req.params.phase as string, req.body);
    createAuditLog(account.id, 'create_rule', req.params.domain as string, `phase=${req.params.phase} action=${action}`, rule.status === 'success' ? 'success' : 'error');
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/domains/:domain/rules/:phase/:ruleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { expression, action } = req.body;
    if (!expression || !action) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string, zoneContext(req));
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改规则' } }); return; }
    const rule = await updateRule(account, zoneId, req.params.phase as string, req.params.ruleId as string, req.body);
    createAuditLog(account.id, 'update_rule', req.params.domain as string, `phase=${req.params.phase} rule_id=${req.params.ruleId}`, rule.status === 'success' ? 'success' : 'error');
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
    const result = await deleteRule(account, zoneId, req.params.phase as string, req.params.ruleId as string, req.body?.baseline);
    createAuditLog(account.id, 'delete_rule', req.params.domain as string, `phase=${req.params.phase} rule_id=${req.params.ruleId}`, result.status === 'success' ? 'success' : 'error');
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
