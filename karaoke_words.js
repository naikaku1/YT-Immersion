// ===== カラオケ：語単位の塗り（YTM-Immersion の Apple Music 風の文字同期と同じ方式） =====
// Apple Music の歌詞が美しく見えるのは、
//   1. 塗りの先端が行を「ひと続きに」流れていく（境目はぼけている）
//   2. 行そのものは平らなまま
//   3. 伸ばした音だけが膨らんで光り、また戻る（速い語は光らない）
// が同時に起きているため。以前のこの拡張は語ごとに「塗った／塗ってない」を切り替えていたので、
// 語の変わり目で先端が飛び、速さもまちまちだった。ここでは YTM-Immersion（lyrics-ui.js）と同じく
//   - 行の先頭から何 px 進んだか（--sweep）を行に1本だけ持ち、各語は自分の開始位置（--wx）を引いて描く
//   - 節目（文字ごとの時刻と横位置）は必ず通し、間は単調な3次曲線で結ぶ（Fritsch-Carlson）
//   - 時計は video.currentTime を実経過時間で補間して均す（段差のない時刻）
//   - 伸ばした音の膨らみは Web Animations（合成側）、光は --wg
// で描く。折り返した行は、2行目以降を1行目の右へ続けた座標として扱う。
//
// 時刻の出どころは次の順:
//   1) 取得元の語の時刻（LRCHub / Apple / NetEase yrc / KuGou / AMLL）
//   2) 自動生成字幕との文字単位の突き合わせで得た文字ごとの時刻（core/align.js）
//   3) どちらも無ければ、行の表示時間を文字数で割った近似
// content.js の後に読み込む。

const YTI_WORD_FEATHER_EM = 0.3;       // 塗りの境目のぼかし半幅（全角1字より狭く）
const YTI_WORD_LIFT_EM = 0.05;
const YTI_WORD_LIFT_MIN_SEC = 1.0;
const YTI_WORD_EMPHASIS_PREROLL_SEC = 0.4;
const YTI_WORD_EMPHASIS_STRETCH = 1.4;
const YTI_WORD_DEFAULT_SEC = 0.4;
const YTI_SWEEP_STEP = 32;
const YTI_WG_STEP = 512;

const ytiSmoothstepBell = (x) => (x <= 0 || x >= 1 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * x));
const ytiEmphasisCurve = (dur, scale) => {
  const x = dur / scale;
  return x > 1 ? Math.sqrt(x) : Math.pow(x, 1.8);
};
const ytiEmphasisScale = (dur) => Math.min(1.2, ytiEmphasisCurve(dur, 1.8) * 0.7);
const ytiEmphasisGlow = (dur) => Math.min(0.7, ytiEmphasisCurve(dur, 2.4) * 0.45);

// ── 時計：currentTime を実経過時間で補間して均す（YTM-Immersion の readSmoothPlaybackTime） ──
const ytiClock = { rawTime: -1, rawAt: 0, outTime: -1, outAt: 0 };
function ytiSmoothTime(v) {
  const raw = v.currentTime;
  if (!Number.isFinite(raw)) return raw;
  const now = performance.now();
  const rate = (Number.isFinite(v.playbackRate) && v.playbackRate > 0) ? v.playbackRate : 1;
  if (v.paused) {
    ytiClock.outTime = -1;
    return raw;
  }
  if (raw !== ytiClock.rawTime) {
    ytiClock.rawTime = raw;
    ytiClock.rawAt = now;
  }
  const target = raw + Math.min((now - ytiClock.rawAt) / 1000 * rate, 0.2);
  if (ytiClock.outTime < 0 || Math.abs(target - ytiClock.outTime) > 0.35) {
    ytiClock.outTime = target;
    ytiClock.outAt = now;
    return target;
  }
  const predicted = ytiClock.outTime + (now - ytiClock.outAt) / 1000 * rate;
  let out = predicted + (target - predicted) * 0.12;
  if (out > target + 0.08) out = target + 0.08;
  if (out < target - 0.15) out = target - 0.15;
  ytiClock.outTime = out;
  ytiClock.outAt = now;
  return out;
}

// ── 語の組み立て ──────────────────────────────────────────
const YTI_CJK_RE = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿＀-ﾟ￠-￦가-힯]/;
const YTI_HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
// 拗音・促音・長音・句読点・閉じ括弧は前の字にぶら下げる（単独では1拍にならない・行頭に来ない）
const YTI_TAIL_RE = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮーｰ゛゜々〆、。，．！？!?)）」』】〕》〉”’,.;:\]}…]/;
const ytiIsSpace = (c) => c === ' ' || c === ' ' || c === '\t' || c === '　';
const ytiCompactText = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');
let ytiWordSegmenter;
try {
  ytiWordSegmenter = new Intl.Segmenter('ja', { granularity: 'word' });
} catch (e) {
  ytiWordSegmenter = null;
}

