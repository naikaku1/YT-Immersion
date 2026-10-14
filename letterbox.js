// ===== 黒帯（レターボックス）カット =====
// MVの一部区間などで映像に焼き込まれた上下の黒帯を検出して、
//  - MVモード : 黒帯の部分を、映像の上下端を折り返して延長しぼかした光で埋める
//               （Ambient Light系の拡張のように、画面が続いているように見せる）
//  - 通常再生 : 黒帯を切り取り、プレイヤー枠ごと本来の比率の動画として見せる
// 黒帯は曲の途中で出たり消えたりするので、再生中は監視し続ける。
// 設定は MVモードの設定パネルと、プレイヤーの歯車メニューから切り替える。
//
// content.js より先に読み込まれる。content.js の関数には依存せず、
// DOM（#mv-root-container / #movie_player）の状態だけを見て動く。
// content.js からは ytiLetterboxRefresh() を呼んで状態の変化を知らせる。

const YTI_LBX_KEY_MV = 'mv_lbx_mv';         // MVモード：既定ON
const YTI_LBX_KEY_NORMAL = 'mv_lbx_normal'; // 通常再生：既定OFF

function lbxOption(key, def) {
  const v = localStorage.getItem(key);
  return v === null ? def : v === 'true';
}

// 検出用の縮小キャンバス。縦方向の精度が欲しいので縦長に取る（1行≒0.83%）。
const LBX_SAMPLE_W = 48;
const LBX_SAMPLE_H = 120;
const LBX_INTERVAL_MS = 250;
// これより細い帯は誤差・圧縮ノイズとして扱う
const LBX_MIN_BAR = 0.02;
// 境目に1px程度の黒い線が残らないよう、切り取りは少しだけ内側にする
const LBX_EDGE_MARGIN = 0.004;
// 映画でよく使われる比率。測定値が近ければここへ吸着させ、
// 1行単位の測定誤差で切り取り位置がぶれないようにする。
const LBX_RATIOS = [1.85, 1.9, 2, 2.2, 2.35, 2.39, 2.4, 2.55, 2.76];

const lbx = {
  mode: 'off',      // 'mv' | 'normal' | 'off'
  video: null,
  bar: 0,           // 適用中の黒帯（片側、映像の高さに対する割合）
  pending: -1,      // 切り替え候補と、その候補が連続して観測された回数
  pendingCount: 0,
  timer: null,
  scaleCtx: null,
  sampleCtx: null,
  readFailed: false,
  listeners: null,
  // MVモード
  ambientCanvas: null,
  ambientCtx: null,
  ambientWork: null,
  ambientMask: null,
  ambientPrimed: false,
  ambientActive: false,
  frameHandle: 0,
  frameByVideo: false,
  lastDraw: 0,
  geom: null,
  // 通常再生
  flexy: null,
  player: null,
  normalBar: 0,
  resizeObs: null,
  styleObs: null,
};

// ---------- 検出 ----------

