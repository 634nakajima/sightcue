// MediaPipe Tracking mode - ported from useMediaPipe.ts
// Uses @mediapipe/tasks-vision for hand gesture recognition and face landmark detection
// Sends landmarks via IPC to main process for OSC output

const { ipcRenderer } = require('electron');
const path = require('path');
const { HAND_LANDMARK_NAMES, FACE_LANDMARKS, GESTURE_NAMES, ExponentialSmoother } = require('./mediapipe-data');
const { drawLandmarks } = require('./mediapipe-draw');
const region = require('./mediapipe-region');
const { detectQuad, medianQuad } = require('./quad-detect');
const oscMonitor = require('../osc-monitor');

let gestureRecognizer = null;
let faceLandmarker = null;
let smoother = new ExponentialSmoother(0.5);
let loopTimerId = 0;
let lastSendTime = 0;
let running = false;
let ready = false;
let fps = 0;
let fpsFrameCount = 0;
let fpsLastTime = 0;

// Options
let handEnabled = true;
let faceEnabled = true;
let videoWasReady = false;

// Rectangle detection for the quad region
const DETECT_WIDTH = 320;
// Sample several frames and take the per-corner median, so one noisy frame
// cannot decide the region. A majority of them has to agree.
const DETECT_FRAMES = 5;
const DETECT_FRAME_INTERVAL = 80;
const DETECT_MIN_HITS = 3;
let detectCanvas = null;
let regionHintTimer = 0;
let seedPickActive = false;
// Detection debug view: what the detector saw, drawn over the preview
let debugEnabled = false;
let debugLayer = null;
let debugStats = '';

// DOM references
let els = {};
let overlayCtx = null;

// ── OSC send-point selection ────────────────────────────────
// Only the checked landmarks/axes leave the renderer, so unselected points
// cost no IPC and no OSC traffic.
const SELECTION_KEY = 'sightcue.mediapipe.oscSelection';
const TRACKING_KEY = 'sightcue.mediapipe.tracking';
const AXES = ['x', 'y', 'z'];

const HAND_POINT_NAMES = Object.keys(HAND_LANDMARK_NAMES)
  .map(Number)
  .sort((a, b) => a - b)
  .map(i => HAND_LANDMARK_NAMES[i]);
const FACE_POINT_NAMES = Object.keys(FACE_LANDMARKS);

const HAND_PRESETS = {
  all: HAND_POINT_NAMES,
  tips: ['wrist', 'thumb/tip', 'index/tip', 'middle/tip', 'ring/tip', 'pinky/tip'],
  none: [],
};
const FACE_PRESETS = {
  all: FACE_POINT_NAMES,
  key: [
    'nose/tip', 'left_eye/inner', 'left_eye/upper', 'left_eye/lower',
    'right_eye/inner', 'right_eye/upper', 'right_eye/lower',
    'mouth/upper', 'mouth/lower', 'mouth/left', 'mouth/right', 'jaw/chin',
  ],
  none: [],
};

const selection = {
  hand: new Set(HAND_POINT_NAMES),
  face: new Set(FACE_POINT_NAMES),
  axes: new Set(AXES),
  gesture: true,
};

// Latest tracking result for data monitor
let latestResult = { hands: { left: null, right: null }, face: [] };

function initMediaPipe(elements) {
  els = elements;

  // Smoothing sliders (panel + settings popup are two views of one value)
  for (const slider of _smoothingSliders()) {
    slider.addEventListener('input', () => {
      _applySmoothing(parseFloat(slider.value));
      _saveTrackingSettings();
    });
  }

  // Hand/face toggles
  if (els.handCheckbox) {
    els.handCheckbox.addEventListener('change', () => {
      handEnabled = els.handCheckbox.checked;
      // Stop sending -> drop the frozen rows instead of leaving stale values
      if (!handEnabled) oscMonitor.clearPrefix('/hand/');
      _updateSendEstimate();
      _saveTrackingSettings();
    });
  }
  if (els.faceCheckbox) {
    els.faceCheckbox.addEventListener('change', () => {
      faceEnabled = els.faceCheckbox.checked;
      if (!faceEnabled) oscMonitor.clearPrefix('/face/');
      _updateSendEstimate();
      _saveTrackingSettings();
    });
  }

  _loadTrackingSettings();
  _loadSelection();
  _buildPointSelectors();
  _initRegionControls();
}

