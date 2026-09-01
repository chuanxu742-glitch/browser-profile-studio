import type { FingerprintConfig } from './types.js';

/**
 * Builds self-contained, stealth-hardened client JavaScript to be evaluated
 * inside each browsing context before any other script executes.
 */
export function buildWorkerBootstrap(config: FingerprintConfig): string {
  const serialized = JSON.stringify(config);
  return `(function() {
  'use strict';
  if (typeof self !== 'undefined') {
    try {
      if (typeof Intl !== 'undefined') {
        const proto = Object.getPrototypeOf(self) || self;
        try {
          Object.defineProperty(proto, 'Intl', {
            value: Intl,
            configurable: true,
            writable: true,
            enumerable: true,
          });
        } catch (_) {}
        try { self.Intl = Intl; } catch (_) {}
      }
    } catch (_) {}
  }
  const config = ${serialized};
  const nativeFunctions = new WeakSet();
  const originalToString = Function.prototype.toString;
  function markAsNative(fn, customName) {
    if (typeof fn !== 'function') return fn;
    if (customName) {
      try {
        Object.defineProperty(fn, 'name', { value: customName, configurable: true });
      } catch (_) {}
    }
    nativeFunctions.add(fn);
    return fn;
  }
  if (config.stealth.protectToString) {
    Function.prototype.toString = new Proxy(originalToString, {
      apply(target, thisArg, argArray) {
        if (typeof thisArg === 'function' && nativeFunctions.has(thisArg)) {
          const fnName = thisArg.name || '';
          return 'function ' + (fnName ? fnName + '()' : '()') + ' { [native code] }';
        }
        return Reflect.apply(target, thisArg, argArray);
      }
    });
    nativeFunctions.add(Function.prototype.toString);
  }
  try {
    const origDTF = Intl.DateTimeFormat;
    const PatchedDTF = markAsNative(function(locales, options) {
      const loc = locales === undefined ? (config.geo && config.geo.locale) || 'en-US' : locales;
      const opts = options && typeof options === 'object' ? { ...options } : {};
      if (config.geo && config.geo.timezoneId && opts.timeZone === undefined) {
        opts.timeZone = config.geo.timezoneId;
      }
      return new origDTF(loc, opts);
    }, 'DateTimeFormat');
    PatchedDTF.prototype = origDTF.prototype;
    Object.setPrototypeOf(PatchedDTF, origDTF);
    Intl.DateTimeFormat = PatchedDTF;
  } catch (_) {}
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (typeof self !== 'undefined' && typeof WorkerNavigator !== 'undefined' && WorkerNavigator.prototype) {
    try {
      const proto = WorkerNavigator.prototype;
      try { delete proto.webdriver; } catch (_) {}
      const languages = Object.freeze([...(config.geo && config.geo.languages || [])]);
      const defineGetter = (prop, getter) => {
        try {
          Object.defineProperty(proto, prop, {
            get: markAsNative(getter, 'get ' + prop),
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      };
      defineGetter('userAgent', () => config.userAgent);
      defineGetter('appVersion', () => config.appVersion);
      defineGetter('platform', () => (config.hardware && config.hardware.platform) || config.platform);
      defineGetter('vendor', () => config.vendor || '');
      defineGetter('language', () => languages[0] || (config.geo && config.geo.locale) || 'en-US');
      defineGetter('languages', () => languages);
      defineGetter('hardwareConcurrency', () => (config.hardware && config.hardware.hardwareConcurrency) || 8);
      defineGetter('deviceMemory', () => (config.hardware && config.hardware.deviceMemory) || 8);
      if (config.engine === 'chromium' && nav && nav.userAgentData) {
        const nativeUAData = nav.userAgentData;
        const majorVersion = String(config.browserVersion).split('.')[0];
        const platform = config.os === 'macos' ? 'macOS' : config.os === 'linux' ? 'Linux' : 'Windows';
        const platformVersion = config.os === 'macos' ? '10.15.7' : config.os === 'linux' ? '6.8.0' : '10.0.0';
        const brands = Object.freeze([
          Object.freeze({ brand: 'Chromium', version: majorVersion }),
          Object.freeze({ brand: 'Not=A?Brand', version: '99' }),
        ]);
        const fullVersionList = Object.freeze([
          Object.freeze({ brand: 'Chromium', version: config.browserVersion }),
          Object.freeze({ brand: 'Not=A?Brand', version: '99.0.0.0' }),
        ]);
        const highEntropy = Object.freeze({
          architecture: 'x86', bitness: '64', formFactors: Object.freeze(['Desktop']),
          fullVersionList, model: '', platformVersion,
          uaFullVersion: config.browserVersion, wow64: false,
        });
        const getHighEntropyValues = markAsNative(async function(hints) {
          const result = { brands, mobile: false, platform };
          for (const hint of Array.isArray(hints) ? hints : []) {
            if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) result[hint] = highEntropy[hint];
          }
          return result;
        }, 'getHighEntropyValues');
        const toJSON = markAsNative(function() { return { brands, mobile: false, platform }; }, 'toJSON');
        const alignedUAData = new Proxy(nativeUAData, {
          get(target, prop) {
            if (prop === 'brands') return brands;
            if (prop === 'mobile') return false;
            if (prop === 'platform') return platform;
            if (prop === 'getHighEntropyValues') return getHighEntropyValues;
            if (prop === 'toJSON') return toJSON;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        defineGetter('userAgentData', () => alignedUAData);
      }
    } catch (_) {}
  }
  if (config.webgl) {
    const vendorVal = config.webgl.unmaskedVendor || config.webgl.vendor;
    const rendererVal = config.webgl.unmaskedRenderer || config.webgl.renderer;
    const hookWebGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const originalGetParameter = proto.getParameter;
      try {
        Object.defineProperty(proto, 'getParameter', {
          value: markAsNative(function(param) {
            if (param === 37445) return vendorVal;
            if (param === 37446) return rendererVal;
            if (param === 7936) return config.webgl.vendor;
            if (param === 7937) return config.webgl.renderer;
            return originalGetParameter.apply(this, arguments);
          }, 'getParameter'),
          configurable: true,
          writable: true,
        });
      } catch (_) {}
    };
    try {
      if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype) hookWebGL(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype) hookWebGL(WebGL2RenderingContext.prototype);
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const testGl = new OffscreenCanvas(1, 1).getContext('webgl');
          if (testGl) hookWebGL(Object.getPrototypeOf(testGl));
        } catch (_) {}
        try {
          const testGl2 = new OffscreenCanvas(1, 1).getContext('webgl2');
          if (testGl2) hookWebGL(Object.getPrototypeOf(testGl2));
        } catch (_) {}
      }
    } catch (e) {}
  }
  if (nav && config.webgpu && !config.webgpu.supported) {
    try {
      Object.defineProperty(nav, 'gpu', { get: markAsNative(() => undefined, 'get gpu'), configurable: true });
    } catch (e) {}
  }
})();
`;
}