// 1フレームを縮小して、上下から連続する「黒い行」の数を数える。
function lbxMeasure(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  // 縮小はGPU側のキャンバスで行い、CPU側へは縮小済みの小さな画像だけを読み出す。
  // 読み出し用キャンバスへ直接 drawImage(video) すると、毎回フル解像度の
  // フレーム（1080pで約8MB）をGPUから転送することになり重い。
  if (!lbx.sampleCtx) {
    const a = document.createElement('canvas');
    a.width = LBX_SAMPLE_W;
    a.height = LBX_SAMPLE_H;
    lbx.scaleCtx = a.getContext('2d', { alpha: false });
    const c = document.createElement('canvas');
    c.width = LBX_SAMPLE_W;
    c.height = LBX_SAMPLE_H;
    lbx.sampleCtx = c.getContext('2d', { willReadFrequently: true });
  }
  const ctx = lbx.sampleCtx;
  let data;
  try {
    lbx.scaleCtx.drawImage(video, 0, 0, LBX_SAMPLE_W, LBX_SAMPLE_H);
    ctx.drawImage(lbx.scaleCtx.canvas, 0, 0);
    data = ctx.getImageData(0, 0, LBX_SAMPLE_W, LBX_SAMPLE_H).data;
  } catch (e) {
    // 画素を読めない（キャンバスが汚染される）動画。以後は試さない
    lbx.readFailed = true;
    return null;
  }
  const bright = new Array(LBX_SAMPLE_H);
  const rowSum = new Array(LBX_SAMPLE_H);
  for (let y = 0; y < LBX_SAMPLE_H; y++) {
    let n = 0;
    let s = 0;
    for (let x = 0; x < LBX_SAMPLE_W; x++) {
      const i = (y * LBX_SAMPLE_W + x) * 4;
      const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      s += lum;
      if (lum > 28) n++;
    }
    bright[y] = n;
    rowSum[y] = s;
  }
  // 小さなロゴや圧縮ノイズが数画素あっても黒い行とみなす
  const isBlack = (y) => bright[y] <= 2;
  const half = LBX_SAMPLE_H / 2;
  let top = 0;
  while (top < half && isBlack(top)) top++;
  let bottom = 0;
  while (bottom < half && isBlack(LBX_SAMPLE_H - 1 - bottom)) bottom++;
  let contentSum = 0;
  let contentRows = 0;
  for (let y = top; y < LBX_SAMPLE_H - bottom; y++) {
    contentSum += rowSum[y];
    contentRows++;
  }
  const contentMean = contentRows ? contentSum / (contentRows * LBX_SAMPLE_W) : 0;
  // 暗転・フェード中は黒帯と絵の境目が分からないので、この1枚では判断しない
  const valid = contentMean >= 10 && top + bottom < LBX_SAMPLE_H * 0.6;
  // 境目のすぐ内側に十分な明るさがあるか。暗い絵の上端を黒帯と取り違えないための確認
  const edgeMin = LBX_SAMPLE_W * 0.15;
  const edgeTop = top === 0 || (top < LBX_SAMPLE_H && bright[top] >= edgeMin);
  const edgeBottom = bottom === 0 || bright[LBX_SAMPLE_H - 1 - bottom] >= edgeMin;
  return {
    top: top / LBX_SAMPLE_H,
    bottom: bottom / LBX_SAMPLE_H,
    valid,
    edge: edgeTop && edgeBottom
  };
}

function lbxSnap(bar, aspect) {
  let best = -1;
  let bestDiff = 0.009;
  for (const r of LBX_RATIOS) {
    if (r <= aspect + 0.02) continue;
    const rb = (1 - aspect / r) / 2;
    const d = Math.abs(rb - bar);
    if (d < bestDiff) {
      bestDiff = d;
      best = rb;
    }
  }
  return best >= 0 ? best : Math.round(bar * 200) / 200;
}

// 測定結果から「この黒帯幅にしたい」という候補を作り、連続して同じ候補が
// 出た時だけ切り替える。絵が黒帯の位置に出てきた時（=切り取ると絵が欠ける）は
// 素早く、黒帯を広げる時はゆっくり慎重に切り替える。
function lbxOnSample(m, immediate) {
  const v = lbx.video;
  if (!m || !m.valid || !v) return;
  const aspect = v.videoWidth / v.videoHeight;
  const cur = lbx.bar;
  const raw = Math.min(m.top, m.bottom);
  let cand;
  let need;
  if (cur > 0 && raw < cur - 0.012) {
    cand = (m.top >= LBX_MIN_BAR && m.bottom >= LBX_MIN_BAR) ? lbxSnap(raw, aspect) : 0;
    need = 2;
  } else {
    if (!m.edge) return;
    // 上下どちらかにしか無い帯（字幕の焼き込み等）は黒帯として扱わない
    cand = (m.top >= LBX_MIN_BAR && m.bottom >= LBX_MIN_BAR) ? lbxSnap(raw, aspect) : 0;
    // 片側25%を超える帯は、暗い絵を黒帯と取り違えている可能性が高い
    if (cand > 0.25) return;
    need = cur > 0 ? 8 : 5;
  }
  if (Math.abs(cand - cur) < 0.01) {
    lbx.pending = -1;
    lbx.pendingCount = 0;
    return;
  }
  if (lbx.pending >= 0 && Math.abs(cand - lbx.pending) < 0.01) lbx.pendingCount++;
  else {
    lbx.pending = cand;
    lbx.pendingCount = 1;
  }
  if (immediate || lbx.pendingCount >= need) {
    lbx.pending = -1;
    lbx.pendingCount = 0;
    lbxApply(cand);
  }
}

