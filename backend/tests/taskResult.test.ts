import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../src/config', () => ({ config: { dbPath: ':memory:', encryptionKey: 'task-test-key', fileLogging: false, apiSecret: '' } }));
vi.mock('../src/services/logger', () => ({ appLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
import { getDb, initDb } from '../src/db';
import { runTaskNow } from '../src/services/taskScheduler';
beforeAll(initDb);
describe('scheduled task truthfulness', () => {
  it.each(['kv_cleanup', 'd1_backup', 'r2_cleanup'])('does not report %s placeholder execution as successful', async type => {
    const id = Number(getDb().prepare('INSERT INTO scheduled_tasks (name, type, cron, enabled) VALUES (?, ?, ?, 0)').run(type, type, '0 0 * * *').lastInsertRowid);
    const result = await runTaskNow(id);
    expect(result.status).toBe('error'); expect(result.detail).toContain('No backup or cleanup was performed');
  });
  it('records actual local quota data for a quota report', async () => {
    const id = Number(getDb().prepare("INSERT INTO scheduled_tasks (name, type, cron, enabled) VALUES ('Report', 'quota_report', '0 0 * * *', 0)").run().lastInsertRowid);
    const result = await runTaskNow(id); expect(result.status).toBe('success'); expect(JSON.parse(result.detail!)).toEqual([]);
  });
});
