import type { Account } from '../db/models';
import { accountRequest } from './cfApi';
import { getDnsDirectory } from './dnsDirectory';
import { TunnelResources, tunnelBase } from './tunnelResources';
import { fail, object, segment } from './tunnelConfig';
const resources = new WeakMap<D1Database, TunnelResources>();
export function getTunnelResources(db: D1Database) { let r = resources.get(db); if (!r) { r = new TunnelResources(getDnsDirectory(db), event => console.info(JSON.stringify({ scope: 'tunnels_performance', ...event }))); resources.set(db, r); } return r; }
export interface TunnelAccountItem { id: number; name: string; account_id: string; credential_id?: number }
export function listTunnelAccounts(accounts: Account[]): TunnelAccountItem[] { return accounts.filter(a => a.account_id && a.is_enabled !== 0 && a.is_active !== 0).map(a => ({ id: a.id, name: a.name, account_id: a.account_id!, credential_id: a.credential_id })); }
export async function listTunnels(account: Account, key: string, db: D1Database, refresh = false) { return (await getTunnelResources(db).list(account, await accountRequest(account, key), refresh)).value; }
export async function createTunnel(account: Account, name: string, key: string, db: D1Database) { try { const result = (await (await accountRequest(account, key))(tunnelBase(account), { method: 'POST', body: JSON.stringify({ name, config_src: 'cloudflare' }), retry: false })).result; if (!object(result) || !result.id) fail('UNKNOWN_WRITE', 'Tunnel creation could not be confirmed; refresh before retrying', 502); return result; } finally { getTunnelResources(db).invalidate(account); } }
export async function deleteTunnel(account: Account, id: string, key: string, db: D1Database) { try { return await (await accountRequest(account, key))(`${tunnelBase(account)}/${segment(id)}`, { method: 'DELETE', retry: false }); } finally { getTunnelResources(db).invalidate(account); } }
export async function getTunnelToken(account: Account, id: string, key: string) { return (await (await accountRequest(account, key))(`${tunnelBase(account)}/${segment(id)}/token`)).result as string; }
export async function getTunnelConnections(account: Account, id: string, key: string, db: D1Database, refresh = false) { return getTunnelResources(db).connections(account, await accountRequest(account, key), id, refresh); }
export async function getTunnelConfig(account: Account, id: string, key: string, db: D1Database, signal?: AbortSignal) { return getTunnelResources(db).readConfig(account, await accountRequest(account, key), id, signal); }
export async function updateTunnelConfig(account: Account, id: string, input: { baseline?: unknown; config?: unknown }, key: string, db: D1Database) { const r = getTunnelResources(db); const request = await accountRequest(account, key); return r.exclusive(`config:${account.account_id}:${id}`, () => r.save(account, request, id, input)); }
export async function listTunnelHostnames(account: Account, id: string, key: string, db: D1Database, verify = false, signal?: AbortSignal) { return getTunnelResources(db).hostnames(account, await accountRequest(account, key), id, verify, signal); }
