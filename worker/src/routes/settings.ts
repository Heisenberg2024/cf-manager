import { Hono } from 'hono';
import type { Env } from '../types';
import { VERSION, GIT_COMMIT } from '../version';
import { getDnsDirectory } from '../services/dnsDirectory';
import {getStorageResources} from '../services/storageRuntime';
import { getZoneSettingsRuntime } from '../services/zoneSettingsRuntime';

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
  return c.json({
    encryption_key_configured: !!c.env.ENCRYPTION_KEY,
    api_secret_configured: !!c.env.API_SECRET,
    demo_account_ids: c.env.DEMO_ACCOUNT_IDS || '',
    db_path: 'D1 (Cloudflare)',
    platform: 'cloudflare-workers',
    version: VERSION,
    git_commit: GIT_COMMIT,
  });
});

app.post('/cache/clear', async (c) => {
  getDnsDirectory(c.env.DB).invalidate();getZoneSettingsRuntime(c.env.DB).invalidate();getStorageResources(c.env.DB).invalidate();
  return c.json({ message: 'Current isolate display snapshots cleared' });
});

export default app;
