// ROI (Region of Interest) interaction system
// Supports per-mode independent ROI sets and configurable aspect ratio

const ROI_COLORS = [
  '#e94560', '#00b894', '#fdcb6e', '#6c5ce7', '#00cec9',
  '#fd79a8', '#55efc4', '#fab1a0', '#74b9ff', '#a29bfe',
];

// Per-mode ROI storage: { blip: [...], teachable: [...] }
const roiSets = {};
let activeMode = 'blip';
let roiIdCounters = {}; // per-mode counters

// Current mode's constraint: 'square' or 'free'
let aspectConstraint = 'square';

let dragMode = 'none';
let dragTarget = null;
let dragStart = { x: 0, y: 0 };
let dragAnchor = null;
let dragOffset = { dx: 0, dy: 0 };
const CORNER_HIT_RADIUS = 10;

let overlay = null;
let overlayCtx = null;
let videoEl = null;

let roiCaptions = {};
let onROIChanged = null;

function initROI(canvasElement, video) {
  overlay = canvasElement;
  overlayCtx = overlay.getContext('2d');
  videoEl = video;

  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
  overlay.addEventListener('mouseleave', onMouseUp);
}

/**
 * Switch active ROI set for the given mode.
 * @param {string} mode - 'blip' | 'teachable'
 * @param {'square'|'free'} constraint - aspect ratio constraint
 */
function switchROIMode(mode, constraint) {
  activeMode = mode;
  aspectConstraint = constraint || 'free';
  if (!roiSets[mode]) roiSets[mode] = [];
  if (!roiIdCounters[mode]) roiIdCounters[mode] = 0;
  roiCaptions = {};
  drawROIs();
}

function _rois() {
  if (!roiSets[activeMode]) roiSets[activeMode] = [];
  return roiSets[activeMode];
}

function resizeOverlay() {
  if (!overlay || !videoEl) return;
  const rect = overlay.parentElement.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;
  drawROIs();
}

// --- Coordinate conversion ---
function getVideoRenderRect() {
  if (!videoEl || !videoEl.videoWidth) return { x: 0, y: 0, w: overlay.width, h: overlay.height };
  const vAspect = videoEl.videoWidth / videoEl.videoHeight;
  const oAspect = overlay.width / overlay.height;
  let rw, rh, rx, ry;
  if (vAspect > oAspect) {
    rw = overlay.width; rh = overlay.width / vAspect; rx = 0; ry = (overlay.height - rh) / 2;
  } else {
    rh = overlay.height; rw = overlay.height * vAspect; ry = 0; rx = (overlay.width - rw) / 2;
  }
  return { x: rx, y: ry, w: rw, h: rh };
}

function overlayToNorm(ox, oy) {
  const r = getVideoRenderRect();
  return {
    nx: Math.max(0, Math.min(1, (ox - r.x) / r.w)),
    ny: Math.max(0, Math.min(1, (oy - r.y) / r.h)),
  };
}

function normToOverlay(nx, ny) {
  const r = getVideoRenderRect();
  return { ox: r.x + nx * r.w, oy: r.y + ny * r.h };
}

function normSizeToOverlay(nw, nh) {
  const r = getVideoRenderRect();
  return { ow: nw * r.w, oh: nh * r.h };
}

// --- Drawing ---
function drawROIs() {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  for (const roi of _rois()) {
    const { ox, oy } = normToOverlay(roi.x, roi.y);
    const { ow, oh } = normSizeToOverlay(roi.w, roi.h);

    overlayCtx.strokeStyle = roi.color;
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(ox, oy, ow, oh);
    overlayCtx.fillStyle = roi.color + '30';
    overlayCtx.fillRect(ox, oy, ow, oh);

    const caption = roiCaptions[roi.id] || '';
    const label = `${roi.name}${caption ? ': ' + caption : ''}`;
    overlayCtx.font = '12px -apple-system, sans-serif';
    const tw = overlayCtx.measureText(label).width;
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(ox, oy - 18, tw + 8, 18);
    overlayCtx.fillStyle = '#fff';
    overlayCtx.fillText(label, ox + 4, oy - 5);

    const corners = [[ox, oy], [ox + ow, oy], [ox, oy + oh], [ox + ow, oy + oh]];
    for (const [cx, cy] of corners) {
      overlayCtx.fillStyle = roi.color;
      overlayCtx.fillRect(cx - 4, cy - 4, 8, 8);
    }
  }
}

