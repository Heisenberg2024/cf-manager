import type { CfRequest } from './accountDiscovery';
import { BoundReadCache } from './resourceCache';
import { accountZones, liveAccountZone } from './accountZones';
import type { DnsBinding, ZoneDirectory } from './zoneDirectory';
import { errorDetails } from './cfErrors';
import { assertBaseline, canonical, fail, object, segment, snapshot, validateConfig, type TunnelSnapshot, type TunnelConfig } from './tunnelConfig';
import type { ReadMetric } from './readScheduler';

export async function readAll(request: CfRequest, path: string, signal?: AbortSignal) {
  const rows: any[] = [], seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const data = await request(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=50`, { signal });
    if (!Array.isArray(data.result)) fail('INVALID_RESPONSE', 'Invalid paginated list', 502);
    for (const row of data.result) { if (!object(row) || !row.id || seen.has(row.id)) fail('INVALID_RESPONSE', 'Repeated or missing list identity', 502); seen.add(row.id); rows.push(row); }
    const info = data.result_info;
    if (info?.page !== undefined && info.page !== page) fail('INVALID_RESPONSE', 'Pagination did not advance', 502);
    if (info?.total_count !== undefined && rows.length > info.total_count) fail('INVALID_RESPONSE', 'Pagination count mismatch', 502);
    if (info?.total_pages !== undefined ? page >= info.total_pages : data.result.length < (info?.per_page || 50)) {
      if (info?.total_count !== undefined && rows.length !== info.total_count) fail('INVALID_RESPONSE', 'Incomplete list', 502);
      return rows;
    }
    if (!data.result.length) fail('INVALID_RESPONSE', 'Empty incomplete page', 502);
  }
  return fail('INVALID_RESPONSE', 'List pagination exceeded limit', 502);
}

export function uncertain(error: unknown): boolean { const s = errorDetails(error).statusCode; return s >= 500 || s === 408; }
export function tunnelBase(account: DnsBinding) {
  if (!account.account_id || account.is_enabled === 0 || account.is_active === 0) fail('BAD_ACCOUNT', 'Account disabled or not bound to Cloudflare', 409);
  return `/accounts/${segment(account.account_id)}/cfd_tunnel`;
}
export class TunnelResources {
  readonly cache: BoundReadCache;
  // Local exclusion only: Cloudflare has no multi-resource transaction or distributed CAS.
  private busy = new Set<string>();
  constructor(private directory: ZoneDirectory, metric: (event: ReadMetric) => void = () => {}) { this.cache = new BoundReadCache(directory, metric, 30000, 30000, 200); }
  invalidate(account: DnsBinding, tunnelId?: string) { this.cache.invalidate(account.id, account.account_id, tunnelId ? `tunnel/${tunnelId}` : 'tunnel'); }
  async list(account: DnsBinding, request: CfRequest, refresh = false, background = false, signal?:AbortSignal) {
    const base = tunnelBase(account);
    return this.cache.read(account, 'tunnel/list', signal => readAll(request, `${base}?is_deleted=false`, signal), { refresh,background,signal });
  }
  async detail(account: DnsBinding, request: CfRequest, id: string) {
    const result = (await request(`${tunnelBase(account)}/${segment(id)}`)).result;
    if (!object(result) || result.id !== id || result.deleted_at || (result.account_id && result.account_id !== account.account_id)) fail('TUNNEL_NOT_FOUND', 'Tunnel does not belong to the selected Account', 409);
    if (result.config_src !== 'cloudflare' && result.remote_config !== true) fail('LOCAL_TUNNEL', 'Only remotely managed Tunnels can be configured', 409);
    return result;
  }
  async readConfig(account: DnsBinding, request: CfRequest, id: string, signal?: AbortSignal): Promise<TunnelSnapshot> {
    const path = `${tunnelBase(account)}/${segment(id)}/configurations`;
    // Each safety read gets a new upstream request; only display snapshots are cached.
    return this.cache.uncached(account, async innerSignal => snapshot((await request(path, { signal: innerSignal })).result), signal);
  }
  async save(account: DnsBinding, request: CfRequest, id: string, input: { baseline?: unknown; config?: unknown }) {
    validateConfig(input.config);
    await this.detail(account, request, id);
    const current = await this.readConfig(account, request, id);
    assertBaseline(current, input.baseline);
    let writeError: unknown;
    try { await request(`${tunnelBase(account)}/${segment(id)}/configurations`, { method: 'PUT', body: JSON.stringify({ config: input.config }), retry: false }); }
    catch (error) { if (!uncertain(error)) throw error; writeError = error; }
    finally { this.invalidate(account, id); }
    try {
      const actual = await this.readConfig(account, request, id);
      if (canonical(actual.config) === canonical(input.config)) return { status: 'success' as const, snapshot: actual, recovered: !!writeError };
      return { status: writeError ? 'unknown' as const : 'partial' as const, snapshot: actual, message: 'Remote configuration differs after PUT. Do not resend without reviewing' };
    } catch { return { status: 'unknown' as const, message: 'PUT result could not be confirmed. Keep the draft and read remote state before retrying' }; }
  }
  async connections(account: DnsBinding, request: CfRequest, id: string, refresh = false) {
    return this.cache.read(account, `tunnel/${segment(id)}/connections`, async signal => {
      const result = (await request(`${tunnelBase(account)}/${id}/connections`, { signal })).result;
      if (!Array.isArray(result)) fail('INVALID_RESPONSE', 'Invalid connection list', 502);
      return result;
    }, { refresh });
  }
  async hostnames(account: DnsBinding, request: CfRequest, id: string, verify = false, signal?: AbortSignal) {
    const config = await this.readConfig(account, request, id, signal);
    const names = [...new Set(config.config.ingress.map(e => e.hostname).filter((h): h is string => !!h))];
    const zones = verify ? await accountZones(this.directory, account, request) : [];
    const results = [];
    // At most two exact DNS lookups in flight via the existing scheduler.
    for (const hostname of names) {
      signal?.throwIfAborted();
      const zone = zones.filter(z => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!verify) { results.push({ hostname, dns: 'unverified' }); continue; }
      if (!zone) { results.push({ hostname, dns: 'unknown', error: 'Zone unavailable in selected Account' }); continue; }
      try {
        const records = await this.directory.all(account, request, `/zones/${zone.id}/dns_records?type=CNAME&name.exact=${encodeURIComponent(hostname)}&content.exact=${encodeURIComponent(`${id}.cfargotunnel.com`)}`, 100, { signal });
        results.push({ hostname, dns: records.length ? 'confirmed' : 'missing' });
      } catch (error) { results.push({ hostname, dns: 'unknown', error: errorDetails(error).message }); }
    }
    return { hostnames: results, complete: verify && results.every(r => r.dns !== 'unknown'), scope: 'configured-hostnames', fetchedAt: config.fetchedAt };
  }
  async exclusive<T>(key: string, run: () => Promise<T>) {
    if (this.busy.has(key)) fail('OPERATION_BUSY', 'Operation already running; inspect remote state before retrying', 409);
    this.busy.add(key); try { return await run(); } finally { this.busy.delete(key); }
  }
  async wizard(account: DnsBinding, request: CfRequest, body: Record<string, any>) {
    const base = tunnelBase(account);
    const { mode = 'create', hostname, port, protocol = 'http', path = '', zoneId } = body;
    if (!['create', 'reuse'].includes(mode) || typeof hostname !== 'string' || !/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d-]{2,63}$/i.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || !['http', 'https', 'tcp'].includes(protocol) || typeof path !== 'string' || path.length > 2048) fail('VALIDATION_ERROR', 'Invalid mode, hostname, port, protocol or path');
    const name = body.tunnelName || `tunnel-${hostname}`;
    if (typeof name !== 'string' || name.length > 100 || !name.trim()) fail('VALIDATION_ERROR', 'Invalid Tunnel name');
    return this.exclusive(`wizard:${account.account_id}:${hostname.toLowerCase()}`, async () => {
      const zone = zoneId ? await liveAccountZone(this.directory, account, request, zoneId) : (await accountZones(this.directory, account, request)).filter(z => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone || !(hostname === zone.name || hostname.endsWith(`.${zone.name}`))) fail('ZONE_NOT_FOUND', 'Hostname Zone unavailable in selected Account');
      const dnsBase = `/zones/${segment(zone.id)}/dns_records`;
      const dns = () => this.directory.all(account, request, `${dnsBase}?name.exact=${encodeURIComponent(hostname)}`, 100);
      let id = mode === 'reuse' ? segment(body.tunnelId) : '';
      let before: TunnelSnapshot | undefined;
      if (mode === 'reuse') { await this.detail(account, request, id); before = await this.readConfig(account, request, id); }
      else if ((await this.list(account, request, true)).value.some(t => object(t) && t.name === name)) fail('TUNNEL_EXISTS', 'A Tunnel with this name exists; inspect it and choose reuse');
      const records = await dns();
      const existing = records.find(r => object(r) && ['A', 'AAAA', 'CNAME'].includes(r.type));
      const matches = (r: unknown) => object(r) && r.type === 'CNAME' && r.name === hostname && r.content === `${id}.cfargotunnel.com`;
      if (existing && !(mode === 'reuse' && matches(existing))) fail('CNAME_CONFLICT', 'Hostname already has conflicting DNS records', 409);
      const rule = { hostname, service: `${protocol}://localhost:${port}`, ...(path ? { path } : {}) };
      if (before?.config.ingress.some(e => e.hostname === hostname && (e.path || '') === path && (e.service !== rule.service))) fail('INGRESS_CONFLICT', 'Existing hostname/path rule differs; edit it explicitly', 409);
      let createdTunnel = false, cnameId = '', unknown = false, writePending = false, step = 'precheck';
      let desired: TunnelConfig | undefined;
      const residuals: string[] = [];
      try {
        // Ownership is checked again immediately before any mutation.
        await liveAccountZone(this.directory, account, request, zone.id);
        if (!existing && (await dns()).some(r => object(r) && ['A', 'AAAA', 'CNAME'].includes(r.type))) fail('CNAME_CONFLICT', 'DNS changed during precheck', 409);
        if (mode === 'create') {
          step = 'create_tunnel';
          writePending = true;
          const created = (await request(base, { method: 'POST', body: JSON.stringify({ name, config_src: 'cloudflare' }), retry: false })).result;
          if (!object(created) || !created.id) { unknown = true; fail('UNKNOWN_WRITE', 'Tunnel creation response missing ID', 502); }
          id = segment(created.id); createdTunnel = true; writePending = false;
        }
        if (!existing) {
          step = 'create_dns';
          await liveAccountZone(this.directory, account, request, zone.id);
          writePending = true;
          const cname = (await request(dnsBase, { method: 'POST', body: JSON.stringify({ type: 'CNAME', name: hostname, content: `${id}.cfargotunnel.com`, ttl: 1, proxied: true }), retry: false })).result;
          if (!object(cname) || !cname.id) { unknown = true; fail('UNKNOWN_WRITE', 'DNS creation response missing ID', 502); }
          cnameId = segment(cname.id); writePending = false;
        }
        step = 'save_config';
        if (before) {
          desired = structuredClone(before.config);
          if (!desired.ingress.some(e => e.hostname === hostname && (e.path || '') === path)) desired.ingress.splice(desired.ingress.length - 1, 0, rule);
          assertBaseline(await this.readConfig(account, request, id), before);
        } else desired = { ingress: [rule, { service: 'http_status:404' }] };
        validateConfig(desired);
        const configChanged = !before || canonical(before.config) !== canonical(desired);
        if (configChanged) {
          writePending = true;
          await request(`${base}/${id}/configurations`, { method: 'PUT', body: JSON.stringify({ config: desired }), retry: false });
          writePending = false;
        }
        step = 'confirm';
        const actual = await this.readConfig(account, request, id);
        if (canonical(actual.config) !== canonical(desired) || !(await dns()).some(matches)) { unknown = true; fail('UNKNOWN_WRITE', 'Remote state differs after execution', 502); }
        return { status: 'success' as const, tunnelId: id, hostname, cnameTarget: `${id}.cfargotunnel.com`, mode, snapshot: actual, residuals: [] as string[] };
      } catch (error) {
        // Once a write may have reached CF, dependencies are retained for reconciliation.
        unknown ||= step === 'confirm' || (writePending && uncertain(error));
        if (unknown) {
          residuals.push(...[id && `Tunnel ${id}`, cnameId && `CNAME ${cnameId}`, !id && `Tunnel name ${name}`, !cnameId && step === 'create_dns' && `DNS ${hostname}`].filter((x): x is string => !!x));
          if (before && desired) residuals.push(`Configuration ${id}`);
          return { status: 'unknown' as const, tunnelId: id, hostname, mode, failedStep: step, message: errorDetails(error).message, residuals, ...(before ? { baseline: before } : {}), ...(desired ? { attemptedConfig: desired } : {}) };
        }
        // Known rejection of config means no reuse config change occurred. No broad restore/delete.
        if (cnameId) {
          try {
            await liveAccountZone(this.directory, account, request, zone.id);
            const current = (await request(`${dnsBase}/${cnameId}`)).result;
            if (!matches(current)) fail('ROLLBACK_CONFLICT', 'DNS changed; retained for manual review', 409);
            await request(`${dnsBase}/${cnameId}`, { method: 'DELETE', retry: false });
            try { await request(`${dnsBase}/${cnameId}`); fail('ROLLBACK_UNCONFIRMED', 'DNS deletion not confirmed', 502); } catch (e) { if (errorDetails(e).statusCode !== 404) throw e; }
          } catch { residuals.push(`CNAME ${cnameId}`); }
        }
        // Do not remove a Tunnel still referenced by a retained CNAME.
        if (createdTunnel && !residuals.length) {
          try {
            await request(`${base}/${id}`, { method: 'DELETE', retry: false });
            const result = (await request(`${base}/${id}`)).result;
            if (!object(result) || !result.deleted_at) fail('ROLLBACK_UNCONFIRMED', 'Tunnel deletion not confirmed', 502);
          } catch (e) { if (errorDetails(e).statusCode !== 404) residuals.push(`Tunnel ${id}`); }
        } else if (createdTunnel) residuals.push(`Tunnel ${id}`);
        return { status: residuals.length ? 'partial' as const : 'failed' as const, tunnelId: id, hostname, mode, failedStep: step, message: errorDetails(error).message, residuals };
      } finally { this.invalidate(account); this.directory.invalidate(account.id, account.account_id); }
    });
  }
}
