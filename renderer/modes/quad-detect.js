// Find the quadrilateral to use as the region, for auto-setting its corners.
//
// Two strategies, tried in order:
//   1. Line based (quad-detect-lines) - Sobel edges, Hough lines, four sides
//      scored by edge evidence. Holds up when the background is busy.
//   2. Region based (below) - Otsu threshold, largest connected component,
//      convex hull, polygon approximation. Exact on a clean background, but it
//      fails once the target merges with same-brightness clutter, so it is only
//      the fallback.
//
// Works on a plain {data, width, height} (an ImageData), so it can be unit
// tested outside the browser.

const { detectQuadByLines } = require('./quad-detect-lines');
const {
  convexHull, orderCorners, medianQuad,
  approxQuad: _approxQuad, polygonArea: _polygonArea, isConvex: _isConvex,
} = require('./quad-geometry');

// A quad must cover at least this fraction of the frame to be believable, and
// at most this much (a near-full-frame blob is usually the background itself).
// With a seed the user has pointed at the region, so a smaller one is fine.
const MIN_AREA_RATIO = 0.03;
const MIN_AREA_RATIO_SEEDED = 0.01;
const MAX_AREA_RATIO = 0.98;

/**
 * @param {{data: Uint8ClampedArray|Array, width: number, height: number}} image
 * @param {{x: number, y: number}} [seed] - a point (0-1) inside the wanted
 *   region. Without it the largest region in the frame is used, which is only
 *   reliable on an uncluttered background.
 * @returns {Array<{x: number, y: number}>|null} four corners in TL, TR, BR, BL
 *   order, normalized to 0-1, or null when no convincing quad was found.
 */
function detectQuad(image, seed, debug) {
  const byLines = detectQuadByLines(image, seed, debug);
  if (byLines) {
    if (debug) debug.method = 'lines';
    return byLines;
  }

  const byRegion = detectQuadByRegion(image, seed);
  if (debug) debug.method = byRegion ? 'region' : 'none';
  return byRegion;
}

function detectQuadByRegion(image, seed) {
  const { width, height } = image;
  if (!width || !height) return null;

  const gray = _toGray(image);
  const threshold = _otsu(gray);

  // Try both polarities: a bright region on a dark ground and vice versa.
  let best = null;
  for (const bright of [true, false]) {
    const mask = _binarize(gray, threshold, bright);
    const quad = seed
      ? _quadFromSeed(mask, width, height, seed)
      : _quadFromMask(mask, width, height);
    if (!quad) continue;

    const area = _polygonArea(quad);
    // Without a seed the larger candidate wins. With one, both polarities
    // describe the same clicked spot and the tighter fit is the better read -
    // the other polarity tends to swallow the surrounding background.
    const better = seed ? (!best || area < best.area) : (!best || area > best.area);
    if (better) best = { quad, area };
  }
  if (!best) return null;

  const ordered = orderCorners(best.quad);
  return ordered.map(p => ({
    x: Math.min(1, Math.max(0, p.x / width)),
    y: Math.min(1, Math.max(0, p.y / height)),
  }));
}

function _quadFromMask(mask, width, height) {
  const component = _largestComponent(mask, width, height);
  if (!component) return null;
  return _quadFromPoints(component.points, width, height, MIN_AREA_RATIO);
}

// Only the region the user pointed at, so a cluttered background cannot
// outvote it by simply being bigger.
function _quadFromSeed(mask, width, height, seed) {
  const sx = Math.round(seed.x * (width - 1));
  const sy = Math.round(seed.y * (height - 1));
  if (!(sx >= 0 && sy >= 0 && sx < width && sy < height)) return null;

  const start = sy * width + sx;
  if (!mask[start]) return null; // the seed belongs to the other polarity

  const points = _floodFill(mask, width, height, start, new Uint8Array(mask.length));
  return _quadFromPoints(points, width, height, MIN_AREA_RATIO_SEEDED);
}

function _quadFromPoints(points, width, height, minAreaRatio) {
  const frameArea = width * height;
  if (points.length < frameArea * minAreaRatio) return null;
  if (points.length > frameArea * MAX_AREA_RATIO) return null;

  const hull = convexHull(points);
  if (hull.length < 4) return null;

  const quad = _approxQuad(hull);
  if (!quad) return null;

  const area = _polygonArea(quad);
  if (area < frameArea * minAreaRatio) return null;
  if (area > frameArea * MAX_AREA_RATIO) return null;
  if (!_isConvex(quad)) return null;

  return quad;
}

// ── Preprocessing ───────────────────────────────────────────

function _toGray({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return gray;
}

// Otsu's method: the threshold maximizing between-class variance
function _otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let weightB = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;

    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

function _binarize(gray, threshold, bright) {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const on = bright ? gray[i] > threshold : gray[i] <= threshold;
    mask[i] = on ? 1 : 0;
  }
  return mask;
}

// ── Largest connected component (4-connectivity, iterative flood fill) ──

function _largestComponent(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  let best = null;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const points = _floodFill(mask, width, height, start, visited);
    if (!best || points.length > best.points.length) best = { points };
  }

  return best;
}

function _floodFill(mask, width, height, start, visited) {
  const stack = [start];
  visited[start] = 1;
  const points = [];

  while (stack.length > 0) {
    const idx = stack.pop();
    const x = idx % width;
    const y = (idx / width) | 0;
    points.push({ x, y });

    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }

  return points;

  function push(next) {
    if (mask[next] && !visited[next]) {
      visited[next] = 1;
      stack.push(next);
    }
  }
}

module.exports = { detectQuad, detectQuadByRegion, medianQuad, orderCorners, convexHull };
