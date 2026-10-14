// ===== 外部歌詞の取得・検証・格上げ =====
// content.js の後に読み込む（content.js の関数・状態をそのまま使う）。
//
// 取得の順番と考え方:
//   1) YouTube Music の公式歌詞（music_resolver.js）。曲を videoId で特定し、アーティストの
//      channelId まで照合済み。ログイン時は曲⇔MV の公式の対応表（segmentMap）も付く。
//   2) 語（音節）単位の取得元（LRCHub / AMLL / LyricsPlus(Apple) / NetEase / KuGou）と LRCLIB。
//      曲名で引くので取り違えがありうる。互いの本文の突き合わせで外れを落とす。
//   3) 1) があれば表示はまずそれで出し、2) のうち本文が一致する語単位のものが届いたら、
//      時刻を 1) に合わせ込んでから差し替える（＝公式の対応表の正確さ＋語単位の塗り）。
//   4) 自動生成字幕（ASR）が取れたら、それとの一致率で最終確認する（runExternalAutoSync）。
//      一致しない歌詞（別の曲・別の言語）は、より一致する候補へ乗り換えるか、出さない。

// ===== 実験的な機能（既定では隠す） =====
// パート分け・応援法・共有・ふりがな/ローマ字・端末内翻訳は、コードとしては残したまま既定では出さない。
// 使う時はコンソールで localStorage.setItem('mv_extra_features', 'true') を実行してページを読み込み直す。
const YTI_EXTRAS_KEY = 'mv_extra_features';
function ytiExtrasEnabled() {
  return localStorage.getItem(YTI_EXTRAS_KEY) === 'true';
}

// ===== 拡張の差し込み口 =====
// 訳・読み（language.js）、パート分け（parts.js）、応援法（chants.js）などが、歌詞の行・行の要素・
// 設定パネルに手を加えるための登録先。content.js はここにある関数を呼ぶだけ。
const ytiHooks = { decorateLines: [], decorateLineEl: [], lyricsReady: [], settings: [], rendered: [] };
// 外部歌詞の行（動画の時計に写した後・前奏の「・・・」を足す前）に手を加える
function ytiDecorateExternalLines(lines, info, warp) {
  for (const f of ytiHooks.decorateLines) {
    try {
      f(lines, info, warp);
    } catch (e) {}
  }
}
// 歌詞の行の要素を作った直後（字幕・外部歌詞のどちらでも）
function ytiDecorateLineElement(line, el, index) {
  for (const f of ytiHooks.decorateLineEl) {
    try {
      f(line, el, index);
    } catch (e) {}
  }
}
// 外部歌詞を採用した時
function ytiOnExternalLyricsReady(videoId, token) {
  for (const f of ytiHooks.lyricsReady) {
    try {
      f(videoId, token, 'external');
    } catch (e) {}
  }
}
// 字幕の歌詞を表示した時
function ytiOnCaptionLyricsReady(videoId, token) {
  for (const f of ytiHooks.lyricsReady) {
    try {
      f(videoId, token, 'caption');
    } catch (e) {}
  }
}
function ytiExtendSettingsPanel(panel, makeToggle) {
  for (const f of ytiHooks.settings) {
    try {
      f(panel, makeToggle);
    } catch (e) {}
  }
}
// 設定パネル用：選択肢の行
function ytiMakeSelectRow(label, desc, key, def, options, onChange) {
  const row = document.createElement('div');
  row.className = 'mv-setting-row';
  const txt = document.createElement('div');
  txt.className = 'mv-setting-text';
  txt.innerHTML = '<span class="mv-setting-label"></span><span class="mv-setting-desc"></span>';
  txt.querySelector('.mv-setting-label').textContent = label;
  txt.querySelector('.mv-setting-desc').textContent = desc;
  const sel = document.createElement('select');
  sel.className = 'mv-setting-select';
  const cur = localStorage.getItem(key) || def;
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    if (v === cur) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = (e) => {
    e.stopPropagation();
    localStorage.setItem(key, sel.value);
    if (onChange) onChange(sel.value);
  };
  ['click', 'mousedown'].forEach(t => sel.addEventListener(t, e => e.stopPropagation()));
  row.appendChild(txt);
  row.appendChild(sel);
  return row;
}