// ── Tracking settings persistence ───────────────────────────
// Hands/Face toggles and the smoothing factor are restored on launch, the same
// way the OSC send-point selection is.

function _smoothingSliders() {
  return [els.smoothingSlider, els.smoothingSliderSettings].filter(Boolean);
}

function _smoothingLabels() {
  return [els.smoothingValue, els.smoothingValueSettings].filter(Boolean);
}

function _applySmoothing(value) {
  smoother.setFactor(value);
  const applied = smoother.getFactor(); // clamped to the smoother's valid range
  for (const slider of _smoothingSliders()) {
    if (parseFloat(slider.value) !== applied) slider.value = String(applied);
  }
  for (const label of _smoothingLabels()) {
    label.textContent = applied.toFixed(2);
  }
}

function _loadTrackingSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(TRACKING_KEY) || 'null');
  } catch (err) {
    saved = null;
  }

  if (saved) {
    if (typeof saved.hand === 'boolean') handEnabled = saved.hand;
    if (typeof saved.face === 'boolean') faceEnabled = saved.face;
    if (typeof saved.smoothing === 'number' && isFinite(saved.smoothing)) {
      smoother.setFactor(saved.smoothing);
    }
  }

  if (els.handCheckbox) els.handCheckbox.checked = handEnabled;
  if (els.faceCheckbox) els.faceCheckbox.checked = faceEnabled;
  _applySmoothing(smoother.getFactor());
}

function _saveTrackingSettings() {
  try {
    localStorage.setItem(TRACKING_KEY, JSON.stringify({
      hand: handEnabled,
      face: faceEnabled,
      smoothing: smoother.getFactor(),
    }));
  } catch (err) {
    // Storage unavailable - settings just won't persist
  }
}

// ── Send-point selection ────────────────────────────────────

function _loadSelection() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null');
  } catch (err) {
    saved = null;
  }
  if (!saved) return;

  if (Array.isArray(saved.hand)) {
    selection.hand = new Set(saved.hand.filter(n => HAND_POINT_NAMES.includes(n)));
  }
  if (Array.isArray(saved.face)) {
    selection.face = new Set(saved.face.filter(n => FACE_POINT_NAMES.includes(n)));
  }
  if (Array.isArray(saved.axes)) {
    const axes = saved.axes.filter(a => AXES.includes(a));
    if (axes.length > 0) selection.axes = new Set(axes);
  }
  if (typeof saved.gesture === 'boolean') selection.gesture = saved.gesture;
}

function _saveSelection() {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({
      hand: [...selection.hand],
      face: [...selection.face],
      axes: [...selection.axes],
      gesture: selection.gesture,
    }));
  } catch (err) {
    // Storage unavailable - selection just won't persist
  }
}

function _buildPointSelectors() {
  _renderPointList(els.handPointList, 'hand', HAND_POINT_NAMES);
  _renderPointList(els.facePointList, 'face', FACE_POINT_NAMES);

  // Gesture (index + score) is a hand extra, not a landmark
  if (els.gestureCheckbox) {
    els.gestureCheckbox.checked = selection.gesture;
    els.gestureCheckbox.addEventListener('change', () => {
      selection.gesture = els.gestureCheckbox.checked;
      _onSelectionChanged();
    });
  }

  if (els.axisCheckboxes) {
    els.axisCheckboxes.forEach(cb => {
      cb.checked = selection.axes.has(cb.dataset.axis);
      cb.addEventListener('change', () => {
        if (cb.checked) selection.axes.add(cb.dataset.axis);
        else selection.axes.delete(cb.dataset.axis);
        _onSelectionChanged();
      });
    });
  }

  // Preset buttons: data-group="hand|face" data-preset="all|tips|key|none"
  if (els.presetButtons) {
    els.presetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        const presets = group === 'hand' ? HAND_PRESETS : FACE_PRESETS;
        const names = presets[btn.dataset.preset];
        if (!names) return;
        selection[group] = new Set(names);
        _syncCheckboxes(group);
        _onSelectionChanged();
      });
    });
  }

  _updateSendEstimate();
}

