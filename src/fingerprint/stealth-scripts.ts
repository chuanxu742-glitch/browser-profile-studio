import type { FingerprintConfig } from './types.js';

/** Workers are injected in their own realm by the launcher, before their script runs. */
export function buildWorkerBootstrap(config: FingerprintConfig): string {
  return buildRealmBootstrap(config);
}

export function buildStealthInjectionScript(config: FingerprintConfig): string {
  return buildRealmBootstrap(config);
}

function buildRealmBootstrap(config: FingerprintConfig): string {
  return `(() => {
  'use strict';
  const config = ${JSON.stringify(config)};
  const apply = Reflect.apply;
  const nativeSource = Function.prototype.toString;
  const descriptor = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;

  // Native targets preserve WebIDL brands, name, length and non-constructibility.
  // A Proxy is opaque even to another realm's unmodified Function#toString.
  // Do not replace Function#toString or attach a bootstrap marker to the global.
  function wrap(owner, key, intercept, slot = 'value') {
    if (!owner) return;
    const desc = descriptor(owner, key);
    const original = desc && desc[slot];
    if (typeof original !== 'function') return;
    // Leave an already interposed native Proxy alone, including on reinjection.
    if (/^function\\s*\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$/.test(apply(nativeSource, original, []))) return;
    define(owner, key, { ...desc, [slot]: new Proxy(original, { apply: intercept }) });
  }

  function nativeGetter(owner, key, value) {
    const desc = owner && descriptor(owner, key);
    if (!desc || !desc.get || apply(desc.get, navigator, []) === value) return;
    wrap(owner, key, (target, receiver, args) => {
      apply(target, receiver, args);
      return value;
    }, 'get');
  }

  const navProto = typeof navigator === 'undefined' ? undefined : Object.getPrototypeOf(navigator);
  if (config.hardware) {
    nativeGetter(navProto, 'hardwareConcurrency', config.hardware.hardwareConcurrency);
    nativeGetter(navProto, 'deviceMemory', config.hardware.deviceMemory);
    nativeGetter(navProto, 'maxTouchPoints', config.hardware.maxTouchPoints);
  }
  if (config.stealth.removeWebdriver) nativeGetter(navProto, 'webdriver', false);
  if (typeof WorkerNavigator !== 'undefined' && navProto) {
    const languages = Object.freeze([...config.geo.languages]);
    for (const [key, value] of [
      ['userAgent', config.userAgent],
      ['appVersion', config.appVersion],
      ['platform', config.hardware.platform || config.platform],
      ['language', languages[0] || config.geo.locale],
      ['languages', languages],
    ]) {
      const desc = descriptor(navProto, key);
      if (!desc || typeof desc.get !== 'function') continue;
      const current = apply(desc.get, navigator, []);
      const matches = key === 'languages'
        ? current.length === languages.length && languages.every((language, index) => current[index] === language)
        : current === value;
      if (!matches) nativeGetter(navProto, key, value);
    }
  }

  // UA/UA-CH, locale, timezone, screen, DPR and WebRTC routing belong to the
  // browser configuration. Preserve native capability, permission and device APIs.
  if (config.webrtc === 'disable') {
    for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      const desc = descriptor(globalThis, key);
      if (desc && 'value' in desc && desc.configurable) {
        define(globalThis, key, { ...desc, value: undefined });
      }
    }
  }

  if (config.webgl) {
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const ctor = globalThis[name];
      wrap(ctor && ctor.prototype, 'getParameter', (target, receiver, args) => {
        const result = apply(target, receiver, args);
        // Invalid enums, disabled extensions and lost contexts return null and
        // retain their native GL error. Never consume getError to inspect them.
        if (result === null || args.length === 0) return result;
        const arg = args[0];
        if (typeof arg !== 'number' && typeof arg !== 'string') return result;
        const param = Number(arg) >>> 0;
        if (param === 37445) return config.webgl.unmaskedVendor || config.webgl.vendor;
        if (param === 37446) return config.webgl.unmaskedRenderer || config.webgl.renderer;
        if (param === 7936) return config.webgl.vendor;
        if (param === 7937) return config.webgl.renderer;
        if (param === 3379 && Number.isFinite(config.webgl.maxTextureSize)) {
          return Math.min(result, config.webgl.maxTextureSize);
        }
        return result;
      });
    }
  }

  if (config.canvas && config.canvas.enabled) {
    const seed = config.canvas.seed >>> 0;
    function mix(value) {
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      return (value ^ (value >>> 16)) >>> 0;
    }
    // Project onto a seed-specific set of RGB values rather than adding noise.
    // P(P(pixel)) = P(pixel), including when pixels cross realms, are written
    // back, or make a lossless image round trip. No source/URL provenance leaks.
    // Position-independent projection is consistent at every global coordinate;
    // native getImageData alone handles crop origins and negative dimensions.
    function project(image) {
      const data = image.data;
      // Float16 and premultiplied translucent pixels require a native solution:
      // their encoding/rounding cannot preserve this 8-bit projection invariant.
      if (Object.prototype.toString.call(data) !== '[object Uint8ClampedArray]') return image;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] !== 255) continue;
        const red = data[index] & 254;
        const green = data[index + 1] & 254;
        const blue = data[index + 2] & 254;
        const bits = mix(seed ^ (red << 16) ^ (green << 8) ^ blue);
        data[index] = red | (bits & 1);
        data[index + 1] = green | ((bits >>> 1) & 1);
        data[index + 2] = blue | ((bits >>> 2) & 1);
      }
      return image;
    }

    const contextMethods = new Map();
    for (const name of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) {
      const ctor = globalThis[name];
      if (!ctor) continue;
      const proto = ctor.prototype;
      const get = descriptor(proto, 'getImageData');
      const put = descriptor(proto, 'putImageData');
      const draw = descriptor(proto, 'drawImage');
      if (!get || !put || !draw) continue;
      contextMethods.set(proto, { get: get.value, put: put.value, draw: draw.value });
      wrap(proto, 'getImageData', (target, receiver, args) => project(apply(target, receiver, args)));
    }

    const htmlProto = typeof HTMLCanvasElement === 'undefined' ? undefined : HTMLCanvasElement.prototype;
    const offscreenProto = typeof OffscreenCanvas === 'undefined' ? undefined : OffscreenCanvas.prototype;
    const htmlWidth = htmlProto && descriptor(htmlProto, 'width').get;
    const htmlHeight = htmlProto && descriptor(htmlProto, 'height').get;
    const offscreenWidth = offscreenProto && descriptor(offscreenProto, 'width').get;
    const offscreenHeight = offscreenProto && descriptor(offscreenProto, 'height').get;
    const htmlContext = htmlProto && htmlProto.getContext;
    const offscreenContext = offscreenProto && offscreenProto.getContext;
    const createElement = typeof document === 'undefined' ? undefined : document.createElement;
    const Offscreen = globalThis.OffscreenCanvas;

    function projectedCanvas(source, offscreen) {
      const width = apply(offscreen ? offscreenWidth : htmlWidth, source, []);
      const height = apply(offscreen ? offscreenHeight : htmlHeight, source, []);
      if (!width || !height) return null;
      const canvas = offscreen ? new Offscreen(width, height) : apply(createElement, document, ['canvas']);
      if (!offscreen) { canvas.width = width; canvas.height = height; }
      const context = apply(offscreen ? offscreenContext : htmlContext, canvas, ['2d']);
      if (!context) return null;
      const methods = contextMethods.get(Object.getPrototypeOf(context));
      if (!methods) return null;
      apply(methods.draw, context, [source, 0, 0]);
      const image = project(apply(methods.get, context, [0, 0, width, height]));
      apply(methods.put, context, [image, 0, 0]);
      return canvas;
    }

    // Some Firefox encoders append a per-process, non-rendering deBG nonce.
    // Remove only that verified ancillary chunk, never forge a seeded marker.
    // Pixel/color/compression chunks and their original CRCs remain byte-exact.
    let crcTable;
    function normalizePng(bytes) {
      if (bytes.length < 45 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71
        || bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10) return bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const removed = [];
      let offset = 8, hasData = false, ended = false, removedSize = 0;
      while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) return bytes;
        const type = view.getUint32(offset + 4);
        if (offset === 8 && (type !== 0x49484452 || length !== 13)) return bytes;
        if (offset !== 8 && type === 0x49484452) return bytes;
        // Unknown critical chunks cannot be normalized safely.
        if (!(bytes[offset + 4] & 32) && ![0x49484452, 0x504c5445, 0x49444154, 0x49454e44].includes(type)) return bytes;
        if (type === 0x49444154) hasData = true;
        if (type === 0x64654247) {
          if (length !== 16) return bytes;
          for (let index = offset + 8; index < end - 4; index++) {
            const value = bytes[index];
            if (!(value >= 48 && value <= 57 || value >= 65 && value <= 70 || value >= 97 && value <= 102)) return bytes;
          }
          removed.push([offset, end]);
          removedSize += end - offset;
        }
        offset = end;
        if (type === 0x49454e44) {
          if (length !== 0 || end !== bytes.length) return bytes;
          ended = true;
          break;
        }
      }
      if (!ended || !hasData || !removed.length) return bytes;
      if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let index = 0; index < 256; index++) {
          let crc = index;
          for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
          crcTable[index] = crc;
        }
      }
      for (let start = 8; start < bytes.length;) {
        const end = start + 12 + view.getUint32(start);
        let crc = 0xffffffff;
        for (let index = start + 4; index < end - 4; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
        if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) return bytes;
        start = end;
      }
      const result = new Uint8Array(bytes.length - removedSize);
      let source = 0, destination = 0;
      for (const [start, end] of removed) {
        result.set(bytes.subarray(source, start), destination);
        destination += start - source;
        source = end;
      }
      result.set(bytes.subarray(source), destination);
      return result;
    }
    const decode64 = globalThis.atob;
    const encode64 = globalThis.btoa;
    const BlobClass = globalThis.Blob;
    const blobArrayBuffer = BlobClass && BlobClass.prototype.arrayBuffer;
    const enqueueMicrotask = globalThis.queueMicrotask;
    function normalizeDataURL(value) {
      const prefix = 'data:image/png;base64,';
      if (!value.startsWith(prefix)) return value;
      let binary;
      try { binary = apply(decode64, globalThis, [value.slice(prefix.length)]); } catch { return value; }
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const normalized = normalizePng(bytes);
      if (normalized === bytes) return value;
      const chunks = [];
      for (let index = 0; index < normalized.length; index += 8192) chunks.push(String.fromCharCode(...normalized.subarray(index, index + 8192)));
      return prefix + apply(encode64, globalThis, [chunks.join('')]);
    }
    async function normalizeBlob(blob) {
      if (!blob || blob.type !== 'image/png') return blob;
      const bytes = new Uint8Array(await apply(blobArrayBuffer, blob, []));
      const normalized = normalizePng(bytes);
      return normalized === bytes ? blob : new BlobClass([normalized], { type: blob.type });
    }

    // Conversion remains inside the native call, after its receiver checks.
    // Capture object conversion once, then replay the primitive on our snapshot.
    // HTML's quality parameter is WebIDL any: boxed numbers are intentionally
    // not coerced. Offscreen's dictionary quality is converted to a number.
    function captureConversion(value, numeric, save) {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        save(value);
        return value;
      }
      return {
        [Symbol.toPrimitive]() {
          const primitive = numeric ? +value : String(value);
          save(primitive);
          return primitive;
        },
      };
    }

    wrap(htmlProto, 'toDataURL', (target, receiver, args) => {
      const replay = args.slice();
      const nativeArgs = args.slice();
      if (args.length) nativeArgs[0] = captureConversion(args[0], false, value => { replay[0] = value; });
      const original = apply(target, receiver, nativeArgs);
      const canvas = projectedCanvas(receiver, false);
      return normalizeDataURL(canvas ? apply(target, canvas, replay) : original);
    });

    wrap(htmlProto, 'toBlob', (target, receiver, args) => {
      if (typeof args[0] !== 'function') return apply(target, receiver, args);
      const callback = args[0];
      const replay = args.slice();
      replay[0] = function(blob) {
        const receiver = this;
        if (!blob || blob.type !== 'image/png') return apply(callback, receiver, [blob]);
        const deliver = value => apply(enqueueMicrotask, globalThis, [() => apply(callback, receiver, [value])]);
        normalizeBlob(blob).then(deliver, error => {
          // Preserve the native result if normalization cannot read it, and
          // report that failure without converting callback throws to rejections.
          deliver(blob);
          apply(enqueueMicrotask, globalThis, [() => { throw error; }]);
        });
      };
      let canvas;
      const wrappedArgs = args.slice();
      wrappedArgs[0] = function(blob) {
        if (canvas && blob) return apply(target, canvas, replay);
        return apply(replay[0], this, [blob]);
      };
      if (args.length > 1) wrappedArgs[1] = captureConversion(args[1], false, value => { replay[1] = value; });
      const result = apply(target, receiver, wrappedArgs);
      canvas = projectedCanvas(receiver, false);
      return result;
    });

    wrap(offscreenProto, 'convertToBlob', (target, receiver, args) => {
      const options = args[0];
      const captured = {};
      let nativeArgs = args;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') return apply(target, receiver, args);
        nativeArgs = args.slice();
        // A separate dictionary avoids Proxy invariant violations for frozen
        // option objects whose values themselves require conversion.
        const dictionary = Object.create(null);
        for (const key of ['quality', 'type']) {
          define(dictionary, key, {
            get() {
              return captureConversion(Reflect.get(options, key, options), key === 'quality', value => {
                captured[key] = value;
              });
            },
          });
        }
        nativeArgs[0] = dictionary;
      }
      const result = apply(target, receiver, nativeArgs);
      let canvas;
      try {
        canvas = projectedCanvas(receiver, true);
      } catch {
        // Brand, taint, detached and zero-size failures belong to the native
        // promise above, not an extra synchronous exception from our snapshot.
        return result;
      }
      return result.then(blob => canvas && blob ? apply(target, canvas, [captured]) : blob).then(normalizeBlob);
    });
  }

  if (config.audio && config.audio.enabled && typeof AudioBuffer !== 'undefined') {
    const adjusted = new WeakSet();
    const getChannelData = AudioBuffer.prototype.getChannelData;
    const channelCount = descriptor(AudioBuffer.prototype, 'numberOfChannels').get;
    const seed = config.audio.seed >>> 0;
    function adjustRenderedBuffer(buffer) {
      if (adjusted.has(buffer)) return buffer;
      const channels = apply(channelCount, buffer, []);
      for (let channel = 0; channel < channels; channel++) {
        const data = apply(getChannelData, buffer, [channel]);
        const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
        for (let index = 0; index < words.length; index++) {
          const word = words[index];
          // Leave silence (including negative zero), infinities and NaNs intact.
          if ((word & 0x7fffffff) === 0 || (word & 0x7f800000) === 0x7f800000) continue;
          let bits = Math.imul(seed ^ Math.imul(channel + 1, 0x9e3779b9) ^ index, 0x45d9f3b);
          bits = Math.imul(bits ^ (bits >>> 16), 0x45d9f3b);
          words[index] = (word & 0xfffffff8) | ((bits ^ (bits >>> 16)) & 7);
        }
      }
      adjusted.add(buffer);
      return buffer;
    }
    const offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    wrap(offline && offline.prototype, 'startRendering', (target, receiver, args) => {
      const promise = apply(target, receiver, args);
      return promise.then(adjustRenderedBuffer);
    });
    const completion = globalThis.OfflineAudioCompletionEvent;
    wrap(completion && completion.prototype, 'renderedBuffer', (target, receiver, args) => {
      const buffer = apply(target, receiver, args);
      // Synthetic completion events may carry an application-owned AudioBuffer.
      // Only actual rendering completion is eligible for seed perturbation.
      return receiver.isTrusted ? adjustRenderedBuffer(buffer) : buffer;
    }, 'get');
  }
})();`;
}
