// MediaPipe Tracking mode - ported from useMediaPipe.ts
// Uses @mediapipe/tasks-vision for hand gesture recognition and face landmark detection
// Sends landmarks via IPC to main process for OSC output

const { ipcRenderer } = require('electron');
const path = require('path');
const { HAND_LANDMARK_NAMES, FACE_LANDMARKS, GESTURE_NAMES, ExponentialSmoother } = require('./mediapipe-data');
const { drawLandmarks } = require('./mediapipe-draw');

let gestureRecognizer = null;
let faceLandmarker = null;
let smoother = new ExponentialSmoother(0.5);
let animFrameId = 0;
let lastSendTime = 0;
let running = false;
let ready = false;
let fps = 0;
let fpsFrameCount = 0;
let fpsLastTime = 0;

// Options
let handEnabled = true;
let faceEnabled = true;

// DOM references
let els = {};
let overlayCtx = null;

// Latest tracking result for data monitor
let latestResult = { hands: { left: null, right: null }, face: [] };

function initMediaPipe(elements) {
  els = elements;

  // Smoothing slider
  if (els.smoothingSlider) {
    els.smoothingSlider.addEventListener('input', () => {
      const val = parseFloat(els.smoothingSlider.value);
      smoother.setFactor(val);
      if (els.smoothingValue) els.smoothingValue.textContent = val.toFixed(2);
    });
  }

  // Hand/face toggles
  if (els.handCheckbox) {
    els.handCheckbox.addEventListener('change', () => {
      handEnabled = els.handCheckbox.checked;
    });
  }
  if (els.faceCheckbox) {
    els.faceCheckbox.addEventListener('change', () => {
      faceEnabled = els.faceCheckbox.checked;
    });
  }
}

async function startMediaPipe() {
  if (running) return;
  running = true;

  // Get overlay canvas context (shared with ROI)
  const overlay = els.overlay || document.getElementById('roi-overlay');
  if (overlay) {
    overlayCtx = overlay.getContext('2d');
  }

  if (els.readyStatus) {
    els.readyStatus.textContent = 'Initializing models...';
    els.readyStatus.style.display = 'inline';
  }

  // Initialize models if not already done
  if (!ready) {
    try {
      await _initModels();
      ready = true;
      if (els.readyStatus) {
        els.readyStatus.textContent = 'Ready';
        setTimeout(() => {
          if (els.readyStatus) els.readyStatus.style.display = 'none';
        }, 2000);
      }
    } catch (err) {
      console.error('[MediaPipe] Init error:', err);
      if (els.readyStatus) {
        els.readyStatus.textContent = 'Error: ' + err.message;
      }
      running = false;
      return;
    }
  } else {
    if (els.readyStatus) els.readyStatus.style.display = 'none';
  }

  // Start detection loop
  fpsLastTime = performance.now();
  fpsFrameCount = 0;
  animFrameId = requestAnimationFrame(_detect);
}

function stopMediaPipe() {
  running = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = 0;
  }

  // Clear the overlay canvas
  if (overlayCtx) {
    const canvas = overlayCtx.canvas;
    overlayCtx.clearRect(0, 0, canvas.width, canvas.height);
    overlayCtx = null;
  }
}

async function _initModels() {
  // Use local wasm files from node_modules
  const wasmPath = path.join(__dirname, '..', '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const wasmFilesetUrl = 'file://' + wasmPath;

  // Dynamic import of the MediaPipe module
  const vision = await _loadVision(wasmFilesetUrl);

  gestureRecognizer = await vision.GestureRecognizer.createFromOptions(
    vision.fileset,
    {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
        delegate: 'GPU',
      },
      numHands: 2,
      runningMode: 'VIDEO',
    }
  );

  faceLandmarker = await vision.FaceLandmarker.createFromOptions(
    vision.fileset,
    {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
        delegate: 'GPU',
      },
      numFaces: 1,
      runningMode: 'VIDEO',
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }
  );
}

async function _loadVision(wasmPath) {
  // Load the @mediapipe/tasks-vision package
  const tasksVision = require('@mediapipe/tasks-vision');
  const { FilesetResolver, GestureRecognizer, FaceLandmarker } = tasksVision;

  const fileset = await FilesetResolver.forVisionTasks(wasmPath);

  return {
    fileset,
    GestureRecognizer,
    FaceLandmarker,
  };
}

