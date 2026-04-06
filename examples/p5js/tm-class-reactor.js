// ============================================================
// Class Reactor — SightCue Teachable Machine + p5.js サンプル
// ============================================================
// SightCue の Teachable Machine モードで分類されたクラスに応じて
// 異なるビジュアルエフェクトを表示するスケッチ。
// 確信度に応じてエフェクトの強度が変化します。
//
// SightCue設定:
//   - モード: Teachable Machine
//   - OSCポート: 7400（Interplayブリッジ経由）
//   - ROIを1つ設定（名前は任意、デフォルト: "ROI_1"）
//
// OSCアドレス（受信）:
//   /tm/{roi_name}/class        string  分類クラス名
//   /tm/{roi_name}/confidence   float   確信度 (0-1)
//   /tm/{roi_name}/prob/0       string,float  クラス0: ラベル, 確率
//   /tm/{roi_name}/prob/1       string,float  クラス1: ラベル, 確率
//   ...
//
// ROI名が不明な場合は、SightCueのOSCモニターで確認してください。
// ============================================================

// ---- 設定 ----
// SightCueで設定したROI名をここに入力
const ROI_NAME = 'ROI_1';

// クラス別エフェクト設定（Teachable Machineのクラス名に合わせて変更）
// キーはクラス名（小文字に変換して比較）
const CLASS_EFFECTS = {
  // デフォルトの3クラス例
  class_1: { shape: 'circles', color: [255, 80, 80], bg: [40, 10, 10] },
  class_2: { shape: 'squares', color: [80, 200, 255], bg: [10, 20, 40] },
  class_3: { shape: 'triangles', color: [80, 255, 120], bg: [10, 40, 15] },
};

// ---- 状態変数 ----
let currentClass = '';
let confidence = 0;
let smoothConfidence = 0;
let shapes = [];
const MAX_SHAPES = 200;

// 文字列型OSC対応パーサー（Interplay標準ヘルパーはfloat/intのみのため上書き）
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
  textFont('monospace');
}

function draw() {
  // OSCデータ取得
  let cls = oscData[`/tm/${ROI_NAME}/class`];
  let conf = oscData[`/tm/${ROI_NAME}/confidence`];

  if (cls !== undefined) currentClass = String(cls).toLowerCase();
  if (conf !== undefined) confidence = conf;
  smoothConfidence = lerp(smoothConfidence, confidence, 0.08);

  // エフェクト選択
  let effect = getEffect(currentClass);

  // 背景
  let bg = effect.bg;
  let intensity = smoothConfidence;
  background(
    lerp(15, bg[0], intensity),
    lerp(12, bg[1], intensity),
    lerp(20, bg[2], intensity),
    40
  );

  // 確信度に応じてシェイプ生成
  if (smoothConfidence > 0.3 && frameCount % max(1, floor(10 - smoothConfidence * 8)) === 0) {
    spawnShape(effect);
  }

  // シェイプ更新・描画
  updateShapes();

  // 中央のリアクター表示
  drawReactor(effect);

  // UI
  drawUI(effect);
}

function getEffect(className) {
  // クラス名に一致するエフェクトを探す
  for (let [key, effect] of Object.entries(CLASS_EFFECTS)) {
    if (className.includes(key) || key.includes(className)) {
      return effect;
    }
  }
  // 見つからない場合、先頭一致やインデックスで試行
  let keys = Object.keys(CLASS_EFFECTS);
  if (keys.length > 0) {
    // クラス名の末尾数字でインデックス
    let match = className.match(/(\d+)/);
    if (match) {
      let idx = (parseInt(match[1]) - 1) % keys.length;
      if (idx >= 0) return CLASS_EFFECTS[keys[idx]];
    }
    return CLASS_EFFECTS[keys[0]];
  }
  return { shape: 'circles', color: [200, 200, 200], bg: [20, 20, 20] };
}

