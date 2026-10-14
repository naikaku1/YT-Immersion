// ===== 共通コア：歌詞データの読み取り =====
// 取得元ごとの形式（LRC / 拡張LRC / NetEase yrc / Lyricify lys / Apple TTML / KuGou krc /
// LyricsPlus JSON / YouTube Music の時刻付き歌詞 / YouTube 字幕 json3）を、
// 1つの形（LyricDoc の行配列）にそろえる。時刻はすべて秒。
//
//   line = { start, end?, text, words?: [{ t, end?, c }], bg?: { start, end?, text, words }, singer? }
//
// words は「語（音節）」の並び。c は1文字とは限らない（英語は語、日本語は文字か文節）。
// 行の時刻だけで語の時刻を持たない取得元は words を付けない（描画側が行から作る）。
// 読み込むと globalThis.YTICore.parsers に入る。text.js を先に読むこと。

(function (root) {
  const YTICore = root.YTICore = root.YTICore || {};
  const T = () => YTICore.text;

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ms = (v) => {
    const n = num(v);
    return n === null ? null : n / 1000;
  };

  const pushWord = (words, t, text) => {
    const c = String(text ?? '');
    if (!c || t === null || t === undefined) return;
    words.push({ t, c });
  };

  // ── LRC（拡張LRCの語タグ <mm:ss.xx> にも対応） ───────────────
  const LRC_TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  const lrcSec = (m, s, f) => {
    let frac = f || '0';
    if (frac.length === 1) frac += '00';
    else if (frac.length === 2) frac += '0';
    return Number(m) * 60 + Number(s) + Number(frac.slice(0, 3)) / 1000;
  };

  // 本文が空の行（間奏で表示を消す行）は keepEmpty の時だけ残す
  function parseLrc(text, opts) {
    const keepEmpty = !!(opts && opts.keepEmpty);
    const out = [];
    for (const raw of String(text || '').split(/\r\n|\n|\r/)) {
      let rest = raw;
      const times = [];
      for (;;) {
        const m = rest.match(LRC_TAG);
        if (!m) break;
        times.push(lrcSec(m[1], m[2], m[3]));
        rest = rest.slice(m[0].length);
      }
      if (!times.length) continue;
      // 語タグがあれば語ごとの時刻を拾う。タグとタグの間が1語。
      let words = null;
      let body = rest;
      WORD_TAG.lastIndex = 0;
      if (WORD_TAG.test(rest)) {
        words = [];
        WORD_TAG.lastIndex = 0;
        let m;
        let from = 0;
        let curT = null;
        while ((m = WORD_TAG.exec(rest))) {
          if (curT !== null) pushWord(words, curT, rest.slice(from, m.index));
          curT = lrcSec(m[1], m[2], m[3]);
          from = m.index + m[0].length;
        }
        if (curT !== null) pushWord(words, curT, rest.slice(from));
        body = words.map(w => w.c).join('');
      }
      body = body.trim();
      if (!body && !keepEmpty) continue;
      for (const start of times) {
        const line = { start, text: body };
        // 語の時刻は最初の時刻タグに対するもの。サビの使い回し（同じ行に複数の時刻）では
        // 2つ目以降は行頭からの差で写す。
        if (words && words.length) {
          const shift = start - times[0];
          line.words = words.map(w => ({ t: w.t + shift, c: w.c }));
        }
        out.push(line);
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // ── 「タグ 語 タグ 語」形式（yrc / krc） ───────────────────
  function readTaggedLine(line, tagRe) {
    const words = [];
    let startMs = null;
    let endMs;
    let from = 0;
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(line))) {
      if (startMs !== null) pushWord(words, startMs, line.slice(from, m.index));
      startMs = Number(m[1]);
      const dur = Number(m[2]);
      endMs = (Number.isFinite(startMs) && Number.isFinite(dur) && dur > 0) ? startMs + dur : undefined;
      from = m.index + m[0].length;
    }
    if (startMs !== null) pushWord(words, startMs, line.slice(from));
    return { words, endMs };
  }

  // NetEase yrc: [行開始,行長](語開始,語長,0)語...
  function parseYrc(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('{')) continue;
      const head = line.match(/^\[(\d+),(\d+)\]/);
      if (!head) continue;
      const { words, endMs } = readTaggedLine(line, /\((\d+),(\d+),\d+\)/g);
      if (!words.length) continue;
      out.push({
        start: Number(head[1]) / 1000,
        end: endMs !== undefined ? endMs / 1000 : undefined,
        text: words.map(w => w.c).join(''),
        words: words.map(w => ({ t: w.t / 1000, c: w.c })),
      });
    }
    return out;
  }

  // KuGou krc: [行開始,行長]<行頭からの差,長さ,0>語...
  function parseKrc(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const head = line.match(/^\[(\d+),(\d+)\]/);
      if (!head) continue;
      const lineStart = Number(head[1]);
      const r = readTaggedLine(line, /<(\d+),(\d+),\d+>/g);
      if (!r.words.length) continue;
      out.push({
        start: lineStart / 1000,
        end: r.endMs === undefined ? undefined : (lineStart + r.endMs) / 1000,
        text: r.words.map(w => w.c).join(''),
        words: r.words.map(w => ({ t: (lineStart + w.t) / 1000, c: w.c })),
      });
    }
    return out;
  }

  const KRC_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];
  function decodeKrcBase64(base64) {
    const bin = atob(String(base64 || '').replace(/\s+/g, ''));
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    if (raw.length <= 4) return null;
    const body = raw.subarray(4);
    const out = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) out[i] = body[i] ^ KRC_KEY[i % 16];
    return out;
  }
  async function inflateZlib(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(buf);
  }

  // ── ハモリ（背景の声） ──────────────────────────────────
  function makeBackgroundVocal(words, end) {
    const kept = (words || []).filter(w => w && Number.isFinite(w.t) && String(w.c ?? '').length)
      .map(w => ({ t: w.t, c: String(w.c) }));
    if (!kept.length) return null;
    const first = kept[0];
    const last = kept[kept.length - 1];
    if (/^\s*[(（]/.test(first.c) && /[)）]\s*$/.test(last.c)) {
      first.c = first.c.replace(/^\s*[(（]/, '');
      last.c = last.c.replace(/[)）]\s*$/, '');
    }
    const cleaned = kept.filter(w => w.c.length);
    const text = cleaned.map(w => w.c).join('').trim();
    if (!text) return null;
    const start = Math.min(...cleaned.map(w => w.t));
    const e = Number(end);
    return { start, end: Number.isFinite(e) && e > start ? e : undefined, text, words: cleaned };
  }
  function attachBackgroundVocal(line, bg) {
    if (!line || !bg) return line;
    if (line.bg) {
      const merged = makeBackgroundVocal([...line.bg.words, ...bg.words].sort((a, b) => a.t - b.t),
        Math.max(Number(line.bg.end) || 0, Number(bg.end) || 0) || undefined);
      line.bg = merged || line.bg;
    } else {
      line.bg = bg;
    }
    return line;
  }

  // ── Lyricify lys: [行属性]語(開始ms,長さms) ... 6/7/8 はハモリ ──
  const LYS_BG = new Set([6, 7, 8]);
  function parseLys(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const head = line.match(/^\[(\d+)\]/);
      if (!head) continue;
      const isBg = LYS_BG.has(Number(head[1]));
      const rest = line.slice(head[0].length);
      const words = [];
      const re = /\((\d+),(\d+)\)/g;
      let m;
      let from = 0;
      let endMs;
      while ((m = re.exec(rest))) {
        const word = rest.slice(from, m.index);
        const start = Number(m[1]);
        const dur = Number(m[2]);
        from = m.index + m[0].length;
        if (start === 0 && dur === 0) {
          if (words.length && word) words[words.length - 1].c += word;
          continue;
        }
        pushWord(words, start / 1000, word);
        if (Number.isFinite(start) && Number.isFinite(dur)) endMs = start + dur;
      }
      if (!words.length) continue;
      if (isBg && out.length) {
        attachBackgroundVocal(out[out.length - 1], makeBackgroundVocal(words, endMs / 1000));
        continue;
      }
      out.push({ start: words[0].t, end: endMs !== undefined ? endMs / 1000 : undefined, text: words.map(w => w.c).join(''), words });
    }
    return out;
  }

  // ── Apple TTML ─────────────────────────────────────────
  function parseTtmlTime(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    let m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
    if (m) {
      const h = m[1] ? Number(m[1]) : 0;
      const frac = (m[4] || '0').padEnd(3, '0').slice(0, 3);
      return ((h * 60 + Number(m[2])) * 60 + Number(m[3])) + Number(frac) / 1000;
    }
    m = s.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isFinite(n)) return null;
      return m[2] === 'ms' ? n / 1000 : n;
    }
    return null;
  }
  const decodeXml = (v) => String(v ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  function readTtmlSpans(inner) {
    const words = [];
    let lastEnd = null;
    const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/g;
    let sm;
    let prevEnd = 0;
    while ((sm = spanRe.exec(inner))) {
      const gap = inner.slice(prevEnd, sm.index);
      prevEnd = sm.index + sm[0].length;
      if (/\s/.test(gap.replace(/<[^>]*>/g, '')) && words.length && !/\s$/.test(words[words.length - 1].c)) {
        words[words.length - 1].c += ' ';
      }
      const attrs = sm[1] || '';
      const body = sm[2];
      if (/<span\b/.test(body)) continue;
      const t = parseTtmlTime((attrs.match(/\bbegin="([^"]*)"/) || [])[1]);
      const before = words.length;
      pushWord(words, t, decodeXml(body));
      if (words.length > before) {
        const e = parseTtmlTime((attrs.match(/\bend="([^"]*)"/) || [])[1]);
        if (e !== null) lastEnd = e;
      }
    }
    return { words, lastEnd };
  }
  function splitTtmlBackground(inner) {
    const blocks = [];
    let main = '';
    let pos = 0;
    const openRe = /<span\b[^>]*ttm:role="x-bg"[^>]*>/g;
    let om;
    while ((om = openRe.exec(inner))) {
      if (om.index < pos) continue;
      main += inner.slice(pos, om.index);
      const tagRe = /<span\b[^>]*>|<\/span>/g;
      tagRe.lastIndex = om.index + om[0].length;
      let depth = 1;
      let tm;
      let end = inner.length;
      while ((tm = tagRe.exec(inner))) {
        depth += tm[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
          end = tm.index + tm[0].length;
          break;
        }
      }
      blocks.push(inner.slice(om.index + om[0].length, end));
      pos = end;
      openRe.lastIndex = end;
    }
    main += inner.slice(pos);
    return { main, blocks };
  }
  function parseTtml(text) {
    const out = [];
    const src = String(text || '');
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let pm;
    while ((pm = pRe.exec(src))) {
      const attrs = pm[1] || '';
      const lineStart = parseTtmlTime((attrs.match(/\bbegin="([^"]*)"/) || [])[1]);
      const lineEnd = parseTtmlTime((attrs.match(/\bend="([^"]*)"/) || [])[1]);
      const agent = (attrs.match(/\bttm:agent="([^"]*)"/) || [])[1] || '';
      const { main: inner, blocks } = splitTtmlBackground(pm[2] || '');
      const { words, lastEnd } = readTtmlSpans(inner);
      const bgParts = blocks.map(readTtmlSpans);
      const bg = makeBackgroundVocal(bgParts.flatMap(p => p.words).sort((a, b) => a.t - b.t),
        Math.max(...bgParts.map(p => p.lastEnd ?? 0)) || undefined);
      if (!words.length && bg) {
        out.push({ start: bg.start, end: bg.end, text: bg.text, words: bg.words });
        continue;
      }
      if (!words.length) {
        const plain = decodeXml(inner.replace(/<[^>]*>/g, '')).trim();
        if (!plain || lineStart === null) continue;
        out.push({ start: lineStart, end: lineEnd ?? undefined, text: plain });
        continue;
      }
      const line = {
        start: lineStart === null ? words[0].t : lineStart,
        end: lastEnd ?? lineEnd ?? undefined,
        text: words.map(w => w.c).join('').trim(),
        words,
      };
      if (agent) line.agent = agent;
      out.push(attachBackgroundVocal(line, bg));
    }
    return out;
  }

  // ── LyricsPlus（Apple Music 等を束ねたサーバー）の JSON ──────────
  function convertLyricsPlus(json) {
    const rows = Array.isArray(json && json.lyrics) ? json.lyrics : [];
    const out = [];
    for (const row of rows) {
      const words = [];
      const bgWords = [];
      let bgEnd = null;
      let lastEnd = null;
      for (const syl of (Array.isArray(row && row.syllabus) ? row.syllabus : [])) {
        const t = ms(syl && syl.time);
        const c = String((syl && syl.text) ?? '');
        if (t === null || !c) continue;
        const d = ms(syl && syl.duration);
        if (syl.isBackground) {
          bgWords.push({ t, c });
          if (d !== null && d > 0) bgEnd = Math.max(bgEnd ?? 0, t + d);
          continue;
        }
        words.push({ t, c });
        if (d !== null && d > 0) lastEnd = t + d;
      }
      if (!words.length && bgWords.length) words.push(...bgWords.splice(0));
      const start = ms(row && row.time) ?? (words.length ? words[0].t : null);
      if (start === null) continue;
      const dur = ms(row && row.duration);
      const text = (bgWords.length ? '' : String((row && row.text) ?? '')) || words.map(w => w.c).join('');
      const line = { start, text: text.trim() };
      if (words.length > 1) line.words = words;
      const end = lastEnd ?? (dur !== null && dur > 0 ? start + dur : null);
      if (end !== null) line.end = end;
      attachBackgroundVocal(line, makeBackgroundVocal(bgWords, bgEnd));
      if (line.text) out.push(line);
    }
    return out;
  }

  // ── YouTube Music（InnerTube）の時刻付き歌詞 ─────────────────
  function convertYtmTimed(timedLyricsData) {
    const lines = (timedLyricsData || []).map(item => ({
      text: String((item && item.lyricLine) || '').trim(),
      start: (Number(item && item.cueRange && item.cueRange.startTimeMilliseconds) || 0) / 1000,
      end: (Number(item && item.cueRange && item.cueRange.endTimeMilliseconds) || 0) / 1000,
    })).filter(l => l.text);
    // cueRange が全部 0 のものは同期歌詞として使えない（約7%）
    if (!lines.some(l => l.end > l.start)) return null;
    return lines.map(l => (l.end > l.start ? l : { start: l.start, text: l.text }));
  }

  // ── YouTube 字幕 json3（色＝パート分けの手がかりも拾う） ─────────
  function parseJson3Lines(text) {
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return null;
    }
    const events = (json && json.events) || [];
    const pens = (json && json.pens) || [];
    const penColor = (id) => {
      const p = pens[id];
      if (!p || p.fcForeColor === undefined) return null;
      const n = Number(p.fcForeColor);
      if (!Number.isFinite(n)) return null;
      return '#' + ('000000' + n.toString(16)).slice(-6).toUpperCase();
    };
    const out = [];
    for (const ev of events) {
      if (!ev || !ev.segs) continue;
      const segs = ev.segs;
      const text = segs.map(s => s.utf8 || '').join('').trim();
      if (!text || text === '\n') continue;
      const start = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      // 行の大半を占める色を、その行のパートの色とみなす
      const tally = new Map();
      for (const s of segs) {
        const c = penColor(s.pPenId !== undefined ? s.pPenId : ev.pPenId);
        if (!c) continue;
        tally.set(c, (tally.get(c) || 0) + String(s.utf8 || '').length);
      }
      let color = null;
      let best = 0;
      for (const [c, n] of tally) {
        if (n > best) {
          best = n;
          color = c;
        }
      }
      const line = { start, text };
      if (dur > 0) line.end = start + dur;
      if (color && color !== '#FFFFFF') line.color = color;
      out.push(line);
    }
    return out;
  }

  // ── 仕上げ：見出し落とし・語の時刻の単調化・水増しされた行末の除去 ─────
  function typicalWordGap(lines) {
    const gaps = [];
    for (const l of lines) {
      const w = l.words || [];
      for (let i = 1; i < w.length; i++) {
        const g = w[i].t - w[i - 1].t;
        if (g > 0) gaps.push(g);
      }
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  function finalizeLines(lines, want) {
    let kept = (Array.isArray(lines) ? lines : []).filter(l => l && Number.isFinite(l.start));
    kept.sort((a, b) => a.start - b.start);
    kept = T().stripLeadingHeaderLines(kept, want || {});
    if (!kept.some(l => String(l.text || '').length)) return null;
    // 行の中で語の時刻が巻き戻っていたら直前に合わせて止める（上流データの傷）
    for (const l of kept) {
      if (!Array.isArray(l.words)) continue;
      for (let i = 1; i < l.words.length; i++) {
        if (l.words[i].t < l.words[i - 1].t) l.words[i].t = l.words[i - 1].t;
      }
      if (l.words.length < 2) delete l.words;
    }
    // 次の行まで水増しされた行末は捨てる（最後の語を何秒も塗り続けないように）
    const typical = typicalWordGap(kept);
    for (let i = 0; i < kept.length; i++) {
      const l = kept[i];
      const next = kept[i + 1];
      const lastWord = l.words && l.words.length ? l.words[l.words.length - 1].t : null;
      if (Number.isFinite(l.end)) {
        const broken = lastWord !== null && l.end <= lastWord;
        const padded = next && l.end >= next.start - 0.05 && l.words;
        if (!broken && !padded) continue;
        delete l.end;
      }
      if (l.words && l.words.length && typical !== null && lastWord !== null) {
        const glyphs = Math.max(1, Array.from(String(l.words[l.words.length - 1].c)).length);
        let tail = Math.min(1.5, Math.max(0.3, typical * glyphs));
        if (next) tail = Math.min(tail, Math.max(0.05, next.start - lastWord - 0.05));
        l.end = lastWord + tail;
      }
    }
    return kept;
  }

  // 行配列を LRC 文字列に（LRC保存・突き合わせ用）
  function toLrc(lines) {
    const fmt = (sec) => {
      const t = Math.max(0, sec);
      const m = Math.floor(t / 60);
      const s = Math.floor(t - m * 60);
      const cs = Math.floor((t - m * 60 - s) * 100);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };
    return (lines || []).map(l => `[${fmt(l.start)}] ${l.text || ''}`).join('\n');
  }

  YTICore.parsers = {
    parseLrc, parseYrc, parseKrc, parseLys, parseTtml, parseTtmlTime, convertLyricsPlus, convertYtmTimed,
    parseJson3Lines, decodeKrcBase64, inflateZlib, makeBackgroundVocal, attachBackgroundVocal,
    finalizeLines, toLrc,
  };
  if (typeof module === 'object' && module.exports) module.exports = YTICore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
