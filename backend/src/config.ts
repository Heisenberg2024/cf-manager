import path from 'path';

// Load .env from project root so encryption key stays stable across restarts
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.join(__dirname, '..', '..', '.env') });

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cf-manager.db');

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  encryptionKey: process.env.ENCRYPTION_KEY || 'feiyu',
  apiSecret: process.env.API_SECRET || '',
  dbPath,
  proxyUrl: process.env.PROXY_URL || '',
  demoAccountIds: process.env.DEMO_ACCOUNT_IDS || '',
  logDir: process.env.LOG_DIR || path.join(path.dirname(dbPath), 'logs'),
  fileLogging: process.env.FILE_LOGGING !== 'false',
  workerDeployUrlAllowlist: process.env.WORKER_DEPLOY_URL_ALLOWLIST || '',
};
