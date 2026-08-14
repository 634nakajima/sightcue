// Shared geometry helpers for quadrilateral detection.
// Kept separate so the region-based and line-based detectors can both use them
// without depending on each other.

/**
 * Per-corner median of several detections, to damp the frame-to-frame jitter a
 * single noisy frame would otherwise bake into the region.
 * @param {Array<Array<{x: number, y: number}>>} quads - already corner-ordered
 * @returns {Array<{x: number, y: number}>|null}
 */
function medianQuad(quads) {
  if (!Array.isArray(quads) || quads.length === 0) return null;
  const valid = quads.filter(q => Array.isArray(q) && q.length === 4);
  if (valid.length === 0) return null;

  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const out = [];
  for (let corner = 0; corner < 4; corner++) {
    out.push({
      x: median(valid.map(q => q[corner].x)),
      y: median(valid.map(q => q[corner].y)),
    });
  }
  return out;
}

// ── Geometry ────────────────────────────────────────────────

// Andrew's monotone chain, counter-clockwise in image coordinates
function convexHull(points) {
  if (points.length < 3) return points.slice();

  const sorted = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// approxPolyDP with an epsilon sweep, as OpenCV recipes do by hand, falling
// back to the largest-area quad the hull can produce.
function _approxQuad(hull) {
  const perimeter = _perimeter(hull);
  for (let step = 1; step <= 40; step++) {
    const epsilon = perimeter * (step * 0.005);
    const approx = _douglasPeucker(hull, epsilon);
    if (approx.length === 4) return approx;
    if (approx.length < 4) break; // further simplification only loses vertices
  }
  return _maxAreaQuad(hull);
}

function _douglasPeucker(points, epsilon) {
  // Closed contour: split at the two farthest-apart vertices, simplify each arc
  if (points.length <= 4) return points.slice();

  let a = 0;
  let b = 0;
  let maxDist = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = _dist2(points[i], points[j]);
      if (d > maxDist) { maxDist = d; a = i; b = j; }
    }
  }

  const first = points.slice(a, b + 1);
  const second = points.slice(b).concat(points.slice(0, a + 1));
  const simplified = _simplifyArc(first, epsilon).slice(0, -1)
    .concat(_simplifyArc(second, epsilon).slice(0, -1));
  return simplified;
}

function _simplifyArc(points, epsilon) {
  if (points.length < 3) return points.slice();

  let index = 0;
  let maxDist = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = _pointSegmentDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; index = i; }
  }

  if (maxDist <= epsilon) return [first, last];
  const left = _simplifyArc(points.slice(0, index + 1), epsilon);
  const right = _simplifyArc(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

// Brute force over a subsampled hull - only runs when the epsilon sweep failed
function _maxAreaQuad(hull) {
  const pts = _subsample(hull, 24);
  const n = pts.length;
  if (n < 4) return null;

  let best = null;
  let bestArea = 0;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const quad = [pts[i], pts[j], pts[k], pts[l]];
          const area = _polygonArea(quad);
          if (area > bestArea) { bestArea = area; best = quad; }
        }
      }
    }
  }
  return best;
}

function _subsample(points, max) {
  if (points.length <= max) return points.slice();
  const out = [];
  const stride = points.length / max;
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * stride)]);
  return out;
}

/**
 * Sort four corners into TL, TR, BR, BL using the standard sum/difference
 * trick: x+y is smallest at the top-left and largest at the bottom-right,
 * while y-x is smallest at the top-right and largest at the bottom-left.
 */
function orderCorners(quad) {
  const bySum = quad.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const topLeft = bySum[0];
  const bottomRight = bySum[3];

  const rest = quad.filter(p => p !== topLeft && p !== bottomRight);
  const byDiff = rest.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const topRight = byDiff[0];
  const bottomLeft = byDiff[1];

  return [topLeft, topRight, bottomRight, bottomLeft];
}

function _polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function _isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

function _perimeter(points) {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += Math.sqrt(_dist2(points[i], points[(i + 1) % points.length]));
  }
  return total;
}

function _dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function _pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.sqrt(_dist2(p, a));
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

module.exports = {
  convexHull,
  orderCorners,
  medianQuad,
  approxQuad: _approxQuad,
  polygonArea: _polygonArea,
  isConvex: _isConvex,
  perimeter: _perimeter,
  dist2: _dist2,
  pointSegmentDistance: _pointSegmentDistance,
};
