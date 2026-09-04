import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SiteBinding {
  sitePattern: string; // 例如 "*.taobao.com", "s.taobao.com", "*.weibo.com"
  profileId: string;   // 绑定的已登录专有 Profile ID
  label?: string | undefined;      // 描述备注，例如 "淘宝主力买家号"
  updatedAt: string;
}

export class SiteBindingStore {
  private readonly filePath: string;
  private bindings: Map<string, SiteBinding> = new Map();

  constructor(rootDir = 'data') {
    this.filePath = join(rootDir, 'site_bindings.json');
  }

  public async init(): Promise<void> {
    if (existsSync(this.filePath)) {
      try {
        const raw = await readFile(this.filePath, 'utf-8');
        const list: SiteBinding[] = JSON.parse(raw);
        for (const item of list) {
          this.bindings.set(item.sitePattern.toLowerCase(), item);
        }
      } catch (_) {
        this.bindings.clear();
      }
    }
  }

  public async bind(sitePattern: string, profileId: string, label?: string): Promise<SiteBinding> {
    const pattern = sitePattern.trim().toLowerCase();
    const binding: SiteBinding = {
      sitePattern: pattern,
      profileId: profileId.trim(),
      ...(label?.trim() ? { label: label.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(pattern, binding);
    await this.save();
    return binding;
  }

  public async unbind(sitePattern: string): Promise<boolean> {
    const pattern = sitePattern.trim().toLowerCase();
    const removed = this.bindings.delete(pattern);
    if (removed) {
      await this.save();
    }
    return removed;
  }

  public list(): SiteBinding[] {
    return Array.from(this.bindings.values());
  }

  /**
   * 根据目标 URL 自动解析应该挂载哪个专属的已登录 Profile
   */
  public resolveProfileForUrl(urlStr: string): string | undefined {
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();

      // 1. 精确匹配 (如 "s.taobao.com")
      if (this.bindings.has(host)) {
        return this.bindings.get(host)!.profileId;
      }

      // 2. 通配符匹配 (如 "*.taobao.com")
      for (const [pattern, binding] of this.bindings.entries()) {
        if (pattern.startsWith('*.')) {
          const rootDomain = pattern.slice(2);
          if (host === rootDomain || host.endsWith('.' + rootDomain)) {
            return binding.profileId;
          }
        }
      }
    } catch (_) {}
    return undefined;
  }

  private async save(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });
    const data = Array.from(this.bindings.values());
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
