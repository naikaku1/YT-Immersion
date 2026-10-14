// ===== 共通コア：文字列の正規化・照合・取得元どうしの突き合わせ =====
// YT-Immersion と YTM-Immersion で同じものを使えるよう、DOM にも拡張機能の API にも
// 触れない純粋な関数だけを置く。content script / Service Worker（importScripts）/
// Node（テスト）のどこからでも読み込める。
// 読み込むと globalThis.YTICore.text に入る。

(function (root) {
  const YTICore = root.YTICore = root.YTICore || {};

  // 照合用正規化：NFKC→小文字→カタカナをひらがなへ→記号・空白を除去。
  // ASRと歌詞カードで漢字の開き方が違っても、バイグラム照合でそこそこ吸収できる。
  function normalizeForMatch(s) {
    if (!s) return '';
    let t = String(s).normalize('NFKC').toLowerCase();
    t = t.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
    t = t.replace(/[^\p{L}\p{N}]/gu, '');
    return t;
  }

  // 文字バイグラムのDice係数（0〜1）。CJKでは編集距離より語順ゆらぎ・誤字に頑健。
  function diceSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const g = a.substr(i, 2);
      grams.set(g, (grams.get(g) || 0) + 1);
    }
    let hits = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const g = b.substr(i, 2);
      const c = grams.get(g) || 0;
      if (c > 0) {
        hits++;
        grams.set(g, c - 1);
      }
    }
    return (2 * hits) / (a.length - 1 + b.length - 1);
  }

  const normalizeTrackTitle = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
  const normalizeArtist = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').trim();

  // 曲名から括弧書き（【MV】(Official Video) 等）を落として比較する形に
  const toHalfWidth = (s) => String(s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g,
    c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const normTitleLoose = (s) => toHalfWidth(s)
    .replace(/[【〔（(\[［「『].*?[】〕）)\]］」』]/g, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();

  // 版の違いを表す印。探している側に無い印が候補に付いていたら別物。
  const MARKER_RE = [
    /instrumental/i, /インスト/, /カラオケ/, /karaoke/i, /off\s*vocal/i, /オフボーカル/,
    /cover/i, /カバー/, /歌ってみた/, /弾いてみた/, /演奏してみた/, /ガイドメロディ/,
    /原曲歌手/, /オルゴール/, /music\s*box/i, /piano/i, /ピアノ/,
    /remix/i, /リミックス/, /live/i, /ライブ/, /ライヴ/, /acoustic/i, /アコースティック/,
    /sped\s*up/i, /slowed/i, /nightcore/i,
  ];
  const markersOf = (s) => MARKER_RE.filter(re => re.test(String(s || ''))).map(re => re.source);

  // ── クレジット行・見出し行 ───────────────────────────────
  const CREDIT_LABELS = [
    '词', '詞', '曲', '编', '編',
    '作词', '作詞', '作曲', '编曲', '編曲', '词曲', '詞曲',
    '制作', '製作', '制作人', '製作人', '监制', '監製', '出品', '发行', '發行',
    '混音', '录音', '録音', '母带', '母帶', '和声', '和聲', '策划', '企画',
    'op', 'sp', 'produced', 'producer', 'lyrics', 'lyricist', 'lyric', 'written',
    'music', 'composer', 'composed', 'arranged', 'arranger',
    'vocal', 'chorus', 'mixing', 'mastering',
    'title', 'original', 'publish', 'copyright', 'label', 'engineer', 'studio', 'publisher', 'performed',
  ];
  const normalizeCreditLabel = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const CREDIT_LABEL_KEYS = CREDIT_LABELS.map(normalizeCreditLabel);
  const CREDIT_LABEL_MAX = 8;

  function isCreditLine(text) {
    const m = String(text || '').match(/^([^:：]{1,24})[:：]\s*\S/);
    if (!m) return false;
    const label = normalizeCreditLabel(m[1]);
    if (!label) return false;
    if (label.length <= CREDIT_LABEL_MAX) return true;
    // 「Recorded by：」「Vocal Directed by：」のような英語のクレジット
    if (/by$/.test(label)) return true;
    return CREDIT_LABEL_KEYS.some(known => (
      (known.length <= 3 && /^[a-z]+$/.test(known)) ? label === known : label.includes(known)
    ));
  }

  // 先頭に入る「曲名 - 歌手」とクレジット行を、先頭から連続する分だけ落とす
  function stripLeadingHeaderLines(lines, want) {
    // K-POP の NetEase / KuGou は録音・ミックス等のクレジットが10行を超えることがある
    const MAX_HEADER_LINES = 14;
    const MIN_KEPT_LINES = 6;
    if (!Array.isArray(lines) || lines.length < MIN_KEPT_LINES) return lines;
    const title = normalizeTrackTitle(want && want.track);
    let start = 0;
    while (start < MAX_HEADER_LINES && lines.length - start > MIN_KEPT_LINES) {
      const text = String((lines[start] && lines[start].text) || '').trim();
      if (!text) break;
      const isTitleHeader = !!title && / - |｜| \| /.test(text) && normalizeTrackTitle(text).includes(title);
      if (!isTitleHeader && !isCreditLine(text)) break;
      start += 1;
    }
    return start ? lines.slice(start) : lines;
  }

  // ── 候補の採点（曲名・アーティスト・長さ） ─────────────────
  const MIN_MATCH_SCORE = 4;

  function scoreRemoteCandidate(candidate, want) {
    const wantTitle = normalizeTrackTitle(want && want.track);
    const wantArtist = normalizeArtist(want && want.artist);
    const wantSec = Number(want && want.durationSec);
    const title = normalizeTrackTitle(candidate && candidate.title);
    const artist = normalizeArtist(candidate && candidate.artist);
    const sec = Number(candidate && candidate.durationSec);
    if (!title) return -1;
    let score = 0;
    if (wantTitle) {
      if (title === wantTitle) score += 4;
      else if (title.includes(wantTitle) || wantTitle.includes(title)) score += 2;
      else if (diceSim(normalizeForMatch(title), normalizeForMatch(wantTitle)) >= 0.6) score += 1;
      else return -1;
    }
    if (wantArtist && artist) {
      if (artist === wantArtist) score += 3;
      else if (artist.includes(wantArtist) || wantArtist.includes(artist)) score += 2;
    }
    // 探している曲名に無い版の印（ライブ・リミックス等）が付いていたら別物
    const wantMarkers = markersOf(want && want.track);
    if (markersOf(candidate && candidate.title).some(m => !wantMarkers.includes(m))) score -= 4;
    if (Number.isFinite(wantSec) && wantSec > 0 && Number.isFinite(sec) && sec > 0) {
      const diff = Math.abs(sec - wantSec);
      if (diff <= 3) score += 4;
      else if (diff <= 8) score += 1;
      else score -= 3;
    }
    return score;
  }

  function pickRemoteCandidate(candidates, want) {
    let best = null;
    let bestScore = MIN_MATCH_SCORE - 1;
    for (const c of (Array.isArray(candidates) ? candidates : [])) {
      const s = scoreRemoteCandidate(c, want);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  // ── 取得元どうしの突き合わせ（YTM-Immersion lyrics-agreement.js と同じ考え方） ──
  // 正しい歌詞どうしは取得元が違っても本文の2文字組がほぼ重なる。実測で
  // 正しいもの同士 0.82 以上、外れ（別の曲・ローマ字・訳混じり）は 0.59 以下。
  const LYRICS_AGREE_MIN = 0.7;
  const FRAGMENT_RATIO = 0.4;
  // 突き合わせで決まらない時だけ使う信頼の順。ytm は YouTube Music 自身の歌詞。
  const LYRICS_TRUST_ORDER = ['ytm', 'lrchub', 'amll', 'lyricsplus', 'netease', 'kugou', 'lrclib', 'caption'];
  const trustOf = (id) => {
    const i = LYRICS_TRUST_ORDER.indexOf(String(id || '').toLowerCase());
    return i < 0 ? LYRICS_TRUST_ORDER.length : i;
  };

  const COMPARE_CREDIT_LABELS = [
    '作詞', '作词', '作曲', '編曲', '编曲', '词曲', '詞曲', '词', '詞', '曲', '编', '編',
    '制作', '製作', '监制', '監製', '出品', '发行', '發行', '混音', '録音', '录音', '母带', '母帶',
    '和声', '和聲', '原唱', '翻唱', '演唱', '主唱', '歌手', '专辑', '專輯',
    'lyrics', 'lyricist', 'lyric', 'written', 'writer', 'music', 'composer', 'composed',
    'arranged', 'arranger', 'producer', 'produced', 'vocal', 'chorus', 'mixing', 'mastering',
  ];
  const isCompareCreditLine = (line) => {
    const m = line.match(/^([^:：]{1,24})[:：]/);
    if (!m) return false;
    const label = m[1].normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    return COMPARE_CREDIT_LABELS.some(k => label.includes(k));
  };

  // 突き合わせ用の本文（時刻・タグ・クレジットを落として文字と数字だけ）
  function lyricTextForCompare(lyrics) {
    const body = Array.isArray(lyrics) ? lyrics.map(l => (l && l.text) || '').join('\n') : String(lyrics ?? '');
    return body.split(/\r?\n/)
      .map(line => line.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim())
      .filter(line => !isCompareCreditLine(line))
      .join('\n')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  const MAX_COMPARE_CHARS = 20000;
  function bigramSet(text) {
    const chars = Array.from(text).slice(0, MAX_COMPARE_CHARS);
    const set = new Set();
    for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
    return set;
  }

  // 2つの歌詞がどれだけ同じか（0〜1）。行配列でも文字列でもよい。
  function lyricsAgreement(a, b) {
    const A = bigramSet(lyricTextForCompare(a));
    const B = bigramSet(lyricTextForCompare(b));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const g of A) if (B.has(g)) shared += 1;
    return (2 * shared) / (A.size + B.size);
  }

  const CJK_RE = /[぀-ヿ㐀-鿿]/u;
  const HANGUL_RE = /[가-힯]/u;
  const ANY_ASIAN_RE = /[぀-ヿ㐀-鿿가-힯]/u;
  const expectedScriptOf = (track) => {
    const t = String(track || '');
    if (HANGUL_RE.test(t)) return HANGUL_RE;
    if (CJK_RE.test(t)) return CJK_RE;
    return null;
  };
  const shareOf = (text, re) => {
    const chars = Array.from(text);
    if (!chars.length) return 0;
    return chars.filter(c => re.test(c)).length / chars.length;
  };

  // entries: [{key?, providerId, lyrics}] → Map(key → 'confirmed'|'contradicted'|'unknown')
  function judgeLyrics(entries, opts) {
    const track = (opts && opts.track) || '';
    const all = (Array.isArray(entries) ? entries : [])
      .filter(e => e && e.lyrics && (typeof e.lyrics === 'string' ? e.lyrics.trim() : e.lyrics.length))
      .map(e => {
        const text = lyricTextForCompare(e.lyrics);
        return { key: String(e.key || e.providerId || ''), providerId: String(e.providerId || ''), text, grams: bigramSet(text) };
      });
    const list = all.filter(e => e.text);
    const verdicts = new Map();
    for (const e of all) if (!e.text) verdicts.set(e.key, list.length ? 'contradicted' : 'unknown');
    if (!list.length) return verdicts;
    const n = list.length;
    const agree = list.map(() => new Array(n).fill(false));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let shared = 0;
        for (const g of list[i].grams) if (list[j].grams.has(g)) shared += 1;
        const size = list[i].grams.size + list[j].grams.size;
        const ok = size > 0 && (2 * shared) / size >= LYRICS_AGREE_MIN;
        agree[i][j] = ok;
        agree[j][i] = ok;
      }
    }
    const group = new Array(n).fill(-1);
    const groups = [];
    for (let i = 0; i < n; i++) {
      if (group[i] >= 0) continue;
      const members = [i];
      group[i] = groups.length;
      for (let k = 0; k < members.length; k++) {
        for (let j = 0; j < n; j++) {
          if (group[j] < 0 && agree[members[k]][j]) {
            group[j] = groups.length;
            members.push(j);
          }
        }
      }
      groups.push(members);
    }
    const bestTrust = (members) => Math.min(...members.map(i => trustOf(list[i].providerId)));
    const best = groups.slice().sort((a, b) => (b.length - a.length) || (bestTrust(a) - bestTrust(b)))[0];
    if (best.length >= 2) {
      list.forEach((e, i) => verdicts.set(e.key, best.includes(i) ? 'confirmed' : 'contradicted'));
      return verdicts;
    }
    const lengths = list.map(e => Array.from(e.text).length);
    const longest = Math.max(...lengths);
    const asian = list.map(e => shareOf(e.text, ANY_ASIAN_RE));
    const iLongest = lengths.indexOf(longest);
    const script = expectedScriptOf(track);
    const shares = script ? list.map(e => shareOf(e.text, script)) : null;
    const maxShare = shares ? Math.max(...shares) : 0;
    const flawed = list.map((e, i) => (
      (lengths[i] < longest * FRAGMENT_RATIO && Math.abs(asian[i] - asian[iLongest]) <= 0.2) ||
      (!!shares && maxShare >= 0.3 && shares[i] < maxShare * 0.6)
    ));
    const anyClean = flawed.some(f => !f);
    list.forEach((e, i) => verdicts.set(e.key, (anyClean && flawed[i]) ? 'contradicted' : 'unknown'));
    return verdicts;
  }

  // 表示に使う候補を1つ選ぶ。外れは選ばない。同じ見立ての中では品質→信頼の順。
  function pickAgreedLyrics(candidates, voters, opts) {
    const verdicts = judgeLyrics([...(candidates || []), ...(voters || [])], opts);
    const keyOf = (c) => String(c.key || c.providerId || '');
    const rank = { confirmed: 0, unknown: 1 };
    const picked = (candidates || [])
      .filter(c => verdicts.get(keyOf(c)) !== 'contradicted')
      .sort((a, b) => (
        (rank[verdicts.get(keyOf(a))] ?? 2) - (rank[verdicts.get(keyOf(b))] ?? 2) ||
        (Number(b.quality) || 0) - (Number(a.quality) || 0) ||
        trustOf(a.providerId) - trustOf(b.providerId)
      ))[0] || null;
    return { picked, verdicts };
  }

  // 文字列の短い指紋（キャッシュ・共有データのキーに使う）。FNV-1a 32bit。
  function hash32(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  YTICore.text = {
    normalizeForMatch, diceSim, normalizeTrackTitle, normalizeArtist, normTitleLoose, markersOf,
    isCreditLine, stripLeadingHeaderLines, scoreRemoteCandidate, pickRemoteCandidate,
    lyricTextForCompare, lyricsAgreement, judgeLyrics, pickAgreedLyrics, trustOf, hash32,
    LYRICS_AGREE_MIN, LYRICS_TRUST_ORDER,
  };
  if (typeof module === 'object' && module.exports) module.exports = YTICore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
