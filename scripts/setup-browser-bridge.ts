import { resolve } from 'node:path';

const endpoint = normalizeHttpEndpoint(process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:8081');
const token = process.env.CONTROL_PLANE_TOKEN?.trim();
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (token) headers.authorization = `Bearer ${token}`;

const health = await fetch(`${endpoint}/health`, { headers }).catch(() => undefined);
if (!health?.ok) {
  throw new Error(`控制面未运行或鉴权失败：${endpoint}。请先执行 npm run start:control-plane。`);
}

const listed = await fetch(`${endpoint}/api/browsers`, { headers });
if (!listed.ok) throw new Error(`读取浏览器池失败：HTTP ${listed.status}`);
const current = await listed.json() as { items?: Array<{ id: string; name: string; mode: string; state: string }> };
let bridge = current.items?.find((item) => item.name === 'local-chrome' && item.mode === 'bridge');

if (!bridge) {
  const created = await fetch(`${endpoint}/api/browsers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'local-chrome', engine: 'chromium', mode: 'bridge', start: false }),
  });
  if (!created.ok) throw new Error(`创建 Bridge 实例失败：HTTP ${created.status} ${await created.text()}`);
  bridge = await created.json() as { id: string; name: string; mode: string; state: string };
}

const wsEndpoint = endpoint.replace(/^http/, 'ws');
console.log(JSON.stringify({
  extensionDirectory: resolve(process.cwd(), 'browser-bridge-extension'),
  endpoint: wsEndpoint,
  browserId: bridge.id,
  tokenRequired: Boolean(token),
  state: bridge.state,
}, null, 2));
console.log('\n打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序，然后把以上 endpoint、browserId 和 Token 填入扩展。');

function normalizeHttpEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('CONTROL_PLANE_URL 必须是无凭据的 localhost/127.0.0.1 HTTP(S) 地址');
  }
  return url.toString().replace(/\/$/, '');
}
