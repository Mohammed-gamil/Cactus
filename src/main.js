import './style.css';
import { QUESTS, LANGUAGES } from './quests.js';
import { renderOverlays, hitTestObject } from './overlay.js';

const STORAGE_KEY = 'mirage_quest_v1';

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      xp: Number(saved.xp) || 0,
      questIndex: Number(saved.questIndex) || 0,
      completedQuests: Array.isArray(saved.completedQuests) ? saved.completedQuests : [],
      dex: saved.dex && typeof saved.dex === 'object' ? saved.dex : {},
    };
  } catch {
    return { xp: 0, questIndex: 0, completedQuests: [], dex: {} };
  }
}

function saveProgress() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        xp: state.xp,
        questIndex: state.questIndex,
        completedQuests: state.completedQuests,
        dex: state.dex,
      })
    );
  } catch {
    // Ignore storage errors
  }
}

const saved = loadProgress();

const state = {
  engineReady: false,
  engineLoading: false,
  loadPhase: 'idle',
  loadPct: 0,
  loadLabel: '',
  mode: saved.completedQuests.length >= QUESTS.length ? 'sandbox' : 'quest',
  xp: saved.xp,
  questIndex: Math.min(saved.questIndex, QUESTS.length - 1),
  completedQuests: saved.completedQuests,
  dex: saved.dex,
  language: 'en',
  facingMode: 'environment',
  cameraActive: false,
  stream: null,
  frozenUrl: null,
  inferring: false,
  lastResult: null,
  lastElapsedMs: null,
  lastFeedback: null,
  selectedObjectId: null,
  openSheet: null, // 'inspect' | 'dex' | null
};

let worker = null;
let reqId = 0;
const pending = new Map();
let inferTimerInterval = null;
let inferTimeout = null;
let inferStartTime = 0;

function createWorker() {
  if (worker) {
    worker.terminate();
  }
  worker = new Worker(new URL('./mirage.worker.js', import.meta.url), { type: 'module' });

  worker.onerror = (err) => {
    clearInferTimers();
    if (state.inferring) {
      state.inferring = false;
      state.lastResult = { error: `Worker error: ${err.message || 'WASM crashed — tap LIVE to retry'}` };
      pending.clear();
      // Re-initialize worker in background
      state.engineReady = false;
      createWorker();
      worker.postMessage({ type: 'init' });
      renderStage();
      renderResultStrip();
      renderBottomDock();
    } else if (state.engineLoading) {
      state.engineLoading = false;
      state.loadLabel = `Worker error: ${err.message || 'Failed to start'}`;
      updateProgressUI();
    }
  };

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      state.loadPhase = msg.phase;
      if (msg.phase === 'wasm') {
        state.loadPct = 8;
        state.loadLabel = 'Loading WebAssembly engine (1.2 MB)...';
      } else if (msg.phase === 'cached') {
        state.loadPct = 85;
        state.loadLabel = 'Found cached weights on device...';
      } else if (msg.phase === 'downloading') {
        const mbLoaded = (msg.loaded / 1048576).toFixed(1);
        const mbTotal = (msg.total / 1048576).toFixed(1);
        const ratio = msg.total > 0 ? msg.loaded / msg.total : 0;
        state.loadPct = Math.min(92, Math.round(10 + ratio * 82));
        state.loadLabel = `Downloading Mirage (${mbLoaded} / ${mbTotal} MB)...`;
      } else if (msg.phase === 'mounting') {
        state.loadPct = 96;
        state.loadLabel = 'Mounting 2-bit weights into memory...';
      }
      updateProgressUI();
    } else if (msg.type === 'ready') {
      state.engineReady = true;
      state.engineLoading = false;
      state.loadPct = 100;
      render();
      if (!state.frozenUrl) startCamera();
    } else if (msg.type === 'error') {
      state.engineLoading = false;
      state.loadLabel = `Error: ${msg.message}`;
      updateProgressUI();
      const btn = document.getElementById('wake-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Retry Awakening';
      }
    } else if (msg.type === 'result') {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  };
}

function clearInferTimers() {
  if (inferTimerInterval) {
    clearInterval(inferTimerInterval);
    inferTimerInterval = null;
  }
  if (inferTimeout) {
    clearTimeout(inferTimeout);
    inferTimeout = null;
  }
}

