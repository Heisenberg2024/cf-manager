import { describe, expect, it } from 'vitest';
import zh from '../src/i18n/locales/zh-CN.json';
import en from '../src/i18n/locales/en.json';
import { dnsPlanOptionLabel } from '../src/utils/dnsPlanLabel';
import { zonePlan } from '../src/shared/zonePlans';
const translate = (locale: unknown) => (key: string) => String(key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], locale));
describe('readable DNS plan choices', () => {
  it('renders internal plan codes with human tier names and localized billing periods', () => {
    const plan = { id: 'pro', name: 'CF_PRO_20_20', rate_plan_id: 'CF_PRO_20_20', price: 25, currency: 'USD', frequency: 'monthly', can_subscribe: true };
    expect(dnsPlanOptionLabel(plan, translate(zh))).toBe('Pro（专业版） · 25 USD / 月');
    expect(dnsPlanOptionLabel(plan, translate(en))).toBe('Pro · 25 USD / month');
    expect(plan.rate_plan_id).toBe('CF_PRO_20_20');
    expect(plan.name).toBe('CF_PRO_20_20');
  });
  it('recognizes the exact CF tier codes while retaining the actual Zone display name', () => {
    for (const [code, tier] of [['CF_FREE', 'free'], ['CF_BIZ', 'business'], ['CF_PRO_20_20', 'pro'], ['CF_ENT', 'enterprise'], ['CF_LITE', 'lite'], ['CF_PRO_PLUS', 'pro_plus']]) {
      expect(zonePlan({ id: code })?.id).toBe(tier);
      expect(dnsPlanOptionLabel({ id: code!, name: code!, can_subscribe: true }, translate(zh))).not.toContain('CF_');
    }
    expect(zonePlan({ id: 'opaque', legacy_id: 'CF_ENT', name: 'Enterprise Website' })).toEqual({ id: 'enterprise', name: 'Enterprise Website' });
  });
});
