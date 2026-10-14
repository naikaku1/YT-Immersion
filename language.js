// ===== 言語：訳と読み =====
// 1) 訳：見ている人の言語（既定はブラウザの言語）で、歌詞の下に訳を出す。取れる所から順に
//      ① この動画にある、その言語の字幕（手動）   … 時間の重なりで行に組み合わせる
//      ② 取得元が持つ訳（NetEase の中国語訳）       … 中国語が欲しい時だけ
//      ③ Chrome 内蔵の端末内翻訳（Translator API） … API キー不要・外部へ送らない
//    以前は日本語字幕が無い MV には訳が一切出なかった。
// 2) 読み：
//      - 日本語：ローマ字の行、または漢字のふりがな。NetEase のローマ字（歌われた音）から作るので、
//        当て字（本気＝マジ）も正しく出る。かなだけの行は手元でローマ字にする。
//      - 韓国語：ローマ字の行（カタカナのルビは従来の「韓国語の読み」）。
// content.js / lyrics_pipeline.js の後に読み込む。

const YTI_TARGET_LANG_KEY = 'mv_target_lang';
const YTI_ONDEVICE_TR_KEY = 'mv_ondevice_translate';
const YTI_READING_JA_KEY = 'mv_reading_ja';   // 'none' | 'romaji' | 'furigana'
const YTI_READING_KO_KEY = 'mv_reading_ko';   // 'none' | 'roma'

function ytiTargetLang() {
  const saved = localStorage.getItem(YTI_TARGET_LANG_KEY);
  if (saved) return saved;
  const nav = String((navigator.languages && navigator.languages[0]) || navigator.language || 'ja').toLowerCase();
  return nav.slice(0, 2);
}
const ytiNorm = (s) => YTICore.text.normalizeForMatch(s);

// 歌詞の言語（文字の種類から。ラテン文字の曲は字幕の言語か、端末内の言語判定に任せる）
function ytiScriptLang(texts) {
  const all = texts.join('\n');
  const n = (re) => (all.match(re) || []).length;
  const kana = n(/[぀-ヿ]/g);
  const hangul = n(/[가-힯]/g);
  const han = n(/[一-鿿]/g);
  const latin = n(/[A-Za-z]/g);
  const max = Math.max(kana, hangul, han, latin);
  if (!max) return '';
  if (kana && kana * 3 >= han && kana >= latin * 0.2) return 'ja';
  if (hangul === max || hangul > latin * 0.3) return 'ko';
  if (han === max) return kana ? 'ja' : 'zh';
  return 'latin';
}

// ── 端末内翻訳の呼び出し（MAIN 世界の橋渡し：page_script.js） ───────────────
let ytiTrReqSeq = 0;
function ytiTranslateCall(payload, timeoutMs) {
  return new Promise((resolve) => {
    const id = 'tr' + (++ytiTrReqSeq) + '_' + Date.now();
    let done = false;
    const handler = (e) => {
      let d = null;
      try {
        d = JSON.parse(e.detail);
      } catch (_) {}
      if (!d || d.id !== id) return;
      done = true;
      window.removeEventListener('YTI_TranslateResponse', handler);
      resolve(d);
    };
    window.addEventListener('YTI_TranslateResponse', handler);
    setTimeout(() => {
      if (done) return;
      window.removeEventListener('YTI_TranslateResponse', handler);
      resolve({ ok: false, status: 'timeout' });
    }, timeoutMs || 60000);
    try {
      window.dispatchEvent(new CustomEvent('YTI_TranslateRequest', { detail: JSON.stringify(Object.assign({ id }, payload)) }));
    } catch (_) {
      resolve({ ok: false, status: 'error' });
    }
  });
}

// ── 今の動画の訳・読み ─────────────────────────────────────
const ytiLang = {
  videoId: '',
  srcLang: '',
  trMap: new Map(),      // 本文（正規化）→ 訳
  trSource: '',
  readingMap: new Map(), // 本文（正規化）→ ローマ字（歌われた音）
  pendingOnDevice: null, // ダウンロードが要る時のボタン用
};
function ytiLangReset(videoId) {
  ytiLang.videoId = videoId;
  ytiLang.srcLang = '';
  ytiLang.trMap = new Map();
  ytiLang.trSource = '';
  ytiLang.readingMap = new Map();
  ytiLang.pendingOnDevice = null;
}

