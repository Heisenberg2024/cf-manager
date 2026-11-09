import { zonePlan, ZONE_PLAN_IDS, type ZonePlan, type ZonePlanId, type ZonePlanOption } from '../shared/zonePlans';

type Translate = (key: string) => string;

export interface DnsPlanGroup { key: string; label: string; rank: number }

export function dnsPlanGroup(rawPlan: Parameters<typeof zonePlan>[0], t: Translate): DnsPlanGroup {
  const plan = zonePlan(rawPlan);
  const id = plan?.id as ZonePlanId;
  const rank = ZONE_PLAN_IDS.indexOf(id);
  if (rank >= 0) return { key: id, label: t(`dns.plans.tiers.${id}`), rank };

  const name = typeof plan?.name === 'string' ? plan.name.trim() : '';
  if (name) return { key: `name:${name.toLowerCase()}`, label: name, rank: ZONE_PLAN_IDS.length };
  return { key: 'unknown', label: t('dns.plans.unknown'), rank: ZONE_PLAN_IDS.length + 1 };
}

export function compareDnsPlanGroups(a: DnsPlanGroup, b: DnsPlanGroup): number {
  return a.rank - b.rank || a.key.localeCompare(b.key);
}

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