// --- Hit testing ---
function hitTestCorner(px, py) {
  for (const roi of _rois()) {
    const { ox, oy } = normToOverlay(roi.x, roi.y);
    const { ow, oh } = normSizeToOverlay(roi.w, roi.h);
    const corners = [[ox, oy, 0], [ox + ow, oy, 1], [ox, oy + oh, 2], [ox + ow, oy + oh, 3]];
    for (const [cx, cy, idx] of corners) {
      if (Math.abs(px - cx) < CORNER_HIT_RADIUS && Math.abs(py - cy) < CORNER_HIT_RADIUS) {
        return { roi, cornerIndex: idx };
      }
    }
  }
  return null;
}

function hitTestROI(px, py) {
  const rois = _rois();
  for (let i = rois.length - 1; i >= 0; i--) {
    const roi = rois[i];
    const { ox, oy } = normToOverlay(roi.x, roi.y);
    const { ow, oh } = normSizeToOverlay(roi.w, roi.h);
    if (px >= ox && px <= ox + ow && py >= oy && py <= oy + oh) return roi;
  }
  return null;
}

// --- Mouse handlers ---
function onMouseDown(e) {
  const rect = overlay.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  dragStart = { x: px, y: py };

  const corner = hitTestCorner(px, py);
  if (corner) {
    dragMode = 'resize';
    dragTarget = corner.roi;
    const ci = corner.cornerIndex;
    dragAnchor = {
      nx: (ci === 1 || ci === 3) ? dragTarget.x : dragTarget.x + dragTarget.w,
      ny: (ci === 2 || ci === 3) ? dragTarget.y : dragTarget.y + dragTarget.h,
    };
    return;
  }

  const hit = hitTestROI(px, py);
  if (hit) {
    dragMode = 'move';
    dragTarget = hit;
    const { ox, oy } = normToOverlay(hit.x, hit.y);
    dragOffset = { dx: px - ox, dy: py - oy };
    return;
  }

  dragMode = 'draw';
}

function onMouseMove(e) {
  const rect = overlay.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  if (dragMode === 'none') {
    const corner = hitTestCorner(px, py);
    if (corner) {
      const ci = corner.cornerIndex;
      overlay.style.cursor = (ci === 0 || ci === 3) ? 'nwse-resize' : 'nesw-resize';
    } else if (hitTestROI(px, py)) {
      overlay.style.cursor = 'move';
    } else {
      overlay.style.cursor = 'crosshair';
    }
    return;
  }

  if (dragMode === 'draw') {
    const { nx: nx1, ny: ny1 } = overlayToNorm(dragStart.x, dragStart.y);
    const { nx: nx2, ny: ny2 } = overlayToNorm(px, py);

    let dw, dh;
    if (aspectConstraint === 'square') {
      const size = Math.max(Math.abs(nx2 - nx1), Math.abs(ny2 - ny1));
      dw = size; dh = size;
    } else {
      dw = Math.abs(nx2 - nx1); dh = Math.abs(ny2 - ny1);
    }
    const sx = nx2 > nx1 ? 1 : -1;
    const sy = ny2 > ny1 ? 1 : -1;

    drawROIs();
    const { ox: pox, oy: poy } = normToOverlay(
      Math.min(nx1, nx1 + sx * dw), Math.min(ny1, ny1 + sy * dh)
    );
    const { ow, oh } = normSizeToOverlay(dw, dh);
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([4, 4]);
    overlayCtx.strokeRect(pox, poy, ow, oh);
    overlayCtx.setLineDash([]);
    return;
  }

  if (dragMode === 'move') {
    const { nx, ny } = overlayToNorm(px - dragOffset.dx, py - dragOffset.dy);
    dragTarget.x = Math.max(0, Math.min(1 - dragTarget.w, nx));
    dragTarget.y = Math.max(0, Math.min(1 - dragTarget.h, ny));
    drawROIs();
    return;
  }

  if (dragMode === 'resize') {
    const { nx, ny } = overlayToNorm(px, py);
    if (aspectConstraint === 'square') {
      const size = Math.max(Math.abs(nx - dragAnchor.nx), Math.abs(ny - dragAnchor.ny));
      dragTarget.x = Math.min(dragAnchor.nx, dragAnchor.nx + (nx > dragAnchor.nx ? 0 : -size));
      dragTarget.y = Math.min(dragAnchor.ny, dragAnchor.ny + (ny > dragAnchor.ny ? 0 : -size));
      dragTarget.w = size;
      dragTarget.h = size;
    } else {
      const newX = Math.min(nx, dragAnchor.nx);
      const newY = Math.min(ny, dragAnchor.ny);
      dragTarget.x = newX;
      dragTarget.y = newY;
      dragTarget.w = Math.abs(nx - dragAnchor.nx);
      dragTarget.h = Math.abs(ny - dragAnchor.ny);
    }
    drawROIs();
  }
}

