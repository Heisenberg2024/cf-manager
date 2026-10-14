import { rulesResources } from '../services/rulesetService';
import { accountPhase } from '../services/rulesResources';
import { fail } from '../services/tunnelConfig';
import { Router } from 'express';
import { tunnelResources } from '../services/tunnelService';
import { accountRequest } from '../services/cfFactory';
import {
  listTunnelAccounts, getTunnelAccount, listTunnels, createTunnel,
  deleteTunnel, getTunnelToken, getTunnelConnections, getTunnelConfig,
  updateTunnelConfig, listZonesForAccount, listTunnelHostnames,
} from '../services/tunnelService';
import { createAuditLog } from '../models/auditLog';
import { isDemoAccountId } from './routeUtils';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

router.get('/accounts', (_req, res, next) => {
  try { res.json(listTunnelAccounts()); } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await listTunnels(account, req.query.refresh === 'true'));
  } catch (err) { next(err); }
});

router.get('/accounts/:id/zones', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await listZonesForAccount(account));
  } catch (err) { next(err); }
});

router.post('/accounts/:id/tunnels', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name must be 1–100 characters' } }); return; }
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    if (isDemoAccountId(account.id)) fail('DEMO_PROTECTED', '演示账户不可创建隧道', 403);
    const tunnel = await createTunnel(account, name);
    createAuditLog(account.id, 'create_tunnel', name, `tunnel_id=${tunnel.id}`, 'success');
    res.status(201).json(tunnel);
  } catch (err) { next(err); }
});

router.delete('/accounts/:id/tunnels/:tunnelId', async (req, res, next) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (isDemoAccountId(accountId)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除隧道' } }); return; }
    const account = getTunnelAccount(accountId);
    await deleteTunnel(account, req.params.tunnelId);
    createAuditLog(accountId, 'delete_tunnel', req.params.tunnelId, '', 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/token', async (req, res, next) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (isDemoAccountId(accountId)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可查看令牌' } }); return; }
    const account = getTunnelAccount(accountId);
    const token = await getTunnelToken(account, req.params.tunnelId);
    res.json({ token });
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/connections', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await getTunnelConnections(account, req.params.tunnelId, req.query.refresh === 'true'));
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/hostnames', async (req, res, next) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await listTunnelHostnames(account, req.params.tunnelId, req.query.verify === 'true', controller.signal));
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/config', async (req, res, next) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await getTunnelConfig(account, req.params.tunnelId, controller.signal));
  } catch (err) { next(err); }
});

router.put('/accounts/:id/tunnels/:tunnelId/config', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改配置' } }); return; }
    const result = await updateTunnelConfig(account, req.params.tunnelId, req.body);
    createAuditLog(account.id, 'update_tunnel_config', req.params.tunnelId, `status=${result.status}`, result.status === 'success' ? 'success' : 'error');
    res.json(result);
  } catch (err) { next(err); }
});

// All remote mutations are performed by the shared compensation workflow.
router.post('/accounts/:id/wizard', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    if (isDemoAccountId(account.id)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可执行向导' } }); return; }
    const result = await tunnelResources.wizard(account, accountRequest(account), req.body);
    createAuditLog(account.id, 'wizard_origin', result.tunnelId || '', `step=${'failedStep' in result ? result.failedStep : 'confirmed'} status=${result.status}`, result.status === 'success' ? 'success' : 'error');
    res.status(result.status === 'success' ? 201 : 200).json(result);
  } catch (error) { next(error); }
});
for (const method of ['get', 'post', 'put', 'delete'] as const) {
  router[method](`/accounts/:id/rules/:phase${method === 'put' || method === 'delete' ? '/:ruleId' : ''}`, async (req, res, next) => {
    try {
      const account = getTunnelAccount(parseInt(req.params.id, 10));
      const phase = req.params.phase as string;
      if (!accountPhase(phase)) fail('INVALID_SCOPE', 'This phase requires an explicit Zone');
      if (method !== 'get' && isDemoAccountId(account.id)) fail('DEMO_PROTECTED', '演示账户不可修改规则', 403);
      const request = accountRequest(account);
      if (method === 'get') { res.json((await rulesResources.list(account, request, '', phase, req.query.refresh === 'true')).value); return; }
      const result = await rulesResources.mutate(account, request, '', phase, method === 'post' ? 'create' : method === 'put' ? 'update' : 'delete', req.body, (req.params as Record<string, string>).ruleId, req.body?.baseline);
      createAuditLog(account.id, 'account_rule', phase, `status=${result.status}`, result.status === 'success' ? 'success' : 'error');
      res.json(result);
    } catch (error) { next(error); }
  });
}

export default router;
