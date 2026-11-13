const LOCAL_MODEL_URL = '/models/mirage.cact';
const HF_MODEL_URL = 'https://huggingface.co/Cactus-Compute/mirage/resolve/main/mirage.cact';
const CACHE_NAME = 'mirage-weights-v1';

let cactusModule = null;
let isReady = false;
const encoder = new TextEncoder();

function allocString(m, str) {
  if (!str) return 0;
  const bytes = encoder.encode(str + '\0');
  const ptr = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, ptr);
  return ptr;
}

async function fetchWeightsWithProgress() {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = (await cache.match(LOCAL_MODEL_URL)) || (await cache.match(HF_MODEL_URL));
    if (cached) {
      self.postMessage({ type: 'progress', phase: 'cached', loaded: 1, total: 1 });
      const buf = await cached.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch {
    // Cache API may be unavailable in some private browsing contexts
  }

  let response = null;
  let usedUrl = LOCAL_MODEL_URL;
  try {
    response = await fetch(LOCAL_MODEL_URL);
    if (!response.ok) response = null;
  } catch {
    response = null;
  }

  if (!response) {
    usedUrl = HF_MODEL_URL;
    response = await fetch(HF_MODEL_URL, { mode: 'cors' });
    if (!response.ok) {
      throw new Error(`Failed to fetch Mirage weights (${response.status})`);
    }
  }

  const contentLen = Number(response.headers.get('content-length')) || 0;
  const total = contentLen || 21611043;

  if (!response.body) {
    const buf = await response.arrayBuffer();
    self.postMessage({ type: 'progress', phase: 'downloading', loaded: buf.byteLength, total: buf.byteLength });
    return new Uint8Array(buf);
  }

  const reader = response.body.getReader();
  let merged = contentLen > 0 ? new Uint8Array(contentLen) : null;
  const chunks = merged ? null : [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (merged && loaded + value.byteLength <= merged.byteLength) {
      merged.set(value, loaded);
    } else if (merged) {
      // Content-Length was smaller than actual body; fall back to growing
      const grown = new Uint8Array(loaded + value.byteLength);
      grown.set(merged.subarray(0, loaded), 0);
      grown.set(value, loaded);
      merged = grown;
    } else {
      chunks.push(value);
    }
    loaded += value.byteLength;
    self.postMessage({ type: 'progress', phase: 'downloading', loaded, total });
  }

  if (!merged) {
    merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else if (loaded < merged.byteLength) {
    merged = merged.subarray(0, loaded);
  }

  if (cache) {
    try {
      await cache.put(
        usedUrl,
        new Response(merged, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(merged.byteLength) },
        })
      );
    } catch {
      // Ignore quota errors
    }
  }

  return merged;
}

const OUT_CAPACITY = 131072;
let persistentOutPtr = 0;
let persistentRgbPtr = 0;
let persistentRgbCap = 0;

async function initEngine() {
  if (isReady) {
    self.postMessage({ type: 'ready', cached: true });
    return;
  }

  try {
    self.postMessage({ type: 'progress', phase: 'wasm', loaded: 0, total: 1 });
    const [jsRes, wasmRes] = await Promise.all([
      fetch('/wasm/cactus.js'),
      fetch('/wasm/cactus.wasm'),
    ]);
    if (!jsRes.ok) throw new Error(`Failed to load cactus.js (${jsRes.status})`);
    if (!wasmRes.ok) throw new Error(`Failed to load cactus.wasm (${wasmRes.status})`);

    let [jsCode, wasmBinary] = await Promise.all([
      jsRes.text(),
      wasmRes.arrayBuffer(),
    ]);
    const factory = new Function(jsCode + '\nreturn createCactus;')();
    jsCode = null;

    cactusModule = await factory({ wasmBinary });
    wasmBinary = null;

    let weights = await fetchWeightsWithProgress();

    self.postMessage({ type: 'progress', phase: 'mounting', loaded: 1, total: 1 });
    const ptr = cactusModule._malloc(weights.byteLength);
    try {
      cactusModule.HEAPU8.set(weights, ptr);
      const rc = cactusModule._cactus_load(ptr, BigInt(weights.byteLength));
      if (rc < 0) {
        const err = cactusModule.UTF8ToString(cactusModule._cactus_last_error());
        throw new Error(err || `cactus_load failed (${rc})`);
      }
    } finally {
      cactusModule._free(ptr);
      weights = null;
    }

    // Preallocate reusable scratch buffers so inferences never fragment WASM heap
    persistentOutPtr = cactusModule._malloc(OUT_CAPACITY);
    persistentRgbCap = 320 * 320 * 3;
    persistentRgbPtr = cactusModule._malloc(persistentRgbCap);

    isReady = true;
    self.postMessage({ type: 'ready', models: cactusModule._cactus_models() });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
}

function runDescribe({ id, rgbBuffer, width, height, language = 'en', options = null }) {
  if (!isReady || !cactusModule) {
    self.postMessage({ type: 'result', id, error: 'Engine not initialized' });
    return;
  }

  const m = cactusModule;
  const rgb = new Uint8Array(rgbBuffer);
  let optsPtr = 0;
  let langPtr = 0;

  try {
    if (rgb.byteLength > persistentRgbCap) {
      if (persistentRgbPtr) m._free(persistentRgbPtr);
      persistentRgbCap = rgb.byteLength;
      persistentRgbPtr = m._malloc(persistentRgbCap);
    }
    m.HEAPU8.set(rgb, persistentRgbPtr);

    if (options) {
      optsPtr = allocString(m, JSON.stringify(options));
    }
    if (language && language !== 'en') {
      langPtr = allocString(m, language);
    }

    const t0 = performance.now();
    const rc = m._cactus_describe(persistentRgbPtr, width, height, optsPtr, langPtr, 0, persistentOutPtr, OUT_CAPACITY);
    const elapsedMs = Math.round(performance.now() - t0);

    if (rc < 0) {
      const err = m.UTF8ToString(m._cactus_last_error());
      self.postMessage({ type: 'result', id, error: err || `Inference failed (${rc})`, elapsedMs });
      return;
    }

    const raw = m.UTF8ToString(persistentOutPtr);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    if (typeof m._cactus_reset === 'function') {
      m._cactus_reset();
    }

    self.postMessage({ type: 'result', id, data, elapsedMs });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: err?.message || String(err) });
  } finally {
    if (optsPtr) m._free(optsPtr);
    if (langPtr) m._free(langPtr);
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    initEngine();
  } else if (msg.type === 'describe') {
    runDescribe(msg);
  }
};
