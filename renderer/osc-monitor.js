// OSC Monitor: displays OSC messages from both Socket.io and IPC
// Filters by active mode, throttles DOM updates to ~10fps
const { ipcRenderer } = require('electron');

const _oscRows = {}; // address -> DOM row element
const _pendingUpdates = new Map(); // address -> formatted value string
let _flushTimer = null;
const FLUSH_INTERVAL_MS = 100;

let monitorEl = null;
let activeMode = 'blip'; // 'blip' | 'mediapipe' | 'teachable'

// Address prefixes per mode
const MODE_PREFIXES = {
  blip: ['/blip/'],
  mediapipe: ['/hand/', '/face/'],
  teachable: ['/tm/'],
};

function init() {
  monitorEl = document.getElementById('osc-monitor');
  if (!monitorEl) return;

  ipcRenderer.on('osc:monitor', (event, data) => {
    addOscMessage(data.address, data.args, data.timestamp);
  });

  ipcRenderer.on('osc:monitorBatch', (event, data) => {
    _addBatch(data.messages, data.prune);
  });

  const clearBtn = document.getElementById('osc-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearMonitor);
}

function setMode(mode) {
  if (mode !== activeMode) {
    activeMode = mode;
    clearMonitor();
  }
}

function _matchesMode(address) {
  const prefixes = MODE_PREFIXES[activeMode];
  if (!prefixes) return true;
  return prefixes.some(p => address.startsWith(p));
}

function _formatArgs(args) {
  if (Array.isArray(args)) {
    return args.map(a => {
      if (typeof a === 'object' && a !== null && 'value' in a) {
        return typeof a.value === 'number' ? a.value.toFixed(3) : String(a.value);
      }
      return typeof a === 'number' ? a.toFixed(3) : String(a);
    }).join(' ');
  }
  return String(args);
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(_flush, FLUSH_INTERVAL_MS);
}

function _flush() {
  _flushTimer = null;
  if (!monitorEl) {
    _pendingUpdates.clear();
    return;
  }
  for (const [address, valStr] of _pendingUpdates) {
    let row = _oscRows[address];
    if (row) {
      row.querySelector('.osc-val').textContent = valStr;
    } else {
      row = document.createElement('div');
      row.className = 'osc-row';
      const addrSpan = document.createElement('span');
      addrSpan.className = 'osc-addr';
      addrSpan.textContent = address;
      const valSpan = document.createElement('span');
      valSpan.className = 'osc-val';
      valSpan.textContent = valStr;
      row.appendChild(addrSpan);
      row.appendChild(valSpan);
      monitorEl.appendChild(row);
      _oscRows[address] = row;
    }
  }
  _pendingUpdates.clear();
}

function addOscMessage(address, args, timestamp) {
  if (!monitorEl) return;
  if (!_matchesMode(address)) return;
  _pendingUpdates.set(address, _formatArgs(args));
  _scheduleFlush();
}

// A batch is a complete snapshot of what the sender is emitting right now, so
// any known address under a `prune` prefix that is missing from it has stopped
// being sent (hand left the frame, point deselected) and must not linger.
function _addBatch(messages, prune) {
  if (!monitorEl || !Array.isArray(messages)) return;
  const seen = new Set();
  for (const { address, args } of messages) {
    if (!_matchesMode(address)) continue;
    _pendingUpdates.set(address, _formatArgs(args));
    seen.add(address);
  }

  if (Array.isArray(prune)) {
    const known = new Set([...Object.keys(_oscRows), ..._pendingUpdates.keys()]);
    for (const address of known) {
      if (seen.has(address)) continue;
      if (!prune.some(p => address.startsWith(p))) continue;
      _removeRow(address);
    }
  }

  _scheduleFlush();
}

function _removeRow(address) {
  _pendingUpdates.delete(address);
  const row = _oscRows[address];
  if (row) {
    row.remove();
    delete _oscRows[address];
  }
}

function clearMonitor() {
  if (!monitorEl) return;
  monitorEl.innerHTML = '';
  Object.keys(_oscRows).forEach(k => delete _oscRows[k]);
  _pendingUpdates.clear();
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
}

// Drop rows whose address starts with prefix, e.g. when a tracker is turned off
// and no further batches will arrive to prune them.
function clearPrefix(prefix) {
  if (!monitorEl) return;
  const known = new Set([...Object.keys(_oscRows), ..._pendingUpdates.keys()]);
  for (const address of known) {
    if (address.startsWith(prefix)) _removeRow(address);
  }
}

module.exports = { init, addOscMessage, clearMonitor, clearPrefix, setMode };
