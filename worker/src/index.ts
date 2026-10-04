import { Hono } from 'hono';
import { errorDetails } from './services/cfErrors';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { v1ErrorHandler } from './middleware/v1ErrorHandler';
import { requestIdMiddleware } from './middleware/requestId';
import { canonicalizeMiddleware } from './middleware/canonicalize';
import { apiLoggerMiddleware } from './middleware/apiLogger';
import { responseWrapper } from './middleware/responseWrapper';
import { getRecentLogs, queryLogs, getDistinctActions } from './db/models';
import { getEnabledCatalogSources, updateCatalogSource } from './db/models';
import { getQuotaSummary, syncUsageFromCloudflare, invalidateAiCache } from './services/quotaTracker';
import { getFakeNginxPage } from './pages/fakeNginx';

import accountsRouter from './routes/accounts';
import credentialsRouter from './routes/credentials';
import dnsRouter from './routes/dns';
import workersRouter from './routes/workers';
import storageRouter from './routes/storage';
import browserRenderRouter from './routes/browserRender';
import settingsRouter from './routes/settings';
import openaiRouter from './routes/openai';
import storeRouter from './routes/store';
import tunnelsRouter from './routes/tunnels';
import aiRouter from './routes/ai';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Account-ID'],
  exposeHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 86400,
}));
app.use('*', requestIdMiddleware);
// 路径规范化（P1-4）：在 auth 与路由匹配之前改写路径，确保 Docker/Worker 两端对
// 双斜杠/尾部斜杠/大小写变形路径的匹配结果一致，避免绕过或 404/500 差异。
app.use('*', canonicalizeMiddleware);
app.use('*', errorHandler);

// Unauthenticated local health check. Never calls Cloudflare or an external service.
app.get('/api/health', async c => {
  try {
    if (!c.env.DB || !c.env.KV || !c.env.ENCRYPTION_KEY) throw new Error('Missing core binding');
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ok', db_connected: true, platform: 'cloudflare-workers' });
  } catch { return c.json({ status: 'unavailable', db_connected: false }, 503); }
});

// OpenAI-compatible routes (MUST be registered BEFORE responseWrapper)
// These routes return OpenAI-standard format and should not be wrapped
app.use('/v1/*', apiLoggerMiddleware);
app.use('/v1/*', authMiddleware);
app.use('/v1/*', v1ErrorHandler);
app.route('/v1', openaiRouter);
app.route('/v1/browser', browserRenderRouter);

app.use('/api/v1/*', apiLoggerMiddleware);
app.use('/api/v1/*', authMiddleware);
app.use('/api/v1/*', v1ErrorHandler);
app.route('/api/v1', openaiRouter);
app.route('/api/v1/browser', browserRenderRouter);

// Other API routes (with responseWrapper)
app.use('/api/*', apiLoggerMiddleware);
app.use('/api/*', responseWrapper);
app.use('/api/*', authMiddleware);

app.onError((err: any, c) => {
  const { statusCode: status, message, code } = errorDetails(err);
  console.error(`[OnError] ${c.req.method} ${c.req.path}: ${message}`);
  const path = c.req.path;
  if (path.startsWith('/v1') || path.startsWith('/api/v1')) {
    return c.json(
      { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code } },
      status as any,
    );
  }
  return c.json({ success: false, error: { code, message } }, status as any);
});

app.route('/api/accounts', accountsRouter);
app.route('/api/credentials', credentialsRouter);
app.route('/api/dns', dnsRouter);
app.route('/api/workers', workersRouter);
app.route('/api/browser-render', browserRenderRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/storage', storageRouter);
app.route('/api/store', storeRouter);
app.route('/api/tunnels', tunnelsRouter);
app.route('/api/ai', aiRouter);

app.get('/api/quota', async (c) => {
  const wantsSync = c.req.query('sync') === 'true' || c.req.query('refresh') === 'true';
  if (wantsSync) {
    await syncUsageFromCloudflare(c.env.DB, c.env.ENCRYPTION_KEY);
    await invalidateAiCache(c.env);
  }
  const summary = await getQuotaSummary(c.env.DB, c.env.ENCRYPTION_KEY);
  return c.json(summary);
});

app.post('/api/quota/sync', async (c) => {
  await syncUsageFromCloudflare(c.env.DB, c.env.ENCRYPTION_KEY);
  await invalidateAiCache(c.env);
  const summary = await getQuotaSummary(c.env.DB, c.env.ENCRYPTION_KEY);
  return c.json(summary);
});

app.get('/api/audit-log', async (c) => {
  const action = c.req.query('action');
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');
  if (action || startDate || endDate) {
    const logs = await queryLogs(c.env.DB, { action, startDate, endDate, limit: 500 });
    return c.json(logs);
  }
  const logs = await getRecentLogs(c.env.DB, 100);
  return c.json(logs);
});

app.get('/api/audit-log/actions', async (c) => {
  const actions = await getDistinctActions(c.env.DB);
  return c.json(actions);
});

app.get('/admin', (c) => c.redirect('/admin/', 302));

app.all('/admin/*', async (c) => {
  const url = new URL(c.req.url);
  const strippedPath = url.pathname.replace(/^\/admin/, '') || '/';

  if (/\.\w+$/.test(strippedPath)) {
    const assetUrl = new URL(strippedPath, url.origin).toString();
    const res = await c.env.ASSETS.fetch(new Request(assetUrl));
    if (res.status !== 404) {
      return res;
    }
  }

  const index = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin).toString()));
  return new Response(index.body, {
    status: 200,
    headers: new Headers(index.headers),
  });
});

app.all('*', (c) => {
  return c.html(getFakeNginxPage());
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Periodic catalog refresh every 6 hours
    try {
      const sources = await getEnabledCatalogSources(env.DB);
      for (const source of sources) {
        try {
          const headers: Record<string, string> = {};
          if (source.etag) headers['If-None-Match'] = source.etag;
          const resp = await fetch(source.url, { headers });
          if (resp.status === 304) {
            await updateCatalogSource(env.DB, source.id, {
              last_synced: new Date().toISOString(), last_status: 'ok', last_error: null,
            });
            continue;
          }
          if (!resp.ok) {
            await updateCatalogSource(env.DB, source.id, {
              last_status: 'error', last_error: `HTTP ${resp.status}`,
            });
            continue;
          }
          const json = await resp.json();
          if (env.KV) await env.KV.put(`catalog:${source.id}`, JSON.stringify(json));
          const etag = resp.headers.get('etag');
          await updateCatalogSource(env.DB, source.id, {
            etag: etag || null, last_synced: new Date().toISOString(),
            last_status: 'ok', last_error: null,
          });
        } catch (e: any) {
          await updateCatalogSource(env.DB, source.id, {
            last_status: 'error', last_error: e.message,
          });
        }
      }
    } catch (e) {
      console.error('[Scheduled] Catalog refresh failed:', e);
    }
  },
} satisfies ExportedHandler<Env>;