function ytiCurrentLyricTexts() {
  return (lyricsData || []).filter(l => !l.isInstrumental && l.text).map(l => l.text.split(/\r?\n/)[0]);
}

// 訳・読みを今の歌詞へ反映して描き直す
function ytiLangRefresh() {
  const la = document.getElementById('mv-lyrics-area');
  if (usingExternalLyrics && externalLyricsInfo) {
    applyExternalLyricsData();
    // 行・時刻が同じなら applyExternalLyricsData は描き直さないので、ここで描き直す
    if (la && lyricsData.length) renderLyricsDOM(la);
  } else {
    for (const l of lyricsData || []) ytiDecorateLanguage(l);
    if (la && lyricsData.length) renderLyricsDOM(la);
  }
  try {
    syncLyrics();
  } catch (e) {}
  scrollMvLyricsToActive(true);
}

// 1行に訳・読み・ふりがなを付ける（字幕の歌詞・外部歌詞の両方で使う）
function ytiDecorateLanguage(line) {
  if (!line || line.isInstrumental || !line.text) return;
  const text = line.text.split(/\r?\n/)[0];
  const key = ytiNorm(text);
  if (!line.subText && ytiLang.trMap.has(key)) {
    const tr = ytiLang.trMap.get(key);
    if (tr && ytiNorm(tr) !== key) {
      line.subText = tr;
      line.subIsMachine = ytiLang.trSource === 'ondevice';
    }
  }
  line.reading = '';
  line.ruby = null;
  // ふりがな・ローマ字は実験的な機能（既定では隠す）
  const extras = ytiExtrasEnabled();
  const jaMode = extras ? (localStorage.getItem(YTI_READING_JA_KEY) || 'none') : 'none';
  const koMode = extras ? (localStorage.getItem(YTI_READING_KO_KEY) || 'none') : 'none';
  if (/[぀-ヿ一-鿿]/.test(text) && jaMode !== 'none') {
    let roma = ytiLang.readingMap.get(key) || '';
    if (!roma && !/[一-鿿]/.test(text)) roma = YTICore.kana.kanaToRomaji(text);
    if (jaMode === 'romaji' && roma) line.reading = roma;
    if (jaMode === 'furigana' && roma) {
      const hira = YTICore.kana.romajiToHiragana(roma);
      const segs = hira ? YTICore.kana.furiganaFromReading(text, hira) : null;
      if (segs) line.ruby = segs;
    }
  } else if (/[가-힯]/.test(text) && koMode === 'roma') {
    line.reading = ytiKoreanRuby.romanize(text);
  }
}

// ── 読み：NetEase の「歌詞の行」と「ローマ字の行」を時刻で組んで、本文→ローマ字の表を作る ──
async function ytiLoadReadings(videoId, token, texts) {
  const jaMode = ytiExtrasEnabled() ? (localStorage.getItem(YTI_READING_JA_KEY) || 'none') : 'none';
  if (jaMode === 'none' || ytiScriptLang(texts) !== 'ja') return false;
  let src = null;
  if (externalLyricsInfo && externalLyricsInfo.provider === 'netease' && externalLyricsInfo.romanization) {
    src = { lines: externalLyricsInfo.lines.map(l => ({ start: l.baseTime, text: l.text })), romanization: externalLyricsInfo.romanization };
  } else {
    let meta = null;
    try {
      meta = await getMusicMetadata(videoId);
    } catch (e) {}
    const track = (externalLyricsInfo && externalLyricsInfo.trackName) || (meta && meta.title) || '';
    const artist = (externalLyricsInfo && externalLyricsInfo.artistName) || (meta && meta.artist) || '';
    if (!track) return false;
    src = await ytiAskProvider('netease', { track, artist });
  }
  if (token !== mvContentToken || ytiLang.videoId !== videoId) return false;
  if (!src || !Array.isArray(src.romanization) || !src.romanization.length) return false;
  const roma = src.romanization;
  let added = 0;
  for (const l of src.lines) {
    let best = null;
    for (const r of roma) if (!best || Math.abs(r.start - l.start) < Math.abs(best.start - l.start)) best = r;
    if (!best || Math.abs(best.start - l.start) > 1.0) continue;
    const k = ytiNorm(l.text);
    if (k && !ytiLang.readingMap.has(k)) {
      ytiLang.readingMap.set(k, best.text);
      added++;
    }
  }
  return added > 0;
}

