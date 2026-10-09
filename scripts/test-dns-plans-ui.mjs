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
const reset = () => {
  zones = accounts.map((account, i) => ({ id: `zone-${i + 1}`, name: `existing-${i + 1}.test`, cfAccountId: account.id, credentialId: account.credential_id, accountName: account.name, account: { id: account.account_id }, status: 'active', plan: { legacy_id: ['free', 'enterprise', 'pro'][i], name: ['Free', 'Enterprise', 'Pro'][i] } }));
  posted = undefined; delayFirst = false; failedPlans = false; getPlansCalls = 0;
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
    if (/^\/dns\/accounts\/\d+\/plans$/.test(path)) {
      getPlansCalls++;
      const id = Number(path.split('/')[3]);
      if (delayFirst && id === 1) await new Promise(resolve => setTimeout(resolve, 600));
      if (failedPlans) return json({ code: 'CF_PERMISSION', message: 'Billing Read permission missing' }, 403);
      return json({ source: 'zone', plans: [{ id: 'free', name: 'Free', can_subscribe: true }, { id: id === 2 ? 'pro' : 'enterprise', name: id === 2 ? 'Pro' : 'Enterprise', can_subscribe: true }] });
    }
    if (path === '/dns/domains' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      posted = JSON.parse(raw);
      const results = posted.names.map((name, i) => ({ name, zone_created: true, success: true, requested_plan: posted.plan, zone_id: `new-${i}`, name_servers: ['ns.example.test'], plan: { id: i < 3 ? posted.plan : 'free', name: i < 3 ? 'Enterprise' : 'Free' }, ...(i >= 3 ? { fallback: true, warning: '所选套餐不可订阅或名额不足，已使用 Free 套餐' } : {}) }));
      return json({ total: results.length, succeeded: results.length, failed: 0, fallback_count: 2, results }, 201);
    }
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
    await search.fill('  EXISTING-1.TEST\n\nexisting-3.test  \nexisting-1.test');
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 2, 'multi-line search matches either domain, ignoring blank lines and case');
    await search.fill('  \n ');
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 3, 'whitespace-only search must show all domains');
    await search.fill('');
    await select(filter, labels[1]);
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1);
    await search.fill('existing-1.test\nexisting-2.test\nexisting-3.test');
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1, 'multi-line search must preserve selected Account scope');
    await search.fill('existing-1.test\nexisting-3.test');
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 0);
    await search.fill('existing-2');
    assert.equal(await page.locator('.dns-zone-list .n-list-item').count(), 1, 'single partial search remains supported');
    await search.fill('');
    assert.equal(await page.locator('.dns-zone-list .n-tag').innerText(), 'Enterprise');
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
    await planSelect.click(); await page.locator('.n-base-select-menu:visible').getByText('Enterprise', { exact: true }).waitFor();
    await page.locator('.n-base-select-menu:visible').getByText('Enterprise', { exact: true }).click();
    await modal.locator('textarea').fill('1.test\n2.test\n3.test\n4.test\n5.test');
    await modal.getByRole('button', { name: zh.common.create, exact: true }).click();
    await page.getByText('2 个域名已使用 Free 兜底', { exact: false }).waitFor();
    assert.equal(posted.account_id, 1); assert.equal(posted.plan, 'enterprise');
    assert.equal(await page.locator('.n-modal .n-tag').filter({ hasText: /^Enterprise$/ }).count(), 3);
    assert.equal(await page.locator('.n-modal .n-tag').filter({ hasText: /^Free$/ }).count(), 2);
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
    await page.locator('.n-base-select-menu:visible').getByText('Pro', { exact: true }).waitFor();
    assert.equal(await page.locator('.n-base-select-menu:visible').getByText('Enterprise', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    failedPlans = true;
    await select(page.locator('.n-modal .n-select').nth(0), labels[2]);
    await page.getByText('Billing Read permission missing', { exact: false }).waitFor();
    await page.locator('.n-modal .n-select').nth(1).click();
    await page.locator('.n-base-select-menu:visible').getByText('Free', { exact: true }).waitFor();
    assert.equal(await page.locator('.n-base-select-menu:visible .n-base-select-option').count(), 1);
    assert(getPlansCalls >= 4);
    console.log(`PASS DNS credentials, striped options, multi-line search and plans at ${width}px (${theme})`);
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