export function buildStealthInjectionScript(config: FingerprintConfig): string {
  const serialized = JSON.stringify(config);

  return `
(function() {
  'use strict';
  const config = ${serialized};

  // 1. Function.prototype.toString defense
  const nativeFunctions = new WeakSet();
  const originalToString = Function.prototype.toString;

  function markAsNative(fn, customName) {
    if (typeof fn !== 'function') return fn;
    if (customName) {
      try {
        Object.defineProperty(fn, 'name', { value: customName, configurable: true });
      } catch (_) {}
    }
    nativeFunctions.add(fn);
    return fn;
  }

  if (config.stealth.protectToString) {
    Function.prototype.toString = new Proxy(originalToString, {
      apply(target, thisArg, argArray) {
        if (typeof thisArg === 'function' && nativeFunctions.has(thisArg)) {
          const fnName = thisArg.name || '';
          return 'function ' + (fnName ? fnName + '()' : '()') + ' { [native code] }';
        }
        return Reflect.apply(target, thisArg, argArray);
      }
    });
    nativeFunctions.add(Function.prototype.toString);
  }

  const navigatorObject = typeof navigator !== 'undefined' ? navigator : undefined;
  const navigatorPrototype = navigatorObject ? Object.getPrototypeOf(navigatorObject) : undefined;

  function defineNativeGetter(target, property, getter, enumerable = true) {
    if (!target) return false;
    try {
      try {
        Object.defineProperty(getter, 'name', {
          value: 'get ' + property,
          configurable: true,
        });
      } catch (_) {}
      Object.defineProperty(target, property, {
        get: markAsNative(getter),
        configurable: true,
        enumerable,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 2. Native Deep WebDriver Removal & Window Navigator Proxying
  if (navigatorObject) {
    try {
      if (typeof Navigator !== 'undefined' && Navigator.prototype) {
        try { delete Navigator.prototype.webdriver; } catch (_) {}
      }
      const origNav = navigatorObject;
      const languages = Object.freeze([...(config.geo && config.geo.languages || [])]);
      const navProxy = new Proxy(origNav, {
        get(target, prop, receiver) {
          if (prop === 'webdriver' && config.stealth.removeWebdriver) return undefined;
          if (prop === 'userAgent') return config.userAgent;
          if (prop === 'appVersion') return config.appVersion;
          if (prop === 'platform') return (config.hardware && config.hardware.platform) || config.platform;
          if (prop === 'vendor') return config.vendor;
          if (prop === 'language') return (languages && languages[0]) || (config.geo && config.geo.locale) || 'en-US';
          if (prop === 'languages') return languages;
          if (prop === 'hardwareConcurrency') return config.hardware ? config.hardware.hardwareConcurrency : target.hardwareConcurrency;
          if (prop === 'deviceMemory') return config.hardware ? config.hardware.deviceMemory : target.deviceMemory;
          if (prop === 'maxTouchPoints') return config.hardware ? config.hardware.maxTouchPoints : target.maxTouchPoints;
          // WebIDL getters such as Navigator.serviceWorker require the real
          // Navigator as their receiver and reject a wrapping Proxy.
          const val = Reflect.get(target, prop, target);
          return typeof val === 'function' ? val.bind(target) : val;
        },
        has(target, prop) {
          if (prop === 'webdriver' && config.stealth.removeWebdriver) return false;
          return Reflect.has(target, prop);
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'webdriver' && config.stealth.removeWebdriver) return undefined;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });

      if (typeof window !== 'undefined') {
        const winProto = Object.getPrototypeOf(window);
        if (winProto) {
          try {
            Object.defineProperty(winProto, 'navigator', {
              get: markAsNative(function() { return navProxy; }, 'get navigator'),
              configurable: true,
              enumerable: true,
            });
          } catch (_) {}
        }
        if (typeof Window !== 'undefined' && Window.prototype) {
          try {
            Object.defineProperty(Window.prototype, 'navigator', {
              get: markAsNative(function() { return navProxy; }, 'get navigator'),
              configurable: true,
              enumerable: true,
            });
          } catch (_) {}
        }
        try {
          Object.defineProperty(window, 'navigator', {
            get: markAsNative(function() { return navProxy; }, 'get navigator'),
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      }
    } catch (e) {}
  }

  // 3. Hardware & Screen Consistency (Screen, Viewport, CSS matchMedia)
  if (config.hardware) {
    const hw = config.hardware;
    defineNativeGetter(navigatorPrototype, 'hardwareConcurrency', () => hw.hardwareConcurrency);
    defineNativeGetter(navigatorObject, 'hardwareConcurrency', () => hw.hardwareConcurrency);
    defineNativeGetter(navigatorPrototype, 'deviceMemory', () => hw.deviceMemory);
    defineNativeGetter(navigatorObject, 'deviceMemory', () => hw.deviceMemory);
    defineNativeGetter(navigatorPrototype, 'maxTouchPoints', () => hw.maxTouchPoints);
    defineNativeGetter(navigatorObject, 'maxTouchPoints', () => hw.maxTouchPoints);
    defineNativeGetter(navigatorPrototype, 'platform', () => hw.platform || config.platform);
    defineNativeGetter(navigatorObject, 'platform', () => hw.platform || config.platform);

    if (typeof screen !== 'undefined' && screen && hw.screenWidth && hw.screenHeight) {
      const screenPrototype = Object.getPrototypeOf(screen);
      const sw = hw.screenWidth;
      const sh = hw.screenHeight;
      defineNativeGetter(screenPrototype, 'width', () => sw);
      defineNativeGetter(screenPrototype, 'height', () => sh);
      defineNativeGetter(screenPrototype, 'availWidth', () => hw.availWidth || sw);
      defineNativeGetter(screenPrototype, 'availHeight', () => hw.availHeight || (sh - 40));
      defineNativeGetter(screenPrototype, 'colorDepth', () => hw.colorDepth || 24);
      defineNativeGetter(screenPrototype, 'pixelDepth', () => hw.colorDepth || 24);
      defineNativeGetter(screen, 'width', () => sw);
      defineNativeGetter(screen, 'height', () => sh);
      defineNativeGetter(screen, 'availWidth', () => hw.availWidth || sw);
      defineNativeGetter(screen, 'availHeight', () => hw.availHeight || (sh - 40));
      defineNativeGetter(screenPrototype, 'availLeft', () => 0);
      defineNativeGetter(screenPrototype, 'availTop', () => 0);
      defineNativeGetter(screen, 'availLeft', () => 0);
      defineNativeGetter(screen, 'availTop', () => 0);
    }
    if (typeof window !== 'undefined') {
      defineNativeGetter(window, 'outerWidth', () => hw.screenWidth);
      defineNativeGetter(window, 'outerHeight', () => hw.screenHeight);
      defineNativeGetter(window, 'devicePixelRatio', () => hw.devicePixelRatio);
    }
  }

  // 4. Navigator and Intl values follow the generated profile in every context.
  if (navigatorObject) {
    defineNativeGetter(navigatorPrototype, 'userAgent', () => config.userAgent);
    defineNativeGetter(navigatorObject, 'userAgent', () => config.userAgent);
    defineNativeGetter(navigatorPrototype, 'appVersion', () => config.appVersion);
    defineNativeGetter(navigatorObject, 'appVersion', () => config.appVersion);
    defineNativeGetter(navigatorPrototype, 'vendor', () => config.vendor);
    defineNativeGetter(navigatorObject, 'vendor', () => config.vendor);
    defineNativeGetter(navigatorPrototype, 'language', () => (config.geo.languages && config.geo.languages[0]) || config.geo.locale);
    defineNativeGetter(navigatorObject, 'language', () => (config.geo.languages && config.geo.languages[0]) || config.geo.locale);
    defineNativeGetter(navigatorPrototype, 'languages', () => Object.freeze([...(config.geo.languages || [])]));
    defineNativeGetter(navigatorObject, 'languages', () => Object.freeze([...(config.geo.languages || [])]));
    if (config.oscpu !== undefined) {
      defineNativeGetter(navigatorPrototype, 'oscpu', () => config.oscpu);
      defineNativeGetter(navigatorObject, 'oscpu', () => config.oscpu);
    }
    if (config.buildID !== undefined) {
      defineNativeGetter(navigatorPrototype, 'buildID', () => config.buildID);
      defineNativeGetter(navigatorObject, 'buildID', () => config.buildID);
    }
  }
  if (navigatorObject && config.stealth.blockServiceWorkers) {
    try {
      if (navigatorPrototype && 'serviceWorker' in navigatorPrototype) delete navigatorPrototype.serviceWorker;
      if ('serviceWorker' in navigatorObject) delete navigatorObject.serviceWorker;
      defineNativeGetter(navigatorPrototype, 'serviceWorker', () => undefined);
      defineNativeGetter(navigatorObject, 'serviceWorker', () => undefined);
    } catch (e) {}
  }

  try {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const PatchedDateTimeFormat = markAsNative(function(locales, options) {
      const localeValue = locales === undefined ? config.geo.locale : locales;
      const optionsValue = options && typeof options === 'object' ? { ...options } : {};
      if (config.geo.timezoneId && optionsValue.timeZone === undefined) {
        optionsValue.timeZone = config.geo.timezoneId;
      }
      return new OriginalDateTimeFormat(localeValue, optionsValue);
    });
    PatchedDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
    Object.setPrototypeOf(PatchedDateTimeFormat, OriginalDateTimeFormat);
    Intl.DateTimeFormat = PatchedDateTimeFormat;
  } catch (e) {}

  // 5. Native Browser Engine Specific Identifiers (Firefox vs Chromium)
  const isFirefoxEngine = config.engine === 'firefox';

  // 6. Mock Plugins & MimeTypes
  if (config.stealth.mockPlugins && navigatorObject) {
    try {
      const pluginData = config.plugins || [];
      const pluginPrototype = typeof Plugin !== 'undefined' ? Plugin.prototype : Object.prototype;
      const pluginArrayPrototype = typeof PluginArray !== 'undefined' ? PluginArray.prototype : Array.prototype;
      const mimeTypePrototype = typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype;
      const mimeTypeArrayPrototype = typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : Array.prototype;
      const mockPlugins = Object.create(pluginArrayPrototype);
      const mockMimeTypes = Object.create(mimeTypeArrayPrototype);
      const allMimeTypes = [];

      pluginData.forEach((p, idx) => {
        const plugin = Object.create(pluginPrototype);
        const mimeTypes = p.mimeTypes || [];
        Object.defineProperties(plugin, {
          name: { value: p.name, enumerable: true },
          filename: { value: p.filename, enumerable: true },
          description: { value: p.description, enumerable: true },
          length: { value: mimeTypes.length, enumerable: true },
        });

        mimeTypes.forEach((m, mIdx) => {
          const mimeType = Object.create(mimeTypePrototype);
          Object.defineProperties(mimeType, {
            type: { value: m.type, enumerable: true },
            suffixes: { value: m.suffixes, enumerable: true },
            description: { value: m.description, enumerable: true },
            enabledPlugin: { value: plugin, enumerable: true },
          });
          Object.defineProperty(plugin, String(mIdx), { value: mimeType, enumerable: true });
          Object.defineProperty(plugin, m.type, { value: mimeType, enumerable: false });
          allMimeTypes.push(mimeType);
          Object.defineProperty(mockMimeTypes, String(allMimeTypes.length - 1), { value: mimeType, enumerable: true });
          Object.defineProperty(mockMimeTypes, m.type, { value: mimeType, enumerable: false });
        });

        plugin.item = markAsNative(function(index) { return this[index] || null; }, 'item');
        plugin.namedItem = markAsNative(function(name) { return this[name] || null; }, 'namedItem');

        Object.defineProperty(mockPlugins, String(idx), { value: plugin, enumerable: true });
        Object.defineProperty(mockPlugins, p.name, { value: plugin, enumerable: false });
      });

      Object.defineProperty(mockPlugins, 'length', { value: pluginData.length, enumerable: false });
      Object.defineProperty(mockMimeTypes, 'length', { value: allMimeTypes.length, enumerable: false });
      mockPlugins.item = markAsNative(function(index) { return this[index] || null; }, 'item');
      mockPlugins.namedItem = markAsNative(function(name) { return this[name] || null; }, 'namedItem');
      mockPlugins.refresh = markAsNative(function() {}, 'refresh');
      mockMimeTypes.item = markAsNative(function(index) { return this[index] || null; }, 'item');
      mockMimeTypes.namedItem = markAsNative(function(name) { return this[name] || null; }, 'namedItem');
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
        Object.defineProperty(mockPlugins, Symbol.toStringTag, { value: 'PluginArray' });
        Object.defineProperty(mockMimeTypes, Symbol.toStringTag, { value: 'MimeTypeArray' });
      }

      defineNativeGetter(navigatorPrototype, 'plugins', () => mockPlugins);
      defineNativeGetter(navigatorObject, 'plugins', () => mockPlugins);
      defineNativeGetter(navigatorPrototype, 'mimeTypes', () => mockMimeTypes);
      defineNativeGetter(navigatorObject, 'mimeTypes', () => mockMimeTypes);
    } catch (e) {}
  }

  const isFirefox = config.engine === 'firefox';

  // 7. Mock window.chrome & chrome.runtime (Chromium only)
  if (config.stealth.mockChromeRuntime && typeof window !== 'undefined' && !window.chrome && !isFirefox) {
    try {
      const mockChrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          connect: markAsNative(function connect() {}),
          sendMessage: markAsNative(function sendMessage() {}),
        },
        csi: markAsNative(function csi() {}),
        loadTimes: markAsNative(function loadTimes() {
          return {
            commitLoadTime: Date.now() / 1000,
            connectionInfo: 'h2',
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000,
            navigationType: 'Other',
            npnNegotiatedProtocol: 'h2',
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
          };
        }),
      };
      Object.defineProperty(window, 'chrome', {
        value: mockChrome,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch (e) {}
  }

  // 7. Notification Permission
  if (config.stealth.mockNotificationPermission) {
    try {
      if (typeof Notification !== 'undefined' && Notification) {
        Object.defineProperty(Notification, 'permission', {
          get: markAsNative(() => 'default'),
          configurable: true,
          enumerable: true,
        });
        Notification.requestPermission = markAsNative(function() {
          return Promise.resolve('default');
        });
      }

      if (navigatorObject && navigatorObject.permissions && navigatorObject.permissions.query) {
        const origQuery = navigatorObject.permissions.query;
        navigatorObject.permissions.query = markAsNative(function(parameters) {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({
              state: 'prompt',
              name: 'notifications',
              onchange: null,
            });
          }
          return origQuery.apply(this, arguments);
        });
      }
    } catch (e) {}
  }

  // 7.1 Align Chromium Client Hints only when the native context exposes the
  // API (normally trustworthy origins). This preserves the native capability
  // boundary while preventing host OS and headless-brand leakage.
  if (!isFirefoxEngine && navigatorObject) {
    try {
      const nativeUAData = navigatorObject.userAgentData;
      if (nativeUAData) {
        const majorVersion = String(config.browserVersion).split('.')[0];
        const platform = config.os === 'macos' ? 'macOS' : config.os === 'linux' ? 'Linux' : 'Windows';
        const platformVersion = config.os === 'macos' ? '10.15.7' : config.os === 'linux' ? '6.8.0' : '10.0.0';
        const brands = Object.freeze([
          Object.freeze({ brand: 'Chromium', version: majorVersion }),
          Object.freeze({ brand: 'Not=A?Brand', version: '99' }),
        ]);
        const fullVersionList = Object.freeze([
          Object.freeze({ brand: 'Chromium', version: config.browserVersion }),
          Object.freeze({ brand: 'Not=A?Brand', version: '99.0.0.0' }),
        ]);
        const highEntropy = Object.freeze({
          architecture: 'x86',
          bitness: '64',
          formFactors: Object.freeze(['Desktop']),
          fullVersionList,
          model: '',
          platformVersion,
          uaFullVersion: config.browserVersion,
          wow64: false,
        });
        const getHighEntropyValues = markAsNative(async function(hints) {
          const result = { brands, mobile: false, platform };
          for (const hint of Array.isArray(hints) ? hints : []) {
            if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) result[hint] = highEntropy[hint];
          }
          return result;
        }, 'getHighEntropyValues');
        const toJSON = markAsNative(function() { return { brands, mobile: false, platform }; }, 'toJSON');
        const alignedUAData = new Proxy(nativeUAData, {
          get(target, prop) {
            if (prop === 'brands') return brands;
            if (prop === 'mobile') return false;
            if (prop === 'platform') return platform;
            if (prop === 'getHighEntropyValues') return getHighEntropyValues;
            if (prop === 'toJSON') return toJSON;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        defineNativeGetter(navigatorPrototype, 'userAgentData', () => alignedUAData);
        defineNativeGetter(navigatorObject, 'userAgentData', () => alignedUAData);
      }
    } catch (e) {}
  }

  // 7.2 MediaDevices Hardware Enumeration Spoofing
  if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
    try {
      const mdSeed = (config.canvas && config.canvas.seed) ? config.canvas.seed : 12345;
      const deviceHash = (prefix, idx) => {
        let h = (mdSeed * 2654435761 + idx * 1013904223) >>> 0;
        return prefix + '_' + h.toString(16).padStart(8, '0');
      };
      const mockDevices = [
        {
          deviceId: deviceHash('audio_in', 1),
          kind: 'audioinput',
          label: 'Microphone (Realtek High Definition Audio)',
          groupId: deviceHash('grp_audio', 1),
        },
        {
          deviceId: deviceHash('audio_out', 2),
          kind: 'audiooutput',
          label: 'Speakers (Realtek High Definition Audio)',
          groupId: deviceHash('grp_audio', 1),
        },
        {
          deviceId: deviceHash('video_in', 3),
          kind: 'videoinput',
          label: 'HD Web Camera (Integrated USB Video Device)',
          groupId: deviceHash('grp_video', 2),
        }
      ];
      const patchedEnumerateDevices = markAsNative(function() {
        return Promise.resolve(mockDevices.map(d => Object.freeze({ ...d })));
      }, 'enumerateDevices');

      try {
        Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
          value: patchedEnumerateDevices,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch (_) {}
      if (typeof MediaDevices !== 'undefined' && MediaDevices.prototype) {
        try {
          Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', {
            value: patchedEnumerateDevices,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      }
    } catch (e) {}
  }

  // 8. Deterministic Canvas Noise (one stable transform per canvas)
  if (config.canvas && config.canvas.enabled) {
    const salt = Number.isFinite(config.canvas.seed) ? config.canvas.seed : 42;
    const processedCanvases = new WeakSet();

    function getSpatialOffset(x, y, seed) {
      let h = (x * 374761393 + y * 668265263) ^ seed;
      h = (h ^ (h >> 13)) * 1274126177;
      return ((h ^ (h >> 16)) & 0x07) + 1;
    }

    function injectNoise(data, width, height) {
      if (!data || data.length === 0) return;
      const w = width || 1;
      const h = height || Math.floor(data.length / (4 * w)) || 1;
      for (let row = 0; row < h; row += 2) {
        for (let col = 0; col < w; col += 2) {
          const idx = (row * w + col) * 4;
          if (idx + 3 < data.length && data[idx + 3] > 10) {
            data[idx] = (data[idx] + getSpatialOffset(col, row, salt)) % 256;
          }
        }
      }
    }

    function createPoisonedImageData(origImageData, width, height) {
      if (!origImageData || !origImageData.data) return origImageData;
      injectNoise(origImageData.data, width || origImageData.width, height || origImageData.height);
      return origImageData;
    }

    try {
      if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype) {
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = markAsNative(function(sx, sy, sw, sh, ...gArgs) {
          const res = origGetImageData.call(this, sx, sy, sw, sh, ...gArgs);
          if (res && res.data) {
            injectNoise(res.data, res.width || sw, res.height || sh);
          }
          return res;
        }, 'getImageData');
      }

      if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype) {
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const patchedToDataURL = markAsNative(function(...args) {
          const res = origToDataURL.apply(this, args);
          if (typeof res === 'string' && res.startsWith('data:image/png;base64,')) {
            const saltHex = (salt * 2654435761 >>> 0).toString(16).padStart(8, '0').toUpperCase();
            const prefix = res.slice(0, 80);
            return prefix + 'STABLE' + saltHex + 'FPSIGNATURE==';
          }
          return res;
        }, 'toDataURL');

        try { HTMLCanvasElement.prototype.toDataURL = patchedToDataURL; } catch (_) {}
        try {
          Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
            value: patchedToDataURL,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}

        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = markAsNative(function(...args) {
          return origToBlob.apply(this, args);
        }, 'toBlob');
      }
    } catch (e) {}
  }

  // 9. WebGL / WebGPU values come from the same profile in every context.
  if (config.webgl) {
    const UNMASKED_VENDOR_WEBGL = 37445;
    const UNMASKED_RENDERER_WEBGL = 37446;
    const vendorVal = config.webgl.unmaskedVendor || config.webgl.vendor;
    const rendererVal = config.webgl.unmaskedRenderer || config.webgl.renderer;

    const STANDARD_EXTENSIONS = [
      'ANGLE_instanced_arrays',
      'EXT_blend_minmax',
      'EXT_color_buffer_half_float',
      'EXT_float_blend',
      'EXT_frag_depth',
      'EXT_shader_texture_lod',
      'EXT_sRGB',
      'EXT_texture_compression_bptc',
      'EXT_texture_compression_rgtc',
      'EXT_texture_filter_anisotropic',
      'KHR_parallel_shader_compile',
      'OES_element_index_uint',
      'OES_fbo_render_mipmap',
      'OES_standard_derivatives',
      'OES_texture_float',
      'OES_texture_float_linear',
      'OES_texture_half_float',
      'OES_texture_half_float_linear',
      'OES_vertex_array_object',
      'WEBGL_color_buffer_float',
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb',
      'WEBGL_debug_renderer_info',
      'WEBGL_debug_shaders',
      'WEBGL_depth_texture',
      'WEBGL_draw_buffers',
      'WEBGL_lose_context',
      'WEBGL_multi_draw',
    ];

    function hookWebGL(proto) {
      if (!proto || !proto.getParameter) return;
      const origGetParameter = proto.getParameter;
      proto.getParameter = markAsNative(function(param) {
        if (param === UNMASKED_VENDOR_WEBGL) return vendorVal;
        if (param === UNMASKED_RENDERER_WEBGL) return rendererVal;
        if (param === 7936 /* VENDOR */) return config.webgl.vendor;
        if (param === 7937 /* RENDERER */) return config.webgl.renderer;
        if (param === 3379 /* MAX_TEXTURE_SIZE */ && config.webgl.maxTextureSize) {
          return config.webgl.maxTextureSize;
        }
        return origGetParameter.apply(this, arguments);
      });

      const origGetExtension = proto.getExtension;
      if (origGetExtension) {
        proto.getExtension = markAsNative(function(name) {
          if (name === 'WEBGL_debug_renderer_info') {
            return {
              UNMASKED_VENDOR_WEBGL: 37445,
              UNMASKED_RENDERER_WEBGL: 37446,
            };
          }
          return origGetExtension.apply(this, arguments);
        });
      }

      const origGetSupportedExtensions = proto.getSupportedExtensions;
      if (origGetSupportedExtensions) {
        proto.getSupportedExtensions = markAsNative(function() {
          return Array.from(new Set([...(origGetSupportedExtensions.apply(this, arguments) || []), ...STANDARD_EXTENSIONS]));
        });
      }

      const origGetShaderPrecisionFormat = proto.getShaderPrecisionFormat;
      if (origGetShaderPrecisionFormat) {
        proto.getShaderPrecisionFormat = markAsNative(function(shaderType, precisionType) {
          return {
            rangeMin: 127,
            rangeMax: 127,
            precision: 23,
          };
        });
      }
    }

    try {
      if (typeof WebGLRenderingContext !== 'undefined') hookWebGL(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') hookWebGL(WebGL2RenderingContext.prototype);
    } catch (e) {}

    // 10. WebGPU Adapter Spoofing
    try {
      if (navigatorObject && config.webgpu && !config.webgpu.supported) {
        defineNativeGetter(navigatorObject, 'gpu', () => undefined);
      } else if (navigatorObject && navigatorObject.gpu && navigatorObject.gpu.requestAdapter) {
        const origRequestAdapter = navigatorObject.gpu.requestAdapter;
        navigatorObject.gpu.requestAdapter = markAsNative(async function(options) {
          const adapter = await origRequestAdapter.apply(this, arguments);
          if (!adapter) return adapter;
          return new Proxy(adapter, {
            get(target, prop) {
              if (prop === 'info') {
                return {
                  vendor: vendorVal,
                  architecture: 'common-3d',
                  device: rendererVal,
                  description: rendererVal,
                };
              }
              return Reflect.get(target, prop);
            },
          });
        });
      }
    } catch (e) {}
  }

  // 11. Web Worker & SharedWorker profile propagation
  if (typeof window !== 'undefined') {
    try {
      const workerBootstrap = ${JSON.stringify(buildWorkerBootstrap(config))};

      function createWrappedWorker(OriginalWorker, scriptURL, options) {
        const workerType = options && options.type === 'module' ? 'module' : 'classic';
        if (typeof Blob !== 'undefined' && scriptURL instanceof Blob) {
          const blobType = workerType === 'module' ? 'text/javascript' : 'application/javascript';
          const combinedBlob = new Blob([workerBootstrap, '\\n', scriptURL], { type: blobType });
          return new OriginalWorker(URL.createObjectURL(combinedBlob), options);
        }
        if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof location === 'undefined') {
          return new OriginalWorker(scriptURL, options);
        }
        const resolvedURL = new URL(String(scriptURL), location.href).href;
        const source = workerType === 'module'
          ? workerBootstrap + '\\nimport ' + JSON.stringify(resolvedURL) + ';'
          : workerBootstrap + '\\nimportScripts(' + JSON.stringify(resolvedURL) + ');';
        const wrappedBlob = new Blob([source], {
          type: workerType === 'module' ? 'text/javascript' : 'application/javascript',
        });
        return new OriginalWorker(URL.createObjectURL(wrappedBlob), options);
      }

      const OriginalWorker = window.Worker;
      if (OriginalWorker) {
        const WrappedWorker = markAsNative(function(scriptURL, options) {
          return createWrappedWorker(OriginalWorker, scriptURL, options);
        });
        WrappedWorker.prototype = OriginalWorker.prototype;
        Object.setPrototypeOf(WrappedWorker, OriginalWorker);
        window.Worker = WrappedWorker;
      }

      const OriginalSharedWorker = window.SharedWorker;
      if (OriginalSharedWorker) {
        const WrappedSharedWorker = markAsNative(function(scriptURL, options) {
          return createWrappedWorker(OriginalSharedWorker, scriptURL, options);
        });
        WrappedSharedWorker.prototype = OriginalSharedWorker.prototype;
        Object.setPrototypeOf(WrappedSharedWorker, OriginalSharedWorker);
        window.SharedWorker = WrappedSharedWorker;
      }
    } catch (e) {}
  }

  // 12. AudioContext Fingerprint Protection (stable per returned buffer)
  if (config.audio && config.audio.enabled) {
    const audioSeed = (config.audio.seed || 100) * 0.0000001;
    const adjustedBuffers = new WeakSet();
    const adjustedArrays = new WeakSet();
    try {
      if (typeof AudioBuffer !== 'undefined') {
        const origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = markAsNative(function(channel) {
          const buffer = origGetChannelData.apply(this, arguments);
          if (buffer && !adjustedBuffers.has(buffer)) {
            for (let i = 0; i < buffer.length; i += 100) buffer[i] += audioSeed;
            adjustedBuffers.add(buffer);
          }
          return buffer;
        });
      }
      if (typeof BaseAudioContext !== 'undefined') {
        try {
          Object.defineProperty(BaseAudioContext.prototype, 'sampleRate', {
            get: markAsNative(() => 48000),
            configurable: true,
          });
        } catch(e) {}
      }
      if (typeof AudioContext !== 'undefined') {
        try {
          Object.defineProperty(AudioContext.prototype, 'baseLatency', {
            get: markAsNative(() => 0.005333),
            configurable: true,
          });
        } catch(e) {}
      }
      if (typeof AnalyserNode !== 'undefined') {
        const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
        AnalyserNode.prototype.getFloatFrequencyData = markAsNative(function(array) {
          origGetFloatFrequencyData.apply(this, arguments);
          if (array && !adjustedArrays.has(array)) {
            for (let i = 0; i < array.length; i += 50) array[i] += audioSeed;
            adjustedArrays.add(array);
          }
        });
      }
    } catch (e) {}
  }

  // 13. WebRTC Protection & IP Leak Prevention
  if (config.webrtc) {
    const mode = config.webrtc;
    if (mode === 'disable') {
      try {
        window.RTCPeerConnection = undefined;
        window.webkitRTCPeerConnection = undefined;
      } catch (e) {}
    } else if (mode === 'block_leak' || mode === 'replace') {
      try {
        const OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (OrigRTC) {
          const filterSdp = (sdp) => {
            if (!sdp) return sdp;
            return sdp.replace(/a=candidate:.+ (10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+|.+?\\.local) .+/g, '');
          };

          window.RTCPeerConnection = markAsNative(function(...args) {
            const pc = new OrigRTC(...args);
            const origSetLocal = pc.setLocalDescription;
            pc.setLocalDescription = markAsNative(function(desc) {
              if (desc && desc.sdp) {
                desc.sdp = filterSdp(desc.sdp);
              }
              return origSetLocal.apply(this, arguments);
            });
            return pc;
          });
          window.RTCPeerConnection.prototype = OrigRTC.prototype;
        }
      } catch (e) {}
    }
  }

  // 14. Dynamic Iframe Protection & Fingerprint Synchronization
  try {
    function protectIframeNode(child) {
      if (child && (child.tagName === 'IFRAME' || child.nodeName === 'IFRAME')) {
        try {
          const iframeWin = child.contentWindow;
          if (iframeWin && iframeWin.navigator) {
            const ifrNav = iframeWin.navigator;
            const ifrLanguages = Object.freeze([...((config.geo && config.geo.languages) || (config.locale && config.locale.languages) || [])]);
            const ifrNavProxy = new Proxy(ifrNav, {
              get(target, prop, receiver) {
                if (prop === 'webdriver' && config.stealth.removeWebdriver) return undefined;
                if (prop === 'userAgent') return config.userAgent;
                if (prop === 'appVersion') return config.appVersion;
                if (prop === 'platform') return (config.hardware && config.hardware.platform) || config.platform;
                if (prop === 'vendor') return config.vendor;
                if (prop === 'language') return (ifrLanguages && ifrLanguages[0]) || (config.geo && config.geo.locale) || 'en-US';
                if (prop === 'languages') return ifrLanguages;
                if (prop === 'hardwareConcurrency') return config.hardware ? config.hardware.hardwareConcurrency : target.hardwareConcurrency;
                if (prop === 'deviceMemory') return config.hardware ? config.hardware.deviceMemory : target.deviceMemory;
                if (prop === 'maxTouchPoints') return config.hardware ? config.hardware.maxTouchPoints : target.maxTouchPoints;
                const val = Reflect.get(target, prop, target);
                return typeof val === 'function' ? val.bind(target) : val;
              },
              has(target, prop) {
                if (prop === 'webdriver' && config.stealth.removeWebdriver) return false;
                return Reflect.has(target, prop);
              },
              getOwnPropertyDescriptor(target, prop) {
                if (prop === 'webdriver' && config.stealth.removeWebdriver) return undefined;
                return Reflect.getOwnPropertyDescriptor(target, prop);
              },
            });

            const ifrWinProto = Object.getPrototypeOf(iframeWin);
            if (ifrWinProto) {
              try {
                Object.defineProperty(ifrWinProto, 'navigator', {
                  get: markAsNative(function() { return ifrNavProxy; }, 'get navigator'),
                  configurable: true,
                  enumerable: true,
                });
              } catch (_) {}
            }
            if (iframeWin.Window && iframeWin.Window.prototype) {
              try {
                Object.defineProperty(iframeWin.Window.prototype, 'navigator', {
                  get: markAsNative(function() { return ifrNavProxy; }, 'get navigator'),
                  configurable: true,
                  enumerable: true,
                });
              } catch (_) {}
            }
            try {
              Object.defineProperty(iframeWin, 'navigator', {
                get: markAsNative(function() { return ifrNavProxy; }, 'get navigator'),
                configurable: true,
                enumerable: true,
              });
            } catch (_) {}
          }
        } catch (_) {}
      }
    }

    const origAppendChild = Element.prototype.appendChild;
    Element.prototype.appendChild = markAsNative(function(child) {
      const res = origAppendChild.apply(this, arguments);
      protectIframeNode(child);
      return res;
    }, 'appendChild');

    const origInsertBefore = Element.prototype.insertBefore;
    Element.prototype.insertBefore = markAsNative(function(newNode, referenceNode) {
      const res = origInsertBefore.apply(this, arguments);
      protectIframeNode(newNode);
      return res;
    }, 'insertBefore');
  } catch (e) {}

  // 15. Worker & SharedWorker Isolation & Fingerprint Alignment
  try {
    const workerBootstrapCode = ${JSON.stringify(buildWorkerBootstrap(config))};
    function createWrappedWorker(OriginalWorkerClass) {
      if (!OriginalWorkerClass) return undefined;
      const Wrapped = markAsNative(function(scriptURL, options) {
        const workerType = options && options.type === 'module' ? 'module' : 'classic';
        const nl = String.fromCharCode(10);
        if (typeof Blob !== 'undefined' && scriptURL instanceof Blob) {
          const blobType = workerType === 'module' ? 'text/javascript' : 'application/javascript';
          const combinedBlob = new Blob([workerBootstrapCode, nl + ';' + nl, scriptURL], { type: blobType });
          const url = URL.createObjectURL(combinedBlob);
          return typeof options !== 'undefined' ? new OriginalWorkerClass(url, options) : new OriginalWorkerClass(url);
        }
        if (typeof scriptURL === 'string' && (scriptURL.startsWith('blob:') || scriptURL.startsWith('data:'))) {
          return typeof options !== 'undefined' ? new OriginalWorkerClass(scriptURL, options) : new OriginalWorkerClass(scriptURL);
        }
        if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof location === 'undefined') {
          return new OriginalWorkerClass(scriptURL, options);
        }
        try {
          const resolvedURL = new URL(String(scriptURL), location.href).href;
          const source = workerType === 'module'
            ? workerBootstrapCode + nl + ';import ' + JSON.stringify(resolvedURL) + ';'
            : workerBootstrapCode + nl + ';importScripts(' + JSON.stringify(resolvedURL) + ');';
          const wrappedBlob = new Blob([source], {
            type: workerType === 'module' ? 'text/javascript' : 'application/javascript',
          });
          return new OriginalWorkerClass(URL.createObjectURL(wrappedBlob), options);
        } catch (_) {
          return new OriginalWorkerClass(scriptURL, options);
        }
      }, OriginalWorkerClass.name || 'Worker');
      Wrapped.prototype = OriginalWorkerClass.prototype;
      Object.setPrototypeOf(Wrapped, OriginalWorkerClass);
      return Wrapped;
    }

    if (typeof Worker !== 'undefined') {
      const WrappedWorker = createWrappedWorker(Worker);
      if (WrappedWorker) {
        try { window.Worker = WrappedWorker; } catch (_) {}
        try {
          Object.defineProperty(window, 'Worker', {
            value: WrappedWorker,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
        try {
          Object.defineProperty(globalThis, 'Worker', {
            value: WrappedWorker,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      }
    }
    if (typeof SharedWorker !== 'undefined') {
      const WrappedSharedWorker = createWrappedWorker(SharedWorker);
      if (WrappedSharedWorker) {
        try { window.SharedWorker = WrappedSharedWorker; } catch (_) {}
        try {
          Object.defineProperty(window, 'SharedWorker', {
            value: WrappedSharedWorker,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
        try {
          Object.defineProperty(globalThis, 'SharedWorker', {
            value: WrappedSharedWorker,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      }
    }
  } catch (e) {}

})();
`;
}
