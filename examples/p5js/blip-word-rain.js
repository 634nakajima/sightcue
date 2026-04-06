// ============================================================
// Word Rain — SightCue BLIP + p5.js サンプル
// ============================================================
// SightCue の BLIP Caption モードで生成されたキャプション（英文）を
// 単語に分解し、画面上から雨のように降らせるスケッチ。
// トリガーの類似度に応じて背景色やエフェクトが変化します。
//
// SightCue設定:
//   - モード: BLIP Caption
//   - OSCポート: 7400（Interplayブリッジ経由）
//   - トリガーを1〜4個設定推奨
//
// OSCアドレス（受信）:
//   /blip/caption       string  キャプションテキスト
//   /blip/trigger1      float   トリガー1の類似度 (0-1)
//   /blip/trigger2      float   トリガー2の類似度 (0-1)
//   /blip/trigger3      float   トリガー3の類似度 (0-1)
//   /blip/trigger4      float   トリガー4の類似度 (0-1)
// ============================================================

let words = [];
let lastCaption = '';
let captionHistory = [];
const MAX_WORDS = 300;
const MAX_HISTORY = 8;

// トリガー類似度
let triggerValues = [0, 0, 0, 0];
// トリガー色
const TRIGGER_COLORS = [
  [255, 80, 80],    // 赤
  [80, 200, 255],   // 水色
  [80, 255, 120],   // 緑
  [255, 220, 50],   // 黄
];

// 文字列型OSC対応パーサー（Interplay標準ヘルパーはfloat/intのみのため上書き）
// ※関数名を _oscParseExt にしてInterplayの自動削除を回避
function _oscParseExt(buf) {
  var view = new DataView(buf);
  var i = 0;
  var addrEnd = i;
  while (addrEnd < view.byteLength && view.getUint8(addrEnd) !== 0) addrEnd++;
  var address = String.fromCharCode.apply(null, new Uint8Array(buf, i, addrEnd - i));
  i = addrEnd;
  i += 4 - (i % 4);
  if (i >= view.byteLength || view.getUint8(i) !== 44) return null;
  i++;
  var type = String.fromCharCode(view.getUint8(i));
  i++;
  i += 4 - (i % 4);
  var value;
  if (type === 'f' && i + 4 <= view.byteLength) {
    value = view.getFloat32(i);
  } else if (type === 'i' && i + 4 <= view.byteLength) {
    value = view.getInt32(i);
  } else if (type === 's') {
    var strEnd = i;
    while (strEnd < view.byteLength && view.getUint8(strEnd) !== 0) strEnd++;
    value = String.fromCharCode.apply(null, new Uint8Array(buf, i, strEnd - i));
  }
  return { address: address, value: value };
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  setupOSC(7401);
  // 文字列OSC対応: onmessageを差し替え
  if (oscWs) {
    oscWs.onmessage = function(e) {
      var parsed = _oscParseExt(e.data);
      if (parsed) oscData[parsed.address] = parsed.value;
    };
  }
  textFont('Georgia');
}

function draw() {
  // トリガー値の更新
  for (let i = 0; i < 4; i++) {
    let val = oscData[`/blip/trigger${i + 1}`];
    if (val !== undefined) {
      triggerValues[i] = lerp(triggerValues[i], val, 0.1);
    }
  }

  // 背景色（トリガー値に応じて変化）
  drawBackground();

  // 新しいキャプション受信チェック
  let caption = oscData['/blip/caption'];
  if (caption && caption !== lastCaption) {
    lastCaption = caption;
    spawnWords(caption);
    captionHistory.unshift({ text: caption, time: frameCount });
    if (captionHistory.length > MAX_HISTORY) captionHistory.pop();
  }

  // 単語パーティクルの更新・描画
  updateWords();

  // UI表示
  drawUI();
}

function drawBackground() {
  // ベース色
  let r = 15, g = 10, b = 25;

  // 各トリガーの寄与を加算
  for (let i = 0; i < 4; i++) {
    let intensity = triggerValues[i] * 0.3;
    r += TRIGGER_COLORS[i][0] * intensity;
    g += TRIGGER_COLORS[i][1] * intensity;
    b += TRIGGER_COLORS[i][2] * intensity;
  }

  background(constrain(r, 0, 255), constrain(g, 0, 255), constrain(b, 0, 255), 30);
}

function spawnWords(caption) {
  // キャプションを単語に分解
  let wordList = caption.split(/\s+/).filter(w => w.length > 0);

  for (let w of wordList) {
    let sz = map(w.length, 1, 12, 14, 48);
    // 最も高いトリガー値の色を使用
    let maxIdx = 0;
    let maxVal = triggerValues[0];
    for (let i = 1; i < 4; i++) {
      if (triggerValues[i] > maxVal) {
        maxVal = triggerValues[i];
        maxIdx = i;
      }
    }
    let col = maxVal > 0.2
      ? TRIGGER_COLORS[maxIdx]
      : [200 + random(-30, 30), 200 + random(-30, 30), 220 + random(-30, 30)];

    words.push({
      text: w,
      x: random(50, width - 50),
      y: random(-100, -20),
      vy: random(0.5, 2.5),
      vx: random(-0.3, 0.3),
      size: sz,
      color: col,
      alpha: 255,
      rotation: random(-0.15, 0.15),
    });
  }

  // 上限制御
  while (words.length > MAX_WORDS) {
    words.shift();
  }
}

function updateWords() {
  for (let i = words.length - 1; i >= 0; i--) {
    let w = words[i];
    w.y += w.vy;
    w.x += w.vx;
    w.vx += random(-0.02, 0.02); // 微小なゆらぎ

    // 画面下部に近づくとフェードアウト
    if (w.y > height * 0.7) {
      w.alpha -= 2;
    }

    if (w.alpha <= 0 || w.y > height + 50) {
      words.splice(i, 1);
      continue;
    }

    push();
    translate(w.x, w.y);
    rotate(w.rotation);
    fill(w.color[0], w.color[1], w.color[2], w.alpha);
    noStroke();
    textSize(w.size);
    textAlign(CENTER, CENTER);
    text(w.text, 0, 0);
    pop();
  }
}

function drawUI() {
  // ヘッダー
  fill(255, 180);
  noStroke();
  textSize(14);
  textAlign(LEFT);
  textFont('monospace');
  text('Word Rain — SightCue BLIP', 20, 30);

  // トリガーバー
  textSize(10);
  for (let i = 0; i < 4; i++) {
    let y = 55 + i * 22;
    fill(100);
    text(`trigger${i + 1}`, 20, y);

    // バー背景
    fill(40);
    rect(90, y - 10, 120, 12, 3);

    // バー値
    fill(...TRIGGER_COLORS[i], 200);
    rect(90, y - 10, 120 * triggerValues[i], 12, 3);

    // 数値
    fill(180);
    text(triggerValues[i].toFixed(2), 220, y);
  }

  // キャプション履歴
  let histY = height - 30;
  textAlign(LEFT);
  for (let i = 0; i < captionHistory.length; i++) {
    let age = frameCount - captionHistory[i].time;
    let alpha = map(age, 0, 600, 200, 0);
    if (alpha <= 0) continue;
    fill(200, 200, 220, alpha);
    textSize(i === 0 ? 13 : 11);
    text(captionHistory[i].text, 20, histY);
    histY -= 18;
  }

  textFont('Georgia');
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