// 行の終わり（動画の時計）
function ytiLineEnd(line, nextLine) {
  let end = Number.isFinite(line.duration) ? line.time + line.duration : (nextLine ? nextLine.time : line.time + 5);
  if (nextLine) end = Math.min(end, nextLine.time);
  return Math.min(end, line.time + 12);
}

// 「1字＋開始秒」の並びにする。取得元の語の塊（"Maybe "）は次の時刻までを字数で割る。
function ytiFlattenGlyphs(words, lineEnd) {
  const flat = [];
  for (let i = 0; i < words.length; i++) {
    const raw = String(words[i].c ?? '');
    if (!raw) continue;
    const start = Number.isFinite(words[i].t) ? words[i].t : null;
    let next = null;
    for (let j = i + 1; j < words.length; j++) {
      if (Number.isFinite(words[j].t)) {
        next = words[j].t;
        break;
      }
    }
    if (next === null) next = Number.isFinite(words[i].end) ? words[i].end : (Number.isFinite(lineEnd) ? lineEnd : (start === null ? null : start + YTI_WORD_DEFAULT_SEC));
    const glyphs = Array.from(raw);
    const step = (start !== null && next !== null && next > start) ? (next - start) / glyphs.length : 0;
    glyphs.forEach((g, k) => flat.push({ c: g, t: start === null ? null : start + step * k }));
  }
  return flat;
}

// 語（単位）にまとめる。空白は語に入れず、語と語の間のテキストとして置く。
function ytiBuildUnits(flat, lineEnd) {
  // 日本語の同期データには文字ごとに空白を挟んだものがある。CJK に挟まれた空白が過半なら書式とみなして捨てる
  const fmtSpace = new Array(flat.length).fill(false);
  let spaces = 0;
  let between = 0;
  for (let i = 0; i < flat.length; i++) {
    if (!ytiIsSpace(flat[i].c)) continue;
    spaces++;
    const p = flat[i - 1];
    const n = flat[i + 1];
    if (p && n && YTI_CJK_RE.test(p.c) && YTI_CJK_RE.test(n.c) && !YTI_HANGUL_RE.test(p.c) && !YTI_HANGUL_RE.test(n.c)) {
      fmtSpace[i] = true;
      between++;
    }
  }
  if (!spaces || between / spaces <= 0.5) fmtSpace.fill(false);
  const boundaries = new Set();
  if (ytiWordSegmenter && flat.length) {
    try {
      let text = '';
      const at = new Map();
      for (let i = 0; i < flat.length; i++) {
        if (fmtSpace[i]) continue;
        at.set(text.length, i);
        text += flat[i].c;
      }
      for (const seg of ytiWordSegmenter.segment(text)) {
        const idx = at.get(seg.index);
        if (idx !== undefined) boundaries.add(idx);
      }
    } catch (e) {}
  }
  const useSeg = boundaries.size > 0;
  const units = [];
  let cur = null;
  let curCjk = false;
  flat.forEach((g, i) => {
    if (ytiIsSpace(g.c)) {
      if (fmtSpace[i]) return;
      const last = units[units.length - 1];
      if (last && last.type === 'space') last.text += g.c;
      else units.push({ type: 'space', text: g.c });
      cur = null;
      return;
    }
    const tail = YTI_TAIL_RE.test(g.c);
    let fresh;
    if (useSeg) fresh = !cur || (!tail && boundaries.has(i));
    else {
      const cjk = YTI_CJK_RE.test(g.c);
      fresh = !cur || (!tail && (cjk || curCjk));
      if (fresh) curCjk = cjk;
    }
    if (fresh) {
      cur = { type: 'word', text: '', times: [], offsets: [], endIndex: i };
      units.push(cur);
    }
    cur.offsets.push(cur.text.length);
    cur.text += g.c;
    cur.times.push(g.t);
    cur.endIndex = i;
  });
  // 語の終わり＝その語の最後の字の次の字の時刻（書式の空白は飛ばす）
  for (const u of units) {
    if (u.type !== 'word') continue;
    let end = null;
    for (let i = u.endIndex + 1; i < flat.length; i++) {
      if (fmtSpace[i]) continue;
      if (flat[i].t !== null) {
        end = flat[i].t;
        break;
      }
    }
    const start = u.times.find(t => t !== null) ?? null;
    if (end === null) end = Number.isFinite(lineEnd) ? lineEnd : null;
    u.start = start;
    u.end = (end !== null && start !== null && end > start) ? end : (start === null ? null : start + YTI_WORD_DEFAULT_SEC);
  }
  return units;
}