const YTI_EXT2_PREFIX = 'ext3:'; // 語の時刻を行の時刻へ寄せていた頃の保存分（ext2:）は使わない
const YTI_EXT2_TTL = 30 * 24 * 3600 * 1000;
const YTI_EXT2_MISS_TTL = 12 * 3600 * 1000;
// 1曲の候補を待つ上限。公式歌詞が無い時だけ待つ（あれば先に出して裏で格上げ）。
const YTI_CANDIDATE_WAIT_MS = 6500;
const YTI_WORD_PROVIDERS = ['lrchub', 'lyricsplus', 'amll', 'netease', 'kugou'];

function ytiAskProvider(provider, want) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_LYRICS_PROVIDER', provider, want }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success) resolve(null);
        else resolve(res.result || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

const ytiStoreGet = (key) => new Promise((resolve) => {
  try {
    chrome.storage.local.get(key, (items) => resolve((items && items[key]) || null));
  } catch (e) {
    resolve(null);
  }
});
const ytiStoreSet = (key, value) => {
  try {
    chrome.storage.local.set({ [key]: value });
  } catch (e) {}
};

const ytiWithTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

const YTI_PROVIDER_LABEL = {
  ytm: 'YouTube Music', lrchub: 'LRCHub', lyricsplus: 'LyricsPlus', amll: 'AMLL', netease: 'NetEase', kugou: 'KuGou', lrclib: 'LRCLIB',
};

// 取得元の結果（秒の行配列）を外部歌詞の候補の形へ
function ytiCandidateFrom(r, extra) {
  if (!r || !Array.isArray(r.lines) || r.lines.length < 4) return null;
  return Object.assign({
    providerId: r.provider,
    key: r.provider,
    lines: r.lines,
    quality: r.quality || 1,
    timebase: r.timebase || 'song',
    trackName: r.trackName || '',
    artistName: r.artistName || '',
    duration: r.duration || 0,
    translation: r.translation || null,
    romanization: r.romanization || null,
    singers: r.singers || null,
    sourceDetail: r.sourceDetail || '',
  }, extra || {});
}

// 候補 cand の時刻を、基準 ref（同じ曲の別の取得元）の時刻へ揃える。
// 取得元ごとにマスターの頭出しが 0.2〜2 秒違う（実測: KuGou は他より 1.4 秒遅い曲がある）。
// 本文の一致する行どうしのずれの中央値を当てる。揃えられなければ null。
function ytiRegisterTo(cand, ref) {
  const T = YTICore.text;
  const refNorm = ref.lines.map(l => T.normalizeForMatch(l.text));
  const diffs = [];
  let j = 0;
  for (const l of cand.lines) {
    const n = T.normalizeForMatch(l.text);
    if (n.length < 3) continue;
    for (let k = j; k < Math.min(refNorm.length, j + 6); k++) {
      if (refNorm[k].length >= 3 && T.diceSim(n, refNorm[k]) >= 0.8) {
        diffs.push(ref.lines[k].start - l.start);
        j = k + 1;
        break;
      }
    }
  }
  if (diffs.length < 5) return null;
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  const mad = diffs.map(d => Math.abs(d - med)).sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
  if (mad > 0.6) return null;
  // 行の時刻だけの歌詞（YouTube Music の LyricFind / Musixmatch）は、行の頭の付け方の癖で
  // 語単位の歌詞より 0.2〜0.7 秒前後にずれている（実測: Ditto -0.32 / アイドル +0.30 / Lemon -0.70）。
  // 語の時刻の方が歌声に正確なので、1 秒未満の差は「同じ音源の表記の差」とみなして動かさない。
  // 1 秒以上ずれる時だけ、頭出しの違う別の音源とみなして合わせる。
  if (Math.abs(med) < 1.0) {
    return Object.assign({}, cand, { registeredTo: ref.providerId, registerShift: 0, timebase: ref.timebase });
  }
  const shift = (t) => t + med;
  const lines = cand.lines.map(l => {
    const o = Object.assign({}, l, { start: shift(l.start) });
    if (Number.isFinite(l.end)) o.end = shift(l.end);
    if (l.words) o.words = l.words.map(w => Object.assign({}, w, { t: shift(w.t), end: Number.isFinite(w.end) ? shift(w.end) : undefined }));
    if (l.bg) o.bg = Object.assign({}, l.bg, { start: shift(l.bg.start), end: Number.isFinite(l.bg.end) ? shift(l.bg.end) : undefined, words: (l.bg.words || []).map(w => ({ t: shift(w.t), c: w.c })) });
    return o;
  });
  return Object.assign({}, cand, { lines, registeredTo: ref.providerId, registerShift: med, timebase: ref.timebase });
}

// 候補から content.js の externalLyricsInfo を作る
function ytiInfoFromCandidate(c, base) {
  const lines = c.lines.map((l, i) => {
    const o = { baseTime: l.start, text: l.text, srcIndex: i };
    if (Number.isFinite(l.end)) o.end = l.end;
    if (l.words) o.words = l.words;
    if (l.bg) o.bg = l.bg;
    if (l.agent) o.agent = l.agent;
    return o;
  });
  const label = YTI_PROVIDER_LABEL[c.providerId] || c.providerId;
  return {
    lines,
    trackName: c.trackName || base.trackName || '',
    artistName: c.artistName || base.artistName || '',
    duration: base.songDur || c.duration || 0,
    source: label + (c.registeredTo ? (c.registerShift ? ' → ' + (YTI_PROVIDER_LABEL[c.registeredTo] || c.registeredTo) + 'の頭出しに補正' :
      '（' + (YTI_PROVIDER_LABEL[c.registeredTo] || c.registeredTo) + 'と照合済み）') : '') +
      (c.quality >= 2 ? '・語同期' : ''),
    provider: c.providerId,
    quality: c.quality || 1,
    // 公式の対応表は「曲の時計」の歌詞にだけ当てる。LRCHub がこの動画に紐付けた時刻はもう動画の時計。
    segments: (c.timebase === 'song') ? (base.segments || []) : [],
    timebase: c.timebase || 'song',
    official: c.providerId === 'ytm' || c.registeredTo === 'ytm',
    translation: c.translation || base.translation || null,
    romanization: c.romanization || base.romanization || null,
    singers: c.singers || base.singers || null,
    songKey: base.songKey || '',
    songVideoId: base.songVideoId || '',
    alternatives: base.alternatives || [],
  };
}

function ytiSongKey(res, want) {
  if (res && res.songVideoId) return 'song:' + res.songVideoId;
  const t = YTICore.text.normTitleLoose(want.track || '');
  const a = YTICore.text.normalizeArtist(want.artist || '');
  return t ? 'title:' + YTICore.text.hash32(t + '|' + a) : '';
}

// 既存の LRCLIB 検索（content.js）を候補の形に
async function ytiLrclibCandidate(meta, videoDur) {
  try {
    const o = await findLrclibLyrics(meta, videoDur);
    if (!o || !o.result) return null;
    const r = o.result;
    return ytiCandidateFrom({
      provider: 'lrclib', lines: r.lines.map(l => ({ start: l.baseTime, text: l.text })), quality: 1,
      trackName: r.trackName, artistName: r.artistName, duration: r.duration,
    });
  } catch (e) {
    return null;
  }
}

// 本体。onUpgrade(info) は、先に出した歌詞より良いもの（語単位）が後から見つかった時に呼ぶ。
async function findExternalLyricsDoc(videoId, opts) {
  opts = opts || {};
  const warm = !!opts.warm;
  // 取得の経過（先読みの時は今の動画の経過を汚さないよう記録しない）
  const tr = (stage, detail) => {
    if (!warm && typeof ytiTrace === 'function') ytiTrace(videoId, stage, detail);
  };
  const cacheKey = YTI_EXT2_PREFIX + videoId;
  if (!opts.noCache) {
    const saved = await ytiStoreGet(cacheKey);
    if (saved && saved.at) {
      const age = Date.now() - saved.at;
      if (saved.miss && age < YTI_EXT2_MISS_TTL) return null;
      if (saved.info && age < YTI_EXT2_TTL && saved.info.quality >= 2) return saved.info;
      // 行単位でしか取れていなかった曲は、語単位が後から登録されているかもしれないので、
      // 保存分を即座に返しつつ裏で取り直す
      if (saved.info && age < YTI_EXT2_TTL && !warm) {
        if (typeof opts.onUpgrade === 'function') {
          findExternalLyricsDoc(videoId, Object.assign({}, opts, { noCache: true, onUpgrade: null }))
            .then(info => {
              if (info && info.quality > saved.info.quality) opts.onUpgrade(info);
            }).catch(() => {});
        }
        return saved.info;
      }
    }
  }
  // 曲の手がかり。warm（次の動画の先読み）はページの DOM が別の動画なので使わない。
  // 曲の特定（YouTube Music）は videoId だけで始められるので、ページの曲名の読み取りを待たずに投げる。
  // ページの曲名（概要欄のミュージック）は、ダンス練習・ステージ等の動画で曲を探す手がかりとして後から渡す。
  const metaP = warm ? Promise.resolve({ title: '', artist: '', album: '' }) : getMusicMetadata(videoId).catch(() => ({ title: '', artist: '', album: '' }));
  const resolverP = ytiMusicResolver.resolve(videoId, metaP.then(m => ({ title: m.title, artist: m.artist }))).catch(() => null);
  // LRCHub も videoId で引ける
  const lrchubP = ytiAskProvider('lrchub', { videoId });
  const meta = await metaP;
  const videoDur = (!warm && targetVideo && isFinite(targetVideo.duration)) ? targetVideo.duration : 0;
  const res = await ytiWithTimeout(resolverP, 5000);
  tr('YouTube Music', !res ? '応答なし' : (res.lyrics ? `${res.via || '-'} / ${res.lyrics.kind}` +
    (res.lyrics.lines ? ` ${res.lyrics.lines.length}行` : '') + (res.segments && res.segments.length ? ` / 対応表 ${res.segments.length}区間` : ' / 対応表なし') +
    (res.lyrics.source ? ` (${res.lyrics.source})` : '') : `歌詞なし (${res.musicVideoType || '?'})`));
  // 曲（音源版）の長さ。対応表があればその合計、無ければ YouTube Music の音源版の長さ
  const songDur = (res && res.segments && res.segments.length) ? res.segments.reduce((a, s) => a + s.dur, 0) :
    ((res && res.songLengthSec) || ((res && res.musicVideoType === 'ATV') ? videoDur : 0));
  const want = {
    track: (res && res.title) || meta.title || '',
    artist: (res && res.artistName) || meta.artist || '',
    album: (res && res.album) || meta.album || '',
    durationSec: songDur || 0,
    videoId,
  };
  if (!want.track) {
    if (!warm) ytiStoreSet(cacheKey, { at: Date.now(), miss: true });
    return null;
  }
  const base = {
    trackName: want.track,
    artistName: want.artist,
    songDur,
    segments: (res && res.segments) || [],
    songKey: ytiSongKey(res, want),
    songVideoId: (res && res.songVideoId) || '',
  };

  // 同じ曲の別の動画（MV・ダンス練習・ステージ等）で一度決めた歌詞があれば、それを使う。
  // 時刻は曲の時計なので、この動画への写し方（対応表・自動同期）だけがこの動画ごとに決まる。
  const songDocKey = base.songKey ? 'songdoc2:' + base.songKey : '';
  if (songDocKey && !opts.noCache) {
    const sd = await ytiStoreGet(songDocKey);
    if (sd && sd.at && Date.now() - sd.at < YTI_EXT2_TTL && sd.cand && sd.cand.quality >= 2) {
      const info = ytiInfoFromCandidate(sd.cand, base);
      ytiStoreSet(cacheKey, { at: Date.now(), info });
      return info;
    }
  }
  const cands = [];
  let ytm = null;
  if (res && res.lyrics && res.lyrics.kind === 'timed') {
    ytm = ytiCandidateFrom({
      provider: 'ytm', lines: res.lyrics.lines, quality: 1, trackName: res.title, artistName: res.artistName,
    }, { sourceDetail: res.lyrics.source || '' });
    if (ytm) cands.push(ytm);
  }
  // 語単位の取得元と LRCLIB。届いた順に候補へ。
  const tasks = YTI_WORD_PROVIDERS.map(p => (p === 'lrchub' ? lrchubP : ytiAskProvider(p, want)).then(r => {
    const c = ytiCandidateFrom(r);
    tr(YTI_PROVIDER_LABEL[p] || p, c ? `${c.lines.length}行 ${c.quality >= 2 ? '語同期' : '行同期'}${c.timebase === 'video' ? ' / この動画の時刻' : ''}` : 'なし');
    return c;
  }));
  if (!warm) {
    const lrclibMeta = Object.assign({}, meta, { title: want.track, artist: want.artist, fromStructured: !!(res && res.title) || meta.fromStructured });
    tasks.push(ytiLrclibCandidate(lrclibMeta, videoDur).then(c => {
      tr('LRCLIB', c ? `${c.lines.length}行` : 'なし');
      return c;
    }));
  }
  // 曲より大幅に長い歌詞は別物（長さが分かる時だけ）
  const plausible = (c) => {
    const last = c.lines[c.lines.length - 1].start;
    if (songDur > 30 && last > songDur + 8) return false;
    if (!songDur && videoDur > 30 && last > videoDur * 1.6) return false;
    return true;
  };

  const decide = (all) => {
    const ok = all.filter(Boolean).filter(plausible);
    if (!ok.length) return null;
    const { picked, verdicts } = YTICore.text.pickAgreedLyrics(
      ok.map(c => ({ key: c.key, providerId: c.providerId, lyrics: c.lines, quality: c.quality, cand: c })),
      [], { track: want.track });
    if (!picked) return null;
    let chosen = picked.cand;
    // 公式歌詞があれば、それと本文が一致する語単位の候補を、時刻を公式に揃えて使う。
    // LRCHub がこの動画に紐付けた時刻（動画の時計）は、公式の対応表が無い時はそのまま使う方が正確。
    const ref = ok.find(c => c.providerId === 'ytm');
    if (ref) {
      const hasSegs = base.segments.length > 0;
      const words = ok.filter(c => c.quality >= 2 && c.providerId !== 'ytm' && verdicts.get(c.key) !== 'contradicted' &&
        YTICore.text.lyricsAgreement(c.lines, ref.lines) >= 0.7)
        .sort((a, b) => YTICore.text.trustOf(a.providerId) - YTICore.text.trustOf(b.providerId));
      let best = null;
      for (const w of words) {
        if (w.timebase === 'video' && !hasSegs) {
          best = w;
          break;
        }
        const reg = ytiRegisterTo(w, ref);
        if (reg) {
          best = reg;
          break;
        }
      }
      chosen = best || ref;
    }
    // 他の取得元の訳・ローマ字・歌い手は、本文が一致していれば借りる
    const borrow = (field) => {
      if (chosen[field]) return;
      const donor = ok.find(c => c[field] && (c[field].lines ? c[field].lines.length : c[field].length) &&
        YTICore.text.lyricsAgreement(c.lines, chosen.lines) >= 0.7);
      if (donor) chosen = Object.assign({}, chosen, { [field]: donor[field], [field + 'From']: donor.providerId });
    };
    borrow('translation');
    borrow('romanization');
    borrow('singers');
    // 曲の時計の歌詞（動画に紐付いた時刻でないもの）は、曲単位でも覚える
    if (songDocKey && chosen.timebase === 'song') ytiStoreSet(songDocKey, { at: Date.now(), cand: chosen });
    return ytiInfoFromCandidate(chosen, Object.assign({}, base, {
      alternatives: ok.filter(c => c !== picked.cand).map(c => c.providerId),
    }));
  };

  let info = null;
  if (ytm && !warm && typeof opts.onUpgrade === 'function') {
    // 公式歌詞は先に出し、語単位の候補は裏で集めて格上げする
    info = ytiInfoFromCandidate(ytm, base);
    // 本文の一致する語単位の候補が1つ届いた時点で格上げする（遅い取得元を待たない）
    const got = [ytm];
    let upgraded = false;
    tasks.forEach(t => ytiWithTimeout(t, 9000).then(c => {
      if (!c || upgraded) return;
      got.push(c);
      if (c.quality < 2) return;
      const better = decide(got.slice());
      if (better && better.quality > info.quality) {
        upgraded = true;
        tr('格上げ', better.source);
        ytiStoreSet(cacheKey, { at: Date.now(), info: better });
        opts.onUpgrade(better);
      }
    }).catch(() => {}));
  } else {
    // 公式歌詞が無い：候補が揃うのを待つ。2つが一致した時点で打ち切る。
    const got = [];
    if (ytm) got.push(ytm);
    await new Promise((resolve) => {
      let pending = tasks.length;
      let graceTimer = null;
      const timer = setTimeout(resolve, YTI_CANDIDATE_WAIT_MS);
      const check = () => {
        if (got.length >= 2) {
          const v = YTICore.text.judgeLyrics(got.map(c => ({ key: c.key, providerId: c.providerId, lyrics: c.lines })), { track: want.track });
          const confirmed = got.filter(c => c.quality >= 2 && v.get(c.key) === 'confirmed');
          if (confirmed.length && !graceTimer) {
            // 信頼の高い取得元（手打ちの AMLL など）が少し遅れて届くことがあるので、少しだけ待つ
            const bestTrust = Math.min(...confirmed.map(c => YTICore.text.trustOf(c.providerId)));
            graceTimer = setTimeout(() => {
              clearTimeout(timer);
              resolve();
            }, bestTrust <= YTICore.text.trustOf('amll') ? 0 : 600);
          }
        }
      };
      tasks.forEach(t => t.then(c => {
        if (c) got.push(c);
        pending -= 1;
        if (pending === 0) {
          clearTimeout(timer);
          resolve();
        } else check();
      }).catch(() => {
        pending -= 1;
        if (pending === 0) {
          clearTimeout(timer);
          resolve();
        }
      }));
    });
    info = decide(got);
  }
  tr('決定', info ? info.source : '見つからず');
  if (info) ytiStoreSet(cacheKey, { at: Date.now(), info });
  else ytiStoreSet(cacheKey, { at: Date.now(), miss: true });
  return info;
}

// ===== 次の動画の先読み =====
function ytiRequestNextVideoId(videoId) {
  return new Promise((resolve) => {
    let done = false;
    const handler = (e) => {
      let d = null;
      try {
        d = JSON.parse(e.detail);
      } catch (_) {}
      if (!d || d.videoId !== videoId) return;
      done = true;
      window.removeEventListener('YTI_NextVideoResponse', handler);
      resolve(d.next || '');
    };
    window.addEventListener('YTI_NextVideoResponse', handler);
    setTimeout(() => {
      if (done) return;
      window.removeEventListener('YTI_NextVideoResponse', handler);
      // MAIN 世界から取れない時はプレイヤーの「次へ」ボタンのリンクを見る
      let next = '';
      try {
        const a = document.querySelector('.ytp-next-button[href]');
        const m = a && String(a.getAttribute('href')).match(/[?&]v=([A-Za-z0-9_-]{11})/);
        if (m) next = m[1];
      } catch (_) {}
      resolve(next);
    }, 800);
    try {
      window.dispatchEvent(new CustomEvent('YTI_RequestNextVideo', { detail: videoId }));
    } catch (_) {}
  });
}

let ytiPrefetchedFor = '';
async function ytiPrefetchNext(videoId) {
  if (!videoId || ytiPrefetchedFor === videoId) return;
  if (!getMvOption('mv_external_lyrics', true)) return;
  ytiPrefetchedFor = videoId;
  const next = await ytiRequestNextVideoId(videoId);
  if (!next || next === videoId) return;
  try {
    console.info('[YT Immersion] 次の動画の歌詞を先読み: ' + next);
  } catch (e) {}
  findExternalLyricsDoc(next, { warm: true }).catch(() => {});
}

// サムネイル（watch?v= のリンク）を押した瞬間に曲の特定を始める。再生が始まるより先に終わる。
document.addEventListener('pointerdown', (ev) => {
  try {
    const link = ev.target && ev.target.closest && ev.target.closest('a[href*="watch?v="]');
    if (!link) return;
    const m = String(link.getAttribute('href') || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m && getMvOption('mv_external_lyrics', true)) ytiMusicResolver.prefetch(m[1]);
  } catch (e) {}
}, { capture: true, passive: true });

// ===== ASR による最終確認と時計合わせ =====
// 戻り値: { accepted, coverage, anchors, charTimes }。accepted=false なら、この歌詞はこの動画と合っていない。
function ytiCheckWithAsr(info, asrWords) {
  if (!info || !asrWords || !asrWords.length) return null;
  const lines = info.lines.map(l => ({ start: l.baseTime, end: l.end, text: l.text, words: l.words }));
  const r = YTICore.align.alignLyricsToAsr(lines, asrWords);
  const substantive = YTICore.align.asrHasSubstance(asrWords);
  // 公式歌詞（アーティストまで照合済み）は ASR が外れても疑わない（ASR は歌に弱い）
  const accepted = !substantive || info.official || r.coverage >= 0.12;
  return Object.assign(r, { accepted, substantive });
}

// ===== 音声の記録を視聴ページの再生開始から =====
// 音声による同期（audio_sync.js）は曲の頭から聞いていることが前提。以前は MV モードの
// 歌詞読み込みの中で記録を始めていたので、再生の途中から MV モードに入る一番よくある
// 使い方ではほぼ働かなかった。音楽カテゴリの動画は、再生が頭から始まった時点で
// 音量の記録だけ始めておく（聞こえる音には触らない）。MV モードに入ればそれを引き継ぐ。
let ytiPrimedFor = '';
function ytiMaybePrimeAudio(ev) {
  try {
    if (!getMvOption('mv_external_lyrics', true) || !isWatchPage()) return;
    const v = ev && ev.target;
    if (!v || v.tagName !== 'VIDEO' || !v.closest || !v.closest('#movie_player')) return;
    const vid = getVideoId();
    if (!vid || ytiPrimedFor === vid || v.currentTime > 2) return;
    // 広告の再生中は記録しない（本編の読み込み開始で記録は捨てられるが、無駄を避ける）
    const player = document.getElementById('movie_player');
    if (player && player.classList.contains('ad-showing')) return;
    const data = getPlayerVideoData();
    if (data && data.videoId === vid && data.category && data.category !== 'Music') {
      // 前の動画の記録が残っていれば止める（MV モードの判定中でなければ）
      if (ytiAudioSync.primedKey() && !ytiAudioSync.isRunning()) ytiAudioSync.stop();
      return;
    }
    ytiPrimedFor = vid;
    ytiAudioSync.prime(v, vid);
  } catch (e) {}
}
document.addEventListener('playing', ytiMaybePrimeAudio, true);
