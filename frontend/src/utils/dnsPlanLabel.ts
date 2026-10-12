import { zonePlan, ZONE_PLAN_IDS, type ZonePlan, type ZonePlanOption } from '../shared/zonePlans';

type Translate = (key: string) => string;
export function dnsPlanTierLabel(plan: ZonePlan, t: Translate): string {
  const id = zonePlan(plan)?.id;
  return ZONE_PLAN_IDS.includes(id as typeof ZONE_PLAN_IDS[number]) ? t(`dns.plans.tiers.${id}`) : plan.name;
}
export function dnsPlanOptionLabel(plan: ZonePlanOption, t: Translate): string {
  const name = dnsPlanTierLabel(plan, t);
  if (plan.price === undefined) return name;
  const period = plan.frequency && ['weekly', 'monthly', 'quarterly', 'yearly'].includes(plan.frequency) ? t(`dns.plans.periods.${plan.frequency}`) : plan.frequency;
  return `${name} · ${plan.price} ${plan.currency || ''}${period ? ` / ${period}` : ''}`.trim();
}
