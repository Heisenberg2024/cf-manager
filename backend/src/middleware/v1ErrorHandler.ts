import { Request, Response, NextFunction } from 'express';
import { appLogger } from '../services/logger';
import { errorDetails } from '../services/cfErrors';

/**
 * Error handler for OpenAI-compatible routes (/v1, /api/v1).
 * Returns errors in OpenAI format: { error: { message, type, code } }
 * instead of the internal { success: false, error: { code, message } } format.
 *
 * Note: Express may pass arbitrary errors (SyntaxError, non-Error throws),
 * so we accept `any` and type-narrow to AppError.
 */
export function v1ErrorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  const { statusCode, code, message } = errorDetails(err);
  appLogger.error(`[V1 ${code}] ${req.method} ${req.originalUrl} - ${message}`);
  if (res.headersSent) return;
  res.status(statusCode).json({
    error: {
      message,
      type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      code,
    },
  });
}
