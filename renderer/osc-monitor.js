// OSC Monitor: displays OSC messages from both Socket.io and IPC
const { ipcRenderer } = require('electron');

const _oscRows = {}; // address -> DOM row element
let monitorEl = null;

function init() {
  monitorEl = document.getElementById('osc-monitor');
  if (!monitorEl) return;

  // Listen for IPC-based OSC monitor events (from main process, for MediaPipe/TM)
  ipcRenderer.on('osc:monitor', (event, data) => {
    addOscMessage(data.address, data.args, data.timestamp);
  });
}

/**
 * Add/update an OSC message in the monitor.
 * Uses in-place update: one row per address, value updates live.
 * @param {string} address - OSC address
 * @param {Array} args - Array of {type, value} or plain values
 * @param {number} [timestamp] - optional timestamp
 */
function addOscMessage(address, args, timestamp) {
  if (!monitorEl) return;

  // Format value string
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
    // Update value in-place
    row.querySelector('.osc-val').textContent = valStr;
  } else {
    // Create new row
    row = document.createElement('div');
    row.className = 'osc-row';
    row.innerHTML = `<span class="osc-addr">${address}</span><span class="osc-val">${valStr}</span>`;
    monitorEl.appendChild(row);
    _oscRows[address] = row;
  }
}

/**
 * Clear all rows from the monitor.
 */
function clearMonitor() {
  if (!monitorEl) return;
  monitorEl.innerHTML = '';
  Object.keys(_oscRows).forEach(k => delete _oscRows[k]);
}

module.exports = { init, addOscMessage, clearMonitor };