// 表示する文字列に対する「字＋時刻」の並び。表示と一致しない時刻は使わない。
function ytiGlyphTimes(line, text, nextLine) {
  const end = ytiLineEnd(line, nextLine);
  if (Array.isArray(line.words) && line.words.length > 1 &&
      ytiCompactText(line.words.map(w => w.c).join('')) === ytiCompactText(text)) {
    return { words: line.words, end, kind: 'words' };
  }
  const chars = Array.from(text);
  if (Array.isArray(line.charTimes) && line.charTimes.length === chars.length) {
    return { words: chars.map((c, i) => ({ c, t: line.charTimes[i] })), end, kind: 'asr' };
  }
  // 近似：行の表示時間（の 9 割）を、空白を除いた字数で割る
  const n = chars.filter(c => !ytiIsSpace(c)).length || 1;
  const span = Math.max(0.5, end - line.time) * 0.9;
  let k = 0;
  return {
    words: chars.map(c => {
      const t = line.time + span * (k / n);
      if (!ytiIsSpace(c)) k++;
      return { c, t };
    }),
    end: line.time + span,
    kind: 'approx',
  };
}

// target に語の span を並べ、行（塗りの単位）を返す
function ytiBuildWordRow(target, words, end) {
  const units = ytiBuildUnits(ytiFlattenGlyphs(words, end), end);
  target.textContent = '';
  const spans = [];
  for (const u of units) {
    if (u.type === 'space') {
      target.appendChild(document.createTextNode(u.text));
      continue;
    }
    if (!u.text) continue;
    const s = document.createElement('span');
    s.className = 'yti-w';
    s.textContent = u.text;
    s._times = u.times;
    s._offsets = u.offsets;
    s._start = u.start;
    s._end = u.end;
    if (YTI_HANGUL_RE.test(u.text)) ytiKoreanRuby.decorate(s);
    target.appendChild(s);
    spans.push(s);
  }
  target.classList.add('yti-wsync');
  return { el: target, spans, ready: false };
}

// renderLyricsDOM から呼ばれる。語に分けたら true。
function ytiTokenizeLine(line, span, text, nextLine) {
  if (!getMvOption('mv_karaoke', true) || line.isInstrumental || !text || !text.trim()) return false;
  const g = ytiGlyphTimes(line, text, nextLine);
  if (!g || !g.words.length) return false;
  const row = ytiBuildWordRow(span, g.words, g.end);
  if (!row.spans.length) return false;
  line.wordRow = row;
  line.tokenKind = g.kind;
  // 互換：他のモジュール（ふりがな）が語の一覧として使う
  line.tokens = row.spans.map(s => ({ el: s, t: s._start, end: s._end }));
  return true;
}

// ハモリ（背景の声）。本編の下に小さく出し、自分の時刻で同じように塗る。
function ytiRenderBackgroundVocal(line, container) {
  const bgSpan = document.createElement('span');
  bgSpan.className = 'lyric-line-bg';
  bgSpan.textContent = line.bg.text;
  container.appendChild(bgSpan);
  if (getMvOption('mv_karaoke', true) && Array.isArray(line.bg.words) && line.bg.words.length > 1 &&
      ytiCompactText(line.bg.words.map(w => w.c).join('')) === ytiCompactText(line.bg.text)) {
    const end = Number.isFinite(line.bg.end) ? line.bg.end : line.bg.words[line.bg.words.length - 1].t + 0.6;
    line.bgRow = ytiBuildWordRow(bgSpan, line.bg.words, end);
  }
}

// ── 計測：行ぜんたいの「時刻 → 進んだ px」表 ─────────────────────
function ytiMonotoneTangents(ts, xs) {
  const n = ts.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = ts[i + 1] - ts[i];
    d[i] = h[i] > 0 ? (xs[i + 1] - xs[i]) / h[i] : 0;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0)) continue;
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return m;
}

