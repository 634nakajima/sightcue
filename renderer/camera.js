// Camera management using getUserMedia

let videoElement = null;
let currentStream = null;

async function enumerateCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}

async function startCamera(deviceId, video) {
  videoElement = video;

  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
  }

  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: 640, height: 480 }
      : { width: 640, height: 480 },
    audio: false,
  };

  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = currentStream;
  await video.play();
  return { width: video.videoWidth, height: video.videoHeight };
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (videoElement) {
    videoElement.srcObject = null;
  }
}

// Capture full frame as base64 JPEG
function captureFrame(video, quality = 0.8) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1]; // base64 only
}

module.exports = { enumerateCameras, startCamera, stopCamera, captureFrame };
