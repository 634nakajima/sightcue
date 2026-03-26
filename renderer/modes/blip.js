// BLIP Caption mode - extracted from app.js
// Uses Socket.io to communicate with Python backend, IPC for lifecycle

const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const { captureFrame } = require('../camera');
const { getROIs, getROICrops, removeROI, clearROIs, renameROI, setROICaption, setOnROIChanged, drawROIs } = require('../roi');
const oscMonitor = require('../osc-monitor');

const PYTHON_PORT = 5555;

let socket = null;
let pipelineRunning = false;
let pipelineLoading = false;
let captureTimer = null;
let captureInterval = 0.5; // seconds

// DOM element references
let els = {};

// --- Similarity drag state ---
let _simDragging = null;
let _sliderDragging = false;
let _thresholdTimers = {};

function initBlip(elements) {
  els = elements;

  // Trigger input enter key
  if (els.triggerDesc) {
    els.triggerDesc.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTrigger();
    });
  }

  // ROI change callback
  setOnROIChanged(updateROIList);

  // Expose global functions
  window.blipToggle = togglePipeline;
  window.blipAddTrigger = addTrigger;
  window.blipRemoveTrigger = removeTriggerById;
  window.blipRemoveROI = removeROIById;
  window.blipClearROIs = clearAllROIs;
}

function startBlip() {
  // Re-register ROI callback (may have been overwritten by TM mode)
  setOnROIChanged(updateROIList);
  updateROIList();

  // Connect socket.io to Python backend (lazy start Python first)
  if (!socket) {
    _connectSocket();
  }
}

function stopBlip() {
  // Stop capture timer
  stopCapture();

  // Stop pipeline if running
  if (socket && pipelineRunning) {
    socket.emit('pipeline:stop');
  }

  // Disconnect socket
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  pipelineRunning = false;
  pipelineLoading = false;

  if (els.btnToggle) {
    els.btnToggle.textContent = 'Start';
    els.btnToggle.className = '';
    els.btnToggle.disabled = false;
  }
  if (els.loadingMsg) {
    els.loadingMsg.style.display = 'none';
  }
}

function setCaptureInterval(val) {
  captureInterval = val;
  if (captureTimer) {
    _startCapture();
  }
}

// --- Socket.io connection ---
function _connectSocket() {
  socket = io(`http://localhost:${PYTHON_PORT}`, { reconnection: true });

  socket.on('trigger:list', _renderTriggers);
  socket.on('trigger:added', () => socket.emit('trigger:list'));

  socket.on('caption:update', (data) => {
    if (els.captionDisplay) {
      els.captionDisplay.textContent = data.text;
    }
    _addLogEntry(data.timestamp, data.text, `(${data.inference_time}s)`);

    if (pipelineLoading) {
      pipelineLoading = false;
      if (els.btnToggle) els.btnToggle.disabled = false;
      if (els.loadingMsg) els.loadingMsg.style.display = 'none';
    }
  });

  socket.on('roi:caption', (data) => {
    setROICaption(data.roi_id, data.caption);
    _addLogEntry(data.timestamp, `[${data.roi_name}] ${data.caption}`, '');
  });

  socket.on('trigger:fired', (data) => {
    const prefix = data.roi_name ? `[${data.roi_name}] ` : '';
    _addLogEntry(data.timestamp, `${prefix}TRIGGER: ${data.description} (${data.similarity})`, '', true);

    const li = document.getElementById(`trigger-${data.trigger_id}`);
    if (li) {
      li.classList.add('fired');
      setTimeout(() => li.classList.remove('fired'), 2000);
    }
  });

  socket.on('similarities:update', _handleSimilarities);

  socket.on('status:update', (status) => {
    pipelineRunning = status.running;

    if (els.btnToggle) {
      els.btnToggle.textContent = status.running ? 'Stop' : 'Start';
      els.btnToggle.className = status.running ? 'running' : '';
    }

    // Info fields in settings
    const stDevice = document.getElementById('st-device');
    const stModels = document.getElementById('st-models');
    const stInference = document.getElementById('st-inference');
    if (stDevice) stDevice.textContent = status.device;
    if (stModels) stModels.textContent = status.models_loaded ? 'Loaded' : 'Not loaded';
    if (stInference) stInference.textContent = `${status.inference_duration}s/frame`;

    if (status.models_loaded || !status.running) {
      if (els.btnToggle) els.btnToggle.disabled = false;
      pipelineLoading = false;
      if (els.loadingMsg) els.loadingMsg.style.display = 'none';
    }

    if (status.running && !captureTimer && status.models_loaded) {
      _startCapture();
    }
    if (!status.running) {
      stopCapture();
    }
  });

  socket.on('loading:update', (data) => {
    if (els.loadingMsg) {
      els.loadingMsg.textContent = data.message;
      els.loadingMsg.style.display = 'inline';
    }
  });

  // OSC monitor from Socket.io (BLIP mode sends OSC via Python)
  socket.on('osc:sent', (data) => {
    oscMonitor.addOscMessage(data.address, data.args, Date.now());
  });

  socket.emit('status:request');
}

