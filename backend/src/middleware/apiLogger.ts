import { Request, Response, NextFunction } from 'express';
import { apiLogger as logger } from '../services/logger';
import { performanceContext } from '../services/performanceMetrics';

export function apiRequestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, originalUrl } = req;
  const metrics = { upstreamCalls: 0, cacheLookups: 0, cacheHits: 0, staleHits: 0, merged: 0, rateLimited: 0, timeouts: 0 };

  let logged = false;

  function log(suffix?: string) {
    if (logged) return;
    logged = true;
    const duration = Date.now() - start;
    logger.info(JSON.stringify({ event: 'api_request', method, path: originalUrl.split('?')[0], status: res.statusCode, durationMs: duration, ...(suffix ? { outcome: suffix } : {}), ...metrics, cacheHitRate: metrics.cacheLookups ? metrics.cacheHits / metrics.cacheLookups : null }));
  }

  res.on('finish', () => log());
  res.on('close', () => {
    if (!res.writableFinished) log('client_disconnected');
  });

  performanceContext.run(metrics, next);
}
