import { describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserSession,
} from '../../src/browser/browser-session.js';
import { getAutomationPolicy } from '../../src/browser/automation-policy.js';
import type { FirefoxContextLike, FirefoxLauncherLike, FirefoxPageLike } from '../../src/browser/firefox-launcher.js';
import { ChallengeDetector } from '../../src/challenge/detector.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { DirectScheduler } from '../../src/input/direct-scheduler.js';

class FakePage {
  private currentUrl = 'about:blank';
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  public gotoCalls = 0;
  public bringToFrontCalls = 0;

  url(): string { return this.currentUrl; }
  title(): Promise<string> { return Promise.resolve('Fixture'); }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  locator(): never {
    // The lifecycle test does not snapshot; challenge detection's empty body
    // fallback exercises its safe exception path.
    throw new Error('no locator in lifecycle fake');
  }
  async goto(url: string): Promise<void> {
    this.gotoCalls += 1;
    this.currentUrl = url;
    this.emit('framenavigated');
  }
  async screenshot(): Promise<Buffer> { return Buffer.from('fixture-png'); }
  async close(): Promise<void> { return undefined; }
  async bringToFront(): Promise<void> {
    this.bringToFrontCalls += 1;
  }
}

class ExtractingFakePage extends FakePage {
  public constructor(private readonly extractionResult: unknown) {
    super();
  }

  async evaluate(_expression: unknown, _arg?: unknown): Promise<unknown> {
    return this.extractionResult;
  }
}

class FakeContext implements FirefoxContextLike {
  public readonly page: FakePage;
  public readonly addedCookies: Array<Record<string, unknown>> = [];
  private cookieJar: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }> = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  public constructor(page: FakePage) { this.page = page; }
  pages(): FirefoxPageLike[] { return [this.page as unknown as FirefoxPageLike]; }
  async close(): Promise<void> { return undefined; }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  async route(): Promise<void> { return undefined; }
  async addCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    this.addedCookies.push(...cookies);
  }
  async cookies(): Promise<typeof this.cookieJar> { return this.cookieJar; }
  setCookies(cookies: typeof this.cookieJar): void { this.cookieJar = cookies; }
}

class TabLocator {
  public constructor(private readonly page: TabPage, private readonly selector: string) {}

  async count(): Promise<number> { return this.selector === 'button' ? 1 : 0; }
  nth(): TabLocator { return this; }
  async isVisible(): Promise<boolean> { return true; }
  async isEnabled(): Promise<boolean> { return true; }
  async isEditable(): Promise<boolean> { return false; }
  async isChecked(): Promise<boolean> { return false; }
  async getAttribute(name: string): Promise<string | null> {
    if (this.selector !== 'button') return null;
    if (name === 'role') return 'button';
    if (name === 'type') return 'button';
    return null;
  }
  async innerText(): Promise<string> {
    return this.selector === 'body' ? '' : `Button ${this.page.url()}`;
  }
  async textContent(): Promise<string> { return this.innerText(); }
  async click(): Promise<void> { return undefined; }
  async boundingBox(): Promise<null> { return null; }
}

class TabPage {
  private currentUrl: string;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  public closed = false;

  public constructor(url = 'about:blank') { this.currentUrl = url; }
  url(): string { return this.currentUrl; }
  title(): Promise<string> { return Promise.resolve(`Title ${this.currentUrl}`); }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  locator(selector: string): TabLocator { return new TabLocator(this, selector); }
  async goto(url: string): Promise<void> {
    this.currentUrl = url;
    this.emit('framenavigated');
  }
  async close(): Promise<void> { this.closed = true; }
}

class TabContext implements FirefoxContextLike {
  private readonly pageList: TabPage[];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  public constructor(main: TabPage) { this.pageList = [main]; }
  pages(): FirefoxPageLike[] { return this.pageList as unknown as FirefoxPageLike[]; }
  async newPage(): Promise<FirefoxPageLike> {
    const page = new TabPage();
    this.pageList.push(page);
    this.emit('page', page);
    return page as unknown as FirefoxPageLike;
  }
  async close(): Promise<void> { return undefined; }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  async route(): Promise<void> { return undefined; }
}
async function flushAsyncEvent(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}


