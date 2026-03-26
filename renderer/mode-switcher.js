// Mode switcher: manages transitions between BLIP, MediaPipe, Teachable Machine
const roi = require('./roi');

let currentMode = 'blip'; // 'blip' | 'mediapipe' | 'teachable'
let modes = {}; // { blip, mediapipe, teachable }

function init(modeModules) {
  modes = modeModules;

  // Bind tab buttons
  const tabs = document.querySelectorAll('.mode-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const newMode = tab.dataset.mode;
      if (newMode !== currentMode) {
        switchMode(newMode);
      }
    });
  });
}

function switchMode(newMode) {
  if (newMode === currentMode && document.querySelector('.mode-panel.mode-' + newMode).style.display !== 'none') {
    return;
  }

  // Stop current mode
  _stopCurrentMode();

  const prevMode = currentMode;
  currentMode = newMode;

  // Update tab buttons
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === newMode);
  });

  // Show/hide mode panels
  document.querySelectorAll('.mode-panel').forEach(panel => {
    panel.style.display = 'none';
  });
  const activePanel = document.querySelector('.mode-panel.mode-' + newMode);
  if (activePanel) activePanel.style.display = '';

  // Show/hide mode-specific settings sections
  document.querySelectorAll('.settings-blip-only').forEach(el => {
    el.style.display = newMode === 'blip' ? '' : 'none';
  });
  document.querySelectorAll('.settings-mediapipe-only').forEach(el => {
    el.style.display = newMode === 'mediapipe' ? '' : 'none';
  });
  document.querySelectorAll('.settings-teachable-only').forEach(el => {
    el.style.display = newMode === 'teachable' ? '' : 'none';
  });

  // Show/hide caption display (BLIP only)
  const captionDisplay = document.getElementById('current-caption');
  if (captionDisplay) {
    captionDisplay.style.display = newMode === 'blip' ? '' : 'none';
  }

  // ROI interaction: enable for BLIP and Teachable, disable for MediaPipe
  const overlay = document.getElementById('roi-overlay');
  if (overlay) {
    overlay.style.pointerEvents = newMode === 'mediapipe' ? 'none' : 'auto';
  }

  // Clear canvas overlay when switching away from mediapipe
  if (prevMode === 'mediapipe' && newMode !== 'mediapipe') {
    roi.drawROIs();
  }

  // Start new mode
  _startNewMode(newMode);

  // Update status
  const statusEl = document.getElementById('mode-status');
  if (statusEl) {
    const labels = { blip: 'BLIP Caption', mediapipe: 'MediaPipe Tracking', teachable: 'Teachable Machine' };
    statusEl.textContent = labels[newMode] || '';
  }
}

function _stopCurrentMode() {
  switch (currentMode) {
    case 'blip':
      if (modes.blip) modes.blip.stopBlip();
      break;
    case 'mediapipe':
      if (modes.mediapipe) modes.mediapipe.stopMediaPipe();
      break;
    case 'teachable':
      if (modes.teachable) modes.teachable.stopTeachable();
      break;
  }
}

function _startNewMode(mode) {
  switch (mode) {
    case 'blip':
      // BLIP doesn't auto-start, user clicks Start button
      break;
    case 'mediapipe':
      if (modes.mediapipe) modes.mediapipe.startMediaPipe();
      break;
    case 'teachable':
      if (modes.teachable) modes.teachable.startTeachable();
      break;
  }
}

Object.defineProperty(module.exports, 'currentMode', {
  get: () => currentMode,
});

module.exports.init = init;
module.exports.switchMode = switchMode;