function spawnShape(effect) {
  let angle = random(TWO_PI);
  let dist = random(50, min(width, height) * 0.4);
  shapes.push({
    x: width / 2 + cos(angle) * dist,
    y: height / 2 + sin(angle) * dist,
    vx: cos(angle) * random(0.5, 2),
    vy: sin(angle) * random(0.5, 2),
    size: random(10, 40) * smoothConfidence,
    rotation: random(TWO_PI),
    rotSpeed: random(-0.03, 0.03),
    alpha: 255,
    life: random(60, 180),
    type: effect.shape,
    color: [...effect.color],
  });

  while (shapes.length > MAX_SHAPES) shapes.shift();
}

function updateShapes() {
  for (let i = shapes.length - 1; i >= 0; i--) {
    let s = shapes[i];
    s.x += s.vx;
    s.y += s.vy;
    s.rotation += s.rotSpeed;
    s.alpha -= 255 / s.life;
    s.size *= 0.998;

    if (s.alpha <= 0) {
      shapes.splice(i, 1);
      continue;
    }

    push();
    translate(s.x, s.y);
    rotate(s.rotation);
    noStroke();
    fill(s.color[0], s.color[1], s.color[2], s.alpha * 0.7);

    if (s.type === 'circles') {
      circle(0, 0, s.size);
    } else if (s.type === 'squares') {
      rectMode(CENTER);
      rect(0, 0, s.size, s.size);
    } else if (s.type === 'triangles') {
      let r = s.size / 2;
      triangle(0, -r, -r * 0.87, r * 0.5, r * 0.87, r * 0.5);
    }
    pop();
  }
}

function drawReactor(effect) {
  let cx = width / 2;
  let cy = height / 2;
  let baseR = min(width, height) * 0.15;
  let r = baseR * (0.5 + smoothConfidence * 0.5);

  // グロー
  for (let i = 3; i >= 0; i--) {
    let glowR = r + i * 20 * smoothConfidence;
    let a = smoothConfidence * 30 * (3 - i);
    fill(effect.color[0], effect.color[1], effect.color[2], a);
    noStroke();
    circle(cx, cy, glowR * 2);
  }

  // 中心リング
  noFill();
  stroke(effect.color[0], effect.color[1], effect.color[2], 200 * smoothConfidence);
  strokeWeight(2);
  circle(cx, cy, r * 2);

  // パルスリング
  let pulse = (sin(frameCount * 0.05) + 1) / 2;
  stroke(effect.color[0], effect.color[1], effect.color[2], 100 * smoothConfidence * pulse);
  strokeWeight(1);
  circle(cx, cy, r * 2.5 + pulse * 30);

  // クラス名表示
  fill(255, 230 * max(0.3, smoothConfidence));
  noStroke();
  textAlign(CENTER, CENTER);
  textSize(24);
  text(currentClass || '---', cx, cy);

  // 確信度表示
  textSize(14);
  fill(effect.color[0], effect.color[1], effect.color[2], 180);
  text((smoothConfidence * 100).toFixed(0) + '%', cx, cy + 30);
}

function drawUI(effect) {
  fill(255, 180);
  noStroke();
  textSize(14);
  textAlign(LEFT);
  text('Class Reactor — SightCue TM', 20, 30);

  textSize(10);
  fill(150);
  text(`ROI: ${ROI_NAME}`, 20, 50);
  text(`class: ${currentClass || '(waiting...)'}`, 20, 65);
  text(`confidence: ${(smoothConfidence * 100).toFixed(1)}%`, 20, 80);

  // クラスエフェクト凡例
  let y = 105;
  fill(120);
  text('Effects:', 20, y);
  y += 16;
  for (let [key, eff] of Object.entries(CLASS_EFFECTS)) {
    fill(...eff.color, 180);
    circle(28, y - 4, 8);
    fill(150);
    text(`${key} → ${eff.shape}`, 40, y);
    y += 16;
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
