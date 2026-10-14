// ===== 歌詞の行送りアニメーション（YTM-Immersion と同じ方式）=====
// 行が変わったら scrollTop はその場で行き先へ飛ばし、見た目の動きは
// 各行の translate で「さっきまでいた所」から 0 へ戻していく。
// その動きは Web Animations に渡すので、合成スレッドが画面の更新に合わせて進める。
// 上の行から順に少しずつ遅れて動き出す（時間差）ので、歌詞の列がしなやかに流れる。
//
// 以前（本拡張）は rAF で毎フレーム scrollTop を目標へ寄せていた（lerp）。
// メインスレッドが重いフレームでは歌詞も止まり、scrollTop が画素単位に丸められる
// ので止まり際が段々になっていた。いまはメインスレッドの仕事は行が変わった時の1回だけ。
//
// 行の拡大（transform: scale）とは別のプロパティ（translate）を動かすので、
// アクティブ行の拡大・縮小のトランジションとは干渉しない。
//
// content.js から ytiLyricMotion.scrollTo(container, rowsParent, target, primaryIndex, opts) で使う。

const ytiLyricMotion = (() => {
  // 時間差なし（遠くへ飛ぶ時・時間差オフ）のばね。行き過ぎて戻らない臨界減衰。
  const SCROLL_STIFFNESS = 120;
  const SCROLL_DAMPING = 2 * Math.sqrt(SCROLL_STIFFNESS);
  // これ以下になったら止める。残りコンマ数 px を延々と詰めない。
  const SETTLE_PX = 0.5;
  const SETTLE_VEL = 8;
  // 行ごとの時間差。上の行から順に少しずつ遅れて動き出す。
  const STAGGER_DELAY = 0.032;
  const STAGGER_MAX_ROWS = 32;
  const STAGGER_STIFFNESS = 145;
  const STAGGER_DAMPING = 19;
  // キーフレームの間隔。間は合成側が直線で埋める（1/60秒刻みなら曲線との差は0.1px未満）
  const FRAME_SEC = 1 / 60;
  const MAX_SEC = 3;
  // 画面の外でも、この距離までに入る行は動かす
  const MARGIN_PX = 80;

  // 減衰ばね（質量1）の t 秒後の変位 y と速度 v。y0 は行き先からのずれ。
  function sampleSpring(k, c, y0, v0, t) {
    const w0 = Math.sqrt(k);
    const zeta = c / (2 * w0);
    if (zeta < 1 - 1e-6) {
      const a = zeta * w0;
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const b = (v0 + a * y0) / wd;
      const e = Math.exp(-a * t);
      const cos = Math.cos(wd * t);
      const sin = Math.sin(wd * t);
      return {
        y: e * (y0 * cos + b * sin),
        v: e * ((b * wd - a * y0) * cos - (y0 * wd + a * b) * sin),
      };
    }
    if (zeta <= 1 + 1e-6) {
      const b = v0 + w0 * y0;
      const e = Math.exp(-w0 * t);
      return { y: (y0 + b * t) * e, v: (v0 - w0 * b * t) * e };
    }
    const s = w0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w0 + s;
    const r2 = -zeta * w0 - s;
    const c1 = (v0 - r2 * y0) / (r1 - r2);
    const c2 = y0 - c1;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    return { y: c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 };
  }

  // 着地するまでの変位を等間隔に並べる。最後は必ず 0。
  function buildPath(k, c, y0, v0) {
    const path = [y0];
    for (let i = 1; ; i++) {
      const t = i * FRAME_SEC;
      const { y, v } = sampleSpring(k, c, y0, v0, t);
      if ((Math.abs(y) < SETTLE_PX && Math.abs(v) < SETTLE_VEL) || t >= MAX_SEC) {
        path.push(0);
        return path;
      }
      path.push(y);
    }
  }

  // 行がいま行き先からどれだけずれているか（scrollTop と同じ向き）と速度、残りの待ち時間
  function readMotion(state) {
    let elapsed = 0;
    try {
      elapsed = (Number(state.anim.currentTime) || 0) / 1000;
    } catch (e) {}
    const t = elapsed - state.delay;
    if (t >= state.duration) return { y: 0, v: 0, wait: 0 };
    if (t <= 0) return { y: state.y0, v: state.v0, wait: -t };
    const { y, v } = sampleSpring(state.k, state.c, state.y0, state.v0, t);
    return { y, v, wait: 0 };
  }

  function dropMotion(state) {
    try {
      state.anim.cancel();
    } catch (e) {}
    if (state.row._ytiMotion === state) state.row._ytiMotion = undefined;
  }

  // 動きを止めて、行を本来の位置に置く（再描画・シーク・窓の大きさの変更など）
  function reset(container) {
    const motion = container && container._ytiRowMotion;
    if (!motion) return;
    container._ytiRowMotion = undefined;
    for (const state of motion.values()) dropMotion(state);
  }

  function onFinished(container, state) {
    const motion = container._ytiRowMotion;
    if (!motion || motion.get(state.row) !== state) return;
    motion.delete(state.row);
    dropMotion(state);
    if (!motion.size) container._ytiRowMotion = undefined;
  }

  function isMoving(container) {
    return !!(container && container._ytiRowMotion);
  }

  // 行が変わった時に1回だけ呼ぶ。scrollTop を行き先へ飛ばし、飛ばしたぶんを
  // 見えている行の translate で打ち消してから、ばねで 0 へ戻す。
  // opts: { instant, stagger, isRow(el) }
  function scrollTo(container, rowsParent, target, primaryIndex, opts) {
    if (!container) return;
    opts = opts || {};
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    target = Math.max(0, Math.min(target, max));
    if (opts.instant) {
      reset(container);
      container.scrollTop = target;
      return;
    }
    const from = container.scrollTop;
    // いま動いている行の、この瞬間の位置と速度を先に控える（止めると読めない）
    const previous = container._ytiRowMotion;
    const carried = new Map();
    if (previous) {
      for (const state of previous.values()) carried.set(state.row, readMotion(state));
      reset(container);
    }
    container.scrollTop = target;
    // scrollTop は範囲と画素に丸められるので、実際に着いた値で計算する
    const to = container.scrollTop;
    const parent = rowsParent || container;
    const rows = parent.children;
    const height = container.clientHeight;
    if (!rows || !rows.length || !height || typeof rows[0].animate !== 'function') return;
    const isRow = opts.isRow || (() => true);
    const jump = to - from;
    // 遠くへ飛ぶ時（シーク・手で読みに行った所から戻る等）は時間差を付けない。
    // 付けると画面何枚ぶんもの行が順に遅れて、戻り切るまでが長くなる。
    const stagger = opts.stagger !== false && Math.abs(jump) <= height * 1.5;
    const k = stagger ? STAGGER_STIFFNESS : SCROLL_STIFFNESS;
    const c = stagger ? STAGGER_DAMPING : SCROLL_DAMPING;
    // 行き過ぎるぶんも画面に入りうるので、遠いほど広めに見る
    const margin = MARGIN_PX + Math.abs(jump) * 0.05;
    const viewTop = container.getBoundingClientRect().top;
    // 動いている間に画面に入る行だけを拾う。歌っている行から上下へたどり、
    // 画面の外に出きった所で打ち切る。測るのは行が変わった時だけ。
    const picked = [];
    const visit = (i, dir) => {
      const row = rows[i];
      if (!isRow(row)) return true;
      const rect = row.getBoundingClientRect();
      if (!rect.height) return true;
      const endTop = rect.top - viewTop;
      const prior = carried.get(row);
      const y0 = from + (prior ? prior.y : 0) - to;
      const startTop = endTop - y0;
      const hi = Math.min(startTop, endTop);
      const lo = Math.max(startTop, endTop) + rect.height;
      if (lo < -margin) return dir > 0;
      if (hi > height + margin) return dir < 0;
      picked.push({ index: i, row, y0, v0: prior ? prior.v : 0, wait: prior ? prior.wait : null });
      return true;
    };
    const center = Number.isInteger(primaryIndex) ? Math.min(Math.max(primaryIndex, 0), rows.length - 1) : 0;
    for (let i = center; i < rows.length; i++) if (!visit(i, 1)) break;
    for (let i = center - 1; i >= 0; i--) if (!visit(i, -1)) break;
    // 打ち切った先でまだ動いている行も、途中で放すと跳ぶので最後まで動かす
    for (const row of carried.keys()) {
      if (picked.some(p => p.row === row) || row.parentNode !== parent) continue;
      const prior = carried.get(row);
      picked.push({ index: Array.prototype.indexOf.call(rows, row), row, y0: from + prior.y - to, v0: prior.v, wait: prior.wait });
    }
    picked.sort((a, b) => a.index - b.index);
    const motion = new Map();
    // 新しく動き出す行はみな同じ距離・速度0なので、キーフレームを使い回す
    const shared = new Map();
    picked.forEach(({ row, y0, v0, wait }, order) => {
      if (Math.abs(y0) < SETTLE_PX && Math.abs(v0) < SETTLE_VEL) return;
      const delay = wait !== null ? wait : (stagger ? Math.min(order, STAGGER_MAX_ROWS - 1) * STAGGER_DELAY : 0);
      const key = `${y0.toFixed(2)}|${v0.toFixed(1)}`;
      let built = shared.get(key);
      if (!built) {
        const path = buildPath(k, c, y0, v0);
        built = {
          frames: path.map(y => ({ translate: `0 ${(-y).toFixed(2)}px` })),
          duration: (path.length - 1) * FRAME_SEC,
        };
        shared.set(key, built);
      }
      let anim;
      try {
        anim = row.animate(built.frames, {
          duration: built.duration * 1000,
          delay: delay * 1000,
          // 待っている間は元いた所に留まる。終われば何も残さない。
          fill: 'backwards',
          easing: 'linear',
        });
      } catch (e) {
        return;
      }
      const state = { row, anim, k, c, y0, v0, delay, duration: built.duration };
      row._ytiMotion = state;
      motion.set(row, state);
      anim.onfinish = () => onFinished(container, state);
    });
    if (motion.size) container._ytiRowMotion = motion;
  }

  return { scrollTo, reset, isMoving };
})();
