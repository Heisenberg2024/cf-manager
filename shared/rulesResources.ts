import type { CfRequest } from './accountDiscovery';
import { BoundReadCache } from './resourceCache';
import type { DnsBinding, ZoneDirectory } from './zoneDirectory';
import type { ReadMetric } from './readScheduler';
import { canonical, fail, object, segment } from './tunnelConfig';
import { uncertain } from './tunnelResources';
import { liveAccountZone } from './accountZones';

export const phaseActions: Record<string, string[]> = {
  http_request_origin: ['route'], http_request_redirect: ['redirect', 'execute'], http_request_dynamic_redirect: ['redirect'],
  http_request_transform: ['rewrite'], http_request_late_transform: ['rewrite'], http_response_headers_transform: ['rewrite'],
  http_request_cache_settings: ['set_cache_settings'], http_request_firewall_custom: ['block', 'challenge', 'js_challenge', 'managed_challenge', 'skip', 'log', 'execute'],
  http_ratelimit: ['block', 'challenge', 'js_challenge', 'managed_challenge', 'log'],
};
export function accountPhase(phase: string) { return phase === 'http_request_redirect'; }
export function ruleScope(account: DnsBinding, zoneId: string, phase: string) {
  if (!phaseActions[phase]) fail('INVALID_PHASE', 'Unsupported Rules phase');
  if (!account.account_id || account.is_enabled === 0 || account.is_active === 0) fail('BAD_ACCOUNT', 'Account disabled or unbound', 409);
  const kind = accountPhase(phase) ? 'root' : 'zone';
  const id = segment(kind === 'root' ? account.account_id : zoneId);
  return { base: `/${kind === 'root' ? 'accounts' : 'zones'}/${id}/rulesets`, kind, cache: `rules/${kind}/${id}` };
}
export interface GenericRuleInput { description?: string; expression: string; action: string; action_parameters?: any; enabled?: boolean; ratelimit?: Record<string, unknown>; baseline?: Record<string, any> }
function validateRule(phase: string, input: GenericRuleInput) {
  if (!object(input) || typeof input.expression !== 'string' || !input.expression.trim() || input.expression.length > 10000 || !phaseActions[phase]?.includes(input.action)) fail('INVALID_RULE', 'Invalid expression or action for selected phase');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('INVALID_RULE', 'enabled must be boolean');
  for (const key of ['action_parameters', 'ratelimit']) if ((input as any)[key] !== undefined && !object((input as any)[key])) fail('INVALID_RULE', `${key} must be an object`);
  if (phase === 'http_request_redirect' && input.action === 'redirect' && (!object(input.action_parameters?.from_list) || typeof input.action_parameters.from_list.name !== 'string' || !input.action_parameters.from_list.name || typeof input.action_parameters.from_list.key !== 'string')) fail('INVALID_RULE', 'Account Bulk Redirect requires from_list; URL targets use Zone Single Redirect');
}
const writable = ['action', 'action_parameters', 'description', 'enabled', 'expression', 'logging', 'ratelimit', 'ref', 'exposed_credential_check'] as const;
function ruleBody(rule: Record<string, any>) { return Object.fromEntries(writable.filter(key => rule[key] !== undefined).map(key => [key, structuredClone(rule[key])])); }
function matches(actual: Record<string, any> | undefined, expected: Record<string, any>) { return !!actual && Object.keys(expected).every(key => canonical(actual[key]) === canonical(expected[key])); }
export class RulesResources {
  readonly cache: BoundReadCache;
  constructor(private directory: ZoneDirectory, metric: (event: ReadMetric) => void = () => {}) { this.cache = new BoundReadCache(directory, metric, 30000, 30000, 300); }
  invalidate(account: DnsBinding, zoneId: string, phase: string) { this.cache.invalidate(account.id, account.account_id, ruleScope(account, zoneId, phase).cache); }
  private async listIds(request: CfRequest, base: string, signal?: AbortSignal) {
    const rows: any[] = [], seen = new Set<string>(), cursors = new Set<string>(); let cursor = '';
    for (let page = 0; page < 1000; page++) {
      const data = await request(`${base}?per_page=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
      if (!Array.isArray(data.result)) fail('INVALID_RESPONSE', 'Invalid ruleset list', 502);
      for (const row of data.result) { if (!object(row) || !row.id || seen.has(row.id)) fail('INVALID_RESPONSE', 'Repeated ruleset ID', 502); seen.add(row.id); rows.push(row); }
      const info = data.result_info as any;
      const next = info?.cursors?.after || info?.cursor || '';
      if (!next) return rows;
      if (cursors.has(next)) fail('INVALID_RESPONSE', 'Repeated ruleset cursor', 502);
      cursors.add(next); cursor = next;
    }
    return fail('INVALID_RESPONSE', 'Ruleset pagination exceeded limit', 502);
  }
  async id(account: DnsBinding, request: CfRequest, zoneId: string, phase: string, refresh = false) {
    const scope = ruleScope(account, zoneId, phase);
    const result = await this.cache.read(account, `${scope.cache}/ids`, signal => this.listIds(request, scope.base, signal), { refresh });
    const matches = result.value.filter(rs => rs.phase === phase && rs.kind === scope.kind);
    if (matches.length > 1) fail('AMBIGUOUS_RULESET', 'Multiple entrypoints for this scope/phase', 409);
    return matches[0]?.id as string | undefined;
  }
  private async detail(request: CfRequest, base: string, id: string, kind: string, phase: string, signal?: AbortSignal) {
    const result = (await request(`${base}/${segment(id)}`, { signal })).result;
    if (!object(result) || result.id !== id || result.phase !== phase || result.kind !== kind || !Array.isArray(result.rules)) fail('INVALID_RULESET', 'Ruleset scope/kind/phase mismatch or invalid rules', 502);
    return result;
  }
  async list(account: DnsBinding, request: CfRequest, zoneId: string, phase: string, refresh = false) {
    const scope = ruleScope(account, zoneId, phase);
    const id = await this.id(account, request, zoneId, phase, refresh);
    if (!id) return { value: [] as any[], cache: { state: 'fresh' as const, fetchedAt: Date.now() } };
    try { return await this.cache.read(account, `${scope.cache}/${phase}/${id}`, async signal => (await this.detail(request, scope.base, id, scope.kind, phase, signal)).rules as any[], { refresh }); }
    catch (error) { this.invalidate(account, zoneId, phase); throw error; }
  }
  async mutate(account: DnsBinding, request: CfRequest, zoneId: string, phase: string, operation: 'create' | 'update' | 'delete', input?: GenericRuleInput, ruleId?: string, baseline?: unknown) {
    const scope = ruleScope(account, zoneId, phase);
    if (operation !== 'delete') validateRule(phase, input!);
    if (scope.kind === 'zone') await liveAccountZone(this.directory, account, request, zoneId);
    if (ruleId) segment(ruleId);
    // Bypass read snapshots for every mutation; no automatic ruleset creation during reads.
    let id = await this.id(account, request, zoneId, phase, true);
    let before: Record<string, any> | undefined;
    if (id) before = await this.detail(request, scope.base, id, scope.kind, phase);
    const old = before?.rules.find((r: any) => r.id === ruleId);
    if (operation !== 'create') {
      if (!old) fail('RULE_NOT_FOUND', 'Rule no longer exists', 404);
      if (!object(baseline || input?.baseline)) fail('BASELINE_REQUIRED', 'Read the complete rule before modifying');
      if (canonical(old) !== canonical(baseline || input?.baseline)) fail('RULE_CONFLICT', 'Remote rule changed; keep draft and refresh', 409);
      if (operation === 'update' && Object.keys(old).some(key => ![...writable, 'id', 'version', 'last_updated', 'categories'].includes(key))) fail('UNSAFE_RULE', 'Unknown rule fields require editing in Cloudflare; saving disabled', 409);
    }
    let body: Record<string, any> | undefined;
    if (operation !== 'delete') {
      body = { ...(old ? ruleBody(old) : {}), ...ruleBody(input as any) };
      if (operation === 'create' && body.enabled === undefined) body.enabled = true;
    }
    let writeError: unknown;
    try {
      if (!id) {
        if (operation !== 'create') fail('RULESET_NOT_FOUND', 'Ruleset not found', 404);
        // Create entrypoint and first rule in one write; no empty orphan ruleset.
        const result = (await request(scope.base, { method: 'POST', body: JSON.stringify({ kind: scope.kind, phase, name: `${phase} rules`, rules: [body] }), retry: false })).result;
        if (!object(result) || !result.id) return { status: 'unknown', message: 'Ruleset creation response missing ID; refresh before retrying' };
        id = segment(result.id);
      } else {
        await request(`${scope.base}/${id}/rules${ruleId ? `/${ruleId}` : ''}`, { method: operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE', ...(body ? { body: JSON.stringify(body) } : {}), retry: false });
      }
    } catch (error) { if (!uncertain(error)) throw error; writeError = error; }
    finally { this.invalidate(account, zoneId, phase); }
    if (!id) return { status: 'unknown', message: 'Ruleset creation outcome unknown; refresh before retrying' };
    try {
      const actual = await this.detail(request, scope.base, id, scope.kind, phase);
      const oldIds = new Set(before?.rules.map((r: any) => r.id) || []);
      const actualRule = operation === 'create' ? actual.rules.find((r: any) => !oldIds.has(r.id) && matches(r, body!)) : actual.rules.find((r: any) => r.id === ruleId);
      const confirmed = operation === 'delete' ? !actualRule : matches(actualRule, body!);
      return { status: confirmed ? 'success' : writeError ? 'unknown' : 'partial', rule: actualRule, rules: actual.rules, recovered: !!writeError, ...(!confirmed ? { message: 'Write could not be confirmed; review actual rules before retrying' } : {}) };
    } catch { return { status: 'unknown', message: 'Readback failed; refresh remote rules before retrying' }; }
  }
}
