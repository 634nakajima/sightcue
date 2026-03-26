# SightCue

3つのAIビジョンモードを1つに統合したデスクトップアプリ。OSC/Socket.IOで外部アプリにリアルタイム通知。

## Modes

| Mode | Engine | Python | Description |
|------|--------|--------|-------------|
| **BLIP Caption** | PyTorch MPS | Required | AI image captioning + text similarity triggers |
| **MediaPipe Tracking** | WASM (browser) | Not needed | Hand/face landmark detection + gesture recognition |
| **Teachable Machine** | TensorFlow.js (browser) | Not needed | Custom model inference on ROI regions |

## Quick Start

```bash
git clone https://github.com/634nakajima/sightcue.git
cd sightcue
npm install

# BLIP mode requires Python
cd python && pip install -r requirements.txt && cd ..

npm start
```

MediaPipe / Teachable Machine modes work without Python.

## Features

- **Mode switching** - Switch between 3 AI vision modes with tab buttons
- **ROI (Region of Interest)** - Draw multiple regions on camera for independent processing
- **OSC output** - All modes send data via OSC to Pure Data, TouchDesigner, Max, Ableton, etc.
- **Real-time monitor** - OSC monitor, similarity bars, caption log
- **Apple Silicon optimized** - BLIP uses MPS, MediaPipe/TM use WebGPU/WASM

## OSC Address Format

### BLIP Mode
```
/vision/caption          [string]     Caption text
/vision/trigger{N}       [float]      Trigger similarity (0-1)
/vision/roi/{name}/caption    [string]
/vision/roi/{name}/trigger{N} [float]
```

### MediaPipe Mode
```
/hand/{side}/{landmark}/x    [float 0-1]
/hand/{side}/{landmark}/y    [float 0-1]
/hand/{side}/{landmark}/z    [float]
/hand/{side}/gesture/index   [float 0-7]
/face/{landmark}/x           [float 0-1]
/face/{landmark}/y           [float 0-1]
```

### Teachable Machine Mode
```
/tm/roi/{name}/class         [string]    Top class name
/tm/roi/{name}/confidence    [float]     Top class probability
/tm/roi/{name}/prob/{i}      [string, float]  Per-class
```

## Tech Stack

Electron, Python, PyTorch MPS, BLIP, Sentence-Transformers, MediaPipe, TensorFlow.js, Flask-SocketIO, OSC

## License

MIT
