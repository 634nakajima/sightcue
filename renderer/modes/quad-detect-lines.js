// Line-based quadrilateral detection.
//
// The region-based detector asks "which blob is the region", which breaks as
// soon as the target touches something of similar brightness: the two merge
// into one blob and the shape is lost. This one asks "which four straight
// edges bound the region" instead, so a merged interior does not matter.
//
// Sobel edges -> Hough lines -> pick two pairs of roughly parallel lines ->
// the four intersections form a candidate quad -> score by how much real edge
// evidence sits on its sides.

const {
  orderCorners,
  polygonArea,
  isConvex,
} = require('./quad-geometry');

const MAX_LINES = 14;          // Hough peaks kept
// Gradient magnitude cutoff. Sweeping this over several values and keeping the
// best-scoring quad was measurably worse on the synthetic clutter benchmark
// (19/20 -> 16/20 with distractors): a different threshold lets a small, crisp
// distractor outscore the real region. Left fixed on purpose.
const EDGE_PERCENTILE = 0.90;
const PARALLEL_TOLERANCE = 25 * Math.PI / 180; // "same family" angle spread
const CROSS_MIN_ANGLE = 35 * Math.PI / 180;    // families must actually cross
const SIDE_SAMPLES = 24;
const SUPPORT_RADIUS = 2;      // px: how far off a side an edge still counts
const MIN_SIDE_SUPPORT = 0.45; // every side needs at least this much evidence
const MIN_AREA_RATIO = 0.02;
const MAX_AREA_RATIO = 0.95;
// A region running past the edge of the frame only shows two or three sides, so
// the frame border itself has to be usable as the missing one.
const BORDER_TOLERANCE = 2;    // px: a side this close to the edge counts as seen
const MIN_CORNER_ANGLE = 40 * Math.PI / 180;
const MAX_CORNER_ANGLE = 140 * Math.PI / 180;

/**
 * @param {{data: Uint8ClampedArray|Array, width: number, height: number}} image
 * @param {{x: number, y: number}} [seed] - point (0-1) that must fall inside the
 *   quad. Strongly recommended: it is what separates the wanted rectangle from
 *   every other rectangular thing in the frame.
 * @param {object} [debug] - filled in with the edge map, the lines, per-reason
 *   rejection counts and the best candidate even when it was rejected, so the
 *   UI can show why a detection failed instead of just saying it did.
 * @returns {Array<{x: number, y: number}>|null} TL, TR, BR, BL normalized 0-1
 */
function detectQuadByLines(image, seed, debug) {
  const { width, height } = image;
  if (!width || !height) return null;

  const gray = _toGray(image);
  const blurred = _boxBlur(gray, width, height);
  const { magnitude, angle } = _sobel(blurred, width, height);

  const seedPoint = seed
    ? { x: seed.x * (width - 1), y: seed.y * (height - 1) }
    : null;

  const sorted = Float32Array.from(magnitude).sort();
  const cutoff = sorted[Math.floor(sorted.length * EDGE_PERCENTILE)] || 1;
  const edges = _thinEdges(magnitude, angle, width, height, cutoff);
  const lines = _houghLines(edges, width, height);

  if (debug) {
    debug.width = width;
    debug.height = height;
    debug.edges = edges;
    debug.edgeCount = edges.reduce((n, v) => n + v, 0);
    debug.lines = lines;
    debug.seedPoint = seedPoint;
    debug.rejected = { bounds: 0, convex: 0, area: 0, sliver: 0, seed: 0, support: 0 };
    debug.candidates = 0;
    debug.bestSupport = 0;
    debug.bestQuad = null;
    debug.minSupport = MIN_SIDE_SUPPORT;
  }

  // Two passes. The frame borders are only brought in when the real edges alone
  // cannot produce a quad: giving a side that lies on the border free support
  // lets junk candidates score perfectly, which measurably wrecks the ordinary
  // cases (19/20 -> 15/20 on the clutter benchmark). As a rescue for a region
  // that runs off the frame, though, it is exactly what is needed.
  let best = lines.length >= 4
    ? _bestQuad(lines, edges, width, height, seedPoint, debug)
    : null;

  if (!best) {
    const withBorders = lines.concat(_borderLines(width, height));
    if (debug) debug.usedBorders = true;
    best = _bestQuad(withBorders, edges, width, height, seedPoint, debug, true);
  }
  if (!best) return null;

  return orderCorners(best).map(p => ({
    x: Math.min(1, Math.max(0, p.x / width)),
    y: Math.min(1, Math.max(0, p.y / height)),
  }));
}

// ── Edges ───────────────────────────────────────────────────

