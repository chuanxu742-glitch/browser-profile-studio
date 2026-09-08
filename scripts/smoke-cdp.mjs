import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const endpoint = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const token = process.env.CDP_TOKEN;
assert(token, 'Set CDP_TOKEN');
assert.equal((await fetch(`${endpoint}/health`)).status, 200);
assert.equal((await fetch(`${endpoint}/json/version`)).status, 401);
const options = { headers: { Authorization: `Bearer ${token}` }, noDefaults: true };
let browser = await chromium.connectOverCDP(endpoint, options);
try {
  const context = browser.contexts()[0];
  if (process.env.CDP_SMOKE_PHASE === 'write') {
    await context.addCookies([{ name: 'cdp-restart-smoke', value: 'persisted', domain: 'cdp-smoke.test', path: '/', expires: Date.now() / 1000 + 3600 }]);
  } else if (process.env.CDP_SMOKE_PHASE === 'read') {
    assert.equal((await context.cookies('https://cdp-smoke.test')).find(c => c.name === 'cdp-restart-smoke')?.value, 'persisted');
  }
  const page = await browser.contexts()[0].newPage();
  await page.goto('data:text/html,<input><button onclick="document.title=document.querySelector(\'input\').value">Save</button>');
  await page.locator('input').fill('cdp-smoke-passed');
  await page.getByRole('button').click();
  assert.equal(await page.title(), 'cdp-smoke-passed');
  assert((await page.screenshot()).byteLength > 100);
  await page.close();
} finally { await browser.close(); }
browser = await chromium.connectOverCDP(endpoint, options);
await browser.close();
console.log('CDP authentication, page interaction, screenshot and reconnect passed');
