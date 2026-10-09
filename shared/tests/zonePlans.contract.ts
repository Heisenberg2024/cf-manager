import type * as Implementation from '../zonePlans';
import { fakeZonePlans } from './zonePlans.fixture';
import { CloudflareError } from '../cfErrors';

interface Matchers {
  toBe(value: unknown): void; toEqual(value: unknown): void; toHaveLength(value: number): void;
  toContain(value: unknown): void; toMatchObject(value: unknown): void; toThrow(value?: unknown): void;
  rejects: Matchers;
}
interface Harness {
  describe(name: string, run: () => void): void;
  it(name: string, run: () => Promise<void> | void): void;
  expect(value: unknown): Matchers;
}
export function zonePlansContract(label: string, implementation: typeof Implementation, { describe, it, expect }: Harness) {
  const { createZonesWithPlan, getZonePlanOptions, parseCreateZonesInput } = implementation;
  const input = (names = ['1.test', '2.test', '3.test', '4.test', '5.test']) => parseCreateZonesInput({ names, account_id: 1, type: 'full', plan: 'enterprise' });
  describe(label, () => {
    it('assigns three Enterprise slots to the first three domains and falls back to Free for the last two', async () => {
      const cf = fakeZonePlans();
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result).toMatchObject({ total: 5, succeeded: 5, failed: 0, fallback_count: 2 });
      expect(result.results.map(row => row.plan?.id)).toEqual(['enterprise', 'enterprise', 'enterprise', 'free', 'free']);
      expect(result.results.map(row => row.name)).toEqual(input().names);
      const upgrades = cf.calls.filter(call => call.path.endsWith('/subscription'));
      expect(upgrades).toHaveLength(3);
      expect(upgrades[0].body).toEqual({ rate_plan: { id: 'enterprise' }, frequency: 'monthly' });
      expect(cf.calls.filter(call => call.path === '/zones').map(call => call.body?.name)).toEqual(input().names);
    });
    it('also falls back when the subscription API explicitly rejects exhausted capacity', async () => {
      const cf = fakeZonePlans({ rejectCapacity: true });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result.results.map(row => row.plan?.id)).toEqual(['enterprise', 'enterprise', 'enterprise', 'free', 'free']);
      expect(result.results[3].warning).toContain('quota exceeded');
      expect(result.fallback_count).toBe(2);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(4);
    });
    it('a rejected domain does not consume a plan slot', async () => {
      const cf = fakeZonePlans({ capacity: 1, failedName: 'bad.test' });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input(['bad.test', 'first.test', 'last.test']));
      expect(result.results.map(row => row.plan?.id)).toEqual([undefined, 'enterprise', 'free']);
      expect(result).toMatchObject({ succeeded: 2, failed: 1, fallback_count: 1 });
    });
    it('Free needs no billing API and omitted plan preserves Free behavior', async () => {
      const cf = fakeZonePlans({ billingDenied: true });
      const result = await createZonesWithPlan(cf.request, cf.accountId, parseCreateZonesInput({ account_id: 1, names: ['a.test', 'b.test'] }));
      expect(result.succeeded).toBe(2);
      expect(cf.calls.some(call => call.path.includes('available_plans') || call.path.endsWith('/subscription'))).toBe(false);
    });
    it('denied Billing Read fails before creating any domains', async () => {
      const cf = fakeZonePlans({ billingDenied: true });
      await expect(createZonesWithPlan(cf.request, cf.accountId, input())).rejects.toThrow('Billing Read');
      expect(cf.zones.size).toBe(0);
    });
    it('denied Billing Write keeps the created Zone receipt, stops subsequent domains and never calls it capacity exhaustion', async () => {
      const cf = fakeZonePlans({ upgradeError: new CloudflareError(403, 'Billing Write permission missing') });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result).toMatchObject({ succeeded: 0, failed: 5, fallback_count: 0 });
      expect(result.results[0]).toMatchObject({ zone_created: true, zone_id: 'zone-1', name_servers: ['ns.example.test'] });
      expect(result.results[0].error).toContain('Billing Write');
      expect(result.results[1].zone_created).toBe(false);
      expect(cf.zones.size).toBe(1);
    });
    it('ambiguous subscription timeout is never retried or represented as a confirmed Free fallback', async () => {
      const cf = fakeZonePlans({ upgradeError: Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }) });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result.results[0].plan).toBe(undefined);
      expect(result.fallback_count).toBe(0);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
      expect(cf.zones.size).toBe(1);
    });
    it('ambiguous creation does not invite a blind retry or proceed with other domains', async () => {
      const cf = fakeZonePlans();
      const request: typeof cf.request = async (path, init) => {
        if (path === '/zones' && init?.method === 'POST') throw Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
        return cf.request(path, init);
      };
      const result = await createZonesWithPlan(request, cf.accountId, input());
      expect(result.results[0]).toMatchObject({ success: false, zone_created: false, outcome_uncertain: true });
      expect(result.results[1].error).toContain('未处理');
      expect(result.fallback_count).toBe(0);
    });
    it('unknown plan availability is reported as an error, not a Free fallback', async () => {
      const cf = fakeZonePlans();
      const request: typeof cf.request = async (path, init) => {
        if (path.endsWith('/available_plans')) return { result: [{ legacy_id: 'enterprise', name: 'Enterprise' }] };
        return cf.request(path, init);
      };
      const result = await createZonesWithPlan(request, cf.accountId, input());
      expect(result.results[0]).toMatchObject({ success: false, zone_created: true });
      expect(result.results[0].error).toContain('availability could not be confirmed');
      expect(result.fallback_count).toBe(0);
      expect(cf.zones.size).toBe(1);
    });
    it('successful subscription responses still require remote activation', async () => {
      const cf = fakeZonePlans({ noActivation: true });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result.results[0]).toMatchObject({ success: false, zone_created: true, plan: { id: 'free' } });
      expect(result.results[0].error).toContain('not active');
      expect(result.fallback_count).toBe(0);
      expect(cf.zones.size).toBe(1);
    });
    it('empty accounts expose plan choices but verify them only on the newly created Zone', async () => {
      const cf = fakeZonePlans({ emptyAccount: true, capacity: 0 });
      expect(await getZonePlanOptions(cf.request, cf.accountId)).toMatchObject({ source: 'new_zone' });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input(['first.test']));
      expect(result.results[0]).toMatchObject({ plan: { id: 'free' }, fallback: true });
    });
    it('never upgrades a Zone whose true Account differs from the selected binding', async () => {
      const cf = fakeZonePlans({ wrongOwner: true });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input(['first.test']));
      expect(result.results[0].error).toContain('ownership');
      expect(cf.calls.some(call => call.path.endsWith('/subscription'))).toBe(false);
    });
    it('validates before writing and preserves input order after normalizing duplicates', () => {
      for (const body of [{ account_id: 1, names: [5] }, { account_id: '1abc', names: ['a.test'] }, { account_id: 1, names: ['a.test'], plan: 'opaque-enterprise-id' }]) expect(() => parseCreateZonesInput(body)).toThrow();
      expect(parseCreateZonesInput({ account_id: 1, names: [' A.test ', 'b.test', 'a.test'] }).names).toEqual(['a.test', 'b.test']);
    });
  });
}