function _renderPointList(container, group, names) {
  if (!container) return;
  container.innerHTML = names.map(name => `
    <label class="mp-chip">
      <input type="checkbox" data-group="${group}" value="${name}" ${selection[group].has(name) ? 'checked' : ''} />
      <span>${name}</span>
    </label>`).join('');

  container.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.matches('input[type="checkbox"]')) return;
    if (cb.checked) selection[group].add(cb.value);
    else selection[group].delete(cb.value);
    _onSelectionChanged();
  });
}

function _syncCheckboxes(group) {
  const container = group === 'hand' ? els.handPointList : els.facePointList;
  if (!container) return;
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = selection[group].has(cb.value);
  });
}

function _onSelectionChanged() {
  _saveSelection();
  _updateSendEstimate();
  // Addresses that are no longer sent would otherwise linger in the OSC monitor
  oscMonitor.clearMonitor();
}

function _updateSendEstimate() {
  if (!els.sendEstimate) return;
  const axisCount = selection.axes.size;
  let count = 0;
  if (handEnabled) {
    count += 2; // /hand/{left,right}/detected
    count += 2 * selection.hand.size * axisCount;
    if (selection.gesture) count += 4; // index + score per hand
  }
  if (faceEnabled) {
    count += 1; // /face/detected
    count += selection.face.size * axisCount;
  }
  els.sendEstimate.textContent = `max ${count} msg/frame`;
}

// Drop every tracking address from the OSC monitor. Used when nothing is being
// sent at all (mode stopped, camera off) - in that state no batch arrives, so
// the monitor's own pruning cannot notice the addresses went away.
function _clearTrackingRows() {
  oscMonitor.clearPrefix('/hand/');
  oscMonitor.clearPrefix('/face/');
}

function _filterLandmarks(landmarks, allowed) {
  const useRegion = region.isEnabled();
  const out = [];
  for (const lm of landmarks) {
    if (!allowed.has(lm.name)) continue;

    // With a region set, x/y become region-relative (0-1 inside the quad) and
    // points outside it are dropped. z is a depth value, so it passes through.
    let x = lm.x;
    let y = lm.y;
    if (useRegion) {
      const mapped = region.mapPoint(lm.x, lm.y);
      if (!mapped.inside) continue;
      x = mapped.u;
      y = mapped.v;
    }

    const values = { x, y, z: lm.z };
    const point = { name: lm.name };
    for (const axis of AXES) {
      if (selection.axes.has(axis)) point[axis] = values[axis];
    }
    out.push(point);
  }
  return out;
}

// ── Quad region controls ────────────────────────────────────

function _initRegionControls() {
  const overlay = els.overlay || document.getElementById('roi-overlay');
  if (overlay) {
    region.initRegion(overlay);
    // Dragging a corner must repaint even when the detection loop is idle
    region.setOnChange(_redrawOverlay);
  }

  if (els.regionCheckbox) {
    els.regionCheckbox.checked = region.isEnabled();
    els.regionCheckbox.addEventListener('change', () => {
      region.setEnabled(els.regionCheckbox.checked);
      // Points that just fell outside the region must not linger in the monitor
      _clearTrackingRows();
      _updateRegionHint();
    });
  }
  if (els.regionResetBtn) {
    els.regionResetBtn.addEventListener('click', () => region.resetCorners());
  }
  if (els.regionDetectBtn) {
    els.regionDetectBtn.addEventListener('click', _detectRegionFromFrame);
  }
  if (els.regionDebugCheckbox) {
    els.regionDebugCheckbox.addEventListener('change', () => {
      debugEnabled = els.regionDebugCheckbox.checked;
      if (!debugEnabled) {
        debugLayer = null;
        debugStats = '';
      }
      _redrawOverlay();
    });
  }
  _updateRegionHint();
}

