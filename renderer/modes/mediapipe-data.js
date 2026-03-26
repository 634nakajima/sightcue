// MediaPipe landmark maps and smoothing - ported from mediapipe-osc TypeScript

// Maps MediaPipe hand landmark indices to human-readable OSC address segments
const HAND_LANDMARK_NAMES = {
  0: 'wrist',
  1: 'thumb/cmc',
  2: 'thumb/mcp',
  3: 'thumb/ip',
  4: 'thumb/tip',
  5: 'index/mcp',
  6: 'index/pip',
  7: 'index/dip',
  8: 'index/tip',
  9: 'middle/mcp',
  10: 'middle/pip',
  11: 'middle/dip',
  12: 'middle/tip',
  13: 'ring/mcp',
  14: 'ring/pip',
  15: 'ring/dip',
  16: 'ring/tip',
  17: 'pinky/mcp',
  18: 'pinky/pip',
  19: 'pinky/dip',
  20: 'pinky/tip',
};

// Hand landmark connections for drawing lines
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // index
  [0, 9], [9, 10], [10, 11], [11, 12],  // middle
  [0, 13], [13, 14], [14, 15], [15, 16],// ring
  [0, 17], [17, 18], [18, 19], [19, 20],// pinky
  [5, 9], [9, 13], [13, 17],            // palm
];

// Selected face landmark indices (subset of 468 mesh points)
const FACE_LANDMARKS = {
  'left_eye/inner': 133,
  'left_eye/outer': 33,
  'left_eye/upper': 159,
  'left_eye/lower': 145,
  'right_eye/inner': 362,
  'right_eye/outer': 263,
  'right_eye/upper': 386,
  'right_eye/lower': 374,
  'left_eyebrow/inner': 107,
  'left_eyebrow/middle': 105,
  'left_eyebrow/outer': 70,
  'right_eyebrow/inner': 336,
  'right_eyebrow/middle': 334,
  'right_eyebrow/outer': 300,
  'nose/tip': 1,
  'nose/bridge': 6,
  'nose/left': 129,
  'nose/right': 358,
  'mouth/upper': 13,
  'mouth/lower': 14,
  'mouth/left': 78,
  'mouth/right': 308,
  'mouth/upper_inner': 12,
  'mouth/lower_inner': 15,
  'jaw/left': 172,
  'jaw/right': 397,
  'jaw/chin': 152,
  'forehead/center': 10,
  'cheek/left': 234,
  'cheek/right': 454,
};

// Face connections for drawing lines
const FACE_CONNECTIONS = [
  // Left eye
  ['left_eye/inner', 'left_eye/upper'],
  ['left_eye/upper', 'left_eye/outer'],
  ['left_eye/outer', 'left_eye/lower'],
  ['left_eye/lower', 'left_eye/inner'],
  // Right eye
  ['right_eye/inner', 'right_eye/upper'],
  ['right_eye/upper', 'right_eye/outer'],
  ['right_eye/outer', 'right_eye/lower'],
  ['right_eye/lower', 'right_eye/inner'],
  // Mouth
  ['mouth/left', 'mouth/upper'],
  ['mouth/upper', 'mouth/right'],
  ['mouth/right', 'mouth/lower'],
  ['mouth/lower', 'mouth/left'],
  // Nose
  ['nose/bridge', 'nose/tip'],
  ['nose/left', 'nose/tip'],
  ['nose/right', 'nose/tip'],
  // Left eyebrow
  ['left_eyebrow/inner', 'left_eyebrow/middle'],
  ['left_eyebrow/middle', 'left_eyebrow/outer'],
  // Right eyebrow
  ['right_eyebrow/inner', 'right_eyebrow/middle'],
  ['right_eyebrow/middle', 'right_eyebrow/outer'],
  // Jaw
  ['jaw/left', 'jaw/chin'],
  ['jaw/chin', 'jaw/right'],
];

// Gesture names recognized by MediaPipe GestureRecognizer
const GESTURE_NAMES = [
  'None',
  'Closed_Fist',
  'Open_Palm',
  'Pointing_Up',
  'Thumb_Down',
  'Thumb_Up',
  'Victory',
  'ILoveYou',
];

// Exponential smoother - ported from smoothing.ts
class ExponentialSmoother {
  constructor(factor = 0.5) {
    this._prev = new Map();
    this._factor = factor;
  }

  smooth(key, value) {
    const prev = this._prev.get(key);
    if (prev === undefined) {
      this._prev.set(key, value);
      return value;
    }
    const smoothed = prev * this._factor + value * (1 - this._factor);
    this._prev.set(key, smoothed);
    return smoothed;
  }

  setFactor(f) {
    this._factor = Math.max(0, Math.min(0.95, f));
  }

  getFactor() {
    return this._factor;
  }

  reset() {
    this._prev.clear();
  }
}

module.exports = {
  HAND_LANDMARK_NAMES,
  HAND_CONNECTIONS,
  FACE_LANDMARKS,
  FACE_CONNECTIONS,
  GESTURE_NAMES,
  ExponentialSmoother,
};
