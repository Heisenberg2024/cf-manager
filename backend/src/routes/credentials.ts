import { Router } from 'express';
import { credentials } from '../services/credentials';
import { createAuditLog } from '../models/auditLog';

const router = Router();
router.get('/', async (_req, res, next) => { try { res.json(await credentials.list()); } catch (e) { next(e); } });
router.post('/discover', async (req, res, next) => { try { res.json(await credentials.discover(req.body)); } catch (e) { next(e); } });
router.post('/', async (req, res, next) => {
  try {
    const result = await credentials.save(req.body);
    createAuditLog(result.id, 'create_credential', String(result.credential_id), `${result.ids.length} account bindings`, 'success');
    res.status(201).json(result);
  } catch (e) { next(e); }
});
router.post('/:id/sync', async (req, res, next) => { try { res.json(await credentials.sync(Number(req.params.id))); } catch (e) { next(e); } });
router.post('/:id/accounts', async (req, res, next) => { try { res.json(await credentials.addBindings(Number(req.params.id), req.body)); } catch (e) { next(e); } });
router.put('/:id', async (req, res, next) => { try { res.json(await credentials.update(Number(req.params.id), req.body)); } catch (e) { next(e); } });
router.delete('/:id', async (req, res, next) => {
  try {
    res.json(await credentials.remove(Number(req.params.id)));
    createAuditLog(null, 'delete_credential', req.params.id as string, 'Deleted credential and its local account bindings', 'success');
  } catch (e) { next(e); }
});
export default router;