// ── 訳 ────────────────────────────────────────────────
// ① この動画にある、見ている人の言語の字幕（手動）。時間の重なりで今の行に組み合わせる。
async function ytiTranslationFromCaptions(videoId, token, target) {
  let list = null;
  try {
    list = await getCaptionTracklistFromPlayer();
  } catch (e) {}
  const tracks = (list && list.list) || [];
  const t = tracks.find(tr => String(tr.languageCode || '').toLowerCase().startsWith(target) &&
    tr.kind !== 'asr' && !(tr.vssId && String(tr.vssId).startsWith('a.')));
  if (!t) return false;
  const track = { code: t.languageCode, name: (t.name && t.name.simpleText) || t.languageCode, vssId: t.vssId, baseUrl: t.baseUrl };
  await requestCacheFromPage(videoId);
  let raw = getCachedCaptionForTrack(videoId, track);
  if ((!raw || !raw.length) && track.baseUrl) raw = await fetchCaptionTrack(track.baseUrl);
  if (token !== mvContentToken || ytiLang.videoId !== videoId || !raw || !raw.length) return false;
  const main = (lyricsData || []).filter(l => !l.isInstrumental);
  const paired = YTICore.pairing.pairLines(
    main.map(l => ({ start: l.time, end: l.duration ? l.time + l.duration : undefined, text: l.text })),
    raw.map(r => ({ start: r.time, end: r.duration ? r.time + r.duration : undefined, text: r.text })));
  let n = 0;
  main.forEach((l, i) => {
    if (paired[i]) {
      ytiLang.trMap.set(ytiNorm(l.text.split(/\r?\n/)[0]), paired[i]);
      n++;
    }
  });
  if (n) ytiLang.trSource = 'caption:' + track.code;
  return n > 0;
}

// ② 取得元の訳（NetEase の中国語訳）
function ytiTranslationFromProvider(target) {
  const info = externalLyricsInfo;
  const tr = info && info.translation;
  if (!tr || !tr.lines || !tr.lines.length || !String(target).startsWith(tr.lang || '')) return false;
  let n = 0;
  for (const l of info.lines) {
    let best = null;
    for (const r of tr.lines) if (!best || Math.abs(r.start - l.baseTime) < Math.abs(best.start - l.baseTime)) best = r;
    if (best && Math.abs(best.start - l.baseTime) <= 1.0 && best.text) {
      ytiLang.trMap.set(ytiNorm(l.text), best.text);
      n++;
    }
  }
  if (n) ytiLang.trSource = 'provider';
  return n > 0;
}

// ③ 端末内翻訳。行をまとめて訳し、行数が合わなければ1行ずつ。結果は曲ごとに保存。
async function ytiTranslateOnDevice(videoId, token, srcLang, target, texts) {
  const uniq = [...new Set(texts.map(t => t.trim()).filter(Boolean))];
  const cacheKey = 'trs:' + target + ':' + YTICore.text.hash32(uniq.slice(0, 20).join('|'));
  const saved = await ytiStoreGet(cacheKey);
  if (saved && saved.map) {
    for (const [k, v] of Object.entries(saved.map)) ytiLang.trMap.set(k, v);
    ytiLang.trSource = 'ondevice';
    return true;
  }
  const out = {};
  const CHUNK = 12;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const part = uniq.slice(i, i + CHUNK);
    const r = await ytiTranslateCall({ op: 'translate', source: srcLang, target, texts: [part.join('\n')] }, 120000);
    if (token !== mvContentToken || ytiLang.videoId !== videoId) return false;
    if (!r.ok) return false;
    let lines = String((r.texts && r.texts[0]) || '').split('\n');
    if (lines.length !== part.length) {
      const r2 = await ytiTranslateCall({ op: 'translate', source: srcLang, target, texts: part }, 120000);
      if (!r2.ok) return false;
      lines = r2.texts || [];
    }
    part.forEach((t, j) => {
      if (lines[j]) out[ytiNorm(t)] = lines[j].trim();
    });
  }
  for (const [k, v] of Object.entries(out)) ytiLang.trMap.set(k, v);
  ytiLang.trSource = 'ondevice';
  ytiStoreSet(cacheKey, { at: Date.now(), map: out });
  return true;
}

