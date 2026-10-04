/**
 * Simple logger for Cloudflare Worker.
 * Wraps console.* to provide a consistent logging interface.
 * Logs are output via console.* and will appear in wrangler/devtools.
 */

import { redact } from './cfErrors';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  const configured = (globalThis as any).LOG_LEVEL || 'info';
  return LOG_LEVEL_PRIORITY[level] >= (LOG_LEVEL_PRIORITY[configured as LogLevel] ?? 0);
}

function formatMessage(module: string, message: string): string {
  return `[${module}] ${redact(message)}`;
}

export const logger = {
  debug(module: string, message: string): void {
    if (shouldLog('debug')) console.debug(formatMessage(module, message));
  },
  info(module: string, message: string): void {
    if (shouldLog('info')) console.info(formatMessage(module, message));
  },
  warn(module: string, message: string): void {
    if (shouldLog('warn')) console.warn(formatMessage(module, message));
  },
  error(module: string, message: string): void {
    if (shouldLog('error')) console.error(formatMessage(module, message));
  },
};
