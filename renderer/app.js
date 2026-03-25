const { enumerateCameras, startCamera, stopCamera, captureFrame } = require('./camera');
const { initROI, resizeOverlay, getROICrops, getROIs, removeROI, clearROIs, setROICaption, setOnROIChanged, drawROIs } = require('./roi');
const io = require('socket.io-client');

const PYTHON_PORT = 5555;
const socket = io(`http://localhost:${PYTHON_PORT}`);

let pipelineRunning = false;
let pipelineLoading = false;
let captureTimer = null;
let captureInterval = 0.5; // seconds

// --- Init ---
window.addEventListener('DOMContentLoaded', async () => {
  const video = document.getElementById('webcam');
  const overlay = document.getElementById('roi-overlay');

  // Camera selector
  const cameras = await enumerateCameras();
  const select = document.getElementById('camera-select');
  cameras.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    select.appendChild(opt);
  });

  select.addEventListener('change', async () => {
    await startCamera(select.value, video);
    resizeOverlay();
  });

  // Start default camera
  if (cameras.length > 0) {
    await startCamera(cameras[0].deviceId, video);
  }

  // Init ROI overlay
  initROI(overlay, video);
  video.addEventListener('loadedmetadata', resizeOverlay);
  window.addEventListener('resize', resizeOverlay);
  setTimeout(resizeOverlay, 500);

  // ROI list update callback
  setOnROIChanged(updateROIList);
});

// --- Pipeline Control ---
window.togglePipeline = function() {
  if (pipelineLoading) return;
  if (pipelineRunning) {
    socket.emit('pipeline:stop');
    stopCapture();
  } else {
    pipelineLoading = true;
    document.getElementById('btn-toggle').disabled = true;
    document.getElementById('loading-msg').style.display = 'inline';
    document.getElementById('loading-msg').textContent = 'Loading models... (first time may take a few minutes)';
    socket.emit('pipeline:start');
  }
};

function startCapture() {
  stopCapture();
  captureTimer = setInterval(captureAndSend, captureInterval * 1000);
}

function stopCapture() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

function captureAndSend() {
  const video = document.getElementById('webcam');
  if (!video || !video.videoWidth) return;

  const rois = getROIs();
  if (rois.length > 0) {
    const crops = getROICrops(video);
    if (crops.length > 0) {
      socket.emit('frame:rois', { rois: crops });
    }
  } else {
    const b64 = captureFrame(video);
    socket.emit('frame:full', { image_b64: b64 });
  }
}

// --- Trigger Management ---
window.addTrigger = function() {
  const desc = document.getElementById('trigger-desc').value.trim();
  const threshold = parseFloat(document.getElementById('trigger-threshold').value);
  if (!desc) return;
  socket.emit('trigger:add', { description: desc, threshold: threshold });
  document.getElementById('trigger-desc').value = '';
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('trigger-desc').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') window.addTrigger();
  });
});

window.removeTrigger = function(id) {
  socket.emit('trigger:remove', { id: id });
};

let _sliderDragging = false;

function renderTriggers(triggers) {
  if (_sliderDragging) return; // Don't rebuild DOM while dragging
  const list = document.getElementById('trigger-list');
  list.innerHTML = '';
  triggers.forEach(t => {
    const li = document.createElement('li');
    li.id = `trigger-${t.id}`;
    li.innerHTML = `
      <span class="trigger-index">${t.index || '?'}</span>
      <span class="trigger-desc">${t.description}</span>
      <input type="range" class="trigger-slider" min="0" max="1" step="0.01" value="${t.threshold}" />
      <span class="trigger-threshold">${t.threshold}</span>
      <button onclick="removeTrigger('${t.id}')">Remove</button>
    `;
    const slider = li.querySelector('.trigger-slider');
    const label = li.querySelector('.trigger-threshold');

    slider.addEventListener('mousedown', () => { _sliderDragging = true; });
    slider.addEventListener('touchstart', () => { _sliderDragging = true; });
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      label.textContent = val.toFixed(2);
      _debouncedThresholdUpdate(t.id, val);
    });
    slider.addEventListener('mouseup', () => { _sliderDragging = false; });
    slider.addEventListener('touchend', () => { _sliderDragging = false; });
    // Also handle mouse leaving the slider while dragging
    document.addEventListener('mouseup', () => { _sliderDragging = false; });

    list.appendChild(li);
  });
}

