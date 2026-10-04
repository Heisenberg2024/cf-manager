import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { errorDetails } from '../services/cfErrors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const errorHandler = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await next();
  } catch (err: any) {
    const { statusCode: status, message, code } = errorDetails(err);
    console.error(`[Error] ${c.req.method} ${c.req.path}: ${message}`);
    // P1-11: 与 backend responseWrapper 对齐；OpenAI 兼容路径用 OpenAI 错误体，内部 /api 用 {success:false,error}
    const path = c.req.path;
    if (path.startsWith('/v1') || path.startsWith('/api/v1')) {
      return c.json(
        { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code } },
        status as ContentfulStatusCode,
      );
    }
    return c.json({ success: false, error: { code, message } }, status as ContentfulStatusCode);
  }
});