function onMouseUp(e) {
  if (dragMode === 'draw') {
    const rect = overlay.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { nx: nx1, ny: ny1 } = overlayToNorm(dragStart.x, dragStart.y);
    const { nx: nx2, ny: ny2 } = overlayToNorm(px, py);

    let dw, dh;
    if (aspectConstraint === 'square') {
      const size = Math.max(Math.abs(nx2 - nx1), Math.abs(ny2 - ny1));
      dw = size; dh = size;
    } else {
      dw = Math.abs(nx2 - nx1); dh = Math.abs(ny2 - ny1);
    }

    if (dw > 0.02 && dh > 0.02) {
      const sx = nx2 > nx1 ? 1 : -1;
      const sy = ny2 > ny1 ? 1 : -1;
      if (!roiIdCounters[activeMode]) roiIdCounters[activeMode] = 0;
      roiIdCounters[activeMode]++;
      const roi = {
        id: roiIdCounters[activeMode],
        name: `ROI_${roiIdCounters[activeMode]}`,
        x: Math.min(nx1, nx1 + sx * dw),
        y: Math.min(ny1, ny1 + sy * dh),
        w: dw,
        h: dh,
        color: ROI_COLORS[_rois().length % ROI_COLORS.length],
      };
      _rois().push(roi);
      if (typeof onROIChanged === 'function') onROIChanged();
    }
  }

  dragMode = 'none';
  dragTarget = null;
  drawROIs();
}

// --- ROI crop for BLIP ---
const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');

function getROICrops(video, maxSize = 384) {
  if (!video || !video.videoWidth) return [];
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const crops = [];

  for (const roi of _rois()) {
    const sx = Math.round(roi.x * vw);
    const sy = Math.round(roi.y * vh);
    const sw = Math.round(roi.w * vw);
    const sh = Math.round(roi.h * vh);
    if (sw < 10 || sh < 10) continue;

    const cropW = Math.min(sw, maxSize);
    const cropH = Math.min(sh, maxSize);
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    cropCtx.drawImage(video, sx, sy, sw, sh, 0, 0, cropW, cropH);

    const b64 = cropCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    crops.push({ roi_id: roi.id, roi_name: roi.name, image_b64: b64 });
  }
  return crops;
}

function removeROI(id) {
  roiSets[activeMode] = _rois().filter(r => r.id !== id);
  delete roiCaptions[id];
  drawROIs();
  if (typeof onROIChanged === 'function') onROIChanged();
}

function clearROIs() {
  roiSets[activeMode] = [];
  roiCaptions = {};
  drawROIs();
  if (typeof onROIChanged === 'function') onROIChanged();
}

function renameROI(id, newName) {
  const roi = _rois().find(r => r.id === id);
  if (roi) {
    roi.name = newName.trim().replace(/\s+/g, '_') || `ROI_${roi.id}`;
    drawROIs();
  }
}

function setROICaption(roiId, caption) {
  roiCaptions[roiId] = caption;
  drawROIs();
}

function getROIs() {
  return _rois();
}

function setOnROIChanged(cb) { onROIChanged = cb; }

module.exports = {
  initROI, resizeOverlay, drawROIs, getROICrops, getROIs,
  removeROI, clearROIs, renameROI, setROICaption, setOnROIChanged,
  switchROIMode,
};
