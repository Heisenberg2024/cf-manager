import type { Account } from '../models/account';
import { accountRequest } from './cfFactory';
import { dnsDirectory } from './dnsDirectory';
import { recordPerformance } from './performanceMetrics';
import { RulesResources, type GenericRuleInput } from './rulesResources';
export type { GenericRuleInput } from './rulesResources';
export const rulesResources = new RulesResources(dnsDirectory, recordPerformance);
export async function listRules(account: Account, zoneId: string, phase: string, refresh = false) { return (await rulesResources.list(account, accountRequest(account), zoneId, phase, refresh)).value; }
export async function createRule(account: Account, zoneId: string, phase: string, input: GenericRuleInput) { return rulesResources.mutate(account, accountRequest(account), zoneId, phase, 'create', input); }
export async function updateRule(account: Account, zoneId: string, phase: string, ruleId: string, input: GenericRuleInput) { return rulesResources.mutate(account, accountRequest(account), zoneId, phase, 'update', input, ruleId); }
export async function deleteRule(account: Account, zoneId: string, phase: string, ruleId: string, baseline?: unknown) { return rulesResources.mutate(account, accountRequest(account), zoneId, phase, 'delete', undefined, ruleId, baseline); }