function cancelInference(reason = 'Scan cancelled') {
  if (!state.inferring) return;
  clearInferTimers();
  pending.clear();
  state.inferring = false;
  state.lastResult = { error: reason };
  // Restart worker cleanly so WASM memory/decoder is fresh
  state.engineReady = false;
  createWorker();
  worker.postMessage({ type: 'init' });
  renderStage();
  renderResultStrip();
  renderBottomDock();
}

createWorker();

function wakeMirage() {
  if (state.engineLoading || state.engineReady) return;
  state.engineLoading = true;
  state.loadPct = 4;
  state.loadLabel = 'Starting worker...';
  render();
  worker.postMessage({ type: 'init' });
}

function updateProgressUI() {
  const fill = document.getElementById('load-progress-fill');
  const label = document.getElementById('load-progress-label');
  const pct = document.getElementById('load-progress-pct');
  if (fill) fill.style.width = `${state.loadPct}%`;
  if (label) label.textContent = state.loadLabel;
  if (pct) pct.textContent = `${state.loadPct}%`;
}

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    state.cameraActive = false;
    renderStage();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: 1024 },
        height: { ideal: 1024 },
      },
      audio: false,
    });
    state.stream = stream;
    state.cameraActive = true;
    state.frozenUrl = null;
    state.lastResult = null;
    state.selectedObjectId = null;
    renderStage();
    const video = document.getElementById('camera-video');
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => {});
    }
  } catch {
    state.cameraActive = false;
    renderStage();
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  state.cameraActive = false;
}

function extractRgbFromSource(sourceEl, srcW, srcH) {
  const maxDim = 320;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(32, Math.round(srcW * scale));
  const h = Math.max(32, Math.round(srcH * scale));

  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(sourceEl, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < imgData.length; i += 4, j += 3) {
    rgb[j] = imgData[i];
    rgb[j + 1] = imgData[i + 1];
    rgb[j + 2] = imgData[i + 2];
  }

  return { rgb, width: w, height: h, previewDataUrl: offscreen.toDataURL('image/jpeg', 0.85) };
}

async function runInferenceOnSource(sourceEl, srcW, srcH) {
  if (!state.engineReady || state.inferring) return;
  state.inferring = true;
  state.lastResult = null;
  state.lastElapsedMs = null;
  state.selectedObjectId = null;
  state.lastFeedback = null;
  inferStartTime = performance.now();

  const { rgb, width, height, previewDataUrl } = extractRgbFromSource(sourceEl, srcW, srcH);

  // Freeze frame so overlays align cleanly
  stopCamera();
  state.frozenUrl = previewDataUrl;
  renderStage();
  renderBottomDock();

  clearInferTimers();
  inferTimerInterval = setInterval(() => {
    const pill = document.getElementById('infer-timer-pill');
    if (pill) {
      const sec = ((performance.now() - inferStartTime) / 1000).toFixed(1);
      pill.textContent = `Scanning ${sec}s`;
    }
  }, 150);
  inferTimeout = setTimeout(() => {
    cancelInference('Scan timed out after 45s — try better lighting or a closer shot');
  }, 45000);

  const id = ++reqId;
  const resultPromise = new Promise((resolve) => pending.set(id, resolve));
  worker.postMessage(
    {
      type: 'describe',
      id,
      rgbBuffer: rgb.buffer,
      width,
      height,
      language: state.language,
      options: { conf: 0.25, text_conf: 0.25, max_objects: 8, max_text_lines: 8, max_tokens: 160 },
    },
    [rgb.buffer]
  );

  const res = await resultPromise;
  clearInferTimers();
  state.inferring = false;

  if (res.error) {
    state.lastResult = { error: res.error };
    state.lastElapsedMs = res.elapsedMs || null;
  } else {
    state.lastResult = res.data;
    state.lastElapsedMs = res.elapsedMs;
    recordDexDiscoveries(res.data);

    if (state.mode === 'quest') {
      const quest = QUESTS[state.questIndex];
      if (quest) {
        const check = quest.check(res.data);
        state.lastFeedback = check;
        if (check.passed && !state.completedQuests.includes(quest.id)) {
          state.completedQuests.push(quest.id);
          state.xp += quest.xp;
          saveProgress();
        }
      }
    }
  }

  renderHeader();
  renderQuestCard();
  renderStage();
  renderResultStrip();
  renderBottomDock();
}

