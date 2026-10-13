import type { CfRequest } from './accountDiscovery';
import type { DnsBinding, DnsZone, ZoneDirectory } from './zoneDirectory';

/** A resource's credential may see several Accounts; always scope to its actual Account. */
export async function accountZones(directory: Pick<ZoneDirectory, 'list' | 'all' | 'request'>, account: DnsBinding, request: CfRequest): Promise<DnsZone[]> {
  if (!account.account_id || account.is_enabled === 0) throw Object.assign(new Error('Account unavailable'), { statusCode: 409 });
  if (account.is_active !== 0 && account.enabled_features.split(',').includes('dns')) return (await directory.list(account, request)).zones;
  // Preserve Tunnel/Workers access when the local DNS feature is disabled; Cloudflare enforces permissions.
  const rows = await directory.all(account, request, `/zones?account.id=${encodeURIComponent(account.account_id)}`, 50) as DnsZone[];
  return rows.filter(zone => zone.account?.id === account.account_id).map(zone => ({ ...zone, cfAccountId: account.id, credentialId: account.credential_id, accountName: account.name }));
}
export async function liveAccountZone(directory: Pick<ZoneDirectory, 'list' | 'all' | 'request'>, account: DnsBinding, request: CfRequest, zoneId: string) {
  if (typeof zoneId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(zoneId)) throw Object.assign(new Error('Invalid Zone ID'), { statusCode: 400 });
  const zone = (await directory.request(account, request, `/zones/${encodeURIComponent(zoneId)}`)).result as DnsZone;
  if (zone?.id !== zoneId || zone.account?.id !== account.account_id) throw Object.assign(new Error('Zone does not belong to the selected Account'), { statusCode: 409, code: 'ZONE_OWNERSHIP_MISMATCH' });
  return zone;
}