function _toGray({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return gray;
}

function _boxBlur(gray, width, height) {
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          sum += gray[ny * width + nx];
          count++;
        }
      }
      out[y * width + x] = (sum / count) | 0;
    }
  }
  return out;
}

function _sobel(gray, width, height) {
  const magnitude = new Float32Array(gray.length);
  const angle = new Float32Array(gray.length);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = gray[i - width - 1], tc = gray[i - width], tr = gray[i - width + 1];
      const ml = gray[i - 1], mr = gray[i + 1];
      const bl = gray[i + width - 1], bc = gray[i + width], br = gray[i + width + 1];

      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      magnitude[i] = Math.hypot(gx, gy);
      angle[i] = Math.atan2(gy, gx);
    }
  }
  return { magnitude, angle };
}

// Keep only local maxima along the gradient direction, above a percentile cut
function _thinEdges(magnitude, angle, width, height, cutoff) {
  const edges = new Uint8Array(magnitude.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const m = magnitude[i];
      if (m < cutoff) continue;

      // Quantize the gradient to one of four directions and compare neighbours
      let dx = 1;
      let dy = 0;
      const a = ((angle[i] * 180 / Math.PI) + 180) % 180;
      if (a >= 22.5 && a < 67.5) { dx = 1; dy = 1; }
      else if (a >= 67.5 && a < 112.5) { dx = 0; dy = 1; }
      else if (a >= 112.5 && a < 157.5) { dx = -1; dy = 1; }

      if (m >= magnitude[i + dy * width + dx] && m >= magnitude[i - dy * width - dx]) {
        edges[i] = 1;
      }
    }
  }
  return edges;
}

// ── Hough transform ─────────────────────────────────────────

function _houghLines(edges, width, height) {
  const thetaSteps = 180;
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoOffset = diagonal;
  const rhoSize = diagonal * 2 + 1;

  const cos = new Float32Array(thetaSteps);
  const sin = new Float32Array(thetaSteps);
  for (let t = 0; t < thetaSteps; t++) {
    const theta = t * Math.PI / thetaSteps;
    cos[t] = Math.cos(theta);
    sin[t] = Math.sin(theta);
  }

  const acc = new Int32Array(thetaSteps * rhoSize);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!edges[y * width + x]) continue;
      for (let t = 0; t < thetaSteps; t++) {
        const rho = Math.round(x * cos[t] + y * sin[t]) + rhoOffset;
        acc[t * rhoSize + rho]++;
      }
    }
  }

  // Peaks, suppressing neighbours so one edge does not yield a dozen lines
  const peaks = [];
  const minVotes = Math.max(20, Math.round(Math.min(width, height) * 0.25));
  for (let t = 0; t < thetaSteps; t++) {
    for (let r = 1; r < rhoSize - 1; r++) {
      const votes = acc[t * rhoSize + r];
      if (votes < minVotes) continue;
      if (!_isLocalPeak(acc, thetaSteps, rhoSize, t, r)) continue;
      peaks.push({ theta: t * Math.PI / thetaSteps, rho: r - rhoOffset, votes });
    }
  }

  peaks.sort((a, b) => b.votes - a.votes);

  // Drop near-duplicates that survived the local peak test
  const kept = [];
  for (const line of peaks) {
    const duplicate = kept.some(k =>
      Math.abs(k.rho - line.rho) < 12 && _angleDelta(k.theta, line.theta) < 6 * Math.PI / 180);
    if (duplicate) continue;
    kept.push(line);
    if (kept.length >= MAX_LINES) break;
  }
  return kept;
}

// The four image borders, so a region that is cut off by the frame can still be
// closed into a quad. They carry no votes; the edge support test gives sides
// that lie on the border credit instead of evidence it cannot have.
function _borderLines(width, height) {
  return [
    { theta: 0, rho: 0, votes: 0, border: true },
    { theta: 0, rho: width - 1, votes: 0, border: true },
    { theta: Math.PI / 2, rho: 0, votes: 0, border: true },
    { theta: Math.PI / 2, rho: height - 1, votes: 0, border: true },
  ];
}

function _isLocalPeak(acc, thetaSteps, rhoSize, t, r) {
  const votes = acc[t * rhoSize + r];
  for (let dt = -2; dt <= 2; dt++) {
    const nt = (t + dt + thetaSteps) % thetaSteps;
    for (let dr = -8; dr <= 8; dr++) {
      const nr = r + dr;
      if (nr < 0 || nr >= rhoSize) continue;
      if (dt === 0 && dr === 0) continue;
      if (acc[nt * rhoSize + nr] > votes) return false;
    }
  }
  return true;
}

// Smallest angle between two undirected line orientations
function _angleDelta(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return d > Math.PI / 2 ? Math.PI - d : d;
}

// ── Candidate quads ─────────────────────────────────────────

