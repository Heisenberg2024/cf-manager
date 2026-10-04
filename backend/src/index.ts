import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { initDb, getDb } from './db';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { v1ErrorHandler } from './middleware/v1ErrorHandler';
import { responseWrapper } from './middleware/responseWrapper';
import accountsRouter from './routes/accounts';
import credentialsRouter from './routes/credentials';
import dnsRouter from './routes/dns';
import workersRouter from './routes/workers';
import browserRenderRouter from './routes/browserRender';
import settingsRouter from './routes/settings';
import storageRouter from './routes/storage';
import tasksRouter from './routes/tasks';
import openaiRouter from './routes/openai';
import externalBrowserRenderRouter from './routes/externalBrowserRender';
import aiRouter from './routes/ai';
import storeRouter from './routes/store';
import tunnelsRouter from './routes/tunnels';
import { getQuotaSummary, syncUsageFromCloudflare } from './services/quotaTracker';
import { invalidateAiCache } from './services/accountRouter';
import { getRecentLogs, queryLogs, getDistinctActions } from './models/auditLog';
import { initScheduler } from './services/taskScheduler';
import { initBrowserRateLimiter } from './services/browserRateLimiter';
import { v1RequestLogger } from './middleware/v1Logger';
import { apiRequestLogger } from './middleware/apiLogger';
import { requestIdMiddleware } from './middleware/requestId';
import { canonicalizeMiddleware } from './middleware/canonicalize';
import { appLogger } from './services/logger';
import cron from 'node-cron';
import { getEnabledCatalogSources } from './models/catalogSource';
import { refreshCatalogSource } from './routes/store';

const app = express();

app.use(cors({
  origin: true, // Allow all origins (or specify your frontend URL)
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Account-ID'],
  credentials: false,
}));
app.use(express.json({ limit: '100mb' }));

// 路径规范化（P1-4）：在 auth 与路由匹配之前改写 req.url，确保 Docker/Worker 两端对
// 双斜杠/尾部斜杠/大小写变形路径的匹配结果一致，避免绕过或 404/500 差异。
app.use(canonicalizeMiddleware);

// Health check — before auth so Docker healthcheck works without API_SECRET
app.get('/api/health', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', db_connected: true });
  } catch {
    res.status(503).json({ status: 'unavailable', db_connected: false });
  }
});

// ---- Static frontend serving (Docker all-in-one mode) ----
// Must be BEFORE authMiddleware so the login page loads without credentials.
// API routes (/api/*, /v1/*) are registered after authMiddleware and remain protected.
const frontendDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(frontendDir)) {
  app.use(compression());
  app.use(express.static(frontendDir, {
    maxAge: '30d',
    immutable: true,
    setHeaders: (res, filePath) => {
      // index.html should never be cached
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  appLogger.info(`Serving frontend from ${frontendDir}`);
}

// SPA fallback: all non-API, non-v1 GET routes serve index.html.
// Must be BEFORE authMiddleware so the browser can load frontend pages
// (e.g. /ai, /dashboard) on a full page reload without an Authorization header.
// The regex excludes /api/ and /v1/ paths, so protected API routes are unaffected.
if (fs.existsSync(path.join(__dirname, '..', 'public'))) {
  app.get(/^(?!\/api\/|\/v1\/).*/, (_req, res) => {
    res.sendFile(path.join(path.join(__dirname, '..', 'public'), 'index.html'));
  });
}

app.use(authMiddleware);

// External APIs — no responseWrapper, keep original format
// Mount BEFORE /api middleware to avoid responseWrapper
app.use('/v1', requestIdMiddleware);
app.use('/v1', v1RequestLogger);
app.use('/v1', openaiRouter);
app.use('/v1', v1ErrorHandler); // OpenAI-format error handler (before global errorHandler)
app.use('/v1/browser', externalBrowserRenderRouter);

// Internal APIs — with responseWrapper
app.use('/api', apiRequestLogger);
app.use('/api', responseWrapper);

app.use('/api/accounts', accountsRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/dns', dnsRouter);
app.use('/api/workers', workersRouter);
app.use('/api/browser-render', browserRenderRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/ai', aiRouter);
app.use('/api/store', storeRouter);
app.use('/api/tunnels', tunnelsRouter);
app.use('/api/v1', requestIdMiddleware);
app.use('/api/v1', v1RequestLogger);
app.use('/api/v1', openaiRouter);
app.use('/api/v1', v1ErrorHandler); // OpenAI-format error handler (before global errorHandler)

app.get('/api/quota', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wantsSync = req.query.sync === 'true' || req.query.refresh === 'true';
    if (wantsSync) {
      await syncUsageFromCloudflare();
      invalidateAiCache();
    }
    res.json(getQuotaSummary());
  } catch (err) { next(err); }
});

app.post('/api/quota/sync', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await syncUsageFromCloudflare();
    invalidateAiCache();
    res.json(getQuotaSummary());
  } catch (err) { next(err); }
});

app.get('/api/audit-log', (req, res, next) => {
  try {
    const { action, startDate, endDate } = req.query as any;
    if (action || startDate || endDate) {
      res.json(queryLogs({ action, startDate, endDate, limit: 500 }));
    } else {
      res.json(getRecentLogs(100));
    }
  } catch (err) { next(err); }
});

app.get('/api/audit-log/actions', (_req, res, next) => {
  try {
    res.json(getDistinctActions());
  } catch (err) { next(err); }
});

app.use(errorHandler);

async function start() {
  initDb();
  initScheduler();
  initBrowserRateLimiter();

  // Catalog refresh cron (every 6 hours)
  cron.schedule('0 */6 * * *', async () => {
    const sources = getEnabledCatalogSources();
    for (const s of sources) {
      try { await refreshCatalogSource(s); } catch (e) { appLogger.error(`[Cron] catalog refresh ${s.id}: ${e}`); }
    }
  });
  app.listen(config.port, () => {
    appLogger.info(`Server running on port ${config.port} (ready)`);
  });
}

process.on('uncaughtException', (err) => {
  appLogger.error(`[UNCAUGHT] ${err}`);
  // 进程处于未知状态，交由编排器（Docker/K8s）重启，避免静默损坏
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  appLogger.error(`[UNHANDLED_REJECTION] ${err}`);
});

start().catch((err) => {
  appLogger.error(`[STARTUP] ${err}`);
  process.exitCode = 1;
});
