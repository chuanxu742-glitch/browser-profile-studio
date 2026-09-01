import { randomBytes as cryptoRandomBytes } from 'node:crypto';

import { createSemanticSnapshot, redactControlValue } from './semantic-snapshot.js';
import type {
  BoundingBox,
  SchedulerLocatorLike,
} from '../input/scheduler.js';
import type {
  SemanticNode,
  SemanticRole,
  SemanticSnapshot,
  SemanticTarget,
  SemanticTargetMetadata,
  SnapshotBuildOptions,
} from './semantic-snapshot.js';

export interface RegistryPageLike {
  locator(selector: string): RegistryLocatorLike;
  getByRole?(role: SemanticRole, options?: { name?: string; exact?: boolean }): RegistryLocatorLike;
  getByLabel?(label: string, options?: { exact?: boolean }): RegistryLocatorLike;
  getByTestId?(testId: string): RegistryLocatorLike;
  url?(): string;
  title?(): Promise<string>;
}

export interface RegistryLocatorLike extends SchedulerLocatorLike {
  count(): Promise<number>;
  nth(index: number): RegistryLocatorLike;
  isVisible?(): Promise<boolean>;
  isEnabled?(): Promise<boolean>;
  isEditable?(): Promise<boolean>;
  isChecked?(): Promise<boolean>;
  getAttribute?(name: string, options?: Record<string, unknown>): Promise<string | null>;
  textContent?(options?: Record<string, unknown>): Promise<string | null>;
  innerText?(options?: Record<string, unknown>): Promise<string>;
  boundingBox?(): Promise<BoundingBox | null>;
}

export type TargetRegistryErrorCode =
  | 'INVALID_TARGET'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_ACTIONABLE'
  | 'STALE_TARGET'
  | 'PAGE_REVISION_MISMATCH';

export class TargetRegistryError extends Error {
  public readonly code: TargetRegistryErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: TargetRegistryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TargetRegistryError';
    this.code = code;
    this.details = details;
  }
}

export interface TargetRecord {
  ref: string;
  target: SemanticTarget;
  metadata: SemanticTargetMetadata;
  locator: RegistryLocatorLike;
  generation: number;
  frameGeneration: number;
  frameId: string;
  createdAt: number;
}

export interface TargetResolution {
  ref: string;
  locator: RegistryLocatorLike;
  metadata: SemanticTargetMetadata;
  generation: number;
  frameGeneration: number;
  frameId: string;
  boundingBox?: BoundingBox;
}

export interface RegistryOptions {
  sessionId?: string;
  generation?: number;
  frameGeneration?: number;
  maxRefs?: number;
  refTtlMs?: number;
  now?: () => number;
}

const FIXED_INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role]:not(button):not(a[href]):not(input):not(textarea):not(select)',
  '[contenteditable="true"]:not([role])',
].join(', ');

const ROLE_TAGS: Record<string, string> = {
  button: 'button',
  a: 'link',
  textarea: 'textbox',
  select: 'combobox',
};

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  email: 'textbox',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
};

function randomBytes(length: number): Uint8Array {
  // References are opaque and non-deterministic by design. Their entropy is
  // independent from the seeded interaction stream used by the scheduler.
  return cryptoRandomBytes(length);
}

function opaqueRef(counter: number): string {
  const bytes = randomBytes(8);
  const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `ref_${counter.toString(36)}_${suffix}`;
}

function cleanName(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function attr(locator: RegistryLocatorLike, name: string): Promise<string | null> {
  return locator.getAttribute ? locator.getAttribute(name).catch(() => null) : Promise.resolve(null);
}

function text(locator: RegistryLocatorLike): Promise<string> {
  if (locator.innerText) return locator.innerText({ timeout: 500 }).catch(() => '');
  if (locator.textContent) return locator.textContent({ timeout: 500 }).then((value) => value ?? '').catch(() => '');
  return Promise.resolve('');
}

function inferRole(tag: string, type: string, explicitRole: string | null): string {
  if (explicitRole) return explicitRole;
  if (tag === 'input') return INPUT_ROLES[type] ?? 'textbox';
  return ROLE_TAGS[tag] ?? (tag === 'div' ? 'generic' : tag || 'generic');
}

function isForbiddenTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return true;
  const candidate = target as Record<string, unknown>;
  const forbiddenKeys = [
    'css',
    'cssSelector',
    'xpath',
    'path',
    'coordinates',
    'coordinate',
    'x',
    'y',
    'script',
    'expression',
  ];
  return forbiddenKeys.some((key) => key in candidate);
}