function lbxApply(bar) {
  lbx.bar = bar;
  if (lbx.mode === 'mv') lbxLayoutMv();
  else if (lbx.mode === 'normal') lbxLayoutNormal();
}

function lbxSampleNow(immediate) {
  // 広告の映像の黒帯で本編の切り取りを変えない
  const lbxPlayer = document.getElementById('movie_player');
  if (lbxPlayer && lbxPlayer.classList.contains('ad-showing')) return;
  if (lbx.mode === 'off' || !lbx.video || lbx.readFailed) return;
  lbxOnSample(lbxMeasure(lbx.video), immediate);
}

// ---------- モード管理 ----------

function lbxDetectMode() {
  const root = document.getElementById('mv-root-container');
  const mvVideo = root ? root.querySelector('video') : null;
  if (mvVideo) {
    return lbxOption(YTI_LBX_KEY_MV, true) ? { mode: 'mv', video: mvVideo } : { mode: 'off', video: null };
  }
  const onWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/live/');
  const player = document.getElementById('movie_player');
  const pageVideo = player ? player.querySelector('video.html5-main-video') : null;
  if (onWatch && pageVideo && lbxOption(YTI_LBX_KEY_NORMAL, false)) {
    return { mode: 'normal', video: pageVideo };
  }
  return { mode: 'off', video: null };
}

// 状態（MVモードの開始/終了・設定変更・ページ遷移）が変わった時に呼ぶ。
// 1秒ごとの見回りからも呼ばれるので、変化が無ければ何もしない。
function ytiLetterboxRefresh() {
  const next = lbx.readFailed ? { mode: 'off', video: null } : lbxDetectMode();
  if (next.mode === lbx.mode && next.video === lbx.video) return;
  const prevVideo = lbx.video;
  const prevBar = lbx.bar;
  lbxTeardown();
  lbx.mode = next.mode;
  lbx.video = next.video;
  // 同じ動画のままモードだけ変わった（通常→MVなど）なら、検出済みの黒帯を引き継ぐ
  lbx.bar = (next.video && next.video === prevVideo) ? prevBar : 0;
  lbx.pending = -1;
  lbx.pendingCount = 0;
  if (lbx.mode === 'off') return;
  const v = lbx.video;
  const onSeeked = () => {
    // 一時停止中のシークは絵が止まっているので、その1枚で即判断する
    setTimeout(() => lbxSampleNow(v.paused), 120);
  };
  const onReset = () => {
    // 次の動画の読み込み開始。前の動画の黒帯は引き継がない
    lbx.pending = -1;
    lbx.pendingCount = 0;
    if (lbx.bar !== 0) lbxApply(0);
  };
  const onMeta = () => {
    if (lbx.mode === 'mv') lbxLayoutMv();
    setTimeout(() => lbxSampleNow(v.paused), 200);
  };
  v.addEventListener('seeked', onSeeked);
  v.addEventListener('loadstart', onReset);
  v.addEventListener('loadeddata', onMeta);
  lbx.listeners = { v, onSeeked, onReset, onMeta };
  if (lbx.mode === 'mv') lbxSetupMv(document.getElementById('mv-root-container'));
  else lbxSetupNormal(document.getElementById('movie_player'));
  lbx.timer = setInterval(() => {
    const cv = lbx.video;
    if (!cv || !cv.isConnected) {
      ytiLetterboxRefresh();
      return;
    }
    if (cv.paused || cv.seeking || document.hidden) return;
    lbxSampleNow(false);
  }, LBX_INTERVAL_MS);
  setTimeout(() => lbxSampleNow(v.paused), 150);
}

function lbxTeardown() {
  if (lbx.timer) {
    clearInterval(lbx.timer);
    lbx.timer = null;
  }
  if (lbx.listeners) {
    const { v, onSeeked, onReset, onMeta } = lbx.listeners;
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('loadstart', onReset);
    v.removeEventListener('loadeddata', onMeta);
    lbx.listeners = null;
  }
  if (lbx.mode === 'mv') lbxTeardownMv();
  else if (lbx.mode === 'normal') lbxTeardownNormal();
  lbx.mode = 'off';
  lbx.video = null;
}

