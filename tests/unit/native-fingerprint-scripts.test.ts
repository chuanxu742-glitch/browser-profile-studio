import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { buildStealthInjectionScript, buildWorkerBootstrap } from '../../src/fingerprint/stealth-scripts.js';

function fixture(worker: boolean) {
  const context = createContext({});
  runInContext(`
    class Navigator {}
    class WorkerNavigator {}
    const proto = ${worker ? 'WorkerNavigator' : 'Navigator'}.prototype;
    for (const [name, value] of Object.entries({ hardwareConcurrency: 3, deviceMemory: 4,
        language: 'native-language', languages: ['native-language'] })) {
      Object.defineProperty(proto, name, { configurable: true, get: () => value });
    }
    globalThis.navigator = new ${worker ? 'WorkerNavigator' : 'Navigator'}();
    globalThis.self = globalThis;
    ${worker ? '' : 'globalThis.window = globalThis;'}
    class WebGLRenderingContext { getParameter() { return 'native-gpu'; } }
    class WebGL2RenderingContext extends WebGLRenderingContext {}
    class OffscreenCanvas { getContext() { return new WebGLRenderingContext(); } }
    class CanvasRenderingContext2D { getImageData() { return { data: new Uint8Array(4) }; } }
    class HTMLCanvasElement { toDataURL() { return 'data:fixture'; } }
    class AudioBuffer { getChannelData() { return new Float32Array(4); } }
    class AnalyserNode { getFloatFrequencyData() {} }
    globalThis.originals = { intl: Intl.DateTimeFormat,
      cores: Object.getOwnPropertyDescriptor(proto, 'hardwareConcurrency').get,
      memory: Object.getOwnPropertyDescriptor(proto, 'deviceMemory').get,
      language: Object.getOwnPropertyDescriptor(proto, 'language').get,
      gpu: WebGLRenderingContext.prototype.getParameter,
      canvas: CanvasRenderingContext2D.prototype.getImageData,
      audio: AudioBuffer.prototype.getChannelData };
  `, context);
  return context;
}

describe('native Chromium script handoff', () => {
  for (const worker of [false, true]) {
    it(`preserves native getters and GPU methods in ${worker ? 'workers' : 'pages'}`, () => {
      const profile = generateFingerprint({ engine: 'chromium', seed: 7 });
      const config = { ...profile, stealth: { ...profile.stealth, protectToString: false, mockPlugins: false } };
      const context = fixture(worker);
      const build = worker ? buildWorkerBootstrap : buildStealthInjectionScript;
      runInContext(build(config, { nativeChromium: true }), context);
      expect(runInContext(`[
        Intl.DateTimeFormat === originals.intl,
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'hardwareConcurrency').get === originals.cores,
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'deviceMemory').get === originals.memory,
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'language').get === originals.language,
        WebGLRenderingContext.prototype.getParameter === originals.gpu,
        CanvasRenderingContext2D.prototype.getImageData === originals.canvas,
        AudioBuffer.prototype.getChannelData === originals.audio
      ]`, context)).toEqual([true, true, true, true, true, true, true]);
      // Control: the same fixture must reach the hooks in the managed build.
      const stock = fixture(worker);
      runInContext(build(config), stock);
      expect(runInContext('navigator.hardwareConcurrency', stock)).toBe(profile.hardware.hardwareConcurrency);
      expect(runInContext('WebGLRenderingContext.prototype.getParameter === originals.gpu', stock)).toBe(false);
      if (!worker) {
        expect(runInContext('CanvasRenderingContext2D.prototype.getImageData === originals.canvas', stock)).toBe(false);
        expect(runInContext('AudioBuffer.prototype.getChannelData === originals.audio', stock)).toBe(false);
      }
    });
  }
});
