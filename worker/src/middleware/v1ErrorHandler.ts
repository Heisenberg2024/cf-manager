import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { errorDetails } from '../services/cfErrors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Error handler for OpenAI-compatible routes (/v1, /api/v1).
 * Returns errors in OpenAI format: { error: { message, type, code } }
 * Must be registered AFTER the openaiRouter so it catches thrown errors.
 */
export const v1ErrorHandler = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await next();
  } catch (err: any) {
    const { statusCode, code, message } = errorDetails(err);
    console.error(`[V1 ${code}] ${c.req.method} ${c.req.path} - ${message}`);
    return c.json({
      error: {
        message,
        type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
        code,
      },
    }, statusCode as ContentfulStatusCode);
  }
});
