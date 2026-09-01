import { describe, expect, it } from 'vitest';

import {
  TargetRegistry,
  TargetRegistryError,
  type RegistryLocatorLike,
  type RegistryPageLike,
} from '../../src/browser/target-registry.js';

type ElementData = {
  tag: string;
  role?: string;
  name?: string;
  accessibleName?: string;
  type?: string;
  id?: string;
  for?: string;
  testId?: string;
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  text?: string;
};

class FakeLocator implements RegistryLocatorLike {
  public constructor(private readonly entries: ElementData[]) {}

  count(): Promise<number> { return Promise.resolve(this.entries.length); }
  nth(index: number): RegistryLocatorLike { return new FakeLocator([this.entries[index] as ElementData]); }
  click(): Promise<void> { return Promise.resolve(); }
  async getAttribute(name: string): Promise<string | null> {
    const entry = this.entries[0];
    if (!entry) return null;
    const value: Record<string, string | undefined> = {
      role: entry.role,
      type: entry.type,
      id: entry.id,
      for: entry.for,
      'data-testid': entry.testId,
      'data-semantic-tag': entry.tag,
      name: entry.name,
    };
    return value[name] ?? null;
  }
  textContent(): Promise<string | null> { return Promise.resolve(this.entries[0]?.text ?? null); }
  isVisible(): Promise<boolean> { return Promise.resolve(this.entries[0]?.visible ?? true); }
  isEnabled(): Promise<boolean> { return Promise.resolve(this.entries[0]?.enabled ?? true); }
  isEditable(): Promise<boolean> { return Promise.resolve(this.entries[0]?.editable ?? false); }
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return Promise.resolve({ x: 0, y: 0, width: 100, height: 30 });
  }
}

class FakePage implements RegistryPageLike {
  public constructor(public readonly entries: ElementData[]) {}
  locator(selector: string): RegistryLocatorLike {
    if (selector === 'button') return new FakeLocator(this.entries.filter((entry) => entry.tag === 'button'));
    if (selector === 'input') return new FakeLocator(this.entries.filter((entry) => entry.tag === 'input'));
    if (selector === 'label[for]') return new FakeLocator(this.entries.filter((entry) => entry.tag === 'label' && entry.for));
    if (selector === 'body') return new FakeLocator([]);
    if (selector.startsWith('[role]')) return new FakeLocator(this.entries.filter((entry) => entry.role !== undefined && !['button', 'input'].includes(entry.tag)));
    if (selector.startsWith('[contenteditable')) return new FakeLocator([]);
    return new FakeLocator([]);
  }
  getByRole(role: string, options?: { name?: string; exact?: boolean }): RegistryLocatorLike {
    const matches = this.entries.filter((entry) => entry.role === role &&
      (options?.name === undefined || (entry.accessibleName ?? entry.name) === options.name));
    return new FakeLocator(matches);
  }
  getByTestId(testId: string): RegistryLocatorLike {
    return new FakeLocator(this.entries.filter((entry) => entry.testId === testId));
  }
}

describe('TargetRegistry', () => {
  it('creates semantic refs and resolves them with fresh actionability checks', async () => {
    const entry: ElementData = { tag: 'button', role: 'button', name: 'Save', visible: true, enabled: true };
    const locator = new FakeLocator([entry]);
    const registry = new TargetRegistry({ generation: 2, now: () => 100 });
    const ref = registry.register({ role: 'button', name: 'Save', exact: true }, locator, {
      role: 'button', name: 'Save', tag: 'button', visible: true, enabled: true,
    });
    const result = await registry.resolve(ref, { generation: 2 });
    expect(result.metadata.name).toBe('Save');
    expect(result.boundingBox?.width).toBe(100);
  });

  it('invalidates refs on page generation changes', async () => {
    const registry = new TargetRegistry({ generation: 1 });
    const locator = new FakeLocator([{ tag: 'button', role: 'button', name: 'Save' }]);
    const ref = registry.register({ role: 'button', name: 'Save' }, locator, { role: 'button', name: 'Save', tag: 'button' });
    registry.setGeneration(2);
    await expect(registry.resolve(ref, { generation: 2 })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
  });

  it('rejects ambiguous semantic matches instead of selecting arbitrarily', async () => {
    const registry = new TargetRegistry();
    const locator = new FakeLocator([
      { tag: 'button', role: 'button', name: 'Save' },
      { tag: 'button', role: 'button', name: 'Save' },
    ]);
    const ref = registry.register({ role: 'button', name: 'Save' }, locator, { role: 'button', name: 'Save', tag: 'button' });
    await expect(registry.resolve(ref)).rejects.toMatchObject({ code: 'TARGET_AMBIGUOUS' });
    expect(new TargetRegistryError('TARGET_NOT_FOUND', 'x').code).toBe('TARGET_NOT_FOUND');
  });

  it('keeps a unique test-id strategy when role and name are ambiguous', async () => {
    const page = new FakePage([
      { tag: 'button', role: 'button', name: 'Save', text: 'Save', testId: 'save-primary' },
      { tag: 'button', role: 'button', name: 'Save', text: 'Save', testId: 'save-secondary' },
    ]);
    const registry = new TargetRegistry({ generation: 3 });
    const snapshot = await registry.snapshot(page, { generation: 3, includeText: false });
    const primary = snapshot.targets.find((target) => target.testId === 'save-primary');

    expect(primary?.ref).toBeTruthy();
    const resolved = await registry.resolve(primary!.ref, { page, generation: 3 });
    expect(resolved.metadata.testId).toBe('save-primary');
  });

  it('uses a native label as the accessible name instead of the HTML name attribute', async () => {
    const page = new FakePage([
      { tag: 'label', for: 'email', text: 'Email' },
      { tag: 'input', role: 'textbox', name: 'email', accessibleName: 'Email', id: 'email', type: 'email' },
    ]);
    const registry = new TargetRegistry({ generation: 4 });
    const snapshot = await registry.snapshot(page, { generation: 4, includeText: false });
    const textbox = snapshot.targets.find((target) => target.role === 'textbox');

    expect(textbox?.name).toBe('Email');
    await expect(registry.resolve(textbox!.ref, { page, generation: 4 })).resolves.toMatchObject({
      metadata: { name: 'Email' },
    });
  });
});
