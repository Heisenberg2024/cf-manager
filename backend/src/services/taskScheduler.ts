import * as cron from 'node-cron';
import { getDb } from '../db';
import { appLogger } from './logger';
import { getQuotaSummary } from './quotaTracker';

export interface ScheduledTask {
  id: number;
  name: string;
  type: string;
  cron: string;
  config: string | null;
  enabled: number;
  created_at: string;
}

export interface TaskExecution {
  id: number;
  task_id: number;
  status: 'running' | 'success' | 'error';
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

const activeJobs = new Map<number, cron.ScheduledTask>();

export function getAllTasks(): ScheduledTask[] {
  return getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function getTaskById(id: number): ScheduledTask | undefined {
  return getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function createTask(name: string, type: string, cronExpr: string, config?: any): number {
  if (!cron.validate(cronExpr)) {
    throw Object.assign(new Error(`Invalid cron expression: ${cronExpr}`), { statusCode: 400 });
  }
  const result = getDb()
    .prepare('INSERT INTO scheduled_tasks (name, type, cron, config) VALUES (?, ?, ?, ?)')
    .run(name, type, cronExpr, config ? JSON.stringify(config) : null);
  const id = result.lastInsertRowid as number;
  scheduleTask(id);
  return id;
}

export function updateTask(id: number, updates: { name?: string; cron?: string; config?: any; enabled?: boolean }): void {
  const task = getTaskById(id);
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });

  if (updates.cron && !cron.validate(updates.cron)) {
    throw Object.assign(new Error(`Invalid cron expression: ${updates.cron}`), { statusCode: 400 });
  }

  const sets: string[] = [];
  const vals: any[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); vals.push(updates.name); }
  if (updates.cron !== undefined) { sets.push('cron = ?'); vals.push(updates.cron); }
  if (updates.config !== undefined) { sets.push('config = ?'); vals.push(JSON.stringify(updates.config)); }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0); }

  if (sets.length > 0) {
    vals.push(id);
    getDb().prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  unscheduleTask(id);
  const updated = getTaskById(id);
  if (updated?.enabled) scheduleTask(id);
}

export function deleteTask(id: number): void {
  unscheduleTask(id);
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getTaskHistory(taskId: number, limit = 20): TaskExecution[] {
  return getDb()
    .prepare('SELECT * FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(taskId, limit) as TaskExecution[];
}

export async function runTaskNow(id: number): Promise<TaskExecution> {
  const task = getTaskById(id);
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  return executeTask(task);
}

async function executeTask(task: ScheduledTask): Promise<TaskExecution> {
  const execResult = getDb()
    .prepare('INSERT INTO task_executions (task_id, status) VALUES (?, ?)')
    .run(task.id, 'running');
  const execId = execResult.lastInsertRowid as number;

  try {
    let detail = '';

    switch (task.type) {
      case 'quota_report':
        detail = JSON.stringify(getQuotaSummary());
        break;
      case 'kv_cleanup':
      case 'd1_backup':
      case 'r2_cleanup':
        throw new Error(`Task ${task.type} is not implemented. No backup or cleanup was performed.`);
      default:
        throw new Error(`Unsupported task type: ${task.type}`);
    }

    getDb().prepare('UPDATE task_executions SET status = ?, detail = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('success', detail, execId);

    return getDb().prepare('SELECT * FROM task_executions WHERE id = ?').get(execId) as TaskExecution;
  } catch (err: any) {
    getDb().prepare('UPDATE task_executions SET status = ?, detail = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('error', err.message, execId);
    return getDb().prepare('SELECT * FROM task_executions WHERE id = ?').get(execId) as TaskExecution;
  }
}

function scheduleTask(id: number): void {
  const task = getTaskById(id);
  if (!task || !task.enabled) return;

  const job = cron.schedule(task.cron, () => {
    executeTask(task).catch(err => appLogger.error(`[Task ${task.id}] Execution failed: ${err}`));
  });
  activeJobs.set(id, job);
}

function unscheduleTask(id: number): void {
  const job = activeJobs.get(id);
  if (job) {
    job.stop();
    activeJobs.delete(id);
  }
}

export function initScheduler(): void {
  const tasks = getAllTasks();
  for (const task of tasks) {
    if (task.enabled) {
      scheduleTask(task.id);
    }
  }
  appLogger.info(`[Scheduler] Initialized ${tasks.filter(t => t.enabled).length} active tasks`);
}