// ---------- MVモード：黒帯を映像の続きで埋める ----------
// 動画の上に、黒帯（と画面比率の隙間）を覆う小さなキャンバスを重ねる。
//  - キャンバスは幅128pxで描き、拡大は合成処理（GPUのテクスチャ拡大）に任せる
//  - ぼかしは小さいキャンバスの中で掛ける（CSSの filter: blur を全画面に掛けない）
//  - 映像との境目は、キャンバス側の透明度で溶かす（動画に mask を掛けない）
//  - 描き直しは最大15fps。前のフレームと混ぜて、カット割りでの色の跳ねも抑える
// 以前は全画面のキャンバスに毎フレームCSSぼかし＋全画面動画にマスクを掛けていて重かった。
const LBX_AMBIENT_W = 128;
const LBX_AMBIENT_FPS_MS = 66;

function lbxSetupMv(root) {
  if (!root) return;
  const c = document.createElement('canvas');
  c.id = 'mv-lbx-ambient';
  c.width = LBX_AMBIENT_W;
  c.height = 72;
  // 動画の直後（＝動画より手前、歌詞などの重ね表示より奥）に置く
  const v = lbx.video;
  if (v && v.parentNode === root) v.after(c);
  else root.insertBefore(c, root.firstChild);
  lbx.ambientCanvas = c;
  lbx.ambientCtx = c.getContext('2d');
  const work = document.createElement('canvas');
  lbx.ambientWork = work.getContext('2d', { alpha: false });
  const mask = document.createElement('canvas');
  lbx.ambientMask = mask.getContext('2d');
  lbx.ambientPrimed = false;
  lbx.ambientActive = false;
  root.classList.add('yti-lbx-on');
  window.addEventListener('resize', lbxLayoutMv);
  lbxLayoutMv();
  lbxStartAmbientLoop();
}

function lbxTeardownMv() {
  window.removeEventListener('resize', lbxLayoutMv);
  lbxStopAmbientLoop();
  const root = document.getElementById('mv-root-container');
  if (root) root.classList.remove('yti-lbx-on', 'yti-lbx-active');
  if (lbx.ambientCanvas) lbx.ambientCanvas.remove();
  lbx.ambientCanvas = null;
  lbx.ambientCtx = null;
  lbx.ambientWork = null;
  lbx.ambientMask = null;
  lbx.ambientActive = false;
  lbx.geom = null;
}

