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
  const { changeZonePlan, getExistingZonePlanOptions, parseZonePlan, createZonesWithPlan, getZonePlanOptions, parseCreateZonesInput } = implementation;
  const input = (names = ['1.test', '2.test', '3.test', '4.test', '5.test']) => parseCreateZonesInput({ names, account_id: 1, type: 'full', plan: 'enterprise' });
  describe(label, () => {
    it('maps exact CF SKU codes to public tiers without changing actual Zone names', () => {
      for (const [id, tier] of [['CF_FREE', 'free'], ['CF_BIZ', 'business'], ['CF_PRO_20_20', 'pro'], ['CF_ENT', 'enterprise'], ['CF_LITE', 'lite'], ['CF_PRO_PLUS', 'pro_plus']]) expect(implementation.zonePlan({ id })?.id).toBe(tier);
      expect(implementation.zonePlan({ legacy_id: 'CF_ENT', name: 'Enterprise Website' })).toEqual({ id: 'enterprise', name: 'Enterprise Website' });
    });
    it('recognizes exact public website tier names without classifying Enterprise add-ons as a website plan', () => {
      expect(implementation.zonePlan({ id: 'opaque', legacy_id: 'custom-contract', name: 'Contract SKU', public_name: 'Enterprise Website' })?.id).toBe('enterprise');
      expect(implementation.zonePlan({ id: 'opaque', name: 'Enterprise App Security Core' })?.id).toBe('opaque');
      expect(implementation.zonePlan({ id: 'opaque', name: 'Free Plan' })?.id).toBe('free');
    });
    it('recognizes Enterprise Website without a usable legacy ID and uses the subscription rate-plan ID for ten entitlements', async () => {
      const rateId = 'c'.repeat(32);
      const cf = fakeZonePlans({ capacity: 10, enterpriseLegacyId: 'unrecognized-legacy-contract', enterpriseName: 'Enterprise Website', enterpriseRateId: rateId });
      const options = await getZonePlanOptions(cf.request, cf.accountId);
      expect(options.plans.find(plan => plan.id === 'enterprise')).toMatchObject({ name: 'Enterprise Website', rate_plan_id: rateId });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input(Array.from({ length: 11 }, (_, index) => `${index + 1}.test`)));
      expect(result).toMatchObject({ succeeded: 11, failed: 0, fallback_count: 1 });
      expect(result.results.map(row => row.plan?.id)).toEqual([...Array(10).fill('enterprise'), 'free']);
      const writes = cf.calls.filter(call => call.path.endsWith('/subscription'));
      expect(writes).toHaveLength(11);
      expect(writes.every(call => (call.body?.rate_plan as { id: string }).id === rateId)).toBe(true);
    });
    it('finds Enterprise in rate plans when legacy available_plans omits it', async () => {
      const cf = fakeZonePlans({ capacity: 5, omitLegacyEnterprise: true });
      expect((await getZonePlanOptions(cf.request, cf.accountId)).plans.map(plan => plan.id)).toContain('enterprise');
      expect(await createZonesWithPlan(cf.request, cf.accountId, input())).toMatchObject({ succeeded: 5, fallback_count: 0 });
    });
    it('does not treat legacy can_subscribe false as exhausted Enterprise capacity', async () => {
      const cf = fakeZonePlans({ capacity: 5 });
      const request: typeof cf.request = async (path, init) => {
        if (path.endsWith('/available_plans')) return { result: [{ id: 'opaque-product', legacy_id: 'enterprise', name: 'Enterprise Website', can_subscribe: false }] };
        if (path.endsWith('/available_rate_plans')) throw new CloudflareError(404, 'Rate plans endpoint unavailable');
        return cf.request(path, init);
      };
      expect(await createZonesWithPlan(request, cf.accountId, input())).toMatchObject({ succeeded: 5, fallback_count: 0 });
    });
    it('enumerates later rate-plan pages before deciding a plan is absent', async () => {
      const cf = fakeZonePlans();
      const request: typeof cf.request = async (path, init) => {
        if (path.endsWith('/available_plans')) return { result: [] };
        if (path.endsWith('/available_rate_plans')) return { result: [{ id: 'free', name: 'Free' }], result_info: { total_count: 2, per_page: 1 } };
        if (path.endsWith('/available_rate_plans?page=2')) return { result: [{ id: 'enterprise', name: 'Enterprise Website' }], result_info: { total_count: 2, per_page: 1 } };
        return cf.request(path, init);
      };
      expect((await getZonePlanOptions(request, cf.accountId)).plans.map(plan => plan.id)).toContain('enterprise');
    });
    const existing = async (options: Parameters<typeof fakeZonePlans>[0] = {}, plan = 'enterprise') => {
      const cf = fakeZonePlans(options);
      await cf.request('/zones', { method: 'POST', body: JSON.stringify({ name: 'existing.test', account: { id: cf.accountId } }) });
      cf.zones.get('zone-1')!.plan = { id: `opaque-${plan}`, legacy_id: plan, name: plan === 'enterprise' ? 'Enterprise Website' : plan };
      cf.calls.length = 0;
      return cf;
    };
    it('downgrades Enterprise Website using PUT with the public Free ID and verifies activation without Billing Read', async () => {
      const cf = await existing({ billingDenied: true });
      const result = await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'free');
      expect(result).toMatchObject({ success: true, previous_plan: { id: 'enterprise' }, plan: { id: 'free' } });
      expect(cf.calls.map(call => [call.path, call.method])).toEqual([['/zones/zone-1', 'GET'], ['/zones/zone-1/subscription', 'PUT'], ['/zones/zone-1', 'GET']]);
      expect(cf.calls[1].body).toEqual({ rate_plan: { id: 'free' } });
    });
    it('upgrades existing Free via POST but modifies a paid plan via PUT', async () => {
      for (const [before, method] of [['free', 'POST'], ['pro', 'PUT']]) {
        const cf = await existing({}, before);
        expect((await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'enterprise')).success).toBe(true);
        expect(cf.calls.find(call => call.path.endsWith('/subscription'))?.method).toBe(method);
      }
    });
    it('reads options from the exact Zone and prevents ownership mismatches before all writes', async () => {
      const cf = await existing();
      expect(await getExistingZonePlanOptions(cf.request, cf.accountId, 'zone-1')).toMatchObject({ plan: { id: 'enterprise' } });
      expect(cf.calls.map(call => call.path)).toEqual(['/zones/zone-1', '/zones/zone-1/available_plans', '/zones/zone-1/available_rate_plans']);
      cf.zones.get('zone-1')!.account.id = 'another-account'; cf.calls.length = 0;
      await expect(changeZonePlan(cf.request, cf.accountId, 'zone-1', 'free')).rejects.toThrow('ownership');
      expect(cf.calls).toHaveLength(1);
    });
    it('skips an already active plan and rejects invalid IDs before any requests', async () => {
      const cf = await existing();
      expect(await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'enterprise')).toMatchObject({ success: true, unchanged: true });
      expect(cf.calls).toHaveLength(1);
      for (const body of [null, {}, { plan: 'opaque-enterprise' }]) expect(() => parseZonePlan(body)).toThrow();
    });
    it('keeps existing paid plans after authoritative subscription capacity rejection; never falls back', async () => {
      const cf = await existing({ capacity: 0 }, 'pro');
      const result = await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'enterprise');
      expect(result).toMatchObject({ success: false, plan: { id: 'pro' }, outcome_uncertain: false });
      expect(result.error).toContain('quota exceeded');
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
    });
    it('reports Billing Write refusal and retains the observed paid plan', async () => {
      const cf = await existing({ upgradeError: new CloudflareError(403, 'Billing Write permission missing') });
      const result = await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'free');
      expect(result).toMatchObject({ success: false, plan: { id: 'enterprise' }, outcome_uncertain: false });
      expect(result.error).toContain('Billing Write');
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
    });
    it('confirms short propagation delays using reads without repeating the subscription write', async () => {
      const cf = await existing({ activationDelayReads: 2 }); const waits: number[] = [];
      expect(await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'free', async ms => { waits.push(ms); })).toMatchObject({ success: true, outcome_uncertain: false, plan: { id: 'free' } });
      expect(waits).toEqual([250, 750]);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
    });
    it('accepted changes with stale Zone plans are pending activation, not failures or unknown writes', async () => {
      const cf = await existing({ noActivation: true });
      const result = await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'free', async () => {});
      expect(result).toMatchObject({ success: true, activation_pending: true, outcome_uncertain: false, plan: { id: 'enterprise' } });
      expect(result.error).toBe(undefined);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
    });
    it('confirmation read failures after accepted writes still preserve pending activation receipts', async () => {
      const cf = await existing(); let wrote = false;
      const request: typeof cf.request = async (path, init) => {
        if (wrote && path === '/zones/zone-1') throw new CloudflareError(403, 'Zone Read permission missing');
        const result = await cf.request(path, init);
        if (path.endsWith('/subscription')) wrote = true;
        return result;
      };
      expect(await changeZonePlan(request, cf.accountId, 'zone-1', 'free', async () => {})).toMatchObject({ success: true, activation_pending: true, outcome_uncertain: false });
    });
    it('recovers a lost write response after reading the target plan, without repeating the write', async () => {
      const cf = await existing({ activationDelayReads: 1 });
      const request: typeof cf.request = async (path, init) => {
        const result = await cf.request(path, init);
        if (path.endsWith('/subscription')) throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
        return result;
      };
      const result = await changeZonePlan(request, cf.accountId, 'zone-1', 'free', async () => {});
      expect(result).toMatchObject({ success: true, outcome_uncertain: false, plan: { id: 'free' } });
      expect(result.error).toBe(undefined);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
    });
    it('retains truly ambiguous writes when readback cannot confirm the target, without retrying', async () => {
      const cf = await existing({ upgradeError: Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }) });
      expect(await changeZonePlan(cf.request, cf.accountId, 'zone-1', 'free', async () => {})).toMatchObject({ success: false, outcome_uncertain: true, plan: { id: 'enterprise' } });
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1);
    });
    it('assigns three Enterprise slots to the first three domains and falls back to Free for the last two', async () => {
      const cf = fakeZonePlans();
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result).toMatchObject({ total: 5, succeeded: 5, failed: 0, fallback_count: 2 });
      expect(result.results.map(row => row.plan?.id)).toEqual(['enterprise', 'enterprise', 'enterprise', 'free', 'free']);
      expect(result.results.map(row => row.name)).toEqual(input().names);
      const upgrades = cf.calls.filter(call => call.path.endsWith('/subscription'));
      expect(upgrades).toHaveLength(4);
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
    it('denied Billing Read does not stop creation or authorized public-tier subscription requests', async () => {
      const cf = fakeZonePlans({ billingDenied: true });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result.results.map(row => row.plan?.id)).toEqual(['enterprise', 'enterprise', 'enterprise', 'free', 'free']);
      expect(cf.zones.size).toBe(5);
    });
    it('denied Billing Write keeps every created Zone receipt and continues without claiming capacity exhaustion', async () => {
      const cf = fakeZonePlans({ upgradeError: new CloudflareError(403, 'Billing Write permission missing') });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input());
      expect(result).toMatchObject({ succeeded: 0, failed: 5, fallback_count: 0 });
      expect(result.results[0]).toMatchObject({ zone_created: true, zone_id: 'zone-1', name_servers: ['ns.example.test'] });
      expect(result.results[0].error).toContain('Billing Write');
      expect(result.results[1].zone_created).toBe(true);
      expect(cf.zones.size).toBe(5);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(5);
    });
    it('ambiguous subscription timeout is never retried or represented as a confirmed Free fallback', async () => {
      const cf = fakeZonePlans({ upgradeError: Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }) });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input(), async () => {});
      expect(result.results[0]).toMatchObject({ success: false, outcome_uncertain: true, plan: { id: 'free' } });
      expect(result.fallback_count).toBe(0);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(5);
      expect(cf.zones.size).toBe(5);
    });
    it('ambiguous creation is not retried and does not prevent later distinct domain attempts', async () => {
      const cf = fakeZonePlans();
      const attempted: string[] = [];
      const request: typeof cf.request = async (path, init) => {
        if (path === '/zones' && init?.method === 'POST') { attempted.push(JSON.parse(String(init.body)).name); throw Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }); }
        return cf.request(path, init);
      };
      const result = await createZonesWithPlan(request, cf.accountId, input());
      expect(result.results[0]).toMatchObject({ success: false, zone_created: false, outcome_uncertain: true });
      expect(result.results[1].outcome_uncertain).toBe(true);
      expect(attempted).toEqual(input().names);
      expect(result.fallback_count).toBe(0);
    });
    it('missing legacy availability is not an exhausted quota and the rate-plan endpoint supplies Enterprise', async () => {
      const cf = fakeZonePlans({ capacity: 5 });
      const request: typeof cf.request = async (path, init) => {
        if (path.endsWith('/available_plans')) return { result: [{ legacy_id: 'enterprise', name: 'Enterprise' }] };
        return cf.request(path, init);
      };
      const result = await createZonesWithPlan(request, cf.accountId, input());
      expect(result.results[0]).toMatchObject({ success: true, zone_created: true, plan: { id: 'enterprise' } });
      expect(result.fallback_count).toBe(0);
      expect(cf.zones.size).toBe(5);
    });
    it('successful subscription submissions with delayed activation are pending, not local 409 errors or Free fallbacks', async () => {
      const cf = fakeZonePlans({ capacity: 5, noActivation: true });
      const result = await createZonesWithPlan(cf.request, cf.accountId, input(), async () => {});
      expect(result.results[0]).toMatchObject({ success: true, zone_created: true, activation_pending: true, plan: { id: 'free' } });
      expect(result.results[0].error).toBe(undefined);
      expect(result.pending_count).toBe(5);
      expect(result.fallback_count).toBe(0);
      expect(cf.zones.size).toBe(5);
      expect(cf.calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(5);
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
