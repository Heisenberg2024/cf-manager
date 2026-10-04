import { Router, Request, Response, NextFunction } from 'express';
import { createAuditLog } from '../models/auditLog';
import {
  getAllTasks, getTaskById, createTask, updateTask, deleteTask,
  getTaskHistory, runTaskNow,
} from '../services/taskScheduler';

const router = Router();

router.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(getAllTasks());
  } catch (err) { next(err); }
});

router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, type, cron, config } = req.body;
    if (!name || !type || !cron) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name, type, and cron are required' } });
      return;
    }
    const id = createTask(name, type, cron, config);
    createAuditLog(null, 'task_create', name, `type=${type} cron=${cron}`, 'success');
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.put('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    updateTask(id, req.body);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const task = getTaskById(id);
    deleteTask(id);
    createAuditLog(null, 'task_delete', task?.name || String(id), null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:id/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const result = await runTaskNow(id);
    const task = getTaskById(id);
    createAuditLog(null, 'task_run', task?.name || String(id), result.detail, result.status === 'error' ? 'error' : 'success');
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:id/history', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(getTaskHistory(id, limit));
  } catch (err) { next(err); }
});

export default router;
