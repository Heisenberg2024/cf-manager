import { Request, Response, NextFunction } from 'express';
import { v1Logger as logger } from '../services/logger';

export function v1RequestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, originalUrl } = req;

  let logged = false;

  function log(suffix?: string) {
    if (logged) return;
    logged = true;
    const duration = Date.now() - start;
    const tag = suffix ? ` [${suffix}]` : '';
    const rid = req.requestId || '-';
    const streamFlag = req.body?.stream === true ? 'STREAM' : 'NON-STREAM';
    const bodySize = req.headers['content-length'] || '?';

    logger.info(`[${rid}] ${method} ${originalUrl} ${res.statusCode} ${duration}ms${tag} [${streamFlag}] [body=${bodySize}B]`);
  }

  // Only use res events for disconnect detection.
  // Do NOT use req.on('close') — in Node.js 18+ it fires when the request
  // body has been fully read (which is BEFORE we send the response),
  // causing false-positive disconnect logs.
  res.on('finish', () => log());
  res.on('close', () => {
    if (!res.writableFinished) log('client_disconnected');
  });

  next();
}
