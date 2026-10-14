import type { CfRequest } from '../accountDiscovery';
export const tunnelAccount = { id: 1, name: 'Synthetic', account_id: 'a'.repeat(32), credential_id: 10, is_active: 1, is_enabled: 1, enabled_features: 'dns', auth_type: 'global_key', api_key: 'synthetic-ciphertext', email: 'synthetic@example.test' };
export const fullConfig = () => ({ originRequest: { noTLSVerify: true, connectTimeout: 8 }, 'warp-routing': { enabled: true }, future: { settings: [1, 'keep'] }, ingress: [
  { hostname: 'app.example.test', path: '^/api', service: 'ssh://192.0.2.5:22', originRequest: { httpHostHeader: 'internal', access: { required: true, teamName: 'team' } }, future: { x: 1 } },
  { hostname: 'app.example.test', path: '^/web', service: 'https://service:8443', originRequest: { noTLSVerify: false } },
  { path: '^/other', service: 'tcp://host:99', originRequest: { tcpKeepAlive: 30 } },
  { service: 'http_status:503', originRequest: { keepAliveTimeout: 90 }, future: 'catch-all' },
] });
export function tunnelsFixture() {
  const tunnels = new Map<string, any>([['t1', { id: 't1', name: 'existing', config_src: 'cloudflare' }]]);
  const configs = new Map<string, any>([['t1', { config: fullConfig(), version: 5, source: 'cloudflare' }]]);
  const records = new Map<string, any>();
  const ruleset = { id: 'rs1', phase: 'http_request_origin', kind: 'zone', rules: [{ id: 'rule1', version: '1', enabled: false, description: 'keep', expression: 'true', action: 'route', action_parameters: { origin: { host: 'internal', port: 80 }, host_header: 'advanced' }, ratelimit: undefined, ref: 'stable' }] };
  const calls: Array<{ path: string; method: string; body?: any; retry?: boolean }> = [];
  let serial = 0;
  let hook: ((path: string, method: string, body: any) => unknown) | undefined;
  const request: CfRequest = async (path, init = {}) => {
    init.signal?.throwIfAborted();
    const method = init.method || 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, retry: init.retry });
    const intercepted = hook?.(path, method, body); if (intercepted !== undefined) return await intercepted as any;
    const url = new URL(path, 'https://fixture.invalid'), p = url.pathname;
    const result = (value: unknown) => ({ success: true, result: structuredClone(value) });
    const missing = () => { throw Object.assign(Error('Synthetic 404'), { statusCode: 404 }); };
    if (p === '/zones/z1') return result({ id: 'z1', name: 'example.test', account: { id: tunnelAccount.account_id } });
    if (p === '/zones') return { ...result([{ id: 'z1', name: 'example.test', account: { id: tunnelAccount.account_id } }]), result_info: { total_pages: 1 } };
    if (p.endsWith('/cfd_tunnel')) {
      if (method === 'POST') { const id = `t${++serial + 1}`; const value = { id, name: body.name, config_src: body.config_src }; tunnels.set(id, value); return result(value); }
      return { ...result([...tunnels.values()].filter(t => !t.deleted_at)), result_info: { total_pages: 1, total_count: [...tunnels.values()].filter(t => !t.deleted_at).length } };
    }
    const t = p.match(/\/cfd_tunnel\/([^/]+)(?:\/(.*))?$/);
    if (t) {
      const id = t[1], suffix = t[2];
      if (!tunnels.has(id)) return missing();
      if (!suffix) { if (method === 'DELETE') tunnels.get(id).deleted_at = 'now'; return result(tunnels.get(id)); }
      if (suffix === 'configurations') {
        if (method === 'PUT') configs.set(id, { config: body.config, version: (configs.get(id)?.version || 0) + 1, source: 'cloudflare' });
        return result(configs.get(id) || { config: null, version: 0 });
      }
      if (suffix === 'connections') return result([{ id: 'conn1' }]);
      if (suffix === 'token') return result('synthetic-token');
    }
    const dns = p.match(/\/zones\/z1\/dns_records(?:\/([^/]+))?$/);
    if (dns) {
      if (method === 'POST') { const id = `dns${++serial}`; records.set(id, { id, ...body }); return result(records.get(id)); }
      if (dns[1]) { if (!records.has(dns[1])) return missing(); if (method === 'DELETE') records.delete(dns[1]); return result(records.get(dns[1]) || null); }
      return { ...result([...records.values()].filter(r => (!url.searchParams.get('name.exact') || r.name === url.searchParams.get('name.exact')) && (!url.searchParams.get('content.exact') || r.content === url.searchParams.get('content.exact')))), result_info: { total_pages: 1 } };
    }
    if (p.endsWith('/rulesets')) return { ...result([{ id: 'managed', kind: 'managed', phase: ruleset.phase }, { id: ruleset.id, kind: ruleset.kind, phase: ruleset.phase }]), result_info: { cursor: '' } };
    if (p.endsWith('/rulesets/rs1')) return result(ruleset);
    if (p.includes('/rulesets/rs1/rules')) {
      if (method === 'POST') ruleset.rules.push({ id: `rule${++serial + 1}`, version: '1', ...body });
      if (method === 'PATCH') Object.assign(ruleset.rules.find(r => r.id === 'rule1')!, body);
      if (method === 'DELETE') ruleset.rules = ruleset.rules.filter(r => r.id !== 'rule1');
      return result(ruleset);
    }
    throw Error(`Unmatched synthetic request ${method} ${p}`);
  };
  return { request, calls, tunnels, configs, records, ruleset, setHook: (next?: typeof hook) => { hook = next; } };
}