export function validateSemanticTarget(target: SemanticTarget): void {
  if (isForbiddenTarget(target)) throw new TargetRegistryError('INVALID_TARGET', 'Only semantic target fields are accepted');
  const keys = ['role', 'label', 'testId', 'selector'].filter((key) => {
    const value = (target as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0;
  });
  if (keys.length !== 1) {
    throw new TargetRegistryError('INVALID_TARGET', 'A target must use exactly one semantic locator strategy');
  }
  if (target.role && target.name !== undefined && typeof target.name !== 'string') {
    throw new TargetRegistryError('INVALID_TARGET', 'Target name must be a string');
  }
  for (const value of [target.role, target.name, target.label, target.testId]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 200)) {
      throw new TargetRegistryError('INVALID_TARGET', 'Target text is too long or invalid');
    }
  }
  if (target.selector !== undefined && (typeof target.selector !== 'string' || target.selector.length > 2_048 || !target.selector.trim())) {
    throw new TargetRegistryError('INVALID_TARGET', 'Raw selector is too long or invalid');
  }
  if (target.exact !== undefined && typeof target.exact !== 'boolean') {
    throw new TargetRegistryError('INVALID_TARGET', 'Target exact must be a boolean');
  }
}

export class TargetRegistry {
  private readonly options: Required<Pick<RegistryOptions, 'maxRefs' | 'refTtlMs'>> & RegistryOptions;
  private readonly records = new Map<string, TargetRecord>();
  private sequence = 0;
  private currentGeneration: number;
  private currentFrameGeneration: number;

  public constructor(options: RegistryOptions = {}) {
    this.options = {
      ...options,
      maxRefs: Math.max(1, Math.min(10_000, Math.floor(options.maxRefs ?? 2_000))),
      refTtlMs: Math.max(100, Math.min(3_600_000, Math.floor(options.refTtlMs ?? 120_000))),
    };
    this.currentGeneration = options.generation ?? 0;
    this.currentFrameGeneration = options.frameGeneration ?? 0;
  }

  public get generation(): number {
    return this.currentGeneration;
  }

  public get size(): number {
    this.pruneExpired();
    return this.records.size;
  }

  public setGeneration(generation: number, frameGeneration = 0): void {
    if (!Number.isInteger(generation) || generation < 0) throw new RangeError('Generation must be a non-negative integer');
    this.currentGeneration = generation;
    this.currentFrameGeneration = frameGeneration;
    this.records.clear();
  }

  public advanceGeneration(): number {
    this.setGeneration(this.currentGeneration + 1, 0);
    return this.currentGeneration;
  }

  public invalidate(generation?: number, frameGeneration?: number): void {
    if (generation === undefined && frameGeneration === undefined) {
      this.records.clear();
      return;
    }
    for (const [ref, record] of this.records) {
      if (
        (generation !== undefined && record.generation !== generation) ||
        (frameGeneration !== undefined && record.frameGeneration !== frameGeneration)
      ) this.records.delete(ref);
    }
  }

  public clear(): void {
    this.records.clear();
  }

  public register(
    target: SemanticTarget,
    locator: RegistryLocatorLike,
    metadata: SemanticTargetMetadata,
    context: { generation?: number; frameGeneration?: number; frameId?: string } = {},
  ): string {
    validateSemanticTarget(target);
    this.pruneExpired();
    while (this.records.size >= this.options.maxRefs) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
    const generation = context.generation ?? this.currentGeneration;
    const frameGeneration = context.frameGeneration ?? this.currentFrameGeneration;
    const frameId = context.frameId ?? metadata.frameId ?? 'main';
    const ref = opaqueRef(++this.sequence);
    const safeMetadata = redactControlValue({ ...metadata, frameId });
    this.records.set(ref, {
      ref,
      target: { ...target },
      metadata: safeMetadata,
      locator,
      generation,
      frameGeneration,
      frameId,
      createdAt: (this.options.now ?? Date.now)(),
    });
    return ref;
  }

  public registerTarget = this.register.bind(this);
  public createRef = this.register.bind(this);

  public getRecord(ref: string): TargetRecord | undefined {
    this.pruneExpired();
    return this.records.get(ref);
  }

