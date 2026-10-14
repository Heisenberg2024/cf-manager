// Desktop/mobile acceptance against synthetic HTTP/Cloudflare only; production credentials are never read.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'backend/package.json'));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ts = require('typescript');
const temporary = mkdtempSync('/private/tmp/cfm-tunnels-ui-');
const dist = resolve(temporary, 'dist'); cpSync(process.env.FRONTEND_DIST || resolve(root, 'frontend/dist'), dist, { recursive: true });
const base = readFileSync(resolve(dist, 'index.html'), 'utf8').includes('/admin/assets/') ? '/admin' : '';
const fixtureFile = resolve(temporary, 'fixture.cjs'); writeFileSync(fixtureFile, ts.transpileModule(readFileSync(resolve(root, 'shared/tests/tunnelsRules.fixture.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
const { tunnelsFixture, tunnelAccount } = require(fixtureFile);
const { TunnelResources } = require(resolve(root, 'backend/dist/services/tunnelResources.js'));
const { RulesResources } = require(resolve(root, 'backend/dist/services/rulesResources.js'));
const { ZoneDirectory } = require(resolve(root, 'backend/dist/services/zoneDirectory.js'));
const zh = JSON.parse(readFileSync(resolve(root, 'frontend/src/i18n/locales/zh-CN.json'), 'utf8'));
const baseline = process.env.BASELINE_UI === 'true';
const accounts = Array.from({ length: 20 }, (_, i) => ({ ...tunnelAccount, id: i + 1, name: `Account ${i + 1}`, account_id: `${i + 1}`.padStart(32, '0'), credential_id: i + 10 }));
let fixture, tunnels, rules, directory, failZones = false, failConfig = false, apiCalls = [], delayConfig = 0, failRules = false;
function reset() { fixture = tunnelsFixture(); directory = new ZoneDirectory(); tunnels = new TunnelResources(directory); rules = new RulesResources(directory); failZones = false; failConfig = false; apiCalls = []; delayConfig = 0; failRules = false; }
reset();
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://fixture');
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data })); };
    if (u.pathname.startsWith('/api/')) {
      const p = u.pathname.slice(4), method = req.method; let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}; apiCalls.push({ p, method });
      if (p === '/settings') return json({ platform: 'docker', version: baseline ? '2.8.2' : '2.9.0', demo_account_ids: '' });
      if (p === '/accounts') return json({ accounts, quota: [], total: accounts.length });
      if (p === '/credentials') return json(accounts.map(a => ({ id: a.credential_id, name: `Credential ${a.id}`, accounts: [] })));
      if (p === '/quota' || p.startsWith('/audit-log')) return json([]);
      if (p === '/tunnels/accounts') return json(accounts);
      if (p === '/dns/domains') { if (baseline) await Promise.all(accounts.map(a => directory.list(a, async path => { const u = new URL(path, 'https://fixture'); const rows = Array.from({ length: 100 }, (_, i) => ({ id: `z${a.id}-${i}`, name: `zone${i}.example.test`, account: { id: a.account_id } })); fixture.calls.push({ path, method: 'GET' }); await new Promise(r => setTimeout(r, 1)); const page = Number(u.searchParams.get('page') || 1); return { result: rows.slice((page - 1) * 50, page * 50), result_info: { total_pages: 2 } }; }))); return json(accounts.flatMap(a => Array.from({ length: 100 }, (_, i) => ({ id: `z${a.id}-${i}`, name: `zone${i}.example.test`, cfAccountId: a.id, accountName: a.name })))); }
      if (/\/dns\/accounts\/\d+\/domains$/.test(p)) return json({ zones: [{ id: 'z1', name: 'example.test', cfAccountId: 1, accountName: 'Account 1' }], meta: { state: 'fresh' } });
      if (p.endsWith('/zones')) { if (failZones) return json({ message: 'Synthetic Zone denied' }, 403); return json([{ id: 'z1', name: 'example.test' }]); }
      if (/\/tunnels\/accounts\/\d+\/tunnels$/.test(p)) return json((await tunnels.list(tunnelAccount, fixture.request, u.searchParams.get('refresh') === 'true')).value);
      if (p.endsWith('/config')) {
        if (delayConfig) await new Promise(r => setTimeout(r, delayConfig));
        if (failConfig) return json({ message: 'Synthetic config network failure' }, 502);
        const snapshot = await tunnels.readConfig(tunnelAccount, fixture.request, 't1');
        if (method === 'GET') return json(baseline ? snapshot.config.ingress : snapshot);
        return json(await tunnels.save(tunnelAccount, fixture.request, 't1', body));
      }
      if (p.endsWith('/connections')) return json(await tunnels.connections(tunnelAccount, fixture.request, 't1'));
      if (p.endsWith('/token')) return json({ token: 'synthetic-token' });
      if (p.includes('/rules/')) {
        const phase = p.split('/rules/')[1].split('/')[0]; fixture.ruleset.phase = phase; fixture.ruleset.kind = phase === 'http_request_redirect' ? 'root' : 'zone';
        if (method === 'GET' && failRules) return json({ message: 'Synthetic Rules denied' }, 403);
        if (method === 'GET') return json((await rules.list(tunnelAccount, fixture.request, 'z1', phase, u.searchParams.get('refresh') === 'true')).value);
        return json(await rules.mutate(tunnelAccount, fixture.request, 'z1', phase, method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update', body, p.endsWith('rule1') ? 'rule1' : undefined, body.baseline));
      }
      return json([]);
    }
    const path = u.pathname.slice(base.length); const file = resolve(dist, path.startsWith('/assets/') ? path.slice(1) : 'index.html');
    res.writeHead(200, { 'Content-Type': extname(file) === '.js' ? 'application/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html' }); res.end(readFileSync(file));
  } catch (error) { res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: { message: error.message, code: error.code || 'SYNTHETIC' } })); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`, report = []; let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) for (const dark of [false, true]) {
    reset(); const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: dark ? 'dark' : 'light' });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ dark }) => { localStorage.setItem('api_token', 'synthetic'); localStorage.setItem('app_locale', 'zh-CN'); localStorage.setItem('themeMode', dark ? 'dark' : 'light'); }, { dark });
    const started = performance.now(); await page.goto(`${origin}${base}/tunnels`); await page.getByText('existing', { exact: true }).waitFor();
    await page.waitForTimeout(80);
    const initialHeapBytes = (await (await context.newCDPSession(page)).send('Runtime.getHeapUsage')).usedSize;
    const firstMs = performance.now() - started, initialApi = apiCalls.length, initialCF = fixture.calls.length;
    if (baseline) { report.push({ width, dark, firstMs, initialApi, initialCF, initialHeapBytes, fullZoneScans: apiCalls.filter(c => c.p === '/dns/domains').length }); await context.close(); continue; }
    assert.equal(apiCalls.filter(c => c.p.startsWith('/dns/')).length, 0);
    failZones = true;
    await page.getByRole('button', { name: zh.tunnels.table.config, exact: true }).click();
    const modal = page.locator('.n-dialog').filter({ hasText: 'Catch-all' });
    await modal.getByText('已加载', { exact: true }).waitFor();
    await modal.getByText(/域名选择不可用/).waitFor();
    const services = modal.locator('input[placeholder^="原始 service"]');
    assert.equal(await services.first().inputValue(), 'ssh://192.0.2.5:22');
    const save = modal.getByRole('button', { name: '保存配置', exact: true }); assert.equal(await save.isEnabled(), false);
    await services.first().fill('bastion'); assert.equal(await save.isEnabled(), true);
    await save.click(); await page.locator('.n-dialog').filter({ hasText: '确认完整配置差异' }).getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.n-button--loading'));
    await page.waitForTimeout(80); assert.equal(fixture.configs.get('t1').config.originRequest.noTLSVerify, true); assert.equal(fixture.configs.get('t1').config.ingress[0].future.x, 1); assert.equal(fixture.configs.get('t1').config.ingress[3].service, 'http_status:503');
    assert.equal(fixture.calls.filter(c => c.method === 'PUT').length, 1); assert.equal(await save.isEnabled(), false);
    // Conflict must keep the draft and refuse a second PUT.
    await services.first().fill('hello_world'); fixture.configs.get('t1').version++;
    await save.click(); await page.locator('.n-dialog').filter({ hasText: '确认完整配置差异' }).getByRole('button', { name: '保存', exact: true }).click();
    await modal.getByText(/Remote configuration changed/).waitFor(); assert.equal(await services.first().inputValue(), 'hello_world'); assert.equal(fixture.calls.filter(c => c.method === 'PUT').length, 1);
    await modal.getByRole('button', { name: '重新读取配置', exact: true }).click(); await page.waitForTimeout(70);
    // config unchanged but version changed: refresh reconciles baseline without rewriting draft.
    assert.equal(await services.first().inputValue(), 'hello_world');
    await modal.getByRole('button', { name: '放弃草稿 / 使用远程配置', exact: true }).click(); await modal.getByRole('button', { name: '取消', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    failConfig = true; failZones = false;
    await page.getByRole('button', { name: zh.tunnels.table.config, exact: true }).click();
    await page.getByText(/Synthetic config network failure/).first().waitFor(); assert.equal(await page.locator('.n-dialog').getByRole('button', { name: '保存配置', exact: true }).isEnabled(), false);
    assert.equal(await page.locator('.n-dialog').locator('.ingress-row').count(), 0);
    failConfig = false; await page.locator('.n-dialog').getByRole('button', { name: '重新读取配置', exact: true }).click(); await page.getByText('Catch-all', { exact: false }).first().waitFor(); await page.locator('.n-dialog').getByRole('button', { name: '取消', exact: true }).click();
    // Closing a loading modal fences its delayed response.
    delayConfig = 1000; await page.getByRole('button', { name: zh.tunnels.table.config, exact: true }).click(); await page.locator('.n-dialog').getByRole('button', { name: '取消', exact: true }).click(); await page.locator('.n-dialog').waitFor({ state: 'hidden' }); await page.waitForTimeout(1100); assert.equal(await page.locator('.n-dialog').count(), 0); delayConfig = 0;
    await page.getByText(zh.tunnels.rulesEngine, { exact: true }).click();
    await page.getByRole('button', { name: zh.common.edit, exact: true }).last().waitFor();
    assert.equal(apiCalls.filter(c => c.p === '/dns/domains').length, 0); assert.equal(apiCalls.filter(c => c.p === '/dns/accounts/1/domains').length, 1);
    await page.getByRole('button', { name: zh.common.edit, exact: true }).last().click();
    const ruleModal = page.locator('.n-dialog').filter({ hasText: '完整 JSON 编辑' });
    const textarea = ruleModal.locator('textarea'); const parsed = JSON.parse(await textarea.inputValue()); parsed.description = 'edited safely';
    await textarea.fill(JSON.stringify(parsed, null, 2)); await ruleModal.getByRole('button', { name: zh.common.save, exact: true }).click(); await ruleModal.waitFor({ state: 'hidden' });
    assert.equal(fixture.ruleset.rules[0].action_parameters.origin.host, 'internal'); assert.equal(fixture.ruleset.rules[0].enabled, false); assert.equal(fixture.ruleset.rules[0].description, 'edited safely');
    // Failed non-blocking refresh keeps the confirmed rules and permits explicit retry.
    failRules = true; await page.getByRole('button', { name: '刷新规则', exact: true }).click(); await page.getByText('Synthetic Rules denied', { exact: false }).first().waitFor();
    assert.equal(await page.getByText('edited safely', { exact: true }).count(), 1);
    failRules = false; await page.getByRole('button', { name: '刷新规则', exact: true }).click(); await page.waitForTimeout(100);
    // Account phase reads must not load a new Zone directory.
    const zoneCount = apiCalls.filter(c => c.p.includes('/domains') && !c.p.includes('/rules')).length;
    const phaseSelect = page.locator('.n-base-selection').filter({ hasText: zh.tunnels.rulePhases.origin }).first();
    await phaseSelect.click(); await page.getByText(zh.tunnels.rulePhases.redirect + ' (Account)', { exact: true }).click(); await page.waitForTimeout(100);
    assert.equal(apiCalls.filter(c => c.p.includes('/domains') && !c.p.includes('/rules')).length, zoneCount);
    assert.ok(apiCalls.some(c => c.p === '/tunnels/accounts/1/rules/http_request_redirect'));
    await page.getByRole('button', { name: zh.tunnels.addRule, exact: true }).click();
    const newRule = page.locator('.n-dialog').filter({ hasText: 'Bulk Redirect List' });
    const expression = 'http.host eq "example.test" and http.request.full_uri in $redirect_list';
    await newRule.getByPlaceholder('已有 redirect list 名称', { exact: true }).fill('redirect_list');
    await newRule.getByPlaceholder(zh.tunnels.expressionPlaceholder, { exact: true }).fill(expression);
    await newRule.getByRole('button', { name: zh.common.create, exact: true }).click(); await newRule.waitFor({ state: 'hidden' });
    const createdRule = fixture.calls.findLast(c => c.method === 'POST' && c.path.includes('/rulesets'));
    assert.equal(createdRule.body.expression, expression); assert.deepEqual(createdRule.body.action_parameters, { from_list: { name: 'redirect_list', key: 'http.request.full_uri' } });
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width + 1);
    assert.deepEqual(errors, []);
    report.push({ width, dark, firstMs, initialApi, initialCF, initialHeapBytes, safetyChecks: 'pass', allZoneScans: 0, configPuts: fixture.calls.filter(c => c.method === 'PUT').length, heapBytes: (await (await context.newCDPSession(page)).send('Runtime.getHeapUsage')).usedSize });
    await page.screenshot({ path: resolve(temporary, `tunnels-${width}-${dark ? 'dark' : 'light'}.png`) }); await context.close();
  }
  writeFileSync(process.env.UI_REPORT || resolve(root, 'docs/performance-v2.9-ui.json'), JSON.stringify({ simulated: true, baseline, runtime: process.version, report }, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) { const page = browser?.contexts().at(-1)?.pages().at(-1); if (page) { await page.screenshot({ path: '/private/tmp/cfm-tunnels-ui-failure.png' }); console.error((await page.locator('body').innerText()).slice(-3800)); } throw error; }
finally { await browser?.close(); await new Promise(r => server.close(r)); rmSync(temporary, { recursive: true, force: true }); }
