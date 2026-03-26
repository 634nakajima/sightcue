// MediaPipe drawing utilities - ported from CameraPreview.tsx
const { HAND_CONNECTIONS, FACE_CONNECTIONS } = require('./mediapipe-data');

/**
 * Draw hand skeletons, face landmarks, gesture labels, and FPS on the canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} result - { hands: { left, right }, face: [] }
 * @param {number} w - canvas width
 * @param {number} h - canvas height
 * @param {number} [fps] - optional fps counter
 */
function drawLandmarks(ctx, result, w, h, fps) {
  ctx.clearRect(0, 0, w, h);

  // Draw hands
  const sides = ['left', 'right'];
  for (const side of sides) {
    const hand = result.hands[side];
    if (!hand) continue;
    const landmarks = hand.landmarks;

    // Draw connections
    ctx.strokeStyle = side === 'left' ? '#22c55e' : '#3b82f6';
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      if (a < landmarks.length && b < landmarks.length) {
        ctx.beginPath();
        ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
        ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
        ctx.stroke();
      }
    }

    // Draw landmark points
    ctx.fillStyle = side === 'left' ? '#4ade80' : '#60a5fa';
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw gesture label near wrist
    if (hand.gesture && hand.gesture !== 'None' && landmarks.length > 0) {
      const wrist = landmarks[0];
      const labelX = wrist.x * w;
      const labelY = wrist.y * h + 24;
      const label = hand.gesture;
      ctx.save();
      ctx.font = 'bold 16px sans-serif';
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(labelX - textW / 2 - 4, labelY - 14, textW + 8, 20);
      ctx.fillStyle = side === 'left' ? '#4ade80' : '#60a5fa';
      ctx.textAlign = 'center';
      ctx.fillText(label, labelX, labelY);
      ctx.restore();
    }
  }

  // Draw face landmarks
  if (result.face && result.face.length > 0) {
    const faceMap = new Map(result.face.map(lm => [lm.name, lm]));

    // Draw face connections
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.5;
    for (const [a, b] of FACE_CONNECTIONS) {
      const la = faceMap.get(a);
      const lb = faceMap.get(b);
      if (la && lb) {
        ctx.beginPath();
        ctx.moveTo(la.x * w, la.y * h);
        ctx.lineTo(lb.x * w, lb.y * h);
        ctx.stroke();
      }
    }

    // Draw face points
    ctx.fillStyle = '#22d3ee';
    for (const lm of result.face) {
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw FPS
  if (fps !== undefined) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(w - 70, 4, 62, 24);
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${fps} fps`, w - 39, 20);
    ctx.restore();
  }
}

module.exports = { drawLandmarks };