function recordDexDiscoveries(data) {
  const objs = Array.isArray(data?.objects) ? data.objects : [];
  let updated = false;
  for (const obj of objs) {
    const key = (obj.name || '').trim().toLowerCase();
    if (!key || key === 'object') continue;
    const score = typeof obj.score === 'number' ? Math.round(obj.score * 100) : 0;
    const prev = state.dex[key];
    if (!prev || score > prev.bestScore) {
      state.dex[key] = {
        name: obj.name,
        color: obj.description?.color || prev?.color || '',
        material: obj.description?.material || prev?.material || '',
        bestScore: Math.max(score, prev?.bestScore || 0),
        count: (prev?.count || 0) + 1,
      };
      updated = true;
    } else {
      prev.count += 1;
      updated = true;
    }
  }
  if (updated) saveProgress();
}

function loadImageAndRun(url) {
  const img = new Image();
  if (!url.startsWith('data:') && !url.startsWith('blob:')) {
    img.crossOrigin = 'anonymous';
  }
  img.onload = () => {
    runInferenceOnSource(img, img.naturalWidth, img.naturalHeight);
  };
  img.onerror = () => {
    state.lastResult = { error: 'Could not load that image. Try another photo or sample.' };
    renderResultStrip();
  };
  img.src = url;
}

function loadFileAndRun(file) {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      loadImageAndRun(reader.result);
    }
  };
  reader.onerror = () => {
    state.lastResult = { error: 'Could not read the selected file.' };
    renderResultStrip();
  };
  reader.readAsDataURL(file);
}

function syncCanvasOverlay() {
  const canvas = document.getElementById('overlay-canvas');
  const img = document.getElementById('frozen-img');
  const wrap = document.getElementById('stage-wrap');
  if (!canvas || !wrap) return;

  if (!img || !state.frozenUrl) {
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Position canvas exactly over the object-fit: contain image box
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  const natW = img.naturalWidth || 512;
  const natH = img.naturalHeight || 512;
  const scale = Math.min(wrapW / natW, wrapH / natH);
  const dispW = Math.round(natW * scale);
  const dispH = Math.round(natH * scale);
  const left = Math.round((wrapW - dispW) / 2);
  const top = Math.round((wrapH - dispH) / 2);

  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;
  canvas.style.width = `${dispW}px`;
  canvas.style.height = `${dispH}px`;
  canvas.width = dispW;
  canvas.height = dispH;

  renderOverlays(canvas, state.lastResult, state.selectedObjectId);
}

function render() {
  const app = document.getElementById('app');
  if (!state.engineReady) {
    app.innerHTML = `
      <div class="phone-shell">
        ${headerHTML()}
        <main class="splash-view">
          <div class="splash-hero">
            <div class="splash-emblem" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </div>
            <h1>Mirage Quest</h1>
            <p>Turn your phone into an offline vision explorer. Spot objects, decode text, and map scenes with a 22&nbsp;MB neural model running locally in WebAssembly.</p>
            <div class="spec-row">
              <div class="spec-tile">
                <div class="spec-val">21.6 MB</div>
                <div class="spec-lbl">2-bit weights</div>
              </div>
              <div class="spec-tile">
                <div class="spec-val">51.3M</div>
                <div class="spec-lbl">Parameters</div>
              </div>
              <div class="spec-tile">
                <div class="spec-val">0 Cloud</div>
                <div class="spec-lbl">100% On-device</div>
              </div>
            </div>
          </div>

          <div class="quest-preview-list">
            <div class="quest-preview-item"><span class="quest-num">01</span><span><strong>5 Field Quests</strong> — Hunt objects, OCR text &amp; scene graphs</span></div>
            <div class="quest-preview-item"><span class="quest-num">02</span><span><strong>Pixel Masks</strong> — Tap any object to inspect color &amp; material</span></div>
            <div class="quest-preview-item"><span class="quest-num">03</span><span><strong>Field Dex</strong> — Collect every discovery in your pocket log</span></div>
          </div>

          <div class="splash-footer">
            ${
              state.engineLoading
                ? `<div class="progress-box">
                    <div class="progress-meta">
                      <span id="load-progress-label">${state.loadLabel}</span>
                      <span id="load-progress-pct">${state.loadPct}%</span>
                    </div>
                    <div class="progress-track">
                      <div id="load-progress-fill" class="progress-fill" style="width:${state.loadPct}%"></div>
                    </div>
                  </div>`
                : `<button id="wake-btn" class="primary-btn" type="button">Wake Up Mirage</button>`
            }
            <div class="privacy-note">Weights download once from Hugging Face and cache in your browser.</div>
          </div>
        </main>
      </div>
    `;

    document.getElementById('wake-btn')?.addEventListener('click', wakeMirage);
    bindHeaderEvents();
    return;
  }

  app.innerHTML = `
    <div class="phone-shell">
      ${headerHTML()}
      <main class="game-view">
        <section id="quest-slot"></section>
        <section id="stage-wrap" class="stage-wrap"></section>
        <section id="result-strip-slot"></section>
        <footer id="thumb-dock" class="thumb-dock"></footer>
      </main>
      <div id="sheet-backdrop" class="sheet-backdrop" role="dialog" aria-modal="true">
        <div class="sheet-panel">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <h2 id="sheet-title">Details</h2>
            <button id="close-sheet-btn" class="icon-btn" type="button">Close</button>
          </div>
          <div id="sheet-body" class="sheet-body"></div>
        </div>
      </div>
    </div>
  `;

  bindHeaderEvents();
  renderQuestCard();
  renderStage();
  renderResultStrip();
  renderBottomDock();

  document.getElementById('close-sheet-btn')?.addEventListener('click', closeSheet);
  document.getElementById('sheet-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'sheet-backdrop') closeSheet();
  });
  window.addEventListener('resize', syncCanvasOverlay);
}

