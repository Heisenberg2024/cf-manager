import { Account } from '../models/account';
import { getCfClient, accountRequest } from './cfFactory';
import { zoneSettingsRuntime } from './zoneSettingsRuntime';
import type {ZoneSaveProgress} from './zoneSettingsEvents';
import { dnsDirectory } from './dnsDirectory';
import { measureDnsWrite } from './performanceMetrics';
import { dnsRecordId } from './dnsRecord';

async function cfZoneApi(account: Account, method: string, path: string, body?: unknown): Promise<any> {
  const data = await accountRequest(account)(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return data.result ?? data;
}

export async function getZoneSettings(account: Account, zoneId: string, options: {refresh?:boolean;signal?:AbortSignal} = {}) {
  return zoneSettingsRuntime.read(account, accountRequest(account), zoneId,options);
}

/** 创建 Zone */
export async function createZone(
  account: Account,
  name: string,
  type: 'full' | 'partial'
): Promise<{ zone_id: string; name_servers: string[] }> {
  const cf = getCfClient(account, 0);
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
  const cf = getCfClient(account, 0);
  await measureDnsWrite(account.id, () => cf.zones.delete({ zone_id: zoneId } as any));
}

export async function updateZoneSettings(account: Account, zoneId: string, settings: Record<string, unknown>,progress?:(event:ZoneSaveProgress)=>Promise<void>|void) {
  return zoneSettingsRuntime.write(account, dnsDirectory.wrap(account,accountRequest(account)), zoneId, settings,progress);
}

/** 清除 Zone 缓存 */
export async function purgeZoneCache(
  account: Account,
  zoneId: string,
  options: { purge_everything?: boolean; files?: string[] }
): Promise<{ id: string }> {
  const result = await cfZoneApi(account, 'POST', `/zones/${zoneId}/purge_cache`, options);
  if(!result?.id) throw Object.assign(new Error('Cache purge receipt missing; execution result unknown'),{statusCode:502,code:'CF_OUTCOME_UNCERTAIN'});
  return { id: result.id };
}

/** 暂停/激活 Zone */
export async function setZoneStatus(
  account: Account,
  zoneId: string,
  paused: boolean
): Promise<any> {
  const cf = getCfClient(account, 0);
  const receipt=await measureDnsWrite(account.id, () => cf.zones.edit({ zone_id: zoneId, paused } as any));
  if(receipt.id !== zoneId || receipt.paused !== paused) throw Object.assign(new Error('Zone status result not confirmed; refresh before retrying'),{statusCode:502,code:'CF_OUTCOME_UNCERTAIN'});
  return {id:receipt.id,paused:receipt.paused,status:receipt.status};
}

/** 清除 zones 缓存（创建/删除后调用） */
export function invalidateZonesCache(accountId?: number, cloudflareAccountId?: string | null): void {
  dnsDirectory.invalidate(accountId, cloudflareAccountId);
  zoneSettingsRuntime.invalidate(accountId, cloudflareAccountId);
}

/** 更新 DNS 记录代理状态（保留现有功能） */
export async function updateProxyStatus(account: Account, zoneId: string, recordId: string, proxied: boolean) {
  recordId = dnsRecordId(recordId);
  const cf = getCfClient(account, 0);
  return measureDnsWrite(account.id, () => cf.dns.records.edit(recordId, { zone_id: zoneId, proxied } as any));
}
