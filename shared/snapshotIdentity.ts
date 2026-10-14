import type { DnsBinding } from './zoneDirectory';
import type { ResourceMetric } from './dashboardData';

/** Inventory identity v2 is independent of the short-lived module cache signature. */
export async function snapshotIdentity(a:DnsBinding):Promise<string> {
 const input=[a.id,a.account_id,a.credential_id??null,a.auth_type??null,a.api_token??null,a.api_key??null,a.email??null,a.proxy_enabled??null,a.proxy_url??null,a.snapshot_epoch??0];
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input)));
 return `inventory:v2:${a.id}:${Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')}`;
}
export type InventorySink=(account:DnsBinding,metric:ResourceMetric,rows:unknown[]|null,startedAt:number,confirmedAt:number,error?:unknown)=>Promise<void>;
export type UsageSink=(account:DnsBinding,date:string,requests:number)=>Promise<void>;