function ytiMeasureRow(row) {
  const el = row.el;
  if (!el.offsetWidth && !el.offsetHeight) return;
  row.ready = true;
  try {
    // 1. 語を表示上の行ごとにまとめる（折り返した2行目以降は1行目の右へ続ける）
    const byTop = new Map();
    for (const s of row.spans) {
      const top = s.offsetTop;
      let b = byTop.get(top);
      if (!b) byTop.set(top, (b = { right: 0 }));
      b.right = Math.max(b.right, s.offsetLeft + s.offsetWidth);
    }
    let carry = 0;
    for (const top of [...byTop.keys()].sort((a, b) => a - b)) {
      byTop.get(top).origin = carry;
      carry += byTop.get(top).right;
    }
    // 2. 語の開始位置と、語の中の字の位置（Range で測る）
    const times = [];
    const xs = [];
    const range = document.createRange();
    for (const s of row.spans) {
      const wx = (byTop.get(s.offsetTop) || { origin: 0 }).origin + s.offsetLeft;
      const w = s.offsetWidth;
      s.style.setProperty('--wx', wx.toFixed(1));
      let fr = null;
      const node = s.firstChild;
      if (node && node.nodeType === 3 && s._offsets.length > 1) {
        const len = node.data.length;
        const raw = s._offsets.map(o => {
          range.setStart(node, 0);
          range.setEnd(node, Math.min(o, len));
          return range.getBoundingClientRect().width;
        });
        range.setStart(node, 0);
        range.setEnd(node, len);
        const all = range.getBoundingClientRect().width;
        if (all > 0) fr = raw.map(x => x / all);
      }
      s._times.forEach((t, i) => {
        if (t === null) return;
        times.push(t);
        xs.push(wx + w * (fr ? (fr[i] ?? i / s._times.length) : i / s._times.length));
      });
      if (Number.isFinite(s._end)) {
        times.push(s._end);
        xs.push(wx + w);
      }
    }
    // 3. 時刻で並べて単調に
    const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b] || xs[a] - xs[b]);
    const st = [];
    const sx = [];
    for (const i of order) {
      if (st.length && times[i] <= st[st.length - 1]) {
        sx[sx.length - 1] = Math.max(sx[sx.length - 1], xs[i]);
        continue;
      }
      st.push(times[i]);
      sx.push(Math.max(xs[i], sx.length ? sx[sx.length - 1] : 0));
    }
    row.t = st;
    row.x = sx;
    row.m = ytiMonotoneTangents(st, sx);
    row.end = carry;
    row.idx = 0;
    const fontPx = parseFloat(getComputedStyle(el).fontSize) || 32;
    el.style.setProperty('--feather', (YTI_WORD_FEATHER_EM * fontPx).toFixed(1));
    // 4. 伸ばした音だけ膨らませて光らせる（長さで強さが決まる）
    for (const s of row.spans) {
      const dur = (Number.isFinite(s._end) && Number.isFinite(s._start) && s._end > s._start) ? s._end - s._start : YTI_WORD_DEFAULT_SEC;
      const amp = ytiEmphasisScale(dur);
      const glow = ytiEmphasisGlow(dur);
      s._emp = amp > 0.05 || glow > 0.05;
      s._empStart = s._start - YTI_WORD_EMPHASIS_PREROLL_SEC;
      s._empDur = Math.max(YTI_WORD_LIFT_MIN_SEC, dur) * YTI_WORD_EMPHASIS_STRETCH;
      s._amp = amp;
      if (s._emp) {
        s.style.setProperty('--wglowa', glow.toFixed(3));
        s.style.setProperty('--wglowr', Math.min(0.3, glow * 0.3).toFixed(3));
      }
    }
  } catch (e) {
    row.t = null;
  }
}

// 時刻 → 行の先頭から進んだ px（節目を必ず通る3次エルミート）
function ytiSweepAt(row, t) {
  const st = row.t;
  const sx = row.x;
  if (!st || !st.length) return 0;
  if (t <= st[0]) return 0;
  if (t >= st[st.length - 1]) return row.end || sx[sx.length - 1];
  let i = row.idx || 0;
  if (i >= st.length - 1) i = st.length - 2;
  if (t < st[i]) i = 0;
  while (i + 1 < st.length - 1 && t >= st[i + 1]) i++;
  row.idx = i;
  const t0 = st[i];
  const t1 = st[i + 1];
  const x0 = sx[i];
  const x1 = sx[i + 1];
  if (!(t1 > t0)) return x1;
  const h = t1 - t0;
  const u = (t - t0) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  const m = row.m;
  return (2 * u3 - 3 * u2 + 1) * x0 + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * x1 + (u3 - u2) * h * m[i + 1];
}

