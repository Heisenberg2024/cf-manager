import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { getRequestId } from './requestId';

/**
 * 结构化请求日志中间件（对齐 backend src/middleware/apiLogger.ts）。
 * 记录 method / path / status / 耗时，并通过 request-id 与审计、错误日志关联。
 * 需在其前挂载 requestIdMiddleware（本仓库入口已全局挂载）。
 */
export const apiLoggerMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res?.status ?? 0;
  const reqId = getRequestId(c);
  console.log(JSON.stringify({ event: 'api_request', method: c.req.method, path: c.req.path, status, durationMs: duration, requestId: reqId }));
});
