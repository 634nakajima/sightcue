// OSC Monitor: displays OSC messages from both Socket.io and IPC
// Filters by active mode
const { ipcRenderer } = require('electron');

const _oscRows = {}; // address -> DOM row element
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

function addOscMessage(address, args, timestamp) {
  if (!monitorEl) return;
  if (!_matchesMode(address)) return;

  let valStr;
  if (Array.isArray(args)) {
    valStr = args.map(a => {
      if (typeof a === 'object' && a !== null && 'value' in a) {
        return typeof a.value === 'number' ? a.value.toFixed(3) : String(a.value);
      }
      return typeof a === 'number' ? a.toFixed(3) : String(a);
    }).join(' ');
  } else {
    valStr = String(args);
  }

  let row = _oscRows[address];
  if (row) {
    row.querySelector('.osc-val').textContent = valStr;
  } else {
    row = document.createElement('div');
    row.className = 'osc-row';
    row.innerHTML = `<span class="osc-addr">${address}</span><span class="osc-val">${valStr}</span>`;
    monitorEl.appendChild(row);
    _oscRows[address] = row;
  }
}

function clearMonitor() {
  if (!monitorEl) return;
  monitorEl.innerHTML = '';
  Object.keys(_oscRows).forEach(k => delete _oscRows[k]);
}

module.exports = { init, addOscMessage, clearMonitor, setMode };
