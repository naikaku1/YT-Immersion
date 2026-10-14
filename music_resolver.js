// ===== 曲の特定：MV の videoId → YouTube Music の曲（音源版）・公式の時刻付き歌詞・曲⇔動画の対応表 =====
// 文字列（動画タイトル・チャンネル名）で歌詞データベースを検索すると、同名の別曲・ライブ版・
// カバーを掴む。YouTube Music は MV と音源版の対応（counterpart）と、その間の時刻の対応表
// （segmentMap：音源の何秒が MV の何秒か）を自分で持っている。これを www.youtube.com から
// 同じオリジンで引く（YTM-Immersion の ytm-lyrics.js と同じ仕組み。ホストだけ違う）。
//
// 実測（2026-10-14, www.youtube.com から）:
//   - WEB_REMIX の next は www でも 200 で、YouTube Music と同じ形の応答が返る
//   - counterpart と segmentMap はログイン状態（SAPISIDHASH 付き）の時だけ返る
//       NewJeans「Ditto」MV: 音源の 0 秒 = MV の 82.035 秒（82 秒の映像イントロ）
//       BTS「Dynamite」: 23.7 秒 / 髭男「Pretender」: 音源の方が 0.45 秒前から
//   - 音源版の歌詞タブを ANDROID_MUSIC（匿名）で browse すると行同期の歌詞（Musixmatch 等）
//   - music.youtube.com へのクロスオリジン呼び出しは認証付きだと 400。www に投げる
// 未ログインでは counterpart が返らないので、アルバム走査と曲検索で音源版を探す
// （採用前にアーティストの channelId を必ず照合する。別の曲の歌詞は出ないより悪い）。
//
// content.js からは ytiMusicResolver.resolve(videoId) / prefetch(videoId) を使う。

