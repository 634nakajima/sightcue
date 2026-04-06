// ============================================================
// Hand Paint — SightCue MediaPipe + p5.js サンプル
// ============================================================
// SightCue の MediaPipe モードで検出した手のランドマークを使い、
// 人差し指の先端で画面上にパーティクルを描画するスケッチ。
// ジェスチャーでブラシの色・サイズが切り替わります。
//
// SightCue設定:
//   - モード: MediaPipe Tracking
//   - OSCポート: 7400（Interplayブリッジ経由）
//
// OSCアドレス（受信）:
//   /hand/left/detected        float  (0 or 1)
//   /hand/left/index/tip/x     float  (0-1)
//   /hand/left/index/tip/y     float  (0-1)
//   /hand/left/gesture/index   float  (0=None,1=Closed_Fist,2=Open_Palm,
//                                      3=Pointing_Up,4=Thumb_Down,
//                                      5=Thumb_Up,6=Victory,7=ILoveYou)
//   /hand/right/... （右手も同様）
// ============================================================

let particles = [];
const MAX_PARTICLES = 2000;

// ジェスチャー別ブラシ設定
const BRUSHES = {
  0: { color: [255, 255, 255], size: 6, name: 'None' },         // 未検出
  1: { color: [255, 80, 80], size: 3, name: 'Closed Fist' },    // グー → 細い赤
  2: { color: [80, 200, 255], size: 20, name: 'Open Palm' },    // パー → 太い水色
  3: { color: [255, 220, 50], size: 10, name: 'Pointing Up' },  // 指差し → 黄色
  4: { color: [180, 80, 255], size: 8, name: 'Thumb Down' },    // サムズダウン → 紫
  5: { color: [80, 255, 120], size: 12, name: 'Thumb Up' },     // サムズアップ → 緑
  6: { color: [255, 150, 200], size: 15, name: 'Victory' },     // ピース → ピンク
  7: { color: [255, 200, 100], size: 18, name: 'I Love You' },  // ILY → オレンジ
};

function setup() {
  createCanvas(windowWidth, windowHeight);
  setupOSC(7401);
  background(15);
  textFont('monospace');
}

function draw() {
  // フェードアウト効果（残像）
  background(15, 15, 20, 12);

  // 両手の処理
  processHand('left');
  processHand('right');

  // パーティクルの更新・描画
  updateParticles();

  // UI表示
  drawUI();
}

function processHand(side) {
  let detected = oscData[`/hand/${side}/detected`] || 0;
  if (detected < 0.5) return;

  let tipX = oscData[`/hand/${side}/index/tip/x`];
  let tipY = oscData[`/hand/${side}/index/tip/y`];
  if (tipX === undefined || tipY === undefined) return;

  // SightCueの座標は0-1（左上原点）なのでキャンバスサイズに変換
  // X軸は左右反転（鏡像）
  let x = (1 - tipX) * width;
  let y = tipY * height;

  // ジェスチャーインデックス取得
  let gestureIdx = Math.round(oscData[`/hand/${side}/gesture/index`] || 0);
  let brush = BRUSHES[gestureIdx] || BRUSHES[0];

  // パーティクル生成
  for (let i = 0; i < 3; i++) {
    particles.push({
      x: x + random(-brush.size / 2, brush.size / 2),
      y: y + random(-brush.size / 2, brush.size / 2),
      vx: random(-0.5, 0.5),
      vy: random(-1.5, -0.3),
      size: random(brush.size * 0.5, brush.size * 1.2),
      color: [...brush.color],
      alpha: 255,
      life: random(60, 150),
    });
  }

  // 上限制御
  while (particles.length > MAX_PARTICLES) {
    particles.shift();
  }

  // カーソル表示
  noFill();
  stroke(...brush.color, 150);
  strokeWeight(1.5);
  circle(x, y, brush.size * 3);

  // 指先のラベル
  fill(...brush.color);
  noStroke();
  textSize(10);
  textAlign(CENTER);
  text(side === 'left' ? 'L' : 'R', x, y - brush.size * 2);
}

function updateParticles() {
  noStroke();
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.01; // 微小な重力
    p.alpha -= 255 / p.life;
    p.size *= 0.995;

    if (p.alpha <= 0 || p.size < 0.3) {
      particles.splice(i, 1);
      continue;
    }

    fill(p.color[0], p.color[1], p.color[2], p.alpha);
    circle(p.x, p.y, p.size);
  }
}

function drawUI() {
  // ジェスチャーガイド表示
  fill(255, 200);
  noStroke();
  textSize(12);
  textAlign(LEFT);
  let y = 30;
  text('Hand Paint — SightCue MediaPipe', 20, y);
  y += 25;

  textSize(10);
  fill(180);
  text('Gestures:', 20, y);
  y += 18;
  for (let [idx, brush] of Object.entries(BRUSHES)) {
    if (idx == 0) continue;
    fill(...brush.color, 180);
    circle(30, y - 4, 8);
    fill(180);
    text(`${brush.name}`, 42, y);
    y += 16;
  }

  // パーティクル数
  fill(100);
  textAlign(RIGHT);
  text(`particles: ${particles.length}`, width - 20, height - 20);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  background(15);
}
