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
    _addBatch(data.messages);
  });
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

function _addBatch(messages) {
  if (!monitorEl || !Array.isArray(messages)) return;
  for (const { address, args } of messages) {
    if (!_matchesMode(address)) continue;
    _pendingUpdates.set(address, _formatArgs(args));
  }
  _scheduleFlush();
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

module.exports = { init, addOscMessage, clearMonitor, setMode };
