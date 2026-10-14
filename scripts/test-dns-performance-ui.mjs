// Local synthetic performance acceptance: 20 Accounts, 1170 Zones, 10000 records.
import { createServer } from 'node:http';
import { readFileSync, existsSync, cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = mkdtempSync('/private/tmp/cf-manager-dns-perf-build-');
cpSync(resolve(root, 'frontend/dist'), dist, { recursive: true });
const base = readFileSync(resolve(dist, 'index.html'), 'utf8').includes('/admin/assets/') ? '/admin' : '';
const zh = JSON.parse(readFileSync(resolve(root, 'frontend/src/i18n/locales/zh-CN.json'), 'utf8'));
const accounts = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Account ${i + 1}`, account_id: String(i + 1).padStart(32, '0'), credential_id: i + 1, is_active: 1, is_enabled: 1, enabled_features: 'dns' }));
const zones = accounts.flatMap(account => Array.from({ length: account.id === 1 ? 600 : 30 }, (_, i) => ({ id: `zone-${account.id}-${i}`, name: `a${account.id}-${String(i).padStart(3, '0')}.test`, account: { id: account.account_id }, cfAccountId: account.id, credentialId: account.id, accountName: account.name, status: 'active', plan: { name: 'Free' } })));
const records = Array.from({ length: 10000 }, (_, i) => ({ id: `r-${i}`, name: `r-${i}.a1-000.test`, type: 'A', content: '192.0.2.1', proxied: false, ttl: 300 }));
const counts = { accounts: 0, zoneReads: [], recordReads: 0, writes: 0 };
let failProxy = false, failAccount = false, slowRecords = false, slowAccount = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://synthetic.local'), path = url.pathname.slice(4);
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: { message: data } })); };
    if (url.pathname.startsWith('/api/')) {
      if (path === '/settings') return send({ platform: 'docker' });
      if(path==='/accounts/options'){counts.accounts++;return send(accounts);}
      if (path === '/accounts') { counts.accounts++; return send({ accounts }); }
      if (path === '/credentials') { await sleep(900); return send(accounts.map(a => ({ id: a.id, name: `Credential ${a.id}` }))); }
      if (/^\/dns\/accounts\/\d+\/domains$/.test(path)) { const id = Number(path.split('/')[3]); counts.zoneReads.push(id); await sleep(slowAccount && id === 2 ? 700 : 15); if (failAccount && id === 1) return send('Synthetic Account failure', 503); return send({ zones: zones.filter(zone => zone.cfAccountId === id), meta: { state: 'miss' } }); }
      if (path.includes('/records') && req.method === 'GET') { counts.recordReads++; await sleep(slowRecords ? 450 : 20); return send(records); }
      if (path.endsWith('/proxy')) {
        counts.writes++; let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body);
        if (failProxy) { await sleep(150); return send('Synthetic permission denied', 403); }
        const row = records.find(row => row.id === input.record_id); row.proxied = input.proxied; if (row.proxied) row.ttl = 1; return send(row);
      }
      return send([]);
    }
    const candidate = resolve(dist, '.' + (url.pathname.slice(base.length) || '/'));
    const file = existsSync(candidate) && extname(candidate) ? candidate : resolve(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = '/private/tmp/cf-manager-dns-performance-ui'; mkdirSync(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath:process.env.CHROMIUM_EXECUTABLE||undefined, headless: true });
  for (const width of [1440, 390]) {
    for(const row of records) { row.proxied = false; row.ttl = 300; }
    counts.writes = 0; counts.accounts = 0; counts.zoneReads = []; counts.recordReads = 0;
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { localStorage.setItem('api_token', 'synthetic'); localStorage.setItem('app_locale', 'zh-CN'); localStorage.setItem('dns_selected_account', '1'); });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    let zoneResponseAt = 0, zoneApiMs = 0;
    page.on('requestfinished', request => { if (!zoneResponseAt && request.url().includes('/dns/accounts/1/domains')) { zoneResponseAt = Date.now(); zoneApiMs = request.timing().responseEnd; } });
    const started = Date.now(); await page.goto(`${origin}${base}/dns`);
    const list = page.locator('.dns-zone-list'); await list.getByText('a1-000.test', { exact: true }).waitFor();
    const firstZoneMs = Date.now() - started;
    const renderAfterResponseMs = zoneResponseAt ? Date.now() - zoneResponseAt : null;
    assert.deepEqual(counts.zoneReads, [1], 'selected account must load without scanning other accounts'); assert.equal(counts.accounts, 1, 'metadata must not be loaded twice');
    assert((await list.locator('.n-list-item').count()) < 40, '600 Zones must have bounded visible DOM rows');
    const virtualScroller = list.locator('.v-vl').first();
    await virtualScroller.evaluate(element => { element.scrollTop = element.scrollHeight; }); await list.getByText('a1-599.test', { exact: true }).waitFor();
    await virtualScroller.evaluate(element => { element.scrollTop = 0; }); await list.getByText('a1-000.test', { exact: true }).waitFor();
    const search = page.getByPlaceholder(zh.dns.searchDomain, { exact: true });
    await search.fill('a1-599.test'); await page.locator('.dns-zone-actions button').first().click(); await page.getByText('已选择 1 个域名', { exact: true }).waitFor();
    await page.locator('.dns-zone-actions button').nth(2).click(); await search.fill(''); await list.getByText('a1-000.test', { exact: true }).waitFor();
    await list.getByText('a1-000.test', { exact: true }).click(); await page.getByText('r-0.a1-000.test', { exact: true }).waitFor();
    await list.getByText('a1-001.test', { exact: true }).click(); await page.getByText('r-0.a1-000.test', { exact: true }).waitFor();
    await list.getByText('a1-000.test', { exact: true }).click(); await page.waitForTimeout(100); assert.equal(counts.recordReads, 2, 'fresh revisit must reuse records');
    const proxy = page.locator('.dns-right-card .n-switch').first();
    const beforeReads = counts.recordReads; await proxy.click(); await page.waitForFunction(() => document.querySelector('.dns-right-card .n-switch')?.getAttribute('aria-checked') === 'true'); await page.waitForTimeout(100);
    assert.equal(counts.recordReads, beforeReads, 'confirmed Proxy must not reload all records');
    failProxy = true; await proxy.click(); await page.getByText('Synthetic permission denied', { exact: false }).first().waitFor(); assert.equal(await proxy.getAttribute('aria-checked'), 'true', 'failed Proxy must roll back'); failProxy = false;
    slowRecords = true; await page.getByRole('button', { name: zh.common.refresh, exact: true }).last().click(); await page.getByText(zh.dns.cacheStatus.refreshing, { exact: true }).waitFor(); assert(await page.getByText('r-0.a1-000.test', { exact: true }).isVisible()); await page.getByText(zh.dns.cacheStatus.refreshing, { exact: true }).waitFor({ state: 'hidden' }); slowRecords = false;
    failAccount = true; await page.getByRole('button', { name: zh.common.refresh, exact: true }).first().click(); await page.getByText('Synthetic Account failure', { exact: false }).waitFor(); assert(await list.getByText('a1-000.test', { exact: true }).isVisible()); failAccount = false; await page.getByRole('button', { name: zh.dns.cacheStatus.retry, exact: true }).click(); await page.getByText('Synthetic Account failure', { exact: false }).waitFor({ state: 'hidden' });
    slowAccount = true; const filter = page.locator('.page-view > .n-space .n-select').first(); await filter.click(); await page.locator('.n-base-select-menu:visible').getByText(zh.dns.allAccounts, { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.dns-zone-list')?.textContent?.includes('Account 3')); assert(!await list.getByText('Account 2｜Credential 2', { exact: true }).isVisible(), 'slow account must not block completed accounts');
    await list.getByText('Account 2｜Credential 2', { exact: true }).waitFor(); slowAccount = false;
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; }); await list.getByText('Account 20｜Credential 20', { exact: true }).scrollIntoViewIfNeeded(); assert(await list.getByText('Account 20｜Credential 20', { exact: true }).isVisible());
    await page.screenshot({ path: resolve(output, `${width}.png`) }); assert.deepEqual(errors, []);
    writeFileSync(resolve(output, `${width}.json`), JSON.stringify({ width, accounts: 20, zones: zones.length, records: 10000, firstZoneMs, zoneApiMs, renderAfterResponseMs, accountMetadataReads: counts.accounts, zoneReads: counts.zoneReads, recordReads: counts.recordReads, writes: counts.writes }, null, 2));
    console.log(`PASS DNS performance ${width}px: scoped load, virtualization, 10000 records, cache revisit, local Proxy, rollback, progressive Accounts (${firstZoneMs}ms first Zone)`);
    await context.close();
  }
  accounts[0].is_enabled = 0; counts.zoneReads = [];
  const fallback = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fallback.addInitScript(() => { localStorage.setItem('api_token', 'synthetic'); localStorage.setItem('app_locale', 'zh-CN'); localStorage.setItem('dns_selected_account', '1'); });
  const page = await fallback.newPage(); await page.goto(`${origin}${base}/dns`); await page.getByText('a2-000.test', { exact: true }).waitFor();
  assert.deepEqual(counts.zoneReads, [2], 'disabled saved binding must fall back without fetching unavailable accounts'); assert.equal(await page.evaluate(() => localStorage.getItem('dns_selected_account')), '2');
  await fallback.close(); accounts[0].is_enabled = 1; console.log('PASS disabled saved Account fallback');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); rmSync(dist, { recursive: true, force: true }); }