// Detect starts by asking where to look: picking the region by click is far
// more reliable than "largest thing in frame" once the background is busy.
// Escape skips the click and falls back to fully automatic detection.
function _detectRegionFromFrame() {
  const video = els.video;
  if (!video || video.readyState < 2 || !video.videoWidth) {
    _flashRegionHint('camera not ready');
    return;
  }
  if (seedPickActive) {
    _endSeedPick();
    return;
  }
  _beginSeedPick();
}

function _beginSeedPick() {
  const overlay = els.overlay || document.getElementById('roi-overlay');
  if (!overlay) return;

  seedPickActive = true;
  // Stand down corner dragging so the click is unambiguously a seed
  region.setInteractive(false);
  overlay.style.cursor = 'crosshair';
  overlay.addEventListener('mousedown', _onSeedClick);
  document.addEventListener('keydown', _onSeedKey);

  clearTimeout(regionHintTimer);
  if (els.regionHint) els.regionHint.textContent = 'click inside the region (Esc: auto)';
}

function _endSeedPick() {
  const overlay = els.overlay || document.getElementById('roi-overlay');
  seedPickActive = false;
  if (overlay) {
    overlay.removeEventListener('mousedown', _onSeedClick);
    overlay.style.cursor = 'default';
  }
  document.removeEventListener('keydown', _onSeedKey);
  region.setInteractive(running);
  _updateRegionHint();
}

function _onSeedClick(e) {
  const overlay = e.currentTarget;
  const rect = overlay.getBoundingClientRect();
  const seed = {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
  e.preventDefault();
  _endSeedPick();
  _runDetection(seed);
}

function _onSeedKey(e) {
  if (e.key === 'Escape') {
    _endSeedPick();
    _runDetection(null); // fully automatic
  }
}

// Sample DETECT_FRAMES frames and keep the per-corner median
function _runDetection(seed) {
  const results = [];
  let attempts = 0;

  if (els.regionHint) els.regionHint.textContent = 'detecting...';

  const step = () => {
    const quad = _detectOnce(seed);
    if (quad) results.push(quad);
    if (++attempts < DETECT_FRAMES) {
      setTimeout(step, DETECT_FRAME_INTERVAL);
      return;
    }
    _finishDetection(results, seed);
  };
  step();
}

function _detectOnce(seed) {
  const video = els.video;
  if (!video || video.readyState < 2 || !video.videoWidth) return null;

  // Detection runs on a downscaled copy: fast, and less sensitive to texture
  const width = DETECT_WIDTH;
  const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  if (!detectCanvas) detectCanvas = document.createElement('canvas');
  detectCanvas.width = width;
  detectCanvas.height = height;
  const ctx = detectCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);

  const debug = debugEnabled ? {} : undefined;
  try {
    const quad = detectQuad(ctx.getImageData(0, 0, width, height), seed || undefined, debug);
    if (debug) _renderDebug(debug, quad);
    return quad;
  } catch (err) {
    console.error('[MediaPipe] Quad detection failed:', err);
    return null;
  }
}

// ── Detection debug view ────────────────────────────────────
// Painted once per detection into an offscreen canvas and then blitted over the
// preview, so inspecting a failure costs nothing in the tracking loop.