// 画面上で映像（黒帯を除いた部分）が占める矩形を求め、キャンバスの大きさと
// 「映像を見せる部分を抜く型（マスク）」を作り直す。
// 画面と動画の比率が違う時（16:10のMacで16:9の動画など）にできる上下の隙間も、
// 同じように映像の続きで埋める。
function lbxLayoutMv() {
  const root = document.getElementById('mv-root-container');
  const v = lbx.video;
  const c = lbx.ambientCanvas;
  if (lbx.mode !== 'mv' || !root || !v || !c) return;
  const W = root.clientWidth;
  const H = root.clientHeight;
  if (!W || !H) return;
  const vw = v.videoWidth || 16;
  const vh = v.videoHeight || 9;
  const scale = Math.min(W / vw, H / vh);
  const cw = vw * scale;
  const ch = vh * scale;
  const x0 = (W - cw) / 2;
  const y0 = (H - ch) / 2;
  const b = lbx.bar > 0 ? Math.min(0.3, lbx.bar + LBX_EDGE_MARGIN) : 0;
  const y1 = y0 + ch * b;
  const y2 = y0 + ch * (1 - b);
  const gapY = y1 > 1.5 || H - y2 > 1.5;
  const gapX = x0 > 1.5;
  lbx.geom = { W, H, x0, cw, y1, y2, b };
  const CW = LBX_AMBIENT_W;
  const CH = Math.max(36, Math.round(CW * H / W));
  const resized = c.height !== CH;
  if (resized) {
    c.height = CH;
    lbx.ambientPrimed = false;
  }
  lbx.ambientWork.canvas.width = CW;
  lbx.ambientWork.canvas.height = CH;
  // 型：映像を見せる部分ほど不透明（=キャンバスを消す）。境目は数%かけて溶かす。
  // キャンバス1pxは画面の十数pxにあたるので、拡大時の補間で黒帯がうっすら
  // 透けないよう、消し始めは境目から1px内側にずらす。
  const k = CW / W;
  const m = lbx.ambientMask;
  m.canvas.width = CW;
  m.canvas.height = CH;
  m.clearRect(0, 0, CW, CH);
  const ty1 = y1 * k + (gapY ? 1 : 0);
  const ty2 = y2 * k - (gapY ? 1 : 0);
  const fy = gapY ? Math.max(1.5, (ty2 - ty1) * 0.06) : 0;
  const tx1 = x0 * k + (gapX ? 1 : 0);
  const tx2 = (x0 + cw) * k - (gapX ? 1 : 0);
  const fx = gapX ? Math.max(1.5, (tx2 - tx1) * 0.05) : 0;
  if (ty2 > ty1 && tx2 > tx1) {
    const gv = m.createLinearGradient(0, ty1, 0, ty2);
    const sv = fy / (ty2 - ty1);
    gv.addColorStop(0, 'rgba(0,0,0,0)');
    gv.addColorStop(Math.min(0.5, sv), '#000');
    gv.addColorStop(Math.max(0.5, 1 - sv), '#000');
    gv.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = gv;
    m.fillRect(tx1, ty1, tx2 - tx1, ty2 - ty1);
    if (fx > 0) {
      const gh = m.createLinearGradient(tx1, 0, tx2, 0);
      const sh = fx / (tx2 - tx1);
      gh.addColorStop(0, 'rgba(0,0,0,0)');
      gh.addColorStop(Math.min(0.5, sh), '#000');
      gh.addColorStop(Math.max(0.5, 1 - sh), '#000');
      gh.addColorStop(1, 'rgba(0,0,0,0)');
      m.globalCompositeOperation = 'destination-in';
      m.fillStyle = gh;
      m.fillRect(0, 0, CW, CH);
      m.globalCompositeOperation = 'source-over';
    }
  }
  const active = gapX || gapY;
  lbx.ambientActive = active;
  // 一時停止中に切り替わってもキャンバスが古い型のままにならないよう、すぐ1枚描く
  if (active) lbxDrawAmbient();
  root.classList.toggle('yti-lbx-active', active);
}

