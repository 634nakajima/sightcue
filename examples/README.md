# SightCue Examples

SightCue の画像認識機能を活用したインタラクティブ作品のサンプル集です。
p5.js（ビジュアル）と Pure Data / plugdata（サウンド）の実装例を含みます。

## 必要なもの

- **SightCue** - 画像認識＆OSC送信アプリ
- **Interplay** - p5.js + plugdata 統合開発環境（p5.jsサンプル使用時）
- **plugdata** - Pure Data ベースのビジュアルプログラミング環境（Pdサンプル使用時）

## OSC通信の設定

### p5.js サンプルを使う場合

```
SightCue (port 7400) → Interplay OSCブリッジ → WebSocket → p5.js
```

1. SightCue の OSC ポートを **7400** に変更
2. Interplay を起動（OSCブリッジが自動起動）
3. p5.js スケッチを Interplay で開く

### Pd サンプルを使う場合

```
SightCue (port 8000) → plugdata (else/osc.receive 8000)
```

1. SightCue の OSC ポートは **8000**（デフォルト）のまま
2. plugdata で Pd パッチを開く

---

## p5.js サンプル

### 1. Hand Paint（手でお絵描き）

**ファイル:** `p5js/mediapipe-hand-paint.js`
**SightCue モード:** MediaPipe Tracking

手のランドマーク座標で画面にパーティクルを描画します。
ジェスチャー（グー、パー、ピースなど）でブラシの色とサイズが変わります。

| OSC アドレス | 値 | 説明 |
|---|---|---|
| `/hand/left/detected` | 0 or 1 | 左手の検出状態 |
| `/hand/left/index/tip/x` | 0-1 | 人差し指先端の X 座標 |
| `/hand/left/index/tip/y` | 0-1 | 人差し指先端の Y 座標 |
| `/hand/left/gesture/index` | 0-7 | ジェスチャー種類 |
| `/hand/right/...` | 同上 | 右手（同じ構造） |

### 2. Word Rain（言葉の雨）

**ファイル:** `p5js/blip-word-rain.js`
**SightCue モード:** BLIP Caption

カメラ映像から生成された英語キャプションを単語に分解し、
画面上から雨のように降らせます。トリガーの類似度で背景色が変化します。

| OSC アドレス | 値 | 説明 |
|---|---|---|
| `/blip/caption` | string | キャプションテキスト |
| `/blip/trigger1` | 0-1 | トリガー1 の類似度 |
| `/blip/trigger2` | 0-1 | トリガー2 の類似度 |

SightCue でトリガーを1〜4個設定してください。

### 3. Class Reactor（分類リアクター）

**ファイル:** `p5js/tm-class-reactor.js`
**SightCue モード:** Teachable Machine

Teachable Machine で分類されたクラスに応じて異なるビジュアルエフェクトを表示します。
確信度に応じてエフェクトの強度が変化します。

| OSC アドレス | 値 | 説明 |
|---|---|---|
| `/tm/{ROI名}/class` | string | 分類クラス名 |
| `/tm/{ROI名}/confidence` | 0-1 | 確信度 |

**カスタマイズ:**
- スケッチ冒頭の `ROI_NAME` を SightCue で設定した ROI 名に変更
- `CLASS_EFFECTS` を自分の Teachable Machine モデルのクラス名に合わせて変更

---

## Pd サンプル

### 4. Face Synth（顔で音を鳴らす）

**ファイル:** `pd/mediapipe-face-synth.pd`
**SightCue モード:** MediaPipe Tracking（顔検出ON）

顔のランドマークで音合成パラメータを制御します。

| 顔の動き | 制御対象 | OSC アドレス |
|---|---|---|
| 口の開閉 | フィルター周波数 | `/face/mouth/lower/y` |
| 頭の左右移動 | ピッチ | `/face/nose/tip/x` |
| 眉の上げ下げ | 音量 | `/face/left_eyebrow/middle/y` |

**調整ポイント:**
- `cyclone/scale` の入力範囲（第1・第2引数）は個人や撮影環境で異なります
- 値が反応しない場合は SightCue の OSC モニターで実際の値を確認し、範囲を調整してください

