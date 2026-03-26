// Teachable Machine mode - ported from teachable-machine-roi/renderer.js
// Uses shared ROI system, sends OSC via IPC instead of direct UDP

const tf = require('@tensorflow/tfjs');
const { ipcRenderer } = require('electron');
const { getROIs, setOnROIChanged, drawROIs: roiDrawROIs, clearROIs, removeROI } = require('../roi');
const oscMonitor = require('../osc-monitor');

let model = null;
let classLabels = [];
let inferenceTimer = null;
let latestResults = {}; // roiId -> { label, probability }
let active = false;

// DOM references
let els = {};

// Offscreen canvas for 224x224 crops
const cropCanvas = document.createElement('canvas');
cropCanvas.width = 224;
cropCanvas.height = 224;
const cropCtx = cropCanvas.getContext('2d');

function initTeachable(elements) {
  els = elements;

  // Load URL button
  if (els.loadUrlBtn) {
    els.loadUrlBtn.addEventListener('click', () => {
      if (els.urlPopover) {
        els.urlPopover.style.display = els.urlPopover.style.display === 'none' ? '' : 'none';
        if (els.urlPopover.style.display !== 'none' && els.modelUrlInput) {
          els.modelUrlInput.focus();
        }
      }
    });
  }

  // URL submit
  if (els.urlSubmitBtn) {
    els.urlSubmitBtn.addEventListener('click', _loadFromUrl);
  }
  if (els.modelUrlInput) {
    els.modelUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _loadFromUrl();
    });
  }

  // Load ZIP button
  if (els.loadZipBtn) {
    els.loadZipBtn.addEventListener('click', _loadFromZip);
  }

  // Clear ROIs
  if (els.clearRoisBtn) {
    els.clearRoisBtn.addEventListener('click', () => {
      clearROIs();
      latestResults = {};
      _updateROIList();
      _restartInference();
    });
  }
}

function startTeachable() {
  active = true;
  // Set the ROI change callback to our handler
  setOnROIChanged(_onROIChanged);
  _updateROIList();
  _restartInference();
}

function stopTeachable() {
  active = false;
  if (inferenceTimer) {
    clearInterval(inferenceTimer);
    inferenceTimer = null;
  }
}

// --- Model loading ---
async function _loadFromUrl() {
  if (!els.modelUrlInput) return;
  const url = els.modelUrlInput.value.trim();
  if (!url) return;

  if (els.urlSubmitBtn) els.urlSubmitBtn.disabled = true;
  try {
    // Clear browser cache first
    try { await ipcRenderer.invoke('clear-cache'); } catch (_) {}
    const base = url.endsWith('/') ? url : url + '/';
    await _loadModelFromBase(base, false);
    if (els.urlPopover) els.urlPopover.style.display = 'none';
  } catch (err) {
    if (els.modelStatus) els.modelStatus.textContent = `Error: ${err.message}`;
  }
  if (els.urlSubmitBtn) els.urlSubmitBtn.disabled = false;
}

async function _loadFromZip() {
  if (els.loadZipBtn) els.loadZipBtn.disabled = true;
  try {
    const extractDir = await ipcRenderer.invoke('select-model-zip');
    if (!extractDir) {
      if (els.loadZipBtn) els.loadZipBtn.disabled = false;
      return;
    }
    const base = 'file://' + extractDir + '/';
    await _loadModelFromBase(base, true);
  } catch (err) {
    if (els.modelStatus) els.modelStatus.textContent = `Error: ${err.message}`;
  }
  if (els.loadZipBtn) els.loadZipBtn.disabled = false;
}

async function _loadModelFromBase(base, useCache) {
  if (els.modelStatus) els.modelStatus.textContent = 'Loading model...';

  const fetchOpts = useCache ? {} : { cache: 'no-store' };
  const cacheBust = useCache ? '' : '?v=' + Date.now();

  // Load metadata
  const metaRes = await fetch(base + 'metadata.json' + cacheBust, fetchOpts);
  const metadata = await metaRes.json();
  classLabels = metadata.labels || [];
  if (els.modelStatus) {
    els.modelStatus.textContent = `Classes: ${classLabels.join(', ')} - loading weights...`;
  }

  // Load TF model
  const loadOpts = useCache ? {} : {
    fetchFunc: (input, init) => {
      const u = typeof input === 'string' ? input : input.url;
      const sep = u.includes('?') ? '&' : '?';
      return fetch(u + sep + 'v=' + Date.now(), { ...init, cache: 'no-store' });
    },
  };
  model = await tf.loadLayersModel(base + 'model.json' + cacheBust, loadOpts);
  if (els.modelStatus) {
    els.modelStatus.textContent = `Loaded: ${classLabels.length} classes (${classLabels.join(', ')})`;
  }
  _restartInference();
}

// --- Inference ---
async function _runInference() {
  if (!model || !active) return;

  const rois = getROIs();
  if (rois.length === 0) return;

  const video = els.video;
  if (!video || !video.videoWidth || !video.videoHeight) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const oscPrefix = (els.oscPrefixInput && els.oscPrefixInput.value.trim()) || '/tm/roi';

  for (const roi of rois) {
    const sx = Math.round(roi.x * vw);
    const sy = Math.round(roi.y * vh);
    const sw = Math.round(roi.w * vw);
    const sh = Math.round(roi.h * vh);

    if (sw < 1 || sh < 1) continue;

    // Crop ROI to 224x224
    cropCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 224, 224);

    // Run prediction
    const tensor = tf.tidy(() => {
      return tf.browser.fromPixels(cropCanvas)
        .toFloat()
        .div(127.5)
        .sub(1)
        .expandDims(0);
    });

    const prediction = await model.predict(tensor);
    const probabilities = await prediction.data();
    tensor.dispose();
    prediction.dispose();

    const predictions = classLabels.map((label, i) => ({
      label,
      probability: probabilities[i] || 0,
    }));

    // Store top prediction for overlay
    const top = predictions.reduce((a, b) => a.probability > b.probability ? a : b);
    latestResults[roi.id] = { label: top.label, probability: top.probability };

    // Send OSC via IPC
    _sendOSC(roi, predictions, oscPrefix);
  }

  // Redraw ROIs with classification results on overlay
  _drawROIsWithResults();
}