const ytiMusicResolver = (() => {
  const CLIENT_WEB = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' };
  const CLIENT_MOBILE = { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' };
  const TIMEOUT_MS = 6000;
  const RESOLVE_BUDGET_MS = 9000;
  const STORE_PREFIX = 'ytm2:';
  const STORE_TTL_MS = 7 * 24 * 3600 * 1000;
  const STORE_MISS_TTL_MS = 12 * 3600 * 1000;

  // ── ページの設定値（visitorData 等）。取れなくても匿名で動く ─────────────
  let cachedConfig = null;
  let lastScanAt = 0;
  function pageConfig() {
    if (cachedConfig) return cachedConfig;
    if (Date.now() - lastScanAt < 3000) return {};
    lastScanAt = Date.now();
    const conf = {};
    const FIELDS = [
      ['visitorData', 'VISITOR_DATA', /"VISITOR_DATA":"([^"]+)"/],
      ['sessionIndex', 'SESSION_INDEX', /"SESSION_INDEX":"?(\d+)"?/],
      ['delegatedSessionId', 'DELEGATED_SESSION_ID', /"DELEGATED_SESSION_ID":"([^"]+)"/],
      ['hl', '"HL"', /"HL":"([^"]+)"/],
      ['gl', '"GL"', /"GL":"([^"]+)"/],
    ];
    try {
      for (const s of document.scripts) {
        const txt = s.textContent;
        if (!txt) continue;
        for (const [key, marker, re] of FIELDS) {
          if (conf[key] || txt.indexOf(marker) === -1) continue;
          const m = txt.match(re);
          if (m) conf[key] = m[1];
        }
      }
    } catch (e) {}
    if (conf.visitorData) cachedConfig = conf;
    return conf;
  }

  const readCookie = (name) => {
    try {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  };
  const authCookie = () => readCookie('SAPISID') || readCookie('__Secure-3PAPISID') || '';
  let authDisabledUntil = 0;
  const canAuth = () => Date.now() >= authDisabledUntil && !!authCookie() && !!(self.crypto && crypto.subtle);

  // SAPISID は YouTube 自身の JS も読む非 HttpOnly の Cookie。ハッシュはこのページ内で計算し、外へは送らない。
  async function authHeaders() {
    if (!canAuth()) return null;
    const origin = location.origin;
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${authCookie()} ${origin}`));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    const conf = pageConfig();
    const h = { 'Authorization': `SAPISIDHASH ${ts}_${hex}`, 'X-Origin': origin, 'X-Goog-AuthUser': conf.sessionIndex || '0' };
    if (conf.delegatedSessionId) h['X-Goog-PageId'] = conf.delegatedSessionId;
    return h;
  }

  // 認証を付けるのは WEB_REMIX の next / browse だけ。ANDROID_MUSIC に web の認証を付けると 400。
  // 検索は匿名（ユーザーの検索履歴を汚さない）。
  async function post(endpoint, client, extra, auth) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const conf = pageConfig();
    const ah = (auth && client.clientName === 'WEB_REMIX') ? await authHeaders().catch(() => null) : null;
    try {
      const res = await fetch(`${location.origin}/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: 'POST',
        credentials: ah ? 'include' : 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: Object.assign({ 'Content-Type': 'application/json' },
          conf.visitorData ? { 'X-Goog-Visitor-Id': conf.visitorData } : {}, ah || {}),
        body: JSON.stringify(Object.assign({
          context: { client: Object.assign({}, client, { hl: conf.hl || 'ja', gl: conf.gl || 'JP' }), user: {} },
        }, extra)),
      });
      if (!res.ok) {
        if (ah && (res.status === 401 || res.status === 403)) {
          authDisabledUntil = Date.now() + 30 * 60 * 1000;
          clearTimeout(timer);
          return post(endpoint, client, extra, false);
        }
        if (ah && res.status === 400) {
          clearTimeout(timer);
          return post(endpoint, client, extra, false);
        }
        throw new Error(`innertube ${endpoint} HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 応答の読み取り ───────────────────────────────────────
  const tabsOf = (nextRes) => (nextRes && nextRes.contents && nextRes.contents.singleColumnMusicWatchNextResultsRenderer &&
    nextRes.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer &&
    nextRes.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer &&
    nextRes.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs) || [];

  function findLyricsTab(nextRes) {
    for (const tab of tabsOf(nextRes)) {
      const tr = tab && tab.tabRenderer;
      const ep = tr && tr.endpoint && tr.endpoint.browseEndpoint;
      const cfg = ep && ep.browseEndpointContextSupportedConfigs && ep.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig;
      if (cfg && cfg.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS' && ep.browseId) return { browseId: ep.browseId, unselectable: !!tr.unselectable };
    }
    return null;
  }
  function queueHead(nextRes) {
    const tab = tabsOf(nextRes)[0];
    const c = tab && tab.tabRenderer && tab.tabRenderer.content && tab.tabRenderer.content.musicQueueRenderer &&
      tab.tabRenderer.content.musicQueueRenderer.content && tab.tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer &&
      tab.tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.contents;
    return (c && c[0]) || null;
  }
  const runsText = (t) => ((t && t.runs) || []).map(r => r.text).join('');
  // "3:06" / "1:02:03" → 秒
  const parseLength = (s) => {
    const parts = String(s || '').trim().split(':').map(Number);
    if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
    return parts.reduce((a, n) => a * 60 + n, 0);
  };
  function readHead(nextRes) {
    const head = queueHead(nextRes);
    if (!head) return null;
    const wrap = head.playlistPanelVideoWrapperRenderer;
    const item = head.playlistPanelVideoRenderer || (wrap && wrap.primaryRenderer && wrap.primaryRenderer.playlistPanelVideoRenderer);
    if (!item) return null;
    const runs = (item.longBylineText && item.longBylineText.runs) || (item.shortBylineText && item.shortBylineText.runs) || [];
    const channelIds = [...new Set(runs.map(r => r && r.navigationEndpoint && r.navigationEndpoint.browseEndpoint &&
      r.navigationEndpoint.browseEndpoint.browseId).filter(b => b && b.startsWith('UC')))];
    const json = JSON.stringify(item);
    const mvt = (json.match(/"musicVideoType":"(\w+)"/) || [])[1] || '';
    let counterpartId = null;
    let counterpartLength = 0;
    let segments = [];
    const cp = wrap && wrap.counterpart && wrap.counterpart[0];
    if (cp) {
      const cpItem = cp.counterpartRenderer && cp.counterpartRenderer.playlistPanelVideoRenderer;
      counterpartId = (cpItem && cpItem.videoId) || null;
      counterpartLength = cpItem ? parseLength(runsText(cpItem.lengthText)) : 0;
      if (cp.segmentMap) segments = YTICore.warp.segmentsFromSegmentMap(cp.segmentMap);
    }
    // アルバム（あれば曲検索の手がかり）
    const albumRun = runs.find(r => r && r.navigationEndpoint && r.navigationEndpoint.browseEndpoint &&
      /^MPREb_/.test(r.navigationEndpoint.browseEndpoint.browseId || ''));
    return {
      title: runsText(item.title),
      artistName: (runs[0] && runs[0].text) || '',
      album: albumRun ? albumRun.text : '',
      channelIds,
      musicVideoType: mvt.replace('MUSIC_VIDEO_TYPE_', ''),
      lengthSec: parseLength(runsText(item.lengthText)),
      counterpartId,
      counterpartLength,
      segments,
    };
  }

  function readLyrics(browseRes) {
    const model = browseRes && browseRes.contents && browseRes.contents.elementRenderer && browseRes.contents.elementRenderer.newElement &&
      browseRes.contents.elementRenderer.newElement.type && browseRes.contents.elementRenderer.newElement.type.componentType &&
      browseRes.contents.elementRenderer.newElement.type.componentType.model;
    const data = model && model.timedLyricsModel && model.timedLyricsModel.lyricsData;
    if (data && Array.isArray(data.timedLyricsData) && data.timedLyricsData.length) {
      const lines = YTICore.parsers.convertYtmTimed(data.timedLyricsData);
      if (lines) return { kind: 'timed', source: data.sourceMessage || '', lines };
      const text = data.timedLyricsData.map(x => x.lyricLine || '').join('\n');
      if (text.trim()) return { kind: 'plain', source: data.sourceMessage || '', text };
    }
    if (model && model.musicMessageModel) return { kind: 'none' };
    if (browseRes && browseRes.contents && browseRes.contents.messageRenderer) return { kind: 'none' };
    const shelf = browseRes && browseRes.contents && browseRes.contents.sectionListRenderer &&
      browseRes.contents.sectionListRenderer.contents && browseRes.contents.sectionListRenderer.contents[0] &&
      browseRes.contents.sectionListRenderer.contents[0].musicDescriptionShelfRenderer;
    const plain = shelf ? runsText(shelf.description) : '';
    if (plain.trim()) return { kind: 'plain', source: shelf ? runsText(shelf.footer) : '', text: plain };
    return null;
  }

  // videoId の歌詞を1回試す。ANDROID_MUSIC（匿名）が同期歌詞を返す。
  // ログイン状態でしか配信されない歌詞もある（WEB_REMIX 認証付きはプレーンのみ）ので並べて投げる。
  async function tryFetch(videoId) {
    const nextRes = await post('next', CLIENT_WEB, { videoId }, true);
    const tab = findLyricsTab(nextRes);
    if (!tab || tab.unselectable) return { nextRes, result: null, browseId: null };
    const mobile = post('browse', CLIENT_MOBILE, { browseId: tab.browseId }, false).then(readLyrics).catch(() => null);
    const web = canAuth() ? post('browse', CLIENT_WEB, { browseId: tab.browseId }, true).then(readLyrics).catch(() => null) : Promise.resolve(null);
    const [m, w] = await Promise.all([mobile, web]);
    const usable = (r) => !!r && r.kind !== 'none';
    const result = usable(m) ? m : (usable(w) ? w : (m || w));
    return { nextRes, result, browseId: tab.browseId };
  }

  // ── 未ログイン時：アルバム走査・曲検索で音源版を探す ─────────────────
  const normTitle = (s) => YTICore.text.normTitleLoose(s);
  const markersOf = (s) => YTICore.text.markersOf(s);

  async function readAlbumRows(browseId) {
    const res = await post('browse', CLIENT_WEB, { browseId }, false);
    const rows = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const r = node.musicResponsiveListItemRenderer;
      if (r) {
        let catalogId = null;
        for (const mi of ((r.menu && r.menu.menuRenderer && r.menu.menuRenderer.items) || [])) {
          const b = mi && mi.menuNavigationItemRenderer && mi.menuNavigationItemRenderer.navigationEndpoint &&
            mi.menuNavigationItemRenderer.navigationEndpoint.browseEndpoint && mi.menuNavigationItemRenderer.navigationEndpoint.browseEndpoint.browseId;
          if (b && b.startsWith('MPTC')) catalogId = b.slice(4);
        }
        const col = r.flexColumns && r.flexColumns[0] && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer;
        rows.push({ videoId: (r.playlistItemData && r.playlistItemData.videoId) || null, catalogId, title: col ? runsText(col.text) : '' });
        return;
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(res && res.contents);
    return rows;
  }

  async function searchIds(query, params, re) {
    const res = await post('search', CLIENT_WEB, { query, params }, false).catch(() => null);
    const ids = [];
    if (!res) return ids;
    for (const m of JSON.stringify(res).matchAll(re)) {
      if (!ids.includes(m[1])) ids.push(m[1]);
      if (ids.length >= 6) break;
    }
    return ids;
  }

  function readSongRows(res) {
    const rows = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const r = node.musicResponsiveListItemRenderer;
      if (r) {
        const c0 = r.flexColumns && r.flexColumns[0] && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer;
        const c1 = r.flexColumns && r.flexColumns[1] && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer;
        const byline = (c1 && c1.text && c1.text.runs) || [];
        rows.push({
          videoId: (r.playlistItemData && r.playlistItemData.videoId) || null,
          title: c0 ? runsText(c0.text) : '',
          artist: (byline[0] && byline[0].text) || '',
          channelIds: [...new Set(byline.map(x => x && x.navigationEndpoint && x.navigationEndpoint.browseEndpoint &&
            x.navigationEndpoint.browseEndpoint.browseId).filter(b => b && b.startsWith('UC')))],
        });
        return;
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(res && res.contents);
    return rows;
  }

  const SONG_PARAMS = 'EgWKAQIIAWoKEAoQCRADEAQQBQ%3D%3D';
  const ALBUM_PARAMS = ['EgWKAQIYAWoKEAoQAxAEEAkQBQ%3D%3D', SONG_PARAMS];

  async function findCatalogSong(videoId, src, deadline) {
    if (!src || !src.title) return null;
    const query = `${src.title.replace(/[【〔].*?[】〕]/g, ' ').slice(0, 80)} ${src.artistName || ''}`.trim();
    const wanted = normTitle(src.title);
    const srcMarkers = markersOf(src.title);
    // 1) アルバム走査：行の videoId が今の MV と完全一致なら曖昧さゼロで音源版が分かる
    const albums = [];
    for (const p of ALBUM_PARAMS) {
      if (Date.now() > deadline) break;
      for (const id of await searchIds(query, p, /"browseId":"(MPREb_[A-Za-z0-9_-]+)"/g)) if (!albums.includes(id)) albums.push(id);
      if (albums.length >= 4) break;
    }
    const fetched = [];
    for (const bid of albums.slice(0, 3)) {
      if (Date.now() > deadline) break;
      const rows = await readAlbumRows(bid).catch(() => []);
      fetched.push(rows);
      const exact = rows.find(r => r.videoId === videoId);
      if (exact && exact.catalogId && exact.catalogId !== videoId) return exact.catalogId;
    }
    for (const rows of fetched) {
      for (const r of rows) {
        if (!r.catalogId || r.catalogId === videoId) continue;
        if (markersOf(r.title).some(m => !srcMarkers.includes(m))) continue;
        if (wanted && normTitle(r.title) === wanted) return r.catalogId;
      }
    }
    // 2) 「曲」検索：同名で、アーティストの channelId（無ければ名前）が一致するもの
    if (Date.now() > deadline) return null;
    const res = await post('search', CLIENT_WEB, { query, params: SONG_PARAMS }, false).catch(() => null);
    for (const row of readSongRows(res)) {
      if (!row.videoId || row.videoId === videoId) continue;
      if (wanted && normTitle(row.title) !== wanted) continue;
      if (markersOf(row.title).some(m => !srcMarkers.includes(m))) continue;
      if (src.channelIds && src.channelIds.length && row.channelIds.length) {
        if (!row.channelIds.some(id => src.channelIds.includes(id))) continue;
      } else if (src.artistName && YTICore.text.diceSim(YTICore.text.normalizeForMatch(row.artist), YTICore.text.normalizeForMatch(src.artistName)) < 0.5) {
        continue;
      }
      return row.videoId;
    }
    return null;
  }

  const ytiResolverTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

  // ── 本体 ───────────────────────────────────────────────
  // 戻り値: { videoId, musicVideoType, title, artistName, album, channelIds, songVideoId,
  //           segments: [{songStart, videoStart, dur}], lyrics: {kind, lines|text, source}|null, via }
  async function resolveUncached(videoId, hintIn) {
    const deadline = Date.now() + RESOLVE_BUDGET_MS;
    // hint は Promise のこともある（ページの曲名の読み取りを待たずに始めるため）。使う所で待つ。
    let hint = null;
    const getHint = async () => {
      if (hint) return hint;
      try {
        hint = (hintIn && typeof hintIn.then === 'function') ? await ytiResolverTimeout(hintIn, 3000) : hintIn;
      } catch (e) {
        hint = null;
      }
      return hint;
    };
    const first = await tryFetch(videoId);
    const head = readHead(first.nextRes) || {};
    const out = {
      videoId,
      musicVideoType: head.musicVideoType || '',
      title: head.title || '',
      artistName: head.artistName || '',
      album: head.album || '',
      channelIds: head.channelIds || [],
      songVideoId: head.musicVideoType === 'ATV' ? videoId : null,
      segments: head.segments || [],
      // 曲（音源版）の長さ。MV がどれだけ長いか（＝映像パートの量）の見積もりに使う
      songLengthSec: head.musicVideoType === 'ATV' ? (head.lengthSec || 0) : (head.counterpartLength || 0),
      lyrics: null,
      via: '',
    };
    const good = (r) => r && r.kind === 'timed';
    // ① ログイン時：counterpart（公式の曲⇔動画の対応）。最大2ホップ。
    let res = first.result;
    let chain = first;
    const visited = new Set([videoId]);
    for (let hop = 0; hop < 2 && !good(res); hop++) {
      const cpId = (readHead(chain.nextRes) || {}).counterpartId;
      if (!cpId || visited.has(cpId)) break;
      visited.add(cpId);
      const cp = await tryFetch(cpId).catch(() => null);
      if (!cp) break;
      chain = cp;
      if (cp.result && cp.result.kind !== 'none') {
        res = cp.result;
        out.songVideoId = cpId;
        out.via = 'counterpart';
        const cpHead = readHead(cp.nextRes);
        if (cpHead && cpHead.lengthSec && !out.songLengthSec) out.songLengthSec = cpHead.lengthSec;
      }
    }
    if (good(res) && !out.via) out.via = head.musicVideoType === 'ATV' ? 'song' : 'own';
    // ② 未ログイン・counterpart なし：アルバム走査と曲検索。
    // 公式 MV・音源以外（ダンス練習・ステージ・ファンカム・歌ってみた等の UGC）は、YouTube Music 側の
    // 曲名が動画タイトルそのものなので、概要欄の「ミュージック」（Content ID が特定した曲）を手がかりにする。
    if (!good(res) && Date.now() < deadline) {
      await getHint();
      const isCatalogVideo = out.musicVideoType === 'OMV' || out.musicVideoType === 'ATV';
      const useHint = !!(hint && hint.title && (!isCatalogVideo || !out.title));
      const src = useHint
        ? { title: hint.title, artistName: hint.artist || '', channelIds: isCatalogVideo ? out.channelIds : [] }
        : { title: out.title || '', artistName: out.artistName || '', channelIds: out.channelIds };
      if (useHint && !isCatalogVideo) {
        out.title = hint.title;
        out.artistName = hint.artist || out.artistName;
        out.channelIds = [];
      }
      const catalogId = await findCatalogSong(videoId, src, deadline).catch(() => null);
      if (catalogId && !visited.has(catalogId)) {
        const alt = await tryFetch(catalogId).catch(() => null);
        const altHead = alt ? readHead(alt.nextRes) : null;
        const sameArtist = !out.channelIds.length || !!(altHead && altHead.channelIds.some(id => out.channelIds.includes(id)));
        if (alt && sameArtist && alt.result && alt.result.kind !== 'none' && (good(alt.result) || !res || res.kind === 'none')) {
          res = alt.result;
          out.songVideoId = catalogId;
          out.via = 'catalog';
          if (altHead && altHead.lengthSec) out.songLengthSec = altHead.lengthSec;
          if (!out.title && altHead) {
            out.title = altHead.title;
            out.artistName = altHead.artistName;
          }
        }
      }
    }
    if (res && res.kind !== 'none') out.lyrics = res;
    return out;
  }

  // 同じ videoId はセッション中1本にまとめ、結果は拡張の保存領域にも置く（次回は通信なしで即座に）
  const inflight = new Map();
  const storeGet = (key) => new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (items) => resolve((items && items[key]) || null));
    } catch (e) {
      resolve(null);
    }
  });
  const storeSet = (key, value) => {
    try {
      chrome.storage.local.set({ [key]: value });
    } catch (e) {}
  };

  function resolve(videoId, hint) {
    if (!videoId) return Promise.resolve(null);
    if (inflight.has(videoId)) return inflight.get(videoId);
    const task = (async () => {
      const key = STORE_PREFIX + videoId;
      const saved = await storeGet(key);
      if (saved && saved.at && Date.now() - saved.at < (saved.value && saved.value.lyrics ? STORE_TTL_MS : STORE_MISS_TTL_MS)) {
        // 保存時に未ログインで対応表が無かったなら、ログインした今は取り直す価値がある
        if (!(saved.value && !saved.value.segments.length && saved.value.musicVideoType === 'OMV' && canAuth() && !saved.authed)) return saved.value;
      }
      const value = await resolveUncached(videoId, hint).catch(() => null);
      if (value) storeSet(key, { at: Date.now(), authed: canAuth(), value });
      return value;
    })();
    inflight.set(videoId, task);
    task.finally(() => setTimeout(() => inflight.delete(videoId), 60000));
    return task;
  }

  // 次の動画（自動再生・再生リスト）を先に引いておく。曲が変わった瞬間に歌詞を出すため。
  function prefetch(videoId) {
    if (!videoId || inflight.has(videoId)) return;
    resolve(videoId).catch(() => {});
  }

  return { resolve, prefetch, canAuth };
})();