// ダウンロードが要る時は、ヘッダーに「訳を表示」のボタンを出す（押した流れで翻訳モデルを落とす）
function ytiShowOnDeviceButton(videoId, token, srcLang, target, texts) {
  const header = document.getElementById('mv-lyrics-header');
  if (!header || header.querySelector('.yti-tr-btn')) return;
  const b = document.createElement('button');
  b.className = 'mv-lyric-action-btn yti-tr-btn';
  b.textContent = '訳を表示（端末内）';
  b.title = 'Chrome 内蔵の翻訳で訳を作ります。初回だけ翻訳モデルのダウンロードがあります。歌詞は外へ送られません';
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    b.textContent = '翻訳中…';
    const ok = await ytiTranslateOnDevice(videoId, token, srcLang, target, texts);
    b.remove();
    if (ok) {
      ytiLangRefresh();
      showToast('端末内翻訳で訳を付けました');
    } else showToast('翻訳できませんでした');
  };
  header.appendChild(b);
}

const YTI_LANG_NAMES = { ja: '日本語', en: 'English', ko: '한국어', zh: '中文', es: 'Español', pt: 'Português', id: 'Indonesia', th: 'ไทย', vi: 'Tiếng Việt', fr: 'Français', de: 'Deutsch' };

async function ytiOnLyricsReadyLanguage(videoId, token, kind) {
  if (ytiLang.videoId !== videoId) ytiLangReset(videoId);
  const texts = ytiCurrentLyricTexts();
  if (!texts.length) return;
  let changed = false;
  // 読み
  try {
    if (await ytiLoadReadings(videoId, token, texts)) changed = true;
  } catch (e) {}
  if (token !== mvContentToken) return;
  // 訳（もう訳が付いている＝原文と訳の2本の字幕があるなら何もしない）
  const target = ytiTargetLang();
  const script = ytiScriptLang(texts);
  let srcLang = script === 'latin' ? '' : script;
  const hasSub = (lyricsData || []).some(l => l.subText);
  if (!hasSub && srcLang !== target) {
    let got = false;
    if (kind === 'external') got = await ytiTranslationFromCaptions(videoId, token, target).catch(() => false);
    if (!got) got = ytiTranslationFromProvider(target);
    if (!got && ytiExtrasEnabled() && getMvOption(YTI_ONDEVICE_TR_KEY, true)) {
      if (!srcLang) {
        const d = await ytiTranslateCall({ op: 'detect', text: texts.slice(0, 12).join('\n') }, 15000);
        srcLang = (d && d.ok && d.lang) ? d.lang.slice(0, 2) : '';
      }
      if (srcLang && srcLang !== target) {
        const av = await ytiTranslateCall({ op: 'availability', source: srcLang, target }, 15000);
        if (av.ok && av.status === 'available') got = await ytiTranslateOnDevice(videoId, token, srcLang, target, texts);
        else if (av.ok && (av.status === 'downloadable' || av.status === 'downloading')) ytiShowOnDeviceButton(videoId, token, srcLang, target, texts);
      }
    }
    if (got) {
      changed = true;
      if (typeof ytiTrace === 'function') ytiTrace(videoId, '訳', `${YTI_LANG_NAMES[target] || target} / ${ytiLang.trSource}`);
    }
  }
  ytiLang.srcLang = srcLang;
  if (changed && token === mvContentToken) ytiLangRefresh();
}

