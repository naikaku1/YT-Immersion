// ===== 共通コア：曲の時計 → 動画の時計 の写し（タイムワープ） =====
// 外部歌詞は「曲（音源）」の時計で付いている。MV はその前後や途中に映像パートが挟まり、
// 短縮版では一部が切られ、速度違いの動画では伸び縮みする。ここではそれを
//   1) 土台：YouTube Music が持っている曲⇔動画の対応表（segmentMap）。区間の外は「切られた所」
//   2) 補正：対応点（手で合わせた・字幕照合・音声推定）による段差と傾き
// の2段で表し、歌詞の各行・各語の時刻を動画の時計へ写す。
// 写した結果、後ろの行より後に来てしまう行は「動画では切られた区間の行」として隠す
// （以前は 10ms 間隔に押し込んでいたため、カットされた2番がサビの前に詰まって流れた）。
// 読み込むと globalThis.YTICore.warp に入る。

(function (root) {
  const YTICore = root.YTICore = root.YTICore || {};

  // segmentMap の区間（秒）。songStart から dur 秒が、動画の videoStart からに当たる。
  // 区間の端に少しだけ余裕を持たせる（区間の直前に歌い出す行を切らないように）。
  const EDGE_TOLERANCE = 0.6;

  function normalizeSegments(segments) {
    return (Array.isArray(segments) ? segments : [])
      .map(s => ({ songStart: Number(s.songStart), videoStart: Number(s.videoStart), dur: Number(s.dur) }))
      .filter(s => Number.isFinite(s.songStart) && Number.isFinite(s.videoStart) && s.dur > 0)
      .sort((a, b) => a.songStart - b.songStart);
  }

  // YouTube Music の segmentMap.segment[]（ミリ秒の文字列）から。primary が今見ている動画。
  function segmentsFromSegmentMap(segmentMap) {
    const segs = (segmentMap && segmentMap.segment) || [];
    return normalizeSegments(segs.map(s => ({
      songStart: Number(s.counterpartVideoStartTimeMilliseconds) / 1000,
      videoStart: Number(s.primaryVideoStartTimeMilliseconds) / 1000,
      dur: Number(s.durationMilliseconds) / 1000,
    })));
  }

  // 土台の写し。区間が無ければ恒等写像（切られた所なし）。
  function baseMap(segs, t) {
    if (!segs.length) return { time: t, cut: false };
    for (const s of segs) {
      if (t >= s.songStart - EDGE_TOLERANCE && t < s.songStart + s.dur + EDGE_TOLERANCE) {
        return { time: s.videoStart + (t - s.songStart), cut: false };
      }
    }
    // 区間の外：近い方の区間からの外挿で時刻だけは返す（隠す判定は cut で）
    let nearest = segs[0];
    let best = Infinity;
    for (const s of segs) {
      const d = t < s.songStart ? s.songStart - t : t - (s.songStart + s.dur);
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    return { time: nearest.videoStart + (t - nearest.songStart), cut: true };
  }

  // anchors: [{lrcTime, videoTime, rate?, src}]（lrcTime 昇順）。曲の時計 lrcTime が
  // 動画の videoTime に当たる。次の対応点まではその段差（と傾き rate）を保つ。
  // 最初の対応点より前の行にも先頭の段差を当てる（＝イントロ分）。
  function buildWarp(opts) {
    const segs = normalizeSegments(opts && opts.segments);
    const anchors = ((opts && opts.anchors) || [])
      .filter(a => a && Number.isFinite(a.lrcTime) && Number.isFinite(a.videoTime))
      .slice().sort((a, b) => a.lrcTime - b.lrcTime);
    const corr = anchors.map(a => {
      const b = baseMap(segs, a.lrcTime);
      return {
        lrcTime: a.lrcTime,
        delta: a.videoTime - b.time,
        rate: Number.isFinite(a.rate) && a.rate > 0 ? a.rate : 1,
      };
    });
    const pieceAt = (t) => {
      if (!corr.length) return null;
      let p = corr[0];
      for (const c of corr) {
        if (c.lrcTime <= t + 0.001) p = c;
        else break;
      }
      return p;
    };
    const map = (t) => {
      const b = baseMap(segs, t);
      const p = pieceAt(t);
      if (!p) return { time: b.time, cut: b.cut, rate: 1 };
      return { time: b.time + p.delta + (p.rate - 1) * (t - p.lrcTime), cut: b.cut, rate: p.rate };
    };
    // 動画の時刻 → 曲の時刻（応援法・パートのタグ付けなど、見ながら打つ時に使う）
    const inverse = (v) => {
      let s = v;
      for (let i = 0; i < 6; i++) {
        const m = map(s);
        const r = m.rate || 1;
        const next = s + (v - m.time) / r;
        if (Math.abs(next - s) < 0.002) return next;
        s = next;
      }
      return s;
    };
    return { map, inverse, segments: segs, anchors: corr, isIdentity: !segs.length && !corr.length };
  }

  // 行（曲の時計）を動画の時計へ写す。戻り値の各行は time（動画の時刻）と hidden を持つ。
  // 語も同じ行の段差・傾きで写す（1行が2つの区間に割れて塗りが飛ばないように）。
  function applyToLines(lines, warp) {
    const out = (lines || []).map(l => {
      const m = warp.map(l.start);
      const line = Object.assign({}, l, { time: Math.max(0, m.time), baseTime: l.start, hidden: !!m.cut });
      const rate = m.rate || 1;
      if (Number.isFinite(l.end)) line.endTime = m.time + (l.end - l.start) * rate;
      if (Array.isArray(l.words)) {
        line.words = l.words.map(w => {
          const o = { t: m.time + (w.t - l.start) * rate, c: w.c };
          if (Number.isFinite(w.end)) o.end = m.time + (w.end - l.start) * rate;
          return o;
        });
      }
      if (l.bg && Array.isArray(l.bg.words)) {
        line.bg = Object.assign({}, l.bg, {
          start: m.time + (l.bg.start - l.start) * rate,
          end: Number.isFinite(l.bg.end) ? m.time + (l.bg.end - l.start) * rate : undefined,
          words: l.bg.words.map(w => ({ t: m.time + (w.t - l.start) * rate, c: w.c })),
        });
      }
      return line;
    });
    // 後ろの行より後に来る行＝動画では切られた区間の行。後ろから見て隠す。
    // 同じ時刻に写った場合も、元が 0.5 秒以上前の行なら切られた側（同時刻の掛け合いの行は残す）。
    let minAfter = Infinity;
    let minAfterBase = Infinity;
    for (let i = out.length - 1; i >= 0; i--) {
      const l = out[i];
      if (l.hidden) continue;
      if (l.time > minAfter + 0.05 || (l.time >= minAfter - 0.01 && l.baseTime < minAfterBase - 0.5)) {
        l.hidden = true;
      } else if (l.time < minAfter) {
        minAfter = l.time;
        minAfterBase = l.baseTime;
      }
    }
    return out;
  }

  YTICore.warp = { buildWarp, applyToLines, segmentsFromSegmentMap, normalizeSegments };
  if (typeof module === 'object' && module.exports) module.exports = YTICore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
