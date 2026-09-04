import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteBindingStore } from '../../src/profile/site-binding.js';

describe('SiteBindingStore', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('persists exact and wildcard profile bindings', async () => {
    root = await mkdtemp(join(tmpdir(), 'site-bindings-'));
    const store = new SiteBindingStore(root);
    await store.init();

    await store.bind('*.example.com', 'profile-wildcard');
    await store.bind('login.example.com', 'profile-login');

    expect(store.resolveProfileForUrl('https://shop.example.com/item')).toBe('profile-wildcard');
    expect(store.resolveProfileForUrl('https://login.example.com/')).toBe('profile-login');
    expect(store.resolveProfileForUrl('https://example.net/')).toBeUndefined();

    const restored = new SiteBindingStore(root);
    await restored.init();
    expect(restored.resolveProfileForUrl('https://example.com/')).toBe('profile-wildcard');

    await restored.unbind('*.example.com');
    expect(restored.resolveProfileForUrl('https://shop.example.com/item')).toBeUndefined();
  });
});