let _thresholdTimers = {};
function _debouncedThresholdUpdate(id, val) {
  clearTimeout(_thresholdTimers[id]);
  _thresholdTimers[id] = setTimeout(() => {
    socket.emit('trigger:update', { id: id, threshold: val });
  }, 200);
}

// --- ROI List UI ---
function updateROIList() {
  const list = document.getElementById('roi-list');
  const rois = getROIs();
  list.innerHTML = '';
  rois.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="trigger-desc" style="color:${r.color}">${r.name}</span>
      <button onclick="removeROIById(${r.id})">Remove</button>
    `;
    list.appendChild(li);
  });
}

window.removeROIById = function(id) {
  removeROI(id);
  updateROIList();
};

window.clearAllROIs = function() {
  clearROIs();
  updateROIList();
};

// --- Settings Popup ---
window.toggleSettings = function() {
  const overlay = document.getElementById('settings-overlay');
  overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
};

window.closeSettingsOutside = function(e) {
  if (e.target === e.currentTarget) toggleSettings();
};

window.applySettings = function() {
  socket.emit('config:update', {
    osc_host: document.getElementById('osc-host').value,
    osc_port: parseInt(document.getElementById('osc-port').value),
  });
  captureInterval = parseFloat(document.getElementById('capture-interval').value);
  if (captureTimer) {
    startCapture();
  }
  toggleSettings();
};

window.updateInterval = function() {
  captureInterval = parseFloat(document.getElementById('capture-interval').value);
  if (captureTimer) {
    startCapture(); // restart with new interval
  }
};

// --- Socket Events ---
socket.on('trigger:list', renderTriggers);
socket.on('trigger:added', () => socket.emit('trigger:list'));

socket.on('caption:update', (data) => {
  document.getElementById('current-caption').textContent = data.text;
  addLogEntry(data.timestamp, data.text, `(${data.inference_time}s)`);

  if (pipelineLoading) {
    pipelineLoading = false;
    document.getElementById('btn-toggle').disabled = false;
    document.getElementById('loading-msg').style.display = 'none';
  }
});

socket.on('roi:caption', (data) => {
  setROICaption(data.roi_id, data.caption);
  addLogEntry(data.timestamp, `[${data.roi_name}] ${data.caption}`, '');
});

socket.on('trigger:fired', (data) => {
  const prefix = data.roi_name ? `[${data.roi_name}] ` : '';
  addLogEntry(data.timestamp, `${prefix}TRIGGER: ${data.description} (${data.similarity})`, '', true);

  const li = document.getElementById(`trigger-${data.trigger_id}`);
  if (li) {
    li.classList.add('fired');
    setTimeout(() => li.classList.remove('fired'), 2000);
  }
});

// --- Similarity Monitor with draggable threshold ---
let _simDragging = null; // trigger_id being dragged, or null

socket.on('similarities:update', (data) => {
  if (_simDragging) return; // Don't touch DOM while dragging
  const monitor = document.getElementById('similarity-monitor');

  // Build a key for each row: trigger_id (+ roi_id if present)
  const existingRows = {};
  monitor.querySelectorAll('.sim-row').forEach(row => {
    existingRows[row.dataset.key] = row;
  });

  const seenKeys = new Set();

  data.forEach(s => {
    const key = s.roi_name ? `${s.trigger_id}_${s.roi_id}` : s.trigger_id;
    seenKeys.add(key);

    const pct = Math.max(0, Math.min(100, s.similarity * 100));
    const threshPct = s.threshold * 100;
    let level = 'low';
    if (s.similarity >= s.threshold) level = 'high';
    else if (s.similarity >= s.threshold * 0.7) level = 'mid';

    let row = existingRows[key];
    if (row) {
      // Update existing row in-place (no DOM rebuild)
      const bar = row.querySelector('.sim-bar');
      bar.style.width = pct + '%';
      bar.className = 'sim-bar ' + level;
      row.querySelector('.sim-threshold').style.left = threshPct + '%';
      row.querySelector('.sim-value').textContent = s.similarity.toFixed(3);
    } else {
      // Create new row
      const roiLabel = s.roi_name ? `[${s.roi_name}] ` : '';
      row = document.createElement('div');
      row.className = 'sim-row';
      row.dataset.key = key;
      row.innerHTML = `
        <span class="sim-label" title="${s.description}">${roiLabel}${s.description}</span>
        <div class="sim-bar-wrap" data-trigger-id="${s.trigger_id}">
          <div class="sim-bar ${level}" style="width: ${pct}%"></div>
          <div class="sim-threshold" style="left: ${threshPct}%"></div>
        </div>
        <span class="sim-value">${s.similarity.toFixed(3)}</span>
      `;
      _attachSimDrag(row, s.trigger_id);
      monitor.appendChild(row);
    }
  });

  // Remove rows no longer present
  monitor.querySelectorAll('.sim-row').forEach(row => {
    if (!seenKeys.has(row.dataset.key)) row.remove();
  });
});

function _attachSimDrag(row, triggerId) {
  const barWrap = row.querySelector('.sim-bar-wrap');
  const threshLine = row.querySelector('.sim-threshold');

  function startDrag(e) {
    _simDragging = triggerId;
    updateFromMouse(e);
    e.preventDefault();
  }

  function updateFromMouse(e) {
    const rect = barWrap.getBoundingClientRect();
    const val = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    threshLine.style.left = (val * 100) + '%';
    _debouncedThresholdUpdate(triggerId, parseFloat(val.toFixed(2)));
  }

  threshLine.addEventListener('mousedown', startDrag);
  barWrap.addEventListener('mousedown', startDrag);

  document.addEventListener('mousemove', (e) => {
    if (_simDragging !== triggerId) return;
    updateFromMouse(e);
  });

  document.addEventListener('mouseup', () => {
    if (_simDragging === triggerId) _simDragging = null;
  });
}

socket.on('status:update', (status) => {
  pipelineRunning = status.running;
  document.getElementById('st-device').textContent = status.device;
  document.getElementById('st-models').textContent = status.models_loaded ? 'Loaded' : 'Not loaded';
  document.getElementById('st-inference').textContent = `${status.inference_duration}s/frame`;

  const btn = document.getElementById('btn-toggle');
  btn.textContent = status.running ? 'Stop' : 'Start';
  btn.className = status.running ? 'running' : '';

  // Only clear loading state when models are actually loaded or pipeline is stopped
  if (status.models_loaded || !status.running) {
    btn.disabled = false;
    pipelineLoading = false;
    document.getElementById('loading-msg').style.display = 'none';
  }

  if (status.running && !captureTimer && status.models_loaded) {
    startCapture();
  }
  if (!status.running) {
    stopCapture();
  }
});

socket.on('loading:update', (data) => {
  document.getElementById('loading-msg').textContent = data.message;
  document.getElementById('loading-msg').style.display = 'inline';
});

function addLogEntry(timestamp, text, suffix, isTrigger) {
  const log = document.getElementById('caption-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  if (isTrigger) {
    entry.innerHTML = `<span class="log-time">${timestamp}</span><span class="log-trigger">${text}</span>`;
  } else {
    entry.innerHTML = `<span class="log-time">${timestamp}</span>${text} <span style="color:#888">${suffix}</span>`;
  }
  log.prepend(entry);
  while (log.children.length > 100) log.removeChild(log.lastChild);
}

// --- OSC Monitor (in-place update, teachable-machine-roi style) ---
const _oscRows = {}; // address -> DOM row

socket.on('osc:sent', (data) => {
  const monitor = document.getElementById('osc-monitor');
  const addr = data.address;
  const valStr = data.args.join(' ');

  let row = _oscRows[addr];
  if (row) {
    // Update value in-place
    row.querySelector('.osc-val').textContent = valStr;
  } else {
    // Create new row
    row = document.createElement('div');
    row.className = 'osc-row';
    row.innerHTML = `<span class="osc-addr">${addr}</span><span class="osc-val">${valStr}</span>`;
    monitor.appendChild(row);
    _oscRows[addr] = row;
  }
});

socket.emit('status:request');
