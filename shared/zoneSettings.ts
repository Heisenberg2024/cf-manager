import type { CfRequest } from './accountDiscovery';
import { errorDetails } from './cfErrors';

export const SETTING_PATHS: Record<string, string> = {
  ssl: 'ssl', always_use_https: 'always_use_https', security_level: 'security_level',
  automatic_https_rewrites: 'automatic_https_rewrites', cache_level: 'cache_level',
  browser_cache_ttl: 'browser_cache_ttl', development_mode: 'development_mode',
  zero_rtt: '0rtt', http2: 'http2', http3: 'http3', always_online: 'always_online',
  minify: 'minify', brotli: 'brotli',
};
export interface SettingMeta { editable: boolean; reason?: string }
export type Settings = Record<string, unknown> & { __meta: Record<string, SettingMeta> };
export function normalizeSettings(result: unknown): Settings {
  if (!Array.isArray(result)) throw Object.assign(new Error('Unexpected Cloudflare zone settings response'), { statusCode: 502, code: 'CF_INVALID_RESPONSE' });
  const settings: Settings = { __meta: {} };
  for (const item of result as Array<{ id: string; value: unknown; editable?: boolean }>) {
    const key = Object.keys(SETTING_PATHS).find(k => SETTING_PATHS[k] === item.id);
    if (!key) continue;
    settings[key] = item.value;
    const deprecated = key === 'minify' || key === 'brotli';
    settings.__meta[key] = { editable: item.editable !== false && !deprecated, ...(deprecated ? { reason: 'Cloudflare has deprecated this setting API' } : {}) };
  }
  return settings;
}
export function validateSetting(key: string, value: unknown): void {
  const enums: Record<string, unknown[]> = {
    ssl: ['off', 'flexible', 'full', 'strict'],
    security_level: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'],
    cache_level: ['basic', 'simplified', 'aggressive'],
  };
  if (!Object.hasOwn(SETTING_PATHS, key) || ['minify', 'brotli'].includes(key)) throw new Error('Unsupported or deprecated zone setting');
  if (key === 'browser_cache_ttl') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 31536000) throw new Error('Browser cache TTL must be an integer from 0 to 31536000');
  } else if (!(enums[key] || ['on', 'off']).includes(value)) throw new Error(`Invalid ${key} value`);
}
export async function readZoneSettings(request: CfRequest, zoneId: string): Promise<Settings> {
  return normalizeSettings((await request(`/zones/${zoneId}/settings`)).result);
}
export async function writeZoneSettings(request: CfRequest, zoneId: string, input: Record<string, unknown>) {
  const before = await readZoneSettings(request, zoneId);
  const updated: string[] = [];
  const failed: string[] = [];
  const errors: Record<string, string> = {};
  const entries = Object.entries(input);
  for (let offset = 0; offset < entries.length; offset += 3) {
    await Promise.all(entries.slice(offset, offset + 3).map(async ([key, value]) => {
      try {
        validateSetting(key, value);
        if (!before.__meta[key]?.editable) throw new Error('Setting is unavailable or read-only for this Zone');
        if (JSON.stringify(before[key]) !== JSON.stringify(value)) await request(`/zones/${zoneId}/settings/${SETTING_PATHS[key]}`, { method: 'PATCH', body: JSON.stringify({ value }) });
        updated.push(key);
      } catch (error) { failed.push(key); errors[key] = errorDetails(error).message; }
    }));
  }
  // Verify every save against the actual remote state, even after a partial failure.
  const settings = await readZoneSettings(request, zoneId);
  for (const key of [...updated]) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(input[key])) {
      updated.splice(updated.indexOf(key), 1); failed.push(key);
      errors[key] = 'Cloudflare returned a different value; the interface now shows the remote value';
    }
  }
  return { updated, failed, errors, settings };
}