function _renderDebug(debug, quad) {
  if (!debug.width || !debug.height) {
    debugLayer = null;
    debugStats = 'no edge data';
    return;
  }

  if (!debugLayer) debugLayer = document.createElement('canvas');
  debugLayer.width = debug.width;
  debugLayer.height = debug.height;
  const ctx = debugLayer.getContext('2d');
  ctx.clearRect(0, 0, debug.width, debug.height);

  // Edge pixels
  if (debug.edges) {
    const image = ctx.createImageData(debug.width, debug.height);
    for (let i = 0; i < debug.edges.length; i++) {
      if (!debug.edges[i]) continue;
      const p = i * 4;
      image.data[p] = 100;
      image.data[p + 1] = 220;
      image.data[p + 2] = 255;
      image.data[p + 3] = 200;
    }
    ctx.putImageData(image, 0, 0);
  }

  // Hough lines
  if (Array.isArray(debug.lines)) {
    ctx.strokeStyle = 'rgba(255, 200, 60, 0.55)';
    ctx.lineWidth = 1;
    for (const line of debug.lines) {
      const cos = Math.cos(line.theta);
      const sin = Math.sin(line.theta);
      const x0 = cos * line.rho;
      const y0 = sin * line.rho;
      const span = debug.width + debug.height;
      ctx.beginPath();
      ctx.moveTo(x0 + span * -sin, y0 + span * cos);
      ctx.lineTo(x0 - span * -sin, y0 - span * cos);
      ctx.stroke();
    }
  }

  // Best candidate that was rejected, then the accepted quad on top
  if (!quad && debug.bestQuad) {
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
    ctx.lineWidth = 2;
    _strokeQuad(ctx, debug.bestQuad);
  }
  if (quad) {
    ctx.strokeStyle = 'rgba(80, 255, 140, 0.95)';
    ctx.lineWidth = 2;
    _strokeQuad(ctx, quad.map(p => ({ x: p.x * debug.width, y: p.y * debug.height })));
  }

  if (debug.seedPoint) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(debug.seedPoint.x, debug.seedPoint.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const r = debug.rejected || {};
  const rejects = Object.keys(r).filter(k => r[k] > 0).map(k => `${k}:${r[k]}`).join(' ');
  debugStats = [
    `method=${debug.method}`,
    `edges=${debug.edgeCount}`,
    `lines=${debug.lines ? debug.lines.length : 0}`,
    `cand=${debug.candidates}`,
    `support=${(debug.bestSupport || 0).toFixed(2)}/${debug.minSupport}`,
    // Always shown: "no rejections at all" means no quad was ever built, which
    // is a different problem from "quads were built and thrown away"
    `rejected=${rejects || 'none'}`,
    debug.usedBorders ? 'borders=used' : '',
  ].filter(Boolean).join('  ');
  console.log('[MediaPipe] detect debug:', debugStats);
}

function _strokeQuad(ctx, corners) {
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
}

function _drawDebugLayer(ctx, w, h) {
  if (!debugEnabled || !debugLayer) return;
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.drawImage(debugLayer, 0, 0, w, h);
  ctx.restore();

  if (debugStats) {
    ctx.save();
    ctx.font = '11px monospace';

    // Wrap instead of running off the edge - the tail of this string is the
    // part worth reading when a detection fails
    const lines = [];
    let current = '';
    for (const token of debugStats.split('  ')) {
      const candidate = current ? `${current}  ${token}` : token;
      if (current && ctx.measureText(candidate).width > w - 18) {
        lines.push(current);
        current = token;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);

    const lineHeight = 14;
    const boxHeight = lines.length * lineHeight + 6;
    const boxWidth = Math.min(w - 8, Math.max(...lines.map(l => ctx.measureText(l).width)) + 10);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(4, h - boxHeight - 4, boxWidth, boxHeight);
    ctx.fillStyle = '#fff';
    lines.forEach((line, i) => {
      ctx.fillText(line, 9, h - boxHeight - 4 + 15 + i * lineHeight);
    });
    ctx.restore();
  }
}

function _finishDetection(results, seed) {
  // A seeded run that found nothing is worth retrying automatically: the click
  // may have landed on a spot the threshold assigned to the background.
  if (results.length < DETECT_MIN_HITS) {
    if (seed) {
      _flashRegionHint('seeded detect failed, trying auto');
      _runDetection(null);
      return;
    }
    _flashRegionHint(results.length ? 'unstable, try again' : 'no rectangle found');
    return;
  }

  const quad = medianQuad(results);
  if (!quad || !region.setCorners(quad)) {
    _flashRegionHint('no rectangle found');
    return;
  }

  // Corners are meaningless while the region is off, so turn it on
  if (!region.isEnabled()) {
    region.setEnabled(true);
    if (els.regionCheckbox) els.regionCheckbox.checked = true;
  }
  _clearTrackingRows();
  _flashRegionHint(`detected (${results.length}/${DETECT_FRAMES} frames)`);
  _log(`Region corners set from detected rectangle (${results.length}/${DETECT_FRAMES} frames${seed ? ', seeded' : ', auto'})`);
}

function _flashRegionHint(message) {
  if (!els.regionHint) return;
  els.regionHint.textContent = message;
  clearTimeout(regionHintTimer);
  regionHintTimer = setTimeout(_updateRegionHint, 2500);
}

function _updateRegionHint() {
  if (!els.regionHint) return;
  els.regionHint.textContent = region.isEnabled()
    ? 'drag TL/TR/BR/BL on the preview'
    : 'off - raw camera coords';
}

function _redrawOverlay() {
  if (!overlayCtx) return;
  const canvas = overlayCtx.canvas;
  drawLandmarks(overlayCtx, latestResult, canvas.width, canvas.height, fps);
  _drawDebugLayer(overlayCtx, canvas.width, canvas.height);
  region.drawRegion(overlayCtx, canvas.width, canvas.height);
}

async function startMediaPipe() {
  if (running) return;
  running = true;
  region.setInteractive(true);

  // Get overlay canvas context (shared with ROI)
  const overlay = els.overlay || document.getElementById('roi-overlay');
  if (overlay) {
    overlayCtx = overlay.getContext('2d');
  }

  if (els.readyStatus) {
    els.readyStatus.textContent = 'Initializing models...';
    els.readyStatus.style.display = 'inline';
  }

  // Initialize models if not already done
  if (!ready) {
    _log('Initializing MediaPipe models...');
    try {
      await _initModels();
      ready = true;
      _log('Models ready, tracking started');
      if (els.readyStatus) {
        els.readyStatus.textContent = 'Ready';
        setTimeout(() => {
          if (els.readyStatus) els.readyStatus.style.display = 'none';
        }, 2000);
      }
    } catch (err) {
      console.error('[MediaPipe] Init error:', err);
      _log('Error: ' + err.message);
      if (els.readyStatus) {
        els.readyStatus.textContent = 'Error: ' + err.message;
      }
      running = false;
      return;
    }
  } else {
    _log('Tracking started');
    if (els.readyStatus) els.readyStatus.style.display = 'none';
  }

  // Start detection loop (use setTimeout instead of rAF to avoid background throttling)
  fpsLastTime = performance.now();
  fpsFrameCount = 0;
  loopTimerId = setTimeout(_detect, 0);
}

function stopMediaPipe() {
  running = false;
  if (seedPickActive) _endSeedPick();
  region.setInteractive(false);
  if (loopTimerId) {
    clearTimeout(loopTimerId);
    loopTimerId = 0;
  }

  // Nothing is being sent anymore - don't leave the last values on screen
  videoWasReady = false;
  _clearTrackingRows();

  // Clear the overlay canvas
  if (overlayCtx) {
    const canvas = overlayCtx.canvas;
    overlayCtx.clearRect(0, 0, canvas.width, canvas.height);
    overlayCtx = null;
  }
}

async function _initModels() {
  // Use local wasm files from node_modules
  const wasmPath = path.join(__dirname, '..', '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const wasmFilesetUrl = 'file://' + wasmPath;

  // Dynamic import of the MediaPipe module
  const vision = await _loadVision(wasmFilesetUrl);

  gestureRecognizer = await vision.GestureRecognizer.createFromOptions(
    vision.fileset,
    {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
        delegate: 'GPU',
      },
      numHands: 2,
      runningMode: 'VIDEO',
    }
  );

  faceLandmarker = await vision.FaceLandmarker.createFromOptions(
    vision.fileset,
    {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
        delegate: 'GPU',
      },
      numFaces: 1,
      runningMode: 'VIDEO',
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }
  );
}

async function _loadVision(wasmPath) {
  // Load the @mediapipe/tasks-vision package
  const tasksVision = require('@mediapipe/tasks-vision');
  const { FilesetResolver, GestureRecognizer, FaceLandmarker } = tasksVision;

  const fileset = await FilesetResolver.forVisionTasks(wasmPath);

  return {
    fileset,
    GestureRecognizer,
    FaceLandmarker,
  };
}

function _detect() {
  if (!running) return;

  const video = els.video;
  if (!video || video.readyState < 2 || !ready) {
    // Camera stopped / not ready yet: no frames means no OSC, so drop stale rows
    if (videoWasReady) {
      videoWasReady = false;
      _clearTrackingRows();
    }
    loopTimerId = setTimeout(_detect, 16);
    return;
  }
  videoWasReady = true;

  const now = performance.now();
  const trackingResult = { hands: { left: null, right: null }, face: [] };

  // Hand + Gesture detection
  if (handEnabled && gestureRecognizer) {
    try {
      const gestureResult = gestureRecognizer.recognizeForVideo(video, now);
      if (gestureResult.landmarks) {
        for (let i = 0; i < gestureResult.landmarks.length; i++) {
          const landmarks = gestureResult.landmarks[i];
          const handedness =
            gestureResult.handednesses[i]?.[0]?.categoryName?.toLowerCase() === 'left'
              ? 'left' : 'right';

          const gestureCategory = gestureResult.gestures[i]?.[0];
          const gestureName = gestureCategory?.categoryName || 'None';
          const gestureIndex = GESTURE_NAMES.indexOf(gestureName);
          const gestureScore = gestureCategory?.score || 0;

          const tracked = landmarks.map((lm, idx) => {
            const name = HAND_LANDMARK_NAMES[idx] || `landmark_${idx}`;
            const prefix = `hand_${handedness}_${name}`;
            return {
              name,
              x: smoother.smooth(`${prefix}_x`, lm.x),
              y: smoother.smooth(`${prefix}_y`, lm.y),
              z: smoother.smooth(`${prefix}_z`, lm.z),
            };
          });

          const handResult = {
            landmarks: tracked,
            gesture: gestureName,
            gestureIndex: gestureIndex >= 0 ? gestureIndex : 0,
            gestureScore,
          };

          if (handedness === 'left') {
            trackingResult.hands.left = handResult;
          } else {
            trackingResult.hands.right = handResult;
          }
        }
      }
    } catch (err) {
      // Ignore timing errors from recognizeForVideo
    }
  }

  // Face detection
  if (faceEnabled && faceLandmarker) {
    try {
      const faceResult = faceLandmarker.detectForVideo(video, now);
      if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
        const allFaceLandmarks = faceResult.faceLandmarks[0];
        const tracked = [];

        for (const [name, idx] of Object.entries(FACE_LANDMARKS)) {
          if (idx < allFaceLandmarks.length) {
            const lm = allFaceLandmarks[idx];
            const prefix = `face_${name}`;
            tracked.push({
              name,
              x: smoother.smooth(`${prefix}_x`, lm.x),
              y: smoother.smooth(`${prefix}_y`, lm.y),
              z: smoother.smooth(`${prefix}_z`, lm.z),
            });
          }
        }

        trackingResult.face = tracked;
      }
    } catch (err) {
      // Ignore timing errors from detectForVideo
    }
  }

  latestResult = trackingResult;

  // Draw on shared overlay canvas
  if (overlayCtx) {
    const canvas = overlayCtx.canvas;
    // Resize canvas to match container if needed
    const container = canvas.parentElement;
    if (container) {
      const rect = container.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    }
    drawLandmarks(overlayCtx, trackingResult, canvas.width, canvas.height, fps);
    _drawDebugLayer(overlayCtx, canvas.width, canvas.height);
    region.drawRegion(overlayCtx, canvas.width, canvas.height);
  }

  // Send via IPC at ~30fps
  if (now - lastSendTime >= 33) {
    lastSendTime = now;

    // Only the selected points/axes are forwarded to the main process
    const payload = { handsEnabled: handEnabled, faceEnabled };
    if (handEnabled) {
      for (const side of ['left', 'right']) {
        const hand = trackingResult.hands[side];
        if (!hand) continue;
        if (!payload.hands) payload.hands = {};
        payload.hands[side] = {
          landmarks: _filterLandmarks(hand.landmarks, selection.hand),
          gesture: selection.gesture ? hand.gesture : null,
          gestureIndex: hand.gestureIndex,
          gestureScore: hand.gestureScore,
        };
      }
    }
    if (faceEnabled && trackingResult.face.length > 0) {
      // faceDetected is separate from the point list: the face can be tracked
      // while every one of its points is deselected or outside the region.
      payload.faceDetected = true;
      payload.face = _filterLandmarks(trackingResult.face, selection.face);
    }

    ipcRenderer.send('osc:sendLandmarks', payload);

    // Update FPS counter
    fpsFrameCount++;
    const elapsed = now - fpsLastTime;
    if (elapsed >= 1000) {
      fps = Math.round(fpsFrameCount * 1000 / elapsed);
      fpsFrameCount = 0;
      fpsLastTime = now;
    }
  }

  // Update data monitor (throttled to ~10fps to reduce DOM thrashing)
  if (now % 100 < 20) {
    _updateDataMonitor(trackingResult);
  }

  loopTimerId = setTimeout(_detect, 0);
}

