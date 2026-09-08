// Invoked only by the explicit native binary smoke command, never by unit CI.
import assert from 'node:assert/strict';

export async function verifyRendering(page, profile) {
  const result = await page.evaluate(async () => {
    const bytes = canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, 24, 16).data);
    const paint = canvas => {
      canvas.width = 24; canvas.height = 16;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgb(93, 126, 167)'; ctx.fillRect(0, 0, 24, 16);
      ctx.fillStyle = 'rgba(20, 30, 40, 0.5)'; ctx.fillRect(5, 4, 8, 6);
      return canvas;
    };
    const canvas = paint(document.createElement('canvas'));
    const first = bytes(canvas), repeated = bytes(canvas);
    const crop = Array.from(canvas.getContext('2d').getImageData(3, 2, 7, 5).data);
    const cropExpected = [];
    for (let y = 2; y < 7; y++) cropExpected.push(...first.slice((y * 24 + 3) * 4, (y * 24 + 10) * 4));
    const decode = async blob => {
      const bitmap = await createImageBitmap(blob);
      const decoded = document.createElement('canvas'); decoded.width = 24; decoded.height = 16;
      decoded.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      return bytes(decoded);
    };
    const png = await decode(await (await fetch(canvas.toDataURL('image/png'))).blob());
    const blob = await decode(await new Promise(resolve => canvas.toBlob(resolve, 'image/png')));
    const offscreen = paint(new OffscreenCanvas(24, 16));
    const offscreenPixels = bytes(offscreen);
    const offscreenBlob = await decode(await offscreen.convertToBlob({ type: 'image/png' }));
    const clear = new OffscreenCanvas(1, 1).getContext('2d').getImageData(0, 0, 1, 1).data;

    const offline = new OfflineAudioContext(2, 4096, 44100);
    const oscillator = offline.createOscillator(); oscillator.frequency.value = 311;
    oscillator.connect(offline.destination); oscillator.start();
    let eventSamples;
    offline.oncomplete = e => { eventSamples = Array.from(e.renderedBuffer.getChannelData(0)); };
    const rendered = await offline.startRendering();
    const audio = Array.from(rendered.getChannelData(0));
    const audioAgain = Array.from(rendered.getChannelData(0));
    const copied = new Float32Array(4096); rendered.copyFromChannel(copied, 0);
    const writable = new AudioBuffer({ numberOfChannels: 1, length: 8, sampleRate: 44100 });
    writable.getChannelData(0).fill(0.25);
    const applicationSamples = new Float32Array(8); writable.copyFromChannel(applicationSamples, 0);
    const silent = await new OfflineAudioContext(1, 16, 44100).startRendering();
    // Suspend the renderer so float and byte queries observe one FFT snapshot.
    const analysisContext = new OfflineAudioContext(1, 1024, 44100);
    const source = analysisContext.createConstantSource(); source.offset.value = 0.25;
    const analyser = analysisContext.createAnalyser(); analyser.fftSize = 256;
    source.connect(analyser); analyser.connect(analysisContext.destination); source.start();
    const suspended = analysisContext.suspend(256 / 44100);
    const completion = analysisContext.startRendering();
    await suspended;
    const timeFloat = new Float32Array(256), timeByte = new Uint8Array(256);
    const frequencyFloat = new Float32Array(128), frequencyByte = new Uint8Array(128);
    analyser.getFloatTimeDomainData(timeFloat); analyser.getByteTimeDomainData(timeByte);
    analyser.getFloatFrequencyData(frequencyFloat); analyser.getByteFrequencyData(frequencyByte);
    const quantize = value => Math.floor(Math.max(0, Math.min(255, value)));
    const expectedTime = Array.from(timeFloat, value => quantize(128 * (value + 1)));
    const expectedFrequency = Array.from(frequencyFloat, value => quantize(
      255 * (value - analyser.minDecibels) / (analyser.maxDecibels - analyser.minDecibels)));
    await analysisContext.resume(); await completion;
    const gpu = {};
    for (const name of ['webgl', 'webgl2']) {
      const gl = new OffscreenCanvas(2, 2).getContext(name);
      if (!gl) { gpu[name] = { skipped: 'No backend context' }; continue; }
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      gpu[name] = debug ? {
        vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        invalidParameter: gl.getParameter(0xffffffff),
        error: gl.getError(),
      } : { skipped: 'Debug extension unavailable' };
    }
    const adapter = await navigator.gpu?.requestAdapter();
    gpu.webgpu = adapter ? {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      fallback: adapter.info.isFallbackAdapter,
      maxTexture: adapter.limits.maxTextureDimension2D,
    } : { skipped: 'No backend adapter' };
    const font = new FontFace('abs-allowed-font', 'local("Liberation Sans")');
    let allowedFont = false;
    try { await font.load(); allowedFont = true; } catch {}
    // This is an installed system family in the Linux workflow fixture.
    const excluded = new FontFace('abs-excluded-font', 'local("DejaVu Sans")');
    let excludedFont = false;
    try { await excluded.load(); excludedFont = true; } catch {}
    return { first, repeated, crop, cropExpected, png, blob, offscreenPixels, offscreenBlob,
      clear: Array.from(clear), audio, audioAgain, copied: Array.from(copied), eventSamples,
      applicationSamples: Array.from(applicationSamples), silence: Array.from(silent.getChannelData(0)),
      timeByte: Array.from(timeByte), expectedTime,
      frequencyByte: Array.from(frequencyByte), expectedFrequency,
      gpu, allowedFont, excludedFont };
  });
  for (const key of ['repeated', 'png', 'blob', 'offscreenPixels', 'offscreenBlob']) {
    assert.deepEqual(result[key], result.first, `Canvas mismatch: ${key}`);
  }
  assert.deepEqual(result.crop, result.cropExpected, 'Subrectangle must use absolute canvas coordinates');
  assert.deepEqual(result.clear, [0, 0, 0, 0]);
  for (const key of ['audioAgain', 'copied', 'eventSamples']) assert.deepEqual(result[key], result.audio, key);
  assert.deepEqual(result.applicationSamples, Array(8).fill(0.25), 'Writable audio must retain application data');
  assert.deepEqual(result.silence, Array(16).fill(0));
  assert.deepEqual(result.timeByte, result.expectedTime, 'Analyser time-domain representations must agree');
  assert.deepEqual(result.frequencyByte, result.expectedFrequency, 'Analyser frequency representations must agree');
  for (const kind of ['webgl', 'webgl2']) {
    const gl = result.gpu[kind];
    if (gl.skipped) continue;
    assert.equal(gl.vendor, profile.gpuVendor);
    assert.equal(gl.renderer, profile.gpuRenderer);
    assert(gl.maxTexture > 0);
    assert.equal(gl.invalidParameter, null);
    assert.equal(gl.error, 0x0500, 'GL_INVALID_ENUM semantics must be preserved');
  }
  if (!result.gpu.webgpu.skipped) {
    assert.equal(result.gpu.webgpu.vendor, profile.gpuVendor);
    assert.equal(result.gpu.webgpu.description, profile.gpuRenderer);
    assert(result.gpu.webgpu.maxTexture > 0);
  }
  if (process.platform === 'linux') {
    assert(result.allowedFont, 'Install fonts-liberation for the native font test');
    assert.equal(result.excludedFont, false, 'Native font allowlist must reject a local() lookup');
  }
  return { canvas: result.first, audio: result.audio, gpu: result.gpu,
    fonts: { allowed: result.allowedFont, excluded: result.excludedFont } };
}
