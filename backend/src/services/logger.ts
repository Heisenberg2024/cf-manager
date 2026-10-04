import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../config';
import { redact, rememberSecret } from './cfErrors';

const logDir = config.logDir;
rememberSecret(config.apiSecret);
rememberSecret(config.encryptionKey);

function createLogger(filename: string): winston.Logger {
  const fileTransport = config.fileLogging ? new DailyRotateFile({
    dirname: logDir,
    filename: `${filename}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: 7,
    zippedArchive: false,
  }) : undefined;
  fileTransport?.on('error', (error) => console.error(`File logging failed: ${redact(error)}`));

  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format((info) => { info.message = redact(info.message); return info; })(),
      winston.format.printf(({ timestamp, message }) => `${timestamp} ${message}`),
    ),
    transports: [
      ...(fileTransport ? [fileTransport] : []),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.printf(({ timestamp, message }) => `${timestamp} ${message}`),
        ),
      }),
    ],
  });
}

export const v1Logger = createLogger('v1');
export const apiLogger = createLogger('api');
export const appLogger = createLogger('app');
