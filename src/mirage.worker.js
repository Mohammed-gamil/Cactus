const MODEL_URL = 'https://huggingface.co/Cactus-Compute/mirage/resolve/main/mirage.cact';
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
    const cached = await cache.match(MODEL_URL);
    if (cached) {
      self.postMessage({ type: 'progress', phase: 'cached', loaded: 1, total: 1 });
      const buf = await cached.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch {
    // Cache API may be unavailable in some private browsing contexts; fall back to direct fetch
  }

  const response = await fetch(MODEL_URL, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`Failed to fetch Mirage weights (${response.status})`);
  }

  const total = Number(response.headers.get('content-length')) || 21611043;

  if (!response.body) {
    const buf = await response.arrayBuffer();
    self.postMessage({ type: 'progress', phase: 'downloading', loaded: buf.byteLength, total: buf.byteLength });
    return new Uint8Array(buf);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    self.postMessage({ type: 'progress', phase: 'downloading', loaded, total });
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (cache) {
    try {
      await cache.put(
        MODEL_URL,
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

async function initEngine() {
  if (isReady) {
    self.postMessage({ type: 'ready', cached: true });
    return;
  }

  try {
    self.postMessage({ type: 'progress', phase: 'wasm', loaded: 0, total: 1 });
    const jsRes = await fetch('/wasm/cactus.js');
    if (!jsRes.ok) throw new Error('Failed to load cactus.js');
    const jsCode = await jsRes.text();
    const factory = new Function(jsCode + '\nreturn createCactus;')();

    cactusModule = await factory({
      locateFile: (path) => `/wasm/${path}`,
    });

    const weights = await fetchWeightsWithProgress();

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
    }

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
  const outCap = 131072;
  let rgbPtr = 0;
  let outPtr = 0;
  let optsPtr = 0;
  let langPtr = 0;

  try {
    rgbPtr = m._malloc(rgb.byteLength);
    m.HEAPU8.set(rgb, rgbPtr);
    outPtr = m._malloc(outCap);

    if (options) {
      optsPtr = allocString(m, JSON.stringify(options));
    }
    if (language && language !== 'en') {
      langPtr = allocString(m, language);
    }

    const t0 = performance.now();
    const rc = m._cactus_describe(rgbPtr, width, height, optsPtr, langPtr, 0, outPtr, outCap);
    const elapsedMs = Math.round(performance.now() - t0);

    if (rc < 0) {
      const err = m.UTF8ToString(m._cactus_last_error());
      self.postMessage({ type: 'result', id, error: err || `Inference failed (${rc})`, elapsedMs });
      return;
    }

    const raw = m.UTF8ToString(outPtr);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    self.postMessage({ type: 'result', id, data, elapsedMs });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: err?.message || String(err) });
  } finally {
    if (rgbPtr) m._free(rgbPtr);
    if (outPtr) m._free(outPtr);
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