describe('BrowserSession lifecycle', () => {
  it('rejects managed fingerprint injection into an externally versioned CDP browser', async () => {
    const session = new BrowserSession({
      headless: true,
      engine: 'chromium',
      cdpEndpoint: 'http://127.0.0.1:9222',
      fingerprint: true,
      launcher: {
        launchPersistentContext: async () => new FakeContext(new FakePage()),
        connectOverCDP: async () => new FakeContext(new FakePage()),
      } as FirefoxLauncherLike,
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await expect(session.start()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects a standalone custom User-Agent without a managed fingerprint profile', async () => {
    const session = new BrowserSession({
      headless: true,
      userAgent: 'Mozilla/5.0 Firefox/153.0',
      fingerprint: false,
      launcher: { launchPersistentContext: async () => new FakeContext(new FakePage()) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });
    await expect(session.start()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('loads saved cookies into the browser and persists the final cookie jar on stop', async () => {
    const context = new FakeContext(new FakePage());
    let persisted: unknown;
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => context },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
      initialCookies: [
        { name: 'session', value: 'before', domain: '.example.com', path: '/', secure: true },
      ],
      onCookiesPersist: (cookies) => { persisted = cookies; },
    });

    await session.start();
    expect(context.addedCookies).toMatchObject([
      { name: 'session', value: 'before', domain: '.example.com', path: '/', secure: true },
    ]);
    context.setCookies([
      {
        name: 'session',
        value: 'after',
        domain: '.example.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    await session.stop();
    expect(persisted).toMatchObject([
      {
        name: 'session',
        value: 'after',
        domain: '.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  });

  it('starts with a persistent-context launcher and pauses on a fixture challenge', async () => {
    const page = new FakePage();
    const context = new FakeContext(page);
    const launcher: FirefoxLauncherLike = {
      launchPersistentContext: async () => context,
    };
    const session = new BrowserSession({
      headless: true,
      launcher,
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    expect(session.status().state).toBe('READY');
    await session.open('https://fixture.test/normal');
    expect(session.status().state).toBe('READY');
    await expect(session.open('https://challenges.cloudflare.com/fixture')).rejects.toMatchObject({ code: 'SESSION_PAUSED_CHALLENGE' });
    expect(session.status().state).toBe('PAUSED_CHALLENGE');
    expect((await session.challengeStatus()).detected).toBe(true);
    expect((await session.wait(50)).waitedMs).toBeGreaterThanOrEqual(40);
    expect(session.status().state).toBe('PAUSED_CHALLENGE');
    const takeover = await session.reopenHeaded();
    expect(takeover.state).toBe('HUMAN_TAKEOVER');
    expect(takeover.headless).toBe(false);
    await session.stop();
    expect(session.status().state).toBe('STOPPED');
    expect((await session.stop()).state).toBe('STOPPED');
  });
  it('brings headed pages to the foreground after launch', async () => {
    const page = new FakePage();
    const session = new BrowserSession({
      headless: false,
      launcher: {
        launchPersistentContext: async () => new FakeContext(page),
      },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });
    try {
      await session.start();
      expect(page.bringToFrontCalls).toBe(1);
    } finally {
      await session.stop();
    }
  });
  it('restores all open tabs and the active tab across headed reopen', async () => {
    const main = new TabPage();
    const replacementMain = new TabPage();
    const contexts = [new TabContext(main), new TabContext(replacementMain)];
    let launches = 0;
    const session = new BrowserSession({
      headless: true,
      launcher: {
        launchPersistentContext: async () => contexts[launches++] ?? new TabContext(new TabPage()),
      },
      detector: new ChallengeDetector({ additionalUrlPatterns: [/force/u] }),
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      await session.open('https://fixture.test/main');
      const popup = new TabPage('https://fixture.test/popup');
      contexts[0]?.emit('page', popup);
      await flushAsyncEvent();
      const tabs = await session.listTabs();
      const popupTab = tabs.find((tab) => !tab.isMain);
      expect(popupTab).toBeDefined();
      if (!popupTab) throw new Error('popup fixture was not registered');
      await session.switchTab(popupTab.tabId);

      await expect(session.open('https://fixture.test/force')).rejects.toMatchObject({
        code: 'SESSION_PAUSED_CHALLENGE',
      });
      expect(session.status().state).toBe('PAUSED_CHALLENGE');

      const reopened = await session.reopenHeaded();
      expect(reopened.state).toBe('HUMAN_TAKEOVER');
      expect(reopened.headless).toBe(false);
      const restored = await session.listTabs();
      expect(restored).toHaveLength(2);
      expect(restored.find((tab) => tab.isMain)?.url).toBe('https://fixture.test/main');
      expect(restored.find((tab) => !tab.isMain)?.url).toBe('https://fixture.test/force');
      expect(restored.find((tab) => tab.tabId === reopened.tabId)?.url).toBe('https://fixture.test/force');
    } finally {
      await session.stop();
    }
  });


  it('keeps an explicitly enabled named profile across stop and a new session', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'browser-session-persistent-profile-'));
    const profileRoot = join(workRoot, 'profiles');
    const launcher: FirefoxLauncherLike = {
      launchPersistentContext: async () => new FakeContext(new FakePage()),
    };
    const options = {
      headless: true,
      profileRoot,
      profileName: 'account-a',
      persistentProfile: true,
      launcher,
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    } as const;

    try {
      const first = new BrowserSession(options);
      await first.start();
      expect(first.status()).toMatchObject({ profileName: 'account-a', profilePersistent: true });
      expect(first.profileDirectory).toBe(join(profileRoot, 'account-a'));
      await expect(access(first.profileDirectory)).resolves.toBeUndefined();
      await first.stop();
      await expect(access(first.profileDirectory)).resolves.toBeUndefined();

      const second = new BrowserSession(options);
      await second.start();
      expect(second.profileDirectory).toBe(first.profileDirectory);
      await second.stop();
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('serializes a concurrent stop with startup and can restart after stopping', async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launcher: FirefoxLauncherLike = {
      launchPersistentContext: async () => {
        await launchGate;
        return new FakeContext(new FakePage());
      },
    };
    const session = new BrowserSession({
      headless: true,
      launcher,
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    const starting = session.start();
    const stopping = session.stop('concurrent-start-stop');
    releaseLaunch();

    await expect(starting).resolves.toMatchObject({ state: 'READY' });
    await expect(stopping).resolves.toMatchObject({ state: 'STOPPED' });

    const restarted = await session.start();
    expect(restarted.state).toBe('READY');
    expect(restarted.control).toMatchObject({ owner: 'agent', hardStop: false });
    await session.stop();
  });

  it('removes profile and artifact directories when launch fails', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'browser-session-launch-failure-'));
    const profileRoot = join(workRoot, 'profiles');
    const artifactsRoot = join(workRoot, 'artifacts');
    const session = new BrowserSession({
      headless: true,
      profileRoot,
      artifactsRoot,
      launcher: {
        launchPersistentContext: async () => { throw new Error('spawn C:\\private\\firefox.exe UNKNOWN'); },
      },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    try {
      await expect(session.start()).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_FAILED',
        message: 'Firefox could not be started',
      });
      await expect(access(session.profileDirectory)).rejects.toBeDefined();
      await expect(access(join(artifactsRoot, session.sessionId))).rejects.toBeDefined();
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('fails startup closed when the resource policy route cannot be installed', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'browser-session-route-failure-'));
    const page = new FakePage();
    const context = new FakeContext(page);
    context.route = async () => { throw new Error('route registration failed'); };
    const session = new BrowserSession({
      headless: true,
      profileRoot: join(workRoot, 'profiles'),
      artifactsRoot: join(workRoot, 'artifacts'),
      launcher: { launchPersistentContext: async () => context },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    try {
      await expect(session.start()).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_FAILED',
        message: 'Firefox could not be started',
      });
      await expect(access(session.profileDirectory)).rejects.toBeDefined();
      await expect(access(join(workRoot, 'artifacts', session.sessionId))).rejects.toBeDefined();
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('returns screenshot bytes without a host path and deletes the artifact on stop', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'browser-session-artifact-'));
    const artifactsRoot = join(workRoot, 'artifacts');
    const page = new FakePage();
    const session = new BrowserSession({
      headless: true,
      profileRoot: join(workRoot, 'profiles'),
      artifactsRoot,
      launcher: { launchPersistentContext: async () => new FakeContext(page) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    try {
      await session.start();
      const screenshot = await session.screenshot();
      expect(screenshot).toEqual({
        artifactRef: expect.stringMatching(/^art_/),
        image: {
          data: Buffer.from('fixture-png').toString('base64'),
          mimeType: 'image/png',
        },
      });
      expect(JSON.stringify(screenshot)).not.toContain(workRoot);
      const artifactPath = join(artifactsRoot, session.sessionId, `${screenshot.artifactRef}.png`);
      await expect(access(artifactPath)).resolves.toBeUndefined();
      await session.stop();
      await expect(access(join(artifactsRoot, session.sessionId))).rejects.toBeDefined();
    } finally {
      await session.stop().catch(() => undefined);
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('counts waiting actions when enforcing the bounded session queue', async () => {
    const page = new FakePage();
    const session = new BrowserSession({
      headless: true,
      maxQueue: 1,
      launcher: { launchPersistentContext: async () => new FakeContext(page) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      const first = session.wait(50);
      expect(session.status().queueDepth).toBe(1);
      await expect(session.wait(50)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
      await first;
      expect(session.status().queueDepth).toBe(0);
    } finally {
      await session.stop();
    }
  });

  it('deduplicates writes by actionId and rejects conflicts or stale revisions before navigation', async () => {
    const page = new FakePage();
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => new FakeContext(page) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });
    const actionId = '2d85c46c-9e34-4a9d-a673-146ab83c0f3a';

    await session.start();
    try {
      const firstPromise = session.open('https://fixture.test/orders', {
        actionId,
        expectedPageRevision: 0,
      });
      const duplicatePromise = session.open('https://fixture.test/orders', {
        actionId,
        expectedPageRevision: 0,
      });
      const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);

      expect(duplicate).toEqual(first);
      expect(page.gotoCalls).toBe(1);
      await expect(session.open('https://fixture.test/other', {
        actionId,
        expectedPageRevision: first.pageGeneration,
      })).rejects.toMatchObject({ code: 'ACTION_ID_CONFLICT' });
      await expect(session.open('https://fixture.test/stale', {
        actionId: '873e4d46-1d37-424a-a4d2-5a963cd17c51',
        expectedPageRevision: 0,
      })).rejects.toMatchObject({
        code: 'PAGE_REVISION_MISMATCH',
        retryable: true,
      });
      expect(page.gotoCalls).toBe(1);
    } finally {
      await session.stop();
    }
  });

  it('surfaces bounded interrupt summaries for blocked browser-native events', async () => {
    const page = new FakePage();
    const context = new FakeContext(page);
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => context },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });
    let popupCloses = 0;
    let dialogDismisses = 0;
    let downloadCancels = 0;
    const popup = { close: async () => { popupCloses += 1; } };

    await session.start();
    page.emit('popup', popup);
    context.emit('page', popup);
    page.emit('dialog', { dismiss: async () => { dialogDismisses += 1; } });
    page.emit('download', { cancel: async () => { downloadCancels += 1; } });
    await Promise.resolve();

    const status = session.status();
    expect(status.interrupts.total).toBe(3);
    expect(status.interrupts.recent.map((event) => event.type)).toEqual([
      'POPUP_BLOCKED',
      'DIALOG_BLOCKED',
      'DOWNLOAD_BLOCKED',
    ]);
    expect(popupCloses).toBe(1);
    expect(dialogDismisses).toBe(1);
    expect(downloadCancels).toBe(1);
    for (let index = 0; index < 20; index += 1) {
      page.emit('dialog', { dismiss: async () => undefined });
    }
    const bounded = session.status().interrupts;
    expect(bounded.total).toBe(23);
    expect(bounded.recent).toHaveLength(16);
    expect(bounded.recent.at(-1)?.sequence).toBe(23);
    await session.stop();
  });

  it('maps an oversized page_extract result to non-retryable RESOURCE_EXHAUSTED', async () => {
    const page = new ExtractingFakePage([{ title: 'x'.repeat(1_100_000) }]);
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => new FakeContext(page) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      await expect(session.extract({
        containerSelector: '.card',
        fields: [{ name: 'title' }],
      })).rejects.toMatchObject({
        code: 'RESOURCE_EXHAUSTED',
        retryable: false,
      });
      expect(session.status().state).toBe('READY');
    } finally {
      await session.stop();
    }
  });

  it('uses a one-time lease for manual handoff and hard-stops automation meanwhile', async () => {
    const pages = [new FakePage(), new FakePage()];
    let launches = 0;
    const session = new BrowserSession({
      headless: true,
      launcher: {
        launchPersistentContext: async () => new FakeContext(pages[launches++] ?? new FakePage()),
      },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      await session.open('https://fixture.test/manual-review');
      const grant = await session.handoff({ ttlMs: 60_000, reason: 'operator_review' });
      expect(grant.state).toBe('USER_CONTROLLED');
      expect(grant.headless).toBe(false);
      expect(grant.leaseToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(grant.control).toMatchObject({ owner: 'user', hardStop: true, handoffState: 'ACTIVE' });
      expect(JSON.stringify(session.status())).not.toContain(grant.leaseToken);
      await expect(session.open('https://fixture.test/blocked')).rejects.toMatchObject({
        code: 'USER_CONTROL_HARD_STOP',
      });
      await expect(session.takeover('x'.repeat(43), true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

      const resumed = await session.takeover(grant.leaseToken, true);
      expect(resumed.state).toBe('READY');
      expect(resumed.control).toMatchObject({ owner: 'agent', hardStop: false });
    } finally {
      await session.stop();
    }
  });

  it('reserves the session for a bounded workflow and blocks interleaving calls', async () => {
    const page = new FakePage();
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => new FakeContext(page) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      const running = session.workflow({
        steps: [{ op: 'wait', milliseconds: 80 }],
        maxDurationMs: 1_000,
      });
      await expect(session.open('https://fixture.test/interleaved')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      await expect(running).resolves.toMatchObject({
        ok: true,
        status: 'completed',
        completedSteps: 1,
      });
      expect(page.gotoCalls).toBe(0);
    } finally {
      await session.stop();
    }
  });

  it('releases the manager slot when cleanup succeeds but stop auditing fails', async () => {
    const manager = new SessionManager({
      maxSessions: 1,
      launcher: { launchPersistentContext: async () => new FakeContext(new FakePage()) },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
      audit: {
        record: async (event) => {
          if (event.action === 'browser_stop') throw new Error('audit unavailable');
        },
      },
    });
    const session = await manager.start({ headless: true });

    await expect(manager.stop(session.sessionId)).rejects.toThrow('audit unavailable');
    expect(manager.size).toBe(0);
    await expect(manager.stop(session.sessionId)).resolves.toMatchObject({ state: 'STOPPED' });
  });
  it('isolates tab navigation and semantic references across popup tabs', async () => {
    const main = new TabPage();
    const context = new TabContext(main);
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => context },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      const mainSnapshot = await session.snapshot({ format: 'structured' });
      const mainSnapshotId = mainSnapshot.snapshotId;
      const mainRef = mainSnapshot.targets[0]?.ref;
      expect(mainSnapshot.tabId).toBeDefined();
      expect(mainSnapshotId).toBeDefined();
      expect(mainRef).toBeDefined();

      const popup = new TabPage('https://fixture.test/popup');
      context.emit('page', popup);
      await flushAsyncEvent();
      const tabsAfterPopup = await session.listTabs();
      expect(tabsAfterPopup).toHaveLength(2);
      const mainTab = tabsAfterPopup.find((tab) => tab.isMain);
      const popupTab = tabsAfterPopup.find((tab) => !tab.isMain);
      expect(mainTab).toBeDefined();
      expect(popupTab).toBeDefined();
      if (!mainRef || !mainSnapshotId || !mainTab || !popupTab) throw new Error('tab fixture was not registered');

      await session.switchTab(popupTab.tabId);
      await expect(session.snapshot({
        format: 'structured',
        sinceSnapshotId: mainSnapshotId,
      })).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
      await expect(session.click(mainRef)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
      const popupSnapshot = await session.snapshot({ format: 'structured' });
      const popupRef = popupSnapshot.targets[0]?.ref;
      expect(popupRef).toBeDefined();

      await session.open('https://fixture.test/popup/updated');
      const updatedTabs = await session.listTabs();
      expect(updatedTabs.find((tab) => tab.tabId === mainTab.tabId)?.url).toBe('about:blank');
      expect(updatedTabs.find((tab) => tab.tabId === popupTab.tabId)?.url).toBe('https://fixture.test/popup/updated');

      await session.switchTab(mainTab.tabId);
      await expect(session.click(mainRef, { expectedTabId: popupTab.tabId })).rejects.toMatchObject({
        code: 'PAGE_REVISION_MISMATCH',
        details: { expectedTabId: popupTab.tabId, actualTabId: mainTab.tabId },
      });
      if (!popupRef) throw new Error('popup snapshot did not issue a ref');
      await expect(session.click(popupRef)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    } finally {
      await session.stop();
    }
  });

  it('caps popup admission at the strict-policy tab ceiling and records the limit interrupt', async () => {
    const main = new TabPage();
    const context = new TabContext(main);
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => context },
      scheduler: new DirectScheduler(),
      automationPolicy: getAutomationPolicy('strict'),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      const popups = Array.from({ length: 5 }, (_, index) => new TabPage(`https://fixture.test/popup/${index}`));
      for (const popup of popups) {
        context.emit('page', popup);
        await flushAsyncEvent();
      }
      expect(await session.listTabs()).toHaveLength(5);

      const rejected = new TabPage('https://fixture.test/popup/rejected');
      context.emit('page', rejected);
      await flushAsyncEvent();
      expect(await session.listTabs()).toHaveLength(5);
      expect(rejected.closed).toBe(true);
      expect(session.status().interrupts.recent.at(-1)?.type).toBe('TAB_LIMIT_EXCEEDED');
    } finally {
      await session.stop();
    }
  });

  it('uses the standard-policy tab ceiling for ordinary sessions', async () => {
    const main = new TabPage();
    const context = new TabContext(main);
    const session = new BrowserSession({
      headless: true,
      launcher: { launchPersistentContext: async () => context },
      scheduler: new DirectScheduler(),
      urlPolicy: { assertAllowed: () => true },
    });

    await session.start();
    try {
      for (let index = 0; index < 6; index += 1) {
        context.emit('page', new TabPage(`https://fixture.test/standard/${index}`));
        await flushAsyncEvent();
      }
      expect(await session.listTabs()).toHaveLength(7);
    } finally {
      await session.stop();
    }
  });

});
