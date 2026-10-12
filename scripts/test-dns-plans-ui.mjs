// Offline UI regression: built frontend, synthetic API, isolated headless browser.
// FRONTEND_DIST=/path/to/test-dist PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-plans-ui.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zh = JSON.parse(readFileSync(resolve(root, 'frontend/src/i18n/locales/zh-CN.json'), 'utf8'));
const enterpriseChoice = `${zh.dns.plans.tiers.enterprise} · 0 USD / ${zh.dns.plans.periods.monthly}`;
const freeChoice = `${zh.dns.plans.tiers.free} · 0 USD / ${zh.dns.plans.periods.monthly}`;
const dist = resolve(process.env.FRONTEND_DIST || resolve(root, 'frontend/dist'));
const index = readFileSync(resolve(dist, 'index.html'), 'utf8');
const base = index.includes('/admin/assets/') ? '/admin' : '';
const accounts = [
  { id: 1, credential_id: 10, account_id: 'a'.repeat(32) },
  { id: 2, credential_id: 10, account_id: 'b'.repeat(32) },
  { id: 3, credential_id: 20, account_id: 'a'.repeat(32) },
].map((account, i) => ({ ...account, name: ['East', 'West', 'East'][i], credential_name: "abc@mail.com's Account", is_active: 1, is_enabled: 1, enabled_features: 'dns', available_features: 'dns', is_demo: false }));
const credentials = [{ id: 10, name: 'abc@mail.com' }, { id: 20, name: 'xyz@mail.com' }];
const labels = accounts.map(account => `${account.name}｜${credentials.find(credential => credential.id === account.credential_id).name}`);
let zones;
let posted;
let delayFirst = false;
let failedPlans = false;
let getPlansCalls = 0;
let planWrites = [];
let changeMode = 'normal';
let failedZonePlans = false;
let createMode = 'normal';
let createWrites = [];
const reset = () => {
  zones = accounts.map((account, i) => ({ id: `zone-${i + 1}`, name: `existing-${i + 1}.test`, cfAccountId: account.id, credentialId: account.credential_id, accountName: account.name, account: { id: account.account_id }, status: 'active', plan: { legacy_id: ['free', 'enterprise', 'pro'][i], name: ['Free Website', 'Enterprise Website', 'Pro Website'][i] } }));
  posted = undefined; delayFirst = false; failedPlans = false; getPlansCalls = 0;
  planWrites = []; changeMode = 'normal'; failedZonePlans = false;
  createMode = 'normal';
  createWrites = [];
};
reset();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data })); };
  if (url.pathname.startsWith('/api/')) {
    const path = url.pathname.slice(4);
    if (path === '/accounts') return json({ accounts, quota: [] });
    if (path === '/settings') return json({ platform: 'docker', version: '2.5.4', demo_account_ids: '' });
    if (path === '/credentials') return json(credentials);
    if (path === '/quota') return json([]);
    if (/^\/dns\/domains\/[^/]+\/plans$/.test(path)) {
      const zone = zones.find(zone => zone.id === url.searchParams.get('zoneId') && zone.cfAccountId === Number(url.searchParams.get('accountId')));
      assert(zone, 'plan options must carry Account and Zone identity');
      if (failedZonePlans) return json({ code: 'CF_PERMISSION', message: 'Billing Read permission missing' }, 403);
      return json({ plan: { id: zone.plan.legacy_id, name: zone.plan.name }, plans: [{ id: 'free', name: 'CF_FREE', price: 0, currency: 'USD', frequency: 'monthly', can_subscribe: true }, { id: 'enterprise', name: 'CF_ENT', price: 0, currency: 'USD', frequency: 'monthly', can_subscribe: true }] });
    }
    if (path.endsWith('/plan') && req.method === 'PATCH') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const zone = zones.find(zone => zone.id === url.searchParams.get('zoneId') && zone.cfAccountId === Number(url.searchParams.get('accountId')));
      assert(zone, 'writes must carry the captured Account and Zone');
      planWrites.push({ zoneId: zone.id, accountId: zone.cfAccountId, plan: body.plan });
      const result = { success: false, zone_id: zone.id, requested_plan: body.plan, previous_plan: { id: zone.plan.legacy_id, name: zone.plan.name } };
      if (changeMode === 'uncertain') return json({ ...result, outcome_uncertain: true, error: 'Request timed out' });
      if (changeMode === 'mixed' && zone.id === 'zone-1') return json({ ...result, outcome_uncertain: true, error: 'Request timed out' });
      if (changeMode === 'mixed' && zone.id === 'zone-2') return json({ code: 'CF_NETWORK', message: 'Connection lost after request' }, 502);
      if (changeMode === 'denied' && zone.id === 'zone-1') return json({ ...result, plan: result.previous_plan, error: 'Billing Write permission missing' });
      if (changeMode === 'pending' && zone.id === 'zone-1') return json({ ...result, success: true, activation_pending: true, outcome_uncertain: false, plan: result.previous_plan, warning: 'Cloudflare accepted; activation pending' });
      zone.plan = { legacy_id: body.plan, name: body.plan === 'free' ? 'Free Website' : 'Enterprise Website' };
      return json({ ...result, success: true, plan: { id: body.plan, name: zone.plan.name } });
    }
    if (path === '/dns/domains' && req.method === 'DELETE') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { domains } = JSON.parse(raw);
      const results = domains.map(domain => ({ ...domain, success: domain.zoneId !== 'zone-1', ...(domain.zoneId === 'zone-1' ? { error: 'Active Enterprise subscription; switch to Free first' } : {}) }));
      zones = zones.filter(zone => !results.some(row => row.success && row.zoneId === zone.id && row.accountId === zone.cfAccountId));
      return json({ total: results.length, succeeded: results.filter(row => row.success).length, failed: results.filter(row => !row.success).length, results });
    }
    if (/^\/dns\/accounts\/\d+\/plans$/.test(path)) {
      getPlansCalls++;
      const id = Number(path.split('/')[3]);
      if (delayFirst && id === 1) await new Promise(resolve => setTimeout(resolve, 600));
      if (failedPlans) return json({ code: 'CF_PERMISSION', message: 'Billing Read permission missing' }, 403);
      return json({ source: 'zone', plans: [
        { id: 'free', name: 'CF_FREE', price: 0, currency: 'USD', frequency: 'monthly', can_subscribe: true },
        ...id === 2 ? [{ id: 'pro', name: 'CF_PRO_20_20', price: 25, currency: 'USD', frequency: 'monthly', can_subscribe: true }] : [
          { id: 'business', name: 'CF_BIZ', price: 250, currency: 'USD', frequency: 'monthly', can_subscribe: true },
          { id: 'pro', name: 'CF_PRO_20_20', price: 25, currency: 'USD', frequency: 'monthly', can_subscribe: true },
          { id: 'enterprise', name: 'CF_ENT', price: delayFirst && id === 1 ? 99 : 0, currency: 'USD', frequency: 'monthly', can_subscribe: true },
          { id: 'lite', name: 'CF_LITE', can_subscribe: true }, { id: 'pro_plus', name: 'CF_PRO_PLUS', can_subscribe: true },
        ],
      ] });
    }
    if (path === '/dns/domains' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      posted = JSON.parse(raw);
      const offset = createWrites.length;
      createWrites.push(structuredClone(posted));
      if (createMode === 'pending') {
        const results = posted.names.map((name, i) => ({ name, zone_created: true, success: true, activation_pending: true, requested_plan: posted.plan, zone_id: `new-${i}`, name_servers: ['ns.example.test'], plan: { id: 'free', name: 'Free' }, warning: 'Cloudflare accepted the Enterprise subscription; activation pending' }));
        return json({ total: results.length, succeeded: results.length, failed: 0, fallback_count: 0, pending_count: results.length, results }, 201);
      }
      if (createMode === 'partial') {
        if (offset === 1) return json({ code: 'CF_NETWORK', message: 'Creation response lost' }, 502);
        const results = posted.names.map((name, i) => offset + i === 0 ? { name, zone_created: true, success: false, zone_id: `new-${offset + i}`, name_servers: ['ns.example.test'], plan: { id: 'free', name: 'Free' }, error: 'Enterprise subscription rejected: HTTP 409' } : { name, zone_created: true, success: true, zone_id: `new-${offset + i}`, name_servers: ['ns.example.test'], plan: { id: 'enterprise', name: 'Enterprise' } });
        return json({ total: results.length, succeeded: results.filter(row => row.success).length, failed: results.filter(row => !row.success).length, fallback_count: 0, pending_count: 0, results }, 201);
      }
      const results = posted.names.map((name, i) => ({ name, zone_created: true, success: true, requested_plan: posted.plan, zone_id: `new-${offset + i}`, name_servers: ['ns.example.test'], plan: { id: offset + i < 3 ? posted.plan : 'free', name: offset + i < 3 ? 'Enterprise' : 'Free' }, ...(offset + i >= 3 && posted.plan !== 'free' ? { fallback: true, warning: 'Enterprise quota exceeded; using Free' } : {}) }));
      return json({ total: results.length, succeeded: results.length, failed: 0, fallback_count: results.filter(row => row.fallback).length, results }, 201);
    }
    if (/^\/dns\/accounts\/\d+\/domains$/.test(path)) return json({ zones: zones.filter(zone => zone.cfAccountId === Number(path.split('/')[3])), meta: { state: 'miss' } });
    if (path === '/dns/domains') return json(zones);
    if (path.endsWith('/records')) return json([]);
    if (path.endsWith('/settings')) return json({});
    return json([]);
  }
  const file = resolve(dist, url.pathname.slice(base.length).replace(/^\//, ''));
  const target = existsSync(file) && extname(file) ? file : resolve(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(target)] || 'application/octet-stream' });
  res.end(readFileSync(target));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const [theme, width] of [['light', 1440], ['light', 390], ['dark', 1440], ['dark', 390]]) {
    reset();
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await context.addInitScript(theme => { localStorage.setItem('app_locale', 'zh-CN'); localStorage.setItem('api_token', 'synthetic'); localStorage.setItem('dns_selected_account', '__all__'); localStorage.setItem('themeMode', theme); }, theme);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}${base}/dns`);
    await page.locator('.n-collapse-item').first().waitFor();
    assert.equal(await page.locator('.n-collapse-item').count(), 3, 'local bindings must remain separate');
    const select = async (element, text) => {
      await element.click();
      await page.locator('.n-base-select-menu:visible').getByText(text, { exact: true }).click();
      await element.getByText(text, { exact: true }).waitFor();
      await page.locator('.n-base-select-menu:visible').waitFor({ state: 'hidden' });
    };
    const waitFinished = async () => page.waitForFunction(label => [...document.querySelectorAll('.n-modal button')].some(button => button.textContent.trim() === label && !button.disabled), zh.common.close);
    const checkManualCloseOnly = async () => {
      await page.locator('.n-modal').waitFor();
      await page.mouse.click(2, 2);
      await page.keyboard.press('Escape');
      assert(await page.locator('.n-modal').isVisible(), 'mask clicks and Esc must never dismiss a domain operation');
    };
    const filter = page.locator('.page-view > .n-space .n-select').first();
    const filterBox = await filter.boundingBox();
    assert(filterBox.x + filterBox.width <= width + 1, 'account filter must not be clipped by viewport');
    await filter.click();
    for (const label of labels) await page.locator('.n-base-select-menu:visible').getByText(label, { exact: true }).waitFor();
    assert.equal(await page.locator('.n-base-select-menu:visible').getByText("abc@mail.com's Account", { exact: false }).count(), 0);
    const checkStripes = async () => {
      const rows = page.locator('.n-base-select-menu:visible .dns-account-option');
      await rows.first().waitFor();
      const stripeClasses = await rows.evaluateAll(elements => elements.map(element => element.classList.contains('dns-account-option--striped')));
      assert.deepEqual(stripeClasses, [false, true, false]);
      await rows.first().hover();
      await page.mouse.move(0, 0);
      const backgrounds = await rows.evaluateAll(elements => elements.filter(element => !element.matches('.n-base-select-option--pending, .n-base-select-option--selected')).map(element => ({ striped: element.classList.contains('dns-account-option--striped'), color: getComputedStyle(element).backgroundColor })));
      assert.notEqual(backgrounds.find(row => !row.striped).color, backgrounds.find(row => row.striped).color, 'alternating rows must have visibly different backgrounds');
    };
    await checkStripes();
    const menuBox = await page.locator('.n-base-select-menu:visible').boundingBox();
    assert(menuBox.x >= -1 && menuBox.x + menuBox.width <= width + 1, 'account menu must fit viewport');
    await page.screenshot({ path: `/private/tmp/cf-manager-dns-accounts-${theme}-${width}.png` });
    await filter.locator('input').fill('abc@mail.com');
    await page.locator('.n-base-select-menu:visible').getByText(labels[2], { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('.n-base-select-menu:visible .dns-account-option').evaluateAll(elements => elements.map(element => element.classList.contains('dns-account-option--striped'))), [false, true]);
    await filter.locator('input').fill('');
    await page.locator('.n-base-select-menu:visible').getByText(labels[2], { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.dns-zone-list .n-tag').count(), 3);
    const search = page.getByPlaceholder(zh.dns.searchDomain, { exact: true });
    await search.fill('  EXISTING-1.TEST\n\nexisting-3.test  \nexisting-1.test'); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 2, 'multi-line search matches either domain, ignoring blank lines and case');
    await search.fill('  \n '); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 3, 'whitespace-only search must show all domains');
    await search.fill(''); await page.waitForTimeout(200);
    await select(filter, labels[1]);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1);
    await search.fill('existing-1.test\nexisting-2.test\nexisting-3.test'); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1, 'multi-line search must preserve selected Account scope');
    await search.fill('existing-1.test\nexisting-3.test'); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 0);
    await search.fill('existing-2'); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1, 'single partial search remains supported');
    await search.fill(''); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dns-zone-list .n-tag').innerText(), 'Enterprise Website');
    await page.locator('.dns-zone-list .n-list-item').click();
    assert((await page.locator('.dns-right-card .n-card-header').innerText()).includes(labels[1]));
    await page.getByRole('button', { name: zh.dns.addDomain, exact: true }).first().click();
    const modal = page.locator('.n-modal');
    const accountSelect = modal.locator('.n-select').nth(0), planSelect = modal.locator('.n-select').nth(1);
    await accountSelect.click();
    await checkStripes();
    await page.keyboard.press('Escape');
    const initialPlans = page.waitForResponse(response => response.url().endsWith('/dns/accounts/1/plans'));
    await select(accountSelect, labels[0]);
    await initialPlans;
    await checkManualCloseOnly();
    await planSelect.click(); await page.locator('.n-base-select-menu:visible').getByText(enterpriseChoice, { exact: true }).waitFor();
    assert(!(await page.locator('.n-base-select-menu:visible').innerText()).includes('CF_'));
    await page.screenshot({ path: `/private/tmp/cf-manager-readable-plans-${theme}-${width}.png` });
    await page.locator('.n-base-select-menu:visible').getByText(enterpriseChoice, { exact: true }).click();
    await modal.locator('textarea').fill('1.test\n2.test\n3.test\n4.test\n5.test');
    await modal.getByRole('button', { name: zh.common.create, exact: true }).click();
    await page.getByText('2 个域名已使用 Free 兜底', { exact: false }).waitFor();
    assert.equal(createWrites[0].account_id, 1);
    assert.deepEqual(createWrites.map(row => row.plan), ['enterprise', 'enterprise', 'enterprise', 'enterprise', 'free']);
    assert.equal(await page.locator('.n-modal tbody td:nth-child(3)').getByText('Enterprise', { exact: true }).count(), 3);
    assert.equal(await page.locator('.n-modal tbody td:nth-child(3)').getByText('Free', { exact: true }).count(), 2);
    await page.screenshot({ path: `/private/tmp/cf-manager-dns-plans-${theme}-${width}.png` });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page must fit narrow viewport');
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    await page.getByRole('button', { name: zh.dns.addDomain, exact: true }).first().click();
    // An old account's late plans must never overwrite the current account's list.
    delayFirst = true;
    const firstRequest = page.waitForRequest(request => request.url().endsWith('/dns/accounts/1/plans'));
    await select(page.locator('.n-modal .n-select').nth(0), labels[0]);
    await firstRequest;
    const secondResponse = page.waitForResponse(response => response.url().endsWith('/dns/accounts/2/plans'));
    await select(page.locator('.n-modal .n-select').nth(0), labels[1]);
    await secondResponse;
    await page.waitForTimeout(750);
    await page.locator('.n-modal .n-select').nth(1).click();
    await page.locator('.n-base-select-menu:visible').getByText(`${zh.dns.plans.tiers.pro} · 25 USD / ${zh.dns.plans.periods.monthly}`, { exact: true }).waitFor();
    assert.equal(await page.locator('.n-base-select-menu:visible').getByText(`${zh.dns.plans.tiers.enterprise} · 99 USD / ${zh.dns.plans.periods.monthly}`, { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    failedPlans = true;
    await select(page.locator('.n-modal .n-select').nth(0), labels[2]);
    await page.getByText('Billing Read permission missing', { exact: false }).waitFor();
    await page.locator('.n-modal .n-select').nth(1).click();
    await page.locator('.n-base-select-menu:visible').getByText(zh.dns.plans.tiers.free, { exact: true }).waitFor();
    assert.equal(await page.locator('.n-base-select-menu:visible .n-base-select-option').count(), 4);
    await page.locator('.n-base-select-menu:visible').getByText(zh.dns.plans.tiers.enterprise, { exact: true }).waitFor();
    assert(getPlansCalls >= 4);
    await page.keyboard.press('Escape');
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    // Even failed billing reads retain Enterprise; delayed activation is pending rather than a Free fallback.
    for (const mode of ['pending', 'partial']) {
      createMode = mode;
      createWrites = [];
      await page.getByRole('button', { name: zh.dns.addDomain, exact: true }).first().click();
      await select(page.locator('.n-modal .n-select').nth(0), labels[2]);
      await page.locator('.n-modal').getByText('Billing Read permission missing', { exact: false }).waitFor();
      await select(page.locator('.n-modal .n-select').nth(1), zh.dns.plans.tiers.enterprise);
      const names = ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'];
      await page.locator('.n-modal textarea').fill(names.join('\n'));
      await checkManualCloseOnly();
      await page.locator('.n-modal').getByRole('button', { name: zh.common.create, exact: true }).click();
      await waitFinished();
      await checkManualCloseOnly();
      assert.deepEqual(createWrites.map(row => row.names[0]), names);
      assert(createWrites.every(row => row.names.length === 1 && row.plan === 'enterprise'));
      if (mode === 'pending') {
        await page.locator('.n-modal').getByText(zh.dns.plans.pendingCount.replace('{count}', '5'), { exact: false }).waitFor();
        assert.equal(await page.locator('.n-modal .n-tag').filter({ hasText: zh.dns.plans.states.pending }).count(), 5);
        assert.equal(await page.locator('.n-modal').getByText(zh.dns.plans.createdButFailed, { exact: true }).count(), 0);
      } else {
        await page.locator('.n-modal').getByText('Enterprise subscription rejected: HTTP 409', { exact: false }).waitFor();
        await page.locator('.n-modal').getByText('Creation response lost', { exact: false }).waitFor();
        assert.equal(await page.locator('.n-modal tbody td:nth-child(3)').getByText('Enterprise', { exact: true }).count(), 3);
        await page.locator('.n-modal').getByText(zh.dns.resultSummary.replace('{total}', '5').replace('{succeeded}', '3').replace('{failed}', '2'), { exact: true }).waitFor();
      }
      await page.screenshot({ path: `/private/tmp/cf-manager-create-enterprise-${mode}-${theme}-${width}.png` });
      await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    }
    // Single-domain Enterprise -> Free still works when Billing Read fails.
    failedZonePlans = true;
    await page.getByRole('button', { name: zh.dns.plans.change, exact: true }).click();
    await page.locator('.n-modal').getByText(zh.dns.plans.optionsFailed, { exact: true }).waitFor();
    await checkManualCloseOnly();
    const submitChange = async () => {
      const modal = page.locator('.n-modal');
      assert(await modal.getByRole('button', { name: zh.dns.plans.confirmChange, exact: true }).isDisabled(), 'billing confirmation is required');
      await modal.getByRole('checkbox').check();
      await modal.getByRole('button', { name: zh.dns.plans.confirmChange, exact: true }).click();
      await waitFinished();
      await checkManualCloseOnly();
    };
    const summary = (active, pending, failed, uncertain, skipped, total = 3) => zh.dns.plans.changeSummary.replace('{total}', String(total)).replace('{active}', String(active)).replace('{pending}', String(pending)).replace('{failed}', String(failed)).replace('{uncertain}', String(uncertain)).replace('{skipped}', String(skipped));
    await submitChange();
    assert.deepEqual(planWrites, [{ zoneId: 'zone-2', accountId: 2, plan: 'free' }]);
    assert((await page.locator('.n-modal').innerText()).includes('Enterprise'));
    assert((await page.locator('.n-modal').innerText()).includes('Free'));
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    await page.locator('.dns-right-card .n-tag').getByText('Free Website', { exact: true }).waitFor();
    failedZonePlans = false;
    await select(filter, zh.dns.allAccounts);
    await page.locator('.dns-zone-actions button').first().click();
    const openBatchPlan = async () => {
      await page.getByRole('button', { name: `${zh.dns.multi.menu} ▾`, exact: true }).click();
      await page.getByText(zh.dns.plans.batchChange, { exact: true }).click();
      await page.locator('.n-modal .n-select').waitFor();
      await page.waitForFunction(label => [...document.querySelectorAll('.n-modal .n-checkbox')].some(el => el.textContent.includes(label) && !el.classList.contains('n-checkbox--disabled')), zh.dns.plans.confirmBilling);
    };
    // Confirmed per-Zone failure is displayed while other Zones complete in order.
    changeMode = 'denied'; planWrites = [];
    await openBatchPlan();
    await select(page.locator('.n-modal .n-select'), enterpriseChoice);
    await submitChange();
    assert.deepEqual(planWrites.map(row => row.zoneId), ['zone-1', 'zone-2', 'zone-3']);
    await page.locator('.n-modal').getByText('Billing Write permission missing', { exact: true }).waitFor();
    await page.locator('.n-modal').getByText(summary(2, 0, 1, 0, 0), { exact: true }).waitFor();
    await page.screenshot({ path: `/private/tmp/cf-manager-plan-change-${theme}-${width}.png` });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    // An accepted change awaiting activation retains the actual old plan and must not stop later domains.
    changeMode = 'pending'; planWrites = [];
    await openBatchPlan();
    await select(page.locator('.n-modal .n-select'), enterpriseChoice);
    await submitChange();
    assert.deepEqual(planWrites.map(row => row.zoneId), ['zone-1', 'zone-2', 'zone-3']);
    await page.locator('.n-modal').getByText(summary(2, 1, 0, 0, 0), { exact: true }).waitFor();
    await page.locator('.n-modal').getByText(zh.dns.plans.states.pending, { exact: true }).waitFor();
    await page.locator('.n-modal').getByText('Cloudflare accepted; activation pending', { exact: true }).waitFor();
    assert.equal(await page.locator('.n-modal tbody tr').first().getByText('Free Website', { exact: true }).count(), 2, 'pending changes must show the old actual plan, not the requested plan');
    await page.screenshot({ path: `/private/tmp/cf-manager-plan-pending-${theme}-${width}.png` });
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    // Every unconfirmed result is retained, all later Zones execute once, and results cannot be resubmitted.
    changeMode = 'uncertain'; planWrites = [];
    await openBatchPlan();
    await select(page.locator('.n-modal .n-select'), enterpriseChoice);
    await submitChange();
    assert.deepEqual(planWrites.map(row => row.zoneId), ['zone-1', 'zone-2', 'zone-3']);
    await page.locator('.n-modal').getByText(summary(0, 0, 0, 3, 0), { exact: true }).waitFor();
    assert.equal(await page.locator('.n-modal').getByText(zh.dns.plans.states.uncertain, { exact: true }).count(), 3);
    assert.equal(await page.locator('.n-modal').getByRole('button', { name: zh.dns.plans.confirmChange, exact: true }).count(), 0);
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    // Both a structured unknown receipt and a rejected HTTP request must still allow the next Zone.
    changeMode = 'mixed'; planWrites = [];
    await openBatchPlan();
    await select(page.locator('.n-modal .n-select'), enterpriseChoice);
    await submitChange();
    assert.deepEqual(planWrites.map(row => row.zoneId), ['zone-1', 'zone-2', 'zone-3']);
    await page.locator('.n-modal').getByText(summary(1, 0, 0, 2, 0), { exact: true }).waitFor();
    await page.locator('.n-modal').getByText('Connection lost after request', { exact: false }).waitFor();
    await page.screenshot({ path: `/private/tmp/cf-manager-plan-continue-${theme}-${width}.png` });
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    // A remote Zone exposed by two credential bindings must not be submitted twice, even if it fails.
    zones.push({ ...zones.find(zone => zone.id === 'zone-1'), cfAccountId: 3, credentialId: 20, accountName: accounts[2].name });
    const refreshed = page.waitForResponse(response => response.url().includes('/domains?refresh=true'));
    await page.getByRole('button', { name: zh.common.refresh, exact: true }).first().click(); await refreshed;
    await page.locator('.dns-zone-list .n-list-item').nth(3).waitFor();
    await page.locator('.dns-zone-actions button').first().click();
    changeMode = 'mixed'; planWrites = [];
    await openBatchPlan();
    await select(page.locator('.n-modal .n-select'), enterpriseChoice);
    await submitChange();
    assert.deepEqual(planWrites.map(row => [row.zoneId, row.accountId]), [['zone-1', 1], ['zone-2', 2], ['zone-3', 3]]);
    await page.locator('.n-modal').getByText(summary(1, 0, 0, 2, 1, 4), { exact: true }).waitFor();
    await page.locator('.n-modal').getByText(zh.dns.plans.duplicateSkipped, { exact: true }).waitFor();
    assert.equal(await page.locator('.n-modal').getByRole('button', { name: zh.dns.plans.confirmChange, exact: true }).count(), 0);
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    zones = zones.filter(zone => !(zone.id === 'zone-1' && zone.cfAccountId === 3));
    const restored = page.waitForResponse(response => response.url().includes('/domains?refresh=true'));
    await page.getByRole('button', { name: zh.common.refresh, exact: true }).first().click(); await restored;
    await page.locator('.dns-zone-list .n-list-item').nth(3).waitFor({ state: 'hidden' });
    // Partial deletion retains failed selection and displays its actionable reason.
    await page.getByRole('button', { name: `${zh.dns.multi.more} ▾`, exact: true }).click();
    await page.getByText(zh.dns.multi.deleteZones, { exact: true }).click();
    await checkManualCloseOnly();
    assert(await page.locator('.n-modal').getByRole('button', { name: zh.common.delete, exact: true }).isDisabled());
    await page.locator('.n-modal').getByRole('checkbox').check();
    await page.locator('.n-modal').getByRole('button', { name: zh.common.delete, exact: true }).click();
    await waitFinished();
    await checkManualCloseOnly();
    await page.screenshot({ path: `/private/tmp/cf-manager-delete-panel-${theme}-${width}.png` });
    await page.locator('.n-modal').getByText('Active Enterprise subscription; switch to Free first', { exact: true }).waitFor();
    await page.locator('.n-modal').getByRole('button', { name: zh.common.close, exact: true }).click();
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1);
    assert.equal(await page.locator('.dns-zone-list .n-checkbox--checked').count(), 1);
    console.log(`PASS readable plans, uniform operation panels, manual-only close, independent results and partial deletion at ${width}px (${theme})`);
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
