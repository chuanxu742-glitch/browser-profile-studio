// Evaluated in the page without reading page content or modifying application APIs.
export const ENVIRONMENT_PROBE: string = String.raw`(async () => {
  const snapshot = { errors: {}, deep: {} };
  const errorText = (error) => String(error && error.name ? error.name + ': ' + error.message : error).slice(0, 500);
  const capture = (name, read) => {
    try { const value = read(); if (value !== undefined) snapshot[name] = value; }
    catch (error) { snapshot.errors[name] = errorText(error); }
  };
  const observed = (value) => ({ status: 'observed', value });
  const unavailable = (error) => ({ status: 'unavailable', error });
  const deadline = async (promise, milliseconds) => {
    const { promise: expired, reject } = Promise.withResolvers();
    const timer = setTimeout(() => { const error = new Error('Probe deadline exceeded'); error.name = 'TimeoutError'; reject(error); }, milliseconds);
    try { return await Promise.race([promise, expired]); }
    finally { clearTimeout(timer); }
  };
  const attempt = async (probe) => {
    try { return await probe(); }
    catch (error) { return { status: error && error.name === 'TimeoutError' ? 'timeout' : 'error', error: errorText(error) }; }
  };
  for (const property of ['userAgent', 'platform', 'language', 'hardwareConcurrency', 'deviceMemory', 'webdriver']) {
    capture(property, () => navigator[property]);
  }
  capture('languages', () => navigator.languages === undefined ? undefined : Array.from(navigator.languages));
  capture('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone);
  capture('viewport', () => ({ width: innerWidth, height: innerHeight }));
  capture('screen', () => ({
    width: screen.width, height: screen.height, availWidth: screen.availWidth,
    availHeight: screen.availHeight, colorDepth: screen.colorDepth,
    pixelDepth: screen.pixelDepth, devicePixelRatio,
  }));
  let gl;
  let glCanvas;
  let foreignToString;
  let foreignSampleRateGetter;
  const nativeSource = (fn) => typeof fn === 'function' && /^function\s*[^{}]*\{\s*\[native code\]\s*\}$/.test(Reflect.apply(foreignToString, fn, []));
  try {
    capture('webgl', () => {
      glCanvas = document.createElement('canvas');
      gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
      if (!gl) throw new Error('WebGL context unavailable');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      if (!debug) throw new Error('Unmasked WebGL identity unavailable');
      return { vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
    });
    capture('integrity', () => {
      const props = ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'webdriver', 'languages', 'language'];
      const pollutedNavigatorProps = props.filter((property) => Object.hasOwn(navigator, property));
      return {
        hasNavigatorInstancePollution: pollutedNavigatorProps.length > 0,
        pollutedNavigatorProps,
        isNavigatorToStringNative: Object.prototype.toString.call(navigator) === '[object Navigator]',
        isFunctionToStringNative: Function.prototype.toString.call(Function.prototype.toString).includes('[native code]'),
        isWebglNative: !!gl && Function.prototype.toString.call(gl.getParameter).includes('[native code]'),
      };
    });
    snapshot.deep.crossRealm = await attempt(() => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      try {
        if (!document.documentElement) return unavailable('Document root unavailable');
        document.documentElement.appendChild(frame);
        if (!frame.contentWindow) return unavailable('Fresh iframe realm unavailable');
        foreignToString = frame.contentWindow.Function.prototype.toString;
        const audioPrototype = frame.contentWindow.BaseAudioContext && frame.contentWindow.BaseAudioContext.prototype;
        const sampleRateGetter = audioPrototype && Object.getOwnPropertyDescriptor(audioPrototype, 'sampleRate')?.get;
        if (nativeSource(sampleRateGetter)) foreignSampleRateGetter = sampleRateGetter;
        const getters = [];
        for (const property of ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver']) {
          let owner = navigator;
          let descriptor;
          while (owner && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(owner, property); owner = Object.getPrototypeOf(owner); }
          if (!descriptor) continue;
          const getter = descriptor.get;
          let rejectsIllegalReceiver = false;
          if (typeof getter === 'function') {
            try { Reflect.apply(getter, {}, []); }
            catch (error) { rejectsIllegalReceiver = error instanceof TypeError && error.name === 'TypeError'; }
          }
          getters.push({ property, nativeSource: nativeSource(getter), rejectsIllegalReceiver });
        }
        return observed({
          functionToStringNative: nativeSource(Function.prototype.toString),
          getters,
          ...(gl ? { webglNative: nativeSource(gl.getParameter) } : {}),
        });
      } finally { frame.remove(); }
    });
    snapshot.deep.css = await attempt(() => {
      if (typeof matchMedia !== 'function' || !snapshot.screen || !snapshot.viewport) return unavailable('CSS media or geometry unavailable');
      const s = snapshot.screen;
      const v = snapshot.viewport;
      return observed({
        screenWidthMatches: matchMedia('(device-width: ' + s.width + 'px)').matches,
        screenHeightMatches: matchMedia('(device-height: ' + s.height + 'px)').matches,
        resolutionMatches: matchMedia('(resolution: ' + s.devicePixelRatio + 'dppx)').matches,
        // CSS retains fractional compositor pixels; innerWidth/Height are
        // WebIDL integers. A half-CSS-pixel interval tests the rounding contract.
        viewportWidthMatches: Number.isFinite(v.width) && matchMedia('(min-width: ' + (v.width - 0.5) + 'px) and (max-width: ' + (v.width + 0.5) + 'px)').matches,
        viewportHeightMatches: Number.isFinite(v.height) && matchMedia('(min-height: ' + (v.height - 0.5) + 'px) and (max-height: ' + (v.height + 0.5) + 'px)').matches,
      });
    });
    snapshot.deep.canvas = await attempt(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 8;
      try {
        const context = canvas.getContext('2d');
        if (!context) return unavailable('Canvas 2D unavailable');
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          context.fillStyle = 'rgb(' + (17 + x * 25) + ',' + (29 + y * 23) + ',' + (41 + (x + y) * 11) + ')';
          context.fillRect(x, y, 1, 1);
        }
        const full = context.getImageData(0, 0, 8, 8).data;
        const repeat = context.getImageData(0, 0, 8, 8).data;
        const crop = context.getImageData(2, 3, 4, 3).data;
        let cropMatches = true;
        for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++) {
          if (crop[(y * 4 + x) * 4 + c] !== full[((y + 3) * 8 + x + 2) * 4 + c]) cropMatches = false;
        }
        return observed({ cropMatches, repeatMatches: full.every((value, index) => value === repeat[index]) });
      } finally { canvas.width = 0; canvas.height = 0; canvas.remove(); }
    });
    const [audio, worker, serviceWorker] = await Promise.all([
      attempt(async () => {
        const Realtime = window.AudioContext || window.webkitAudioContext;
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Realtime || !Offline) return unavailable('AudioContext or OfflineAudioContext unavailable');
        let realtime;
        try {
          realtime = new Realtime();
          const realtimeSampleRate = realtime.sampleRate;
          const nativeRealtimeSampleRate = foreignSampleRateGetter ? Reflect.apply(foreignSampleRateGetter, realtime, []) : undefined;
          const realtimeBufferSampleRate = realtime.createBuffer(1, 128, realtimeSampleRate).sampleRate;
          const renders = [];
          for (const requestedSampleRate of [44100, 48000]) {
            const offline = new Offline(1, 128, requestedSampleRate);
            const buffer = offline.createBuffer(1, 128, requestedSampleRate);
            const source = offline.createBufferSource();
            try {
              const silentBuffer = buffer.getChannelData(0).every((value) => value === 0);
              const copy = new Float32Array(128);
              copy.fill(1);
              buffer.copyFromChannel(copy, 0);
              source.buffer = buffer;
              source.connect(offline.destination);
              source.start();
              const rendered = await deadline(offline.startRendering(), 2000);
              renders.push({
                requestedSampleRate, contextSampleRate: offline.sampleRate,
                bufferSampleRate: buffer.sampleRate, renderedSampleRate: rendered.sampleRate,
                durationMatches: rendered.length === 128 && Math.abs(rendered.duration - 128 / requestedSampleRate) < 1e-9,
                silentBuffer, silentCopy: copy.every((value) => value === 0),
                silentRender: rendered.getChannelData(0).every((value) => value === 0),
              });
            } finally { source.disconnect(); }
          }
          return observed({ realtimeSampleRate, nativeRealtimeSampleRate, realtimeBufferSampleRate, renders });
        } finally { if (realtime && realtime.state !== 'closed') await deadline(realtime.close(), 1000); }
      }),
      attempt(async () => {
        if (typeof Worker !== 'function' || typeof Blob !== 'function') return unavailable('Blob Worker unavailable');
        const sample = () => {
          if (typeof OffscreenCanvas !== 'function') return null;
          const canvas = new OffscreenCanvas(8, 8);
          const context = canvas.getContext('2d');
          if (!context) return null;
          for (let index = 0; index < 64; index++) {
            context.fillStyle = 'rgb(' + (index * 3 % 256) + ',' + (index * 7 % 256) + ',' + (index * 11 % 256) + ')';
            context.fillRect(index % 8, Math.floor(index / 8), 1, 1);
          }
          const pixels = Array.from(context.getImageData(0, 0, 8, 8).data);
          const gpuCanvas = new OffscreenCanvas(1, 1);
          const gpu = gpuCanvas.getContext('webgl');
          let webgl;
          if (gpu) {
            try {
              const extension = gpu.getExtension('WEBGL_debug_renderer_info');
              if (extension) webgl = { vendor: gpu.getParameter(extension.UNMASKED_VENDOR_WEBGL), renderer: gpu.getParameter(extension.UNMASKED_RENDERER_WEBGL) };
            } finally {
              const lose = gpu.getExtension('WEBGL_lose_context');
              if (lose) lose.loseContext();
            }
          }
          return { canvas: pixels, webgl };
        };
        const pageRendering = sample();
        if (pageRendering) snapshot.canvas = pageRendering.canvas;
        // Capture at top-level, not in a later message handler: post-execution
        // Worker.evaluate cannot turn missing first-script injection into a pass.
        const source = "try { const identity = { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, languages: Array.from(navigator.languages), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hardwareConcurrency: navigator.hardwareConcurrency, ...(navigator.deviceMemory === undefined ? {} : { deviceMemory: navigator.deviceMemory }), ...(" + sample.toString() + ")() }; self.postMessage({ identity, serializedIdentity: JSON.stringify(identity), navigatorJSON: JSON.stringify(navigator) }); } catch (error) { self.postMessage({ probeError: String(error) }); }";
        let worker;
        let url;
        try {
          url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          worker = new Worker(url);
          const { promise, resolve, reject } = Promise.withResolvers();
          worker.onmessage = (event) => event.data && event.data.probeError ? reject(new Error(event.data.probeError)) : resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message || 'Blob Worker error'));
          worker.onmessageerror = () => reject(new Error('Blob Worker message deserialization failed'));
          const value = await deadline(promise, 3000);
          if (!value || !value.identity || typeof value.serializedIdentity !== 'string' || typeof value.navigatorJSON !== 'string') throw new Error('Malformed Blob Worker observation');
          return observed({ ...value, canvasMatches: pageRendering && Array.isArray(value.identity.canvas)
            ? pageRendering.canvas.length === value.identity.canvas.length && pageRendering.canvas.every((byte, index) => byte === value.identity.canvas[index])
            : undefined });
        } finally {
          if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
          if (url) URL.revokeObjectURL(url);
        }
      }),
      attempt(async () => {
        const container = navigator.serviceWorker;
        const state = {
          secureContext: isSecureContext,
          exposed: !!container,
          getRegistrationsCallable: !!container && typeof container.getRegistrations === 'function',
          registerCallable: !!container && typeof container.register === 'function',
          querySucceeded: false,
          controlled: !!container && !!container.controller,
          registrationAttempted: false,
        };
        if (!state.secureContext || !state.getRegistrationsCallable) return observed(state);
        const registrations = await deadline(container.getRegistrations(), 2000);
        if (!Array.isArray(registrations)) throw new Error('Invalid ServiceWorker registration list');
        return observed({ ...state, querySucceeded: true, registrationCount: registrations.length,
          ...(foreignToString ? { methodsNative: nativeSource(container.getRegistrations) && nativeSource(container.register) } : {}),
        });
      }),
    ]);
    snapshot.deep.audio = audio;
    snapshot.deep.worker = worker;
    snapshot.deep.serviceWorker = serviceWorker;
  } catch (error) {
    snapshot.errors.probe = errorText(error);
  } finally {
    if (gl) {
      try { const extension = gl.getExtension('WEBGL_lose_context'); if (extension) extension.loseContext(); }
      catch (error) { snapshot.errors.webglCleanup = errorText(error); }
    }
    if (glCanvas) { glCanvas.width = 0; glCanvas.height = 0; glCanvas.remove(); }
  }
  return snapshot;
})()`;
