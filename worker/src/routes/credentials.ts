import { Hono } from 'hono';
import type { Env } from '../types';
import { credentials } from '../services/credentials';
import { addAuditLog } from '../db/models';

const app = new Hono<{ Bindings: Env }>();
app.get('/', async c => c.json(await credentials(c.env).list()));
app.post('/discover', async c => c.json(await credentials(c.env).discover(await c.req.json())));
app.post('/', async c => {
  const result = await credentials(c.env).save(await c.req.json());
  await addAuditLog(c.env.DB, { account_id: result.id, action: 'create_credential', target: String(result.credential_id), detail: `${result.ids.length} account bindings`, status: 'success' });
  return c.json(result, 201);
});
app.post('/:id/sync', async c => c.json(await credentials(c.env).sync(Number(c.req.param('id')))));
app.post('/:id/accounts', async c => c.json(await credentials(c.env).addBindings(Number(c.req.param('id')), await c.req.json())));
app.put('/:id', async c => c.json(await credentials(c.env).update(Number(c.req.param('id')), await c.req.json())));
app.delete('/:id', async c => {
  const result = await credentials(c.env).remove(Number(c.req.param('id')));
  await addAuditLog(c.env.DB, { action: 'delete_credential', target: c.req.param('id'), detail: 'Deleted credential and its local account bindings', status: 'success' });
  return c.json(result);
});
export default app;
