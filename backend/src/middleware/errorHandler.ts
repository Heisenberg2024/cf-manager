import { Request, Response, NextFunction } from 'express';
import { appLogger } from '../services/logger';
import { errorDetails } from '../services/cfErrors';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  const { statusCode, code, message } = errorDetails(err);
  appLogger.error(JSON.stringify({ event: 'api_error', code, status: statusCode, method: req.method, path: req.originalUrl.split('?')[0] }));
  if (res.headersSent) {
    return;
  }
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
  });
}
