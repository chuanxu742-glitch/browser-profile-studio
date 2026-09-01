import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BrowserEngineType } from './types.js';

interface PlaywrightBrowserRegistry {
  readonly browsers?: ReadonlyArray<{ readonly name?: string; readonly browserVersion?: string }>;
}

export interface ManagedBrowserIdentity {
  readonly engine: BrowserEngineType;
  readonly fullVersion: string;
  readonly majorVersion: string;
}

const identities = loadManagedBrowserIdentities();

/** The exact versions shipped by the pinned Playwright dependency. */
export function managedBrowserIdentity(engine: BrowserEngineType): ManagedBrowserIdentity {
  return identities[engine];
}

export function browserVersionFromUserAgent(userAgent: string, engine: BrowserEngineType): string | undefined {
  const expression = engine === 'firefox' ? /Firefox\/([0-9]+(?:\.[0-9]+){0,3})/ : /(?:Chrome|Chromium)\/([0-9]+(?:\.[0-9]+){0,3})/;
  return userAgent.match(expression)?.[1];
}

function loadManagedBrowserIdentities(): Record<BrowserEngineType, ManagedBrowserIdentity> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('playwright-core/package.json');
  const registry = JSON.parse(readFileSync(join(dirname(packagePath), 'browsers.json'), 'utf8')) as PlaywrightBrowserRegistry;
  const versionFor = (engine: BrowserEngineType): ManagedBrowserIdentity => {
    const fullVersion = registry.browsers?.find((browser) => browser.name === engine)?.browserVersion;
    if (!fullVersion || !/^\d+(?:\.\d+){1,3}(?:[a-z]\d+)?$/.test(fullVersion)) {
      throw new Error(`PLAYWRIGHT_${engine.toUpperCase()}_VERSION_UNAVAILABLE`);
    }
    return { engine, fullVersion, majorVersion: fullVersion.split('.')[0]! };
  };
  return Object.freeze({ chromium: versionFor('chromium'), firefox: versionFor('firefox') });
}
