// ===== 歌詞の取得元（Service Worker 側） =====
// content script はページの CORS に縛られるので、外部の歌詞サーバーへの問い合わせは
// ここ（background）でまとめて行い、共通コアの形（秒単位の行配列）にそろえて返す。
// YTM-Immersion の extra-providers.js / api.js と同じ取得元・同じ読み方。
//
//   netease   : 語単位（yrc）。訳（tlyric）とローマ字（romalrc）も付いてくる
//   amll      : 有志が手で打った語単位（CC0）。NetEase の曲IDで引く
//   kugou     : 語単位（krc）
//   lyricsplus: Apple Music の音節単位（ハモリ付き）など
//   lrchub    : videoId で引ける語単位＋歌い手（パート）＋動画ごとのずれ
//
// background.js から importScripts で読み込む。content.js からは
// chrome.runtime.sendMessage({ type: 'FETCH_LYRICS_PROVIDER', provider, want }) で使う。

/* global YTICore */
const ytiProviders = (() => {
  const P = () => YTICore.parsers;
  const T = () => YTICore.text;
  const TIMEOUT_MS = 8000;

  // 落ちている・断られた取得元はしばらく休ませる（曲を送るたびに待たされないように）
  const restUntil = new Map();
  const isResting = (id) => Date.now() < (restUntil.get(id) || 0);
  const rest = (id, ms) => restUntil.set(id, Date.now() + ms);

  async function ask(id, url, init) {
    if (isResting(id)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ cache: 'no-store', signal: ctrl.signal }, init || {}));
      if (res.status === 404) return 'NOT_FOUND';
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500 || res.status === 402) rest(id, 5 * 60 * 1000);
        return null;
      }
      return res;
    } catch (e) {
      rest(id, 60 * 1000);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const finalize = (lines, want) => P().finalizeLines(lines, want);
  const qualityOf = (lines) => (lines && lines.some(l => Array.isArray(l.words) && l.words.length > 1)) ? 2 : 1;
  const result = (provider, lines, want, extra) => {
    const fin = finalize(lines, want);
    if (!fin || fin.length < 4) return null;
    return Object.assign({ provider, lines: fin, quality: qualityOf(fin), timebase: 'song' }, extra || {});
  };

  // ── NetEase ──────────────────────────────────────────────
  const neteaseSearchCache = new Map();
  async function searchNetease(want) {
    const track = String(want.track || '').trim();
    if (!track) return null;
    const artist = String(want.artist || '').trim();
    const key = [track, artist, want.durationSec || ''].join('::');
    const hit = neteaseSearchCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const body = new URLSearchParams({ s: artist ? `${track} ${artist}` : track, type: '1', limit: '10', offset: '0' });
    const res = await ask('netease', 'https://music.163.com/api/cloudsearch/pc', { method: 'POST', body });
    if (!res || res === 'NOT_FOUND') return null;
    const json = await res.json().catch(() => null);
    const songs = (json && json.result && json.result.songs) || [];
    const cands = [];
    for (const s of songs) {
      const a = (s.ar || []).map(x => x && x.name).filter(Boolean).join(' ');
      const dur = Number(s.dt) / 1000;
      cands.push({ id: s.id, title: s.name, artist: a, durationSec: dur });
      // 別名（日本語の原題が alias に入っていることがある）も同じ曲として候補に
      for (const alias of (s.alia || [])) cands.push({ id: s.id, title: alias, artist: a, durationSec: dur });
    }
    const value = T().pickRemoteCandidate(cands, want);
    neteaseSearchCache.set(key, { at: Date.now(), value });
    if (neteaseSearchCache.size > 64) neteaseSearchCache.delete(neteaseSearchCache.keys().next().value);
    return value;
  }

  async function netease(want) {
    const hit = await searchNetease(want);
    if (!hit) return null;
    const url = `https://music.163.com/api/song/lyric/v1?id=${encodeURIComponent(hit.id)}&cp=false&lv=0&kv=0&tv=0&rv=0&yv=0&ytv=0&yrv=0`;
    const res = await ask('netease', url, { method: 'GET' });
    if (!res || res === 'NOT_FOUND') return null;
    const json = await res.json().catch(() => null);
    if (!json) return null;
    // 訳（中国語）とローマ字。行の時刻で本文と組み合わせて使う。
    const extra = {
      trackName: hit.title, artistName: hit.artist, duration: hit.durationSec || 0, songId: String(hit.id),
      translation: { lang: 'zh', lines: P().parseLrc(String((json.tlyric && json.tlyric.lyric) || '')) },
      romanization: P().parseLrc(String((json.romalrc && json.romalrc.lyric) || '')),
    };
    const yrc = String((json.yrc && json.yrc.lyric) || '').trim();
    if (yrc) {
      const r = result('netease', P().parseYrc(yrc), want, extra);
      if (r) return r;
    }
    const lrc = String((json.lrc && json.lrc.lyric) || '').trim();
    if (lrc) return result('netease', P().parseLrc(lrc), want, extra);
    return null;
  }

  // ── AMLL TTML DB（NetEase の曲IDで引く） ─────────────────────────
  const AMLL_BASES = [
    'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main',
    'https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main',
  ];
  async function amllFile(path) {
    for (const base of AMLL_BASES) {
      const res = await ask('amll', `${base}/${path}`, { method: 'GET' });
      if (res === 'NOT_FOUND') return null;
      if (!res) continue;
      return await res.text();
    }
    return null;
  }
  async function amll(want) {
    const hit = await searchNetease(want);
    if (!hit) return null;
    const extra = { trackName: hit.title, artistName: hit.artist, duration: hit.durationSec || 0 };
    const lys = await amllFile(`ncm-lyrics/${encodeURIComponent(hit.id)}.lys`);
    if (lys) {
      const r = result('amll', P().parseLys(lys), want, extra);
      if (r) return r;
    }
    const ttml = await amllFile(`ncm-lyrics/${encodeURIComponent(hit.id)}.ttml`);
    if (ttml) return result('amll', P().parseTtml(ttml), want, extra);
    return null;
  }

  // ── KuGou（krc） ─────────────────────────────────────────
  async function kugou(want) {
    const track = String(want.track || '').trim();
    if (!track) return null;
    const artist = String(want.artist || '').trim();
    const q = new URLSearchParams({ ver: '1', man: 'yes', client: 'mobi', keyword: artist ? `${artist} - ${track}` : track });
    if (want.durationSec > 0) q.set('duration', String(Math.round(want.durationSec * 1000)));
    const sres = await ask('kugou', `https://krcs.kugou.com/search?${q}`, { method: 'GET' });
    if (!sres || sres === 'NOT_FOUND') return null;
    const sjson = await sres.json().catch(() => null);
    const hit = T().pickRemoteCandidate(((sjson && sjson.candidates) || []).map(it => ({
      id: it.id, accesskey: it.accesskey, title: it.song, artist: it.singer, durationSec: Number(it.duration) / 1000,
    })), want);
    if (!hit || !hit.id || !hit.accesskey) return null;
    const d = new URLSearchParams({ ver: '1', client: 'pc', id: String(hit.id), accesskey: String(hit.accesskey), fmt: 'krc', charset: 'utf8' });
    const lres = await ask('kugou', `https://lyrics.kugou.com/download?${d}`, { method: 'GET' });
    if (!lres || lres === 'NOT_FOUND') return null;
    const ljson = await lres.json().catch(() => null);
    const content = String((ljson && ljson.content) || '');
    if (!content) return null;
    const bytes = P().decodeKrcBase64(content);
    if (!bytes) return null;
    const krc = await P().inflateZlib(bytes);
    return result('kugou', P().parseKrc(krc), want, { trackName: hit.title, artistName: hit.artist, duration: hit.durationSec || 0 });
  }

  // ── LyricsPlus（ミラーを同時に投げて最初に返ったものを採る） ──────────
  const LP_MIRRORS = ['https://lyricsplus.prjktla.my.id', 'https://lyricsplus.prjktla.workers.dev', 'https://lyricsplus-seven.vercel.app'];
  function lyricsPlusQuery(query) {
    return new Promise((resolve) => {
      let pending = LP_MIRRORS.length;
      let done = false;
      for (const base of LP_MIRRORS) {
        ask('lp:' + base, `${base}/v2/lyrics/get?${query}`, { method: 'GET' })
          .then(async (res) => {
            if (!res || res === 'NOT_FOUND') return null;
            const json = await res.json().catch(() => null);
            if (!json || json.error) return null;
            return json;
          })
          .catch(() => null)
          .then((json) => {
            pending -= 1;
            if (json && !done) {
              done = true;
              resolve(json);
            } else if (pending === 0 && !done) {
              done = true;
              resolve(null);
            }
          });
      }
    });
  }
  const isAppleSyllable = (json) => !!json && String((json.metadata && json.metadata.source) || '').toLowerCase() === 'apple' &&
    String(json.type || '').toLowerCase() !== 'line';
  async function lyricsplus(want) {
    const title = String(want.track || '').trim();
    const artist = String(want.artist || '').trim();
    if (!title || !artist) return null;
    const q = new URLSearchParams({ title, artist });
    if (want.album) q.set('album', want.album);
    if (want.durationSec > 0) q.set('duration', String(Math.round(want.durationSec)));
    let json = await lyricsPlusQuery(q.toString());
    // サーバーは「曲名・歌手・長さ」の組ごとに最初の結果を覚えている。Apple の音節同期で
    // なければ長さ無しでも聞き直す（ハモリの印が付くのは Apple だけ）。
    if (want.durationSec > 0 && !isAppleSyllable(json)) {
      q.delete('duration');
      const retry = await lyricsPlusQuery(q.toString());
      if (isAppleSyllable(retry)) json = retry;
    }
    if (!json) return null;
    const src = String((json.metadata && json.metadata.source) || '');
    return result('lyricsplus', P().convertLyricsPlus(json), want, { sourceDetail: src });
  }

  // ── LRCHub（videoId で引ける。歌い手＝パートと動画ごとのずれも持つ） ──────
  async function lrchub(want) {
    if (!want.videoId && !want.track) return null;
    const q = new URLSearchParams();
    if (want.track) q.set('track', want.track);
    if (want.artist) q.set('artist', want.artist);
    if (want.videoId) q.set('video_id', want.videoId);
    const res = await ask('lrchub', `https://lrchub.coreone.work/api/lyrics?${q}`, { method: 'GET' });
    if (!res || res === 'NOT_FOUND') return null;
    const json = await res.json().catch(() => null);
    if (!json || json.found === false || json.instrumental) return null;
    const dyn = typeof json.dynamic_lrc === 'string' ? json.dynamic_lrc : (typeof json.dynamic_lyrics === 'string' ? json.dynamic_lyrics : '');
    const lrc = typeof json.lyrics === 'string' ? json.lyrics : (typeof json.synced_lyrics === 'string' ? json.synced_lyrics : '');
    const lines = P().parseLrc(dyn || lrc);
    // この動画が LRCHub に紐付いていれば、時刻はサーバー側でこの動画に合わせてある
    const linked = Array.isArray(json.video_links) && json.video_links.some(v => v && v.video_id === want.videoId);
    const extra = {
      trackName: json.title || json.track || want.track || '',
      artistName: json.artist_name || json.artist || want.artist || '',
      recordId: (json.provider_meta && json.provider_meta.record_id) || json.record_id || json.id || '',
      plainLyrics: typeof json.plain_lyrics === 'string' ? json.plain_lyrics : '',
    };
    const r = result('lrchub', lines, want, extra);
    if (!r) return null;
    if (linked) r.timebase = 'video';
    // 歌い手（パート分け）。1人だけの曲は付けない。
    if (extra.recordId) {
      const sq = new URLSearchParams({ record_id: extra.recordId });
      if (want.videoId) sq.set('video_id', want.videoId);
      const sres = await ask('lrchub', `https://lrchub.coreone.work/api/record/singers?${sq}`, { method: 'GET' });
      const sj = (sres && sres !== 'NOT_FOUND') ? await sres.json().catch(() => null) : null;
      if (sj && Array.isArray(sj.line_singers) && Number(sj.singer_count) > 1) {
        r.singers = { lineSingers: sj.line_singers, singers: sj.singers || {}, plainLyrics: extra.plainLyrics };
      }
    }
    return r;
  }

  const TABLE = { netease, amll, kugou, lyricsplus, lrchub };

  async function fetchProvider(provider, want) {
    const fn = TABLE[provider];
    if (!fn) return null;
    try {
      return await fn(Object.assign({}, want || {}));
    } catch (e) {
      return null;
    }
  }

  return { fetchProvider, PROVIDERS: Object.keys(TABLE) };
})();