function _detect() {
  if (!running) return;

  const video = els.video;
  if (!video || video.readyState < 2 || !ready) {
    animFrameId = requestAnimationFrame(_detect);
    return;
  }

  const now = performance.now();
  const trackingResult = { hands: { left: null, right: null }, face: [] };

  // Hand + Gesture detection
  if (handEnabled && gestureRecognizer) {
    try {
      const gestureResult = gestureRecognizer.recognizeForVideo(video, now);
      if (gestureResult.landmarks) {
        for (let i = 0; i < gestureResult.landmarks.length; i++) {
          const landmarks = gestureResult.landmarks[i];
          const handedness =
            gestureResult.handednesses[i]?.[0]?.categoryName?.toLowerCase() === 'left'
              ? 'left' : 'right';

          const gestureCategory = gestureResult.gestures[i]?.[0];
          const gestureName = gestureCategory?.categoryName || 'None';
          const gestureIndex = GESTURE_NAMES.indexOf(gestureName);
          const gestureScore = gestureCategory?.score || 0;

          const tracked = landmarks.map((lm, idx) => {
            const name = HAND_LANDMARK_NAMES[idx] || `landmark_${idx}`;
            const prefix = `hand_${handedness}_${name}`;
            return {
              name,
              x: smoother.smooth(`${prefix}_x`, lm.x),
              y: smoother.smooth(`${prefix}_y`, lm.y),
              z: smoother.smooth(`${prefix}_z`, lm.z),
            };
          });

          const handResult = {
            landmarks: tracked,
            gesture: gestureName,
            gestureIndex: gestureIndex >= 0 ? gestureIndex : 0,
            gestureScore,
          };

          if (handedness === 'left') {
            trackingResult.hands.left = handResult;
          } else {
            trackingResult.hands.right = handResult;
          }
        }
      }
    } catch (err) {
      // Ignore timing errors from recognizeForVideo
    }
  }

  // Face detection
  if (faceEnabled && faceLandmarker) {
    try {
      const faceResult = faceLandmarker.detectForVideo(video, now);
      if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
        const allFaceLandmarks = faceResult.faceLandmarks[0];
        const tracked = [];

        for (const [name, idx] of Object.entries(FACE_LANDMARKS)) {
          if (idx < allFaceLandmarks.length) {
            const lm = allFaceLandmarks[idx];
            const prefix = `face_${name}`;
            tracked.push({
              name,
              x: smoother.smooth(`${prefix}_x`, lm.x),
              y: smoother.smooth(`${prefix}_y`, lm.y),
              z: smoother.smooth(`${prefix}_z`, lm.z),
            });
          }
        }

        trackingResult.face = tracked;
      }
    } catch (err) {
      // Ignore timing errors from detectForVideo
    }
  }

  latestResult = trackingResult;

  // Draw on shared overlay canvas
  if (overlayCtx) {
    const canvas = overlayCtx.canvas;
    // Resize canvas to match container if needed
    const container = canvas.parentElement;
    if (container) {
      const rect = container.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    }
    drawLandmarks(overlayCtx, trackingResult, canvas.width, canvas.height, fps);
  }

  // Send via IPC at ~30fps
  if (now - lastSendTime >= 33) {
    lastSendTime = now;

    const payload = {};
    if (trackingResult.hands.left) {
      if (!payload.hands) payload.hands = {};
      payload.hands.left = {
        landmarks: trackingResult.hands.left.landmarks,
        gesture: trackingResult.hands.left.gesture,
        gestureIndex: trackingResult.hands.left.gestureIndex,
        gestureScore: trackingResult.hands.left.gestureScore,
      };
    }
    if (trackingResult.hands.right) {
      if (!payload.hands) payload.hands = {};
      payload.hands.right = {
        landmarks: trackingResult.hands.right.landmarks,
        gesture: trackingResult.hands.right.gesture,
        gestureIndex: trackingResult.hands.right.gestureIndex,
        gestureScore: trackingResult.hands.right.gestureScore,
      };
    }
    if (trackingResult.face.length > 0) {
      payload.face = trackingResult.face;
    }

    ipcRenderer.send('osc:sendLandmarks', payload);

    // Update FPS counter
    fpsFrameCount++;
    const elapsed = now - fpsLastTime;
    if (elapsed >= 1000) {
      fps = Math.round(fpsFrameCount * 1000 / elapsed);
      fpsFrameCount = 0;
      fpsLastTime = now;
    }
  }

  // Update data monitor (throttled to ~10fps to reduce DOM thrashing)
  if (now % 100 < 20) {
    _updateDataMonitor(trackingResult);
  }

  animFrameId = requestAnimationFrame(_detect);
}

function _updateDataMonitor(result) {
  if (!els.dataMonitor) return;
  const monitor = els.dataMonitor;

  let html = '';

  // Hands
  for (const side of ['left', 'right']) {
    const hand = result.hands[side];
    if (hand) {
      html += `<div class="dm-section"><span class="dm-header">${side} hand</span>`;
      if (hand.gesture && hand.gesture !== 'None') {
        html += `<div class="dm-row"><span class="dm-key">gesture</span><span class="dm-val">${hand.gesture} (${hand.gestureScore.toFixed(2)})</span></div>`;
      }
      // Show wrist and fingertip positions only (to keep it compact)
      const keyLandmarks = [0, 4, 8, 12, 16, 20];
      for (const idx of keyLandmarks) {
        if (idx < hand.landmarks.length) {
          const lm = hand.landmarks[idx];
          html += `<div class="dm-row"><span class="dm-key">${lm.name}</span><span class="dm-val">${lm.x.toFixed(3)} ${lm.y.toFixed(3)} ${lm.z.toFixed(3)}</span></div>`;
        }
      }
      html += '</div>';
    }
  }

  // Face
  if (result.face.length > 0) {
    html += '<div class="dm-section"><span class="dm-header">face</span>';
    // Show a subset of key face landmarks
    const keyFace = ['nose/tip', 'left_eye/inner', 'right_eye/inner', 'mouth/upper', 'mouth/lower'];
    for (const name of keyFace) {
      const lm = result.face.find(f => f.name === name);
      if (lm) {
        html += `<div class="dm-row"><span class="dm-key">${lm.name}</span><span class="dm-val">${lm.x.toFixed(3)} ${lm.y.toFixed(3)} ${lm.z.toFixed(3)}</span></div>`;
      }
    }
    html += '</div>';
  }

  if (!html) {
    html = '<div class="dm-empty">No tracking data</div>';
  }

  monitor.innerHTML = html;
}

module.exports = {
  initMediaPipe,
  startMediaPipe,
  stopMediaPipe,
};
