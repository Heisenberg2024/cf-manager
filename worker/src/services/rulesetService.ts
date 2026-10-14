import type { Account } from '../db/models';
import { accountRequest } from './cfApi';
import { getDnsDirectory } from './dnsDirectory';
import { RulesResources, type GenericRuleInput } from './rulesResources';
export type { GenericRuleInput } from './rulesResources';
const resources = new WeakMap<D1Database, RulesResources>();
export function getRulesResources(db: D1Database) { let r = resources.get(db); if (!r) { r = new RulesResources(getDnsDirectory(db), event => console.info(JSON.stringify({ scope: 'rules_performance', ...event }))); resources.set(db, r); } return r; }
export async function listRules(account: Account, zoneId: string, phase: string, key: string, db: D1Database, refresh = false) { return (await getRulesResources(db).list(account, await accountRequest(account, key), zoneId, phase, refresh)).value; }
export async function createRule(account: Account, zoneId: string, phase: string, input: GenericRuleInput, key: string, db: D1Database) { return getRulesResources(db).mutate(account, await accountRequest(account, key), zoneId, phase, 'create', input); }
export async function updateRule(account: Account, zoneId: string, phase: string, ruleId: string, input: GenericRuleInput, key: string, db: D1Database) { return getRulesResources(db).mutate(account, await accountRequest(account, key), zoneId, phase, 'update', input, ruleId); }
export async function deleteRule(account: Account, zoneId: string, phase: string, ruleId: string, key: string, db: D1Database, baseline?: unknown) { return getRulesResources(db).mutate(account, await accountRequest(account, key), zoneId, phase, 'delete', undefined, ruleId, baseline); }
