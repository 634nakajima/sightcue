# SightCue

カメラ映像をAIがリアルタイムに解析し、映像内のイベントをOSCで外部アプリケーションに通知するmacOSデスクトップアプリ。Pure Data、TouchDesigner、Max、Ableton等と連携して、インタラクティブな作品やライブパフォーマンスを実現します。

## AI Engines

用途に応じて3つの画像認識AIを切り替えて使えます。

| Engine | 概要 | Python |
|--------|------|--------|
| **BLIP Caption** | 映像をテキスト化し、登録した状況との類似度でトリガー発火 | 必要 |
| **MediaPipe Tracking** | 手（21点 + ジェスチャー）・顔（32点）のランドマーク検出 | 不要 |
| **Teachable Machine** | 自作モデルでROI領域ごとに画像分類 | 不要 |

## Quick Start

```bash
git clone https://github.com/634nakajima/sightcue.git
cd sightcue
npm install

# BLIP Captionを使う場合のみ
cd python && pip install -r requirements.txt && cd ..

npm start
```

MediaPipe / Teachable Machine はPython環境なしで動作します。

## Features

- **ROI（関心領域）** - カメラ映像上に複数の領域を描画し、領域ごとに独立して処理
- **OSC出力** - 全エンジンからOSCでリアルタイム通知
- **リアルタイムモニター** - OSCメッセージ、類似度、キャプションをダッシュボード表示
- **カメラ制御** - オン/オフ切替、複数カメラ対応
- **Apple Silicon最適化** - BLIPはPyTorch MPS、MediaPipe/TMはWASMで高速推論

## OSC Address Format

### BLIP Caption
```
/vision/caption              [string]    キャプションテキスト
/vision/trigger{N}           [float]     トリガー類似度 (0-1)
/vision/roi/{name}/caption   [string]    ROIごとのキャプション
/vision/roi/{name}/trigger{N} [float]    ROIごとのトリガー類似度
```

### MediaPipe Tracking
```
/hand/{side}/{landmark}/x    [float 0-1]  手のランドマーク
/hand/{side}/{landmark}/y    [float 0-1]
/hand/{side}/gesture/index   [float 0-7]  ジェスチャー種別
/face/{landmark}/x           [float 0-1]  顔のランドマーク
/face/{landmark}/y           [float 0-1]
```

### Teachable Machine
```
/tm/{name}/class             [string]    推論クラス名
/tm/{name}/confidence        [float]     確信度
/tm/{name}/prob/{i}          [string, float]  クラス別確率
```

## Tech Stack

Electron, Python, PyTorch MPS, BLIP, Sentence-Transformers, MediaPipe, TensorFlow.js, Flask-SocketIO, OSC

## License

MIT
