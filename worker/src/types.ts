export interface Env {
  DB: D1Database;
  API_SECRET: string;
  ENCRYPTION_KEY: string;
  DEMO_ACCOUNT_IDS?: string;
  ASSETS: Fetcher;
  KV: KVNamespace;
  DASHBOARD_AUTO_COLLECT?: string;
  DASHBOARD_SCAN_INTERVAL_HOURS?: string;
  DASHBOARD_SCAN_CONCURRENCY?: string;
  DASHBOARD_SCAN_STARTUP_DELAY?: string;
  DASHBOARD_SCAN_WINDOW_UTC?: string;
}
