# SightCue

カメラ映像をAIがリアルタイムに解析し、映像内のイベントをOSCで外部アプリケーションに通知するmacOSデスクトップアプリ。Pure Data、TouchDesigner、Max、Ableton等と連携して、インタラクティブな作品やライブパフォーマンスを実現します。

## AI Engines

用途に応じて3つの画像認識AIを切り替えて使えます。

| Engine | 概要 | Python |
|--------|------|--------|
| **BLIP Caption** | 映像をテキスト化し、登録した状況との類似度でトリガー発火 | 必要 |
| **MediaPipe Tracking** | 手（21点 + ジェスチャー）・顔（30点）のランドマーク検出 | 不要 |
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

## ダウンロード版の初回起動（macOS）

配布している .dmg から起動すると、**「"SightCue"は壊れているため開けません。ゴミ箱に入れる必要があります。」** と表示されることがあります。アプリが壊れているわけではありません。

SightCueは Apple Developer Program の公証（notarization）を受けていないため、ダウンロードしたファイルに macOS が付ける隔離属性（quarantine）を Gatekeeper が検証できず、この表示になります。アプリを `/Applications` にコピーしたあと、ターミナルで次のコマンドを一度だけ実行してください。

```bash
xattr -dr com.apple.quarantine /Applications/SightCue.app
```

以降は通常どおり起動できます。macOS Sequoia 以降は「右クリック→開く」による回避ができないため、この方法をお使いください。USBメモリやファイル共有で直接受け取った場合は隔離属性が付かないので、この操作は不要です。

## Features

- **ROI（関心領域）** - カメラ映像上に複数の領域を描画し、領域ごとに独立して処理
- **OSC出力** - 全エンジンからOSCでリアルタイム通知
- **リアルタイムモニター** - OSCメッセージ、類似度、キャプションをダッシュボード表示
- **送信特徴点の選択** - MediaPipeで送る手・顔のランドマークと軸(x/y/z)を個別に選択（設定は保存）
- **領域マッピング** - 4点コーナーで囲んだ領域内の座標を0-1に正規化して送信（斜め設置のカメラにも対応）
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
/hand/{side}/detected        [float 0/1]  手の検出状態
/hand/{side}/{landmark}/x    [float 0-1]  手のランドマーク
/hand/{side}/{landmark}/y    [float 0-1]
/hand/{side}/{landmark}/z    [float]      奥行き（相対値）
/hand/{side}/gesture/index   [float 0-7]  ジェスチャー種別
/hand/{side}/gesture/score   [float 0-1]  ジェスチャー確信度
/face/detected               [float 0/1]  顔の検出状態
/face/{landmark}/x           [float 0-1]  顔のランドマーク
/face/{landmark}/y           [float 0-1]
/face/{landmark}/z           [float]
```

`{side}` は `left` / `right`。`{landmark}` は `index/tip`、`nose/tip` のような名前です。
送信する特徴点と軸はUIで選択でき、チェックを外したアドレスは送信されません。

**領域マッピング（Region）を有効にした場合**

プレビュー上の4点コーナー（TL/TR/BR/BL）で囲んだ領域が基準になり、`x` / `y` はその領域内での0-1に変換されます。領域外にある特徴点は送信されません。ただし `detected` は検出状態そのものを表すため、領域外で検出されている場合も 1 のままです。

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