function _updateDataMonitor(result) {
  if (!els.dataMonitor) return;
  const monitor = els.dataMonitor;

  let html = '<div class="dm-section">';
  html += '<span class="dm-header">Hands</span>';
  html += _renderHandCard('Left', result.hands.left);
  html += _renderHandCard('Right', result.hands.right);
  html += '</div>';

  html += '<div class="dm-section">';
  html += '<span class="dm-header">Face</span>';
  html += _renderFaceCard(result.face);
  html += '</div>';

  html += `<div class="dm-footer">FPS <strong>${fps}</strong> &middot; full OSC addresses in monitor below</div>`;

  monitor.innerHTML = html;
}

function _renderHandCard(label, hand) {
  if (!hand) {
    return `<div class="dm-card dm-card-off">
      <span class="dm-dot dm-dot-off"></span>
      <span class="dm-card-label">${label}</span>
      <span class="dm-card-detail">Not detected</span>
    </div>`;
  }
  const rawGesture = hand.gesture && hand.gesture !== 'None' ? hand.gesture : null;
  const gestureText = rawGesture ? rawGesture.replace(/_/g, ' ') : 'tracking';
  const score = rawGesture && hand.gestureScore > 0
    ? `${(hand.gestureScore * 100).toFixed(0)}%`
    : '';
  return `<div class="dm-card">
    <span class="dm-dot dm-dot-on"></span>
    <span class="dm-card-label">${label}</span>
    <span class="dm-card-gesture">${_escapeHtml(gestureText)}</span>
    <span class="dm-card-detail">${score}</span>
  </div>`;
}

function _renderFaceCard(face) {
  if (!face || face.length === 0) {
    return `<div class="dm-card dm-card-off">
      <span class="dm-dot dm-dot-off"></span>
      <span class="dm-card-label">Face</span>
      <span class="dm-card-detail">Not detected</span>
    </div>`;
  }
  return `<div class="dm-card">
    <span class="dm-dot dm-dot-on"></span>
    <span class="dm-card-label">Face</span>
    <span class="dm-card-detail">${face.length} landmarks tracked</span>
  </div>`;
}

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function _log(message) {
  if (!els.log) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString();
  const msg = document.createElement('span');
  msg.textContent = ' ' + message;
  entry.appendChild(time);
  entry.appendChild(msg);
  els.log.prepend(entry);
  while (els.log.children.length > 100) els.log.removeChild(els.log.lastChild);
}

module.exports = {
  initMediaPipe,
  startMediaPipe,
  stopMediaPipe,
};