  public async resolve(
    ref: string,
    options: {
      page?: RegistryPageLike;
      generation?: number;
      frameGeneration?: number;
      expected?: Partial<SemanticTargetMetadata>;
      requireActionable?: boolean;
    } = {},
  ): Promise<TargetResolution> {
    this.pruneExpired();
    const record = this.records.get(ref);
    if (!record) throw new TargetRegistryError('TARGET_NOT_FOUND', 'Target reference was not found or has expired');
    const generation = options.generation ?? this.currentGeneration;
    const frameGeneration = options.frameGeneration ?? this.currentFrameGeneration;
    if (record.generation !== generation || record.frameGeneration !== frameGeneration) {
      throw new TargetRegistryError('STALE_TARGET', 'Target reference belongs to an older page generation');
    }

    let locator = record.locator;
    if (options.page) locator = this.locatorForTarget(options.page, record.target);
    const count = await locator.count();
    if (count === 0) throw new TargetRegistryError('TARGET_NOT_FOUND', 'Target is no longer present');
    if (count !== 1) {
      throw new TargetRegistryError('TARGET_AMBIGUOUS', 'Target now matches multiple elements', { count });
    }
    const current = await this.readMetadata(locator, record.metadata);
    if (!metadataMatches(current, record.metadata, { allowUnknown: true })) {
      throw new TargetRegistryError('STALE_TARGET', 'Target semantics changed since the snapshot was created');
    }
    if (options.expected && !metadataMatches(current, options.expected)) {
      throw new TargetRegistryError('STALE_TARGET', 'Target semantics changed since the snapshot was created');
    }
    if (options.requireActionable !== false) await this.assertActionable(locator, current);
    const boundingBox = locator.boundingBox ? await locator.boundingBox().catch(() => null) : undefined;
    return {
      ref,
      locator,
      metadata: redactControlValue(current),
      generation: record.generation,
      frameGeneration: record.frameGeneration,
      frameId: record.frameId,
      ...(boundingBox ? { boundingBox } : {}),
    };
  }

  public resolveTarget = this.resolve.bind(this);

