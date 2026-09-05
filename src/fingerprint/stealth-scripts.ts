import type { FingerprintConfig } from './types.js';

/** The same bootstrap runs before application code in documents and workers. */
export function buildWorkerBootstrap(config: FingerprintConfig): string {
  return buildStealthInjectionScript(config);
}

export function buildStealthInjectionScript(config: FingerprintConfig): string {
  return String.raw`(() => {
  'use strict';
  const config = ${JSON.stringify(config)};
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const nav = globalThis.navigator;
  const navProto = typeof Navigator !== 'undefined' ? Navigator.prototype
    : typeof WorkerNavigator !== 'undefined' ? WorkerNavigator.prototype : undefined;

  // Proxy native functions instead of forging Function.prototype.toString.
  // Calling the original first preserves receiver checks and WebIDL errors.
  function getter(proto, name, value) {
    const desc = proto && descriptor(proto, name);
    if (!desc || !desc.get || !desc.configurable) return;
    define(proto, name, { ...desc, get: new Proxy(desc.get, {
      apply(target, receiver, args) {
        apply(target, receiver, args);
        return value;
      },
    }) });
  }
  function method(proto, name, implementation) {
    const desc = proto && descriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') return;
    define(proto, name, { ...desc, value: new Proxy(desc.value, { apply: implementation }) });
  }

  if (navProto && config.stealth.removeWebdriver) {
    const desc = descriptor(navProto, 'webdriver');
    if (desc && desc.configurable) delete navProto.webdriver;
  }
  if (navProto && config.engine === 'chromium') {
    getter(navProto, 'userAgent', config.userAgent);
    getter(navProto, 'appVersion', config.appVersion);
    getter(navProto, 'platform', config.platform);
    getter(navProto, 'hardwareConcurrency', config.hardware.hardwareConcurrency);
    getter(navProto, 'deviceMemory', config.hardware.deviceMemory);
    getter(navProto, 'language', config.geo.languages[0] || config.geo.locale);
    getter(navProto, 'languages', Object.freeze([...config.geo.languages]));
  }

  // The CDP/Firefox launch paths own timezone, viewport, DPR and permissions.
  // Keep Date/Intl, Screen, plugins, media devices and WebGPU native. Fabricating
  // these surfaces cannot change the corresponding underlying capabilities.
  if (config.engine === 'chromium' && nav && nav.userAgentData) {
    const proto = Object.getPrototypeOf(nav.userAgentData);
    const major = config.browserVersion.split('.')[0];
    const platform = config.os === 'windows' ? 'Windows' : config.os === 'macos' ? 'macOS' : 'Linux';
    const brands = Object.freeze([
      Object.freeze({ brand: 'Chromium', version: major }),
      Object.freeze({ brand: 'Not=A?Brand', version: '99' }),
    ]);
    const fullVersionList = [
      { brand: 'Chromium', version: config.browserVersion },
      { brand: 'Not=A?Brand', version: '99.0.0.0' },
    ];
    const high = {
      architecture: 'x86', bitness: '64', formFactors: ['Desktop'], fullVersionList,
      model: '', platformVersion: config.os === 'windows' ? '10.0.0' : config.os === 'macos' ? '10.15.7' : '6.8.0',
      uaFullVersion: config.browserVersion, wow64: false,
    };
    getter(proto, 'brands', brands);
    getter(proto, 'platform', platform);
    getter(proto, 'mobile', false);
    method(proto, 'getHighEntropyValues', (target, receiver, args) => {
      return apply(target, receiver, args).then(result => {
        // Preserve validation, permissions-policy gating and requested-key shape.
        const aligned = { ...result, brands: brands.map(b => ({ ...b })), mobile: false, platform };
        for (const key of Object.keys(high)) if (key in result) aligned[key] = structuredClone(high[key]);
        return aligned;
      });
    });
    method(proto, 'toJSON', (target, receiver, args) => {
      apply(target, receiver, args);
      return { brands: brands.map(b => ({ ...b })), mobile: false, platform };
    });
  }

  if (config.webgl && config.webgl.mode !== 'native' && config.engine === 'chromium') {
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const proto = globalThis[name] && globalThis[name].prototype;
      method(proto, 'getParameter', (target, receiver, args) => {
        const native = apply(target, receiver, args);
        // Missing extensions and lost contexts remain unavailable.
        if (native === null) return native;
        if (args[0] === 37445) return config.webgl.unmaskedVendor;
        if (args[0] === 37446) return config.webgl.unmaskedRenderer;
        return native;
      });
    }
  }

  // Perturb rendered text, never readback buffers. All native getImageData,
  // putImageData, drawImage, bitmap and PNG paths then observe the SAME pixels.
  // Non-text drawing remains native; no full-canvas copies on ordinary reads.
  if (config.canvas && config.canvas.enabled) {
    const delta = ((config.canvas.seed >>> 0) % 7 + 1) / 255;
    for (const name of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) {
      const proto = globalThis[name] && globalThis[name].prototype;
      for (const draw of ['fillText', 'strokeText']) {
        method(proto, draw, (target, receiver, args) => {
          const alphaDesc = descriptor(proto, 'globalAlpha');
          if (!alphaDesc || !alphaDesc.get || !alphaDesc.set) return apply(target, receiver, args);
          const alpha = apply(alphaDesc.get, receiver, []);
          apply(alphaDesc.set, receiver, [alpha * (1 - delta)]);
          try { return apply(target, receiver, args); }
          finally { apply(alphaDesc.set, receiver, [alpha]); }
        });
      }
    }
  }

  // No AudioBuffer read-time mutation and no fictional sampleRate/baseLatency.
  // Real audio rendering and explicit sample-rate requests retain native semantics.

  if (typeof RTCPeerConnection !== 'undefined' && config.webrtc !== 'direct') {
    const Original = RTCPeerConnection;
    const relayConfig = value => {
      if (value === undefined || value === null) return { iceTransportPolicy: 'relay' };
      if (typeof value !== 'object' && typeof value !== 'function') return value;
      // Forward only the dictionary keys the native constructor actually reads.
      // The empty proxy target also permits frozen input dictionaries.
      return new Proxy({}, { get(_target, key) {
        const raw = Reflect.get(value, key, value);
        if (key !== 'iceTransportPolicy') return raw;
        if (raw === undefined) return 'relay';
        const policy = typeof raw === 'symbol' ? raw : String(raw);
        return policy === 'all' || policy === 'relay' ? 'relay' : policy;
      } });
    };
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, [relayConfig(args[0]), ...args.slice(1)], newTarget);
        // Internal filtering leaves application callback identity and EventTarget
        // registration/removal untouched. Actual transport is constrained natively.
        pc.addEventListener('icecandidate', event => {
          if (event.candidate && event.candidate.type !== 'relay') event.stopImmediatePropagation();
        });
        return pc;
      },
    });
    method(Original.prototype, 'setConfiguration', (target, receiver, args) => {
      // Native getConfiguration performs the receiver check without changing state.
      apply(Original.prototype.getConfiguration, receiver, []);
      return apply(target, receiver, [relayConfig(args[0])]);
    });
    const constructorDesc = descriptor(Original.prototype, 'constructor');
    define(Original.prototype, 'constructor', { ...constructorDesc, value: Wrapped });
    globalThis.RTCPeerConnection = Wrapped;
    if (globalThis.webkitRTCPeerConnection === Original) globalThis.webkitRTCPeerConnection = Wrapped;
  }
})();`;
}