// ── 描画：読みの行・ふりがな ─────────────────────────────────
// ふりがなは漢字の塊ごと。カラオケで語（文字）に分けた行は、漢字の塊が1つの語に収まるよう語を束ねてから振る。
function ytiApplyRuby(line, el) {
  const span = el.querySelector('.lyric-line');
  if (!span || !line.ruby) return;
  const segs = line.ruby;
  if (line.wordRow) {
    // 語の span の中に収まる漢字の塊にだけ振る（語をまたいで束ねると、語ごとの時刻が崩れる）
    const segAt = [];
    let off = 0;
    for (const sg of segs) {
      const n = Array.from(sg.text).length;
      if (sg.reading) segAt.push({ s: off, e: off + n, sg });
      off += n;
    }
    let pos = 0;
    for (const node of Array.from(span.childNodes)) {
      const chars = Array.from(node.textContent || '');
      const t0 = pos;
      pos += chars.length;
      if (node.nodeType !== 1 || !node.classList.contains('yti-w')) continue;
      const inside = segAt.filter(x => x.s >= t0 && x.e <= pos);
      if (!inside.length) continue;
      node.textContent = '';
      let c = t0;
      for (const x of inside) {
        if (x.s > c) node.appendChild(document.createTextNode(chars.slice(c - t0, x.s - t0).join('')));
        const ruby = document.createElement('ruby');
        ruby.textContent = x.sg.text;
        const rt = document.createElement('rt');
        rt.textContent = x.sg.reading;
        ruby.appendChild(rt);
        node.appendChild(ruby);
        c = x.e;
      }
      if (c < pos) node.appendChild(document.createTextNode(chars.slice(c - t0).join('')));
    }
    line.wordRow.ready = false;
    return;
  }
  span.textContent = '';
  for (const sg of segs) {
    if (!sg.reading) {
      span.appendChild(document.createTextNode(sg.text));
      continue;
    }
    const ruby = document.createElement('ruby');
    ruby.textContent = sg.text;
    const rt = document.createElement('rt');
    rt.textContent = sg.reading;
    ruby.appendChild(rt);
    span.appendChild(ruby);
  }
}

ytiHooks.decorateLines.push((lines) => {
  for (const l of lines) ytiDecorateLanguage(l);
});
ytiHooks.decorateLineEl.push((line, el) => {
  if (line.isInstrumental) return;
  if (!line.reading && !line.ruby && !usingExternalLyrics) ytiDecorateLanguage(line);
  if (line.reading) {
    const r = document.createElement('span');
    r.className = 'lyric-line-reading';
    r.textContent = line.reading;
    el.insertBefore(r, el.firstChild);
  }
  if (line.ruby) ytiApplyRuby(line, el);
  if (line.subIsMachine) el.classList.add('yti-sub-machine');
});
ytiHooks.lyricsReady.push((videoId, token, kind) => {
  ytiOnLyricsReadyLanguage(videoId, token, kind).catch(() => {});
});
// 訳・読みの設定は実験的な機能（既定では隠す。訳は動画の字幕があれば設定なしで出る）
if (ytiExtrasEnabled()) {
  ytiHooks.settings.push((panel) => {
    const reload = () => {
      if (ytiLang.videoId) ytiLangReset(ytiLang.videoId);
      const vid = getVideoId();
      ytiOnLyricsReadyLanguage(vid, mvContentToken, usingExternalLyrics ? 'external' : 'caption')
        .then(() => ytiLangRefresh()).catch(() => {});
    };
    const sec = document.createElement('div');
    sec.className = 'mv-settings-title';
    sec.textContent = '訳・読み';
    panel.appendChild(sec);
    panel.appendChild(ytiMakeSelectRow('訳の言語', '歌詞の下に出す訳の言語（字幕 → 取得元の訳 → 端末内翻訳の順に探します）',
      YTI_TARGET_LANG_KEY, ytiTargetLang(), Object.entries(YTI_LANG_NAMES), () => {
        showToast('訳の言語を変更しました');
        loadedLyricsVideoId = '';
        updateMVContent(0);
      }));
    panel.appendChild(ytiMakeSelectRow('日本語の読み', 'ローマ字の行、または漢字のふりがな（歌われた音から作るので当て字も正しく出ます）',
      YTI_READING_JA_KEY, 'none', [['none', '表示しない'], ['furigana', 'ふりがな'], ['romaji', 'ローマ字']], reload));
    panel.appendChild(ytiMakeSelectRow('韓国語のローマ字', '韓国語の歌詞の上にローマ字（聞こえる音で）を出します',
      YTI_READING_KO_KEY, 'none', [['none', '表示しない'], ['roma', 'ローマ字']], reload));
  });
  // 端末内翻訳の入り切り（makeToggle は content.js の設定パネルの中の関数）
  ytiHooks.settings.push((panel, makeToggle) => {
    panel.appendChild(makeToggle('端末内翻訳を使う', 'Chrome 内蔵の翻訳で訳を作ります（API キー不要・歌詞は外へ送りません）', YTI_ONDEVICE_TR_KEY, true, (on) => {
      showToast(on ? '端末内翻訳をONにしました' : '端末内翻訳をOFFにしました');
    }));
  });
}
