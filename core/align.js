// ===== 共通コア：歌詞と自動生成字幕（ASR）の文字単位の突き合わせ =====
// ASR は誤字だらけだが、語の時刻は実際の音声から取られていて正確。
// 歌詞（正しい文字）と ASR（正しい時刻）を文字の並びで突き合わせると、
//   1) 合否：この歌詞は本当にこの動画で歌われているか（一致率）
//   2) 時計：曲の時計 → 動画の時計 の対応点（段差・速度・切られた区間）
//   3) 塗り：歌詞の1文字ごとの、動画での時刻（カラオケの語単位の塗り）
// が一度に得られる。以前は字幕の区間（数語のまとまり）単位で行の頭だけを合わせていたので、
// 行の中の時刻・速度の違い・切られた区間は表せなかった。
// 読み込むと globalThis.YTICore.align に入る。text.js を先に読むこと。

(function (root) {
  const YTICore = root.YTICore = root.YTICore || {};
  const norm = (s) => YTICore.text.normalizeForMatch(s);

  // 曲の時計と動画の時計の差として許す範囲（秒）。MV のイントロ映像は数十秒〜1分半、
  // 短縮版・速度違いでは動画の方が先に進むこともある。
  const MAX_LEAD = 60;
  const MAX_LAG = 420;
  // 単発の一致（「の」「に」のような頻出かな）は偶然でも起きるので、連続2文字以上だけ採る
  const MIN_RUN = 2;

  // 歌詞の文字列。各文字に、行番号・元の文字位置・曲の時計での時刻（行内は語の時刻か線形）を持たせる。
  function lyricChars(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l || !l.text) continue;
      const text = String(l.text);
      const chars = Array.from(text);
      const next = lines[i + 1];
      const end = Number.isFinite(l.end) ? l.end : (next ? Math.min(next.start, l.start + 8) : l.start + 4);
      const span = Math.max(0.3, end - l.start);
      // 語の時刻があれば、その語の文字はその時刻から始める
      let wordTimes = null;
      if (Array.isArray(l.words) && l.words.length) {
        wordTimes = [];
        for (const w of l.words) for (let k = 0; k < Array.from(w.c).length; k++) wordTimes.push(w.t);
      }
      for (let k = 0; k < chars.length; k++) {
        const n = norm(chars[k]);
        if (!n) continue;
        const t = (wordTimes && wordTimes[k] !== undefined) ? wordTimes[k] : l.start + span * (k / chars.length);
        for (const ch of Array.from(n)) out.push({ ch, line: i, pos: k, t });
      }
    }
    return out;
  }

  // ASR の文字列。各文字に動画の時刻（語の頭から次の語の頭までを文字数で割る）。
  function asrChars(words) {
    const out = [];
    for (let j = 0; j < words.length; j++) {
      const w = words[j];
      const n = Array.from(norm(w.text));
      if (!n.length) continue;
      const nextT = words[j + 1] ? words[j + 1].time : w.time + 0.5;
      const span = Math.max(0.05, Math.min(nextT - w.time, 1.5));
      n.forEach((ch, k) => out.push({ ch, t: w.time + span * (k / n.length), word: j }));
    }
    return out;
  }

  // 時刻の窓つきの最長共通部分列。方向だけを N×M で持ち、点数は2行で回す。
  function lcsAlign(L, A) {
    const N = L.length;
    const M = A.length;
    if (!N || !M) return [];
    const W = M + 1;
    const dir = new Uint8Array((N + 1) * W); // 1:上(Lを飛ばす) 2:左(Aを飛ばす) 3:斜め(一致)
    let prev = new Int32Array(W);
    let cur = new Int32Array(W);
    for (let i = 1; i <= N; i++) {
      const li = L[i - 1];
      cur[0] = 0;
      for (let j = 1; j <= M; j++) {
        const aj = A[j - 1];
        let best = prev[j];
        let how = 1;
        if (cur[j - 1] > best) {
          best = cur[j - 1];
          how = 2;
        }
        if (li.ch === aj.ch) {
          const d = aj.t - li.t;
          if (d >= -MAX_LEAD && d <= MAX_LAG && prev[j - 1] + 1 > best) {
            best = prev[j - 1] + 1;
            how = 3;
          }
        }
        cur[j] = best;
        dir[i * W + j] = how;
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    const pairs = [];
    let i = N;
    let j = M;
    while (i > 0 && j > 0) {
      const how = dir[i * W + j];
      if (how === 3) {
        pairs.push([i - 1, j - 1]);
        i--;
        j--;
      } else if (how === 2) j--;
      else i--;
    }
    pairs.reverse();
    return pairs;
  }

  // 連続して一致している所だけ残す（両側で隣り合っている一致の連なり）
  function keepRuns(pairs) {
    const keep = [];
    let run = [];
    const flush = () => {
      if (run.length >= MIN_RUN) keep.push(...run);
      run = [];
    };
    for (const p of pairs) {
      const last = run[run.length - 1];
      if (last && p[0] === last[0] + 1 && p[1] <= last[1] + 2) run.push(p);
      else {
        flush();
        run = [p];
      }
    }
    flush();
    return keep;
  }

  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  // 対応点の並びを「ほぼ同じずれ（＋ゆるい傾き）」の塊に分け、塊ごとに直線を当てる。
  // 塊の境目でずれが増えれば映像パートの挿入、減れば切られた区間。
  function fitPieces(points, opts) {
    const minGroup = (opts && opts.minGroup) || 6;
    const switchAfter = (opts && opts.switchAfter) || 3;
    if (points.length < Math.max(2, minGroup)) return [];
    const groups = [];
    let cur = [];
    let outliers = [];
    for (const p of points) {
      if (!cur.length) {
        cur.push(p);
        continue;
      }
      const m = median(cur.slice(-15).map(q => q.v - q.s));
      if (Math.abs((p.v - p.s) - m) <= 1.2) {
        cur.push(...outliers.filter(q => Math.abs((q.v - q.s) - m) <= 1.2));
        outliers = [];
        cur.push(p);
      } else {
        outliers.push(p);
        // 外れが3つ続いて、しかもそれら同士が揃っていれば新しい塊
        if (outliers.length >= switchAfter) {
          const om = median(outliers.map(q => q.v - q.s));
          if (outliers.every(q => Math.abs((q.v - q.s) - om) <= 1.2)) {
            groups.push(cur);
            cur = outliers;
            outliers = [];
          } else outliers.shift();
        }
      }
    }
    if (cur.length) groups.push(cur);
    const pieces = [];
    for (const g of groups) {
      if (g.length < minGroup) continue;
      // 最小二乗で v = a + b s。傾きは速度の比。誤差の範囲なら 1 に丸める。
      const n = g.length;
      const ms = g.reduce((a, p) => a + p.s, 0) / n;
      const mv = g.reduce((a, p) => a + p.v, 0) / n;
      let sxx = 0;
      let sxy = 0;
      for (const p of g) {
        sxx += (p.s - ms) * (p.s - ms);
        sxy += (p.s - ms) * (p.v - mv);
      }
      let b = sxx > 1 ? sxy / sxx : 1;
      const spanS = g[n - 1].s - g[0].s;
      if (!(spanS > 20) || n < 4 || Math.abs(b - 1) < 0.02) b = 1;
      b = Math.max(0.75, Math.min(1.35, b));
      const a = b === 1 ? median(g.map(p => p.v - p.s)) + 0 : mv - b * ms;
      const s0 = g[0].s;
      pieces.push({ lrcTime: s0, videoTime: b === 1 ? s0 + a : a + b * s0, rate: b, count: n, endS: g[n - 1].s });
    }
    // 直前の塊とずれも傾きもほぼ同じなら1つにまとめる
    const merged = [];
    for (const p of pieces) {
      const q = merged[merged.length - 1];
      if (q && q.rate === p.rate) {
        const qOff = q.videoTime - q.lrcTime + (q.rate - 1) * (p.lrcTime - q.lrcTime);
        const pOff = p.videoTime - p.lrcTime;
        if (Math.abs(qOff - pOff) < 0.6) {
          q.count += p.count;
          q.endS = p.endS;
          continue;
        }
      }
      merged.push(Object.assign({}, p));
    }
    return merged;
  }

  // lines: 曲の時計の行 [{start, end?, text, words?}]、words: ASR の語 [{time, text}]
  function alignLyricsToAsr(lines, words) {
    const L = lyricChars(lines || []);
    const A = asrChars(words || []);
    const result = { coverage: 0, lyricChars: L.length, asrChars: A.length, anchors: [], charTimes: [], matchedLines: 0 };
    if (L.length < 8 || A.length < 8) return result;
    const pairs = keepRuns(lcsAlign(L, A));
    result.coverage = pairs.length / L.length;
    const points = pairs.map(([i, j]) => ({ s: L[i].t, v: A[j].t, line: L[i].line, pos: L[i].pos }));
    // 行ごとの文字の時刻（動画の時計）。一致した文字の間は線形に埋める。
    const linePoints = [];
    const byLine = new Map();
    for (const p of points) {
      if (!byLine.has(p.line)) byLine.set(p.line, []);
      byLine.get(p.line).push(p);
    }
    for (const [li, ps] of byLine) {
      if (ps.length < 2) continue;
      const text = Array.from(String(lines[li].text));
      const known = new Map();
      for (const p of ps) if (!known.has(p.pos)) known.set(p.pos, p.v);
      const ks = [...known.keys()].sort((a, b) => a - b);
      // 時刻が巻き戻る一致（別の箇所との偶然の一致）は落とす
      const clean = [];
      for (const k of ks) {
        if (clean.length && known.get(k) < known.get(clean[clean.length - 1])) continue;
        clean.push(k);
      }
      if (clean.length < 2) continue;
      const times = new Array(text.length);
      const first = clean[0];
      const last = clean[clean.length - 1];
      const rate = (known.get(last) - known.get(first)) / Math.max(1, last - first);
      for (let k = 0; k < text.length; k++) {
        if (k <= first) times[k] = known.get(first) - (first - k) * rate;
        else if (k >= last) times[k] = known.get(last) + (k - last) * rate;
        else {
          let lo = first;
          let hi = last;
          for (const c of clean) {
            if (c <= k) lo = c;
            if (c >= k) {
              hi = c;
              break;
            }
          }
          times[k] = lo === hi ? known.get(lo) : known.get(lo) + (known.get(hi) - known.get(lo)) * ((k - lo) / (hi - lo));
        }
      }
      result.charTimes[li] = times;
      result.matchedLines++;
      // 行の頭が動画のどこで歌われたか。一致した最初の文字が行頭に近い時だけ使う
      // （行の途中からの外挿は、行の時刻しか持たない歌詞では誤差が大きい）。
      if (first <= 3) linePoints.push({ s: lines[li].start, v: times[0], line: li });
    }
    linePoints.sort((a, b) => a.s - b.s);
    result.anchors = fitPieces(linePoints, { minGroup: 2, switchAfter: 2 })
      .map(p => ({ lrcTime: p.lrcTime, videoTime: p.videoTime, rate: p.rate, src: 'asr' }));
    return result;
  }

  // ASR に中身があるか（[音楽] だけ・数語だけの字幕は判定に使えない）
  function asrHasSubstance(words) {
    const n = (words || []).reduce((a, w) => a + norm(w.text).length, 0);
    return n >= 40;
  }

  YTICore.align = { alignLyricsToAsr, asrHasSubstance, fitPieces };
  if (typeof module === 'object' && module.exports) module.exports = YTICore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
