// Quad region for MediaPipe tracking (AffectiveFlow-style perspective mapping).
//
// Four draggable corners (TL, TR, BR, BL) define a quad on the camera image.
// Landmarks inside it are remapped to 0-1 within the quad via a homography -
// the same transform AffectiveFlow's warper.py applies to the image, applied
// to the points instead. Landmarks outside the quad are not sent at all, but
// detection state is unaffected: a hand seen outside the region still counts
// as detected.

const STORAGE_KEY = 'sightcue.mediapipe.region';
const CORNER_HIT_RADIUS = 12; // px
const EDGE_EPS = 1e-9;        // tolerance for points exactly on a region edge
const DEFAULT_CORNERS = [
  { x: 0.15, y: 0.15 }, // TL
  { x: 0.85, y: 0.15 }, // TR
  { x: 0.85, y: 0.85 }, // BR
  { x: 0.15, y: 0.85 }, // BL
];
const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];
// Destination corners: the unit square, in the same TL/TR/BR/BL order
const DST = [[0, 0], [1, 0], [1, 1], [0, 1]];

let enabled = false;
let corners = DEFAULT_CORNERS.map(c => ({ ...c }));
let matrix = null;      // [h0..h7], h8 == 1
let matrixDirty = true;

let overlay = null;
let dragIndex = -1;
let onChange = null;
// The overlay canvas is shared with roi.js, so corner dragging is only live
// while MediaPipe mode owns it.
let interactive = false;

function initRegion(canvasElement) {
  overlay = canvasElement;
  _load();

  overlay.addEventListener('mousedown', _onMouseDown);
  overlay.addEventListener('mousemove', _onMouseMove);
  overlay.addEventListener('mouseup', _onMouseUp);
  overlay.addEventListener('mouseleave', _onMouseUp);
}

function setEnabled(value) {
  enabled = !!value;
  _save();
  if (onChange) onChange();
}

function isEnabled() {
  return enabled;
}

function setInteractive(value) {
  interactive = !!value;
  if (!interactive) dragIndex = -1;
}

function resetCorners() {
  corners = DEFAULT_CORNERS.map(c => ({ ...c }));
  matrixDirty = true;
  _save();
  if (onChange) onChange();
}

function getCorners() {
  return corners.map(c => ({ ...c }));
}

function setOnChange(cb) {
  onChange = cb;
}

// ── Homography ──────────────────────────────────────────────

// Solve the 8x8 system for h in
//   u = (h0 x + h1 y + h2) / (h6 x + h7 y + 1)
//   v = (h3 x + h4 y + h5) / (h6 x + h7 y + 1)
function _buildMatrix() {
  matrixDirty = false;
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = corners[i];
    const [u, v] = DST[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  matrix = _solve(A);
}

// Gaussian elimination with partial pivoting on an augmented 8x9 matrix.
// Returns null for a degenerate quad (collinear or coincident corners).
function _solve(A) {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-10) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row][col] / A[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) A[row][k] -= factor * A[col][k];
    }
  }
  // After full elimination each row is diagonal: A[i][i] * h[i] = A[i][n]
  return A.map((row, i) => row[n] / row[i]);
}

/**
 * Map a normalized camera coordinate into region space.
 * @returns {{u: number, v: number, inside: boolean}}
 */
function mapPoint(x, y) {
  if (matrixDirty) _buildMatrix();
  if (!matrix) return { u: x, v: y, inside: true };

  const [h0, h1, h2, h3, h4, h5, h6, h7] = matrix;
  const w = h6 * x + h7 * y + 1;
  if (Math.abs(w) < 1e-9) return { u: 0, v: 0, inside: false };

  const u = (h0 * x + h1 * y + h2) / w;
  const v = (h3 * x + h4 * y + h5) / w;
  // w < 0 means the point is on the far side of the projection plane.
  // EDGE_EPS keeps points sitting exactly on an edge (a corner maps to -1e-17
  // rather than 0) from being rejected as outside.
  const inside = w > 0
    && u >= -EDGE_EPS && u <= 1 + EDGE_EPS
    && v >= -EDGE_EPS && v <= 1 + EDGE_EPS;
  if (!inside) return { u, v, inside: false };
  return { u: _clamp01(u), v: _clamp01(v), inside: true };
}

function _clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// ── Drawing ─────────────────────────────────────────────────

function drawRegion(ctx, w, h) {
  if (!enabled) return;

  const pts = corners.map(c => [c.x * w, c.y * h]);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(233, 69, 96, 0.10)';
  ctx.fill();
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    ctx.fillStyle = i === dragIndex ? '#fff' : '#e94560';
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.fillText(CORNER_LABELS[i], px, py + 0.5);
  }
  ctx.restore();
}

// ── Corner dragging ─────────────────────────────────────────

function _eventPos(e) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
    rect,
  };
}

function _hitTest(nx, ny, rect) {
  for (let i = 0; i < corners.length; i++) {
    const dx = (nx - corners[i].x) * rect.width;
    const dy = (ny - corners[i].y) * rect.height;
    if (Math.hypot(dx, dy) <= CORNER_HIT_RADIUS) return i;
  }
  return -1;
}

function _onMouseDown(e) {
  if (!enabled || !interactive || !overlay) return;
  const { x, y, rect } = _eventPos(e);
  dragIndex = _hitTest(x, y, rect);
  if (dragIndex >= 0) e.stopPropagation();
}

function _onMouseMove(e) {
  if (!enabled || !interactive || !overlay) return;
  const { x, y, rect } = _eventPos(e);

  if (dragIndex < 0) {
    overlay.style.cursor = _hitTest(x, y, rect) >= 0 ? 'grab' : 'default';
    return;
  }

  corners[dragIndex] = {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
  matrixDirty = true;
  overlay.style.cursor = 'grabbing';
  if (onChange) onChange();
}

function _onMouseUp() {
  if (dragIndex < 0) return;
  dragIndex = -1;
  overlay.style.cursor = 'default';
  _save();
  if (onChange) onChange();
}

// ── Persistence ─────────────────────────────────────────────

function _load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch (err) {
    saved = null;
  }
  if (!saved) return;

  if (typeof saved.enabled === 'boolean') enabled = saved.enabled;
  if (Array.isArray(saved.corners) && saved.corners.length === 4) {
    const valid = saved.corners.every(c => typeof c.x === 'number' && typeof c.y === 'number');
    if (valid) corners = saved.corners.map(c => ({ x: c.x, y: c.y }));
  }
  matrixDirty = true;
}

function _save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, corners }));
  } catch (err) {
    // Storage unavailable - region just won't persist
  }
}

module.exports = {
  initRegion,
  setEnabled,
  isEnabled,
  setInteractive,
  resetCorners,
  getCorners,
  setOnChange,
  mapPoint,
  drawRegion,
};