function _sendOSC(roi, predictions, prefix) {
  const roiName = roi.name || `ROI_${roi.id}`;
  const top = predictions.reduce((a, b) => a.probability > b.probability ? a : b);

  // Send class name
  const classAddr = `${prefix}/${roiName}/class`;
  ipcRenderer.send('osc:send', {
    address: classAddr,
    args: [{ type: 's', value: top.label }],
  });
  oscMonitor.addOscMessage(classAddr, [{ type: 's', value: top.label }], Date.now());

  // Send confidence
  const confAddr = `${prefix}/${roiName}/confidence`;
  ipcRenderer.send('osc:send', {
    address: confAddr,
    args: [{ type: 'f', value: top.probability }],
  });
  oscMonitor.addOscMessage(confAddr, [{ type: 'f', value: top.probability }], Date.now());

  // Send per-class probabilities
  predictions.forEach((p, i) => {
    const addr = `${prefix}/${roiName}/prob/${i}`;
    ipcRenderer.send('osc:send', {
      address: addr,
      args: [{ type: 's', value: p.label }, { type: 'f', value: p.probability }],
    });
    oscMonitor.addOscMessage(addr, [{ type: 's', value: p.label }, { type: 'f', value: p.probability }], Date.now());
  });
}

function _drawROIsWithResults() {
  // Use the shared roi overlay context
  const overlay = els.overlay || document.getElementById('roi-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');

  // Resize if needed
  const container = overlay.parentElement;
  if (container) {
    const rect = container.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
      overlay.width = rect.width;
      overlay.height = rect.height;
    }
  }

  const video = els.video;
  if (!video || !video.videoWidth) {
    roiDrawROIs();
    return;
  }

  // Compute video render rect (handles letterboxing)
  const vAspect = video.videoWidth / video.videoHeight;
  const oAspect = overlay.width / overlay.height;
  let rw, rh, rx, ry;
  if (vAspect > oAspect) {
    rw = overlay.width;
    rh = overlay.width / vAspect;
    rx = 0;
    ry = (overlay.height - rh) / 2;
  } else {
    rh = overlay.height;
    rw = overlay.height * vAspect;
    ry = 0;
    rx = (overlay.width - rw) / 2;
  }

  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const rois = getROIs();
  for (const roi of rois) {
    const ox = rx + roi.x * rw;
    const oy = ry + roi.y * rh;
    const ow = roi.w * rw;
    const oh = roi.h * rh;

    // Rectangle
    ctx.strokeStyle = roi.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, ow, oh);
    ctx.fillStyle = roi.color + '30';
    ctx.fillRect(ox, oy, ow, oh);

    // Label with detection result
    const result = latestResults[roi.id];
    const displayName = roi.name || `ROI_${roi.id}`;
    const labelText = result
      ? `${displayName}: ${result.label} (${(result.probability * 100).toFixed(0)}%)`
      : displayName;

    ctx.font = 'bold 13px sans-serif';
    const textWidth = ctx.measureText(labelText).width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(ox, oy - 20, textWidth + 8, 20);
    ctx.fillStyle = roi.color;
    ctx.fillText(labelText, ox + 4, oy - 6);

    // Corner handles
    const corners = [[ox, oy], [ox + ow, oy], [ox, oy + oh], [ox + ow, oy + oh]];
    ctx.fillStyle = roi.color;
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - 4, cy - 4, 8, 8);
    }
  }
}

function _restartInference() {
  if (inferenceTimer) clearInterval(inferenceTimer);
  if (!active) return;

  const interval = (els.inferenceIntervalInput && parseInt(els.inferenceIntervalInput.value)) || 200;
  const rois = getROIs();

  if (model && rois.length > 0) {
    inferenceTimer = setInterval(_runInference, interval);
  }
}

function _onROIChanged() {
  _updateROIList();
  _restartInference();
}

function _updateROIList() {
  if (!els.roiListEl) return;
  const rois = getROIs();
  els.roiListEl.innerHTML = '';

  rois.forEach(roi => {
    const div = document.createElement('div');
    div.className = 'tm-roi-item';
    div.innerHTML = `
      <span class="roi-color-dot" style="background:${roi.color}"></span>
      <input type="text" class="tm-roi-name" value="${roi.name}" spellcheck="false" />
      <span class="tm-roi-result">${_formatResult(roi.id)}</span>
      <button class="btn-remove-roi" data-id="${roi.id}">X</button>
    `;

    // Name editing
    const nameInput = div.querySelector('.tm-roi-name');
    nameInput.addEventListener('change', (e) => {
      roi.name = e.target.value.trim().replace(/\s+/g, '_') || `ROI_${roi.id}`;
      e.target.value = roi.name;
      oscMonitor.clearMonitor();
      _drawROIsWithResults();
    });

    // Remove button
    div.querySelector('.btn-remove-roi').addEventListener('click', () => {
      delete latestResults[roi.id];
      removeROI(roi.id);
      _updateROIList();
      _restartInference();
    });

    els.roiListEl.appendChild(div);
  });
}

function _formatResult(roiId) {
  const r = latestResults[roiId];
  if (!r) return '';
  return `${r.label} (${(r.probability * 100).toFixed(0)}%)`;
}

module.exports = {
  initTeachable,
  startTeachable,
  stopTeachable,
};
