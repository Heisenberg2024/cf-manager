import { accountZones } from './accountZones';
import { dnsDirectory } from './dnsDirectory';
import { Account, getAllAccounts, getAccountById } from '../models/account';
import { getCfClient, accountRequest } from './cfFactory';

export interface TunnelAccountItem {
  id: number;
  name: string;
  account_id: string;
  credential_id?: number;
}

export function listTunnelAccounts(): TunnelAccountItem[] {
  return getAllAccounts()
    .filter((a) => !!a.account_id)
    .map((a) => ({ id: a.id, name: a.name, account_id: a.account_id!, credential_id: a.credential_id }));
}

export function getTunnelAccount(id: number): Account {
  const account = getAccountById(id);
  if (!account) {
    const err = new Error('Account not found') as any;
    err.statusCode = 404;
    throw err;
  }
  if (!account.account_id) {
    const err = new Error('该账户未配置 Cloudflare account_id，无法管理隧道') as any;
    err.statusCode = 400;
    throw err;
  }
  return account;
}

export async function listTunnels(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const tunnels: any[] = [];
  for await (const t of cf.zeroTrust.tunnels.cloudflared.list({ account_id: account.account_id! })) {
    tunnels.push(t);
  }
  return tunnels;
}

export async function createTunnel(account: Account, name: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.zeroTrust.tunnels.cloudflared.create({ account_id: account.account_id!, name });
}

export async function deleteTunnel(account: Account, tunnelId: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.zeroTrust.tunnels.cloudflared.delete(tunnelId, { account_id: account.account_id! });
}

export async function getTunnelToken(account: Account, tunnelId: string): Promise<string> {
  const cf = getCfClient(account);
  return await cf.zeroTrust.tunnels.cloudflared.token.get(tunnelId, { account_id: account.account_id! });
}

export async function getTunnelConnections(account: Account, tunnelId: string): Promise<any> {
  const cf = getCfClient(account);
  const res: any = await cf.zeroTrust.tunnels.cloudflared.connections.get(tunnelId, { account_id: account.account_id! });
  return res.result ?? res;
}

export async function getTunnelConfig(account: Account, tunnelId: string): Promise<any[]> {
  const cf = getCfClient(account);
  const res: any = await cf.zeroTrust.tunnels.cloudflared.configurations.get(tunnelId, { account_id: account.account_id! });
  // SDK 可能返回解包后的 { config: { ingress: [...] } } 或原始 { result: { config: { ingress: [...] } } }
  const config = res?.config ?? res?.result?.config;
  return config?.ingress ?? [];
}

export async function updateTunnelConfig(
  account: Account,
  tunnelId: string,
  ingress: Array<{ hostname?: string; service: string }>
): Promise<any> {
  const cf = getCfClient(account);
  return await cf.zeroTrust.tunnels.cloudflared.configurations.update(tunnelId, {
    account_id: account.account_id!,
    config: { ingress },
  } as any);
}

export async function listZonesForAccount(account: Account): Promise<Array<{ id: string; name: string }>> {
  return (await accountZones(dnsDirectory, account, accountRequest(account))).map(zone => ({id: zone.id, name: zone.name}));
}

/**
 * 获取隧道绑定的域名列表：扫描账户下所有 zone 的 CNAME 记录，
 * 找到 content 为 {tunnelId}.cfargotunnel.com 的记录，返回其 name（hostname）。
 */
export async function listTunnelHostnames(account: Account, tunnelId: string): Promise<string[]> {
  const cf = getCfClient(account);
  const target = `${tunnelId}.cfargotunnel.com`;
  const zones = await listZonesForAccount(account);
  const hostnames: string[] = [];
  for (const zone of zones) {
    try {
      for await (const record of cf.dns.records.list({ zone_id: zone.id, type: 'CNAME' as any, content: { exact: target }, per_page: 100 })) {
        if ((record as any).content === target) {
          hostnames.push((record as any).name);
        }
      }
    } catch {
      // 某些 zone 可能无权限，跳过
    }
  }
  return hostnames;
}
