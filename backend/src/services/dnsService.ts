import { Account } from '../models/account';
import { getCfClient, accountRequest } from './cfFactory';
import { dnsDirectory } from './dnsDirectory';
import { measureDnsWrite } from './performanceMetrics';
import { dnsRecordId } from './dnsRecord';

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
}

export async function listDnsRecords(account: Account, zoneId: string, signal?: AbortSignal): Promise<DnsRecord[]> {
  return await dnsDirectory.all(account, accountRequest(account), `/zones/${zoneId}/dns_records`, 500, { signal }) as DnsRecord[];
}

export async function createDnsRecord(account: Account, zoneId: string, data: Partial<DnsRecord>): Promise<DnsRecord> {
  const cf = getCfClient(account, 0);
  return await measureDnsWrite(account.id, () => cf.dns.records.create({ ...data, zone_id: zoneId } as any)) as any;
}

export async function updateDnsRecord(account: Account, zoneId: string, recordId: string, data: Partial<DnsRecord>): Promise<DnsRecord> {
  recordId = dnsRecordId(recordId);
  const cf = getCfClient(account, 0);
  return await measureDnsWrite(account.id, () => cf.dns.records.edit(recordId, { ...data, zone_id: zoneId } as any)) as any;
}

export async function deleteDnsRecord(account: Account, zoneId: string, recordId: string): Promise<void> {
  recordId = dnsRecordId(recordId);
  const cf = getCfClient(account, 0);
  await measureDnsWrite(account.id, () => cf.dns.records.delete(recordId, { zone_id: zoneId }));
}