### 5. Trigger Bells（トリガーベル）

**ファイル:** `pd/blip-trigger-bells.pd`
**SightCue モード:** BLIP Caption

SightCue のトリガーが発火するとベル音が鳴ります。
4つのトリガーにそれぞれ異なる音程（C5, E5, G5, C6 = C メジャーコード）が割り当てられています。

| OSC アドレス | 音程 |
|---|---|
| `/blip/trigger1` | C5 (523 Hz) |
| `/blip/trigger2` | E5 (659 Hz) |
| `/blip/trigger3` | G5 (784 Hz) |
| `/blip/trigger4` | C6 (1047 Hz) |

SightCue でトリガーを設定してください（例: "person smiling", "empty room" など）。

### 6. Class Drum（分類ドラム）

**ファイル:** `pd/tm-class-drum.pd`
**SightCue モード:** Teachable Machine

分類クラスが変わるとドラムサウンドが鳴ります。確信度で音量が変化します。

| クラス | サウンド |
|---|---|
| class_1 | キック（低音オシレーター） |
| class_2 | スネア（ノイズ + バンドパスフィルター） |
| class_3 | ハイハット（ノイズ + ハイパスフィルター） |

**カスタマイズ:**
- `else/osc.route /ROI_1` の `ROI_1` を実際の ROI 名に変更
- `route class_1 class_2 class_3` のクラス名を TM モデルに合わせて変更

---

## OSC アドレス一覧

### MediaPipe モード

```
/hand/{left|right}/detected           float (0 or 1)
/hand/{left|right}/{landmark}/x       float (0-1)
/hand/{left|right}/{landmark}/y       float (0-1)
/hand/{left|right}/{landmark}/z       float (0-1)
/hand/{left|right}/gesture/index      float (0-7)
/hand/{left|right}/gesture/score      float (0-1)
/face/detected                        float (0 or 1)
/face/{landmark}/x                    float (0-1)
/face/{landmark}/y                    float (0-1)
/face/{landmark}/z                    float (0-1)
```

**手のランドマーク名:** `wrist`, `thumb/cmc`, `thumb/mcp`, `thumb/ip`, `thumb/tip`,
`index/mcp`, `index/pip`, `index/dip`, `index/tip`,
`middle/mcp`, `middle/pip`, `middle/dip`, `middle/tip`,
`ring/mcp`, `ring/pip`, `ring/dip`, `ring/tip`,
`pinky/mcp`, `pinky/pip`, `pinky/dip`, `pinky/tip`

**顔のランドマーク名:** `left_eye/inner`, `left_eye/outer`, `left_eye/upper`, `left_eye/lower`,
`right_eye/inner`, `right_eye/outer`, `right_eye/upper`, `right_eye/lower`,
`left_eyebrow/inner`, `left_eyebrow/middle`, `left_eyebrow/outer`,
`right_eyebrow/inner`, `right_eyebrow/middle`, `right_eyebrow/outer`,
`nose/tip`, `nose/bridge`, `nose/left`, `nose/right`,
`mouth/upper`, `mouth/lower`, `mouth/left`, `mouth/right`,
`mouth/upper_inner`, `mouth/lower_inner`,
`jaw/left`, `jaw/right`, `jaw/chin`,
`forehead/center`, `cheek/left`, `cheek/right`

**ジェスチャー:** 0=None, 1=Closed_Fist, 2=Open_Palm, 3=Pointing_Up,
4=Thumb_Down, 5=Thumb_Up, 6=Victory, 7=ILoveYou

### BLIP Caption モード

```
/blip/caption                         string (キャプションテキスト)
/blip/trigger{N}                      float (類似度 0-1)
/blip/{ROI名}/caption                 string (ROI別キャプション)
/blip/{ROI名}/trigger{N}              float (ROI別類似度)
```

### Teachable Machine モード

```
/tm/{ROI名}/class                     string (クラス名)
/tm/{ROI名}/confidence                float (確信度 0-1)
/tm/{ROI名}/prob/{i}                  string, float (クラス名, 確率)
```
