import { Account } from '../models/account';
import { getCfClient, accountRequest } from './cfFactory';
import { readZoneSettings, writeZoneSettings } from './zoneSettings';
import { clearCache } from './accountRouter';

async function cfZoneApi(account: Account, method: string, path: string, body?: unknown): Promise<any> {
  const data = await accountRequest(account)(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return data.result ?? data;
}

export async function getZoneSettings(account: Account, zoneId: string) {
  return readZoneSettings(accountRequest(account), zoneId);
}

/** 创建 Zone */
export async function createZone(
  account: Account,
  name: string,
  type: 'full' | 'partial'
): Promise<{ zone_id: string; name_servers: string[] }> {
  const cf = getCfClient(account);
  if (!account.account_id) throw new Error(`Account ${account.id} is missing account_id`);

  const zone = await cf.zones.create({
    name,
    account: { id: account.account_id },
    type,
  } as any) as any;

  return {
    zone_id: zone.id,
    name_servers: zone.name_servers || [],
  };
}

/** 删除 Zone */
export async function deleteZone(account: Account, zoneId: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.zones.delete({ zone_id: zoneId } as any);
}

export async function updateZoneSettings(account: Account, zoneId: string, settings: Record<string, unknown>) {
  return writeZoneSettings(accountRequest(account), zoneId, settings);
}

/** 清除 Zone 缓存 */
export async function purgeZoneCache(
  account: Account,
  zoneId: string,
  options: { purge_everything?: boolean; files?: string[] }
): Promise<{ id: string }> {
  const result = await cfZoneApi(account, 'POST', `/zones/${zoneId}/purge_cache`, options);
  return { id: result?.id || '' };
}

/** 暂停/激活 Zone */
export async function setZoneStatus(
  account: Account,
  zoneId: string,
  paused: boolean
): Promise<void> {
  const cf = getCfClient(account);
  await cf.zones.edit({ zone_id: zoneId, paused } as any);
}

/** 清除 zones 缓存（创建/删除后调用） */
export function invalidateZonesCache(): void {
  clearCache();
}

/** 更新 DNS 记录代理状态（保留现有功能） */
export async function updateProxyStatus(account: Account, zoneId: string, recordId: string, proxied: boolean): Promise<void> {
  const cf = getCfClient(account);
  await cf.dns.records.edit(recordId, { zone_id: zoneId, proxied } as any);
}
