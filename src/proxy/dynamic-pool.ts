/**
 * Dynamic Proxy IP Pool & API Extractor Adapter.
 * Supports BrightData, Oxylabs, IPRoyal, Zhima, Jiguang and general HTTP API endpoints.
 */

export interface DynamicProxyConfig {
  apiUrl: string;
  autoRefreshOnStart?: boolean;
  lastExtractedProxy?: string;
  lastRefreshTime?: number;
}

export async function fetchProxyFromApi(apiUrl: string, timeoutMs = 8000): Promise<{ proxy: string; format: string }> {
  if (!apiUrl) throw new Error('Proxy API URL is empty');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(apiUrl, { signal: controller.signal });
    const text = (await res.text()).trim();

    if (!res.ok) {
      throw new Error(`API returned HTTP ${res.status}: ${text.slice(0, 100)}`);
    }

    // 尝试解析 JSON 格式 (如 { code: 0, data: [{ ip: '...', port: 8080 }] })
    try {
      const json = JSON.parse(text);
      if (json.data && Array.isArray(json.data) && json.data.length > 0) {
        const item = json.data[0];
        const host = item.ip || item.host;
        const port = item.port;
        if (host && port) {
          return { proxy: `${item.protocol || 'http'}://${host}:${port}`, format: 'json' };
        }
      }
    } catch (_) {}

    // 解析纯文本多行格式 (如 123.45.67.89:8888 或 socks5://user:pass@123.45.67.89:8888)
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      let first = lines[0]!;
      if (!first.includes('://')) {
        first = `http://${first}`;
      }
      return { proxy: first, format: 'text' };
    }

    throw new Error('No valid proxy IP extracted from API response');
  } finally {
    clearTimeout(timer);
  }
}
