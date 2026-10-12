import { AsyncLocalStorage } from 'node:async_hooks';
import { apiLogger } from './logger';
import type { ReadMetric } from './readScheduler';
import { errorDetails } from './cfErrors';
export const performanceContext = new AsyncLocalStorage<{ upstreamCalls: number; cacheLookups: number; cacheHits: number; staleHits: number; merged: number; rateLimited: number; timeouts: number }>();
export function recordPerformance(metric: ReadMetric & { scope?: string; proxy?: boolean }) {
  const summary = performanceContext.getStore();
  if (summary) {
    if (metric.event.startsWith('cf_')) summary.upstreamCalls++;
    if (metric.event === 'zone_lookup') summary.cacheLookups++;
    if (metric.event === 'zone_hit') summary.cacheHits++;
    if (metric.event === 'zone_stale') summary.staleHits++;
    if (metric.event.endsWith('_merged')) summary.merged++;
    if (metric.event === 'cf_rate_limited' || (metric.event === 'write_failed' && metric.status === 429)) summary.rateLimited++;
    if (metric.event.includes('timeout') || (['cf_attempt', 'write_failed'].includes(metric.event) && metric.status === 504)) summary.timeouts++;
  }
  apiLogger.info(JSON.stringify({ scope: 'dns_performance', ...metric }));
}
export async function measureDnsWrite<T>(accountId: number, task: () => Promise<T>): Promise<T> {
  const started = Date.now(); recordPerformance({ event: 'cf_write', accountId });
  try { return await task(); }
  catch (error) { recordPerformance({ event: 'write_failed', accountId, status: errorDetails(error).statusCode }); throw error; }
  finally { recordPerformance({ event: 'write_finished', accountId, durationMs: Date.now() - started }); }
}
