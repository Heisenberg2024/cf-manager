import { authHeaders, createCfRequest } from '../accountDiscovery';

/** Mirrors the confirmed production envelope, including the per_page rejection. No real credentials. */
export function pagesEnvelope(page = 1, totalCount = 20, perPage = 10) {
  const count = Math.min(perPage, Math.max(0, totalCount - (page - 1) * perPage));
  return {
    success: true, errors: [], messages: [],
    result: Array.from({ length: count }, (_, i) => {
      const index = (page - 1) * perPage + i;
      return { id: `project-${index}`, name: `pages-${index}`, subdomain: `pages-${index}.pages.dev` };
    }),
    result_info: { page, per_page: perPage, count, total_count: totalCount, total_pages: Math.ceil(totalCount / perPage) },
  };
}

export function cloudflareWorkerFixture(cfAccountId = 'cf-a', workerCount = 21, pagesCount = 20) {
  const calls: string[] = [], headers: Headers[] = [];
  const prefix = `/accounts/${cfAccountId}`;
  const request = createCfRequest(async (path, init) => {
    calls.push(path); headers.push(new Headers(init.headers));
    const url = new URL(path, 'https://synthetic.invalid');
    const rejected = () => Response.json({ success: false, errors: [{ code: 8000024, message: 'Invalid pagination parameters' }], result: null }, { status: 400 });
    if (url.pathname === `${prefix}/workers/scripts`) {
      if (url.search) return rejected();
      return Response.json({ success: true, errors: [], messages: [], result: Array.from({ length: workerCount }, (_, i) => ({ id: `worker-${i}` })) });
    }
    if (url.pathname === `${prefix}/pages/projects`) {
      if (!/^\?page=[1-9]\d*$/.test(url.search)) return rejected();
      const page = Number(url.searchParams.get('page'));
      if (page > Math.max(1, Math.ceil(pagesCount / 10))) return rejected();
      return Response.json(pagesEnvelope(page, pagesCount));
    }
    if (path === '/graphql') return Response.json({ data: { viewer: { accounts: [{ workers: [{ sum: { requests: 7, cpuTimeUs: 1000 } }], pages: [{ sum: { requests: 3 } }] }] } } });
    throw new Error(`Unexpected fixture request: ${path}`);
  }, authHeaders({ auth_type: 'global_key', api_key: 'synthetic-global-key', email: 'synthetic@example.invalid' }));
  return { calls, headers, request };
}