function offloadMirage() {
  clearInferTimers();
  pending.clear();
  stopCamera();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  state.inferring = false;
  state.engineReady = false;
  state.engineLoading = false;
  state.frozenUrl = null;
  state.lastResult = null;
  state.selectedObjectId = null;
  createWorker();
  render();
}

function headerHTML() {
  const dexCount = Object.keys(state.dex).length;
  return `
    <header class="hud-header" id="hud-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v20M7 7v4a5 5 0 0 0 5 5M17 9v2a5 5 0 0 1-5 5"/>
          </svg>
        </div>
        <h1 class="brand-title">Mirage</h1>
      </div>
      <div class="hud-actions">
        <span class="xp-pill" id="xp-pill">${state.xp} XP</span>
        <button id="dex-btn" class="icon-btn" type="button" title="Field Dex">Dex (${dexCount})</button>
        ${
          state.engineReady
            ? `<button id="offload-btn" class="icon-btn" type="button" title="Free model memory">Offload</button>`
            : ''
        }
        <select id="lang-select" class="lang-select" aria-label="Output language">
          ${LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === state.language ? 'selected' : ''}>${l.label}</option>`).join('')}
        </select>
      </div>
    </header>
  `;
}

function renderHeader() {
  const xpPill = document.getElementById('xp-pill');
  const dexBtn = document.getElementById('dex-btn');
  if (xpPill) xpPill.textContent = `${state.xp} XP`;
  if (dexBtn) dexBtn.textContent = `Dex (${Object.keys(state.dex).length})`;
}

function bindHeaderEvents() {
  document.getElementById('dex-btn')?.addEventListener('click', () => openSheet('dex'));
  document.getElementById('offload-btn')?.addEventListener('click', offloadMirage);
  document.getElementById('lang-select')?.addEventListener('change', (e) => {
    state.language = e.target.value;
  });
}

function renderQuestCard() {
  const slot = document.getElementById('quest-slot');
  if (!slot) return;

  if (state.mode === 'sandbox') {
    slot.innerHTML = `
      <div class="quest-card">
        <div class="quest-top">
          <span class="quest-title">Free Field Scanner</span>
          <button id="toggle-mode-btn" class="mode-toggle" type="button">Back to Quests (${state.completedQuests.length}/${QUESTS.length})</button>
        </div>
        <p class="quest-prompt">Point at anything, upload a photo, or tap a sample. Tap detected masks to inspect properties.</p>
      </div>
    `;
    document.getElementById('toggle-mode-btn')?.addEventListener('click', () => {
      state.mode = 'quest';
      state.lastFeedback = null;
      renderQuestCard();
    });
    return;
  }

  const quest = QUESTS[state.questIndex];
  const isDone = state.completedQuests.includes(quest.id);
  const allDone = state.completedQuests.length >= QUESTS.length;

  slot.innerHTML = `
    <div class="quest-card">
      <div class="quest-top">
        <div class="quest-dots">
          ${QUESTS.map((q, idx) => {
            const cls = state.completedQuests.includes(q.id) ? 'done' : idx === state.questIndex ? 'active' : '';
            return `<span class="quest-dot ${cls}"></span>`;
          }).join('')}
        </div>
        <button id="toggle-mode-btn" class="mode-toggle" type="button">Free Scan</button>
      </div>
      <div class="quest-title-row">
        <h2 class="quest-title">Quest ${quest.step}/${QUESTS.length}: ${quest.title}</h2>
        <span class="quest-reward">+${quest.xp} XP</span>
      </div>
      <p class="quest-prompt">${quest.prompt}</p>
      ${
        state.lastFeedback
          ? `<div class="quest-feedback ${state.lastFeedback.passed ? 'pass' : 'miss'}">
              <span>${state.lastFeedback.summary}</span>
              ${
                state.lastFeedback.passed
                  ? `<button id="next-quest-btn" class="next-quest-btn" type="button">${
                      state.questIndex < QUESTS.length - 1 ? 'Next Quest →' : allDone ? 'Finish!' : 'Next →'
                    }</button>`
                  : ''
              }
            </div>`
          : isDone
          ? `<div class="quest-feedback pass">
              <span>Quest completed!</span>
              ${
                state.questIndex < QUESTS.length - 1
                  ? `<button id="next-quest-btn" class="next-quest-btn" type="button">Next Quest →</button>`
                  : ''
              }
            </div>`
          : ''
      }
    </div>
  `;

  document.getElementById('toggle-mode-btn')?.addEventListener('click', () => {
    state.mode = 'sandbox';
    renderQuestCard();
  });

  document.getElementById('next-quest-btn')?.addEventListener('click', () => {
    if (state.questIndex < QUESTS.length - 1) {
      state.questIndex += 1;
      state.lastFeedback = null;
      state.frozenUrl = null;
      state.lastResult = null;
      state.lastElapsedMs = null;
      state.selectedObjectId = null;
      saveProgress();
      renderQuestCard();
      renderStage();
      renderResultStrip();
      renderBottomDock();
      startCamera();
    } else {
      state.mode = 'sandbox';
      state.lastFeedback = null;
      renderQuestCard();
    }
  });
}

function renderStage() {
  const wrap = document.getElementById('stage-wrap');
  if (!wrap) return;

  let mediaHTML = '';
  if (state.frozenUrl) {
    mediaHTML = `<img id="frozen-img" class="stage-media" src="${state.frozenUrl}" alt="Captured frame" />`;
  } else if (state.cameraActive) {
    mediaHTML = `<video id="camera-video" class="stage-media" autoplay playsinline muted></video>`;
  } else {
    mediaHTML = `
      <div class="stage-empty">
        <p>Camera unavailable or paused. Try a built-in sample photo or upload your own!</p>
        <div class="sample-chips">
          <button id="empty-sample-desk" class="sample-chip" type="button">Desk Sample</button>
          <button id="empty-sample-sign" class="sample-chip" type="button">Street Sign Sample</button>
        </div>
      </div>
    `;
  }

  wrap.innerHTML = `
    <div class="stage-floating-top">
      <div style="display:flex;gap:6px;">
        <button id="sample-desk-btn" class="stage-pill" type="button">Desk</button>
        <button id="sample-sign-btn" class="stage-pill" type="button">Sign</button>
      </div>
      ${
        state.cameraActive
          ? `<button id="flip-cam-btn" class="stage-pill" type="button">Flip</button>`
          : state.frozenUrl && state.lastElapsedMs !== null
          ? `<span class="stage-pill">${state.lastElapsedMs} ms</span>`
          : ''
      }
    </div>
    ${mediaHTML}
    <canvas id="overlay-canvas"></canvas>
    ${state.inferring ? '<div class="scan-sweep"></div>' : ''}
  `;

  if (state.cameraActive && state.stream) {
    const video = document.getElementById('camera-video');
    if (video) {
      video.srcObject = state.stream;
      video.play().catch(() => {});
    }
  }

  const frozenImg = document.getElementById('frozen-img');
  if (frozenImg) {
    if (frozenImg.complete) syncCanvasOverlay();
    else frozenImg.onload = syncCanvasOverlay;
  } else {
    syncCanvasOverlay();
  }

  document.getElementById('sample-desk-btn')?.addEventListener('click', () => loadImageAndRun('/samples/desk.jpg'));
  document.getElementById('sample-sign-btn')?.addEventListener('click', () => loadImageAndRun('/samples/sign.jpg'));
  document.getElementById('empty-sample-desk')?.addEventListener('click', () => loadImageAndRun('/samples/desk.jpg'));
  document.getElementById('empty-sample-sign')?.addEventListener('click', () => loadImageAndRun('/samples/sign.jpg'));

  document.getElementById('flip-cam-btn')?.addEventListener('click', () => {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  document.getElementById('overlay-canvas')?.addEventListener('click', (e) => {
    if (!state.lastResult) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const normX = ((e.clientX - rect.left) / rect.width) * 1000;
    const normY = ((e.clientY - rect.top) / rect.height) * 1000;
    const hit = hitTestObject(state.lastResult, normX, normY);
    state.selectedObjectId = hit ? hit.id : null;
    syncCanvasOverlay();
    renderResultStrip();
  });
}

function renderResultStrip() {
  const slot = document.getElementById('result-strip-slot');
  if (!slot) return;

  if (!state.lastResult) {
    slot.innerHTML = '';
    return;
  }

  if (state.lastResult.error) {
    slot.innerHTML = `
      <div class="result-strip">
        <span class="result-strip-text">${state.lastResult.error}</span>
      </div>
    `;
    return;
  }

  const objs = Array.isArray(state.lastResult.objects) ? state.lastResult.objects : [];
  const texts = Array.isArray(state.lastResult.text) ? state.lastResult.text : [];
  const selected = objs.find((o) => o.id === state.selectedObjectId);

  let text = '';
  if (selected) {
    const attrs = selected.description ? Object.values(selected.description).filter(Boolean).slice(0, 3).join(' · ') : '';
    text = `${selected.name}${attrs ? ` (${attrs})` : ''}`;
  } else if (state.lastResult.scene) {
    const sceneVals = Object.values(state.lastResult.scene).filter(Boolean).slice(0, 3).join(' · ');
    text = `Scene: ${sceneVals || 'Analyzed'}`;
  } else {
    text = `Found ${objs.length} objects, ${texts.length} text regions`;
  }

  slot.innerHTML = `
    <div class="result-strip">
      <span class="result-strip-text">${escapeHtml(text)}</span>
      <span class="result-strip-meta">${objs.length} obj · ${texts.length} ocr</span>
    </div>
  `;
}

function renderBottomDock() {
  const dock = document.getElementById('thumb-dock');
  if (!dock) return;

  const isFrozen = Boolean(state.frozenUrl);

  dock.innerHTML = `
    <div class="dock-side">
      <label class="dock-btn" for="photo-upload-input" role="button" tabindex="0">
        <span>Upload</span>
        <input id="photo-upload-input" type="file" accept="image/*" class="hidden" />
      </label>
    </div>

    <button id="shutter-btn" class="shutter-btn ${isFrozen ? 'is-resume' : ''}" type="button">
      <span class="shutter-core">${state.inferring ? 'STOP' : isFrozen ? 'LIVE' : 'SCAN'}</span>
    </button>

    <div class="dock-side right">
      <button id="inspect-btn" class="dock-btn" type="button" ${!state.lastResult ? 'disabled' : ''}>
        <span>Inspect</span>
      </button>
    </div>
  `;

  document.getElementById('photo-upload-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    loadFileAndRun(file);
  });

  document.getElementById('shutter-btn')?.addEventListener('click', () => {
    if (state.inferring) {
      cancelInference('Scan stopped by user');
      return;
    }
    if (isFrozen) {
      startCamera();
      return;
    }
    const video = document.getElementById('camera-video');
    if (video && video.videoWidth > 0) {
      runInferenceOnSource(video, video.videoWidth, video.videoHeight);
    } else {
      // Fallback to quest suggested sample if no camera
      const q = QUESTS[state.questIndex];
      const sample = q?.sampleSuggestion === 'sign' ? '/samples/sign.jpg' : '/samples/desk.jpg';
      loadImageAndRun(sample);
    }
  });

  document.getElementById('inspect-btn')?.addEventListener('click', () => {
    if (state.lastResult) openSheet('inspect');
  });
}

function resetJourney() {
  state.xp = 0;
  state.questIndex = 0;
  state.completedQuests = [];
  state.dex = {};
  state.mode = 'quest';
  state.lastFeedback = null;
  state.frozenUrl = null;
  state.lastResult = null;
  state.lastElapsedMs = null;
  state.selectedObjectId = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  closeSheet();
  renderHeader();
  renderQuestCard();
  renderStage();
  renderResultStrip();
  renderBottomDock();
  startCamera();
}

function openSheet(type) {
  state.openSheet = type;
  const backdrop = document.getElementById('sheet-backdrop');
  const title = document.getElementById('sheet-title');
  const body = document.getElementById('sheet-body');
  if (!backdrop || !title || !body) return;

  if (type === 'dex') {
    title.textContent = `Field Dex (${Object.keys(state.dex).length})`;
    const entries = Object.values(state.dex).sort((a, b) => b.bestScore - a.bestScore);
    const listHTML =
      entries.length === 0
        ? `<div class="detail-block"><p>No objects cataloged yet. Scan something to start your collection!</p></div>`
        : `<div class="dex-grid">
            ${entries
              .map(
                (item) => `
              <div class="dex-card">
                <div class="dex-name">${escapeHtml(item.name)}</div>
                <div class="dex-meta">Best: ${item.bestScore}% · Seen ${item.count}x</div>
                ${item.color || item.material ? `<div class="dex-meta">${escapeHtml([item.color, item.material].filter(Boolean).join(' · '))}</div>` : ''}
              </div>
            `
              )
              .join('')}
          </div>`;

    body.innerHTML = `
      ${listHTML}
      <div class="detail-block" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <h3>Journey Progress</h3>
          <p>${state.completedQuests.length}/${QUESTS.length} quests · ${state.xp} XP</p>
        </div>
        <button id="reset-journey-btn" class="icon-btn" type="button" style="color:#9A3412;border-color:rgba(217,107,39,0.35);">Reset Journey</button>
      </div>
    `;
    document.getElementById('reset-journey-btn')?.addEventListener('click', resetJourney);
  } else {
    title.textContent = 'Mirage Perception Record';
    const d = state.lastResult || {};
    const objs = Array.isArray(d.objects) ? d.objects : [];
    const texts = Array.isArray(d.text) ? d.text : [];
    const rels = Array.isArray(d.relations) ? d.relations : [];

    body.innerHTML = `
      ${
        d.scene
          ? `<div class="detail-block">
              <h3>Scene</h3>
              <p>${escapeHtml(Object.entries(d.scene).map(([k, v]) => `${k}: ${v}`).join(' · '))}</p>
            </div>`
          : ''
      }
      ${
        objs.length
          ? `<div class="detail-block">
              <h3>Objects (${objs.length})</h3>
              <p>${objs
                .map((o) => {
                  const pct = typeof o.score === 'number' ? ` (${Math.round(o.score * 100)}%)` : '';
                  return `${escapeHtml(o.name)}${pct}`;
                })
                .join(', ')}</p>
            </div>`
          : ''
      }
      ${
        texts.length
          ? `<div class="detail-block">
              <h3>OCR Text (${texts.length})</h3>
              <p>${texts.map((t) => `"${escapeHtml(t.string || t.text || t.value || '')}"`).join(' · ')}</p>
            </div>`
          : ''
      }
      ${
        rels.length
          ? `<div class="detail-block">
              <h3>Relations (${rels.length})</h3>
              <p>${rels
                .map((r) => {
                  if (typeof r === 'string') return escapeHtml(r);
                  const sub = objs.find((o) => o.id === r.subject)?.name || `#${r.subject}`;
                  const obj = objs.find((o) => o.id === r.object)?.name || `#${r.object}`;
                  return `${escapeHtml(sub)} → ${escapeHtml(r.predicate || '')} → ${escapeHtml(obj)}`;
                })
                .join(' · ')}</p>
            </div>`
          : ''
      }
      ${
        d.reasoning
          ? `<div class="detail-block">
              <h3>Reasoning Trace</h3>
              <p>${escapeHtml(d.reasoning)}</p>
            </div>`
          : ''
      }
      <div class="detail-block">
        <h3>Raw JSON</h3>
        <pre class="json-pre">${escapeHtml(JSON.stringify(d, null, 2))}</pre>
      </div>
    `;
  }

  backdrop.classList.add('open');
}

function closeSheet() {
  state.openSheet = null;
  document.getElementById('sheet-backdrop')?.classList.remove('open');
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.engineReady) {
    renderStage();
    renderBottomDock();
  }
});

render();
