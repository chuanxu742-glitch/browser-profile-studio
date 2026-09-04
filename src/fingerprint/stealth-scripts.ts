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
      if (config.stealth.removeWebdriver) {
        try { delete proto.webdriver; } catch (_) {}
        if ('webdriver' in proto) {
          try {
            Object.defineProperty(proto, 'webdriver', {
              get: undefined,
              set: undefined,
              configurable: true,
              enumerable: false,
            });
            delete proto.webdriver;
          } catch (_) {}
        }
        try { if (nav && 'webdriver' in nav) delete nav.webdriver; } catch (_) {}
      }
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
      if (config.engine !== 'firefox') {
        defineGetter('deviceMemory', () => (config.hardware && config.hardware.deviceMemory) || 8);
      } else {
        try { delete proto.deviceMemory; } catch (_) {}
        try { if (nav && 'deviceMemory' in nav) delete nav.deviceMemory; } catch (_) {}
      }
      if (config.engine === 'chromium') {
        const nativeUAData = nav && nav.userAgentData ? nav.userAgentData : undefined;
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
        const alignedUAData = nativeUAData ? new Proxy(nativeUAData, {
          get(target, prop) {
            if (prop === 'brands') return brands;
            if (prop === 'mobile') return false;
            if (prop === 'platform') return platform;
            if (prop === 'getHighEntropyValues') return getHighEntropyValues;
            if (prop === 'toJSON') return toJSON;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) : {
          brands,
          mobile: false,
          platform,
          getHighEntropyValues,
          toJSON,
        };
        defineGetter('userAgentData', () => alignedUAData);
      }
      ['userAgent', 'appVersion', 'platform', 'vendor', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'userAgentData'].forEach((p) => {
        try { if (nav && Object.prototype.hasOwnProperty.call(nav, p)) delete nav[p]; } catch (_) {}
      });
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
      if (typeof OffscreenCanvas !== 'undefined' && typeof ServiceWorkerGlobalScope === 'undefined') {
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
  try {
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

  // 6. Mock Plugins & MimeTypes 构建（规范标准 PluginArray / MimeTypeArray WebIDL 原型语义）
  let mockPlugins = null;
  let mockMimeTypes = null;
  if (config.stealth.mockPlugins && navigatorObject) {
    try {
      const pluginData = config.plugins || [];
      const pluginPrototype = typeof Plugin !== 'undefined' ? Plugin.prototype : Object.prototype;
      const pluginArrayPrototype = typeof PluginArray !== 'undefined' ? PluginArray.prototype : Array.prototype;
      const mimeTypePrototype = typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype;
      const mimeTypeArrayPrototype = typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : Array.prototype;
      mockPlugins = Object.create(pluginArrayPrototype);
      mockMimeTypes = Object.create(mimeTypeArrayPrototype);
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

          try {
            Object.defineProperty(plugin, String(mIdx), { value: mimeType, enumerable: true, configurable: true, writable: true });
            Object.defineProperty(plugin, m.type, { value: mimeType, enumerable: false, configurable: true, writable: true });
          } catch (_) {}
          allMimeTypes.push(mimeType);
          try {
            Object.defineProperty(mockMimeTypes, String(allMimeTypes.length - 1), { value: mimeType, enumerable: true, configurable: true, writable: true });
            Object.defineProperty(mockMimeTypes, m.type, { value: mimeType, enumerable: false, configurable: true, writable: true });
          } catch (_) {}
        });

        Object.defineProperty(plugin, 'item', {
          value: markAsNative(function(index) { return this[index] || null; }, 'item'),
          enumerable: false,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(plugin, 'namedItem', {
          value: markAsNative(function(name) { return this[name] || null; }, 'namedItem'),
          enumerable: false,
          configurable: true,
          writable: true,
        });

        try {
          Object.defineProperty(mockPlugins, String(idx), { value: plugin, enumerable: true, configurable: true, writable: true });
          Object.defineProperty(mockPlugins, p.name, { value: plugin, enumerable: false, configurable: true, writable: true });
        } catch (_) {}
      });

      Object.defineProperty(mockPlugins, 'length', { value: pluginData.length, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(mockMimeTypes, 'length', { value: allMimeTypes.length, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(mockPlugins, 'item', {
        value: markAsNative(function(index) { return this[index] || null; }, 'item'),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(mockPlugins, 'namedItem', {
        value: markAsNative(function(name) { return this[name] || null; }, 'namedItem'),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(mockPlugins, 'refresh', {
        value: markAsNative(function() {}, 'refresh'),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(mockMimeTypes, 'item', {
        value: markAsNative(function(index) { return this[index] || null; }, 'item'),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(mockMimeTypes, 'namedItem', {
        value: markAsNative(function(name) { return this[name] || null; }, 'namedItem'),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
        Object.defineProperty(mockPlugins, Symbol.toStringTag, { value: 'PluginArray', configurable: true });
        Object.defineProperty(mockMimeTypes, Symbol.toStringTag, { value: 'MimeTypeArray', configurable: true });
      }
    } catch (_) {}
  }

  // 2. Native Deep WebDriver Removal
  if (navigatorObject) {
    try {
      if (config.stealth.removeWebdriver) {
        if (typeof Navigator !== 'undefined' && Navigator.prototype) {
          try { delete Navigator.prototype.webdriver; } catch (_) {}
          if ('webdriver' in Navigator.prototype) {
            try {
              Object.defineProperty(Navigator.prototype, 'webdriver', {
                get: undefined,
                set: undefined,
                configurable: true,
                enumerable: false,
              });
              delete Navigator.prototype.webdriver;
            } catch (_) {}
          }
        }
        try { delete navigatorObject.webdriver; } catch (_) {}
      }
    } catch (e) {}
  }

  // 3. Hardware & Screen Consistency (规范定义在原型链上，绝不在实例上产生异常自有属性)
  try {
    if (config.hardware) {
      const hw = config.hardware;
      const navProto = (typeof Navigator !== 'undefined' && Navigator.prototype) || navigatorPrototype;
      if (navProto) {
        defineNativeGetter(navProto, 'hardwareConcurrency', () => hw.hardwareConcurrency);
        // Firefox 原生不提供 navigator.deviceMemory，严格杜绝跨引擎污染
        if (config.engine !== 'firefox') {
          defineNativeGetter(navProto, 'deviceMemory', () => hw.deviceMemory);
        } else {
          try { delete navProto.deviceMemory; } catch (_) {}
        }
        defineNativeGetter(navProto, 'maxTouchPoints', () => hw.maxTouchPoints);
        defineNativeGetter(navProto, 'platform', () => hw.platform || config.platform);
      }

    if (typeof screen !== 'undefined' && screen && hw.screenWidth && hw.screenHeight) {
      const screenPrototype = (typeof Screen !== 'undefined' && Screen.prototype) || Object.getPrototypeOf(screen);
      const sw = hw.screenWidth;
      const sh = hw.screenHeight;
      if (screenPrototype) {
        defineNativeGetter(screenPrototype, 'width', () => sw);
        defineNativeGetter(screenPrototype, 'height', () => sh);
        defineNativeGetter(screenPrototype, 'availWidth', () => hw.availWidth || sw);
        defineNativeGetter(screenPrototype, 'availHeight', () => hw.availHeight || (sh - 40));
        defineNativeGetter(screenPrototype, 'colorDepth', () => hw.colorDepth || 24);
        defineNativeGetter(screenPrototype, 'pixelDepth', () => hw.colorDepth || 24);
        defineNativeGetter(screenPrototype, 'availLeft', () => 0);
        defineNativeGetter(screenPrototype, 'availTop', () => 0);
      }
      try {
        delete screen.width;
        delete screen.height;
        delete screen.availWidth;
        delete screen.availHeight;
        delete screen.colorDepth;
        delete screen.pixelDepth;
        delete screen.availLeft;
        delete screen.availTop;
      } catch (_) {}
    }
    if (typeof window !== 'undefined') {
      defineNativeGetter(window, 'outerWidth', () => hw.screenWidth);
      defineNativeGetter(window, 'outerHeight', () => hw.screenHeight);
      defineNativeGetter(window, 'devicePixelRatio', () => hw.devicePixelRatio);
    }
  }
} catch (_) {}

  // 4. Navigator and Intl values follow the generated profile in every context.
  if (navigatorObject) {
    const navProto = (typeof Navigator !== 'undefined' && Navigator.prototype) || navigatorPrototype;
    if (navProto) {
      defineNativeGetter(navProto, 'userAgent', () => config.userAgent);
      defineNativeGetter(navProto, 'appVersion', () => config.appVersion);
      defineNativeGetter(navProto, 'vendor', () => config.vendor);
      defineNativeGetter(navProto, 'language', () => (config.geo.languages && config.geo.languages[0]) || config.geo.locale);
      defineNativeGetter(navProto, 'languages', () => Object.freeze([...(config.geo.languages || [])]));
      if (config.oscpu !== undefined) {
        defineNativeGetter(navProto, 'oscpu', () => config.oscpu);
      }
      if (config.buildID !== undefined) {
        defineNativeGetter(navProto, 'buildID', () => config.buildID);
      }
      if (mockPlugins) {
        defineNativeGetter(navProto, 'plugins', () => mockPlugins);
        defineNativeGetter(navProto, 'mimeTypes', () => mockMimeTypes);
      }
    }
    try {
      delete navigatorObject.hardwareConcurrency;
      delete navigatorObject.deviceMemory;
      delete navigatorObject.maxTouchPoints;
      delete navigatorObject.platform;
      delete navigatorObject.userAgent;
      delete navigatorObject.appVersion;
      delete navigatorObject.vendor;
      delete navigatorObject.language;
      delete navigatorObject.languages;
      delete navigatorObject.oscpu;
      delete navigatorObject.buildID;
      delete navigatorObject.plugins;
      delete navigatorObject.mimeTypes;
    } catch (_) {}
  }
  if (navigatorObject && config.stealth.blockServiceWorkers) {
    try {
      if (navigatorPrototype && 'serviceWorker' in navigatorPrototype) delete navigatorPrototype.serviceWorker;
      if ('serviceWorker' in navigatorObject) delete navigatorObject.serviceWorker;
      defineNativeGetter(navigatorPrototype, 'serviceWorker', () => undefined);
    } catch (e) {}
  }

  // 清理 document 实例上的异常自有属性（如 hidden、visibilityState、hasFocus）
  if (typeof document !== 'undefined' && document) {
    try {
      delete document.hidden;
      delete document.visibilityState;
      delete document.hasFocus;
    } catch (_) {}
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
  const isFirefox = config.engine === 'firefox';

  // 7. Mock window.chrome (Chromium only)
  if (config.stealth.mockChromeRuntime && typeof window !== 'undefined' && !window.chrome && !isFirefox) {
    try {
      const mockChrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
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

  // 7. Notification Permission & Permissions API（严格挂在 Permissions.prototype 上）
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

      if (typeof Permissions !== 'undefined' && Permissions.prototype && Permissions.prototype.query) {
        const origQuery = Permissions.prototype.query;
        Permissions.prototype.query = markAsNative(function(parameters) {
          try {
            return origQuery.apply(this, arguments).then(function(realStatus) {
              if (parameters && parameters.name === 'notifications') {
                if (realStatus && realStatus.state !== 'prompt') {
                  return new Proxy(realStatus, {
                    get(target, prop, receiver) {
                      if (prop === 'state') return 'prompt';
                      const v = Reflect.get(target, prop, receiver);
                      return typeof v === 'function' ? v.bind(target) : v;
                    }
                  });
                }
              }
              return realStatus;
            }).catch(function() {
              if (typeof PermissionStatus !== 'undefined' && PermissionStatus.prototype) {
                const fake = Object.create(PermissionStatus.prototype);
                Object.defineProperties(fake, {
                  state: { value: 'prompt', writable: true, configurable: true },
                  name: { value: (parameters && parameters.name) || 'notifications', writable: true, configurable: true },
                  onchange: { value: null, writable: true, configurable: true },
                });
                return fake;
              }
              return { state: 'prompt', name: 'notifications', onchange: null };
            });
          } catch (_) {
            return origQuery.apply(this, arguments);
          }
        }, 'query');
      }
      try {
        if (navigatorObject && navigatorObject.permissions) {
          delete navigatorObject.permissions.query;
        }
      } catch (_) {}
    } catch (e) {}
  }

  // 7.1 Align Chromium Client Hints only when the native context exposes the API
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
        const navProto = (typeof Navigator !== 'undefined' && Navigator.prototype) || navigatorPrototype;
        if (navProto) {
          defineNativeGetter(navProto, 'userAgentData', () => alignedUAData);
        }
        try { delete navigatorObject.userAgentData; } catch (_) {}
      }
    } catch (e) {}
  }

  // 7.2 MediaDevices Hardware Enumeration Spoofing（严格遵循 WebIDL 标准 MediaDeviceInfo 原型语义）
  if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
    try {
      const mdSeed = (config.canvas && config.canvas.seed) ? config.canvas.seed : 12345;
      const deviceHash = (prefix, idx) => {
        let h = (mdSeed * 2654435761 + idx * 1013904223) >>> 0;
        return prefix + '_' + h.toString(16).padStart(8, '0');
      };
      const mockDevicesData = [
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
      let mediaPermissionGranted = false;
      if (typeof MediaDevices !== 'undefined' && MediaDevices.prototype && MediaDevices.prototype.getUserMedia) {
        const origGUM = MediaDevices.prototype.getUserMedia;
        MediaDevices.prototype.getUserMedia = markAsNative(async function(...args) {
          const stream = await origGUM.apply(this, args);
          mediaPermissionGranted = true;
          return stream;
        }, 'getUserMedia');
      }

      const deviceDataMap = new WeakMap();
      const mediaProto = typeof MediaDeviceInfo !== 'undefined' ? MediaDeviceInfo.prototype : Object.prototype;

      if (typeof MediaDeviceInfo !== 'undefined' && MediaDeviceInfo.prototype) {
        const origDeviceIdDesc = Object.getOwnPropertyDescriptor(MediaDeviceInfo.prototype, 'deviceId');
        const origKindDesc = Object.getOwnPropertyDescriptor(MediaDeviceInfo.prototype, 'kind');
        const origLabelDesc = Object.getOwnPropertyDescriptor(MediaDeviceInfo.prototype, 'label');
        const origGroupIdDesc = Object.getOwnPropertyDescriptor(MediaDeviceInfo.prototype, 'groupId');

        Object.defineProperty(MediaDeviceInfo.prototype, 'deviceId', {
          get: markAsNative(function() {
            if (deviceDataMap.has(this)) return mediaPermissionGranted ? deviceDataMap.get(this).deviceId : '';
            return origDeviceIdDesc && origDeviceIdDesc.get ? origDeviceIdDesc.get.call(this) : '';
          }, 'get deviceId'),
          enumerable: true,
          configurable: true,
        });

        Object.defineProperty(MediaDeviceInfo.prototype, 'kind', {
          get: markAsNative(function() {
            if (deviceDataMap.has(this)) return deviceDataMap.get(this).kind;
            return origKindDesc && origKindDesc.get ? origKindDesc.get.call(this) : '';
          }, 'get kind'),
          enumerable: true,
          configurable: true,
        });

        Object.defineProperty(MediaDeviceInfo.prototype, 'label', {
          get: markAsNative(function() {
            if (deviceDataMap.has(this)) return mediaPermissionGranted ? deviceDataMap.get(this).label : '';
            return origLabelDesc && origLabelDesc.get ? origLabelDesc.get.call(this) : '';
          }, 'get label'),
          enumerable: true,
          configurable: true,
        });

        Object.defineProperty(MediaDeviceInfo.prototype, 'groupId', {
          get: markAsNative(function() {
            if (deviceDataMap.has(this)) return mediaPermissionGranted ? deviceDataMap.get(this).groupId : '';
            return origGroupIdDesc && origGroupIdDesc.get ? origGroupIdDesc.get.call(this) : '';
          }, 'get groupId'),
          enumerable: true,
          configurable: true,
        });

        MediaDeviceInfo.prototype.toJSON = markAsNative(function toJSON() {
          return {
            deviceId: this.deviceId,
            kind: this.kind,
            label: this.label,
            groupId: this.groupId,
          };
        }, 'toJSON');
      }

      function buildDeviceInfo(data) {
        const item = Object.create(mediaProto);
        deviceDataMap.set(item, data);
        return item;
      }

      const patchedEnumerateDevices = markAsNative(function() {
        return Promise.resolve(mockDevicesData.map(d => buildDeviceInfo(d)));
      }, 'enumerateDevices');

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
      try {
        if (navigatorObject && navigatorObject.mediaDevices) {
          delete navigatorObject.mediaDevices.enumerateDevices;
        }
      } catch (_) {}
    } catch (e) {}
  }

  // 8. Deterministic Canvas Noise (保持 getImageData、toDataURL、toBlob 多出口像素绝对一致)
  if (config.canvas && config.canvas.enabled) {
    const salt = Number.isFinite(config.canvas.seed) ? config.canvas.seed : 42;

    function getSpatialOffset(x, y, seed) {
      let h = (x * 374761393 + y * 668265263) ^ seed;
      h = (h ^ (h >> 13)) * 1274126177;
      return ((h ^ (h >> 16)) & 0x07) + 1;
    }

    // 根据全局像素坐标对像素缓冲区注入空间确定性噪点
    function injectNoise(data, width, height, startX = 0, startY = 0) {
      if (!data || data.length === 0) return;
      const w = width || 1;
      const h = height || Math.floor(data.length / (4 * w)) || 1;
      for (let row = 0; row < h; row += 2) {
        for (let col = 0; col < w; col += 2) {
          const idx = (row * w + col) * 4;
          if (idx + 3 < data.length && data[idx + 3] > 10) {
            data[idx] = (data[idx] + getSpatialOffset(startX + col, startY + row, salt)) % 256;
          }
        }
      }
    }

    try {
      const poisonedSources = typeof WeakSet !== 'undefined' ? new WeakSet() : { has: () => false, add: () => {} };
      const poisonedCanvasSet = typeof WeakSet !== 'undefined' ? new WeakSet() : { has: () => false, add: () => {} };
      const poisonedUrls = typeof Set !== 'undefined' ? new Set() : { has: () => false, add: () => {}, delete: () => {} };
      const poisonedUrlsList = [];
      function recordPoisonedUrl(url) {
        if (typeof url !== 'string') return;
        poisonedUrls.add(url);
        poisonedUrlsList.push(url);
        if (poisonedUrlsList.length > 200) {
          const old = poisonedUrlsList.shift();
          poisonedUrls.delete(old);
        }
      }
      function isPoisonedUrl(url) {
        if (typeof url !== 'string') return false;
        return poisonedUrls.has(url);
      }

      const origGetImageData = typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype ? CanvasRenderingContext2D.prototype.getImageData : null;
      const origPutImageData = typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype ? CanvasRenderingContext2D.prototype.putImageData : null;
      const origDrawImage = typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype ? CanvasRenderingContext2D.prototype.drawImage : null;

      if (origGetImageData) {
        CanvasRenderingContext2D.prototype.getImageData = markAsNative(function(sx, sy, sw, sh, ...gArgs) {
          const res = origGetImageData.call(this, sx, sy, sw, sh, ...gArgs);
          if (this.canvas && poisonedCanvasSet.has(this.canvas)) {
            return res;
          }
          if (res && res.data) {
            injectNoise(res.data, res.width || sw, res.height || sh, sx, sy);
          }
          return res;
        }, 'getImageData');
      }

      if (origDrawImage) {
        CanvasRenderingContext2D.prototype.drawImage = markAsNative(function(img, ...drawArgs) {
          if (img) {
            const isPoisoned = poisonedSources.has(img) ||
              (img.src && isPoisonedUrl(img.src)) ||
              (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement && poisonedCanvasSet.has(img));
            if (isPoisoned && this.canvas) {
              poisonedCanvasSet.add(this.canvas);
            }
          }
          return origDrawImage.call(this, img, ...drawArgs);
        }, 'drawImage');
      }

      function createPoisonedCanvas(sourceCanvas) {
        if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height || typeof document === 'undefined') return null;
        try {
          const temp = document.createElement('canvas');
          temp.width = sourceCanvas.width;
          temp.height = sourceCanvas.height;
          const ctx = temp.getContext('2d', { willReadFrequently: true }) || temp.getContext('2d');
          if (!ctx || !origDrawImage || !origGetImageData || !origPutImageData) return null;
          origDrawImage.call(ctx, sourceCanvas, 0, 0);
          const imgData = origGetImageData.call(ctx, 0, 0, temp.width, temp.height);
          if (imgData && imgData.data) {
            injectNoise(imgData.data, temp.width, temp.height, 0, 0);
            origPutImageData.call(ctx, imgData, 0, 0);
            return temp;
          }
        } catch (_) {}
        return null;
      }

      if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype) {
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const patchedToDataURL = markAsNative(function(...args) {
          if (poisonedCanvasSet.has(this)) {
            const res = origToDataURL.apply(this, args);
            if (typeof res === 'string') recordPoisonedUrl(res);
            return res;
          }
          const poisoned = createPoisonedCanvas(this);
          const target = poisoned || this;
          const res = origToDataURL.apply(target, args);
          if (typeof res === 'string') recordPoisonedUrl(res);
          return res;
        }, 'toDataURL');

        HTMLCanvasElement.prototype.toDataURL = patchedToDataURL;

        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        const patchedToBlob = markAsNative(function(callback, ...args) {
          const target = (!poisonedCanvasSet.has(this) && createPoisonedCanvas(this)) || this;
          const wrappedCallback = markAsNative(function(blob) {
            if (blob) poisonedSources.add(blob);
            if (typeof callback === 'function') callback(blob);
          }, 'callback');
          return origToBlob.call(target, wrappedCallback, ...args);
        }, 'toBlob');

        HTMLCanvasElement.prototype.toBlob = patchedToBlob;
      }

      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        const origCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = markAsNative(function(obj) {
          const url = origCreateObjectURL.call(this, obj);
          if (obj && poisonedSources.has(obj)) {
            recordPoisonedUrl(url);
          }
          return url;
        }, 'createObjectURL');
      }

      if (typeof HTMLImageElement !== 'undefined' && HTMLImageElement.prototype) {
        const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (srcDesc && srcDesc.set) {
          const origSrcSet = srcDesc.set;
          Object.defineProperty(HTMLImageElement.prototype, 'src', {
            set: markAsNative(function(val) {
              if (isPoisonedUrl(val)) {
                poisonedSources.add(this);
              }
              return origSrcSet.call(this, val);
            }, 'set src'),
            get: srcDesc.get,
            configurable: true,
            enumerable: true,
          });
        }
      }

      if (typeof createImageBitmap !== 'undefined') {
        const origCreateImageBitmap = createImageBitmap;
        window.createImageBitmap = markAsNative(async function(image, ...args) {
          const isPoisoned = poisonedSources.has(image) ||
            (image && image.src && isPoisonedUrl(image.src)) ||
            (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement && poisonedCanvasSet.has(image));
          const bmp = await origCreateImageBitmap.call(this, image, ...args);
          if (isPoisoned && bmp) {
            poisonedSources.add(bmp);
          }
          return bmp;
        }, 'createImageBitmap');
      }

      if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype && OffscreenCanvas.prototype.convertToBlob) {
        const origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
        OffscreenCanvas.prototype.convertToBlob = markAsNative(async function(...args) {
          try {
            const temp = new OffscreenCanvas(this.width, this.height);
            const ctx = temp.getContext('2d');
            if (ctx) {
              ctx.drawImage(this, 0, 0);
              const imgData = ctx.getImageData(0, 0, temp.width, temp.height);
              if (imgData && imgData.data) {
                injectNoise(imgData.data, temp.width, temp.height, 0, 0);
                ctx.putImageData(imgData, 0, 0);
                const blob = await origConvertToBlob.apply(temp, args);
                if (blob) poisonedSources.add(blob);
                return blob;
              }
            }
          } catch (_) {}
          return origConvertToBlob.apply(this, args);
        }, 'convertToBlob');
      }
    } catch (e) {}
  }

  // 9. WebGL / WebGPU values come from the same profile in every context.
  if (config.webgl) {
    const UNMASKED_VENDOR_WEBGL = 37445;
    const UNMASKED_RENDERER_WEBGL = 37446;
    const vendorVal = config.webgl.unmaskedVendor || config.webgl.vendor;
    const rendererVal = config.webgl.unmaskedRenderer || config.webgl.renderer;

    function hookWebGL(proto) {
      if (!proto || !proto.getParameter) return;
      const origGetParameter = proto.getParameter;
      proto.getParameter = markAsNative(function(param) {
        if (param === UNMASKED_VENDOR_WEBGL) return vendorVal;
        if (param === UNMASKED_RENDERER_WEBGL) return rendererVal;
        if (param === 7936 /* VENDOR */) {
          return isFirefoxEngine ? 'Mozilla' : (config.webgl.vendor || 'WebKit');
        }
        if (param === 7937 /* RENDERER */) {
          return isFirefoxEngine ? 'Mozilla' : (config.webgl.renderer || 'WebKit WebGL');
        }
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
          const nativeExts = origGetSupportedExtensions.apply(this, arguments) || [];
          if (!nativeExts.includes('WEBGL_debug_renderer_info')) {
            return [...nativeExts, 'WEBGL_debug_renderer_info'];
          }
          return nativeExts;
        });
      }

      const origGetShaderPrecisionFormat = proto.getShaderPrecisionFormat;
      if (origGetShaderPrecisionFormat) {
        proto.getShaderPrecisionFormat = markAsNative(function(shaderType, precisionType) {
          const res = origGetShaderPrecisionFormat.call(this, shaderType, precisionType);
          if (res && typeof WebGLShaderPrecisionFormat !== 'undefined' && res instanceof WebGLShaderPrecisionFormat) {
            return res;
          }
          if (typeof WebGLShaderPrecisionFormat !== 'undefined' && WebGLShaderPrecisionFormat.prototype) {
            const fake = Object.create(WebGLShaderPrecisionFormat.prototype);
            Object.defineProperties(fake, {
              rangeMin: { value: 127, enumerable: true },
              rangeMax: { value: 127, enumerable: true },
              precision: { value: 23, enumerable: true },
            });
            return fake;
          }
          return res;
        });
      }
    }

    try {
      if (typeof WebGLRenderingContext !== 'undefined') hookWebGL(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') hookWebGL(WebGL2RenderingContext.prototype);
    } catch (e) {}

    // 10. WebGPU Adapter Spoofing
    try {
      const navProto = (typeof Navigator !== 'undefined' && Navigator.prototype) || navigatorPrototype;
      if (config.webgpu && !config.webgpu.supported) {
        if (isFirefoxEngine) {
          if (navigatorObject && 'gpu' in navigatorObject) {
            try { delete navigatorObject.gpu; } catch (_) {}
          }
          if (navProto && 'gpu' in navProto) {
            try { delete navProto.gpu; } catch (_) {}
          }
        } else {
          if (navProto && 'gpu' in navProto) {
            defineNativeGetter(navProto, 'gpu', () => undefined);
          }
          if (navigatorObject && Object.prototype.hasOwnProperty.call(navigatorObject, 'gpu')) {
            try { delete navigatorObject.gpu; } catch (_) {}
          }
        }
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

  // 13. WebRTC 全路径防护与 IP 防泄露（全路径覆盖 setLocalDescription/createOffer/createAnswer/localDescription/onicecandidate/IPv6）
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
          const isLeakingCandidate = (candidateObj) => {
            if (!candidateObj) return false;
            const s = typeof candidateObj === 'string' ? candidateObj : (candidateObj.candidate || '');
            return /(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|127\.\d+\.\d+\.\d+|\.local|fe80:|::1)/i.test(s);
          };

          const filterSdp = (sdp) => {
            if (!sdp || typeof sdp !== 'string') return sdp;
            const LF = String.fromCharCode(10);
            const CRLF = String.fromCharCode(13, 10);
            return sdp.split(LF).map((line) => {
              if (line.startsWith('c=IN IP4 ') || line.startsWith('o=')) {
                return line.replace(/IN IP4 [^ \s]+/g, 'IN IP4 0.0.0.0').replace(/IN IP6 [^ \s]+/g, 'IN IP6 ::1');
              }
              if (line.startsWith('a=candidate:') && isLeakingCandidate(line)) {
                return '';
              }
              return line;
            }).filter(Boolean).join(CRLF) + CRLF;
          };

          const sanitizeDescription = (desc) => {
            if (!desc || !desc.sdp) return desc;
            try {
              return new RTCSessionDescription({
                type: desc.type,
                sdp: filterSdp(desc.sdp),
              });
            } catch (_) {
              return { type: desc.type, sdp: filterSdp(desc.sdp) };
            }
          };

          const PatchedRTC = markAsNative(function(...args) {
            const pc = new OrigRTC(...args);

            // Hook createOffer
            const origCreateOffer = pc.createOffer;
            pc.createOffer = markAsNative(async function(...offerArgs) {
              const offer = await origCreateOffer.apply(this, offerArgs);
              return sanitizeDescription(offer);
            }, 'createOffer');

            // Hook createAnswer
            const origCreateAnswer = pc.createAnswer;
            pc.createAnswer = markAsNative(async function(...answerArgs) {
              const answer = await origCreateAnswer.apply(this, answerArgs);
              return sanitizeDescription(answer);
            }, 'createAnswer');

            // Hook setLocalDescription
            const origSetLocal = pc.setLocalDescription;
            pc.setLocalDescription = markAsNative(function(...setArgs) {
              return origSetLocal.apply(this, setArgs);
            }, 'setLocalDescription');

            // Hook onicecandidate 回调
            let customCandidateHandler = null;
            Object.defineProperty(pc, 'onicecandidate', {
              get: markAsNative(() => customCandidateHandler, 'get onicecandidate'),
              set: markAsNative((fn) => {
                if (typeof fn !== 'function') {
                  customCandidateHandler = null;
                  pc.removeEventListener('icecandidate', internalCandidateListener);
                  return;
                }
                customCandidateHandler = fn;
              }, 'set onicecandidate'),
              configurable: true,
              enumerable: true,
            });

            function internalCandidateListener(event) {
              if (customCandidateHandler) {
                if (event && event.candidate && isLeakingCandidate(event.candidate)) {
                  // 阻断内网 candidate 触发泄露
                  return;
                }
                customCandidateHandler.call(pc, event);
              }
            }
            pc.addEventListener('icecandidate', internalCandidateListener);

            // Hook addEventListener 对 icecandidate 进行过滤
            const origAddEventListener = pc.addEventListener;
            pc.addEventListener = markAsNative(function(type, listener, ...extra) {
              if (type === 'icecandidate' && typeof listener === 'function' && listener !== internalCandidateListener) {
                const wrapped = markAsNative(function(event) {
                  if (event && event.candidate && isLeakingCandidate(event.candidate)) {
                    return;
                  }
                  return listener.call(this, event);
                });
                return origAddEventListener.call(this, type, wrapped, ...extra);
              }
              return origAddEventListener.call(this, type, listener, ...extra);
            }, 'addEventListener');

            return pc;
          }, 'RTCPeerConnection');

          PatchedRTC.prototype = OrigRTC.prototype;
          // Hook localDescription getters
          ['localDescription', 'currentLocalDescription', 'pendingLocalDescription'].forEach((prop) => {
            const desc = Object.getOwnPropertyDescriptor(OrigRTC.prototype, prop);
            if (desc && desc.get) {
              Object.defineProperty(OrigRTC.prototype, prop, {
                get: markAsNative(function() {
                  const origVal = desc.get.call(this);
                  return sanitizeDescription(origVal);
                }, 'get ' + prop),
                configurable: true,
                enumerable: true,
              });
            }
          });

          window.RTCPeerConnection = PatchedRTC;
          if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedRTC;
        }
      } catch (e) {}
    }
  }

  // 14. 全方位 Iframe 隐身防护与指纹同步（覆盖静态与动态 iframe，彻底移除 webdriver）
  try {
    let isProtectingIframe = false;
    const origWinDesc = typeof HTMLIFrameElement !== 'undefined' && HTMLIFrameElement.prototype ? Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow') : null;
    const origWinGet = origWinDesc && origWinDesc.get ? origWinDesc.get : null;

    function protectIframeNode(child) {
      if (isProtectingIframe) return;
      if (!child || (child.tagName !== 'IFRAME' && child.nodeName !== 'IFRAME')) return;
      isProtectingIframe = true;
      try {
        const iframeWin = origWinGet ? origWinGet.call(child) : child.contentWindow;
        if (iframeWin && iframeWin.navigator) {
          if (config.stealth.removeWebdriver) {
            if (iframeWin.Navigator && iframeWin.Navigator.prototype) {
              try { delete iframeWin.Navigator.prototype.webdriver; } catch (_) {}
              if ('webdriver' in iframeWin.Navigator.prototype) {
                try {
                  Object.defineProperty(iframeWin.Navigator.prototype, 'webdriver', {
                    get: undefined,
                    set: undefined,
                    configurable: true,
                    enumerable: false,
                  });
                  delete iframeWin.Navigator.prototype.webdriver;
                } catch (_) {}
              }
            }
            try { delete iframeWin.navigator.webdriver; } catch (_) {}
          }

          const ifrNav = iframeWin.navigator;
          const ifrNavProto = (iframeWin.Navigator && iframeWin.Navigator.prototype) || Object.getPrototypeOf(ifrNav);
          const ifrLanguages = Object.freeze([...((config.geo && config.geo.languages) || (config.locale && config.locale.languages) || [])]);

          if (ifrNavProto) {
            defineNativeGetter(ifrNavProto, 'userAgent', () => config.userAgent);
            defineNativeGetter(ifrNavProto, 'appVersion', () => config.appVersion);
            defineNativeGetter(ifrNavProto, 'platform', () => (config.hardware && config.hardware.platform) || config.platform);
            defineNativeGetter(ifrNavProto, 'vendor', () => config.vendor);
            defineNativeGetter(ifrNavProto, 'language', () => (ifrLanguages && ifrLanguages[0]) || (config.geo && config.geo.locale) || 'en-US');
            defineNativeGetter(ifrNavProto, 'languages', () => ifrLanguages);
            if (config.hardware) {
              defineNativeGetter(ifrNavProto, 'hardwareConcurrency', () => config.hardware.hardwareConcurrency);
              if (config.engine !== 'firefox') {
                defineNativeGetter(ifrNavProto, 'deviceMemory', () => config.hardware.deviceMemory);
              } else {
                try { delete ifrNavProto.deviceMemory; } catch (_) {}
              }
              defineNativeGetter(ifrNavProto, 'maxTouchPoints', () => config.hardware.maxTouchPoints);
            }
            if (mockPlugins) {
              defineNativeGetter(ifrNavProto, 'plugins', () => mockPlugins);
              defineNativeGetter(ifrNavProto, 'mimeTypes', () => mockMimeTypes);
            }
          }

          try {
            delete ifrNav.userAgent;
            delete ifrNav.appVersion;
            delete ifrNav.platform;
            delete ifrNav.vendor;
            delete ifrNav.language;
            delete ifrNav.languages;
            delete ifrNav.hardwareConcurrency;
            delete ifrNav.deviceMemory;
            delete ifrNav.maxTouchPoints;
            delete ifrNav.plugins;
            delete ifrNav.mimeTypes;
            delete iframeWin.navigator;
          } catch (_) {}
        }
      } catch (_) {} finally {
        isProtectingIframe = false;
      }
    }

    if (origWinGet && HTMLIFrameElement.prototype) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: markAsNative(function() {
          const win = origWinGet.call(this);
          if (!isProtectingIframe) {
            protectIframeNode(this);
          }
          return win;
        }, 'get contentWindow'),
        configurable: true,
        enumerable: true,
      });
    }

    // 初始化时保护 DOM 中现存的所有 iframe
    if (typeof document !== 'undefined') {
      try {
        const existingIframes = document.querySelectorAll('iframe');
        existingIframes.forEach(protectIframeNode);
      } catch (_) {}
      // 使用 MutationObserver 监听动态插入的 iframe
      try {
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              protectIframeNode(node);
              if (node && node.querySelectorAll) {
                try {
                  node.querySelectorAll('iframe').forEach(protectIframeNode);
                } catch (_) {}
              }
            }
          }
        });
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch (_) {}
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
    const origCreateObjectURL = typeof URL !== 'undefined' ? URL.createObjectURL : undefined;
    const origRevokeObjectURL = typeof URL !== 'undefined' ? URL.revokeObjectURL : undefined;
    const blobUrlMap = new Map();
    if (origCreateObjectURL) {
      URL.createObjectURL = markAsNative(function(obj) {
        const url = origCreateObjectURL.call(URL, obj);
        if (typeof url === 'string' && typeof Blob !== 'undefined' && obj instanceof Blob) {
          if (blobUrlMap.size > 200) {
            const firstKey = blobUrlMap.keys().next().value;
            blobUrlMap.delete(firstKey);
          }
          blobUrlMap.set(url, obj);
        }
        return url;
      }, 'createObjectURL');
    }
    if (origRevokeObjectURL) {
      URL.revokeObjectURL = markAsNative(function(url) {
        if (typeof url === 'string') {
          blobUrlMap.delete(url);
        }
        return origRevokeObjectURL.call(URL, url);
      }, 'revokeObjectURL');
    }

    function createWrappedWorker(OriginalWorkerClass) {
      if (!OriginalWorkerClass) return undefined;
      const Wrapped = markAsNative(function(scriptURL, options) {
        const workerType = options && options.type === 'module' ? 'module' : 'classic';
        const nl = String.fromCharCode(10);
        const blobType = workerType === 'module' ? 'text/javascript' : 'application/javascript';
        const createURL = origCreateObjectURL ? (b) => origCreateObjectURL.call(URL, b) : (b) => URL.createObjectURL(b);

        if (typeof Blob !== 'undefined' && scriptURL instanceof Blob) {
          const combinedBlob = new Blob([workerBootstrapCode, nl + ';' + nl, scriptURL], { type: blobType });
          const url = createURL(combinedBlob);
          return typeof options !== 'undefined' ? new OriginalWorkerClass(url, options) : new OriginalWorkerClass(url);
        }

        if (typeof scriptURL === 'string' && blobUrlMap.has(scriptURL)) {
          const origBlob = blobUrlMap.get(scriptURL);
          const combinedBlob = new Blob([workerBootstrapCode, nl + ';' + nl, origBlob], { type: origBlob.type || blobType });
          const url = createURL(combinedBlob);
          return typeof options !== 'undefined' ? new OriginalWorkerClass(url, options) : new OriginalWorkerClass(url);
        }

        // 普通脚本 URL（如 /worker.js）绝不改写成 blob，完全尊重原始 location.href、CSP 与模块加载
        return typeof options !== 'undefined' ? new OriginalWorkerClass(scriptURL, options) : new OriginalWorkerClass(scriptURL);
      }, OriginalWorkerClass.name || 'Worker');
      Wrapped.prototype = OriginalWorkerClass.prototype;
      Object.setPrototypeOf(Wrapped, OriginalWorkerClass);
      return Wrapped;
    }

    function alignWorkerFingerprintData(data) {
      if (!data || typeof data !== 'object') return;
      try {
        if ('timezone' in data && config.geo && config.geo.timezoneId) {
          data.timezone = config.geo.timezoneId;
        }
        if ('hardwareConcurrency' in data && config.hardware) {
          data.hardwareConcurrency = config.hardware.hardwareConcurrency;
        }
        if ('platform' in data && (config.hardware?.platform || config.platform)) {
          data.platform = config.hardware?.platform || config.platform;
        }
        if ('userAgent' in data && config.userAgent) {
          data.userAgent = config.userAgent;
        }
        if ('appVersion' in data && config.appVersion) {
          data.appVersion = config.appVersion;
        }
        if (config.engine === 'firefox' && 'deviceMemory' in data) {
          delete data.deviceMemory;
        }
      } catch (_) {}
    }

    function hookOnMessage(targetProto) {
      if (!targetProto) return;
      const origOnMessageDesc = Object.getOwnPropertyDescriptor(targetProto, 'onmessage');
      if (origOnMessageDesc && origOnMessageDesc.set) {
        const origSet = origOnMessageDesc.set;
        Object.defineProperty(targetProto, 'onmessage', {
          set: markAsNative(function(fn) {
            if (typeof fn === 'function') {
              const wrapped = markAsNative(function(event) {
                if (event && event.data) alignWorkerFingerprintData(event.data);
                return fn.apply(this, arguments);
              });
              return origSet.call(this, wrapped);
            }
            return origSet.call(this, fn);
          }, 'set onmessage'),
          get: origOnMessageDesc.get,
          configurable: true,
          enumerable: true,
        });
      }
    }

    if (typeof MessagePort !== 'undefined' && MessagePort.prototype) {
      hookOnMessage(MessagePort.prototype);
    }
    if (typeof Worker !== 'undefined' && Worker.prototype) {
      hookOnMessage(Worker.prototype);
    }

    if (typeof EventTarget !== 'undefined' && EventTarget.prototype && EventTarget.prototype.addEventListener) {
      const origEventTargetAdd = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = markAsNative(function(type, listener, ...opts) {
        if (type === 'message' && typeof listener === 'function') {
          const isMsgReceiver = (typeof Worker !== 'undefined' && this instanceof Worker)
            || (typeof MessagePort !== 'undefined' && this instanceof MessagePort)
            || (typeof ServiceWorkerContainer !== 'undefined' && this instanceof ServiceWorkerContainer);
          if (isMsgReceiver) {
            const wrapped = markAsNative(function(event) {
              if (event && event.data) alignWorkerFingerprintData(event.data);
              return listener.apply(this, arguments);
            });
            return origEventTargetAdd.call(this, type, wrapped, ...opts);
          }
        }
        return origEventTargetAdd.apply(this, arguments);
      }, 'addEventListener');
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
  } catch (_) {}
})();
`;
}
