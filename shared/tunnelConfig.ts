/** JSON is kept whole: visual edits must never reconstruct an ingress entry. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Ingress { [key: string]: unknown; hostname?: string; path?: string; service: string }
export interface TunnelConfig { [key: string]: unknown; ingress: Ingress[] }
export interface TunnelSnapshot { config: TunnelConfig; version?: number; source?: string; fetchedAt: number }
export function fail(code: string, message: string, statusCode = 400): never { throw Object.assign(new Error(message), { code, statusCode }); }
export function object(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function segment(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(value)) fail('INVALID_ID', 'Invalid resource ID');
  return value;
}
export function validateConfig(value: unknown, allowEmpty = false): asserts value is TunnelConfig {
  if (!object(value) || !Array.isArray(value.ingress) || (!allowEmpty && !value.ingress.length) || value.ingress.length > 1000) fail('UNSAFE_CONFIG', 'Configuration must contain 1–1000 ingress entries');
  if (JSON.stringify(value).length > 1024 * 1024) fail('UNSAFE_CONFIG', 'Configuration exceeds 1 MiB');
  if (value.originRequest !== undefined && !object(value.originRequest)) fail('UNSAFE_CONFIG', 'originRequest must be an object');
  for (const [index, entry] of value.ingress.entries()) {
    if (!object(entry) || typeof entry.service !== 'string' || !entry.service.trim()) fail('UNSAFE_CONFIG', 'Each ingress needs its original service');
    if (entry.hostname !== undefined && (typeof entry.hostname !== 'string' || !entry.hostname)) fail('UNSAFE_CONFIG', 'Invalid hostname');
    if (entry.path !== undefined && typeof entry.path !== 'string') fail('UNSAFE_CONFIG', 'Invalid path');
    if (entry.originRequest !== undefined && !object(entry.originRequest)) fail('UNSAFE_CONFIG', 'Ingress originRequest must be an object');
    const catchAll = !entry.hostname && !entry.path;
    if (catchAll !== (index === value.ingress.length - 1)) fail('UNSAFE_CONFIG', 'Exactly one catch-all must be last; existing path-only rules are preserved');
  }
}
export function snapshot(result: unknown): TunnelSnapshot {
  if (!object(result) || !object(result.config)) fail('CONFIG_NOT_LOADED', 'Remote configuration is missing; saving is disabled', 502);
  validateConfig(result.config, true);
  if (result.source && result.source !== 'cloudflare') fail('LOCAL_TUNNEL', 'Locally managed Tunnel configuration is read-only', 409);
  return structuredClone({ config: result.config, ...(typeof result.version === 'number' ? { version: result.version } : {}), ...(result.source ? { source: result.source } : {}), fetchedAt: Date.now() });
}
export function assertBaseline(current: TunnelSnapshot, baseline: unknown) {
  if (!object(baseline) || !object(baseline.config)) fail('BASELINE_REQUIRED', 'Read the complete configuration before saving');
  if (canonical(current.config) !== canonical(baseline.config) || (baseline.version !== undefined && current.version !== baseline.version)) fail('CONFIG_CONFLICT', 'Remote configuration changed. Keep the draft and reload to compare before saving', 409);
}
/** Undefined and empty visual fields delete only that field; advanced fields survive. */
export function editIngress(original: Ingress, fields: { hostname: string; path: string; service: string }): Ingress {
  const copy = JSON.parse(JSON.stringify(original)) as Ingress;
  for (const key of ['hostname', 'path'] as const) { if ((original[key] || '') === fields[key]) continue; if (fields[key]) copy[key] = fields[key]; else delete copy[key]; }
  copy.service = fields.service;
  return copy;
}