// ── 伸ばした音の膨らみ（Web Animations。縦位置の整数丸めでカクつかないよう合成側で動かす） ──
const ytiMotionRows = new Set();
function ytiCreateMotion(row) {
  row.motionReady = true;
  const origin = row.spans.map(s => s._start).find(v => Number.isFinite(v));
  if (!Number.isFinite(origin) || typeof row.spans[0].animate !== 'function') return;
  row.origin = origin;
  const anims = [];
  for (const s of row.spans) {
    if (!s._emp || !Number.isFinite(s._start)) continue;
    const count = Math.max(8, Math.min(40, Math.round(s._empDur * 1000 / 40)));
    const frames = [];
    for (let i = 0; i <= count; i++) {
      const env = ytiSmoothstepBell(i / count);
      frames.push({ offset: i / count, transform: `translateY(${(-YTI_WORD_LIFT_EM * env).toFixed(4)}em) scale(${(1 + env * s._amp * 0.085).toFixed(4)})` });
    }
    try {
      const a = s.animate(frames, { duration: s._empDur * 1000, delay: (s._empStart - origin) * 1000, fill: 'both', easing: 'linear' });
      a.pause();
      anims.push(a);
    } catch (e) {}
  }
  row.motions = anims;
  if (anims.length) ytiMotionRows.add(row);
}
function ytiSyncMotion(row, t, rate) {
  const ms = row.motions;
  if (!ms || !ms.length) return;
  const local = (t - row.origin) * 1000;
  const now = performance.now();
  if (local < 0) {
    for (const a of ms) {
      try {
        if (a.playState !== 'paused') a.pause();
        a.currentTime = local;
      } catch (e) {}
    }
    row.syncedAt = undefined;
    return;
  }
  if (row.syncedAt !== undefined) {
    const predicted = row.syncedLocal + (now - row.syncedAt) * rate;
    if (Math.abs(predicted - local) <= 80) return;
  }
  for (const a of ms) {
    try {
      a.currentTime = local;
      if (a.playbackRate !== rate) a.playbackRate = rate;
      a.play();
    } catch (e) {}
  }
  row.syncedLocal = local;
  row.syncedAt = now;
}
function ytiStopMotion(row) {
  if (!row || !row.motions) return;
  row.syncedAt = undefined;
  for (const a of row.motions) {
    try {
      a.pause();
      a.currentTime = 0;
    } catch (e) {}
  }
}
function ytiPauseAllMotion() {
  for (const row of ytiMotionRows) {
    if (!row.el.isConnected) {
      ytiMotionRows.delete(row);
      continue;
    }
    row.syncedAt = undefined;
    for (const a of row.motions || []) {
      try {
        if (a.playState === 'running') a.pause();
      } catch (e) {}
    }
  }
}
// 一時停止・シーク中に膨らみだけが動き続けないように
document.addEventListener('pause', (e) => {
  if (e.target && e.target.tagName === 'VIDEO') ytiPauseAllMotion();
}, true);

const ytiWriteVar = (el, key, cacheKey, value, step) => {
  const q = Math.round(value * step) / step;
  if (el[cacheKey] === q) return;
  el[cacheKey] = q;
  el.style.setProperty(key, String(q));
};

function ytiPaintRow(row, t, rate) {
  if (!row || !row.spans.length) return;
  if (!row.ready) ytiMeasureRow(row);
  if (!row.ready || !row.t) return;
  if (!row.motionReady) ytiCreateMotion(row);
  ytiSyncMotion(row, t, rate);
  ytiWriteVar(row.el, '--sweep', '_sweep', ytiSweepAt(row, t), YTI_SWEEP_STEP);
  for (const s of row.spans) {
    if (!s._emp || !Number.isFinite(s._start)) continue;
    ytiWriteVar(s, '--wg', '_wg', ytiSmoothstepBell((t - s._empStart) / s._empDur), YTI_WG_STEP);
  }
}

// 毎フレーム（content.js の updateKaraokeFill から、今の行について）
let ytiLastPaintedLine = null;
function ytiFillTokens(line) {
  const v = targetVideo;
  if (!v) return;
  const t = ytiSmoothTime(v);
  const rate = (Number.isFinite(v.playbackRate) && v.playbackRate > 0) ? v.playbackRate : 1;
  if (ytiLastPaintedLine && ytiLastPaintedLine !== line) {
    ytiStopMotion(ytiLastPaintedLine.wordRow);
    ytiStopMotion(ytiLastPaintedLine.bgRow);
  }
  ytiLastPaintedLine = line;
  ytiPaintRow(line.wordRow, t, rate);
  if (line.bgRow) ytiPaintRow(line.bgRow, t, rate);
}

// 窓の大きさ・UI の大きさが変わると語の横位置が動くので測り直す
let ytiRemeasureTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(ytiRemeasureTimer);
  ytiRemeasureTimer = setTimeout(() => {
    for (const l of (typeof lyricsData !== 'undefined' ? lyricsData : [])) {
      if (l.wordRow) l.wordRow.ready = false;
      if (l.bgRow) l.bgRow.ready = false;
    }
  }, 200);
});
