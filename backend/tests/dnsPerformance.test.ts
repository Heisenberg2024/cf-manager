import { beforeEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
const fixture = vi.hoisted(() => ({ calls: 0, accounts: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Account ${i + 1}`, account_id: `cf-${i + 1}`, credential_id: i + 1, is_active: 1, is_enabled: 1, enabled_features: 'dns', api_token: 'synthetic-cipher', updated_at: 'v1' })) }));
const zones = (id: number) => Array.from({ length: 30 }, (_, i) => ({ id: `zone-${id}-${i}`, name: `zone-${id}-${i}.test`, status: 'active', account: { id: `cf-${id}` }, plan: { name: 'Free' } }));
const delay = () => new Promise(resolve => setTimeout(resolve, 5));
vi.mock('../src/models/account', () => ({ getActiveAccountsByFeature: () => fixture.accounts, getActiveAccounts: () => fixture.accounts, getAccountById: (id: number) => fixture.accounts.find(a => a.id === id) }));
vi.mock('../src/services/cfFactory', () => ({
  getCfClient: (a: { id: number }) => ({ zones: { list: () => ({ async *[Symbol.asyncIterator]() { fixture.calls++; await delay(); yield* zones(a.id); } }) } }),
  accountRequest: (a: { id: number }) => async (path: string) => { fixture.calls++; await delay(); return { result: path.startsWith('/zones?') ? zones(a.id) : zones(a.id).find(z => path === `/zones/${z.id}`), result_info: { total_pages: 1 } }; },
}));
vi.mock('../src/services/logger', () => ({ appLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn() } }));
vi.mock('../src/services/quotaTracker', () => ({ getQuotaUsage: vi.fn() }));
import { getAllZones, findAccountByDomain, clearCache } from '../src/services/accountRouter';
beforeEach(() => { clearCache(); fixture.calls = 0; });
it('measures 20 Accounts / 600 Zones with cold, warm, precise and stampede reads', async () => {
  const measurements: Record<string, { ms: number; calls: number }> = {};
  async function measure(name: string, run: () => Promise<unknown>) { const start = performance.now(), before = fixture.calls; await run(); measurements[name] = { ms: Math.round((performance.now() - start) * 100) / 100, calls: fixture.calls - before }; }
  await measure('allCold', async () => expect(await getAllZones()).toHaveLength(600));
  await measure('allWarm', async () => expect(await getAllZones()).toHaveLength(600));
  clearCache();
  await measure('preciseCold', () => findAccountByDomain('zone-1-0.test', { accountId: 1, zoneId: 'zone-1-0' }));
  clearCache();
  await measure('tenConcurrentCold', () => Promise.all(Array.from({ length: 10 }, () => getAllZones())));
  if (process.env.DNS_PERFORMANCE_OUTPUT) writeFileSync(process.env.DNS_PERFORMANCE_OUTPUT, JSON.stringify({ accounts: 20, zones: 600, pageLatencyMs: 5, measurements }, null, 2));
  console.log('DNS_PERFORMANCE', JSON.stringify(measurements));
});