// 作業用キャンバスに「映像を画面全体へ引き伸ばした下地」と「上下の端を境目で
// 折り返した像」を描き、ぼかして表示用キャンバスへ写してから、映像の部分を型で抜く。
function lbxDrawAmbient() {
  const v = lbx.video;
  const c = lbx.ambientCanvas;
  const ctx = lbx.ambientCtx;
  const w = lbx.ambientWork;
  const g = lbx.geom;
  if (!v || !c || !ctx || !w || !g || v.readyState < 2 || !v.videoWidth) return;
  const CW = c.width;
  const CH = c.height;
  const k = CW / g.W;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const sy = vh * g.b;
  const sh = vh * (1 - 2 * g.b);
  const dx = g.x0 * k;
  const dw = g.cw * k;
  const dy = g.y1 * k;
  const dh = (g.y2 - g.y1) * k;
  if (sh <= 1 || dh <= 0.5) return;
  try {
    // 前の絵に半分だけ重ねて、時間方向にならす（初回は全面で描く）
    w.globalAlpha = lbx.ambientPrimed ? 0.5 : 1;
    w.drawImage(v, 0, sy, vw, sh, 0, 0, CW, CH);
    if (dy > 0.5) {
      const srcH = Math.min(sh * 0.5, dy / dh * sh);
      w.save();
      w.translate(0, dy);
      w.scale(1, -1);
      w.drawImage(v, 0, sy, vw, srcH, dx, 0, dw, dy);
      w.restore();
    }
    const by = dy + dh;
    const bh = CH - by;
    if (bh > 0.5) {
      const srcH = Math.min(sh * 0.5, bh / dh * sh);
      w.save();
      w.translate(0, CH);
      w.scale(1, -1);
      w.drawImage(v, 0, sy + sh - srcH, vw, srcH, dx, 0, dw, bh);
      w.restore();
    }
    w.drawImage(v, 0, sy, vw, sh, dx, dy, dw, dh);
    w.globalAlpha = 1;
    lbx.ambientPrimed = true;
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = 'blur(2px) saturate(1.2) brightness(0.85)';
    ctx.drawImage(w.canvas, 0, 0);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(lbx.ambientMask.canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  } catch (e) {}
}

// 新しいフレームが出るたび（最大15fps）に描き直す。一時停止中は描かない。
function lbxStartAmbientLoop() {
  const v = lbx.video;
  if (!v) return;
  lbx.frameByVideo = typeof v.requestVideoFrameCallback === 'function';
  const tick = (now) => {
    if (lbx.mode !== 'mv' || lbx.video !== v) return;
    if (lbx.ambientActive && now - lbx.lastDraw > LBX_AMBIENT_FPS_MS) {
      lbx.lastDraw = now;
      lbxDrawAmbient();
    }
    schedule();
  };
  const schedule = () => {
    lbx.frameHandle = lbx.frameByVideo ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  schedule();
}

function lbxStopAmbientLoop() {
  try {
    if (lbx.frameHandle) {
      if (lbx.frameByVideo && lbx.video && lbx.video.cancelVideoFrameCallback) {
        lbx.video.cancelVideoFrameCallback(lbx.frameHandle);
      } else {
        cancelAnimationFrame(lbx.frameHandle);
      }
    }
  } catch (e) {}
  lbx.frameHandle = 0;
}

// ---------- 通常再生：黒帯を切り取り、本来の比率で見せる ----------
// YouTubeはプレイヤー枠の比率を ytd-watch-flexy の
// --ytd-watch-flexy-width-ratio / --ytd-watch-flexy-height-ratio から決めている。
// これを黒帯を除いた比率に差し替えると、横長の動画を開いた時と同じ枠になる。
// 動画要素はYouTubeが枠に収まるよう配置し直すので、こちらは黒帯の分だけ拡大する。

function lbxSetupNormal(player) {
  if (!player) return;
  lbx.player = player;
  lbx.flexy = document.querySelector('ytd-watch-flexy');
  lbx.normalBar = 0;
  lbx.resizeObs = new ResizeObserver(() => lbxUpdateNormalScale());
  lbx.resizeObs.observe(player);
  // YouTubeが動画要素の大きさ・位置（style属性）を書き換えたら拡大率を取り直す
  lbx.styleObs = new MutationObserver(() => lbxUpdateNormalScale());
  if (lbx.video) lbx.styleObs.observe(lbx.video, { attributes: true, attributeFilter: ['style'] });
  lbxLayoutNormal();
}

function lbxTeardownNormal() {
  if (lbx.resizeObs) lbx.resizeObs.disconnect();
  if (lbx.styleObs) lbx.styleObs.disconnect();
  lbx.resizeObs = null;
  lbx.styleObs = null;
  const hadCrop = lbx.normalBar > 0;
  lbxClearNormalCrop();
  lbx.normalBar = 0;
  lbx.player = null;
  lbx.flexy = null;
  if (hadCrop) window.dispatchEvent(new Event('resize'));
}

function lbxClearNormalCrop() {
  const flexy = lbx.flexy || document.querySelector('ytd-watch-flexy');
  if (flexy) {
    flexy.classList.remove('yti-lbx-crop');
    flexy.style.removeProperty('--yti-lbx-wr');
    flexy.style.removeProperty('--yti-lbx-hr');
  }
  const player = lbx.player || document.getElementById('movie_player');
  if (player) {
    player.classList.remove('yti-lbx-crop');
    player.style.removeProperty('--yti-lbx-s');
  }
}

function lbxLayoutNormal() {
  const v = lbx.video;
  const player = lbx.player;
  if (lbx.mode !== 'normal' || !v || !player) return;
  const b = lbx.bar > 0 ? Math.min(0.3, lbx.bar + LBX_EDGE_MARGIN) : 0;
  if (b === lbx.normalBar) return;
  lbx.normalBar = b;
  if (b > 0 && v.videoWidth && v.videoHeight) {
    const ac = (v.videoWidth / v.videoHeight) / (1 - 2 * b);
    const flexy = lbx.flexy || document.querySelector('ytd-watch-flexy');
    lbx.flexy = flexy;
    if (flexy) {
      flexy.style.setProperty('--yti-lbx-wr', String(Math.round(ac * 1000)));
      flexy.style.setProperty('--yti-lbx-hr', '1000');
      flexy.classList.add('yti-lbx-crop');
    }
    player.classList.add('yti-lbx-crop');
  } else {
    lbxClearNormalCrop();
  }
  // プレイヤーの大きさが変わったことをYouTubeに知らせ、動画の配置と操作バーを組み直させる
  window.dispatchEvent(new Event('resize'));
  lbxUpdateNormalScale();
  requestAnimationFrame(() => requestAnimationFrame(lbxUpdateNormalScale));
}

// YouTubeが枠に収めた動画要素を、黒帯を除いた部分が枠にちょうど収まる倍率まで拡大する。
// 枠が最大幅などで想定の比率にならなかった時も、絵が欠けない側（contain）で止める。
function lbxUpdateNormalScale() {
  const p = lbx.player;
  const v = lbx.video;
  if (lbx.mode !== 'normal' || !p || !v) return;
  const b = lbx.normalBar;
  let s = 1;
  if (b > 0 && v.offsetWidth && v.offsetHeight) {
    s = Math.min(p.clientWidth / v.offsetWidth, p.clientHeight / (v.offsetHeight * (1 - 2 * b)));
    s = Math.max(1, Math.min(1.8, s));
  }
  const val = s.toFixed(4);
  if (p.style.getPropertyValue('--yti-lbx-s') !== val) p.style.setProperty('--yti-lbx-s', val);
}

// ---------- 設定 ----------

function ytiLetterboxSetOption(key, on) {
  localStorage.setItem(key, on ? 'true' : 'false');
  lbxSyncMenuItem();
  ytiLetterboxRefresh();
}

// プレイヤーの歯車メニューに「黒帯カット」のトグルを差し込む。
// メニューが開く直前（pointerdown）に入れておくと、YouTubeが開く時に
// 測るメニューの高さにこの項目も含まれる。
function lbxEnsureMenuItem() {
  const menu = document.querySelector('#movie_player .ytp-settings-menu');
  if (!menu) return;
  let main = null;
  for (const panel of menu.querySelectorAll('.ytp-panel')) {
    if (panel.querySelector('.ytp-panel-header')) continue; // サブメニュー（画質など）
    main = panel.querySelector('.ytp-panel-menu');
    if (main) break;
  }
  if (!main) return;
  let item = main.querySelector('.yti-lbx-menuitem');
  if (!item) {
    item = document.createElement('div');
    item.className = 'ytp-menuitem yti-lbx-menuitem';
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', '黒帯カット');
    item.innerHTML =
      '<div class="ytp-menuitem-icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 5h18M3 19h18"/><rect x="3" y="8.5" width="18" height="7" rx="1.5"/></svg></div>' +
      '<div class="ytp-menuitem-label">黒帯カット</div>' +
      '<div class="ytp-menuitem-content"><div class="ytp-menuitem-toggle-checkbox"></div></div>';
    const toggle = (e) => {
      e.stopPropagation();
      e.preventDefault();
      ytiLetterboxSetOption(YTI_LBX_KEY_NORMAL, !lbxOption(YTI_LBX_KEY_NORMAL, false));
    };
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggle(e);
    });
    // 「シネマティック ライティング」等のトグル群の直後に置く
    const toggles = main.querySelectorAll('.ytp-menuitem[role="menuitemcheckbox"]:not(.yti-lbx-menuitem)');
    if (toggles.length) toggles[toggles.length - 1].after(item);
    else main.prepend(item);
  }
  item.setAttribute('aria-checked', String(lbxOption(YTI_LBX_KEY_NORMAL, false)));
}

function lbxSyncMenuItem() {
  document.querySelectorAll('.yti-lbx-menuitem').forEach(el => {
    el.setAttribute('aria-checked', String(lbxOption(YTI_LBX_KEY_NORMAL, false)));
  });
}

document.addEventListener('pointerdown', (e) => {
  if (e.target && e.target.closest && e.target.closest('.ytp-settings-button')) lbxEnsureMenuItem();
}, true);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest && e.target.closest('.ytp-settings-button')) {
    lbxEnsureMenuItem();
  }
}, true);

// ページ遷移・MVモードの開閉・PiPへの動画の移動などを1秒ごとに見回る（変化が無ければ何もしない）
document.addEventListener('yt-navigate-finish', () => {
  lbx.readFailed = false;
  setTimeout(ytiLetterboxRefresh, 300);
});
setInterval(ytiLetterboxRefresh, 1000);