// --- Pipeline Control ---
function togglePipeline() {
  if (pipelineLoading) return;

  // Lazy-start Python backend
  if (!socket) {
    pipelineLoading = true;
    if (els.btnToggle) els.btnToggle.disabled = true;
    if (els.loadingMsg) {
      els.loadingMsg.style.display = 'inline';
      els.loadingMsg.textContent = 'Starting Python backend...';
    }

    ipcRenderer.invoke('python:start').then(() => {
      _connectSocket();
      // Now start pipeline
      setTimeout(() => {
        if (socket) {
          if (els.loadingMsg) {
            els.loadingMsg.textContent = 'Loading models... (first time may take a few minutes)';
          }
          socket.emit('pipeline:start');
        }
      }, 1000);
    }).catch(err => {
      console.error('[BLIP] Failed to start Python:', err);
      pipelineLoading = false;
      if (els.btnToggle) els.btnToggle.disabled = false;
      if (els.loadingMsg) els.loadingMsg.style.display = 'none';
    });
    return;
  }

  if (pipelineRunning) {
    socket.emit('pipeline:stop');
    stopCapture();
  } else {
    pipelineLoading = true;
    if (els.btnToggle) els.btnToggle.disabled = true;
    if (els.loadingMsg) {
      els.loadingMsg.style.display = 'inline';
      els.loadingMsg.textContent = 'Loading models... (first time may take a few minutes)';
    }
    socket.emit('pipeline:start');
  }
}

function _startCapture() {
  stopCapture();
  captureTimer = setInterval(_captureAndSend, captureInterval * 1000);
}

function stopCapture() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

function _captureAndSend() {
  const video = els.video;
  if (!video || !video.videoWidth) return;

  const rois = getROIs();
  if (rois.length > 0) {
    const crops = getROICrops(video);
    if (crops.length > 0 && socket) {
      socket.emit('frame:rois', { rois: crops });
    }
  } else {
    const b64 = captureFrame(video);
    if (socket) {
      socket.emit('frame:full', { image_b64: b64 });
    }
  }
}

// --- Trigger Management ---
function addTrigger() {
  if (!els.triggerDesc) return;
  const desc = els.triggerDesc.value.trim();
  const threshold = parseFloat(els.triggerThreshold.value);
  if (!desc || !socket) return;
  socket.emit('trigger:add', { description: desc, threshold: threshold });
  els.triggerDesc.value = '';
}

function removeTriggerById(id) {
  if (socket) socket.emit('trigger:remove', { id: id });
}

function _debouncedThresholdUpdate(id, val) {
  clearTimeout(_thresholdTimers[id]);
  _thresholdTimers[id] = setTimeout(() => {
    if (socket) socket.emit('trigger:update', { id: id, threshold: val });
  }, 200);
}

function _renderTriggers(triggers) {
  if (_sliderDragging || !els.triggerList) return;
  els.triggerList.innerHTML = '';
  triggers.forEach(t => {
    const li = document.createElement('li');
    li.id = `trigger-${t.id}`;
    li.innerHTML = `
      <span class="trigger-index">${t.index || '?'}</span>
      <span class="trigger-desc">${t.description}</span>
      <input type="range" class="trigger-slider" min="0" max="1" step="0.01" value="${t.threshold}" />
      <span class="trigger-threshold">${t.threshold}</span>
      <button onclick="blipRemoveTrigger('${t.id}')">Remove</button>
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
    document.addEventListener('mouseup', () => { _sliderDragging = false; });

    els.triggerList.appendChild(li);
  });
}

// --- Similarity Monitor ---
function _handleSimilarities(data) {
  if (_simDragging || !els.similarityMonitor) return;
  const monitor = els.similarityMonitor;

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
      const bar = row.querySelector('.sim-bar');
      bar.style.width = pct + '%';
      bar.className = 'sim-bar ' + level;
      row.querySelector('.sim-threshold').style.left = threshPct + '%';
      row.querySelector('.sim-value').textContent = s.similarity.toFixed(3);
    } else {
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

  monitor.querySelectorAll('.sim-row').forEach(row => {
    if (!seenKeys.has(row.dataset.key)) row.remove();
  });
}

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

// --- ROI List UI ---
function updateROIList() {
  if (!els.roiList) return;
  const rois = getROIs();
  els.roiList.innerHTML = '';
  rois.forEach(r => {
    const li = document.createElement('li');
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    li.style.gap = '8px';

    const dot = document.createElement('span');
    dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${r.color};flex-shrink:0`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = r.name;
    nameInput.spellcheck = false;
    nameInput.style.cssText = 'flex:1;background:#16213e;border:1px solid #0f3460;color:#e0e0e0;padding:3px 6px;border-radius:4px;font-size:12px';
    nameInput.addEventListener('change', () => {
      renameROI(r.id, nameInput.value);
      nameInput.value = r.name;
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur();
    });

    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      removeROI(r.id);
      updateROIList();
    });

    li.appendChild(dot);
    li.appendChild(nameInput);
    li.appendChild(btn);
    els.roiList.appendChild(li);
  });
}

function removeROIById(id) {
  removeROI(id);
  updateROIList();
}

function clearAllROIs() {
  clearROIs();
  updateROIList();
}

// --- Log ---
function _addLogEntry(timestamp, text, suffix, isTrigger) {
  const log = els.captionLog || document.getElementById('caption-log');
  if (!log) return;
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

module.exports = {
  initBlip,
  startBlip,
  stopBlip,
  setCaptureInterval,
};
