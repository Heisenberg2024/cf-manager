import { getRulesResources } from '../services/rulesetService';
import { accountPhase } from '../services/rulesResources';
import { fail } from '../services/tunnelConfig';
import { accountZones } from '../services/accountZones';
import { getDnsDirectory } from '../services/dnsDirectory';
import { accountRequest } from '../services/cfApi';
import { getTunnelResources } from '../services/tunnelService';
import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { tunnelBase } from '../services/tunnelResources';
import { getAllAccounts, getAccountById, addAuditLog } from '../db/models';
import { isDemoAccount } from '../services/demo';
import {
  listTunnelAccounts, listTunnels, createTunnel, deleteTunnel,
  getTunnelToken, getTunnelConnections, getTunnelConfig, updateTunnelConfig,
  listTunnelHostnames,
} from '../services/tunnelService';

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); });
async function accountFor(c: Context<{ Bindings: Env }>) {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id') || '', 10));
  if (!account) fail('BAD_ACCOUNT', 'Account not found', 404);
  tunnelBase(account);
  return account;
}

app.get('/accounts', async (c) => {
  const accounts = await getAllAccounts(c.env.DB);
  return c.json(listTunnelAccounts(accounts));
});

app.get('/accounts/:id/tunnels', async (c) => {
  const account = await accountFor(c);
  return c.json(await listTunnels(account, c.env.ENCRYPTION_KEY, c.env.DB, c.req.query('refresh') === 'true'));
});

app.get('/accounts/:id/zones', async (c) => {
  const account = await accountFor(c);
  const zones = await accountZones(getDnsDirectory(c.env.DB), account, await accountRequest(account, c.env.ENCRYPTION_KEY));
  return c.json(zones.map((z) => ({ id: z.id, name: z.name })));
});

app.post('/accounts/:id/tunnels', async (c) => {
  const { name } = await c.req.json();
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name must be 1–100 characters' } }, 400);
  const account = await accountFor(c);
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) fail('DEMO_PROTECTED', '演示账户不可创建隧道', 403);
  const tunnel = await createTunnel(account, name, c.env.ENCRYPTION_KEY, c.env.DB);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_tunnel', target: name, detail: `tunnel_id=${tunnel.id}`, status: 'success' });
  return c.json(tunnel, 201);
});

app.delete('/accounts/:id/tunnels/:tunnelId', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除隧道' } }, 403);
  const account = await accountFor(c);
  await deleteTunnel(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY, c.env.DB);
  await addAuditLog(c.env.DB, { account_id: id, action: 'delete_tunnel', target: c.req.param('tunnelId'), detail: '', status: 'success' });
  return c.json({ success: true });
});

app.get('/accounts/:id/tunnels/:tunnelId/token', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可查看令牌' } }, 403);
  const account = await accountFor(c);
  const token = await getTunnelToken(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY);
  return c.json({ token });
});

app.get('/accounts/:id/tunnels/:tunnelId/connections', async (c) => {
  const account = await accountFor(c);
  return c.json(await getTunnelConnections(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY, c.env.DB, c.req.query('refresh') === 'true'));
});

app.get('/accounts/:id/tunnels/:tunnelId/hostnames', async (c) => {
  const account = await accountFor(c);
  return c.json(await listTunnelHostnames(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY, c.env.DB, c.req.query('verify') === 'true', c.req.raw.signal));
});

app.get('/accounts/:id/tunnels/:tunnelId/config', async (c) => {
  const account = await accountFor(c);
  return c.json(await getTunnelConfig(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY, c.env.DB, c.req.raw.signal));
});

app.put('/accounts/:id/tunnels/:tunnelId/config', async (c) => {
  const account = await accountFor(c);
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改配置' } }, 403);
  const result = await updateTunnelConfig(account, c.req.param('tunnelId'), await c.req.json(), c.env.ENCRYPTION_KEY, c.env.DB);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_tunnel_config', target: c.req.param('tunnelId'), detail: `status=${result.status}`, status: result.status === 'success' ? 'success' : 'error' });
  return c.json(result);
});

app.post('/accounts/:id/wizard', async c => {
  const account = await accountFor(c);
  if (isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可执行向导' } }, 403);
  const result = await getTunnelResources(c.env.DB).wizard(account, await accountRequest(account, c.env.ENCRYPTION_KEY), await c.req.json());
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'wizard_origin', target: result.tunnelId || '', detail: `status=${result.status}`, status: result.status === 'success' ? 'success' : 'error' });
  return c.json(result, result.status === 'success' ? 201 : 200);
});
for (const method of ['get', 'post', 'put', 'delete'] as const) {
  app[method](`/accounts/:id/rules/:phase${method === 'put' || method === 'delete' ? '/:ruleId' : ''}`, async c => {
    const account = await accountFor(c);
    const phase = c.req.param('phase');
    if (!accountPhase(phase)) fail('INVALID_SCOPE', 'This phase requires an explicit Zone');
    if (method !== 'get' && isDemoAccount(account.id, c.env.DEMO_ACCOUNT_IDS)) fail('DEMO_PROTECTED', '演示账户不可修改规则', 403);
    const request = await accountRequest(account, c.env.ENCRYPTION_KEY);
    const runtime = getRulesResources(c.env.DB);
    if (method === 'get') return c.json((await runtime.list(account, request, '', phase, c.req.query('refresh') === 'true')).value);
    const body = await c.req.json();
    const result = await runtime.mutate(account, request, '', phase, method === 'post' ? 'create' : method === 'put' ? 'update' : 'delete', body, c.req.param('ruleId'), body.baseline);
    await addAuditLog(c.env.DB, { account_id: account.id, action: 'account_rule', target: phase, detail: `status=${result.status}`, status: result.status === 'success' ? 'success' : 'error' });
    return c.json(result);
  });
}

export default app;
