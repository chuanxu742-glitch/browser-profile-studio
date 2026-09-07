import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9222', {
  headers: { Authorization: `Bearer ${process.env.CDP_TOKEN ?? ''}` },
  noDefaults: true,
});
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(process.env.TARGET_URL ?? 'https://example.com');
  console.log(await page.title());
  await page.close();
} finally {
  await browser.close(); // Disconnects this CDP client; the service owns the browser.
}