function _bestQuad(lines, edges, width, height, seedPoint, debug, allowBorders) {
  // Pairs of roughly parallel lines = opposite sides
  const pairs = [];
  for (let i = 0; i < lines.length - 1; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (_angleDelta(lines[i].theta, lines[j].theta) > PARALLEL_TOLERANCE) continue;
      pairs.push([lines[i], lines[j]]);
    }
  }

  const frameArea = width * height;
  let best = null;
  let bestScore = 0;

  for (let a = 0; a < pairs.length; a++) {
    for (let b = a + 1; b < pairs.length; b++) {
      const [a1, a2] = pairs[a];
      const [b1, b2] = pairs[b];
      if (_angleDelta(a1.theta, b1.theta) < CROSS_MIN_ANGLE) continue;

      const corners = [
        _intersect(a1, b1), _intersect(a1, b2),
        _intersect(a2, b1), _intersect(a2, b2),
      ];
      if (corners.some(c => !c)) continue;

      const quad = orderCorners(corners);
      const reason = _rejectReason(quad, width, height, frameArea, seedPoint);
      if (reason) {
        if (debug) debug.rejected[reason]++;
        continue;
      }

      const score = _edgeSupport(quad, edges, width, height, allowBorders);
      if (debug) {
        debug.candidates++;
        if (score > debug.bestSupport) {
          debug.bestSupport = score;
          debug.bestQuad = quad;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = quad;
      }
    }
  }

  if (bestScore < MIN_SIDE_SUPPORT) {
    if (debug && best) debug.rejected.support++;
    return null;
  }
  return best;
}

function _intersect(l1, l2) {
  const c1 = Math.cos(l1.theta), s1 = Math.sin(l1.theta);
  const c2 = Math.cos(l2.theta), s2 = Math.sin(l2.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.rho * s2 - l2.rho * s1) / det,
    y: (l2.rho * c1 - l1.rho * c2) / det,
  };
}

// Returns the name of the first check the quad fails, or null if it passes
function _rejectReason(quad, width, height, frameArea, seedPoint) {
  const margin = Math.max(width, height) * 0.15;
  for (const c of quad) {
    if (c.x < -margin || c.y < -margin) return 'bounds';
    if (c.x > width + margin || c.y > height + margin) return 'bounds';
  }
  if (!isConvex(quad)) return 'convex';

  const area = polygonArea(quad);
  if (area < frameArea * MIN_AREA_RATIO) return 'area';
  if (area > frameArea * MAX_AREA_RATIO) return 'area';

  // Reject slivers
  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4];
    const cur = quad[i];
    const next = quad[(i + 1) % 4];
    const angle = _cornerAngle(prev, cur, next);
    if (angle < MIN_CORNER_ANGLE || angle > MAX_CORNER_ANGLE) return 'sliver';
  }

  if (seedPoint && !_pointInPolygon(seedPoint, quad)) return 'seed';
  return null;
}

function _cornerAngle(prev, cur, next) {
  const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
  const v2x = next.x - cur.x, v2y = next.y - cur.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (mag === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag)));
}

// Fraction of sampled points along each side that sit on a real edge. The
// score is the weakest side, so a quad needs evidence all the way round.
function _edgeSupport(quad, edges, width, height, allowBorders) {
  let weakest = 1;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    let hits = 0;
    let samples = 0;

    for (let s = 0; s <= SIDE_SAMPLES; s++) {
      const t = s / SIDE_SAMPLES;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      if (x < -BORDER_TOLERANCE || y < -BORDER_TOLERANCE) continue;
      if (x > width + BORDER_TOLERANCE || y > height + BORDER_TOLERANCE) continue;
      samples++;

      // On the frame border there is nothing to see beyond, so the cut counts
      // as the boundary rather than as missing evidence - but only in the
      // rescue pass, where no fully evidenced quad exists anyway.
      if (allowBorders &&
          (x <= BORDER_TOLERANCE || y <= BORDER_TOLERANCE ||
           x >= width - 1 - BORDER_TOLERANCE || y >= height - 1 - BORDER_TOLERANCE)) {
        hits++;
        continue;
      }
      if (_edgeNear(edges, width, height, x, y)) hits++;
    }

    if (samples < SIDE_SAMPLES * 0.5) return 0; // side mostly outside the frame
    weakest = Math.min(weakest, hits / samples);
  }
  return weakest;
}

function _edgeNear(edges, width, height, x, y) {
  for (let dy = -SUPPORT_RADIUS; dy <= SUPPORT_RADIUS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -SUPPORT_RADIUS; dx <= SUPPORT_RADIUS; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      if (edges[ny * width + nx]) return true;
    }
  }
  return false;
}

function _pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

module.exports = { detectQuadByLines };
