import { accountZones } from './accountZones';
import { dnsDirectory } from './dnsDirectory';
import { Account, getAllAccounts, getAccountById } from '../models/account';
import { accountRequest } from './cfFactory';
import { TunnelResources, tunnelBase } from './tunnelResources';
import { fail, object, segment } from './tunnelConfig';
import { recordPerformance } from './performanceMetrics';
export const tunnelResources = new TunnelResources(dnsDirectory, recordPerformance);
export interface TunnelAccountItem { id: number; name: string; account_id: string; credential_id?: number }
export function listTunnelAccounts(): TunnelAccountItem[] {
  return getAllAccounts().filter(a => a.account_id && a.is_enabled !== 0 && a.is_active !== 0).map(a => ({ id: a.id, name: a.name, account_id: a.account_id!, credential_id: a.credential_id }));
}
export function getTunnelAccount(id: number): Account {
  const account = getAccountById(id);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  tunnelBase(account); return account;
}
export async function listTunnels(account: Account, refresh = false) { return (await tunnelResources.list(account, accountRequest(account), refresh)).value; }
export async function createTunnel(account: Account, name: string) {
  try { const result = (await accountRequest(account)(tunnelBase(account), { method: 'POST', body: JSON.stringify({ name, config_src: 'cloudflare' }), retry: false })).result; if (!object(result) || !result.id) fail('UNKNOWN_WRITE', 'Tunnel creation could not be confirmed; refresh before retrying', 502); return result; }
  finally { tunnelResources.invalidate(account); }
}
export async function deleteTunnel(account: Account, id: string) {
  try { return await accountRequest(account)(`${tunnelBase(account)}/${segment(id)}`, { method: 'DELETE', retry: false }); }
  finally { tunnelResources.invalidate(account); }
}
export async function getTunnelToken(account: Account, id: string) { return (await accountRequest(account)(`${tunnelBase(account)}/${segment(id)}/token`)).result as string; }
export async function getTunnelConnections(account: Account, id: string, refresh = false) { return tunnelResources.connections(account, accountRequest(account), id, refresh); }
export async function getTunnelConfig(account: Account, id: string, signal?: AbortSignal) { return tunnelResources.readConfig(account, accountRequest(account), id, signal); }
export async function updateTunnelConfig(account: Account, id: string, input: { baseline?: unknown; config?: unknown }) { return tunnelResources.exclusive(`config:${account.account_id}:${id}`, () => tunnelResources.save(account, accountRequest(account), id, input)); }
export async function listZonesForAccount(account: Account) { return (await accountZones(dnsDirectory, account, accountRequest(account))).map(z => ({ id: z.id, name: z.name })); }
export async function listTunnelHostnames(account: Account, id: string, verify = false, signal?: AbortSignal) { return tunnelResources.hostnames(account, accountRequest(account), id, verify, signal); }