  public async assertActionable(locator: RegistryLocatorLike, metadata?: SemanticTargetMetadata): Promise<void> {
    const visible = locator.isVisible ? await locator.isVisible().catch(() => false) : true;
    if (!visible) throw new TargetRegistryError('TARGET_NOT_ACTIONABLE', 'Target is not visible');
    const enabled = locator.isEnabled ? await locator.isEnabled().catch(() => false) : true;
    if (!enabled) throw new TargetRegistryError('TARGET_NOT_ACTIONABLE', 'Target is disabled');
    if (locator.boundingBox) {
      const box = await locator.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new TargetRegistryError('TARGET_NOT_ACTIONABLE', 'Target has no actionable bounding box');
      }
    }
    if (metadata?.type?.toLowerCase() === 'hidden') {
      throw new TargetRegistryError('TARGET_NOT_ACTIONABLE', 'Hidden controls are not actionable');
    }
  }

  public async snapshot(
    page: RegistryPageLike,
    options: SnapshotBuildOptions = {},
  ): Promise<SemanticSnapshot> {
    const maxNodes = Math.max(1, Math.min(2_000, Math.floor(options.maxNodes ?? 500)));
    const nodes: SemanticNode[] = [];
    const labelsByControlId = new Map<string, string>();
    try {
      const labels = page.locator('label[for]');
      const labelCount = Math.min(await labels.count(), maxNodes);
      for (let index = 0; index < labelCount; index += 1) {
        const label = labels.nth(index);
        const id = await attr(label, 'for');
        const labelText = cleanName(await text(label));
        if (id && labelText) labelsByControlId.set(id, labelText);
      }
    } catch {
      // Label enumeration is best effort; aria-label/name remain available.
    }
    // Enumerate a fixed, internal set of semantic-friendly tag locators.  The
    // selector never crosses the MCP boundary and gives us a safe tag hint
    // without using evaluate() to inspect the DOM.
    const fixedSelectors: readonly [string, string][] = [
      ['button', 'button'],
      ['a[href]', 'a'],
      ['input', 'input'],
      ['textarea', 'textarea'],
      ['select', 'select'],
      ['[role]:not(button):not(a[href]):not(input):not(textarea):not(select)', 'unknown'],
      ['[contenteditable="true"]:not([role])', 'div'],
    ];
    const seenLocators = new Set<RegistryLocatorLike>();
    for (const [selector, tagHint] of fixedSelectors) {
      if (nodes.length >= maxNodes) break;
      const selectorLocator = page.locator(selector);
      const count = Math.min(await selectorLocator.count(), maxNodes - nodes.length);
      for (let index = 0; index < count; index += 1) {
        const item = selectorLocator.nth(index);
        // Some pages match an element through both its tag and [role].  Avoid
        // duplicate references when the adapter exposes stable locator object
        // identity; metadata checks still protect against ambiguous matches.
        if (seenLocators.has(item)) continue;
        seenLocators.add(item);
        let metadata = await this.readMetadata(item, { tag: tagHint, role: tagHint === 'unknown' ? 'generic' : inferRole(tagHint, '', null), name: '' });
        const controlId = await attr(item, 'id');
        const labelName = controlId ? labelsByControlId.get(controlId) : undefined;
        // A native <label for> contributes the accessible name and must win
        // over the HTML `name` attribute. Playwright getByRole resolves by
        // accessible name, so storing the form field name here would make a
        // freshly issued ref fail on its first use.
        if (labelName) metadata = { ...metadata, name: labelName };
        if (!metadata.name && metadata.role === 'generic') continue;
        const target = semanticTargetFromMetadata(metadata);
        const ref = this.register(target, item, metadata, {
          generation: options.generation ?? this.currentGeneration,
          frameGeneration: options.frameGeneration ?? this.currentFrameGeneration,
          frameId: options.frameId ?? metadata.frameId ?? 'main',
        });
        nodes.push({
          ref,
          ...redactControlValue(metadata),
          generation: options.generation ?? this.currentGeneration,
          frameGeneration: options.frameGeneration ?? this.currentFrameGeneration,
        });
      }
    }

    let bodyText: string | undefined;
    let textTruncated = false;
    if (options.includeText !== false) {
      try {
        const body = page.locator('body');
        const raw = body.innerText
          ? await body.innerText({ timeout: 1_000 })
          : body.textContent
            ? (await body.textContent({ timeout: 1_000 })) ?? ''
            : '';
        const maxChars = Math.max(0, Math.min(100_000, Math.floor(options.maxChars ?? 10_000)));
        bodyText = raw.slice(0, maxChars);
        textTruncated = raw.length > maxChars;
      } catch {
        bodyText = undefined;
      }
    }

    let title: string | undefined;
    try {
      title = page.title ? await page.title() : undefined;
    } catch {
      title = undefined;
    }
    const snapshot = createSemanticSnapshot(
      nodes.map((node) => ({
        locator: this.records.get(node.ref)?.locator ?? page.locator(FIXED_INTERACTIVE_SELECTOR).nth(0),
        metadata: node,
      })),
      {
        ...options,
        generation: options.generation ?? this.currentGeneration,
        pageGeneration: options.pageGeneration ?? options.generation ?? this.currentGeneration,
      },
    );
    // createSemanticSnapshot intentionally receives metadata-only candidates;
    // restore the refs generated above and page information here.
    snapshot.targets.splice(0, snapshot.targets.length, ...nodes);
    snapshot.elements = snapshot.targets;
    if (bodyText !== undefined) snapshot.text = bodyText;
    if (textTruncated) snapshot.textTruncated = true;
    if (page.url) {
      try {
        snapshot.url = sanitizePageUrl(page.url());
      } catch {
        // Keep the snapshot useful even if a page closed while reading URL.
      }
    }
    if (title !== undefined) snapshot.title = title.slice(0, 500);
    return snapshot;
  }

  public createSnapshot = this.snapshot.bind(this);

  public locatorForTarget(page: RegistryPageLike, target: SemanticTarget): RegistryLocatorLike {
    validateSemanticTarget(target);
    if (target.role) {
      if (!page.getByRole) throw new TargetRegistryError('INVALID_TARGET', 'Role locators are unavailable on this page adapter');
      return page.getByRole(target.role, {
        ...(target.name !== undefined ? { name: target.name } : {}),
        ...(target.exact !== undefined ? { exact: target.exact } : {}),
      });
    }
    if (target.label) {
      if (!page.getByLabel) throw new TargetRegistryError('INVALID_TARGET', 'Label locators are unavailable on this page adapter');
      return page.getByLabel(target.label, { exact: target.exact ?? true });
    }
    if (target.testId) {
      if (!page.getByTestId) throw new TargetRegistryError('INVALID_TARGET', 'Test-id locators are unavailable on this page adapter');
      return page.getByTestId(target.testId);
    }
    if (target.selector) return page.locator(target.selector);
    throw new TargetRegistryError('INVALID_TARGET', 'No semantic locator strategy was supplied');
  }

  /** Resolve a caller-supplied target without creating a snapshot reference. */
  public async resolveDirect(
    page: RegistryPageLike,
    target: SemanticTarget,
    requireActionable = true,
  ): Promise<{ locator: RegistryLocatorLike; metadata: SemanticTargetMetadata }> {
    const locator = this.locatorForTarget(page, target);
    const count = await locator.count();
    if (count === 0) throw new TargetRegistryError('TARGET_NOT_FOUND', 'Target is not present');
    if (count !== 1) throw new TargetRegistryError('TARGET_AMBIGUOUS', 'Target matches multiple elements', { count });
    const metadata = await this.readMetadata(locator);
    if (requireActionable) await this.assertActionable(locator, metadata);
    return { locator, metadata: redactControlValue(metadata) };
  }

  private async readMetadata(locator: RegistryLocatorLike, fallback?: SemanticTargetMetadata): Promise<SemanticTargetMetadata> {
    const explicitRole = await attr(locator, 'role');
    const type = cleanName(await attr(locator, 'type'));
    const tag = cleanName(await attr(locator, 'data-semantic-tag')) || fallback?.tag || 'unknown';
    const ariaLabel = await attr(locator, 'aria-label');
    const ariaRole = explicitRole || await attr(locator, 'data-role');
    const placeholder = await attr(locator, 'placeholder');
    const nameAttr = await attr(locator, 'name');
    const title = await attr(locator, 'title');
    const testId = await attr(locator, 'data-testid') ?? await attr(locator, 'data-test-id');
    const content = cleanName(await text(locator));
    const role = inferRole(tag.toLowerCase(), type.toLowerCase(), ariaRole);
    const isFormControl = ['input', 'textarea', 'select'].includes(tag.toLowerCase());
    // For form controls, Playwright's accessible name can come from an
    // external <label for>, which is not readable through the control
    // Locator alone. The ref was already re-resolved through getByRole using
    // that stored accessible name, so preserve the fallback instead of
    // confusing the unrelated HTML `name` attribute with an accessible name.
    // Non-form controls still prefer their live visible text so a renamed
    // button/link is detected as stale.
    const name = cleanName(
      ariaLabel ||
      (!isFormControl ? content : '') ||
      fallback?.name ||
      title ||
      placeholder ||
      nameAttr,
    );
    const metadata: SemanticTargetMetadata = {
      role: role || fallback?.role || 'generic',
      name,
      tag: tag || fallback?.tag || 'unknown',
      ...(type ? { type } : fallback?.type ? { type: fallback.type } : {}),
      ...(testId ? { testId: cleanName(testId) } : fallback?.testId ? { testId: fallback.testId } : {}),
      ...(fallback?.frameId ? { frameId: fallback.frameId } : {}),
      ...(locator.isVisible ? { visible: await locator.isVisible().catch(() => false) } : {}),
      ...(locator.isEnabled ? { enabled: await locator.isEnabled().catch(() => false) } : {}),
      ...(locator.isEditable ? { editable: await locator.isEditable().catch(() => false) } : {}),
      ...(locator.isChecked ? { checked: await locator.isChecked().catch(() => false) } : {}),
      ...(await attr(locator, 'required') !== null ? { required: true } : fallback?.required ? { required: true } : {}),
      ...(fallback?.value !== undefined ? { value: '<redacted>' as const } : {}),
      ...(content && !['password', 'hidden'].includes(type.toLowerCase()) ? { text: content.slice(0, 500) } : {}),
    };
    return redactControlValue(metadata);
  }

  private pruneExpired(): void {
    const now = (this.options.now ?? Date.now)();
    for (const [ref, record] of this.records) {
      if (now - record.createdAt > this.options.refTtlMs) this.records.delete(ref);
    }
  }
}

function metadataMatches(
  current: SemanticTargetMetadata,
  expected: Partial<SemanticTargetMetadata>,
  options: { allowUnknown?: boolean } = {},
): boolean {
  for (const key of ['role', 'name', 'tag', 'type', 'frameId'] as const) {
    const value = expected[key];
    if (value !== undefined && current[key] !== value) {
      if (options.allowUnknown && (value === 'unknown' || value === 'generic' || value === '')) continue;
      return false;
    }
  }
  return true;
}

function semanticTargetFromMetadata(metadata: SemanticTargetMetadata): SemanticTarget {
  // Prefer a stable explicit test id when the page provides one. Falling
  // back to role/name could become ambiguous when several controls share the
  // same accessible name, even though the snapshot exposed a unique testId.
  if (metadata.testId) return { testId: metadata.testId };
  if (metadata.role && metadata.name) return { role: metadata.role, name: metadata.name, exact: true };
  if (metadata.role) return { role: metadata.role };
  return metadata.name
    ? { role: 'generic', name: metadata.name, exact: true }
    : { role: 'generic', exact: true };
}

function sanitizePageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export type { SemanticSnapshot, SemanticNode, SemanticTarget, SemanticTargetMetadata };
export default TargetRegistry;
