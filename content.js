// 読み込まれている content.js が新旧どちらかを一目で判別するための目印。
// 拡張機能のリロードが効いていない時は、この行がコンソールに出ない。
console.info('%c[YT Immersion] build 0.10.0 / lyrics-core-v1', 'background:#0a84ff;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700');

document.addEventListener('yt-navigate-finish', onNavigate);
document.addEventListener('yt-page-data-updated', () => {
  // MVモードを閉じていても Mini Player(PiP) が開いていれば歌詞は追従させる
  if (rootContainer || pipWindow) {
    setTimeout(() => {
      if (!rootContainer && !pipWindow) return; // 遅延中に両方閉じていたら何もしない
      updateMetadataUI();
      // 同じ動画の読み込みが進行中なら二重に走らせない（字幕の強制切替どうしが競合する）
      if (ytiLoadingVideoId && ytiLoadingVideoId === getVideoId() && lyricsLoadDoneVideoId !== ytiLoadingVideoId) return;
      updateMVContent(0);
      updateSidebarContent(0);
    }, 2500);
  }
});
window.addEventListener('load', init);
let lastTitle = "";
let lastLyricIndex = -1;
// 歌詞DOMを組み直すたびに増やす世代番号。Mini Player(PiP)側はこれを見て
// 曲・言語の切り替わりを検知し、自分の歌詞リストを作り直す。
let lyricsRenderVersion = 0;
// syncLyrics が管理する現在のアクティブ行。毎フレームの querySelector を避けるため
// 自動スクロールのrAFループからも参照する。
let activeLyricLine = null;
let originalParent = null;
let originalNextSibling = null;
let targetVideo = null;
let rootContainer = null;
let lyricsData = [];
let lyricsByLanguage = {};
let currentLyricsLang = '';
let idleTimer = null;
let buttonObserverTimer = null;
let isInfoPinned = localStorage.getItem('mv_pin_mode') === 'true';
let isTitleAlwaysOn = localStorage.getItem('mv_always_title') === 'true';
// UI全体の拡大率（ユーザー設定）。モニター自動補正に掛け合わせる倍率で、既定は1.0。
let userUiScale = (() => {
  const v = parseFloat(localStorage.getItem('mv_ui_scale'));
  return (!isNaN(v) && v >= 0.7 && v <= 1.4) ? v : 1;
})();
// 真偽オプションの取得（未設定なら既定値）
function getMvOption(key, def) {
  const v = localStorage.getItem(key);
  if (v === null) return def;
  return v === 'true';
}
let sidebarObserver = null;
let isInitialized = false;
let savedVolume = null;
let lyricPositionIndex = 0;
let chekiLyricPos = 0;
// 歌詞ロードの世代トークン。新しいロードが始まったら古い非同期チェーンを無効化し、
// CCボタン連打などの取得競合（→取得失敗）を防ぐ。
let mvContentToken = 0;
// 現在表示中の歌詞がどの動画のものかを記録（遷移後の重複再取得を防ぐ）
let loadedLyricsVideoId = '';
// 歌詞の読み込みが進行中の動画（同じ動画の二重読み込みを防ぐ）
let ytiLoadingVideoId = '';
// 今の外部歌詞に当てている「曲の時計 → 動画の時計」（応援法・パート分けの時刻変換にも使う）
let ytiCurrentWarp = null;
// ===== 外部歌詞（LRCLIB）フォールバック =====
// 字幕がない/自動生成しかない動画で、LRCLIBの同期歌詞（LRC）を代わりに表示する。
// LRCは原曲基準の時計なので、MVのイントロ・間奏映像パートで生じるズレを
// 「アンカー列」（lrcTime→videoTimeの対応点の区分ステップ関数）で補正する。
let externalLyricsInfo = null; // { lines:[{baseTime,text}], trackName, artistName, duration }
let lyricsAnchors = [];        // [{lrcTime, videoTime}] lrcTime昇順
let usingExternalLyrics = false;
// ===== カラオケ風ハイライト =====
// ASR字幕(json3)の単語ごとの tOffsetMs を「時計」として借り、表示中の正しい歌詞
// （手動字幕/LRCLIB）の行内を左から塗る。テキストはASRを一切表示しない。
let asrWordStream = null;      // [{time, text}] 動画時計での単語列
let karaokeEnabledCache = null;
// ユーザーが手動スクロール中は自動スクロールを一時停止する（この時刻まで停止）
let userScrollUntil = 0;
// play/pause リスナー（付け外しできるようモジュールスコープで固定）
const playStatus = () => showCenterStatus('play');
const pauseStatus = () => showCenterStatus('pause');
// MVモードを起動してよいページか（/watch と /live/ の視聴ページのみ）
function isWatchPage() {
  return location.pathname.startsWith('/watch') || location.pathname.startsWith('/live/');
}

// ===== MAIN世界の字幕キャッシュ（window.__yt_lyrics_cache__）のISOLATED側ミラー =====
// content.js は ISOLATED 世界で動くため MAIN 世界の変数を直接は読めない。
// page_script.js が発火する YTI_CaptionData / YTI_CacheResponse 経由でミラーを保持する。
const ytiLyricsCache = {};
window.addEventListener('YTI_CaptionData', (e) => {
  try {
    const d = JSON.parse(e.detail);
    if (!d || !d.videoId || !d.text) return;
    if (!ytiLyricsCache[d.videoId]) {
      ytiLyricsCache[d.videoId] = {};
      // ページ側のキャッシュと同じく、新しい順に20本だけ残す
      const ids = Object.keys(ytiLyricsCache);
      for (let i = 0; i < ids.length - 20; i++) delete ytiLyricsCache[ids[i]];
    }
    ytiLyricsCache[d.videoId][d.key || '__default__'] = {
      text: d.text,
      lang: d.lang || '',
      tlang: d.tlang || '',
      name: d.name || '',
      url: d.url || ''
    };
  } catch (_) {}
});

// MAIN世界に蓄積された永続キャッシュを要求してミラーへ取り込む（リスナー登録前の取りこぼし対策）
function requestCacheFromPage(videoId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('YTI_CacheResponse', handler);
      resolve(ytiLyricsCache[videoId] || null);
    };
    const handler = (e) => {
      try {
        const d = JSON.parse(e.detail);
        if (d && d.videoId && d.entries) {
          if (!ytiLyricsCache[d.videoId]) ytiLyricsCache[d.videoId] = {};
          for (const k in d.entries) {
            if (k === '__last') continue;
            const ent = d.entries[k];
            if (ent && ent.text) {
              ytiLyricsCache[d.videoId][k] = {
                text: ent.text,
                lang: ent.lang || '',
                tlang: ent.tlang || '',
                name: ent.name || '',
                url: ent.url || ''
              };
            }
          }
        }
      } catch (_) {}
      finish();
    };
    window.addEventListener('YTI_CacheResponse', handler);
    window.dispatchEvent(new CustomEvent('YTI_RequestCache', { detail: videoId }));
    setTimeout(finish, 300);
  });
}

// ミラーキャッシュから指定トラックに一致する字幕を取り出し、パース済みセグメントを返す（0秒）
function getCachedCaptionForTrack(videoId, track) {
  if (!videoId || !track) return null;
  const entries = ytiLyricsCache[videoId];
  if (!entries) return null;
  const wantLang = track.code || '';
  let best = null;
  for (const k in entries) {
    if (k === '__last' || k === '__default__') continue;
    const ent = entries[k];
    if (!ent || !ent.text) continue;
    const langMatch = ent.lang === wantLang ||
      (track.vssId && ('.' + ent.lang) === String(track.vssId).replace(/^a\./, '.'));
    if (!langMatch) continue;
    if (ent.tlang) continue; // 自動翻訳(tlang付き)は原文トラックとは別物なので除外
    if (track.name && ent.name && ent.name === track.name) {
      best = ent;
      break; // name まで一致したら確定
    }
    if (!best) best = ent;
  }
  if (!best && entries['__default__'] && entries['__default__'].text) {
    best = entries['__default__'];
  }
  if (!best) return null;
  const segs = parseCaptionResponse(best.text);
  return (segs && segs.length > 0) ? segs : null;
}

function init() {
  if (isInitialized) return;
  isInitialized = true;
  try {
    startButtonObserver();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && rootContainer) endMVMode(false);
    });
    if (sessionStorage.getItem('mv_mode_active') === 'true' && !rootContainer) {
      setTimeout(() => startMVMode(true), 1500);
    }
  } catch (e) {}
}
async function onNavigate() {
  // 視聴ページ以外（ホーム等）へ遷移したらオーバーレイを畳む。
  // 放置するとホームのプレビュー動画を掴んだり、video復帰先が壊れたりする。
  if (!isWatchPage()) {
    if (rootContainer) endMVMode(true);
    return;
  }
  if (rootContainer && sessionStorage.getItem('mv_mode_active') === 'true') {
    // 遷移した瞬間にキャッシュを描く。ここで出しておけば、この後の待機と
    // 字幕トラック取得の時間が体感ゼロになる。無ければ従来どおりLoading表示。
    const lyricsArea = document.getElementById('mv-lyrics-area');
    if (!showLyricsFromCache(getVideoId())) {
      if (lyricsArea) lyricsArea.innerHTML = '<p style="opacity:0.5; font-size: 24px; padding: 40px;">Loading next track...</p>';
    }
    // 曲名はプレイヤーの情報から即座に出せる（取れなければ updateMetadataUI が再試行する）
    try {
      updateMetadataUI();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 600));
    startMVMode(true, true);
  } else {
    init();
    if (sessionStorage.getItem('mv_mode_active') === 'true') {
      await new Promise(r => setTimeout(r, 1800));
      startMVMode(true);
    } else if (pipWindow) {
      // MVモードは閉じているが Mini Player が開いている場合。
      // 曲が変わったら歌詞を出し直す（PiPは lyricsData を直接見ている）。
      if (!showLyricsFromCache(getVideoId())) {
        lyricsData = [];
        lyricsRenderVersion++;
      }
      await new Promise(r => setTimeout(r, 800));
      if (pipWindow) updateMVContent(0).catch(() => {});
    }
  }
}

let sidebarUpdateTimer = null;

// サイドバー（次はこちら）は現在CSSで非表示にしている。非表示の間は関連動画の監視も
// 組み立てもしない（YouTube側の書き換えのたびに20件を作り直す無駄を省く）。
function isSidebarEnabled() {
  const sb = document.getElementById('mv-sidebar');
  return !!sb && getComputedStyle(sb).display !== 'none';
}

function startSidebarObserver() {
  if (sidebarObserver) sidebarObserver.disconnect();
  sidebarObserver = null;
  if (!rootContainer || !isSidebarEnabled()) return;
  const targetNode = document.querySelector('ytd-watch-next-secondary-results-renderer #items') || document.querySelector('#secondary #items');
  if (!targetNode) {
    setTimeout(startSidebarObserver, 2000);
    return;
  }
  // 関連動画の欄は読み込み中に何十回も書き換わるので、落ち着いてから1回だけ組み直す
  sidebarObserver = new MutationObserver(() => {
    clearTimeout(sidebarUpdateTimer);
    sidebarUpdateTimer = setTimeout(() => updateSidebarContent(0), 600);
  });
  sidebarObserver.observe(targetNode, {
    childList: true
  });
  updateSidebarContent(0);
}

function startButtonObserver() {
  if (buttonObserverTimer) clearInterval(buttonObserverTimer);
  ensureControlButtons();
  buttonObserverTimer = setInterval(ensureControlButtons, 1500);
}

// プレイヤー右下のボタン群のうち、拡張のボタンを置く場所。
// 2025年以降のYouTube（.ytp-delhi-modern）は、右側の操作ボタンが高さ40pxの
// ピル型の背景（.ytp-right-controls-left / -right の2グループ）に入っている。
// 旧UIのつもりで .ytp-right-controls の先頭へ高さ48pxのボタンを差し込むと、
// ピルの外にはみ出して上下にずれ、UIから浮いて見えていた。
// 純正ボタンと同じグループの先頭に、同じ大きさのアイコンボタンとして置く。
function getControlButtonHost() {
  const player = document.getElementById('movie_player');
  const scope = player || document;
  return scope.querySelector('.ytp-right-controls-left') || scope.querySelector('.ytp-right-controls');
}

// 純正アイコンと同じく viewBox 24・線幅2の線画で描く
const YTI_CTRL_ICON_MV = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M11 10h7M8 13.5h10M13 17h5"/></svg>';
const YTI_CTRL_ICON_MINI = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M6 10h12M9 14h6M9 17.5h4"/></svg>';

function createControlButton(className, label, iconSvg, onClick) {
  const btn = document.createElement('button');
  btn.className = 'ytp-button ytp-yti-btn ' + className;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = iconSvg;
  btn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  };
  return btn;
}

// [MVモード][Mini Player] の順でグループの先頭に置く。
// YouTubeはプレイヤーの組み直しでボタン群を作り直すことがあるので、
// 1.5秒ごとに「正しい場所にあるか」だけを確かめ、外れていたら置き直す。
function ensureControlButtons() {
  try {
    const host = getControlButtonHost();
    if (!host) return;
    let mvBtn = document.querySelector('.ytp-mv-mode-button');
    if (!mvBtn) {
      mvBtn = createControlButton('ytp-mv-mode-button', 'MVモード', YTI_CTRL_ICON_MV, () => startMVMode(false));
    }
    let miniBtn = document.querySelector('.ytp-yti-mini-button');
    if (!miniBtn) {
      // requestWindow はユーザー操作の直後でないと拒否されるので、
      // 歌詞の読み込みより先に、awaitを挟まずPiPを開く。
      miniBtn = createControlButton('ytp-yti-mini-button', 'Mini Player（歌詞つき）', YTI_CTRL_ICON_MINI, startMiniPlayerStandalone);
    }
    if (mvBtn.parentNode !== host || host.firstChild !== mvBtn) host.insertBefore(mvBtn, host.firstChild);
    if (miniBtn.parentNode !== host || mvBtn.nextSibling !== miniBtn) host.insertBefore(miniBtn, mvBtn.nextSibling);
  } catch (e) {}
}

// MVモードを起動していない状態から Mini Player を開く。
// 再生中のvideo要素を掴んで歌詞の読み込みを走らせるところまでを面倒みる。
function startMiniPlayerStandalone() {
  if (!isWatchPage()) {
    showToast('動画の再生ページで使ってください');
    return;
  }
  if (pipWindow) {
    pipWindow.close();
    return;
  }
  const video =
    document.querySelector('#movie_player .video-stream.html5-main-video') ||
    document.querySelector('.video-stream.html5-main-video') ||
    document.querySelector('video');
  if (!video) {
    showToast('動画が見つかりませんでした');
    return;
  }
  targetVideo = video;
  try {
    if (!video.getAttribute('crossOrigin')) video.setAttribute('crossOrigin', 'anonymous');
  } catch (e) {}
  // ここで await しないのが肝心（ユーザー操作の権限を失わないため）
  enableMiniPlayerPiP();
  // 歌詞はPiPを開いた後に裏で用意する。
  // updateMVContent がキャッシュ→通常取得の順に面倒をみるので、
  // 既にこの動画の歌詞を持っている時だけ何もしない。
  const videoId = getVideoId();
  const alreadyLoaded = !!videoId && loadedLyricsVideoId === videoId && lyricsData.length > 0;
  if (!alreadyLoaded) {
    lyricsData = [];
    lyricsRenderVersion++;
    try {
      updateMVContent(0).catch(() => {});
    } catch (e) {}
  }
}

let settingsOutsideClickHandler = null;

async function startMVMode(isAuto = false, isHotSwap = false) {
  if (rootContainer && !isHotSwap) return;
  // watchページ以外では起動しない（ホームのプレビュー動画などを掴まないように）
  if (!isWatchPage()) return;
  // 実プレイヤー（#movie_player）内を最優先で探す。サムネイルのホバープレビュー等も
  // .html5-main-video を持つことがあり、document全体の先頭一致では誤選択しうる。
  const newTargetVideo =
    document.querySelector('#movie_player .video-stream.html5-main-video') ||
    (rootContainer && rootContainer.querySelector('.video-stream.html5-main-video')) ||
    document.querySelector('.video-stream.html5-main-video') ||
    document.querySelector('video');
  if (!newTargetVideo) {
    setTimeout(() => startMVMode(isAuto, isHotSwap), 1000);
    return;
  }
  sessionStorage.setItem('mv_mode_active', 'true');
  // 遷移でYouTubeがvideo要素を作り直した場合、古い要素のリスナーを外し、
  // オーバーレイ内に残った古いvideoを取り除く（2重video・同期停止の防止）
  if (targetVideo && targetVideo !== newTargetVideo) {
    targetVideo.removeEventListener('timeupdate', syncLyrics);
    targetVideo.removeEventListener('seeked', syncLyrics);
    targetVideo.removeEventListener('loadeddata', syncLyrics);
    targetVideo.removeEventListener('play', playStatus);
    targetVideo.removeEventListener('pause', pauseStatus);
    if (rootContainer && rootContainer.contains(targetVideo)) {
      try {
        targetVideo.pause();
        targetVideo.remove();
      } catch (e) {}
    }
  }
  targetVideo = newTargetVideo;
  if (targetVideo && savedVolume === null) {
    savedVolume = targetVideo.volume;
  }
  try {
    if (!targetVideo.getAttribute('crossOrigin')) {
      targetVideo.setAttribute('crossOrigin', 'anonymous');
    }
  } catch (e) {}
  // videoが既にオーバーレイ内にあるホットスワップ時は復帰先を上書きしない。
  // 上書きすると originalParent がオーバーレイ自身になり、MVモード終了時に
  // videoが画面から消えてしまう。
  if (!rootContainer || !rootContainer.contains(targetVideo)) {
    originalParent = targetVideo.parentNode;
    originalNextSibling = targetVideo.nextSibling;
  }
  if (!rootContainer) {
    rootContainer = document.createElement('div');
    rootContainer.id = 'mv-root-container';
    const styleEl = document.createElement('style');
    styleEl.textContent = `

            #mv-lyrics-area.mode-jp-only .type-native,
            #mv-lyrics-area.mode-jp-only .type-romaji { display: none !important; }

            #mv-lyrics-area.mode-native-only .type-jp,
            #mv-lyrics-area.mode-native-only .type-romaji { display: none !important; }

            #rm-lyrics-scroll.mode-jp-only .type-native,
            #rm-lyrics-scroll.mode-jp-only .type-romaji { display: none !important; }
            #rm-lyrics-scroll.mode-native-only .type-jp,
            #rm-lyrics-scroll.mode-native-only .type-romaji { display: none !important; }
            .rm-lyric-line { display: flex; flex-direction: column; align-items: flex-start; }

            #mv-lyrics-area {
                position: absolute;
                bottom: 60px;
                right: 60px;

                height: var(--mv-lyrics-height, calc((100vh - 60px) * 0.4));
                top: auto;

                width: 70vw;
                max-width: 1200px;
                overflow-y: scroll;
                padding: 5vh 0 10vh 0;
                box-sizing: border-box;
                mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
                -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
                pointer-events: auto;
                text-align: right;
                scrollbar-width: none;
                -ms-overflow-style: none;
                transition: height 0.1s linear, opacity 0.3s;
            }

            #mv-lyrics-header {
                position: absolute;
                bottom: calc(60px + var(--mv-lyrics-height, calc((100vh - 60px) * 0.4)) + 20px);
                right: 60px;
                width: 40vw;
                max-width: 500px;
                height: 40px;
                z-index: 100;
                display: flex;
                justify-content: flex-end;
                align-items: center;
                gap: 10px;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.3s ease;
            }

            #mv-lyrics-area::-webkit-scrollbar { display: none; }

            .lyric-line-container {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                justify-content: center;
                margin-bottom: calc(32px * var(--yti-scale, 1));
                position: relative;

                transform-origin: right center;

                transition: transform 0.4s cubic-bezier(0.2, 0, 0.2, 1);
            }

            .lyric-line {
                font-size: calc(32px * var(--yti-scale, 1));
                font-weight: 700;

                color: rgba(255, 255, 255, 0.15);

                filter: blur(1.5px);

                cursor: pointer;
                line-height: 1.5;
                font-feature-settings: "palt";
                letter-spacing: 0.02em;
                white-space: pre-wrap;
                /* 英単語を途中で切らず、日本語は文節の切れ目で折る */
                word-break: auto-phrase;
                line-break: strict;
                overflow-wrap: break-word;
                text-wrap: pretty;
                max-width: 100%;

                /* transition: all は全プロパティを監視するぶんスタイル再計算が重い。
                   実際に変化するのは色・ぼかし・光彩・拡大のみなので明示する。 */
                transition: color 0.6s cubic-bezier(0.16, 1, 0.3, 1),
                            filter 0.6s cubic-bezier(0.16, 1, 0.3, 1),
                            text-shadow 0.6s cubic-bezier(0.16, 1, 0.3, 1),
                            transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .lyric-line:hover {
                color: rgba(255,255,255,0.6);
                filter: blur(0px);
                transform: scale(1.02);
            }

            .lyric-line-container.active .lyric-line {
                color: #fff;

                filter: blur(0px);

                text-shadow: 0 0 20px rgba(255, 255, 255, 0.6);
            }

            .lyric-line-container.active {
                transform: scale(1.05);
            }
            #mv-root-container.hide-cursor { cursor: none !important; }
            #mv-root-container.hide-cursor * { cursor: none !important; }
            #mv-center-status { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8); width: 84px; height: 84px; background: rgba(0, 0, 0, 0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; z-index: 100; }
            #mv-center-status.animate { animation: mv-icon-pop 0.8s cubic-bezier(0.25, 0.1, 0.25, 1) forwards; }
            @keyframes mv-icon-pop { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); } 15% { opacity: 1; transform: translate(-50%, -50%) scale(1.0); } 30% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1.2); } }
            .mv-status-svg { width: 40px; height: 40px; fill: #fff; display: none; }
            #mv-song-title { font-size: calc(42px * var(--yti-scale, 1)); font-weight: 800; margin: 0 0 8px 0; line-height: 1.1; letter-spacing: -0.02em; color: #ffffff; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7); white-space: nowrap; overflow: hidden; display: block; max-width: 40vw; }
            #mv-song-title.marquee { display: flex; width: fit-content; }
            #mv-song-title.marquee span { display: inline-block; padding-right: 50px; animation: scroll-left 18s ease-in infinite; }
            @keyframes scroll-left { 0% { transform: translateX(0); } 20% { transform: translateX(0); } 100% { transform: translateX(-100%); } }
            .mv-header-group { position: absolute; top: 30px; display: flex; align-items: center; gap: 12px; z-index: 2000; pointer-events: none; }
            .mv-header-group > * { pointer-events: auto; position: static !important; margin: 0 !important; }
            .mv-header-group.left { left: 30px; }
            .mv-header-group.right { right: 30px; }

            .mv-header-group.right.active #mv-pin-btn { background: #ffffff !important; color: #000000 !important; border-color: transparent; box-shadow: 0 4px 12px rgba(0,0,0,0.2); text-shadow: none; }
            .mv-header-group.right.active #mv-pin-btn svg { stroke: #000000 !important; }

            #mv-root-container.no-lyrics-mode #mv-lyrics-area,
            #mv-root-container.no-lyrics-mode .rm-lyrics-container {
                display: none !important;
            }

            #mv-root-container.record-mode.no-lyrics-mode #mv-info-area {
                display: none !important;
            }

            #mv-root-container.record-mode.no-lyrics-mode .rm-left-pane {
                display: flex !important;
                flex-direction: column !important;

                justify-content: center !important;

                align-items: flex-start !important;

                height: 100% !important;
                padding-bottom: 0 !important;
            }

        `;
    rootContainer.appendChild(styleEl);
    const overlayContent = document.createElement('div');
    overlayContent.id = 'mv-overlay-content';
    overlayContent.innerHTML = `
            <div id="mv-lyrics-scrim"></div>
            <div id="mv-center-status">
                <svg id="mv-icon-play" class="mv-status-svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                <svg id="mv-icon-pause" class="mv-status-svg" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </div>
            <div id="mv-info-area"></div>
            <div id="mv-lyrics-header"></div>
            <div id="mv-lyrics-area"></div>
            <div id="mv-pos-slider-container" style="position: absolute; bottom: 30px; right: 60px; z-index: 2000; display: flex; align-items: center; gap: 8px; opacity: 0; transition: opacity 0.3s; pointer-events: none;">
                <span style="font-size: 10px; font-weight: 700; color: rgba(255,255,255,0.5);">POS</span>
<input type="range" id="mv-pos-slider" min="20" max="100" value="40" style="width: 80px; height: 4px; border-radius: 2px; -webkit-appearance: none; background: rgba(255,255,255,0.2); outline: none; cursor: pointer;">            </div>

            <div class="mv-header-group left">
                <button id="mv-shot-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot</button>
                <button id="mv-desktop-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Mini Player</button>
            </div>

            <!-- 右上のボタンは1つのflex列に並べる。Glassとスライダーはレコードモード専用で、
                 それ以外では display:none にして場所を取らない（以前は絶対座標で置いていたため、
                 ボタン幅の合計が変わると Record / 固定ボタンと重なっていた） -->
            <div class="mv-header-group right">
                <div id="mv-glass-slider-container">
                    <input type="range" id="mv-glass-slider" min="0" max="100" value="50">
                </div>
                <button id="mv-glass-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" opacity="0.4"/><rect x="7" y="7" width="10" height="10" rx="2" ry="2" opacity="0.7"/></svg> Glass</button>
                <button id="mv-settings-btn" class="mv-glass-btn" title="表示オプション"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
                <button id="mv-record-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" class="mv-ico-solid"/></svg> Record</button>
                <button id="mv-pin-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-3 4h10l-3-4V3M12 13v8"/></svg> 固定オフ</button>
                <button id="mv-close-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>

            <div class="record-mode-layout">
                <div class="rm-left-pane">
                    <div class="rm-title" id="rm-song-title">Title</div>
                    <div class="rm-artist" id="rm-artist-name">Artist</div>
                    <div class="rm-lyrics-container"><div class="rm-lyrics-scroll" id="rm-lyrics-scroll"></div></div>
                </div>

                <div class="rm-right-pane">
                    <div class="vinyl-wrapper">
                        <div class="vinyl-record" id="vinyl-record">
                            <div class="vinyl-label" id="vinyl-label"></div>
                        </div>

                        <div class="rm-tonearm-container">
                            <div class="arm-base"></div>
                            <div class="arm-pipe"> <div class="arm-weight"></div> <div class="arm-headshell"></div> </div>
                        </div>
                    </div>
                </div>
            </div>

        `;
    const closeBtn = overlayContent.querySelector('#mv-close-btn');
    if (closeBtn) closeBtn.onclick = () => endMVMode(false);
    const shotBtn = overlayContent.querySelector('#mv-shot-btn');
    if (shotBtn) shotBtn.onclick = startHybridShotSequence;
    const recordBtn = overlayContent.querySelector('#mv-record-btn');
    if (recordBtn) recordBtn.onclick = (e) => {
      e.stopPropagation();
      rootContainer.classList.toggle('record-mode');
      const isRec = rootContainer.classList.contains('record-mode');
      localStorage.setItem('mv_record_mode', isRec);
      const glassBtn = document.getElementById('mv-glass-btn');
      const glassSlider = document.getElementById('mv-glass-slider-container');
      if (isRec) {
        recordBtn.style.background = '#fff';
        recordBtn.style.color = '#000';
        showToast("Record Mode ON");
        if (glassBtn) glassBtn.classList.add('visible');
        if (glassSlider) glassSlider.classList.add('visible');
      } else {
        recordBtn.style.background = 'rgba(255,255,255,0.15)';
        recordBtn.style.color = '#fff';
        showToast("Record Mode OFF");
        if (glassBtn) glassBtn.classList.remove('visible');
        if (glassSlider) glassSlider.classList.remove('visible');
      }
    };
    const desktopBtn = overlayContent.querySelector('#mv-desktop-btn');
    if (desktopBtn) desktopBtn.onclick = (e) => {
      e.stopPropagation();
      enableMiniPlayerPiP();
    };
    const settingsBtn = overlayContent.querySelector('#mv-settings-btn');
    if (settingsBtn) {
      const panel = buildSettingsPanel();
      overlayContent.appendChild(panel);
      settingsBtn.onclick = (e) => {
        e.stopPropagation();
        if (panel.syncLetterboxToggles) panel.syncLetterboxToggles();
        panel.classList.toggle('open');
      };
      // パネルの外をクリックしたら閉じる。MVモードを開くたびに足していくと
      // 閉じても外れずに溜まり続けるので、1つだけ持って終了時に外す。
      if (settingsOutsideClickHandler) document.removeEventListener('click', settingsOutsideClickHandler);
      settingsOutsideClickHandler = (ev) => {
        if (!panel.classList.contains('open')) return;
        if (ev.target.closest('#mv-settings-panel') || ev.target.closest('#mv-settings-btn')) return;
        panel.classList.remove('open');
      };
      document.addEventListener('click', settingsOutsideClickHandler);
    }
    const glassBtn = overlayContent.querySelector('#mv-glass-btn');
    const glassSlider = overlayContent.querySelector('#mv-glass-slider');
    if (glassSlider) {
      const applyGlassEffect = (val) => {
        const blurPx = (val / 100) * 30;
        const opacity = (val / 100) * 0.6;
        rootContainer.style.setProperty('--glass-blur', `${blurPx}px`);
        rootContainer.style.setProperty('--glass-opacity', opacity);
      };
      applyGlassEffect(glassSlider.value);
      glassSlider.oninput = (e) => {
        e.stopPropagation();
        applyGlassEffect(e.target.value);
      };
      glassSlider.onclick = (e) => e.stopPropagation();
      const posSlider = overlayContent.querySelector('#mv-pos-slider');
      if (posSlider) {
        // 歌詞エリアの高さは「利用可能な縦幅に対する割合(%)」で保持する。
        // モニター解像度に依存せず、100%で歌詞エリアの上端が画面最上部に到達する。
        // （height = (100vh - 下端60px) * v/100、bottom:60px 固定）
        let saved = parseFloat(localStorage.getItem('mv_lyrics_height_vh'));
        if (isNaN(saved)) {
          // 旧バージョンの px 絶対値（100〜900）を割合に換算して引き継ぐ
          const legacyPx = parseFloat(localStorage.getItem('mv_lyrics_height'));
          saved = !isNaN(legacyPx) ? Math.round(legacyPx / 1080 * 100) : 40;
        }
        saved = Math.min(100, Math.max(20, saved));
        const applyLyricsHeight = (v) => {
          rootContainer.style.setProperty('--mv-lyrics-height', `calc((100vh - 60px) * ${v} / 100)`);
        };
        posSlider.value = saved;
        applyLyricsHeight(saved);
        localStorage.setItem('mv_lyrics_height_vh', saved);
        posSlider.oninput = (e) => {
          e.stopPropagation();
          const val = e.target.value;
          applyLyricsHeight(val);
          localStorage.setItem('mv_lyrics_height_vh', val);
        };
        posSlider.onclick = (e) => e.stopPropagation();
        posSlider.onmousedown = (e) => e.stopPropagation();
      }
    }
    if (glassBtn) {
      glassBtn.onclick = (e) => {
        e.stopPropagation();
        rootContainer.classList.toggle('glass-mode');
        glassBtn.classList.toggle('active');
      };
    }
    const pinBtn = overlayContent.querySelector('#mv-pin-btn');
    if (pinBtn) {
      if (isInfoPinned) {
        pinBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-3 4h10l-3-4V3M12 13v8"/></svg> 固定オン';
        pinBtn.classList.add('active-pin');
        setTimeout(() => document.getElementById('mv-info-area')?.classList.add('visible'), 100);
      }
      pinBtn.onclick = (e) => {
        stopProp(e);
        isInfoPinned = !isInfoPinned;
        localStorage.setItem('mv_pin_mode', isInfoPinned);
        const parentGroup = pinBtn.closest('.mv-header-group');
        pinBtn.classList.remove('active-pin');
        if (isInfoPinned) {
          pinBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-3 4h10l-3-4V3M12 13v8"/></svg> 固定オン';
          if (parentGroup) parentGroup.classList.add('active');
          document.getElementById('mv-info-area')?.classList.add('visible');
          showToast("コントローラーを固定しました");
        } else {
          pinBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-3 4h10l-3-4V3M12 13v8"/></svg> 固定オフ';
          if (parentGroup) parentGroup.classList.remove('active');
          showToast("固定を解除しました");
        }
      };
    }
    const sidebarTrigger = document.createElement('div');
    sidebarTrigger.id = 'mv-sidebar-trigger';
    sidebarTrigger.onmouseenter = () => {
      document.getElementById('mv-sidebar')?.classList.add('visible');
    };
    rootContainer.appendChild(sidebarTrigger);
    const sidebar = document.createElement('div');
    sidebar.id = 'mv-sidebar';
    sidebar.onmouseleave = () => {
      document.getElementById('mv-sidebar')?.classList.remove('visible');
    };
    sidebar.innerHTML = '<h2>次はこちら</h2><div id="mv-next-list">読み込み中...</div>';
    rootContainer.appendChild(sidebar);
    const bgImg = document.createElement('img');
    bgImg.id = 'mv-ambient-background';
    bgImg.alt = '';
    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'mv-ambient-controls';
    controlsDiv.innerHTML = `
            <div class="amb-toggle-wrapper" id="amb-toggle-btn">
                <span class="amb-label">Ambient</span>
                <div class="amb-switch"></div>
            </div>
            <div class="amb-slider-container">
                <svg class="amb-icon" viewBox="0 0 24 24"><path d="M20 15.31L23.31 12 20 8.69V4h-4.69L12 0.69 8.69 4H4v4.69L0.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>
                <input type="range" id="amb-brightness-slider" min="10" max="150" value="50">
            </div>
        `;
    rootContainer.prepend(bgImg);
    rootContainer.appendChild(controlsDiv);
    rootContainer.appendChild(overlayContent);
    setTimeout(() => {
      const ambToggle = document.getElementById('amb-toggle-btn');
      const ambSlider = document.getElementById('amb-brightness-slider');
      const bgEl = document.getElementById('mv-ambient-background');
      let isAmbOn = localStorage.getItem('mv_ambient_enabled') === 'true';
      let ambBright = localStorage.getItem('mv_ambient_brightness') || '50';
      const updateAmbState = () => {
        if (isAmbOn) {
          ambToggle.classList.add('active');
          rootContainer.classList.add('ambient-active');
        } else {
          ambToggle.classList.remove('active');
          rootContainer.classList.remove('ambient-active');
        }
        localStorage.setItem('mv_ambient_enabled', isAmbOn);
      };
      const updateAmbBrightness = (val) => {
        const brightness = val / 100;
        rootContainer.style.setProperty('--ambient-brightness', brightness);
        localStorage.setItem('mv_ambient_brightness', val);
      };
      updateAmbState();
      ambSlider.value = ambBright;
      updateAmbBrightness(ambBright);
      if (ambToggle) {
        ambToggle.onclick = (e) => {
          e.stopPropagation();
          isAmbOn = !isAmbOn;
          updateAmbState();
          showToast(isAmbOn ? "Ambient Mode ON" : "Ambient Mode OFF");
        };
      }
      if (ambSlider) {
        ambSlider.oninput = (e) => {
          e.stopPropagation();
          updateAmbBrightness(e.target.value);
        };
        ambSlider.onclick = (e) => e.stopPropagation();
        ambSlider.onmousedown = () => {
          if (rootContainer) rootContainer.classList.remove('hide-cursor');
        };
      }
    }, 100);
    // 入場中は操作UI・曲名を出さない（yti-entering）。全画面への遷移と同時に
    // すりガラス(backdrop-filter)のボタン十数個をフェードインさせていたのが
    // カクつきの一因だったため、遷移が落ち着いてから1枚のレイヤーとして出す。
    if (!isHotSwap) rootContainer.classList.add('yti-entering');
    document.body.appendChild(rootContainer);
    // 広告・一時停止の確認・再生の操作の見張り（player_guard.js）
    if (typeof ytiStartGuard === 'function') {
      try {
        ytiStartGuard();
      } catch (e) {}
    }
    updateUiScale();
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('mousemove', onUserAction);
    document.addEventListener('click', onUserAction);
    window.addEventListener('resize', updateUiScale);
  }
  if (!rootContainer.contains(targetVideo)) {
    rootContainer.insertBefore(targetVideo, rootContainer.firstChild);
  }
  targetVideo.removeEventListener('timeupdate', syncLyrics);
  targetVideo.addEventListener('timeupdate', syncLyrics);
  // timeupdate は再生中しか発火しない。一時停止中のシーク/初回ロードでも
  // ハイライト＆スクロールが追従するよう seeked / loadeddata でも同期する。
  targetVideo.removeEventListener('seeked', syncLyrics);
  targetVideo.addEventListener('seeked', syncLyrics);
  targetVideo.removeEventListener('loadeddata', syncLyrics);
  targetVideo.addEventListener('loadeddata', syncLyrics);
  targetVideo.removeEventListener('play', playStatus);
  targetVideo.addEventListener('play', playStatus);
  targetVideo.removeEventListener('pause', pauseStatus);
  targetVideo.addEventListener('pause', pauseStatus);
  const goingFullscreen = !isAuto && !isHotSwap;
  const fsRequest = goingFullscreen ? rootContainer.requestFullscreen().catch(() => false) : null;
  // 黒帯カット（letterbox.js）に、動画がMVモードへ移ったことを知らせる
  try {
    ytiLetterboxRefresh();
  } catch (e) {}
  // 字幕取得・歌詞DOMの生成・サイドバー監視・曲名の採寸は重い。
  // 全画面への遷移アニメーションと同じタイミングで走らせるとカクつくため、
  // 遷移が終わってから（まだUIを隠したまま）実行し、その後でUIを出す。
  const startHeavyInit = () => {
    if (!rootContainer) return;
    try {
      updateMetadataUI();
    } catch (e) {}
    try {
      updateMVContent().catch(() => {});
    } catch (e) {}
    try {
      startSidebarObserver();
    } catch (e) {}
    const lyricsArea = document.getElementById('mv-lyrics-area');
    if (lyricsArea) startSmoothAutoScroll(lyricsArea);
    if (isHotSwap) return;
    // 重い処理で生じたスタイル再計算を描画し終えてからUIを出す
    requestAnimationFrame(() => requestAnimationFrame(() => revealMvUi()));
  };
  runAfterEntrySettled(startHeavyInit, fsRequest);
  if (targetVideo.paused) targetVideo.play();
}

// 入場中に隠していた曲名・操作ボタンを出す。
function revealMvUi() {
  if (!rootContainer) return;
  rootContainer.classList.remove('yti-entering');
  // タイトル常時表示／固定オプションが有効なら曲名も出しておく
  if (isTitleAlwaysOn || isInfoPinned) document.getElementById('mv-info-area')?.classList.add('visible');
  onUserAction();
}

// 全画面への遷移が済み、ウィンドウサイズが落ち着いてから fn を実行する。
// macOS の全画面アニメーションは0.5秒以上かかり、その間に resize が何度か来る。
// 以前は400msで見切り発車していたため、アニメーションの途中で重い初期化が走っていた。
// fsRequest: requestFullscreen() の Promise（全画面にしない時は null）
function runAfterEntrySettled(fn, fsRequest) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        fn();
      } catch (e) {}
    }));
  };
  if (!fsRequest) {
    run();
    return;
  }
  let settleTimer = null;
  let hardTimer = null;
  const cleanup = () => {
    document.removeEventListener('fullscreenchange', onFs);
    window.removeEventListener('resize', onResize);
    clearTimeout(settleTimer);
    clearTimeout(hardTimer);
  };
  const finish = () => {
    cleanup();
    run();
  };
  // 最後の resize から150ms何も起きなければ「落ち着いた」とみなす
  const armSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, 150);
  };
  const onResize = () => {
    if (document.fullscreenElement) armSettle();
  };
  const onFs = () => {
    if (document.fullscreenElement) armSettle();
    else finish();
  };
  document.addEventListener('fullscreenchange', onFs);
  window.addEventListener('resize', onResize);
  // 全画面が拒否された時はすぐ、イベントが来ない環境でも1.5秒で必ず初期化する
  fsRequest.then((r) => {
    if (r === false) finish();
  });
  hardTimer = setTimeout(finish, 1500);
}

// モニター（画面解像度）に依存せず、UIが常に同じ体感サイズに見えるように
// ビューポート高さから拡大率 --yti-scale を算出して #mv-root-container に適用する。
// 参照高さ1000px（一般的なノートPCの表示高さ）を1.0とし、極端な値はクランプする。
// リサイズ・モニター間移動・フルスクリーン切替のたびに再計算する。
function updateUiScale() {
  if (!rootContainer) return;
  const h = window.innerHeight || 1000;
  let scale = h / 1000;
  if (scale < 0.85) scale = 0.85;
  if (scale > 1.7) scale = 1.7;
  // ユーザーが設定パネルで指定した好みの倍率を掛け合わせる（モニター間の一定さは維持）
  scale *= userUiScale;
  rootContainer.style.setProperty('--yti-scale', scale.toFixed(3));
}

function endMVMode(keepActive = false) {
  // 進行中の歌詞ロードを打ち切る（終了後もCCボタン等を操作し続けないように）
  mvContentToken++;
  ytiUiShown = false;
  activeLyricLine = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  // videoをまだオーバーレイが保持しているときだけ復帰させる。
  // YouTube側が既に移動済み（ミニプレイヤー等）なら触らない。
  const videoHeldByOverlay = !!(rootContainer && targetVideo && rootContainer.contains(targetVideo));
  if (rootContainer) {
    rootContainer.remove();
    rootContainer = null;
  }
  if (targetVideo && originalParent && videoHeldByOverlay) {
    try {
      if (originalNextSibling && originalParent.contains(originalNextSibling)) {
        originalParent.insertBefore(targetVideo, originalNextSibling);
      } else {
        originalParent.appendChild(targetVideo);
      }
    } catch (e) {}
  }
  if (targetVideo) {
    targetVideo.removeEventListener('timeupdate', syncLyrics);
    targetVideo.removeEventListener('seeked', syncLyrics);
    targetVideo.removeEventListener('loadeddata', syncLyrics);
    targetVideo.removeEventListener('play', playStatus);
    targetVideo.removeEventListener('pause', pauseStatus);
    if (savedVolume !== null) {
      targetVideo.volume = savedVolume;
      savedVolume = null;
    }
  }
  stopSmoothAutoScroll();
  lastActiveEl = null;
  cachedTargetScroll = null;
  document.removeEventListener('mousemove', onUserAction);
  document.removeEventListener('click', onUserAction);
  window.removeEventListener('resize', updateUiScale);
  if (settingsOutsideClickHandler) {
    document.removeEventListener('click', settingsOutsideClickHandler);
    settingsOutsideClickHandler = null;
  }
  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }
  clearTimeout(sidebarUpdateTimer);
  karaokeClassApplied = null;
  if (!keepActive) {
    targetVideo = null;
    sessionStorage.removeItem('mv_mode_active');
  }
  // Mini Player も開いていなければ、外部歌詞の音声同期はもう使わない
  if (!pipWindow) ytiAudioSync.stop();
  // 動画がプレイヤーへ戻ったので、黒帯カットを通常再生側の動作へ切り替える
  try {
    ytiLetterboxRefresh();
  } catch (e) {}
}
let isLyricSelectionMode = false;

function isOnlyAutoGeneratedCaptions() {
  return new Promise((resolve) => {
    const eventId = 'YTI_CheckCaption_' + Math.random().toString(36).substr(2);
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page_script.js');
    script.setAttribute('data-event-id', eventId);
    script.onload = function() {
      this.remove();
    };
    const handler = (e) => {
      window.removeEventListener(eventId, handler);
      let data = {};
      try {
        data = typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
      } catch (_) {}
      const active = data.active;
      const list = data.list || [];
      if (active) {
        const isActiveAsr = (active.kind === 'asr') || (active.vssId && active.vssId.startsWith('a.'));
        if (isActiveAsr) {
          resolve(true);
          return;
        }
      }
      if (list.length > 0) {
        const hasStandard = list.some(t => t.kind !== 'asr' && (!t.vssId || !t.vssId.startsWith('a.')));
        if (!hasStandard) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    };
    window.addEventListener(eventId, handler, {
      once: true
    });
    (document.head || document.documentElement).appendChild(script);
    setTimeout(() => resolve(false), 1000);
  });
}

function openTranscriptPanel() {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.innerText.includes('文字起こし') || btn.getAttribute('aria-label')?.includes('文字起こし') || btn.getAttribute('aria-label')?.includes('Transcript')) {
      btn.click();
      return true;
    }
  }
  return false;
}
async function clickTranscriptLanguageOption(langName) {
  const transcript = document.querySelector('ytd-transcript-renderer');
  if (!transcript) return false;
  const closeBtn = transcript.querySelector('button[aria-label="閉じる"], button[aria-label="Close"]');
  const buttons = transcript.querySelectorAll('button, [role="button"], tp-yt-paper-dropdown-menu-light, #label, .ytd-transcript-header-renderer [role="button"]');
  let openDropdown = null;
  for (const el of buttons) {
    if (el === closeBtn) continue;
    if (el.offsetParent !== null) {
      openDropdown = el;
      break;
    }
  }
  if (openDropdown) {
    openDropdown.click();
    await new Promise(r => setTimeout(r, 500));
  }
  const menuItems = document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item, [role="option"], [role="menuitem"], tp-yt-paper-listbox a, tp-yt-paper-listbox .ytd-menu-service-item-renderer');
  for (const item of menuItems) {
    const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    if (text === langName || text.includes(langName) || langName.includes(text)) {
      item.click();
      return true;
    }
  }
  return false;
}

function closeTranscriptPanel() {
  const closeBtn = document.querySelector('ytd-transcript-renderer button[aria-label="閉じる"], ytd-transcript-renderer button[aria-label="Close"]');
  if (closeBtn) closeBtn.click();
}
// 字幕の取得のためにプレイヤーを操作する処理は、1本ずつ順に（player_guard.js の ytiPlayerMutex）。
// 2本が同時に CC ボタンや字幕トラックを切り替えると、両方とも横取りに失敗する。
function interceptFromCCButton() {
  return ytiPlayerMutex.run('cc-button', ytiInterceptFromCCButtonRaw);
}

async function ytiInterceptFromCCButtonRaw() {
  return new Promise((resolve) => {
    let ccBtn = document.querySelector('.ytp-subtitles-button');
    let wasTurnedOn = false;
    const currentVid = new URLSearchParams(window.location.search).get('v') || '';
    // メタ情報付きの YTI_CaptionData を使い、遷移直後に届く
    // 「前の動画の字幕レスポンス」を誤って採用しないようにする
    const handler = (e) => {
      let d = null;
      try {
        d = JSON.parse(e.detail);
      } catch (_) {}
      if (!d || !d.text) return;
      if (currentVid && d.videoId && d.videoId !== currentVid) return;
      // 自動翻訳(tlang付き)は採用しない。前の動画で選んだ言語（例:K-POPの韓国語）が
      // YouTube側に記憶されていると、日本の曲で「日本語→韓国語」翻訳字幕が
      // 勝手に読み込まれ、それを歌詞として誤採用してしまうため。
      if (d.tlang) return;
      window.removeEventListener('YTI_CaptionData', handler);
      clearTimeout(timeoutId);
      if (wasTurnedOn && ccBtn) ccBtn.click();
      resolve(parseCaptionResponse(d.text));
    };
    window.addEventListener('YTI_CaptionData', handler);
    const timeoutId = setTimeout(() => {
      window.removeEventListener('YTI_CaptionData', handler);
      if (wasTurnedOn && ccBtn) ccBtn.click();
      resolve([]);
    }, 2500);
    if (ccBtn) {
      const isPressed = ccBtn.getAttribute('aria-pressed') === 'true';
      if (!isPressed) {
        ccBtn.click();
        wasTurnedOn = true;
      } else {
        ccBtn.click();
        setTimeout(() => ccBtn.click(), 50);
      }
    } else {
      window.removeEventListener('YTI_CaptionData', handler);
      clearTimeout(timeoutId);
      resolve([]);
    }
  });
}
function scrapeTranscriptFromDOM() {
  return ytiPlayerMutex.run('transcript', ytiScrapeTranscriptFromDOMRaw);
}

async function ytiScrapeTranscriptFromDOMRaw() {
  return new Promise(async (resolve) => {
    const isOpened = openTranscriptPanel();
    if (!isOpened) {
      return resolve([]);
    }
    let attempts = 0;
    const checkInterval = setInterval(() => {
      attempts++;
      const segmentNodes = document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model');
      if (segmentNodes.length > 0) {
        clearInterval(checkInterval);
        const rawScraped = Array.from(segmentNodes).map(node => {
          const timeStr = node.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp')?.textContent.trim() || "0:00";
          let textElement = node.querySelector('.segment-text, .yt-core-attributed-string');
          let rawText = "";
          if (textElement) {
            rawText = textElement.innerText || textElement.innerHTML.replace(/<br\s*[\/]?>/gi, '\n').replace(/<[^>]+>/g, '');
            rawText = rawText.trim();
          }
          const timeParts = timeStr.split(':').reverse();
          let timeSec = 0;
          for (let i = 0; i < timeParts.length; i++) {
            timeSec += parseInt(timeParts[i], 10) * Math.pow(60, i);
          }
          return {
            time: timeSec,
            text: rawText
          };
        }).filter(item => item.text !== "");
        const finalData = [];
        for (let i = 0; i < rawScraped.length; i++) {
          const current = rawScraped[i];
          const lines = current.text.split('\n').map(s => s.trim()).filter(s => s);
          if (lines.length <= 1) {
            finalData.push({
              time: current.time,
              text: current.text,
              el: null
            });
          } else {
            const nextTime = (i + 1 < rawScraped.length) ? rawScraped[i + 1].time : current.time + (lines.length * 4);
            const duration = nextTime - current.time;
            const timePerLine = duration / lines.length;
            lines.forEach((line, index) => {
              const interpolatedTime = current.time + (timePerLine * index);
              finalData.push({
                time: interpolatedTime,
                text: line,
                el: null
              });
            });
          }
        }
        closeTranscriptPanel();
        resolve(finalData);
      } else if (attempts > 30) {
        clearInterval(checkInterval);
        closeTranscriptPanel();
        resolve([]);
      }
    }, 100);
  });
}
async function fetchCaptionTrack(baseUrl) {
  try {
    let safeUrl = baseUrl.replace(/&tlang=[^&]*/g, '');
    let urlJson;
    if (safeUrl.includes('fmt=')) {
      urlJson = safeUrl.replace(/fmt=[^&]*/, 'fmt=json3');
    } else {
      urlJson = safeUrl.includes('?') ? safeUrl + '&fmt=json3' : safeUrl + '?fmt=json3';
    }
    const res2 = await fetch(urlJson);
    if (res2.ok) {
      const text2 = await res2.text();
      if (text2 && text2.trim()) {
        const segments2 = parseCaptionResponse(text2);
        if (segments2.length > 0) return segments2;
      }
    }
    let urlObj;
    try {
      urlObj = new URL(baseUrl);
    } catch (_) {}
    const videoId = urlObj?.searchParams?.get('v') || new URLSearchParams(window.location.search).get('v');
    const lang = urlObj?.searchParams?.get('lang') || '';
    const name = urlObj?.searchParams?.get('name') || '';
    if (videoId && lang) {
      let simpleUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`;
      if (name) simpleUrl += `&name=${encodeURIComponent(name)}`;
      const res1 = await fetch(simpleUrl);
      if (res1.ok) {
        const text1 = await res1.text();
        if (text1 && text1.trim()) {
          const segments1 = parseCaptionResponse(text1);
          if (segments1.length > 0) return segments1;
        }
      }
    }
    const res3 = await fetch(safeUrl);
    if (res3.ok) {
      const text3 = await res3.text();
      if (text3 && text3.trim()) {
        const segments3 = parseTimedTextXml(text3);
        if (segments3.length > 0) return segments3;
      }
    }
    return [];
  } catch (e) {
    return [];
  }
}

function parseCaptionResponse(text) {
  let segments = [];
  try {
    const json = JSON.parse(text);
    if (json.events && Array.isArray(json.events)) {
      for (const ev of json.events) {
        if (!ev.segs) continue;
        const lineText = (ev.segs || []).map(s => (s.utf8 || '')).join('').trim();
        if (!lineText) continue;
        const time = (ev.tStartMs || 0) / 1000;
        const duration = (ev.dDurationMs || 0) / 1000;
        segments.push({
          time,
          duration,
          text: lineText,
          el: null
        });
      }
    }
  } catch (_) {}
  if (segments.length === 0) segments = parseTimedTextXml(text);
  return segments;
}

function parseTimedTextXml(xmlText) {
  const segments = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    let textNodes = doc.querySelectorAll('text');
    if (textNodes.length === 0) textNodes = doc.querySelectorAll('p');
    textNodes.forEach(node => {
      let start = parseFloat(node.getAttribute('start') || node.getAttribute('t') || '0');
      if (start > 1e6) start = start / 1000;
      if (!node.getAttribute('start') && node.getAttribute('t') && start > 100) start = start / 1000;
      let dur = parseFloat(node.getAttribute('dur') || node.getAttribute('d') || '0');
      if (dur > 1e6) dur = dur / 1000;
      if (!node.getAttribute('dur') && node.getAttribute('d') && dur > 100) dur = dur / 1000;
      let t = (node.textContent || '').trim();
      t = t.replace(/\s+/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      if (t) segments.push({
        time: start,
        duration: dur,
        text: t,
        el: null
      });
    });
  } catch (e) {}
  return segments;
}
// 行間がこの秒数以上空いたら「間奏」行（・・・）を挿入する。
// ※定数は12だったが processRawLyricsToProcessed 側は 8.0 をハードコードしており、
//   実際に効いていたのは 8.0。挙動を変えないよう 8 に合わせて一本化した。
const INTERLUDE_THRESHOLD = 8.0;

// 行ごとのボタン（コピー／同期）は数百行ぶん作るので、SVG文字列を毎回パースせず
// 一度だけ組んだ雛形を複製する（歌詞の初回描画を軽くし、起動時のカクつきを抑える）
const lyricButtonTemplates = {};

function cloneLyricButtonTemplate(kind) {
  if (!lyricButtonTemplates[kind]) {
    const b = document.createElement('button');
    if (kind === 'sync') {
      b.className = 'lyric-quick-copy lyric-sync-tap';
      b.title = 'この行を「今」に同期（この行以降のタイミングを合わせ直します）';
      b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 10v3l2 2"/><path d="M9 2h6"/></svg>';
    } else {
      b.className = 'lyric-quick-copy';
      b.title = 'この行をコピー';
      b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }
    lyricButtonTemplates[kind] = b;
  }
  return lyricButtonTemplates[kind].cloneNode(true);
}

function renderLyricsDOM(lyricsArea) {
  if (!lyricsArea) return;
  // 歌詞を作り直すので、前の曲のスクロール目標・active要素参照をリセットする
  lastActiveEl = null;
  cachedTargetScroll = null;
  lastLyricIndex = -1;
  activeLyricLine = null;
  lyricsRenderVersion++;
  ytiLyricMotion.reset(lyricsArea);
  lyricsNeedInstantScroll = true;
  const lyricsHeader = document.getElementById('mv-lyrics-header');
  const rmScroll = document.getElementById('rm-lyrics-scroll');
  lyricsArea.innerHTML = '';
  if (rmScroll) rmScroll.innerHTML = '';
  const mainFragment = document.createDocumentFragment();
  const rmFragment = document.createDocumentFragment();
  lyricsData.forEach((line, index) => {
    const container = document.createElement('div');
    container.className = 'lyric-line-container';
    if (line.isInstrumental) container.classList.add('instrumental-line');
    const rmLine = document.createElement('div');
    rmLine.className = 'rm-lyric-line';
    if (line.isInstrumental) rmLine.classList.add('instrumental-line');
    line.rmEl = rmLine;
    const rawText = line.text;
    const segmentHasJapanese = !!rawText.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
    let isOrphanRomaji = false;
    if (!segmentHasJapanese && index > 0) {
      const prevLine = lyricsData[index - 1];
      const prevHasJapanese = !!prevLine.text.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
      const timeDiff = Math.abs(line.time - prevLine.time);
      if (prevHasJapanese && timeDiff < 0.6) isOrphanRomaji = true;
    }
    const subLines = rawText.split(/\r\n|\n|\r/);
    let tokenizedOnce = false;
    subLines.forEach((subText) => {
      if (!subText.trim()) return;
      if (line.isInstrumental) {
        const dotContainer = document.createElement('div');
        dotContainer.className = 'lyric-line';
        for (let i = 0; i < 3; i++) {
          const dot = document.createElement('span');
          dot.textContent = '・';
          dot.className = 'instrumental-dot';
          dotContainer.appendChild(dot);
        }
        container.appendChild(dotContainer);
        const rmSpan = document.createElement('span');
        rmSpan.innerText = "・・・";
        rmLine.appendChild(rmSpan);
        return;
      }
      const textSpan = document.createElement('span');
      textSpan.className = 'lyric-line';
      textSpan.innerText = subText;
      const hasJapanese = subText.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
      const hasHangul = subText.match(/[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/);
      if (hasHangul) textSpan.classList.add('type-native');
      else if (hasJapanese) {
        textSpan.classList.add('type-jp');
        // auto-phrase（文節での折り返し）は言語が分かって初めて効く
        textSpan.lang = 'ja';
      }
      else textSpan.classList.add((segmentHasJapanese && !hasJapanese) || isOrphanRomaji ? 'type-romaji' : 'type-eng');
      // カラオケの語単位の塗り（karaoke_words.js）。行の最初の本文だけを語に分ける
      const tokenized = !tokenizedOnce && typeof ytiTokenizeLine === 'function' &&
        ytiTokenizeLine(line, textSpan, subText, lyricsData[index + 1]);
      if (tokenized) tokenizedOnce = true;
      // 韓国語の読み（korean_ruby.js）。表示の入り切りは <html> のクラスで行う（語に分けた時は語ごとに付け済み）
      if (hasHangul && !tokenized) ytiKoreanRuby.decorate(textSpan);
      container.appendChild(textSpan);
      const rmSpan = document.createElement('span');
      rmSpan.innerText = subText;
      if (hasHangul) ytiKoreanRuby.decorate(rmSpan);
      if (textSpan.classList.contains('type-native')) rmSpan.classList.add('type-native');
      if (textSpan.classList.contains('type-jp')) rmSpan.classList.add('type-jp');
      if (textSpan.classList.contains('type-romaji')) rmSpan.classList.add('type-romaji');
      if (textSpan.classList.contains('type-eng')) rmSpan.classList.add('type-eng');
      rmLine.appendChild(rmSpan);
    });
    if (line.subText) {
      const subLines2 = line.subText.split(/\r\n|\n|\r/);
      subLines2.forEach(subTextStr => {
        if (!subTextStr.trim()) return;
        const subSpan = document.createElement('span');
        subSpan.className = 'lyric-line-sub';
        subSpan.innerText = subTextStr.trim();
        container.appendChild(subSpan);
        const rmSubSpan = document.createElement('span');
        rmSubSpan.className = 'rm-lyric-line-sub';
        rmSubSpan.innerText = subTextStr.trim();
        rmLine.appendChild(rmSubSpan);
      });
    }
    // ハモリ（背景の声）は本編の下に小さく
    if (line.bg && line.bg.text && typeof ytiRenderBackgroundVocal === 'function') {
      try {
        ytiRenderBackgroundVocal(line, container);
      } catch (e) {}
    }
    line.el = container;
    if (typeof ytiDecorateLineElement === 'function') {
      try {
        ytiDecorateLineElement(line, container, index);
      } catch (e) {}
    }
    // #1 クイックコピー：行ホバーで現れるボタンでその行の歌詞を即コピー（再生位置は動かさない）
    if (!line.isInstrumental) {
      const quickCopyBtn = cloneLyricButtonTemplate('copy');
      quickCopyBtn.onclick = (e) => {
        e.stopPropagation();
        let txt = (line.text || '');
        if (line.subText) txt += '\n' + line.subText;
        txt = txt.trim();
        if (!txt) return;
        navigator.clipboard.writeText(txt).then(() => {
          showToast('この行をコピーしました');
          quickCopyBtn.classList.add('copied');
          setTimeout(() => quickCopyBtn.classList.remove('copied'), 900);
        }).catch(() => {});
      };
      container.appendChild(quickCopyBtn);
    }
    container.onclick = (e) => {
      if (isLyricSelectionMode) {
        e.stopPropagation();
        container.classList.toggle('selected');
        const count = lyricsArea.querySelectorAll('.lyric-line-container.selected').length;
        const copyBtn = lyricsHeader ? lyricsHeader.querySelector('.mv-lyric-action-btn.primary') : null;
        if (copyBtn) copyBtn.innerHTML = `コピー (${count})`;
      } else {
        if (targetVideo) targetVideo.currentTime = line.time;
      }
    };
    mainFragment.appendChild(container);
    if (rmScroll) {
      rmLine.onclick = (e) => {
        e.stopPropagation();
        if (targetVideo) targetVideo.currentTime = line.time;
      };
      rmFragment.appendChild(rmLine);
    }
  });
  lyricsArea.appendChild(mainFragment);
  if (rmScroll) {
    rmScroll.appendChild(rmFragment);
  }
  // 外部歌詞モード：行ホバーの時計ボタンで「この行＝今」のアンカーを打つ。
  // イントロや間奏の映像パートで生じたズレを、その行以降だけ合わせ直せる。
  attachLyricSyncButtons();
}

function buildLyricsUIWithLanguageSwitch(lyricsArea, lyricsHeader) {
  if (!lyricsHeader) lyricsHeader = document.getElementById('mv-lyrics-header');
  if (!lyricsArea) lyricsArea = document.getElementById('mv-lyrics-area');
  // MVモードを閉じたまま Mini Player だけ使っている時はヘッダーUIが存在しない
  if (!lyricsHeader || !lyricsArea) return;
  lyricsHeader.innerHTML = '';
  const rootContainer = document.getElementById('mv-root-container');
  if (rootContainer) {
    if (!lyricsData || lyricsData.length === 0) rootContainer.classList.add('no-lyrics-mode');
    else rootContainer.classList.remove('no-lyrics-mode');
  }
  const langKeys = Object.keys(lyricsByLanguage);
  if (langKeys.length > 0) {
    const langSelect = document.createElement('select');
    langSelect.className = 'mv-lyric-action-btn';
    langSelect.style.cssText = 'min-width:120px;padding:6px 8px;margin-right:8px;cursor:pointer;font-size:13px;';
    langSelect.title = '歌詞の言語を切り替え';
    langKeys.forEach(code => {
      const opt = document.createElement('option');
      opt.value = code;
      const info = lyricsByLanguage[code];
      opt.textContent = info.isAsr ? (info.name + ' (自動)') : info.name;
      if (code === currentLyricsLang) opt.selected = true;
      langSelect.appendChild(opt);
    });
    langSelect.onchange = () => {
      currentLyricsLang = langSelect.value;
      lyricsData = lyricsByLanguage[currentLyricsLang].processed;
      localStorage.setItem('mv_lyrics_lang', currentLyricsLang);
      renderLyricsDOM(lyricsArea);
      showToast(lyricsByLanguage[currentLyricsLang].name + ' に切り替えました');
    };
    lyricsHeader.appendChild(langSelect);
  }
  const savedMode = localStorage.getItem('mv_lyrics_mode') || 'all';
  let currentMode = savedMode === 'native_only' ? 2 : (savedMode === 'jp_only' ? 1 : 0);
  const langBtn = document.createElement('button');
  langBtn.className = 'mv-lyric-action-btn';
  langBtn.title = '歌詞の表示（原文・訳・全表示）を切り替え';
  const rmScroll = document.getElementById('rm-lyrics-scroll');
  const updateLangBtn = (isInit) => {
    if (lyricsArea) lyricsArea.classList.remove('mode-jp-only', 'mode-native-only');
    if (rmScroll) rmScroll.classList.remove('mode-jp-only', 'mode-native-only');
    if (currentMode === 0) {
      langBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> 全表示';
      langBtn.style.background = '';
      langBtn.style.color = '';
      localStorage.setItem('mv_lyrics_mode', 'all');
      if (!isInit) showToast('全ての行を表示します');
    } else if (currentMode === 1) {
      if (lyricsArea) lyricsArea.classList.add('mode-jp-only');
      if (rmScroll) rmScroll.classList.add('mode-jp-only');
      langBtn.innerHTML = '<span style="font-weight:800;font-size:11px;margin-right:4px;">JP</span> 訳のみ';
      langBtn.style.background = '#fff';
      langBtn.style.color = '#000';
      localStorage.setItem('mv_lyrics_mode', 'jp_only');
      if (!isInit) showToast('日本語（訳）のみ表示します');
    } else {
      if (lyricsArea) lyricsArea.classList.add('mode-native-only');
      if (rmScroll) rmScroll.classList.add('mode-native-only');
      langBtn.innerHTML = '<span style="font-weight:800;font-size:11px;margin-right:4px;">Aa</span> 原文のみ';
      langBtn.style.background = '#007AFF';
      langBtn.style.color = '#fff';
      localStorage.setItem('mv_lyrics_mode', 'native_only');
      if (!isInit) showToast('原文のみ表示します');
    }
  };
  updateLangBtn(true);
  langBtn.onclick = () => {
    currentMode = (currentMode + 1) % 3;
    updateLangBtn();
  };
  lyricsHeader.appendChild(langBtn);
  const copyAllBtn = document.createElement('button');
  copyAllBtn.className = 'mv-lyric-action-btn';
  copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
  copyAllBtn.onclick = () => {
    let targetText = [];
    lyricsData.forEach(l => {
      const lines = l.text.split(/\r\n|\n|\r/);
      lines.forEach(sub => {
        const isJP = !!sub.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
        if (currentMode === 1 && !isJP) return;
        if (currentMode === 2 && isJP) return;
        targetText.push(sub);
      });
    });
    navigator.clipboard.writeText(targetText.join('\n')).then(() => showToast('表示中の歌詞をコピーしました'));
  };
  lyricsHeader.appendChild(copyAllBtn);
  const selectBtn = document.createElement('button');
  selectBtn.className = 'mv-lyric-action-btn';
  selectBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
  selectBtn.onclick = () => {
    isLyricSelectionMode = !isLyricSelectionMode;
    if (isLyricSelectionMode) {
      lyricsArea.classList.add('selecting');
      selectBtn.innerHTML = 'キャンセル';
      copyAllBtn.innerHTML = 'コピー (0)';
      copyAllBtn.classList.add('primary');
      copyAllBtn.onclick = () => {
        const selectedEls = lyricsArea.querySelectorAll('.lyric-line-container.selected .lyric-line');
        const visibleTexts = [];
        selectedEls.forEach(el => {
          if (window.getComputedStyle(el).display !== 'none') visibleTexts.push(el.innerText);
        });
        if (visibleTexts.length === 0) return;
        navigator.clipboard.writeText(visibleTexts.join('\n')).then(() => {
          showToast(visibleTexts.length + '行をコピーしました');
          selectBtn.click();
        });
      };
    } else {
      lyricsArea.classList.remove('selecting');
      lyricsArea.querySelectorAll('.lyric-line-container.selected').forEach(el => el.classList.remove('selected'));
      selectBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
      copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
      copyAllBtn.classList.remove('primary');
      copyAllBtn.onclick = () => {
        let targetText = [];
        lyricsData.forEach(l => {
          const lines = l.text.split(/\r\n|\n|\r/);
          lines.forEach(sub => {
            const isJP = !!sub.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
            if (currentMode === 1 && !isJP) return;
            if (currentMode === 2 && isJP) return;
            targetText.push(sub);
          });
        });
        navigator.clipboard.writeText(targetText.join('\n')).then(() => showToast('表示中の歌詞をコピーしました'));
      };
    }
  };
  lyricsHeader.appendChild(selectBtn);
  renderLyricsDOM(lyricsArea);
}

// 歌詞でない行（クレジット・曲名の表示・記号だけの行）の判定。
// 公式字幕の冒頭の「作詞：〜 作曲：〜」「『曲名』」「♪」や、歌詞DBの「作词 : 〜」などが、
// 前奏の間に「歌詞」として表示されてしまうのを防ぐ。
const YTI_CREDIT_RE = /(作詞|作曲|編曲|作词|编曲|詞|词|Lyrics?|Lyricist|Words|Music|Composed|Composer|Arrange[dr]?|Arrangement|Produced|Producer|Prod\.|Vocals?|Director|監督|振付|Choreograph\w*|Mix(?:ed|ing)?|Master(?:ed|ing)?)\s*(?:by)?\s*[:：／/]/i;
// 「制作人 : 〜」「和声 : 〜」のような、短い漢字・かなの見出し＋コロン
const YTI_CJK_LABEL_RE = /^[\u4e00-\u9fff\u3040-\u30ff]{1,8}\s*[:：]/;

function isNonLyricLine(text, titles, artist) {
  const t = String(text || '').trim();
  const norm = yti_normalizeForMatch(t);
  if (!norm) return true; // 空・記号だけ（♪ など）
  if (YTI_CREDIT_RE.test(t) || YTI_CJK_LABEL_RE.test(t)) return true;
  if (/著作权|版权|纯音乐|请欣赏|請欣賞/.test(t)) return true;
  if (/^(lyrics|words|music|composed|arranged|produced|written)\s+(and\s+\w+\s+)?by\b/i.test(t)) return true;
  if (/^(official\s*)?(music\s*video|mv|lyric\s*video)$/i.test(t)) return true;
  // 曲名の表示（『曲名』、曲名 - アーティスト 等）。サビで曲名を歌う行は消さないよう、
  // 括弧・区切り・アーティスト名が一緒に書かれている時だけ非歌詞とみなす。
  const na = yti_normalizeForMatch(artist || '');
  for (const title of titles) {
    const nt = yti_normalizeForMatch(title || '');
    if (nt.length < 2 || !norm.includes(nt)) continue;
    if (/[『「【\[]|\s[-–—/|]\s|feat\.|\bMV\b|Music Video/i.test(t)) return true;
    if (na.length >= 2 && norm.includes(na)) return true;
  }
  return false;
}

// 先頭と末尾にある歌詞でない行を取り除く（曲の途中の行には手を付けない）
function stripNonLyricLines(raw) {
  if (!raw || raw.length < 3) return raw;
  let meta = { title: '', artist: '' };
  try {
    meta = getDisplayMetadata();
  } catch (e) {}
  const titles = [meta.title];
  if (externalLyricsInfo && externalLyricsInfo.trackName) titles.push(externalLyricsInfo.trackName);
  const artist = meta.artist || (externalLyricsInfo && externalLyricsInfo.artistName) || '';
  let startIdx = 0;
  while (startIdx < raw.length - 2 && startIdx < 8 && (raw[startIdx].time || 0) < 45 &&
         isNonLyricLine(raw[startIdx].text, titles, artist)) startIdx++;
  let endIdx = raw.length;
  while (endIdx - 1 > startIdx + 1 && raw.length - endIdx < 4 && isNonLyricLine(raw[endIdx - 1].text, titles, artist)) endIdx--;
  return (startIdx === 0 && endIdx === raw.length) ? raw : raw.slice(startIdx, endIdx);
}

// 歌い出しまでがこれ以上あれば、先頭に前奏の「・・・」行を置く（Apple Music と同じく、
// 前奏の間は歌詞の1行目ではなく前奏表示に焦点を当てる）
const INTRO_DOTS_MIN = 6;

function processRawLyricsToProcessed(rawLyrics) {
  rawLyrics = stripNonLyricLines(rawLyrics);
  const processed = [];
  if (rawLyrics.length && rawLyrics[0].time >= INTRO_DOTS_MIN) {
    processed.push({
      time: 0,
      duration: rawLyrics[0].time - 1.0,
      text: "・・・",
      isInstrumental: true,
      isIntro: true,
      el: null
    });
  }
  for (let i = 0; i < rawLyrics.length; i++) {
    const currentLine = rawLyrics[i];
    processed.push(currentLine);
    if (i < rawLyrics.length - 1) {
      const nextLine = rawLyrics[i + 1];
      const endTime = currentLine.duration ? (currentLine.time + currentLine.duration) : (currentLine.time + 4.0);
      const trueGap = nextLine.time - endTime;
      if (trueGap >= INTERLUDE_THRESHOLD) {
        processed.push({
          time: endTime + 0.5,
          duration: trueGap - 1.0,
          text: "・・・",
          isInstrumental: true,
          el: null
        });
      }
    }
  }
  return processed;
}

// ===== 歌詞の永続キャッシュ（localStorage） =====
// 一度取得した歌詞を動画IDごとに保存し、次に同じ曲を開いた時は通信を待たずに
// 即座に表示する。表示後も通常の取得処理は裏で走らせ、内容が変わっていた時だけ
// 差し替える（＝キャッシュは常に「速く出すための下書き」）。
const YTI_LYR_CACHE_PREFIX = 'yti_lyrcache_';
const YTI_LYR_CACHE_INDEX = 'yti_lyrcache_index';
const YTI_LYR_CACHE_MAX = 40;
// キャッシュから先に描いた歌詞の動画IDと指紋。取得完了時にこれと同じ内容なら
// 描き直さない（＝スクロール位置やハイライトが一瞬リセットされるチラつきを防ぐ）。
// リトライで updateMVContent が呼び直されても保持できるようモジュール変数に置く。
let cacheShownVideoId = '';
let cacheShownSig = '';
// 歌詞の探索が「終わった」動画ID。見つかった／見つからなかったの両方で立てる。
// Mini Player 側が「読み込み中…」と「歌詞がありません」を出し分けるのに使う。
let lyricsLoadDoneVideoId = '';

// 内容が変わったかを軽く判定するための指紋。行数・総文字数・先頭末尾で十分。
function lyricsSignature(lines) {
  if (!lines || !lines.length) return '';
  let chars = 0;
  for (const l of lines) chars += (l.text || '').length + (l.subText || '').length;
  const first = lines[0];
  const last = lines[lines.length - 1];
  return `${lines.length}:${chars}:${(first.text || '').slice(0, 24)}:${(last.text || '').slice(0, 24)}`;
}

function readLyricsCacheIndex() {
  try {
    const raw = localStorage.getItem(YTI_LYR_CACHE_INDEX);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// 直近利用順（先頭が最新）に並べ替え、上限を超えた分は実体ごと捨てる
function touchLyricsCacheIndex(videoId) {
  let idx = readLyricsCacheIndex().filter(v => v !== videoId);
  idx.unshift(videoId);
  const dropped = idx.slice(YTI_LYR_CACHE_MAX);
  idx = idx.slice(0, YTI_LYR_CACHE_MAX);
  dropped.forEach(v => {
    try {
      localStorage.removeItem(YTI_LYR_CACHE_PREFIX + v);
    } catch (e) {}
  });
  try {
    localStorage.setItem(YTI_LYR_CACHE_INDEX, JSON.stringify(idx));
  } catch (e) {}
  return dropped;
}

// キャッシュ由来の歌詞を今まさに表示中か（取得失敗時に消してしまわないための判定）
function isShowingCachedLyrics(videoId) {
  return !!videoId && cacheShownVideoId === videoId && lyricsData.length > 0;
}

// キャッシュにある歌詞を今すぐ画面へ出す。取得処理より前に呼ぶのが肝心で、
// 曲送りの待ち時間（onNavigateの待機＋字幕トラック取得）を丸ごと飛ばせる。
function showLyricsFromCache(videoId) {
  if (!videoId) return false;
  if (isShowingCachedLyrics(videoId)) return true; // 二重描画しない
  const cached = loadLyricsFromCache(videoId);
  if (!cached) {
    console.debug('[YT Immersion] lyrics cache: MISS', videoId);
    return false;
  }
  lyricsData = cached.lines;
  cacheShownVideoId = videoId;
  cacheShownSig = lyricsSignature(lyricsData);
  const lyricsArea = document.getElementById('mv-lyrics-area');
  if (lyricsArea) {
    lyricsArea.classList.remove('no-lyrics', 'fade-out');
    renderLyricsDOM(lyricsArea);
  } else {
    lyricsRenderVersion++;
  }
  try {
    syncLyrics();
  } catch (e) {}
  console.debug('[YT Immersion] lyrics cache: HIT', videoId, cached.lines.length + '行');
  return true;
}

function saveLyricsToCache(videoId, lines, meta) {
  if (!videoId || !lines || !lines.length) return;
  const payload = {
    v: 1,
    at: Date.now(),
    lang: (meta && meta.lang) || '',
    subLang: (meta && meta.subLang) || '',
    external: !!(meta && meta.external),
    lines: lines.map(l => {
      const o = { t: Math.round((l.time || 0) * 1000) / 1000, x: l.text || '' };
      if (l.duration) o.d = Math.round(l.duration * 1000) / 1000;
      if (l.subText) o.s = l.subText;
      if (l.isInstrumental) o.i = 1;
      return o;
    })
  };
  const body = JSON.stringify(payload);
  const write = () => localStorage.setItem(YTI_LYR_CACHE_PREFIX + videoId, body);
  try {
    write();
  } catch (e) {
    // 容量超過：古いものから半分捨てて一度だけ再試行する
    try {
      const idx = readLyricsCacheIndex();
      const keep = Math.floor(idx.length / 2);
      idx.slice(keep).forEach(v => localStorage.removeItem(YTI_LYR_CACHE_PREFIX + v));
      localStorage.setItem(YTI_LYR_CACHE_INDEX, JSON.stringify(idx.slice(0, keep)));
      write();
    } catch (e2) {
      console.warn('[YT Immersion] lyrics cache: SAVE FAILED (localStorage容量?)', videoId, e2 && e2.name);
      return;
    }
  }
  touchLyricsCacheIndex(videoId);
  console.debug('[YT Immersion] lyrics cache: SAVE', videoId, lines.length + '行', Math.round(body.length / 1024) + 'KB');
}

function loadLyricsFromCache(videoId) {
  if (!videoId) return null;
  let payload = null;
  try {
    const raw = localStorage.getItem(YTI_LYR_CACHE_PREFIX + videoId);
    if (!raw) return null;
    payload = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.lines) || !payload.lines.length) return null;
  const lines = payload.lines.map(o => {
    const line = { time: o.t || 0, text: o.x || '', el: null };
    if (o.d) line.duration = o.d;
    if (o.s) line.subText = o.s;
    if (o.i) line.isInstrumental = true;
    return line;
  });
  touchLyricsCacheIndex(videoId);
  return { lines, meta: payload };
}

function mergeDualLyrics(mainRaw, subRaw) {
  if (!subRaw || subRaw.length === 0) return processRawLyricsToProcessed(mainRaw);
  const processedMain = processRawLyricsToProcessed(mainRaw);
  // 時間の重なりで順序を保って組み合わせる（core/pairing.js）。割れた訳はつなぐ。
  const real = processedMain.filter(l => !l.isInstrumental);
  const toRow = (l) => ({ start: l.time, end: l.duration ? l.time + l.duration : undefined, text: l.text });
  const paired = YTICore.pairing.pairLines(real.map(toRow), subRaw.map(toRow));
  real.forEach((line, i) => {
    const t = paired[i];
    if (t && t.trim() !== line.text.trim()) line.subText = t;
  });
  return processedMain;
}

// プレイヤーから再生中の動画の基本情報を同期的に読む（page_script.js のブリッジ）。
// CustomEvent の dispatch は同期実行なので、戻った時点で応答が届いている。
function getPlayerVideoData() {
  let out = null;
  const handler = (e) => {
    try {
      out = JSON.parse(e.detail);
    } catch (_) {}
  };
  window.addEventListener('YTI_VideoDataResponse', handler);
  try {
    window.dispatchEvent(new CustomEvent('YTI_RequestVideoData'));
  } catch (_) {}
  window.removeEventListener('YTI_VideoDataResponse', handler);
  return out;
}

// チャンネル名から「OFFICIAL YouTube CHANNEL」「公式チャンネル」「VEVO」「- Topic」などの
// 飾りを取り除いてアーティスト名にする。末尾から1語ずつ剥がすので、
// 「乃木坂46 OFFICIAL YouTube CHANNEL」→「乃木坂46」のような複合形にも効く。
// 英語の語は区切り（空白・記号）の直後にある時だけ剥がす（「Rich」の ch などを壊さない）。
function cleanArtistName(name) {
  const original = String(name || '').trim();
  let s = original.replace(/^[【\[(（]\s*(?:公式|official)\s*[】\])）]\s*/i, '');
  const tails = [
    /(?:^|[\s\-_|/・:：]+)(?:official|offical|youtube|channel|ch\.?|topic)\s*$/i,
    /(?:公式|オフィシャル|チャンネル|ちゃんねる)\s*$/,
    /VEVO\s*$/
  ];
  for (let i = 0; i < 8; i++) {
    let next = s;
    for (const re of tails) next = next.replace(re, '');
    next = next.replace(/[\s\-_|/・:：]+$/, '').trim();
    if (next === s) break;
    s = next;
  }
  return s || original;
}

function getCleanedMetadata() {
  // SPA遷移の直後は、ページのタイトル要素が前の動画のまま残っている。
  // ytd-watch-flexy の video-id で鮮度を確かめ、古ければプレイヤーの情報を使う
  // （以前はここで古い曲名を掴むのを避けるため、取得完了まで曲名を消していた）。
  const vid = getVideoId();
  const flexy = document.querySelector('ytd-watch-flexy');
  const domFresh = !vid || !flexy || flexy.getAttribute('video-id') === vid;
  const pd = getPlayerVideoData();
  const pdFresh = !!(pd && pd.videoId && pd.videoId === vid);
  let rawTitle = '';
  if (pdFresh && pd.title) rawTitle = pd.title;
  else if (domFresh) rawTitle = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent.trim() || document.querySelector('#title h1')?.innerText || document.title.replace(' - YouTube', '') || "";
  let songTitle = rawTitle;
  let rawArtist = "";
  if (domFresh) {
    const attributedLink = document.querySelector('#attributed-channel-name a');
    if (attributedLink) {
      rawArtist = attributedLink.textContent.trim();
      rawArtist = rawArtist.replace(/、/g, ' & ').replace(/, /g, ' & ');
    }
    if (!rawArtist) {
      const metaBlock = document.querySelector('ytd-watch-metadata #owner') || document.querySelector('ytd-video-owner-renderer');
      if (metaBlock) {
        const channelLinks = metaBlock.querySelectorAll('ytd-channel-name a:not([hidden])');
        if (channelLinks.length > 0) {
          rawArtist = Array.from(channelLinks).map(link => link.textContent.trim()).filter(text => text.length > 0).filter((text, index, self) => self.indexOf(text) === index).join(' & ');
        }
      }
    }
    if (!rawArtist) {
      rawArtist = document.querySelector('#owner-name a')?.innerText || "";
    }
  }
  if (!rawArtist && pdFresh) rawArtist = pd.author || '';
  const bracketMatch = rawTitle.match(/『(.*?)』/) || rawTitle.match(/「(.*?)」/) || rawTitle.match(/["'](.*?)["']/);
  let useBracketTitle = false;
  if (bracketMatch) {
    const candidate = bracketMatch[1].trim();
    const isMetadata = /^(Official\s*Video|Official\s*MV|Music\s*Video|MV|Full\s*ver\.?|Teaser)$/i.test(candidate);
    const isTooShort = candidate.length < 2;
    if (!isMetadata && !isTooShort) {
      songTitle = candidate;
      useBracketTitle = true;
    }
  }
  if (!useBracketTitle) {
    let tempTitle = rawTitle;
    const artistParts = cleanArtistName(rawArtist).split('&').map(s => s.trim());
    artistParts.forEach(art => {
      if (art) tempTitle = tempTitle.replace(art, '');
    });
    songTitle = tempTitle.replace(/【.*?】/g, '').replace(/\[.*?\]/g, '').replace(/［.*?］/g, '').replace(/\(.*?\)/g, '').replace(/（.*?）/g, '').replace(/Official\s*Music\s*Video/gi, '').replace(/Music\s*Video/gi, '').replace(/Official\s*Video/gi, '').replace(/Official\s*MV/gi, '').replace(/Special\s*Film/gi, '').replace(/Performance\s*Video/gi, '').replace(/MV/gi, '').replace(/full/gi, '').replace(/公式/g, '').replace(/\//g, '').trim().replace(/^[\s\-:：]+|[\s\-:：]+$/g, '');
    const quoteCleanup = songTitle.match(/^["'](.*?)["']$/);
    if (quoteCleanup) {
      songTitle = quoteCleanup[1];
    }
  }
  const artistName = cleanArtistName(rawArtist);
  return {
    title: songTitle,
    artist: artistName
  };
}

// ===== 構造化楽曲メタデータ（MAIN世界から取得）=====
// 動画タイトルは【MV】曲名 / アーティスト (Official Music Video) のような
// 無法地帯なので、Content ID由来の正確な曲名・アーティストが取れるなら
// そちらを外部歌詞DBの検索キーに使う。取れない動画も多いのでnull前提で扱う。
const ytiMusicMetaCache = {};

function requestMusicMetaOnce(videoId) {
  return new Promise((resolve) => {
    let done = false;
    const handler = (e) => {
      let d = null;
      try {
        d = JSON.parse(e.detail);
      } catch (_) {}
      if (!d || (d.videoId && videoId && d.videoId !== videoId)) return;
      done = true;
      window.removeEventListener('YTI_MusicMetaResponse', handler);
      clearTimeout(timer);
      resolve(d);
    };
    window.addEventListener('YTI_MusicMetaResponse', handler);
    const timer = setTimeout(() => {
      if (done) return;
      window.removeEventListener('YTI_MusicMetaResponse', handler);
      resolve(null);
    }, 1500);
    try {
      window.dispatchEvent(new CustomEvent('YTI_RequestMusicMeta', { detail: videoId }));
    } catch (_) {
      resolve(null);
    }
  });
}

async function requestMusicMetaFromPage(videoId) {
  if (!videoId) return null;
  if (Object.prototype.hasOwnProperty.call(ytiMusicMetaCache, videoId)) {
    return ytiMusicMetaCache[videoId];
  }
  // SPA遷移直後は ytInitialData が前ページのまま。stale が返る間は待って再試行する。
  // ここで stale を null と同一視すると「楽曲メタ無し」として確定キャッシュしてしまう。
  for (let i = 0; i < 3; i++) {
    const d = await requestMusicMetaOnce(videoId);
    if (d && !d.stale) {
      ytiMusicMetaCache[videoId] = d.meta || null;
      return d.meta || null;
    }
    if (i < 2) await new Promise(r => setTimeout(r, 600));
  }
  // 応答なし/stale のままなら、キャッシュせずに諦める（次の機会に再取得できる）
  return null;
}

// 構造化データ優先、無ければ従来のタイトルパースにフォールバック。
// 構造化側が来たかどうかは fromStructured で呼び出し側に伝える。
async function getMusicMetadata(videoId) {
  const dom = getCleanedMetadata();
  let sm = null;
  try {
    sm = await requestMusicMetaFromPage(videoId);
  } catch (e) {}
  if (sm && sm.song) {
    try {
      console.info('[YT Immersion] 構造化楽曲メタ: ' + sm.song + ' / ' + (sm.artist || '(不明)'));
    } catch (e) {}
    return {
      title: sm.song,
      artist: sm.artist || dom.artist || '',
      album: sm.album || '',
      fromStructured: true,
      domTitle: dom.title,
      domArtist: dom.artist
    };
  }
  return {
    title: dom.title,
    artist: dom.artist,
    album: '',
    fromStructured: false,
    domTitle: dom.title,
    domArtist: dom.artist
  };
}

// 取得済みの構造化メタを同期的に読む（UIから使う）。未取得なら null。
function getCachedMusicMeta(videoId) {
  if (!videoId) return null;
  return Object.prototype.hasOwnProperty.call(ytiMusicMetaCache, videoId) ? ytiMusicMetaCache[videoId] : null;
}

// 表示用の曲名・アーティスト。構造化メタがあればそちらが正確なので優先する。
let musicMetaPrimingVideoId = '';

function getDisplayMetadata() {
  const vid = getVideoId();
  const dom = getCleanedMetadata();
  const sm = getCachedMusicMeta(vid);
  // 未取得なら裏で取りに行き、届いたら描き直す（届かなければ何もしない＝再帰しない）
  if (vid && !Object.prototype.hasOwnProperty.call(ytiMusicMetaCache, vid) && musicMetaPrimingVideoId !== vid) {
    musicMetaPrimingVideoId = vid;
    requestMusicMetaFromPage(vid).then(m => {
      musicMetaPrimingVideoId = '';
      if (m && m.song && getVideoId() === vid) updateMetadataUI();
    }).catch(() => {
      musicMetaPrimingVideoId = '';
    });
  }
  return {
    title: (sm && sm.song) ? sm.song : dom.title,
    artist: (sm && sm.artist) ? sm.artist : dom.artist
  };
}

// 曲名がまだ取れない（遷移直後でプレイヤーも切り替わっていない）時の再試行
let metaRetryTimer = null;
let metaRetryCount = 0;

function updateMetadataUI() {
  const infoArea = document.getElementById('mv-info-area');
  const {
    title: songTitle,
    artist: artistName
  } = getDisplayMetadata();
  if (metaRetryTimer) {
    clearTimeout(metaRetryTimer);
    metaRetryTimer = null;
  }
  if (!songTitle && metaRetryCount < 12) {
    metaRetryCount++;
    metaRetryTimer = setTimeout(updateMetadataUI, 400);
  } else if (songTitle) {
    metaRetryCount = 0;
  }
  // 同じ内容なら組み直さない（マーキーの採寸＝強制レイアウトを省く）
  if (infoArea && infoArea._ytiMeta === songTitle + '\u0000' + artistName && infoArea.firstChild) return;
  if (infoArea) {
    infoArea._ytiMeta = songTitle + '\u0000' + artistName;
    const rmTitle = document.getElementById('rm-song-title');
    const rmArtist = document.getElementById('rm-artist-name');
    const vinylLabel = document.getElementById('vinyl-label');
    if (rmTitle) rmTitle.innerText = songTitle;
    if (rmArtist) rmArtist.innerText = artistName;
    if (vinylLabel) {
      const vThumb = getHighResThumbnail();
      if (vThumb) vinylLabel.style.backgroundImage = `url('${vThumb}')`;
    }
    // 動画タイトルは投稿者が自由に付けられる文字列なので、innerHTMLで組むと
    // <img onerror=...> のようなタイトルの動画を開いた時点でスクリプトが動く。
    // 拡張のISOLATED世界（chrome.runtime が触れる）で実行されるため必ずDOM APIで組む。
    infoArea.textContent = '';
    const titleEl = document.createElement('h1');
    titleEl.id = 'mv-song-title';
    titleEl.textContent = songTitle;
    const artistEl = document.createElement('p');
    artistEl.id = 'mv-artist-name';
    artistEl.textContent = artistName;
    infoArea.appendChild(titleEl);
    infoArea.appendChild(artistEl);
    if (songTitle && titleEl.scrollWidth > titleEl.clientWidth) {
      titleEl.classList.add('marquee');
      titleEl.textContent = '';
      for (let i = 0; i < 2; i++) {
        const span = document.createElement('span');
        span.textContent = songTitle;
        titleEl.appendChild(span);
      }
    }
    lastTitle = "";
    const ambientBg = document.getElementById('mv-ambient-background');
    if (ambientBg) {
      const lowResThumb = getLowResThumbnail();
      if (lowResThumb && ambientBg.src !== lowResThumb) {
        ambientBg.src = lowResThumb;
      }
    }
  }
}

function getCaptionTracklistFromPlayer() {
  return new Promise((resolve) => {
    const eventId = 'YTI_Tracklist_' + Math.random().toString(36).substr(2);
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page_script.js');
    script.setAttribute('data-event-id', eventId);
    script.onload = function() {
      this.remove();
    };
    const handler = (e) => {
      window.removeEventListener(eventId, handler);
      let data = {};
      try {
        data = typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
      } catch (_) {}
      resolve({
        list: data.list || [],
        active: data.active || null,
        defaultLang: data.defaultLang || '',
        videoId: data.videoId || ''
      });
    };
    window.addEventListener(eventId, handler, {
      once: true
    });
    (document.head || document.documentElement).appendChild(script);
    setTimeout(() => resolve({
      list: [],
      active: null,
      defaultLang: '',
      videoId: ''
    }), 3000);
  });
}
// 「歌詞なし」系メッセージを画面下部に表示し、一定時間後にフェードアウト
// （マウスオーバー中は表示維持）させる共通処理。
function showNoLyrics(lyricsArea, msg, opts) {
  if (!lyricsArea) return;
  opts = opts || {};
  let style = '';
  if (opts.fontSize) style += `font-size:${opts.fontSize};`;
  if (opts.opacity) style += `opacity:${opts.opacity};`;
  lyricsArea.innerHTML = `<p class="no-lyrics-msg"${style ? ` style="${style}"` : ''}>${msg}</p>`;
  lyricsArea.classList.add('no-lyrics');
  lyricsArea.classList.remove('fade-out');
  if (lyricsArea._noLyricsTimer) clearTimeout(lyricsArea._noLyricsTimer);
  lyricsArea._noLyricsTimer = setTimeout(() => {
    if (lyricsArea.classList.contains('no-lyrics')) lyricsArea.classList.add('fade-out');
  }, 5000);
  lyricsArea.onmouseenter = () => {
    if (lyricsArea._noLyricsTimer) clearTimeout(lyricsArea._noLyricsTimer);
    lyricsArea.classList.remove('fade-out');
  };
  lyricsArea.onmouseleave = () => {
    if (lyricsArea.classList.contains('no-lyrics')) lyricsArea.classList.add('fade-out');
  };
}

// ===== 外部歌詞（LRCLIB）＋アンカー同期エンジン =====

// backgroundのFETCH_URL経由で取得（content scriptはページのCORSに縛られるため）
function fetchViaBackground(url) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_URL', url }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success) resolve(null);
        else resolve(res.text);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// 照合用正規化：NFKC→小文字→カタカナをひらがなへ→記号・空白を除去。
// ASRと歌詞カードで漢字の開き方が違っても、バイグラム照合でそこそこ吸収できる。
function yti_normalizeForMatch(s) {
  if (!s) return '';
  let t = String(s).normalize('NFKC').toLowerCase();
  t = t.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  t = t.replace(/[^\p{L}\p{N}]/gu, '');
  return t;
}

// 文字バイグラムのDice係数（0〜1）。CJKでは編集距離より語順ゆらぎ・誤字に頑健。
function yti_diceSim(a, b) {
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

// LRC形式をパース。[mm:ss.xx] 複数タイムタグ/1行にも対応。空テキスト行は捨てる。
function parseLrcText(lrcText) {
  const lines = [];
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of String(lrcText || '').split(/\r\n|\n|\r/)) {
    const times = [];
    let m;
    let lastIndex = 0;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(rawLine)) !== null) {
      const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
      times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      lastIndex = tagRe.lastIndex;
    }
    if (times.length === 0) continue;
    const text = rawLine.slice(lastIndex).trim();
    if (!text) continue;
    times.forEach(t => lines.push({ baseTime: t, text }));
  }
  lines.sort((a, b) => a.baseTime - b.baseTime);
  return lines;
}

// ===== 外部歌詞の検索（複数の情報源）=====
// LRCLIB と NetEase Cloud Music を並列に検索し、曲名・アーティストの類似度と
// 動画尺との整合で採点して、最も確からしい同期歌詞を選ぶ。
//  - LRCLIB：オープンな歌詞DB。精度は高いが、応答に数十秒かかることがある
//  - NetEase：日本・韓国の曲も含めて収録数が多く、応答も速い（約1秒）
// 片方で良い結果が出たら、もう片方は少しだけ待って打ち切る（遅い方に全体を引きずられない）。
// 結果はvideoIdごとにlocalStorageへキャッシュ（ヒット30日・ミス12時間）し、再取得を避ける。
const YTI_EXT_CACHE_PREFIX = 'yti_lrc2_cache_';
// 片方の結果が出てから、もう片方を待つ時間
const YTI_EXT_GRACE_MS = 1500;

// 外部歌詞の候補を採点する（0〜1強）。曲名7：アーティスト3、尺が合えば加点。
function scoreLyricCandidate(meta, videoDur, name, artist, durSec) {
  const normTitle = yti_normalizeForMatch(meta.title);
  const normArtist = yti_normalizeForMatch(meta.artist);
  let score = yti_diceSim(normTitle, yti_normalizeForMatch(name || ''));
  if (normArtist) {
    score = score * 0.7 + yti_diceSim(normArtist, yti_normalizeForMatch(artist || '')) * 0.3;
  }
  if (videoDur > 30 && durSec) {
    // 原曲がMVより長いことは通常ない（MVは映像パディングで曲より長い）
    if (durSec > videoDur + 5) score -= 0.3;
    else score += Math.max(0, 0.15 - (Math.abs(videoDur - durSec) / videoDur) * 0.3);
  }
  // 探している曲名に無いのに、リミックス・カラオケ・インスト版を指している候補は下げる
  const variant = /(remix|inst(rumental)?|off\s*vocal|karaoke|カラオケ|伴奏|acoustic|ver\.|version|live)/i;
  if (variant.test(name || '') && !variant.test(meta.title || '')) score -= 0.25;
  return score;
}

// NetEase等のLRCの冒頭・末尾に入る「作詞：」「制作人：」などのクレジット行を除く
function stripLyricCredits(lines) {
  if (!lines.length) return lines;
  const lastTime = lines[lines.length - 1].baseTime;
  const credit = /^[^:：]{1,16}\s*[:：]\s*\S/;
  const out = lines.filter(l => {
    if (!credit.test(l.text)) return true;
    return !(l.baseTime < 40 || l.baseTime > lastTime - 15);
  });
  // 「純音楽、请欣赏」等のインスト表示だけの歌詞は歌詞なしとして扱う
  if (out.length <= 2 && out.every(l => /纯音乐|請欣賞|请欣赏|instrumental/i.test(l.text))) return [];
  return out;
}

async function findLrclibLyrics(meta, videoDur) {
  const enc = encodeURIComponent;
  const queries = [];
  // 構造化メタがある時は /api/get の完全一致を最優先で叩く。
  // artist+track（+album/duration）が正確なので、検索より遥かに当たる。
  if (meta.fromStructured && meta.artist) {
    let getUrl = `https://lrclib.net/api/get?artist_name=${enc(meta.artist)}&track_name=${enc(meta.title)}`;
    if (meta.album) getUrl += `&album_name=${enc(meta.album)}`;
    if (videoDur > 30) getUrl += `&duration=${Math.round(videoDur)}`;
    queries.push({ url: getUrl, exact: true });
    // durationはMVの映像パディングぶんズレるので、外した版も試す
    if (videoDur > 30) {
      let noDur = `https://lrclib.net/api/get?artist_name=${enc(meta.artist)}&track_name=${enc(meta.title)}`;
      if (meta.album) noDur += `&album_name=${enc(meta.album)}`;
      queries.push({ url: noDur, exact: true });
    }
  }
  if (meta.artist) {
    queries.push({ url: `https://lrclib.net/api/search?track_name=${enc(meta.title)}&artist_name=${enc(meta.artist)}` });
    queries.push({ url: `https://lrclib.net/api/search?q=${enc(meta.artist + ' ' + meta.title)}` });
  }
  queries.push({ url: `https://lrclib.net/api/search?q=${enc(meta.title)}` });
  // 構造化メタで見つからない場合に備え、従来のタイトルパース版も後段に残す
  if (meta.fromStructured && meta.domTitle && meta.domTitle !== meta.title) {
    if (meta.domArtist) {
      queries.push({ url: `https://lrclib.net/api/search?track_name=${enc(meta.domTitle)}&artist_name=${enc(meta.domArtist)}` });
    }
    queries.push({ url: `https://lrclib.net/api/search?q=${enc(meta.domTitle)}` });
  }
  let responded = false;
  // 候補の問い合わせは一斉に投げ、優先順に評価する
  const inflight = queries.map(q => fetchViaBackground(q.url));
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const text = await inflight[qi];
    if (!text) continue;
    responded = true;
    let list = [];
    try {
      list = JSON.parse(text);
    } catch (e) {
      continue;
    }
    // /api/get は配列ではなく単一オブジェクト（見つからない時は error を返す）
    if (list && !Array.isArray(list)) list = list.syncedLyrics ? [list] : [];
    if (!Array.isArray(list) || !list.length) continue;
    let best = null;
    let bestScore = 0;
    for (const item of list) {
      if (!item || !item.syncedLyrics) continue;
      const score = scoreLyricCandidate(meta, videoDur, item.trackName, item.artistName, item.duration);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    // /api/get はartist+trackの完全一致なので、類似度の閾値を下げてよい。
    // ただし構造化メタの抽出ミスを拾わないよう最低限の一致は要求する。
    const threshold = q.exact ? 0.25 : 0.45;
    if (best && bestScore >= threshold) {
      const lines = parseLrcText(best.syncedLyrics);
      if (lines.length >= 4) {
        return {
          responded: true,
          score: bestScore + (q.exact ? 0.1 : 0),
          result: { lines, trackName: best.trackName || meta.title, artistName: best.artistName || meta.artist, duration: best.duration || 0, source: 'LRCLIB' }
        };
      }
    }
  }
  return { responded, score: 0, result: null };
}

async function findNeteaseLyrics(meta, videoDur) {
  const enc = encodeURIComponent;
  const terms = [];
  if (meta.artist) terms.push(meta.artist + ' ' + meta.title);
  terms.push(meta.title);
  if (meta.domTitle && meta.domTitle !== meta.title) terms.push((meta.domArtist ? meta.domArtist + ' ' : '') + meta.domTitle);
  const texts = await Promise.all(terms.map(t => fetchViaBackground(`https://music.163.com/api/cloudsearch/pc?s=${enc(t)}&type=1&limit=10&offset=0`)));
  let responded = false;
  const seen = new Set();
  const cands = [];
  for (const text of texts) {
    if (!text) continue;
    let d = null;
    try {
      d = JSON.parse(text);
    } catch (e) {
      continue;
    }
    responded = true;
    const songs = (d && d.result && d.result.songs) || [];
    for (const song of songs) {
      if (!song || seen.has(song.id)) continue;
      seen.add(song.id);
      const artist = (song.ar || song.artists || []).map(a => a && a.name).filter(Boolean).join(' & ');
      const durSec = (song.dt || song.duration || 0) / 1000;
      // 別名（日本語の原題がaliasに入っていることがある）も曲名として照合する
      let score = scoreLyricCandidate(meta, videoDur, song.name, artist, durSec);
      for (const alias of (song.alia || song.alias || [])) {
        score = Math.max(score, scoreLyricCandidate(meta, videoDur, alias, artist, durSec));
      }
      cands.push({ song, artist, durSec, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // 上位から順に歌詞を取りに行く（リミックス等で歌詞が空の候補を飛ばす）
  for (const c of cands.slice(0, 3)) {
    if (c.score < 0.45) break;
    const text = await fetchViaBackground(`https://music.163.com/api/song/lyric?id=${c.song.id}&lv=1`);
    if (!text) continue;
    let d = null;
    try {
      d = JSON.parse(text);
    } catch (e) {
      continue;
    }
    const lrc = d && d.lrc && d.lrc.lyric;
    if (!lrc) continue;
    const lines = stripLyricCredits(parseLrcText(lrc));
    if (lines.length >= 4) {
      return {
        responded: true,
        score: c.score,
        result: { lines, trackName: c.song.name || meta.title, artistName: c.artist || meta.artist, duration: c.durSec || 0, source: 'NetEase' }
      };
    }
  }
  return { responded, score: 0, result: null };
}

async function fetchLrclibLyrics(videoId) {
  const cacheKey = YTI_EXT_CACHE_PREFIX + (videoId || '');
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const c = JSON.parse(raw);
      const age = Date.now() - (c.ts || 0);
      if (c.miss && age < 12 * 3600 * 1000) return null;
      if (!c.miss && Array.isArray(c.lines) && c.lines.length && age < 30 * 24 * 3600 * 1000) {
        return { lines: c.lines, trackName: c.trackName || '', artistName: c.artistName || '', duration: c.duration || 0, source: c.source || '' };
      }
    }
  } catch (e) {}
  const saveCache = (obj) => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(Object.assign({ ts: Date.now() }, obj)));
    } catch (e) {}
  };
  const meta = await getMusicMetadata(videoId);
  if (!meta.title) return null;
  const videoDur = (targetVideo && isFinite(targetVideo.duration)) ? targetVideo.duration : 0;
  const tasks = [findLrclibLyrics(meta, videoDur), findNeteaseLyrics(meta, videoDur)];
  const outcomes = [null, null];
  let settled = 0;
  await new Promise((resolve) => {
    let graceTimer = null;
    tasks.forEach((p, i) => {
      p.catch(() => ({ responded: false, score: 0, result: null })).then((o) => {
        outcomes[i] = o;
        settled++;
        if (settled === tasks.length) {
          clearTimeout(graceTimer);
          resolve();
        } else if (o && o.result && !graceTimer) {
          // 1件目の歌詞が見つかった。もう片方はもう少しだけ待つ
          graceTimer = setTimeout(resolve, YTI_EXT_GRACE_MS);
        }
      });
    });
  });
  const found = outcomes.filter(o => o && o.result).sort((a, b) => b.score - a.score);
  if (found.length) {
    const best = found[0].result;
    try {
      console.info('[YT Immersion] 外部歌詞: ' + best.source + ' / ' + best.trackName + ' — ' + best.artistName);
    } catch (e) {}
    saveCache(best);
    return best;
  }
  // 応答が1件も無かった＝通信自体が失敗している。ミスとして確定させず、次回再試行する。
  const allResponded = outcomes.every(o => o && o.responded);
  if (allResponded) saveCache({ miss: true });
  return null;
}

// ===== アンカー列（区分ステップ関数）=====
// ズレは「イントロ/間奏の映像パート挿入」による階段状の定数なので、
// アンカーより後ろの行にそのアンカーのオフセットを適用すれば全編合う。
function yti_anchorStorageKey(videoId) {
  return 'yti_lrc_anchors_' + (videoId || '');
}

function loadLyricsAnchors(videoId) {
  try {
    const raw = localStorage.getItem(yti_anchorStorageKey(videoId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      // src の無い古い保存データは、ユーザーが手で合わせたものとして扱う
      const list = arr.filter(a => a && typeof a.lrcTime === 'number' && typeof a.videoTime === 'number')
        .map(a => Object.assign({}, a, { src: a.src || 'manual' }))
        .sort((a, b) => a.lrcTime - b.lrcTime);
      // 古い推定方法による音声の補正（語りのイントロで歌い出しを誤認していた等）は使わず、推定し直す
      if (list.some(a => a.src === 'audio' && a.ver !== ytiAudioSync.version)) return [];
      // 別の歌詞（取得元が変わった）に対して打った補正は当てない。指紋の無い古い補正は
      // 以前の取得元（LRCLIB / NetEase）の歌詞を表示している時だけ使う。
      const lh = ytiLyricsHash(externalLyricsInfo);
      const prov = externalLyricsInfo && externalLyricsInfo.provider;
      return list.filter(a => a.lh ? a.lh === lh : (prov === 'lrclib' || prov === 'netease'));
    }
  } catch (e) {}
  return [];
}

// アンカー列の出どころ。'manual'（手で合わせた）> 'asr'（字幕照合）> 'audio'（音声推定）の順に信頼する。
function anchorsSource(anchors) {
  if (!anchors || !anchors.length) return '';
  if (anchors.some(a => a.src === 'manual')) return 'manual';
  // 共有された同期（community.js）は字幕照合と同じ扱い（音声の推定では上書きしない）
  if (anchors.every(a => a.src === 'asr' || a.src === 'shared')) return 'asr';
  return 'audio';
}

function saveLyricsAnchors() {
  const vid = loadedLyricsVideoId || getVideoId();
  try {
    if (lyricsAnchors.length) localStorage.setItem(yti_anchorStorageKey(vid), JSON.stringify(lyricsAnchors));
    else localStorage.removeItem(yti_anchorStorageKey(vid));
  } catch (e) {}
}

// アンカーを適用して lyricsData を再構築＋再描画。アンカー変更時にも呼ぶ。
function applyExternalLyricsData() {
  if (!externalLyricsInfo) return;
  const info = externalLyricsInfo;
  // 曲の時計 → 動画の時計。土台は YouTube Music の公式の対応表（あれば）、その上に
  // 手で合わせた・字幕照合・音声推定の対応点。動画で切られた区間の行は隠す。
  const warp = YTICore.warp.buildWarp({ segments: info.segments || [], anchors: lyricsAnchors });
  ytiCurrentWarp = warp;
  const mapped = YTICore.warp.applyToLines(info.lines.map(l => ({
    start: l.baseTime, end: l.end, text: l.text, words: l.words, bg: l.bg, srcIndex: l.srcIndex, agent: l.agent
  })), warp);
  const shifted = mapped.filter(l => !l.hidden).map(l => {
    const o = { time: l.time, baseTime: l.baseTime, text: l.text, el: null, srcIndex: l.srcIndex };
    if (Number.isFinite(l.endTime)) o.duration = Math.max(0.3, l.endTime - l.time);
    if (l.words) o.words = l.words;
    else if (ytiAsrCharTimes && ytiAsrCharTimes[l.srcIndex]) o.charTimes = ytiAsrCharTimes[l.srcIndex];
    if (l.bg) o.bg = l.bg;
    if (l.agent) o.agent = l.agent;
    return o;
  });
  ytiHiddenLineCount = mapped.length - shifted.length;
  if (typeof ytiDecorateExternalLines === 'function') {
    try {
      ytiDecorateExternalLines(shifted, info, warp);
    } catch (e) {}
  }
  const next = processRawLyricsToProcessed(shifted);
  const lyricsArea = document.getElementById('mv-lyrics-area');
  const rootContainer = document.getElementById('mv-root-container');
  if (rootContainer) rootContainer.classList.remove('no-lyrics-mode');
  // キャッシュから先に描いた歌詞と行・時刻が同じなら、DOMを作り直さずに
  // 外部歌詞としての情報（同期ボタン用の baseTime）だけを足す。
  // 作り直すとスクロール位置とハイライトが一瞬リセットされてチラつくため。
  const domReady = !!(lyricsArea && lyricsArea.querySelector('.lyric-line-container'));
  if (sameLyricsTiming(lyricsData, next) && (domReady || !lyricsArea)) {
    next.forEach((l, i) => {
      if (typeof l.baseTime === 'number') lyricsData[i].baseTime = l.baseTime;
    });
    attachLyricSyncButtons();
  } else {
    lyricsData = next;
    if (lyricsArea) {
      lyricsArea.classList.remove('no-lyrics', 'fade-out');
      renderLyricsDOM(lyricsArea);
    } else {
      lyricsRenderVersion++;
    }
    // 同期アンカーを打ち直した結果も含めて保存し、次回は即座に同じ状態で出す
    saveLyricsToCache(loadedLyricsVideoId || getVideoId(), lyricsData, { external: true });
  }
  // アンカーで行時刻が変わったので、カラオケ用の単語タイミングも付け直す
  if (asrWordStream) attachKaraokeTiming(asrWordStream);
  try {
    syncLyrics();
  } catch (e) {}
}

// 行・時刻・種類が同じ歌詞か（表示を作り直す必要があるかの判定）
function sameLyricsTiming(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i].time || 0) - (b[i].time || 0)) > 0.02) return false;
    if ((a[i].text || '') !== (b[i].text || '')) return false;
    if (!!a[i].isInstrumental !== !!b[i].isInstrumental) return false;
  }
  return true;
}

// 外部歌詞の行に「この行を今に同期」ボタンを付ける（まだ無い行だけ）
function attachLyricSyncButtons() {
  if (!usingExternalLyrics) return;
  lyricsData.forEach(line => {
    if (line.isInstrumental || typeof line.baseTime !== 'number' || !line.el) return;
    if (line.el.querySelector('.lyric-sync-tap')) return;
    const syncBtn = cloneLyricButtonTemplate('sync');
    syncBtn.onclick = (e) => {
      e.stopPropagation();
      addLyricsAnchorForLine(line);
    };
    line.el.appendChild(syncBtn);
  });
}

// 「この行を今に合わせる」：この行以降のアンカーを張り替える（前半の同期は保持）
function addLyricsAnchorForLine(line) {
  if (!targetVideo || typeof line.baseTime !== 'number') return;
  // 手で合わせ直した以上、残す前半のアンカーも含めて「手動」として固定する
  lyricsAnchors = lyricsAnchors.filter(a => a.lrcTime < line.baseTime - 0.001).map(a => Object.assign({}, a, { src: 'manual', lh: ytiLyricsHash(externalLyricsInfo) }));
  lyricsAnchors.push({ lrcTime: line.baseTime, videoTime: targetVideo.currentTime, src: 'manual', lh: ytiLyricsHash(externalLyricsInfo) });
  ytiAudioSync.stop();
  lyricsAnchors.sort((a, b) => a.lrcTime - b.lrcTime);
  saveLyricsAnchors();
  applyExternalLyricsData();
  showToast('この行を現在の再生位置に同期しました');
}

// 全体を±deltaへ微調整（アンカーが無ければ先頭アンカーを新設）
function nudgeLyricsOffset(delta) {
  const lh = ytiLyricsHash(externalLyricsInfo);
  // 公式の対応表がある時は、対応表で写した位置からのずれとして足す
  const base0 = ytiCurrentWarp ? ytiCurrentWarp.map(0).time : 0;
  if (!lyricsAnchors.length) lyricsAnchors = [{ lrcTime: 0, videoTime: base0 + delta, src: 'manual', lh }];
  else lyricsAnchors = lyricsAnchors.map(a => ({ lrcTime: a.lrcTime, videoTime: a.videoTime + delta, rate: a.rate, src: 'manual', lh }));
  ytiAudioSync.stop();
  saveLyricsAnchors();
  applyExternalLyricsData();
  const off = lyricsAnchors[0].videoTime - (ytiCurrentWarp ? YTICore.warp.buildWarp({ segments: externalLyricsInfo.segments || [] }).map(lyricsAnchors[0].lrcTime).time : lyricsAnchors[0].lrcTime);
  showToast(`オフセット: ${off >= 0 ? '+' : ''}${off.toFixed(1)}秒`);
}

// ===== ASRハイブリッド自動整合 =====
// ASR字幕は誤字だらけだがタイミングは実音声由来で正確。テキストはLRCLIB、
// 時計はASRから借りる：行同士をあいまい照合し、オフセットの階段を推定する。
//
// 以前は「各行について最も似ているASR区間」を独立に探していたが、サビのように
// 同じ歌詞が何度も出る曲では別の回のサビと対応してしまい、ズレがばらばらに
// 見えて整合を諦める（＝手動調整が必要になる）ことが多かった。
// 歌詞もASRも時間順に進むので、順序を保ったまま対応付ける（動的計画法）。
function autoAlignWithAsr(lrcLines, asrSegs) {
  if (!lrcLines || lrcLines.length < 4 || !asrSegs || asrSegs.length < 4) return null;
  const asr = asrSegs
    .map(s => ({ time: s.time, norm: yti_normalizeForMatch(s.text) }))
    .filter(s => s.norm.length >= 2);
  const lrc = lrcLines.map(l => ({ time: l.baseTime, norm: yti_normalizeForMatch(l.text) }));
  const N = lrc.length;
  const M = asr.length;
  if (M < 4) return null;
  const MIN_SIM = 0.42;
  // MVは原曲より前に映像が入ることはあっても、大きく前倒しになることはない
  const MAX_LEAD = 20;
  const MAX_LAG = 240;
  // gain[i][j]：LRCのi行目とASRのj区間を対応させた時の得点（対応させられなければ0）
  const gain = new Array(N);
  for (let i = 0; i < N; i++) {
    gain[i] = new Float32Array(M);
    const norm = lrc[i].norm;
    if (norm.length < 4) continue;
    for (let j = 0; j < M; j++) {
      const delta = asr[j].time - lrc[i].time;
      if (delta < -MAX_LEAD || delta > MAX_LAG) continue;
      // ASRは行の切れ目がLRCとズレるため、隣接区間との連結も試す
      let sim = yti_diceSim(norm, asr[j].norm);
      if (j + 1 < M) {
        const sim2 = yti_diceSim(norm, asr[j].norm + asr[j + 1].norm);
        if (sim2 > sim) sim = sim2;
      }
      if (j > 0) {
        const sim3 = yti_diceSim(norm, asr[j - 1].norm + asr[j].norm);
        if (sim3 > sim) sim = sim3;
      }
      if (sim >= MIN_SIM) gain[i][j] = sim - MIN_SIM + 0.05;
    }
  }
  // dp[i][j]：LRCの先頭i行とASRの先頭j区間で作れる、順序を保った対応の最大得点
  const W = M + 1;
  const dp = new Float32Array((N + 1) * W);
  const from = new Uint8Array((N + 1) * W); // 1:行を飛ばす 2:区間を飛ばす 3:対応させる
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      let best = dp[(i - 1) * W + j];
      let how = 1;
      const skipAsr = dp[i * W + j - 1];
      if (skipAsr > best) {
        best = skipAsr;
        how = 2;
      }
      const g = gain[i - 1][j - 1];
      if (g > 0) {
        const take = dp[(i - 1) * W + j - 1] + g;
        if (take > best) {
          best = take;
          how = 3;
        }
      }
      dp[i * W + j] = best;
      from[i * W + j] = how;
    }
  }
  const pairs = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    const how = from[i * W + j];
    if (how === 3) {
      pairs.push({ lrcTime: lrc[i - 1].time, videoTime: asr[j - 1].time, delta: asr[j - 1].time - lrc[i - 1].time });
      i--;
      j--;
    } else if (how === 2) j--;
    else i--;
  }
  pairs.reverse();
  if (pairs.length < 3) return null;
  const median = (arr) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  // ズレの連続性（区間の中央値から±1.5秒）で区間分け。単発の飛び値は捨てる。
  const groups = [];
  let cur = [pairs[0]];
  for (let k = 1; k < pairs.length; k++) {
    const m = median(cur.map(c => c.delta));
    if (Math.abs(pairs[k].delta - m) <= 1.5) cur.push(pairs[k]);
    else {
      groups.push(cur);
      cur = [pairs[k]];
    }
  }
  groups.push(cur);
  const solid = groups.filter(g => g.length >= 2);
  if (!solid.length) return null;
  // 対応の大半が安定区間に属していなければ照合自体を信用しない
  const covered = solid.reduce((n, g) => n + g.length, 0);
  if (covered < 3 || covered < pairs.length * 0.5) return null;
  const anchors = [];
  for (const g of solid) {
    const off = median(g.map(c => c.delta));
    // 直前の区間とオフセットがほぼ同じなら統合（間に飛び値があっただけ）
    if (anchors.length) {
      const prevOff = anchors[anchors.length - 1].videoTime - anchors[anchors.length - 1].lrcTime;
      if (Math.abs(prevOff - off) < 0.8) continue;
    }
    anchors.push({ lrcTime: g[0].lrcTime, videoTime: g[0].lrcTime + off });
  }
  return anchors.length ? anchors : null;
}

// ===== カラオケ風ハイライト =====

// 字幕トラックのjson3を生テキストで取得（単語オフセットを保持するため未パースで返す）
async function fetchCaptionTrackRaw(baseUrl) {
  try {
    const safeUrl = baseUrl.replace(/&tlang=[^&]*/g, '');
    const urlJson = safeUrl.includes('fmt=')
      ? safeUrl.replace(/fmt=[^&]*/, 'fmt=json3')
      : (safeUrl.includes('?') ? safeUrl + '&fmt=json3' : safeUrl + '?fmt=json3');
    const res = await fetch(urlJson);
    if (res.ok) {
      const text = await res.text();
      if (text && text.trim()) return text;
    }
  } catch (e) {}
  return null;
}

// json3のイベントから単語列を抽出（ASRはsegsに単語ごとの tOffsetMs を持つ）
function parseJson3Words(text) {
  const words = [];
  try {
    const json = JSON.parse(text);
    if (!json.events || !Array.isArray(json.events)) return null;
    let multiSegEvents = 0;
    let totalEvents = 0;
    for (const ev of json.events) {
      if (!ev.segs || !ev.segs.length) continue;
      const base = ev.tStartMs || 0;
      const segWords = ev.segs.filter(s => (s.utf8 || '').trim());
      if (!segWords.length) continue;
      totalEvents++;
      if (segWords.length > 1) multiSegEvents++;
      for (const s of segWords) {
        words.push({ time: (base + (s.tOffsetMs || 0)) / 1000, text: s.utf8.trim() });
      }
    }
    if (totalEvents === 0 || multiSegEvents < totalEvents * 0.3) return null;
  } catch (e) {
    return null;
  }
  return words;
}

// srv3(XML)の <p t=".."><s t="offset">語</s>... からも単語列を抽出できるようにする。
// プレイヤーが横取りキャッシュに残す形式がjson3とは限らないため両対応。
function parseSrv3Words(xmlText) {
  const decode = (s) => s.replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const attrNum = (attrs, name) => {
    const m = attrs.match(new RegExp('\\b' + name + '="(\\d+)"'));
    return m ? parseInt(m[1], 10) : 0;
  };
  const words = [];
  let totalP = 0;
  let multiP = 0;
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let pm;
  while ((pm = pRe.exec(xmlText)) !== null) {
    const base = attrNum(pm[1], 't');
    const sRe = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
    let sm;
    const segs = [];
    while ((sm = sRe.exec(pm[2])) !== null) {
      const w = decode(sm[2]).trim();
      if (w) segs.push({ time: (base + attrNum(sm[1], 't')) / 1000, text: w });
    }
    if (!segs.length) continue;
    totalP++;
    if (segs.length > 1) multiP++;
    words.push(...segs);
  }
  if (totalP === 0 || multiP < totalP * 0.3) return null;
  return words;
}

// 字幕レスポンスから単語列を抽出。単語オフセットを持たない字幕（手動字幕の多く）
// では null（単語時計として使えない）。この判定はASRレスポンスの識別にも使う。
function parseCaptionWords(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  let words = trimmed.charAt(0) === '{' ? parseJson3Words(trimmed) : parseSrv3Words(trimmed);
  if (!words || words.length < 8) return null;
  words.sort((a, b) => a.time - b.time);
  // 重複（同時刻・同語）除去
  const out = [];
  for (const w of words) {
    const p = out[out.length - 1];
    if (p && Math.abs(p.time - w.time) < 0.01 && p.text === w.text) continue;
    out.push(w);
  }
  return out;
}

// プレイヤーにASRトラックを一瞬ロードさせ、その字幕通信を横取りして生テキストを得る。
// 直接fetchが空ボディを返す環境（potトークン必須化以降）での本命ルート。
// CCの状態は元に戻す：OFFだったならOFFへ、ONだったなら元のトラックへ。
function forceInterceptAsrRaw(videoId, asrTrack, restoreCode) {
  return ytiPlayerMutex.run('asr-load', () => ytiForceInterceptAsrRawUnlocked(videoId, asrTrack, restoreCode));
}

function ytiForceInterceptAsrRawUnlocked(videoId, asrTrack, restoreCode) {
  return new Promise((resolve) => {
    let timeoutId;
    const ccBtnEl = document.querySelector('.ytp-subtitles-button');
    const ccWasOn = !!(ccBtnEl && ccBtnEl.getAttribute('aria-pressed') === 'true');
    const finish = (result) => {
      window.removeEventListener('YTI_CaptionData', handler);
      clearTimeout(timeoutId);
      try {
        if (!ccWasOn && ccBtnEl && ccBtnEl.getAttribute('aria-pressed') === 'true') {
          ccBtnEl.click();
        } else if (ccWasOn && restoreCode) {
          // 視聴者がCCで字幕を見ていた場合、ASRのまま放置せず元の言語へ戻す
          window.dispatchEvent(new CustomEvent('YTI_ForceChangeTrack', { detail: restoreCode }));
        }
      } catch (e) {}
      resolve(result);
    };
    const handler = (e) => {
      let d = null;
      try {
        d = JSON.parse(e.detail);
      } catch (_) {}
      if (!d || !d.text) return;
      if (videoId && d.videoId && d.videoId !== videoId) return;
      if (d.tlang) return;
      // 単語オフセットを持つレスポンス＝ASR。手動字幕の混入はここで弾かれる
      if (!parseCaptionWords(d.text)) return;
      finish(d.text);
    };
    window.addEventListener('YTI_CaptionData', handler);
    // page_script側の tracklist ロード待ちリトライ（最大2秒）を見込んだ余裕を持つ
    timeoutId = setTimeout(() => finish(null), 6000);
    window.dispatchEvent(new CustomEvent('YTI_ForceChangeTrack', {
      detail: JSON.stringify({
        languageCode: asrTrack.code,
        kind: 'asr',
        vssId: asrTrack.vssId || ('a.' + (asrTrack.code || ''))
      })
    }));
  });
}

// 成功済みの字幕通信URL（ドナー）から pot 等のセッションパラメータを移植する。
// baseUrlの署名パラメータはそのまま、不足分だけを補う。
function yti_graftSessionParams(baseUrl, donorUrl) {
  try {
    const dst = new URL(baseUrl, location.href);
    const src = new URL(donorUrl, location.href);
    ['pot', 'potc', 'c', 'cver', 'cplayer', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform'].forEach(p => {
      const v = src.searchParams.get(p);
      if (v !== null && !dst.searchParams.has(p)) dst.searchParams.set(p, v);
    });
    return dst.toString();
  } catch (e) {
    return null;
  }
}

// ASRの生字幕テキストを堅牢に取得する（4段フォールバック）。
// 1) パッシブ横取りキャッシュ  2) 直接fetch  3) pot移植fetch  4) 強制ロード＋横取り
async function getAsrRawText(videoId, asrTrack, allowIntercept, restoreCode) {
  const dbg = (msg) => {
    try {
      console.info('[YT Immersion] ASR取得: ' + msg);
    } catch (e) {}
  };
  // 1) プレイヤー自身が取得した字幕のコピーがMAIN世界キャッシュにあれば最優先
  let donorUrl = '';
  try {
    await requestCacheFromPage(videoId);
    const entries = ytiLyricsCache[videoId];
    if (entries) {
      for (const k of Object.keys(entries)) {
        if (k === '__last') continue;
        const ent = entries[k];
        if (!ent || !ent.text || ent.tlang) continue;
        if (ent.url && ent.url.indexOf('pot=') >= 0) donorUrl = ent.url;
        if (parseCaptionWords(ent.text)) {
          dbg('横取りキャッシュにヒット');
          return ent.text;
        }
      }
    }
  } catch (e) {}
  dbg('キャッシュに単語付きレスポンスなし');
  // 2) 直接fetch（近年は空ボディが多いが、生きている環境もあるので残す）
  if (asrTrack && asrTrack.baseUrl) {
    const raw = await fetchCaptionTrackRaw(asrTrack.baseUrl);
    if (raw && parseCaptionWords(raw)) {
      dbg('直接fetchで取得');
      return raw;
    }
    dbg('直接fetchは失敗（空ボディ等）');
    // 3) プレイヤーが成功させた通信からpot等を移植して再fetch
    if (donorUrl) {
      const grafted = yti_graftSessionParams(asrTrack.baseUrl, donorUrl);
      if (grafted) {
        const raw3 = await fetchCaptionTrackRaw(grafted);
        if (raw3 && parseCaptionWords(raw3)) {
          dbg('potパラメータ移植fetchで取得');
          return raw3;
        }
      }
      dbg('pot移植fetchも失敗');
    } else {
      dbg('potドナーURLなし（プレイヤーがまだ字幕通信をしていない）');
    }
  }
  // 4) 強制ロード＋横取り（CC状態は復元される）
  if (allowIntercept && asrTrack) {
    dbg('ASRトラックの強制ロード＋横取りを試行...');
    const raw = await forceInterceptAsrRaw(videoId, asrTrack, restoreCode);
    if (raw) {
      dbg('強制ロード横取りで取得');
      return raw;
    }
    dbg('強制ロード横取りも失敗');
  }
  return null;
}

// 各歌詞行に「時刻→行内位置(0..1)」の折れ線 line.karaoke を付与する。
// 行の時間窓に入るASR単語を集め、正規化文字長の累積比で行内位置を推定する。
// 表記（漢字/かな）が違っても、同じ音声を写しているので比率はほぼ一致する。
function attachKaraokeTiming(words) {
  if (!words || words.length < 8 || !lyricsData || !lyricsData.length) return;
  for (let i = 0; i < lyricsData.length; i++) {
    const line = lyricsData[i];
    if (line.isInstrumental) continue;
    const start = line.time;
    const next = lyricsData[i + 1];
    const end = Math.min(next ? next.time : start + 6, start + 15);
    if (end - start < 0.8) continue;
    const inWin = words.filter(w => w.time >= start - 0.4 && w.time < end - 0.05);
    if (inWin.length < 2) {
      line.karaoke = null;
      continue;
    }
    const lens = inWin.map(w => Math.max(1, yti_normalizeForMatch(w.text).length));
    const total = lens.reduce((a, b) => a + b, 0);
    const pts = [[Math.max(start, inWin[0].time), 0]];
    let acc = 0;
    for (let k = 1; k < inWin.length; k++) {
      acc += lens[k - 1];
      pts.push([inWin[k].time, acc / total]);
    }
    const avgGap = (inWin[inWin.length - 1].time - inWin[0].time) / Math.max(1, inWin.length - 1);
    pts.push([Math.min(end, inWin[inWin.length - 1].time + Math.max(0.4, avgGap)), 1]);
    line.karaoke = pts;
  }
}

// 毎フレーム呼ばれる塗り更新。ASR単語タイミングがあれば折れ線補間で、
// 無い行は行の表示時間で線形に0→1へ（近似カラオケ）。
// 毎フレーム呼ばれるので、DOMの検索や全行の走査はしない。
// 現在行は syncLyrics（timeupdate）が決めた番号から、次の行に進んだかだけを見る。
let karaokeClassApplied = null;

function updateKaraokeFill() {
  const root = rootContainer;
  if (!root) return;
  if (typeof ytiAdActive !== 'undefined' && ytiAdActive) return;
  if (karaokeEnabledCache === null) karaokeEnabledCache = getMvOption('mv_karaoke', true);
  if (karaokeClassApplied !== karaokeEnabledCache) {
    root.classList.toggle('karaoke-on', karaokeEnabledCache);
    karaokeClassApplied = karaokeEnabledCache;
  }
  if (!karaokeEnabledCache) return;
  if (!targetVideo || !lyricsData || !lyricsData.length) return;
  const t = targetVideo.currentTime;
  let idx = activeLyricIndex;
  if (idx < 0 || idx >= lyricsData.length || lyricsData[idx].time > t) idx = heldLyricIndex(findLyricIndexAt(t));
  else if (!(usingExternalLyrics && ytiAudioSync.isHoldingIntro())) {
    while (idx + 1 < lyricsData.length && lyricsData[idx + 1].time <= t) idx++;
  }
  if (idx < 0) return;
  const line = lyricsData[idx];
  if (!line || line.isInstrumental) return;
  if (line.tokens && typeof ytiFillTokens === 'function') {
    ytiFillTokens(line, t);
    return;
  }
  let frac = 0;
  const pts = line.karaoke;
  if (pts && pts.length >= 2) {
    if (t <= pts[0][0]) frac = 0;
    else if (t >= pts[pts.length - 1][0]) frac = 1;
    else {
      for (let k = 1; k < pts.length; k++) {
        if (t < pts[k][0]) {
          const [t0, f0] = pts[k - 1];
          const [t1, f1] = pts[k];
          frac = f0 + (f1 - f0) * ((t - t0) / Math.max(0.001, t1 - t0));
          break;
        }
      }
    }
  } else {
    // 線形近似：行開始→終了（次行 or 想定尺）。持ち歌詞に時計が無くてもそれっぽく塗る
    const next = lyricsData[idx + 1];
    let end = next ? next.time : line.time + 5;
    if (line.duration) end = Math.min(end, line.time + line.duration);
    end = Math.min(end, line.time + 12);
    frac = (t - line.time) / Math.max(0.5, end - line.time);
  }
  frac = Math.max(0, Math.min(1, frac));
  const val = frac.toFixed(4);
  if (line.el && line.el._ytiFill !== val) {
    line.el.style.setProperty('--yti-fill', val);
    line.el._ytiFill = val;
  }
  if (line.rmEl && line.rmEl._ytiFill !== val) {
    line.rmEl.style.setProperty('--yti-fill', val);
    line.rmEl._ytiFill = val;
  }
}

// ASR単語タイミングを非同期取得して現在の歌詞に付与（表示をブロックしない）
async function loadAsrWordsAndAttach(asrTrack, videoId, token, restoreCode) {
  asrWordStream = null;
  if (!asrTrack) {
    try {
      console.info('[YT Immersion] この動画にASRトラックなし。行単位の線形近似で塗ります');
    } catch (e) {}
    return;
  }
  // カラオケOFF（既定）のときは取得自体を行わない（無駄な通信・CC操作をしない）
  if (!getMvOption('mv_karaoke', true)) return;
  const allowIntercept = true;
  try {
    const raw = await getAsrRawText(videoId, asrTrack, allowIntercept, restoreCode);
    if (token !== mvContentToken) return;
    if ((new URLSearchParams(window.location.search).get('v')) !== videoId) return;
    const words = raw ? parseCaptionWords(raw) : null;
    if (words && words.length >= 8) {
      asrWordStream = words;
      attachKaraokeTiming(asrWordStream);
      try {
        console.info('[YT Immersion] カラオケ単語同期ON: ' + words.length + ' words');
      } catch (e) {}
      showToast('カラオケ: 単語タイミングに同期しました');
    } else {
      try {
        console.info('[YT Immersion] ASR単語タイミング取得不可。行単位の線形近似で塗ります');
      } catch (e) {}
    }
  } catch (e) {}
}

// 外部歌詞モードのヘッダー（出典バッジ・±0.5秒・同期リセット）
function buildExternalLyricsHeader(lyricsHeader) {
  if (!lyricsHeader) lyricsHeader = document.getElementById('mv-lyrics-header');
  if (!lyricsHeader || !externalLyricsInfo) return;
  lyricsHeader.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = 'mv-lyric-action-btn';
  badge.style.cssText = 'cursor:default;opacity:0.8;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  badge.textContent = `♪ ${externalLyricsInfo.trackName} — ${externalLyricsInfo.artistName}` + (externalLyricsInfo.source ? ` (${externalLyricsInfo.source})` : '');
  // 経過は後から届く取得元のぶんも見せたいので、ホバーした時に作り直す
  const badgeTitle = () => {
    const info = externalLyricsInfo;
    if (!info) return '';
    const syncHow = (info.segments && info.segments.length) ? 'YouTube Music の曲⇔動画の対応表で同期しています' :
      (info.timebase === 'video' ? 'この動画に合わせた時刻（LRCHub）で表示しています' : '自動生成字幕・音声から自動で同期します');
    return `歌詞の取得元: ${info.source}\n${syncHow}。ズレている場合は今歌われている行の時計ボタン、または [ ] キーで合わせ直せます` +
      (ytiHiddenLineCount > 0 ? `\n動画で切られている ${ytiHiddenLineCount} 行は表示していません` : '') +
      (typeof ytiTraceText === 'function' ? '\n\n― 取得の経過 ―\n' + ytiTraceText() : '');
  };
  badge.title = badgeTitle();
  badge.addEventListener('mouseenter', () => {
    badge.title = badgeTitle();
  });
  lyricsHeader.appendChild(badge);
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'mv-lyric-action-btn';
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    lyricsHeader.appendChild(b);
    return b;
  };
  mkBtn('−0.5s', '歌詞全体を0.5秒早める', () => nudgeLyricsOffset(-0.5));
  mkBtn('+0.5s', '歌詞全体を0.5秒遅らせる', () => nudgeLyricsOffset(0.5));
  mkBtn('同期リセット', 'この動画の同期補正をすべて消去して、自動同期をやり直す', () => {
    lyricsAnchors = [];
    saveLyricsAnchors();
    applyExternalLyricsData();
    showToast('同期をリセットしました。自動で合わせ直します');
    runExternalAutoSync(loadedLyricsVideoId || getVideoId(), mvContentToken, externalAsrTrack, '');
  });
}

// 外部歌詞の自動同期に使うASRトラック（同期リセット時の再実行用に覚えておく）
let externalAsrTrack = null;
// ASR との文字単位の突き合わせで得た、外部歌詞の各行の文字ごとの時刻（動画の時計）
let ytiAsrCharTimes = null;
// 動画で切られた区間として隠した行の数
let ytiHiddenLineCount = 0;
// 外部歌詞の本文の指紋。同期の補正は「どの歌詞に対して打ったか」と一緒に保存する
// （取得元が変わると曲の時計の頭出しがずれるため、別の歌詞の補正は当てない）。
function ytiLyricsHash(info) {
  if (!info || !info.lines) return '';
  return YTICore.text.hash32(info.lines.slice(0, 12).map(l => YTICore.text.normalizeForMatch(l.text)).join('|'));
}

// 字幕が取れなかったときの外部歌詞フォールバック本体。
// 歌詞は見つかった時点で（保存済みの同期補正があればそれを当てて）すぐ表示し、
// 自動同期は裏で進めて、終わったら行の時刻だけを差し替える。
// 以前はASRの取得（CCの強制切替・最大数秒）を待ってから表示していたため遅かった。
// 成功時は表示まで済ませて true を返す。呼び出し元は直後に世代チェックすること。
async function tryExternalLyricsFallback(videoId, lyricsArea, lyricsHeader, token, asrTrack) {
  if (!getMvOption('mv_external_lyrics', true)) return false;
  if (lyricsArea && !isShowingCachedLyrics(videoId)) {
    lyricsArea.classList.remove('no-lyrics', 'fade-out');
    lyricsArea.innerHTML = '<p style="color:rgba(255,255,255,0.3); font-size:20px; padding:20px;">歌詞を探しています...</p>';
  }
  const result = await findExternalLyricsDoc(videoId, {
    // 先に出した歌詞より良いもの（語単位）が後から届いたら差し替える
    onUpgrade: (better) => {
      if (token !== mvContentToken || loadedLyricsVideoId !== videoId || !usingExternalLyrics) return;
      ytiAdoptExternalInfo(better, videoId, null, token, asrTrack, true);
    }
  });
  if (token !== mvContentToken) return false;
  if (!result) return false;
  ytiAdoptExternalInfo(result, videoId, lyricsHeader, token, asrTrack, false);
  return true;
}

// 外部歌詞を表示中の歌詞として採用する（初回・格上げの両方）
function ytiAdoptExternalInfo(result, videoId, lyricsHeader, token, asrTrack, isUpgrade) {
  externalLyricsInfo = result;
  usingExternalLyrics = true;
  externalAsrTrack = asrTrack || null;
  lyricsAnchors = loadLyricsAnchors(videoId);
  loadedLyricsVideoId = videoId || '';
  lyricsLoadDoneVideoId = videoId || '';
  currentLyricsLang = '';
  applyExternalLyricsData();
  buildExternalLyricsHeader(lyricsHeader);
  const savedSrc = anchorsSource(lyricsAnchors);
  if (isUpgrade) showToast('語単位の歌詞に切り替えました（' + result.source + '）');
  else if (savedSrc === 'manual') showToast('外部歌詞を表示中（保存済みの同期補正を適用）');
  else if (result.segments && result.segments.length) showToast('YouTube Music の対応表で歌詞を同期しました');
  try {
    console.info('[YT Immersion] 外部歌詞: ' + result.source + ' / ' + result.trackName + ' — ' + result.artistName +
      (result.segments && result.segments.length ? ' / 公式の対応表 ' + result.segments.length + '区間' : ''));
  } catch (e) {}
  runExternalAutoSync(videoId, token, asrTrack, savedSrc);
  if (!isUpgrade) {
    try {
      ytiPrefetchNext(videoId);
    } catch (e) {}
  }
  if (typeof ytiOnExternalLyricsReady === 'function') {
    try {
      ytiOnExternalLyricsReady(videoId, token);
    } catch (e) {}
  }
}

// 外部歌詞の自動同期（裏で実行）。
//   1) ASRがあれば、歌詞と順序を保って照合してズレの階段を求める（最も正確）
//   2) ASRが無い・照合できない時は、再生中の音声から曲の始まり・間奏の挿入を推定する
// 手で合わせた補正（manual）は常に優先し、自動では上書きしない。
async function runExternalAutoSync(videoId, token, asrTrack, savedSrc) {
  const stillCurrent = () => token === mvContentToken && usingExternalLyrics && loadedLyricsVideoId === videoId;
  const info = externalLyricsInfo;
  // 公式の対応表がある・この動画に紐付いた時刻（LRCHub）なら、推定で合わせる必要はない
  const exact = !!(info && ((info.segments && info.segments.length) || info.timebase === 'video'));
  const needAlign = !exact && savedSrc !== 'manual' && savedSrc !== 'asr';
  const wantKaraoke = getMvOption('mv_karaoke', true);
  // 音声による推定は「再生の頭から聞いている」ことが前提なので、ASRの取得を待たずに始めておく
  if (needAlign && savedSrc !== 'audio') startAudioSync(videoId, token);
  // ASR は ①この動画の歌詞かの確認 ②時計合わせ ③語単位の塗り に使う。
  // 公式の語単位の歌詞なら、どれも要らないので字幕に触らない。
  const needCheck = !(info && info.official);
  const needKaraokeTimes = wantKaraoke && info && info.quality < 2;
  if (!asrTrack || (!needAlign && !needCheck && !needKaraokeTimes)) return;
  let asrRaw = null;
  try {
    asrRaw = await getAsrRawText(videoId, asrTrack, true);
  } catch (e) {}
  if (!stillCurrent() || !asrRaw) return;
  const words = parseCaptionWords(asrRaw);
  if (!words || words.length < 8) return;
  asrWordStream = words;
  const check = ytiCheckWithAsr(externalLyricsInfo, words);
  if (check && typeof ytiTrace === 'function') {
    ytiTrace(videoId, '自動生成字幕', `一致率 ${(check.coverage * 100).toFixed(0)}%` + (check.substantive ? '' : '（字幕に中身なし）') +
      (check.anchors && check.anchors.length ? ` / 対応点 ${check.anchors.length}` : ''));
  }
  if (check && !check.accepted) {
    // 歌詞が動画の歌とほとんど一致しない＝別の曲・別の言語の歌詞。出さない方がまし。
    try {
      console.warn('[YT Immersion] 外部歌詞が自動生成字幕と一致しないため取り下げ: ' + info.source + ' 一致率 ' + check.coverage.toFixed(2));
    } catch (e) {}
    ytiStoreSet(YTI_EXT2_PREFIX + videoId, { at: Date.now(), miss: true });
    usingExternalLyrics = false;
    externalLyricsInfo = null;
    lyricsData = [];
    const lyricsArea = document.getElementById('mv-lyrics-area');
    if (lyricsArea) showNoLyrics(lyricsArea, '見つかった歌詞がこの動画の歌と一致しないため表示しません', { fontSize: '16px', opacity: '0.6' });
    return;
  }
  if (needAlign && anchorsSource(lyricsAnchors) !== 'manual') {
    let auto = (check && check.anchors && check.anchors.length) ? check.anchors : null;
    // 文字単位で取れなかった時は、従来の行単位の照合（字幕の区間どうし）を試す
    if (!auto) {
      const asrSegs = parseCaptionResponse(asrRaw);
      const old = (asrSegs && asrSegs.length) ? autoAlignWithAsr(externalLyricsInfo.lines, asrSegs) : null;
      if (old && old.length) auto = old.map(a => ({ lrcTime: a.lrcTime, videoTime: a.videoTime, src: 'asr' }));
    }
    if (auto && auto.length) {
      ytiAudioSync.stop();
      const lh = ytiLyricsHash(externalLyricsInfo);
      lyricsAnchors = auto.map(a => Object.assign({}, a, { src: 'asr', lh }));
      saveLyricsAnchors();
      if (check) ytiAsrCharTimes = check.charTimes;
      applyExternalLyricsData();
      const cut = lyricsData.length ? (externalLyricsInfo.lines.length - lyricsData.filter(l => !l.isInstrumental).length) : 0;
      const rated = auto.some(a => a.rate && Math.abs(a.rate - 1) > 0.01);
      showToast('外部歌詞を自動生成字幕と自動同期しました' + (rated ? '（速度の違いも補正）' : '') + (cut > 0 ? `（動画に無い${cut}行を非表示）` : ''));
      return;
    }
  }
  if (check && check.charTimes && check.charTimes.length) {
    ytiAsrCharTimes = check.charTimes;
    applyExternalLyricsData();
  } else if (asrWordStream) attachKaraokeTiming(asrWordStream);
}

function startAudioSync(videoId, token) {
  if (!targetVideo || !externalLyricsInfo) return;
  // 公式の対応表・この動画の時刻がある時は推定しない（推定の方が粗い）
  if ((externalLyricsInfo.segments && externalLyricsInfo.segments.length) || externalLyricsInfo.timebase === 'video') {
    ytiAudioSync.stop();
    return;
  }
  const started = ytiAudioSync.start({
    video: targetVideo,
    key: videoId,
    lrcLines: externalLyricsInfo.lines,
    trackDuration: externalLyricsInfo.duration || 0,
    onAnchors: (anchors, kind) => {
      if (token !== mvContentToken || !usingExternalLyrics || loadedLyricsVideoId !== videoId) {
        ytiAudioSync.stop();
        return;
      }
      // その間に手動・ASRで合わせられていたら、音声の推定では上書きしない
      const src = anchorsSource(lyricsAnchors);
      if (src === 'manual' || src === 'asr') {
        ytiAudioSync.stop();
        return;
      }
      const lh = ytiLyricsHash(externalLyricsInfo);
      lyricsAnchors = anchors.map(a => Object.assign({}, a, { lh }));
      saveLyricsAnchors();
      applyExternalLyricsData();
      showToast(kind === 'intro' ? '歌い出しを音声から検出して歌詞を同期しました' : '間奏の映像パートを検出して歌詞を合わせ直しました');
    }
  });
  if (started) console.info('[YT Immersion] 音声による外部歌詞の自動同期を開始');
}

async function updateMVContent(retryCount = 0, token = null) {
  // 世代トークン：新しいロードが始まったら、進行中の古いチェーン（リトライ含む）は
  // ここで打ち切る。複数チェーンが同時にCCボタンを操作して両方失敗する競合を防ぐ。
  if (token === null) {
    // 表示中の動画の歌詞が出来上がっているなら、世代を進めずに帰る。
    // （yt-page-data-updated の遅延発火のたびに世代が進むと、裏で進めている自動同期・
    //   語単位への格上げ・訳の取得が「古い世代」として捨てられていた）
    const vidNow = new URLSearchParams(window.location.search).get('v');
    const la = document.getElementById('mv-lyrics-area');
    if (retryCount === 0 && vidNow && vidNow === loadedLyricsVideoId && lyricsData.length > 0 && la && la.querySelector('.lyric-line-container')) {
      updateMetadataUI();
      try {
        updateSidebarContent(0);
      } catch (e) {}
      return;
    }
    token = ++mvContentToken;
  }
  if (token !== mvContentToken) return;
  const lyricsArea = document.getElementById('mv-lyrics-area');
  const lyricsHeader = document.getElementById('mv-lyrics-header');
  const videoId = new URLSearchParams(window.location.search).get('v');
  // この動画の歌詞が既に表示済みなら再取得しない
  // （yt-page-data-updated の遅延発火による無駄な取り直し＆表示消失を防ぐ）
  if (retryCount === 0 && videoId && videoId === loadedLyricsVideoId &&
      lyricsData.length > 0 && lyricsArea && lyricsArea.querySelector('.lyric-line-container')) {
    updateMetadataUI();
    try {
      updateSidebarContent(0);
    } catch (e) {}
    return;
  }
  if (lyricsArea) {
    lyricsArea.classList.remove('no-lyrics', 'fade-out', 'selecting');
    lyricsArea.onmouseenter = null;
    lyricsArea.onmouseleave = null;
  }
  ytiLoadingVideoId = videoId || '';
  isLyricSelectionMode = false;
  if (retryCount === 0) {
    // 曲名は消さずに、取得処理より先に今の動画のものへ更新する
    try {
      updateMetadataUI();
    } catch (e) {}
    if (lyricsHeader) lyricsHeader.innerHTML = '';
    lyricsData = [];
    lyricsByLanguage = {};
    currentLyricsLang = '';
    usingExternalLyrics = false;
    externalLyricsInfo = null;
    externalAsrTrack = null;
    lyricsAnchors = [];
    asrWordStream = null;
    ytiAsrCharTimes = null;
    ytiHiddenLineCount = 0;
    ytiCurrentWarp = null;
    // 視聴ページで再生が始まった時から記録している同じ動画の音量は、捨てずに引き継ぐ
    if (ytiAudioSync.primedKey() !== videoId) ytiAudioSync.stop();
    // 外部歌詞の自動同期に備えて、曲の冒頭から音量を記録しておく
    // （歌詞の検索を待ってから聞き始めると、イントロの長さが分からなくなる）
    if (getMvOption('mv_external_lyrics', true) && targetVideo && videoId) {
      try {
        ytiAudioSync.prime(targetVideo, videoId);
      } catch (e) {}
    }
    lyricsRenderVersion++;
    cacheShownVideoId = '';
    cacheShownSig = '';
    lyricsLoadDoneVideoId = '';
    if (rootContainer) rootContainer.classList.remove('no-lyrics-mode');
    // 保存済みの歌詞があれば通信を待たずに即描画し、以降の取得は裏で続行する
    if (!showLyricsFromCache(videoId) && lyricsArea) {
      lyricsArea.innerHTML = '<p style="color:rgba(255,255,255,0.3); font-size:20px; padding:20px;">読み込み中...</p>';
    }
  }
  const tracklistData = await getCaptionTracklistFromPlayer();
  if (token !== mvContentToken) return;
  const tracks = tracklistData.list || [];
  const defaultLang = tracklistData.defaultLang || '';
  const excludeAuto = getMvOption('mv_exclude_auto', true);
  const autoPriority = getMvOption('mv_lang_auto_priority', true);
  // プレイヤーがまだ前の動画の情報を返している間（SPA遷移直後）は待って再試行。
  // 前の動画のトラックURLで取得すると失敗や別の曲の歌詞表示につながる。
  const isStaleResponse = !!(tracklistData.videoId && videoId && tracklistData.videoId !== videoId);
  // プレイヤーがこの動画の情報を返した上で字幕トラックが0本なら、字幕は無いと確定してよい。
  // 以前は1秒×5回待ってから外部歌詞を探していたため、表示までに5秒以上かかっていた。
  const confirmedNoTracks = !isStaleResponse && !!tracklistData.videoId && tracklistData.videoId === videoId;
  if (isStaleResponse || !tracks || tracks.length === 0) {
    const maxRetry = isStaleResponse ? 10 : (confirmedNoTracks ? 1 : 5);
    if (retryCount < maxRetry) {
      setTimeout(() => updateMVContent(retryCount + 1, token), confirmedNoTracks ? 500 : 1000);
      return;
    } else {
      // 字幕トラックが1本も無い動画：外部歌詞（LRCLIB）を探す
      const gotExternal = await tryExternalLyricsFallback(videoId, lyricsArea, lyricsHeader, token, null);
      if (token !== mvContentToken) return;
      // キャッシュから既に歌詞を出せている場合は、それを消してまで
      // 「ありません」に上書きしない
      if (!gotExternal && lyricsArea && !isShowingCachedLyrics(videoId)) {
        showNoLyrics(lyricsArea, '歌詞情報がありません');
      }
      lyricsLoadDoneVideoId = videoId || '';
    }
    updateMetadataUI();
    try {
      updateSidebarContent(0);
    } catch (e) {}
    return;
  }
  const langList = tracks.map(t => {
    let url = t.baseUrl;
    if (!url) {
      url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${t.languageCode || ''}&fmt=json3`;
    }
    return {
      code: t.languageCode || t.vssId || '',
      name: (t.name && t.name.simpleText) ? t.name.simpleText : (t.languageCode || t.vssId || '言語'),
      vssId: t.vssId,
      isAuto: (t.kind === 'asr') || (t.vssId && t.vssId.startsWith('a.')),
      baseUrl: url
    };
  });
  // #3 「自動生成字幕を使わない」オプション（既定ON）。OFFなら自動生成も候補に含める。
  const validLangs = langList.filter(t => excludeAuto ? !t.isAuto : true);
  if (validLangs.length === 0) {
    // 自動生成(ASR)しか無い動画：ここがハイブリッド同期の主戦場。
    // テキストはLRCLIB、時計はASRから借りて自動整合する。
    const asrTrack = langList.find(t => t.isAuto) || null;
    const gotExternal = await tryExternalLyricsFallback(videoId, lyricsArea, lyricsHeader, token, asrTrack);
    if (token !== mvContentToken) return;
    if (!gotExternal && lyricsArea && !isShowingCachedLyrics(videoId)) {
      showNoLyrics(lyricsArea, '自動生成字幕のため非表示', { fontSize: '16px', opacity: '0.6' });
    }
    lyricsLoadDoneVideoId = videoId || '';
    updateMetadataUI();
    try {
      updateSidebarContent(0);
    } catch (e) {}
    return;
  }
  const isJaTrack = (t) => /^ja/i.test(t.code || '') || (t.name && t.name.indexOf('日本語') >= 0);
  const langMatches = (t, code) => {
    if (!t || !code) return false;
    const a = (t.code || '').toLowerCase();
    const b = code.toLowerCase();
    return a === b || a.startsWith(b) || b.startsWith(a) || t.name === code;
  };
  const savedLangCode = localStorage.getItem('mv_lyrics_lang_code') || localStorage.getItem('mv_lyrics_lang');
  const savedSubLangCode = localStorage.getItem('mv_lyrics_sub_lang_code') || localStorage.getItem('mv_lyrics_sub_lang') || 'none';
  let mainTrack, subTrack;
  if (autoPriority) {
    // #4 YouTube Music風：原文（アップロード元の言語）をメイン、日本語をサブに表示。
    const jaTrack = validLangs.find(isJaTrack);
    const nativeTrack =
      (defaultLang && validLangs.find(t => langMatches(t, defaultLang))) ||
      validLangs.find(t => !isJaTrack(t)) ||
      validLangs[0];
    mainTrack = nativeTrack || validLangs[0];
    subTrack = (jaTrack && jaTrack !== mainTrack) ? jaTrack : null;
  } else {
    // 手動優先：ユーザーが選んだ言語を記憶して使う（従来の挙動）。
    mainTrack = validLangs.find(t => t.code === savedLangCode || t.name === savedLangCode) || validLangs[0];
    subTrack = savedSubLangCode !== 'none' ? validLangs.find(t => t.code === savedSubLangCode || t.name === savedSubLangCode) : null;
  }
  const forceIntercept = (track) => {
    if (!track) return Promise.resolve(null);
    return ytiPlayerMutex.run('track-load', () => forceInterceptUnlocked(track));
  };
  const forceInterceptUnlocked = (track) => {
    return new Promise((resolve) => {
      let timeoutId;
      // メタ情報付きの YTI_CaptionData を使い、別動画・自動翻訳・別言語の
      // レスポンスを誤って採用しないようにする（遷移直後の混入対策）
      const langMatch = (a, b) => !a || !b || a === b || a.startsWith(b) || b.startsWith(a);
      const ccBtnEl = document.querySelector('.ytp-subtitles-button');
      const ccWasOn = !!(ccBtnEl && ccBtnEl.getAttribute('aria-pressed') === 'true');
      const finish = (result) => {
        window.removeEventListener('YTI_CaptionData', handler);
        clearTimeout(timeoutId);
        // YTI_ForceChangeTrack（内部でtoggleSubtitlesOn）がCCをONのまま残すと、
        // YouTubeが字幕言語を記憶して次の動画で外国語・自動翻訳字幕を勝手に
        // 読み込む汚染源になる。元がOFFだったならOFFへ戻す。
        try {
          if (!ccWasOn && ccBtnEl && ccBtnEl.getAttribute('aria-pressed') === 'true') ccBtnEl.click();
        } catch (e) {}
        resolve(result);
      };
      const handler = (e) => {
        let d = null;
        try {
          d = JSON.parse(e.detail);
        } catch (_) {}
        if (!d || !d.text) return;
        if (videoId && d.videoId && d.videoId !== videoId) return;
        if (d.tlang) return;
        if (!langMatch(d.lang, track.code)) return;
        finish(parseCaptionResponse(d.text));
      };
      window.addEventListener('YTI_CaptionData', handler);
      timeoutId = setTimeout(() => finish(null), 2500);
      window.dispatchEvent(new CustomEvent('YTI_ForceChangeTrack', {
        detail: track.code
      }));
    });
  };
  let newMainRaw = null;
  let newSubRaw = null;
  // ===== 0秒キャッシュ参照 =====
  // MAIN世界(page_script.js)がパッシブ収集した字幕を最優先で読む。
  // ヒットすればYouTubeへの再通信・トラック強制切替を一切行わない。
  await requestCacheFromPage(videoId);
  if (token !== mvContentToken) return;
  newMainRaw = getCachedCaptionForTrack(videoId, mainTrack);
  if (subTrack) newSubRaw = getCachedCaptionForTrack(videoId, subTrack);
  // 各フォールバックの合間にも世代チェックを行い、キャンセル済みチェーンが
  // CCボタンや文字起こしパネルを操作し続けて新しいロードと競合しないようにする
  if (!subTrack) {
    if (!newMainRaw || newMainRaw.length === 0) newMainRaw = await fetchCaptionTrack(mainTrack.baseUrl);
    if (token !== mvContentToken) return;
    // forceInterceptはトラックを明示指定して切り替えるため、前の動画で記憶された
    // 外国語の字幕設定をこの動画の正しい言語に戻す効果もある
    if (!newMainRaw || newMainRaw.length === 0) newMainRaw = await forceIntercept(mainTrack);
    if (token !== mvContentToken) return;
    if (!newMainRaw || newMainRaw.length === 0) newMainRaw = await interceptFromCCButton();
    if (token !== mvContentToken) return;
    if (!newMainRaw || newMainRaw.length === 0) newMainRaw = await scrapeTranscriptFromDOM();
  } else {
    // キャッシュで両方そろっていれば、再生待ち・強制切替もスキップ
    if ((!newSubRaw || newSubRaw.length === 0) || (!newMainRaw || newMainRaw.length === 0)) {
      if (targetVideo && targetVideo.readyState < 2) {
        await new Promise(r => {
          const onPlay = () => {
            targetVideo.removeEventListener('playing', onPlay);
            r();
          };
          targetVideo.addEventListener('playing', onPlay);
          setTimeout(r, 2000);
        });
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
      if (token !== mvContentToken) return;
    }
    if (!newSubRaw || newSubRaw.length === 0) {
      newSubRaw = await forceIntercept(subTrack);
      if (token !== mvContentToken) return;
      if (!newSubRaw || newSubRaw.length === 0) newSubRaw = await fetchCaptionTrack(subTrack.baseUrl);
      if (token !== mvContentToken) return;
    }
    if (!newMainRaw || newMainRaw.length === 0) {
      newMainRaw = await forceIntercept(mainTrack);
      if (token !== mvContentToken) return;
      if (!newMainRaw || newMainRaw.length === 0) newMainRaw = await fetchCaptionTrack(mainTrack.baseUrl);
      if (token !== mvContentToken) return;
      if (!newMainRaw || newMainRaw.length === 0) {
        newMainRaw = await interceptFromCCButton();
        if (token !== mvContentToken) return;
        if (!newMainRaw || newMainRaw.length === 0) newMainRaw = await scrapeTranscriptFromDOM();
      }
    }
  }
  if (token !== mvContentToken) return;
  if (!newMainRaw || newMainRaw.length === 0) {
    // 字幕トラックはあるのに取得に失敗：外部歌詞へフォールバック
    const asrTrack = langList.find(t => t.isAuto) || null;
    const gotExternal = await tryExternalLyricsFallback(videoId, lyricsArea, lyricsHeader, token, asrTrack);
    if (token !== mvContentToken) return;
    if (!gotExternal && lyricsArea && !isShowingCachedLyrics(videoId)) {
      showNoLyrics(lyricsArea, '歌詞の取得に失敗しました');
    }
    lyricsLoadDoneVideoId = videoId || '';
    updateMetadataUI();
    try {
      updateSidebarContent(0);
    } catch (e) {}
    return;
  }
  // 字幕で表示できるので、外部歌詞の音声同期に備えた音量の記録は止める
  ytiAudioSync.stop();
  const merged = mergeDualLyrics(newMainRaw, newSubRaw);
  // キャッシュから描いた内容と同じなら、配列ごと差し替えずに今の表示を維持する
  const sameAsCached = cacheShownVideoId === videoId && !!cacheShownSig &&
    lyricsSignature(merged) === cacheShownSig;
  if (!sameAsCached) lyricsData = merged;
  loadedLyricsVideoId = videoId || '';
  lyricsLoadDoneVideoId = videoId || '';
  currentLyricsLang = mainTrack.code;
  localStorage.setItem('mv_lyrics_lang_code', mainTrack.code);
  localStorage.setItem('mv_lyrics_sub_lang_code', subTrack ? subTrack.code : 'none');
  saveLyricsToCache(videoId, lyricsData, {
    lang: mainTrack.code,
    subLang: subTrack ? subTrack.code : ''
  });
  if (lyricsHeader) {
    lyricsHeader.innerHTML = '';
    const mainLangSelect = document.createElement('select');
    mainLangSelect.className = 'mv-lyric-action-btn';
    mainLangSelect.style.cssText = 'min-width:100px;padding:6px 8px;margin-right:4px;cursor:pointer;font-size:13px;';
    mainLangSelect.title = 'メイン言語';
    const subLangSelect = document.createElement('select');
    subLangSelect.className = 'mv-lyric-action-btn';
    subLangSelect.style.cssText = 'min-width:100px;padding:6px 8px;margin-right:8px;cursor:pointer;font-size:13px;';
    subLangSelect.title = 'サブ言語（翻訳など）';
    const noneOpt = document.createElement('option');
    noneOpt.value = 'none';
    noneOpt.textContent = 'サブなし';
    subLangSelect.appendChild(noneOpt);
    validLangs.forEach(item => {
      const optMain = document.createElement('option');
      optMain.value = item.code;
      optMain.textContent = item.name;
      if (item.code === mainTrack.code) optMain.selected = true;
      mainLangSelect.appendChild(optMain);
      const optSub = document.createElement('option');
      optSub.value = item.code;
      optSub.textContent = item.name;
      if (subTrack && item.code === subTrack.code) optSub.selected = true;
      subLangSelect.appendChild(optSub);
    });
    // 連続で言語を切り替えたとき、古い取得結果が後から上書きしないよう世代管理する
    let langChangeSeq = 0;
    const handleLanguageChange = async () => {
      const seq = ++langChangeSeq;
      const mCode = mainLangSelect.value;
      const sCode = subLangSelect.value;
      const mTrack = validLangs.find(t => t.code === mCode);
      const sTrack = validLangs.find(t => t.code === sCode);
      if (!mTrack) return;
      showToast('字幕データを読み込み中...');
      let mRaw = null;
      let sRaw = null;
      // 0秒キャッシュ参照を最優先（ヒットすれば再通信なし）
      await requestCacheFromPage(videoId);
      mRaw = getCachedCaptionForTrack(videoId, mTrack);
      if (sTrack) sRaw = getCachedCaptionForTrack(videoId, sTrack);
      if (!sTrack) {
        if (!mRaw || mRaw.length === 0) mRaw = await fetchCaptionTrack(mTrack.baseUrl);
        if (!mRaw || mRaw.length === 0) mRaw = await forceIntercept(mTrack);
        if (!mRaw || mRaw.length === 0) mRaw = await interceptFromCCButton();
        if (!mRaw || mRaw.length === 0) mRaw = await scrapeTranscriptFromDOM();
      } else {
        if (!sRaw || sRaw.length === 0) {
          sRaw = await forceIntercept(sTrack);
          if (!sRaw || sRaw.length === 0) sRaw = await fetchCaptionTrack(sTrack.baseUrl);
        }
        if (!mRaw || mRaw.length === 0) {
          mRaw = await forceIntercept(mTrack);
          if (!mRaw || mRaw.length === 0) mRaw = await fetchCaptionTrack(mTrack.baseUrl);
          if (!mRaw || mRaw.length === 0) {
            mRaw = await interceptFromCCButton();
            if (!mRaw || mRaw.length === 0) mRaw = await scrapeTranscriptFromDOM();
          }
        }
      }
      // 取得中に別の動画へ遷移した／さらに新しい切替が始まっていたら適用しない
      if (seq !== langChangeSeq) return;
      if ((new URLSearchParams(window.location.search).get('v')) !== videoId) return;
      if (mRaw && mRaw.length > 0) {
        lyricsData = mergeDualLyrics(mRaw, sRaw);
        currentLyricsLang = mCode;
        localStorage.setItem('mv_lyrics_lang_code', mTrack.code);
        localStorage.setItem('mv_lyrics_sub_lang_code', sTrack ? sTrack.code : 'none');
        saveLyricsToCache(videoId, lyricsData, {
          lang: mTrack.code,
          subLang: sTrack ? sTrack.code : ''
        });
        renderLyricsDOM(lyricsArea);
        if (asrWordStream) attachKaraokeTiming(asrWordStream);
        try {
          syncLyrics();
        } catch (e) {}
        showToast('言語を切り替えました');
      } else {
        showToast('切り替えに失敗しました');
      }
    };
    mainLangSelect.onchange = handleLanguageChange;
    subLangSelect.onchange = handleLanguageChange;
    lyricsHeader.appendChild(mainLangSelect);
    lyricsHeader.appendChild(subLangSelect);
    const langBtn = document.createElement('button');
    langBtn.className = 'mv-lyric-action-btn';
    langBtn.title = "歌詞の表示（原文・訳・全表示）を切り替え";
    const savedMode = localStorage.getItem('mv_lyrics_mode') || 'all';
    let currentMode = savedMode === 'native_only' ? 2 : (savedMode === 'jp_only' ? 1 : 0);
    const updateLangBtn = (isInit = false) => {
      lyricsArea.classList.remove('mode-jp-only', 'mode-native-only');
      const rmScroll = document.getElementById('rm-lyrics-scroll');
      if (rmScroll) rmScroll.classList.remove('mode-jp-only', 'mode-native-only');
      if (currentMode === 0) {
        langBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> 全表示';
        langBtn.style.background = '';
        langBtn.style.color = '';
        localStorage.setItem('mv_lyrics_mode', 'all');
        if (!isInit) showToast("全ての行を表示します");
      } else if (currentMode === 1) {
        lyricsArea.classList.add('mode-jp-only');
        if (rmScroll) rmScroll.classList.add('mode-jp-only');
        langBtn.innerHTML = '<span style="font-weight:800;font-size:11px;margin-right:4px;">JP</span> 訳のみ';
        langBtn.style.background = '#fff';
        langBtn.style.color = '#000';
        localStorage.setItem('mv_lyrics_mode', 'jp_only');
        if (!isInit) showToast("日本語（訳）のみ表示します");
      } else {
        lyricsArea.classList.add('mode-native-only');
        if (rmScroll) rmScroll.classList.add('mode-native-only');
        langBtn.innerHTML = '<span style="font-weight:800;font-size:11px;margin-right:4px;">Aa</span> 原文のみ';
        langBtn.style.background = '#007AFF';
        langBtn.style.color = '#fff';
        localStorage.setItem('mv_lyrics_mode', 'native_only');
        if (!isInit) showToast("原文（非日本語）のみ表示します");
      }
    };
    updateLangBtn(true);
    langBtn.onclick = () => {
      currentMode = (currentMode + 1) % 3;
      updateLangBtn();
    };
    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'mv-lyric-action-btn';
    copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
    copyAllBtn.onclick = () => {
      let targetText = [];
      lyricsData.forEach(l => {
        const lines = l.text.split(/\r\n|\n|\r/);
        lines.forEach(sub => {
          const isJP = !!sub.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
          if (currentMode === 1 && !isJP) return;
          if (currentMode === 2 && isJP) return;
          targetText.push(sub);
        });
      });
      navigator.clipboard.writeText(targetText.join('\n')).then(() => showToast("表示中の歌詞をコピーしました"));
    };
    const selectBtn = document.createElement('button');
    selectBtn.className = 'mv-lyric-action-btn';
    selectBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
    selectBtn.onclick = () => {
      isLyricSelectionMode = !isLyricSelectionMode;
      if (isLyricSelectionMode) {
        lyricsArea.classList.add('selecting');
        selectBtn.innerHTML = 'キャンセル';
        copyAllBtn.innerHTML = 'コピー (0)';
        copyAllBtn.classList.add('primary');
        copyAllBtn.onclick = () => {
          const selectedEls = lyricsArea.querySelectorAll('.lyric-line-container.selected .lyric-line');
          const visibleTexts = [];
          selectedEls.forEach(el => {
            if (window.getComputedStyle(el).display !== 'none') {
              visibleTexts.push(el.innerText);
            }
          });
          if (visibleTexts.length === 0) return;
          navigator.clipboard.writeText(visibleTexts.join('\n')).then(() => {
            showToast(`${visibleTexts.length}行をコピーしました`);
            selectBtn.click();
          });
        };
      } else {
        lyricsArea.classList.remove('selecting');
        const selected = lyricsArea.querySelectorAll('.selected');
        selected.forEach(el => el.classList.remove('selected'));
        selectBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
        copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
        copyAllBtn.classList.remove('primary');
        copyAllBtn.onclick = () => {
          let targetText = [];
          lyricsData.forEach(l => {
            const lines = l.text.split(/\r\n|\n|\r/);
            lines.forEach(sub => {
              const isJP = !!sub.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
              if (currentMode === 1 && !isJP) return;
              if (currentMode === 2 && isJP) return;
              targetText.push(sub);
            });
          });
          navigator.clipboard.writeText(targetText.join('\n')).then(() => showToast("表示中の歌詞をコピーしました"));
        };
      }
    };
    lyricsHeader.appendChild(langBtn);
    lyricsHeader.appendChild(selectBtn);
    lyricsHeader.appendChild(copyAllBtn);
    const lrcBtn = document.createElement('button');
    lrcBtn.className = 'mv-lyric-action-btn';
    lrcBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> LRC保存';
    lrcBtn.onclick = () => {
      downloadLrc();
    };
    lyricsHeader.appendChild(lrcBtn);
  }
  // キャッシュ表示と同一内容なら描き直さない（スクロール位置とハイライトを保つ）
  if (!sameAsCached && lyricsArea) renderLyricsDOM(lyricsArea);
  // 手動字幕を表示しつつ、ASRトラックがあれば単語タイミングを非同期で借りて
  // カラオケ塗りを有効化する（テキストは正しい字幕、時計はASR）
  try {
    loadAsrWordsAndAttach(langList.find(t => t.isAuto) || null, videoId, token,
      (mainTrack && mainTrack.code) || '');
  } catch (e) {}
  // 描画直後に一度同期して初期ハイライト＆スクロール位置を確定させる。
  // （動画が一時停止/バッファリング中で timeupdate が来なくても同期されるように）
  try {
    syncLyrics();
  } catch (e) {}
  // 訳・読み・パート分けなど（language.js / parts.js）と、次の動画の歌詞の先読み
  try {
    ytiOnCaptionLyricsReady(videoId, token);
    ytiPrefetchNext(videoId);
  } catch (e) {}
  updateMetadataUI();
  try {
    updateSidebarContent(0);
  } catch (e) {}
}

function updateSidebarContent(retryCount = 0) {
  const listContainer = document.getElementById('mv-next-list');
  if (!listContainer || !isSidebarEnabled()) return;
  const currentVid = new URLSearchParams(window.location.search).get('v');
  let items = [];
  let sourceMode = 'related';
  const playlistItems = document.querySelectorAll('ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer');
  if (playlistItems.length > 0) {
    sourceMode = 'playlist';
    items = playlistItems;
  } else {
    const relatedContainer = document.querySelector('#related') || document.querySelector('#secondary');
    if (relatedContainer) {
      const autoplayItem = relatedContainer.querySelectorAll('ytd-compact-autoplay-renderer');
      const videoItems = relatedContainer.querySelectorAll('ytd-compact-video-renderer');
      items = [...autoplayItem, ...videoItems];
    }
  }
  if (items.length === 0) {
    if (retryCount < 10) setTimeout(() => updateSidebarContent(retryCount + 1), 1000);
    return;
  }
  const tempFragment = document.createDocumentFragment();
  let count = 0;
  items.forEach(item => {
    if (count >= 20) return;
    try {
      const linkEl = item.querySelector('a#thumbnail') || item.querySelector('a');
      if (!linkEl || !linkEl.href) return;
      const href = linkEl.href;
      const urlObj = new URL(href);
      const vidId = urlObj.searchParams.get('v');
      if (!vidId || vidId === currentVid) return;
      let titleText = "";
      const titleEl = item.querySelector('#video-title');
      if (titleEl) {
        titleText = titleEl.textContent.trim();
        if (!titleText && titleEl.getAttribute('title')) titleText = titleEl.getAttribute('title');
      }
      if (!titleText) return;
      let artistText = "";
      const channelEl = item.querySelector('.secondary-metadata') || item.querySelector('#byline-container') || item.querySelector('ytd-channel-name');
      if (channelEl) artistText = channelEl.textContent.trim().replace(/\n/g, '').replace(/\s+/g, ' ');
      const thumbSrc = `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;
      // タイトル等は投稿者が自由に付けられる文字列なので、HTMLとしてではなくテキストとして入れる
      const card = document.createElement('a');
      card.className = 'mv-next-item';
      card.href = href;
      const img = document.createElement('img');
      img.src = thumbSrc;
      img.className = 'mv-next-item-thumb';
      img.loading = 'lazy';
      img.style.cssText = 'width: 110px; height: 62px; border-radius: 6px; object-fit: cover; background: #333; margin-right: 15px; flex-shrink: 0;';
      const info = document.createElement('div');
      info.className = 'mv-next-info';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'mv-next-title';
      titleDiv.textContent = titleText;
      const artistDiv = document.createElement('div');
      artistDiv.className = 'mv-next-artist';
      artistDiv.textContent = artistText;
      info.appendChild(titleDiv);
      info.appendChild(artistDiv);
      card.appendChild(img);
      card.appendChild(info);
      tempFragment.appendChild(card);
      count++;
    } catch (e) {}
  });
  listContainer.innerHTML = '';
  listContainer.appendChild(tempFragment);
  const sidebarTitle = document.querySelector('#mv-sidebar h2');
  if (sidebarTitle) sidebarTitle.innerText = (sourceMode === 'playlist') ? 'プレイリスト' : '次はこちら';
}

function buildSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'mv-settings-panel';
  const makeToggle = (label, desc, key, def, onChange) => {
    const row = document.createElement('label');
    row.className = 'mv-setting-row';
    const txt = document.createElement('div');
    txt.className = 'mv-setting-text';
    txt.innerHTML = `<span class="mv-setting-label"></span><span class="mv-setting-desc"></span>`;
    txt.querySelector('.mv-setting-label').textContent = label;
    txt.querySelector('.mv-setting-desc').textContent = desc;
    const sw = document.createElement('span');
    sw.className = 'mv-setting-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = getMvOption(key, def);
    if (input.checked) sw.classList.add('on');
    const knob = document.createElement('span');
    knob.className = 'mv-setting-knob';
    sw.appendChild(input);
    sw.appendChild(knob);
    input.onchange = () => {
      localStorage.setItem(key, input.checked ? 'true' : 'false');
      sw.classList.toggle('on', input.checked);
      if (onChange) onChange(input.checked);
    };
    row.appendChild(txt);
    row.appendChild(sw);
    return row;
  };
  const makeSlider = (label, desc, opts, getInit, onInput) => {
    const row = document.createElement('div');
    row.className = 'mv-setting-row mv-setting-slider-row';
    const head = document.createElement('div');
    head.className = 'mv-setting-slider-head';
    const txt = document.createElement('div');
    txt.className = 'mv-setting-text';
    txt.innerHTML = `<span class="mv-setting-label"></span><span class="mv-setting-desc"></span>`;
    txt.querySelector('.mv-setting-label').textContent = label;
    txt.querySelector('.mv-setting-desc').textContent = desc;
    const valBadge = document.createElement('span');
    valBadge.className = 'mv-setting-value';
    head.appendChild(txt);
    head.appendChild(valBadge);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'mv-setting-range';
    input.min = opts.min;
    input.max = opts.max;
    input.step = opts.step;
    input.value = getInit();
    const fmt = opts.format || ((v) => v);
    valBadge.textContent = fmt(input.value);
    input.oninput = (e) => {
      e.stopPropagation();
      valBadge.textContent = fmt(input.value);
      onInput(input.value);
    };
    input.onmousedown = (e) => e.stopPropagation();
    input.onclick = (e) => e.stopPropagation();
    row.appendChild(head);
    row.appendChild(input);
    return row;
  };
  const title = document.createElement('div');
  title.className = 'mv-settings-title';
  title.textContent = '表示オプション';
  panel.appendChild(title);
  panel.appendChild(makeSlider('UIの大きさ', '歌詞や文字などの表示サイズを調整します',
    { min: 70, max: 140, step: 5, format: (v) => v + '%' },
    () => Math.round(userUiScale * 100),
    (v) => {
      userUiScale = parseFloat(v) / 100;
      localStorage.setItem('mv_ui_scale', String(userUiScale));
      updateUiScale();
    }));
  panel.appendChild(makeToggle('タイトルを常に表示', '曲名・アーティストを常時表示します', 'mv_always_title', false, (on) => {
    isTitleAlwaysOn = on;
    const ia = document.getElementById('mv-info-area');
    if (ia && on) ia.classList.add('visible');
    showToast(on ? 'タイトルを常に表示します' : 'タイトルの常時表示を解除しました');
  }));
  panel.appendChild(makeToggle('自動生成字幕を使わない', 'AIの自動字幕は歌詞に使いません', 'mv_exclude_auto', true, () => {
    showToast('設定を変更しました');
    loadedLyricsVideoId = '';
    updateMVContent(0);
  }));
  panel.appendChild(makeToggle('原文を優先（日本語はサブ）', '海外曲は原語をメイン・日本語を訳として表示', 'mv_lang_auto_priority', true, () => {
    showToast('設定を変更しました');
    loadedLyricsVideoId = '';
    updateMVContent(0);
  }));
  panel.appendChild(makeToggle('字幕がない曲は外部歌詞を表示', 'YouTube Music の公式歌詞（曲を動画から特定）と、LRCHub / Apple(LyricsPlus) / NetEase / KuGou / LRCLIB を突き合わせて表示します', 'mv_external_lyrics', true, () => {
    showToast('設定を変更しました');
    loadedLyricsVideoId = '';
    updateMVContent(0);
  }));
  panel.appendChild(makeToggle('カラオケ風ハイライト', '歌に合わせて語ごとに塗ります（語単位の歌詞が無い曲は自動生成字幕の時刻で推定）', 'mv_karaoke', true, (on) => {
    karaokeEnabledCache = on;
    updateKaraokeLoop();
    // 語単位の塗りは描画時に行を語に分けるので、描き直す
    const la = document.getElementById('mv-lyrics-area');
    if (la && lyricsData.length) {
      renderLyricsDOM(la);
      try {
        syncLyrics();
      } catch (e) {}
    }
    showToast(on ? 'カラオケ風ハイライトをONにしました' : 'カラオケ風ハイライトをOFFにしました');
    // OFF中は単語タイミングを取得していないため、ONにしたら歌詞をロードし直して取得する
    if (on && !asrWordStream) {
      loadedLyricsVideoId = '';
      updateMVContent(0);
    }
  }));
  const koRubyRow = makeToggle('韓国語の読みを表示', '韓国語の歌詞と字幕（CC）の上に、読みをカタカナで小さく振ります', YTI_KOREAN_RUBY_KEY, false, (on) => {
    ytiKoreanRuby.setEnabled(on);
    if (pipWindow) ytiKoreanRuby.applyTo(pipWindow.document);
    // 行の高さが変わるので、今の行を歌詞欄の中央に置き直す
    scrollMvLyricsToActive(true);
    showToast(on ? '韓国語の読みを表示します' : '韓国語の読みを非表示にしました');
  });
  panel.appendChild(koRubyRow);
  panel.appendChild(makeToggle('歌詞の時間差スクロール', '行が変わる時、上の行から順に少しずつ遅れて流れます（YTM-Immersion と同じ動き）', 'mv_lyric_stagger', true, (on) => {
    showToast(on ? '時間差スクロールをONにしました' : '時間差スクロールをOFFにしました（全行が一緒に動きます）');
  }));
  // 黒帯カット（letterbox.js）。保存先はプレイヤーの歯車メニューのトグルと共通
  const lbxMvRow = makeToggle('黒帯をカット（MVモード）', '上下の黒帯を、映像が続いているような光で埋めます', YTI_LBX_KEY_MV, true, (on) => {
    ytiLetterboxSetOption(YTI_LBX_KEY_MV, on);
    showToast(on ? '黒帯カットをONにしました' : '黒帯カットをOFFにしました');
  });
  panel.appendChild(lbxMvRow);
  const lbxNormalRow = makeToggle('黒帯をカット（通常再生）', '通常の画面でも黒帯を切り取り、本来の比率で表示します', YTI_LBX_KEY_NORMAL, false, (on) => {
    ytiLetterboxSetOption(YTI_LBX_KEY_NORMAL, on);
    showToast(on ? '通常再生でも黒帯をカットします' : '通常再生の黒帯カットをOFFにしました');
  });
  panel.appendChild(lbxNormalRow);
  // 言語（訳・読み）・パート分け・応援法などの設定（各モジュールが足す）
  if (typeof ytiExtendSettingsPanel === 'function') {
    try {
      ytiExtendSettingsPanel(panel, makeToggle);
    } catch (e) {}
  }
  // プレイヤーの歯車メニュー側で切り替えられた値を、パネルを開くたびに反映する
  panel.syncLetterboxToggles = () => {
    [[lbxMvRow, YTI_LBX_KEY_MV, true], [lbxNormalRow, YTI_LBX_KEY_NORMAL, false], [koRubyRow, YTI_KOREAN_RUBY_KEY, false]].forEach(([row, key, def]) => {
      const input = row.querySelector('input');
      const sw = row.querySelector('.mv-setting-switch');
      const on = getMvOption(key, def);
      if (input) input.checked = on;
      if (sw) sw.classList.toggle('on', on);
    });
  };
  ['click', 'mousedown', 'mouseup'].forEach(evt => panel.addEventListener(evt, e => e.stopPropagation()));
  return panel;
}

// 一定時間操作が無かった時にMVモードのUIを隠す。onUserAction の高速パスと
// 共有するために関数として切り出している。
let ytiUiShown = false;

function hideMvUi() {
  const settingsPanelEl = document.getElementById('mv-settings-panel');
  if (settingsPanelEl) settingsPanelEl.classList.remove('open');
  const elems = [document.getElementById('mv-info-area'), document.getElementById('mv-close-btn'), document.getElementById('mv-settings-btn'), document.getElementById('mv-shot-btn'), document.getElementById('mv-pin-btn'), document.getElementById('mv-lyrics-header'), document.getElementById('mv-record-btn'), document.getElementById('mv-glass-btn'), document.getElementById('mv-glass-slider-container'), document.getElementById('mv-pos-slider-container'), document.getElementById('mv-desktop-btn'), document.getElementById('mv-ambient-controls')];
  if (elems[0] && !isInfoPinned && !isTitleAlwaysOn) elems[0].classList.remove('visible');
  for (let i = 1; i < elems.length; i++) {
    if (elems[i]) elems[i].classList.remove('visible');
  }
  const lyricsArea = document.getElementById('mv-lyrics-area');
  if (lyricsArea && lyricsArea.classList.contains('no-lyrics')) {
    lyricsArea.classList.add('fade-out');
  }
  const posSliderContainer = document.getElementById('mv-pos-slider-container');
  if (posSliderContainer) {
    posSliderContainer.style.opacity = '0';
    posSliderContainer.style.pointerEvents = 'none';
  }
  if (rootContainer) rootContainer.classList.add('hide-cursor');
  ytiUiShown = false;
}

function onUserAction(e) {
  // mousemove ごとに十数回の getElementById と classList 操作をしていたため、
  // マウスを動かしながらMVモードへ入ると描画がカクついていた。
  // UIが既に表示済みで、単なるマウス移動なら「自動非表示タイマーの延長」だけで済ませる。
  if (e && e.type === 'mousemove' && ytiUiShown && rootContainer &&
      !rootContainer.classList.contains('hide-cursor')) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(hideMvUi, 3000);
    return;
  }
  ytiUiShown = true;
  const infoArea = document.getElementById('mv-info-area');
  const closeBtn = document.getElementById('mv-close-btn');
  const shotBtn = document.getElementById('mv-shot-btn');
  const pinBtn = document.getElementById('mv-pin-btn');
  const lyricsHeader = document.getElementById('mv-lyrics-header');
  const lyricsArea = document.getElementById('mv-lyrics-area');
  const recordBtn = document.getElementById('mv-record-btn');
  const glassBtn = document.getElementById('mv-glass-btn');
  const glassSlider = document.getElementById('mv-glass-slider-container');
  const desktopBtn = document.getElementById('mv-desktop-btn');
  const posSliderContainer = document.getElementById('mv-pos-slider-container');
  const isRecordMode = rootContainer && rootContainer.classList.contains('record-mode');
  if (rootContainer) {
    rootContainer.classList.remove('hide-cursor');
    const ambControls = document.getElementById('mv-ambient-controls');
    if (ambControls) ambControls.classList.add('visible');
  }
  if (infoArea) {
    infoArea.classList.add('visible');
    if (closeBtn) closeBtn.classList.add('visible');
    const settingsBtn = document.getElementById('mv-settings-btn');
    if (settingsBtn) settingsBtn.classList.add('visible');
    if (shotBtn) shotBtn.classList.add('visible');
    if (pinBtn) pinBtn.classList.add('visible');
    if (lyricsHeader) lyricsHeader.classList.add('visible');
    if (desktopBtn) desktopBtn.classList.add('visible');
    if (recordBtn) recordBtn.classList.add('visible');
    if (posSliderContainer) {
      posSliderContainer.style.opacity = '1';
      posSliderContainer.style.pointerEvents = 'auto';
    }
    if (isRecordMode) {
      if (glassBtn) glassBtn.classList.add('visible');
      if (glassSlider) glassSlider.classList.add('visible');
    } else {
      if (glassBtn) glassBtn.classList.remove('visible');
      if (glassSlider) glassSlider.classList.remove('visible');
    }
    if (lyricsArea && lyricsArea.classList.contains('no-lyrics')) {
      lyricsArea.classList.remove('fade-out');
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(hideMvUi, 3000);
  }
  if (e && e.type === 'click' && rootContainer) {
    const target = e.target;
    if (target.closest('button') || target.closest('.mv-glass-btn') || target.closest('#mv-pin-btn') || target.closest('.mv-lyric-action-btn') || target.closest('a') || target.closest('.lyric-line') || target.closest('#mv-sidebar') || target.closest('#shot-result-overlay') || target.closest('#shot-selector-overlay') || target.closest('#mv-settings-panel') || target.closest('input[type="range"]')) {
      return;
    }
    if (targetVideo) {
      if (targetVideo.paused) {
        targetVideo.play();
      } else {
        targetVideo.pause();
      }
    }
  }
}

// 現在時刻に対応する行の番号（time <= t となる最後の行）。行は時刻順なので二分探索する。
// 数百行の曲でも、timeupdate・毎フレームの呼び出しで全行を走査しないようにするため。
function findLyricIndexAt(t) {
  let lo = 0;
  let hi = lyricsData.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyricsData[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// 外部歌詞の「曲の始まり」を音声で判定している間は、補正前の時刻で歌詞が
// 先走らないよう、歌詞を進めずに前奏表示（先頭の・・・行）のまま待たせる。
function heldLyricIndex(index) {
  if (!usingExternalLyrics || !ytiAudioSync.isHoldingIntro()) return index;
  return (lyricsData[0] && lyricsData[0].isInstrumental) ? 0 : -1;
}

// 行を光らせ始めるのを歌より少しだけ早める（光り切るまでの遷移ぶん）
const YTI_LINE_LEAD = 0.12;
// syncLyrics が決めた現在行の番号（カラオケの塗りなどが毎フレーム探し直さないように共有する）
let activeLyricIndex = -1;
// レコードモードの盤面要素（毎回 getElementById しないように覚えておく）
let rmVinylEl = null;
let rmRightPaneEl = null;
let rmSpinning = null;

function syncLyrics() {
  if (!targetVideo) return;
  // 広告の再生中は歌詞を進めない（広告の再生位置で本編の歌詞が流れてしまう）
  if (typeof ytiAdActive !== 'undefined' && ytiAdActive) return;
  const currentTime = targetVideo.currentTime;
  if (!rmVinylEl || !rmVinylEl.isConnected) {
    rmVinylEl = document.getElementById('vinyl-record');
    rmRightPaneEl = document.querySelector('.rm-right-pane');
    rmSpinning = null;
  }
  const spinning = !targetVideo.paused;
  if (rmVinylEl && rmRightPaneEl && spinning !== rmSpinning) {
    rmVinylEl.classList.toggle('spinning', spinning);
    rmRightPaneEl.classList.toggle('playing', spinning);
    rmSpinning = spinning;
  }
  const activeIndex = heldLyricIndex(findLyricIndexAt(currentTime + YTI_LINE_LEAD));
  if (activeIndex !== -1) {
    const currentLine = lyricsData[activeIndex];
    const nextLine = lyricsData[activeIndex + 1];
    if (currentLine.isInstrumental && currentLine.el) {
      const endTime = nextLine ? nextLine.time : currentLine.time + 5.0;
      const duration = Math.max(0.1, endTime - currentLine.time);
      const elapsed = Math.max(0, currentTime - currentLine.time);
      let totalProgress = (elapsed / duration) * 3.0;
      if (!currentLine._dots) currentLine._dots = currentLine.el.querySelectorAll('.instrumental-dot');
      currentLine._dots.forEach((d, i) => {
        const dotProgress = Math.max(0.0, Math.min(1.0, totalProgress - i)).toFixed(3);
        if (d._p !== dotProgress) {
          d._p = dotProgress;
          d.style.setProperty('--dot-progress', dotProgress);
        }
      });
    }
  }
  lastLyricIndex = activeIndex;
  activeLyricIndex = activeIndex;
  // アクティブ行が変わった時だけ、旧行と新行の2つだけを触る。
  const nextActive = activeIndex >= 0 ? lyricsData[activeIndex] : null;
  if (nextActive !== activeLyricLine) {
    const prev = activeLyricLine;
    if (prev) {
      if (prev.el) prev.el.classList.remove('active');
      if (prev.rmEl) prev.rmEl.classList.remove('active');
    }
    if (nextActive) {
      if (nextActive.el) nextActive.el.classList.add('active');
      if (nextActive.rmEl) {
        nextActive.rmEl.classList.add('active');
        const rmScroll = document.getElementById('rm-lyrics-scroll');
        if (rmScroll && rmScroll.parentElement) {
          const containerHeight = rmScroll.parentElement.clientHeight;
          const itemTop = nextActive.rmEl.offsetTop;
          const itemHeight = nextActive.rmEl.clientHeight;
          const offset = -(itemTop - containerHeight / 2 + itemHeight / 2 + 160);
          rmScroll.style.transform = `translateY(${offset}px)`;
        }
      }
    }
    activeLyricLine = nextActive;
    // 行送りは行が変わったこの1回だけ（YTM-Immersion と同じ時間差つきのばね）
    if (nextActive) scrollMvLyricsToActive(false);
  }
}

function getVideoId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('v');
}

function getHighResThumbnail() {
  const videoId = getVideoId();
  if (videoId) return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  return "";
}

function getLowResThumbnail() {
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }
  return null;
}

function onFullscreenChange() {
  if (!document.fullscreenElement && rootContainer) {
    endMVMode(false);
  }
}

function showCenterStatus(type) {
  const container = document.getElementById('mv-center-status');
  const playIcon = document.getElementById('mv-icon-play');
  const pauseIcon = document.getElementById('mv-icon-pause');
  if (!container || !playIcon || !pauseIcon) return;
  playIcon.style.display = (type === 'play') ? 'block' : 'none';
  pauseIcon.style.display = (type === 'pause') ? 'block' : 'none';
  container.classList.remove('animate');
  void container.offsetWidth;
  container.classList.add('animate');
}
async function startHybridShotSequence() {
  const isMVMode = !!document.getElementById('mv-root-container');
  // MVモードでは再生中の実体である targetVideo を直接使う。
  // querySelector でDOMから引き直すと、YouTube が再生成した別の（冒頭=0秒の）
  // video 要素を掴んでしまい、現在地ではなく冒頭フレームが撮れてしまう。
  const video = (isMVMode && targetVideo && targetVideo.isConnected) ?
    targetVideo :
    (document.querySelector('.video-stream.html5-main-video') || document.querySelector('video'));
  if (!video) return;
  const btn = document.getElementById('mv-shot-btn');
  if (isMVMode && btn) {
    btn.innerText = "解析中...";
    btn.style.background = "rgba(255, 50, 50, 0.8)";
  } else {
    showToast("ベストショット解析中...");
  }
  try {
    const frames = await tryBurstCapture(video);
    if (frames && frames.length > 0) {
      showShotSelector(frames);
      if (isMVMode && btn) {
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot';
        btn.style.background = "";
      }
      return;
    }
  } catch (e) {}
  if (isMVMode && btn) btn.innerText = "高画質撮影中...";
  takeSingleScreenShot();
}
async function tryBurstCapture(video) {
  // メタデータ未ロード（初回読み込み時に多い）だと videoWidth/Height が 0 になり、
  // 0x0 キャンバスで黒画面/エラーになる。準備できていなければ即フォールバックへ。
  if (!video || !video.videoWidth || !video.videoHeight) {
    throw new Error("Video not ready");
  }
  const wasPaused = video.paused;
  const currentTime = video.currentTime;
  const rewindTime = 0.5;
  if (currentTime > rewindTime) {
    video.currentTime = currentTime - rewindTime;
    // シーク完了（seeked）を待ってから撮影。待たないと初回は古い/黒いフレームを掴む。
    await new Promise(r => {
      let settled = false;
      const onSeeked = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        r();
      };
      video.addEventListener('seeked', onSeeked);
      setTimeout(onSeeked, 400);
    });
  }
  if (video.paused) {
    try {
      await video.play();
    } catch (e) {}
  }
  const frames = [];
  const captureDuration = 1000;
  const startTime = Date.now();
  try {
    while (Date.now() - startTime < captureDuration) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', {
        willReadFrequently: true
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const d = ctx.getImageData(0, 0, 1, 1);
      } catch (e) {
        throw new Error("Canvas Tainted");
      }
      const score = calculateSharpness(ctx, canvas.width, canvas.height);
      frames.push({
        canvas,
        score
      });
      await new Promise(r => requestAnimationFrame(r));
    }
  } catch (e) {
    if (wasPaused) video.pause();
    video.currentTime = currentTime;
    throw e;
  }
  if (wasPaused) video.pause();
  video.currentTime = currentTime;
  frames.sort((a, b) => b.score - a.score);
  // 全フレームが真っ黒/ほぼ無地（score≈0）なら撮影失敗とみなし、単写フォールバックへ。
  if (frames.length === 0 || !frames[0] || frames[0].score <= 0) {
    throw new Error("Blank frames");
  }
  return frames;
}
async function takeSingleScreenShot() {
  const isMVMode = !!document.getElementById('mv-root-container');
  const video = (isMVMode && targetVideo && targetVideo.isConnected) ?
    targetVideo :
    (document.querySelector('.video-stream.html5-main-video') || document.querySelector('video'));
  const btn = document.getElementById('mv-shot-btn');
  if (!video) return;
  const wasPaused = video.paused;
  video.pause();
  const overlay = document.getElementById('mv-overlay-content');
  const sidebar = document.getElementById('mv-sidebar');
  if (overlay) overlay.style.display = 'none';
  if (sidebar) sidebar.style.display = 'none';
  await new Promise(r => setTimeout(r, 200));
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_CURRENT_TAB'
    });
    if (overlay) overlay.style.display = 'block';
    if (sidebar) sidebar.style.display = 'block';
    if (!wasPaused) video.play();
    if (response && response.success && response.dataUrl) {
      processScreenshot(response.dataUrl, video);
    } else {
      alert("撮影エラー: " + (response ? response.error : "Unknown"));
    }
  } catch (e) {
    if (overlay) overlay.style.display = 'block';
    alert("エラー: " + e.message);
  } finally {
    if (btn) {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot';
      btn.style.background = "";
    }
  }
}

function calculateSharpness(ctx, w, h) {
  const sampleW = 120;
  const sampleH = (h / w) * sampleW;
  const sc = document.createElement('canvas');
  sc.width = sampleW;
  sc.height = sampleH;
  const sCtx = sc.getContext('2d', {
    willReadFrequently: true
  });
  sCtx.drawImage(ctx.canvas, 0, 0, sampleW, sampleH);
  const data = sCtx.getImageData(0, 0, sampleW, sampleH).data;
  let score = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (i + 4 < data.length) score += Math.abs(data[i] - data[i + 4]);
  }
  return score;
}

function processScreenshot(dataUrl, videoEl) {
  const img = new Image();
  img.onload = () => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    const tempCtx = tempCanvas.getContext('2d', {
      willReadFrequently: true
    });
    tempCtx.drawImage(img, 0, 0);
    selectedSnapshotCanvas = cropCanvasBlackBars(tempCanvas);
    showChekiEditor();
  };
  img.src = dataUrl;
}

function showShotSelector(frames) {
  const old = document.getElementById('shot-selector-overlay');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'shot-selector-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    background: 'rgba(0,0,0,0.85)',
    zIndex: 2147483650,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(15px)',
    padding: '20px',
    boxSizing: 'border-box'
  });
  ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
    overlay.addEventListener(evt, stopProp);
  });
  const title = document.createElement('h2');
  title.innerText = "ベストショットを選択";
  title.style.color = "#fff";
  title.style.marginBottom = "15px";
  title.style.flexShrink = "0";
  overlay.appendChild(title);
  const listScrollArea = document.createElement('div');
  Object.assign(listScrollArea.style, {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
    maxHeight: '70vh',
    overflowY: 'auto',
    minHeight: '0'
  });
  const list = document.createElement('div');
  Object.assign(list.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '15px',
    width: '90%',
    maxWidth: '1000px',
    height: 'fit-content',
    paddingBottom: '20px'
  });
  const renderImages = (targetFrames) => {
    targetFrames.forEach((f, index) => {
      const img = document.createElement('img');
      img.src = f.canvas.toDataURL('image/png');
      Object.assign(img.style, {
        width: '100%',
        aspectRatio: '16/9',
        objectFit: 'cover',
        cursor: 'pointer',
        borderRadius: '12px',
        border: '2px solid transparent',
        background: '#000',
        opacity: '0',
        animation: `gorgeous-slide-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards ${index * 0.05}s`
      });
      img.onclick = async (e) => {
        stopProp(e);
        selectedSnapshotCanvas = cropCanvasBlackBars(f.canvas);
        const rect = img.getBoundingClientRect();
        const clone = img.cloneNode(true);
        Object.assign(clone.style, {
          position: 'fixed',
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          zIndex: '2147483660',
          transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
          borderRadius: '12px',
          objectFit: 'cover',
          boxShadow: '0 0 0 rgba(0,0,0,0)',
          opacity: '1',
          animation: 'none'
        });
        document.body.appendChild(clone);
        overlay.style.transition = 'opacity 0.3s ease';
        overlay.style.opacity = '0';
        overlay.style.transform = 'scale(0.98)';
        requestAnimationFrame(() => {
          const targetHeight = window.innerHeight * 0.85;
          const ratio = f.canvas.width / f.canvas.height;
          const targetWidth = targetHeight * ratio;
          Object.assign(clone.style, {
            top: '50%',
            left: '50%',
            width: `${targetWidth}px`,
            height: `${targetHeight}px`,
            transform: 'translate(-50%, -50%)',
            boxShadow: '0 30px 60px rgba(0,0,0,0.5)'
          });
        });
        await new Promise(r => setTimeout(r, 450));
        showChekiEditor(frames);
        setTimeout(() => {
          clone.remove();
          overlay.remove();
        }, 100);
      };
      list.appendChild(img);
    });
  };
  renderImages(frames.slice(0, 6));
  listScrollArea.appendChild(list);
  overlay.appendChild(listScrollArea);
  const actionArea = document.createElement('div');
  Object.assign(actionArea.style, {
    marginTop: '15px',
    display: 'flex',
    gap: '15px',
    flexShrink: '0'
  });
  if (frames.length > 6) {
    const showAllBtn = document.createElement('button');
    showAllBtn.innerHTML = `
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-right:4px;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            すべて表示 (${frames.length}枚)
        `;
    showAllBtn.className = "cheki-btn secondary";
    showAllBtn.onclick = (e) => {
      stopProp(e);
      showAllBtn.remove();
      const remaining = frames.slice(6);
      let index = 0;
      const chunkSize = 3;
      const processChunk = () => {
        const chunk = remaining.slice(index, index + chunkSize);
        if (chunk.length > 0) {
          renderImages(chunk);
          index += chunkSize;
          requestAnimationFrame(processChunk);
        }
      };
      processChunk();
    };
    actionArea.appendChild(showAllBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        キャンセル
    `;
  closeBtn.className = "cheki-btn secondary danger";
  closeBtn.onclick = (e) => {
    stopProp(e);
    overlay.remove();
  };
  actionArea.appendChild(closeBtn);
  overlay.appendChild(actionArea);
  getTargetContainer().appendChild(overlay);
}
let isChekiRomajiHidden = false;
let selectedSnapshotCanvas = null;
let currentSelectedLyrics = [];
async function generateChekiCanvas(lyrics, theme = 'glass', sourceCanvas = selectedSnapshotCanvas) {
  if (!selectedSnapshotCanvas) return document.createElement('canvas');
  let songTitle = document.getElementById('mv-song-title')?.textContent.trim() || "Unknown Title";
  let artistName = document.getElementById('mv-artist-name')?.textContent.trim() || "Unknown Artist";
  const canvasW = 1920;
  const margin = 40;
  const imgW = canvasW - (margin * 2);
  const videoRatio = selectedSnapshotCanvas.height / selectedSnapshotCanvas.width;
  const imgH = imgW * videoRatio;
  const textSpace = 220;
  const canvasH = Math.floor(margin + imgH + textSpace);
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  if (theme === 'white') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);
  } else if (theme === 'black') {
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, canvasW, canvasH);
  } else {
    ctx.save();
    ctx.filter = 'blur(100px) brightness(0.5) saturate(1.4)';
    ctx.drawImage(sourceCanvas, -200, -200, canvasW + 400, canvasH + 400);
    ctx.restore();
  }
  ctx.save();
  if (theme === 'white') {
    ctx.shadowColor = "rgba(0,0,0,0.15)";
  } else {
    ctx.shadowColor = "rgba(0,0,0,0.3)";
  }
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  ctx.beginPath();
  ctx.roundRect(margin, margin, imgW, imgH, 20);
  ctx.clip();
  ctx.drawImage(sourceCanvas, margin, margin, imgW, imgH);
  ctx.restore();
  let mainColor, subColor, dateColor, shadowColor;
  if (theme === 'white') {
    mainColor = "#222222";
    subColor = "#555555";
    dateColor = "#888888";
    shadowColor = "transparent";
  } else {
    mainColor = "#ffffff";
    subColor = "rgba(255,255,255,0.7)";
    dateColor = "rgba(255,255,255,0.4)";
    shadowColor = "rgba(0,0,0,0.8)";
  }
  if (lyrics && lyrics.length > 0) {
    ctx.save();
    const lyFontSize = 38;
    ctx.font = `bold ${lyFontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Hiragino Sans", sans-serif`;
    if (theme !== 'white') {
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = mainColor;
    const padding = 50;
    const lineHeight = lyFontSize * 1.5;
    let lyX, lyY;
    switch (chekiLyricPos) {
      case 1:
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        lyX = margin + padding;
        lyY = margin + padding;
        lyrics.forEach((line, i) => {
          ctx.fillText(line, lyX, lyY + (i * lineHeight));
        });
        break;
      case 2:
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        lyX = margin + imgW - padding;
        lyY = margin + padding;
        lyrics.forEach((line, i) => {
          ctx.fillText(line, lyX, lyY + (i * lineHeight));
        });
        break;
      case 3:
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        lyX = margin + imgW - padding;
        lyY = margin + imgH - padding;
        [...lyrics].reverse().forEach((line, i) => {
          ctx.fillText(line, lyX, lyY - (i * lineHeight));
        });
        break;
      case 0:
      default:
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        lyX = margin + padding;
        lyY = margin + imgH - padding;
        [...lyrics].reverse().forEach((line, i) => {
          ctx.fillText(line, lyX, lyY - (i * lineHeight));
        });
        break;
    }
    ctx.restore();
  }
  const infoAreaTop = margin + imgH + 55;
  ctx.fillStyle = mainColor;
  ctx.font = "bold 52px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(songTitle, margin + 10, infoAreaTop);
  const subInfoY = infoAreaTop + 80;
  ctx.fillStyle = subColor;
  ctx.font = "600 30px -apple-system, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(artistName, margin + 12, subInfoY);
  const d = new Date();
  const dateStr = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  ctx.fillStyle = dateColor;
  ctx.font = "300 22px monospace";
  ctx.textAlign = "right";
  ctx.fillText(dateStr, margin + imgW - 10, subInfoY + 8);
  return canvas;
}

function showChekiEditor(prevFrames = null) {
  if (!selectedSnapshotCanvas) return;
  currentSelectedLyrics = [];
  let currentTheme = 'glass';
  const old = document.getElementById('cheki-editor-overlay');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'cheki-editor-overlay';
  ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(evt => overlay.addEventListener(evt, stopProp));
  overlay.tabIndex = -1;
  overlay.style.outline = "none";
  overlay.onkeydown = (e) => {
    if (e.key === 'p' || e.key === 'P') {
      e.stopPropagation();
      chekiLyricPos = (chekiLyricPos + 1) % 4;
      updateLayoutUI();
      updatePreview();
    }
  };
  setTimeout(() => overlay.focus(), 50);
  const backBtnHtml = prevFrames ? `<button class="cheki-btn secondary" id="cheki-back-btn" style="margin-right:auto;"><svg viewBox="0 0 24 24" style="width:14px;fill:none;stroke:currentColor;stroke-width:2;margin-right:4px;"><polyline points="15 18 9 12 15 6"></polyline></svg>戻る</button>` : '';
  overlay.innerHTML = `
        <div class="cheki-container" onclick="event.stopPropagation()">
            <style>
                .cheki-controls-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }

                .settings-panel {
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 16px;
                    padding: 16px 20px;
                    margin-bottom: 24px;
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    box-shadow: inset 0 2px 10px rgba(0,0,0,0.1);
                }
                .settings-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .settings-row:not(:last-child) {
                    margin-bottom: 16px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                }
                .section-title {
                    font-size: 13px;
                    font-weight: 600;
                    color: #fff;
                    letter-spacing: 0.02em;
                }
                .section-subtitle {
                    font-size: 11px;
                    color: rgba(255, 255, 255, 0.5);
                    margin-top: 4px;
                }

                .theme-group { display: flex; gap: 12px; }
                .theme-btn {
                    width: 24px; height: 24px;
                    border-radius: 50%; border: 2px solid transparent;
                    cursor: pointer; transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
                    box-shadow: 0 2px 6px rgba(0,0,0,0.4);
                }
                .theme-btn:hover { transform: scale(1.1); }
                .theme-btn.selected { border-color: #fff; transform: scale(1.2); box-shadow: 0 0 12px rgba(255,255,255,0.4); }
                .theme-btn.glass { background: linear-gradient(135deg, #a8c0ff, #3f2b96); }
                .theme-btn.white { background: #ffffff; }
                .theme-btn.black { background: #181818; }

                .ios-segment {
                    display: flex;
                    background: rgba(0, 0, 0, 0.4);
                    border-radius: 8px;
                    padding: 4px;
                    gap: 4px;
                }
                .layout-btn {
                    width: 38px; height: 26px;
                    border-radius: 6px; border: none;
                    background: transparent;
                    cursor: pointer; position: relative;
                    transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
                }
                .layout-btn:hover { background: rgba(255,255,255,0.1); }
                .layout-btn.selected { background: rgba(255,255,255,0.25); box-shadow: 0 2px 6px rgba(0,0,0,0.3); }

                .layout-btn::before {
                    content: ''; position: absolute;
                    width: 14px; height: 2px;
                    background: rgba(255,255,255,0.4);
                    border-radius: 1px;
                    box-shadow: 0 4px 0 rgba(255,255,255,0.4);
                    transition: background 0.2s;
                }
                .layout-btn.selected::before { background: #fff; box-shadow: 0 4px 0 #fff; }
                .layout-btn[data-pos="1"]::before { top: 6px; left: 6px; }
                .layout-btn[data-pos="2"]::before { top: 6px; right: 6px; }
                .layout-btn[data-pos="0"]::before { bottom: 10px; left: 6px; }
                .layout-btn[data-pos="3"]::before { bottom: 10px; right: 6px; }

                .control-btn {
                    background: rgba(255, 255, 255, 0.15);
                    color: #fff;
                    border: none;
                    border-radius: 14px;
                    padding: 6px 14px;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.2s, transform 0.1s;
                }
                .control-btn:hover { background: rgba(255, 255, 255, 0.25); }
                .control-btn:active { transform: scale(0.95); }
            </style>

            <div class="cheki-preview-box">
                <img id="cheki-preview-img" class="cheki-preview-img" src="">
            </div>

            <div class="cheki-controls">

                <div class="settings-panel">
                    <div class="settings-row">
                        <div>
                            <div class="section-title">テーマカラー</div>
                            <div class="section-subtitle">背景と文字色の組み合わせ</div>
                        </div>
                        <div class="theme-group">
                            <button class="theme-btn glass selected" data-theme="glass" title="Glass"></button>
                            <button class="theme-btn white" data-theme="white" title="White"></button>
                            <button class="theme-btn black" data-theme="black" title="Black"></button>
                        </div>
                    </div>

                    <div class="settings-row">
                        <div>
                            <div class="section-title">歌詞の配置</div>
                            <div class="section-subtitle">テキストを表示する位置</div>
                        </div>
                        <div class="ios-segment layout-group">
                            <button class="layout-btn" data-pos="1" title="左上"></button>
                            <button class="layout-btn" data-pos="2" title="右上"></button>
                            <button class="layout-btn selected" data-pos="0" title="左下"></button>
                            <button class="layout-btn" data-pos="3" title="右下"></button>
                        </div>
                    </div>
                </div>

                <div class="cheki-controls-row">
                    <div style="display:flex; align-items:center; gap:8px;">
                         <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor;color:#fff;"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                         <span style="font-size:14px; font-weight:700; color:#fff;">歌詞選択</span>
                    </div>

                    <div style="display:flex; align-items:center; gap:12px;">
                        <div class="sharpen-toggle-wrapper" style="margin:0;">
                            <span class="toggle-label" style="color:#fff;">高画質化</span>
                            <label class="toggle-switch">
                                <input type="checkbox" id="cheki-sharpen-toggle">
                                <span class="slider"></span>
                            </label>
                        </div>
                        <button id="cheki-romaji-toggle" class="control-btn">
                            JP訳のみ
                        </button>
                    </div>
                </div>

                <div class="cheki-lyrics-list" id="cheki-lyrics-list"></div>

                <div class="cheki-actions">
                    ${backBtnHtml}
                    <button class="cheki-btn secondary danger" id="cheki-cancel-btn">キャンセル</button>
                    <button class="cheki-btn primary" id="cheki-create-btn">画像を保存</button>
                </div>
            </div>
        </div>
    `;
  getTargetContainer().appendChild(overlay);
  const layoutBtns = overlay.querySelectorAll('.layout-btn');
  const updateLayoutUI = () => {
    layoutBtns.forEach(btn => {
      const p = parseInt(btn.dataset.pos);
      if (p === chekiLyricPos) btn.classList.add('selected');
      else btn.classList.remove('selected');
    });
  };
  layoutBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      chekiLyricPos = parseInt(btn.dataset.pos);
      updateLayoutUI();
      updatePreview();
    };
  });
  updateLayoutUI();
  const themeBtns = overlay.querySelectorAll('.theme-btn');
  themeBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      themeBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentTheme = btn.getAttribute('data-theme');
      updatePreview();
    };
  });
  const listContainer = document.getElementById('cheki-lyrics-list');
  const romajiToggle = document.getElementById('cheki-romaji-toggle');
  const previewImg = document.getElementById('cheki-preview-img');
  const hasJP = (text) => !!text.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
  let sharpenedCache = null;
  setTimeout(() => {
    const toggle = document.getElementById('cheki-sharpen-toggle');
    if (toggle) toggle.addEventListener('change', updatePreview);
  }, 10);

  function updatePreview() {
    const isSharpen = document.getElementById('cheki-sharpen-toggle')?.checked;
    let targetCanvas = selectedSnapshotCanvas;
    if (isSharpen) {
      if (!sharpenedCache) sharpenedCache = applySharpenFilter(selectedSnapshotCanvas);
      targetCanvas = sharpenedCache;
    }
    generateChekiCanvas(currentSelectedLyrics, currentTheme, targetCanvas).then(canvas => {
      if (previewImg) previewImg.src = canvas.toDataURL('image/png');
    });
  }
  const renderChekiLyrics = () => {
    listContainer.innerHTML = '';
    romajiToggle.style.background = isChekiRomajiHidden ? "#fff" : "rgba(255,255,255,0.1)";
    romajiToggle.style.color = isChekiRomajiHidden ? "#000" : "#fff";
    let delayCounter = 0;
    lyricsData.forEach((line) => {
      if (!line.text) return;
      if (line.isInstrumental) return;
      const subLines = line.text.split(/\r\n|\n|\r/);
      subLines.forEach(subText => {
        const cleanText = subText.trim();
        if (!cleanText) return;
        if (isChekiRomajiHidden && !hasJP(cleanText)) return;
        const item = document.createElement('div');
        item.className = 'cheki-lyric-item';
        if (currentSelectedLyrics.includes(cleanText)) {
          item.classList.add('selected');
          item.style.animation = 'none';
          item.style.opacity = '1';
        } else {
          item.style.animationDelay = `${Math.min(delayCounter * 0.03, 0.5)}s`;
        }
        item.innerText = cleanText;
        item.onclick = (e) => {
          e.stopPropagation();
          item.classList.remove('selected');
          void item.offsetWidth;
          if (currentSelectedLyrics.includes(cleanText)) {
            currentSelectedLyrics = currentSelectedLyrics.filter(t => t !== cleanText);
          } else {
            if (currentSelectedLyrics.length >= 5) currentSelectedLyrics.shift();
            currentSelectedLyrics.push(cleanText);
            item.classList.add('selected');
          }
          updateSelectionUI();
          updatePreview();
        };
        listContainer.appendChild(item);
        delayCounter++;
      });
    });
  };
  const updateSelectionUI = () => {
    const items = listContainer.querySelectorAll('.cheki-lyric-item');
    items.forEach(item => {
      if (currentSelectedLyrics.includes(item.innerText)) {
        item.classList.add('selected');
        item.style.animation = 'none';
        item.style.opacity = '1';
      } else {
        item.classList.remove('selected');
      }
    });
  };
  romajiToggle.onclick = (e) => {
    e.stopPropagation();
    isChekiRomajiHidden = !isChekiRomajiHidden;
    if (isChekiRomajiHidden) {
      currentSelectedLyrics = currentSelectedLyrics.filter(text => hasJP(text));
    }
    renderChekiLyrics();
    updatePreview();
  };
  if (prevFrames) {
    document.getElementById('cheki-back-btn').onclick = (e) => {
      e.stopPropagation();
      overlay.remove();
      showShotSelector(prevFrames);
    };
  }
  document.getElementById('cheki-cancel-btn').onclick = (e) => {
    e.stopPropagation();
    overlay.remove();
  };
  document.getElementById('cheki-create-btn').onclick = (e) => {
    e.stopPropagation();
    const isSharpen = document.getElementById('cheki-sharpen-toggle')?.checked;
    let targetCanvas = selectedSnapshotCanvas;
    if (isSharpen && sharpenedCache) targetCanvas = sharpenedCache;
    generateChekiCanvas(currentSelectedLyrics, currentTheme, targetCanvas).then(finalCanvas => {
      showResultModal(finalCanvas);
      overlay.remove();
    });
  };
  renderChekiLyrics();
  updatePreview();
}

function showResultModal(canvas) {
  const overlay = document.createElement('div');
  overlay.id = 'shot-result-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    background: 'rgba(0,0,0,0.92)',
    zIndex: 2147483660,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(15px)'
  });
  ['click', 'mousedown', 'mouseup'].forEach(evt => overlay.addEventListener(evt, stopProp));
  const dataUrl = canvas.toDataURL('image/png');
  overlay.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; max-width:90%;" onclick="event.stopPropagation()">
            <img src="${dataUrl}" style="max-height: 80vh; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);">

            <div class="result-row" style="margin-top:30px; display:flex; gap:12px; width: 100%; justify-content: center; flex-wrap: wrap;">
                <button class="cheki-btn" id="res-share-x-btn" style="background:#000; color:#fff; border:1px solid #333;">
                    <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:currentColor;margin-right:6px;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    Post
                </button>

                <button class="cheki-btn secondary" id="res-copy-btn">
                    <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-right:6px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    コピー
                </button>

                <button class="cheki-btn save" id="res-save-btn" style="padding: 14px 30px; box-shadow: 0 4px 20px rgba(0,122,255,0.3);">
                    <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-right:6px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                    保存
                </button>

                <button class="cheki-btn secondary danger" id="res-close-btn" style="padding: 14px;">
                    <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <p style="color:rgba(255,255,255,0.3); font-size:10px; margin-top:12px; font-weight:500;">画像はクリップボードにコピーされます</p>
        </div>
    `;
  getTargetContainer().appendChild(overlay);
  document.getElementById('res-close-btn').onclick = (e) => {
    stopProp(e);
    overlay.remove();
  };
  document.getElementById('res-copy-btn').onclick = (e) => {
    stopProp(e);
    canvas.toBlob(blob => {
      const item = new ClipboardItem({
        "image/png": blob
      });
      navigator.clipboard.write([item]).then(() => showToast("コピーしました"));
    });
  };
  document.getElementById('res-save-btn').onclick = (e) => {
    stopProp(e);
    let songTitle = document.getElementById('mv-song-title')?.textContent.trim() || "Shot";
    const link = document.createElement('a');
    link.download = `Immersion_${songTitle}_${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  };
  document.getElementById('res-share-x-btn').onclick = (e) => {
    stopProp(e);
    canvas.toBlob(blob => {
      const item = new ClipboardItem({
        "image/png": blob
      });
      navigator.clipboard.write([item]).then(() => {
        showToast("画像をコピーしました");
        let songTitle = document.getElementById('mv-song-title')?.textContent.trim() || "";
        let artistName = document.getElementById('mv-artist-name')?.textContent.trim() || "";
        const videoId = new URLSearchParams(window.location.search).get('v');
        const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : window.location.href;
        let text = "";
        text += `『${songTitle}』/ ${artistName}\n\n`;
        if (typeof currentSelectedLyrics !== 'undefined' && currentSelectedLyrics.length > 0) {
          text += `${currentSelectedLyrics.join('\n')}\n\n`;
        }
        text += videoUrl;
        const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
        window.open(tweetUrl, '_blank', 'width=600,height=450');
      }).catch(() => {
        showToast("画像のコピーに失敗しました");
      });
    });
  };
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.innerText = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '100px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(255,255,255,0.95)',
    color: '#000',
    padding: '12px 28px',
    borderRadius: '30px',
    fontWeight: 'bold',
    zIndex: '2147483647',
    boxShadow: '0 8px 20px rgba(0,0,0,0.3)',
    opacity: '0',
    transition: 'opacity 0.3s'
  });
  getTargetContainer().appendChild(toast);
  requestAnimationFrame(() => toast.style.opacity = '1');
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

function stopProp(e) {
  e.stopPropagation();
}

function getTargetContainer() {
  return rootContainer || document.body;
}
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('vinyl-label') || e.target.closest('.vinyl-label')) {
    const label = e.target.classList.contains('vinyl-label') ? e.target : e.target.closest('.vinyl-label');
    const currentPos = label.getAttribute('data-pos') || 'center';
    let newPos, newPosStyle, newSizeStyle;
    if (currentPos === 'center') {
      newPos = 'top';
      newPosStyle = 'center 10%';
      newSizeStyle = 'auto 140%';
      showToast("Position: Top (Face Low)");
    } else if (currentPos === 'top') {
      newPos = 'bottom';
      newPosStyle = 'center 90%';
      newSizeStyle = 'auto 140%';
      showToast("Position: Bottom (Face High)");
    } else {
      newPos = 'center';
      newPosStyle = 'center center';
      newSizeStyle = 'cover';
      showToast("Position: Center");
    }
    label.style.transition = 'background-position 0.4s cubic-bezier(0.25, 1, 0.5, 1), background-size 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
    label.style.backgroundSize = newSizeStyle;
    label.style.backgroundPosition = newPosStyle;
    label.setAttribute('data-pos', newPos);
    e.stopPropagation();
    e.preventDefault();
  }
}, true);
// ===== Mini Player (Document PiP) =====
// 縦長ウィンドウの上半分に実再生中の動画、下半分に Apple Music 風の歌詞スクロール。
// 歌詞は MV モードの lyricsData をそのまま使い、PiP 側の DOM を独自に組み立てる。
// PiPウィンドウ用のCSSはここに直接持つ。style.css を fetch して流し込む方式だと、
// 拡張機能をリロードした後の古いタブ（chrome.runtime が無効化された状態）や
// ページ側のCSPで取得に失敗し、PiPが無スタイルのまま開いてしまうため。
const YTI_PIP_CSS = `


/* ===== Mini Player (Document PiP) : Apple Music 風 ===== */
.yti-pip-body {
  margin: 0;
  padding: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #08080a;
  color: #fff
}

#yti-pip {
  --pip-pad: 16px;
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #08080a;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Segoe UI", Roboto, sans-serif;
  user-select: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility
}

/* 背景は2層。下がサムネイル（映像が出るまでの下地）、上が再生中の映像を
   縮小して描いたキャンバス。映像側が乗ると色が実際のシーンに追従する。
   動き続けると視界の端でチラつくので、位置は固定・色の変化のみ（描画側で平滑化）。 */
#yti-pip-bg,
#yti-pip-bg-live {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 130%;
  height: 130%;
  object-fit: cover;
  transform: translate(-50%, -50%);
  pointer-events: none
}

#yti-pip-bg {
  filter: blur(64px) saturate(190%) brightness(0.58);
  opacity: 0.9;
  z-index: 0
}

/* キャンバスは48x27pxしかないので、拡大時の補間だけでほぼ溶ける */
#yti-pip-bg-live {
  filter: blur(30px) saturate(180%) brightness(0.58);
  opacity: 0;
  z-index: 0;
  transition: opacity 0.8s ease
}

#yti-pip-bg-live.ready {
  opacity: 0.95
}

/* 上下を締めて中央を抜く：文字が乗る部分だけ暗く落ち着かせる */
#yti-pip::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 70% at 50% 0%, rgba(0, 0, 0, 0.15) 0%, rgba(0, 0, 0, 0.5) 100%),
    linear-gradient(to bottom, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0.15) 26%, rgba(0, 0, 0, 0.58) 62%, rgba(0, 0, 0, 0.74) 100%);
  pointer-events: none;
  z-index: 1
}

/* --- 上部：動画（カードとして浮かせる） --- */
.yti-pip-stage {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  margin: var(--pip-pad) var(--pip-pad) 0 var(--pip-pad);
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow:
    0 18px 40px rgba(0, 0, 0, 0.55),
    0 2px 8px rgba(0, 0, 0, 0.4),
    inset 0 0 0 1px rgba(255, 255, 255, 0.09)
}

.yti-pip-stage video,
video.yti-pip-live-video {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
  background: #000 !important;
  transform: translatez(0) !important;
  backface-visibility: hidden !important
}

.yti-pip-stage-fallback svg {
  width: 40px;
  height: 40px;
  fill: rgba(255, 255, 255, 0.22)
}

/* --- 映像の上に重ねる操作系（普段は非表示） --- */
.yti-pip-overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  padding: 30px 14px 10px 14px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.82) 0%, rgba(0, 0, 0, 0.55) 45%, rgba(0, 0, 0, 0) 100%);
  opacity: 0;
  transform: translateY(6px);
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)
}

#yti-pip.show-controls .yti-pip-overlay {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto
}

/* 操作を隠している間の進捗表示。1.5pxの線だけ残す */
.yti-pip-hairline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.5px;
  z-index: 4;
  background: rgba(255, 255, 255, 0.16);
  opacity: 1;
  transition: opacity 0.22s ease;
  pointer-events: none
}

#yti-pip.show-controls .yti-pip-hairline {
  opacity: 0
}

.yti-pip-hairline-fill {
  height: 100%;
  width: 100%;
  transform: scaleX(0);
  transform-origin: left center;
  background: rgba(255, 255, 255, 0.75)
}

.yti-pip-seek {
  position: relative;
  padding: 6px 0;
  cursor: pointer;
  touch-action: none
}

.yti-pip-seek-track {
  position: relative;
  height: 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.26);
  transition: height 0.2s cubic-bezier(0.22, 1, 0.36, 1)
}

.yti-pip-seek:hover .yti-pip-seek-track,
.yti-pip-seek.dragging .yti-pip-seek-track {
  height: 7px
}

.yti-pip-seek-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  transform: scaleX(0);
  transform-origin: left center;
  border-radius: inherit;
  background: #fff
}

.yti-pip-seek-knob {
  position: absolute;
  top: 50%;
  left: 0%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%) scale(0);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)
}

.yti-pip-seek:hover .yti-pip-seek-knob,
.yti-pip-seek.dragging .yti-pip-seek-knob {
  transform: translate(-50%, -50%) scale(1)
}

/* 経過時間 / 操作ボタン / 残り時間 を1行に収める */
.yti-pip-transport {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px
}

.yti-pip-time {
  flex: 0 0 auto;
  min-width: 38px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6)
}

.yti-pip-time.right {
  text-align: right
}

.yti-pip-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px
}

.yti-pip-btn {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #fff;
  transition: background 0.18s ease, transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1)
}

.yti-pip-btn:hover {
  background: rgba(255, 255, 255, 0.16)
}

.yti-pip-btn:active {
  transform: scale(0.88);
  background: rgba(255, 255, 255, 0.24)
}

.yti-pip-btn svg {
  width: 19px;
  height: 19px;
  fill: currentColor;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55))
}

.yti-pip-btn.primary {
  width: 42px;
  height: 42px;
  background: rgba(255, 255, 255, 0.16);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16)
}

.yti-pip-btn.primary:hover {
  background: rgba(255, 255, 255, 0.26)
}

.yti-pip-btn.primary svg {
  width: 22px;
  height: 22px
}

.yti-pip-btn.primary .ic-pause {
  display: none
}

.yti-pip-btn.primary.playing .ic-play {
  display: none
}

.yti-pip-btn.primary.playing .ic-pause {
  display: block
}

/* --- 曲名（常時表示はここだけ） ---
   歌詞より確実に小さく・弱くして「見出し」として読ませる。
   同じ大きさだと歌詞の1行と見分けがつかず、ちぐはぐに見えるため。 */
.yti-pip-panel {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  padding: 12px var(--pip-pad) 10px var(--pip-pad);
  box-sizing: border-box
}

.yti-pip-meta {
  min-width: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1)
}

.yti-pip-title {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.012em;
  line-height: 1.25;
  color: rgba(255, 255, 255, 0.95);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis
}

.yti-pip-artist {
  margin-top: 1px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.035em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.42);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis
}

/* --- 下部：Apple Music 風の歌詞スクロール --- */
.yti-pip-lyrics {
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 var(--pip-pad);
  scrollbar-width: none;
  -ms-overflow-style: none;
  mask-image: linear-gradient(to bottom, transparent 0%, #000 7%, #000 84%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 7%, #000 84%, transparent 100%)
}

.yti-pip-lyrics::-webkit-scrollbar {
  display: none
}

.yti-pip-lyrics-inner {
  padding: 20px 0 58% 0
}

.yti-pip-line {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  margin-bottom: 19px;
  cursor: pointer;
  transform-origin: left center;
  transform: scale(0.97);
  opacity: 0.55;
  filter: blur(0.7px);
  transition:
    transform 0.55s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.55s cubic-bezier(0.22, 1, 0.36, 1)
}

.yti-pip-line:hover {
  opacity: 0.85;
  filter: blur(0)
}

.yti-pip-line.active {
  transform: scale(1);
  opacity: 1;
  filter: blur(0)
}

.yti-pip-text {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.34;
  letter-spacing: -0.015em;
  font-feature-settings: "palt";
  color: rgba(255, 255, 255, 0.62);
  /* 英語は単語の途中で切らずスペースで折る。日本語は auto-phrase で
     文節の切れ目を選ぶ。どうしても入らない長い語だけ break-word で逃がす。 */
  word-break: auto-phrase;
  line-break: strict;
  overflow-wrap: break-word;
  text-wrap: pretty;
  transition: color 0.55s cubic-bezier(0.22, 1, 0.36, 1), text-shadow 0.55s ease
}

.yti-pip-sub {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.42;
  letter-spacing: -0.005em;
  color: rgba(255, 255, 255, 0.42);
  word-break: auto-phrase;
  line-break: strict;
  overflow-wrap: break-word;
  text-wrap: pretty;
  transition: color 0.55s cubic-bezier(0.22, 1, 0.36, 1)
}

.yti-pip-line.active .yti-pip-text {
  color: #fff;
  text-shadow: 0 0 26px rgba(255, 255, 255, 0.35), 0 1px 12px rgba(0, 0, 0, 0.4)
}

.yti-pip-line.active .yti-pip-sub {
  color: rgba(255, 255, 255, 0.72)
}

/* 間奏行：3つのドットが順に膨らむ（Apple Music の間奏インジケータ相当） */
.yti-pip-line.instrumental {
  margin-bottom: 20px
}

.yti-pip-dots {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 18px
}

.yti-pip-dots span {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  transform: scale(0.8)
}

.yti-pip-line.instrumental.active .yti-pip-dots span {
  animation: yti-pip-dot 1.7s cubic-bezier(0.45, 0, 0.55, 1) infinite
}

.yti-pip-line.instrumental.active .yti-pip-dots span:nth-child(2) {
  animation-delay: 0.22s
}

.yti-pip-line.instrumental.active .yti-pip-dots span:nth-child(3) {
  animation-delay: 0.44s
}

@keyframes yti-pip-dot {

  0%,
  100% {
    background: rgba(255, 255, 255, 0.4);
    transform: scale(0.8)
  }

  35% {
    background: #fff;
    transform: scale(1.25)
  }
}

/* --- 読み込み中：歌詞の行の形をしたスケルトン --- */
.yti-pip-skeleton {
  padding: 22px 0 0 0
}

.yti-pip-skeleton span {
  display: block;
  height: 15px;
  margin-bottom: 22px;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.07) 0%, rgba(255, 255, 255, 0.16) 50%, rgba(255, 255, 255, 0.07) 100%);
  background-size: 200% 100%;
  animation: yti-pip-shimmer 1.6s ease-in-out infinite
}

.yti-pip-skeleton span:nth-child(1) { width: 78% }
.yti-pip-skeleton span:nth-child(2) { width: 56%; animation-delay: 0.12s }
.yti-pip-skeleton span:nth-child(3) { width: 68%; animation-delay: 0.24s }
.yti-pip-skeleton span:nth-child(4) { width: 42%; animation-delay: 0.36s }

@keyframes yti-pip-shimmer {
  from { background-position: 100% 0 }
  to { background-position: -100% 0 }
}

/* --- 歌詞が無い曲：空の歌詞欄を見せず、曲名を主役にした「Now Playing」表示にする ---
   以前は「歌詞がありません」の小さな文字だけが広い暗がりの中に浮いていた。 */
.yti-pip-note {
  display: none
}

#yti-pip.no-lyrics .yti-pip-lyrics {
  display: none
}

#yti-pip.no-lyrics .yti-pip-panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px calc(var(--pip-pad) + 10px) 32px calc(var(--pip-pad) + 10px);
  text-align: center;
  animation: yti-pip-rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both
}

#yti-pip.no-lyrics .yti-pip-meta {
  width: 100%;
  padding-bottom: 0;
  border-bottom: none
}

#yti-pip.no-lyrics .yti-pip-title {
  font-size: 22px;
  font-weight: 750;
  line-height: 1.24;
  letter-spacing: -0.02em;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.35)
}

#yti-pip.no-lyrics .yti-pip-artist {
  margin-top: 7px;
  font-size: 12px
}

#yti-pip.no-lyrics .yti-pip-note {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 22px;
  padding: 8px 14px 8px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  color: rgba(255, 255, 255, 0.6);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap
}

/* 再生中だけ動く小さなイコライザー（歌詞が無くても「鳴っている」ことが伝わる） */
.yti-pip-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px
}

.yti-pip-eq i {
  display: block;
  width: 2.5px;
  height: 100%;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.75);
  transform-origin: bottom;
  transform: scaleY(0.35)
}

#yti-pip.is-playing .yti-pip-eq i {
  animation: yti-pip-eq 1s ease-in-out infinite
}

#yti-pip.is-playing .yti-pip-eq i:nth-child(2) { animation-delay: -0.35s }
#yti-pip.is-playing .yti-pip-eq i:nth-child(3) { animation-delay: -0.7s }

@keyframes yti-pip-eq {
  0%, 100% { transform: scaleY(0.3) }
  50% { transform: scaleY(1) }
}

@keyframes yti-pip-rise {
  from { opacity: 0; transform: translateY(8px) }
  to { opacity: 1; transform: none }
}

/* MVモードの表示切替（訳のみ／原文のみ）をPiPにも反映 */
#yti-pip-lyrics.mode-jp-only .type-native,
#yti-pip-lyrics.mode-jp-only .type-romaji {
  display: none !important
}

#yti-pip-lyrics.mode-native-only .type-jp,
#yti-pip-lyrics.mode-native-only .type-romaji {
  display: none !important
}

/* 韓国語の読み（korean_ruby.js）。ハングルの塊の上にカタカナを小さく振る。
   切っている間の .lyric-ko はただのインラインなので、行の折り返しは変わらない。
   カラオケ塗り（background-clip: text）は子孫の字にも掛かるので、ルビも一緒に塗られる。 */
.yti-korean-ruby .lyric-ko {
  display: inline-block;
  text-align: center;
  text-indent: 0
}

.yti-korean-ruby .lyric-ko::before {
  content: attr(data-ruby);
  display: block;
  font-size: 0.42em;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0;
  text-align: center;
  white-space: nowrap
}

/* 小さくされた時は歌詞の文字も詰める */
@media (max-height: 560px) {
  .yti-pip-text {
    font-size: 18px
  }

  .yti-pip-sub {
    font-size: 12.5px
  }

  .yti-pip-line {
    margin-bottom: 16px
  }
}

/* 横長にリサイズされた時は動画を左、歌詞を右に並べる */
@media (min-aspect-ratio: 1/1) {
  #yti-pip {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(250px, 1fr);
    grid-template-rows: auto 1fr
  }

  .yti-pip-stage {
    grid-column: 1;
    grid-row: 1
  }

  .yti-pip-panel {
    grid-column: 1;
    grid-row: 2;
    align-self: start
  }

  .yti-pip-lyrics {
    grid-column: 2;
    grid-row: 1 / span 2;
    padding-top: var(--pip-pad)
  }

  /* 歌詞が無い時は、右側の空いた列に曲名を置く */
  #yti-pip.no-lyrics .yti-pip-panel {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: stretch
  }
}
`;

let pipWindow = null;
let pipRafId = null;
let pipVideoEl = null;
let pipActiveLine = null;
let pipTargetScroll = null;
let pipUserScrollUntil = 0;
let pipLyricsVersion = -1;
let pipLyricsRef = null;
let pipFrameCount = 0;
let pipLoadStateShown = '';

function createPiPPlayerElement() {
  const container = document.createElement('div');
  container.id = 'yti-pip';
  container.innerHTML = `
        <img id="yti-pip-bg" alt="">
        <canvas id="yti-pip-bg-live" width="48" height="27"></canvas>
        <div class="yti-pip-stage" id="yti-pip-stage">
            <div class="yti-pip-stage-fallback" id="yti-pip-stage-fallback">
                <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
            </div>

            <!-- 操作系は普段は隠し、マウスを動かした時だけ映像の上に出す -->
            <div class="yti-pip-overlay" id="yti-pip-overlay">
                <div class="yti-pip-seek" id="yti-pip-seek">
                    <div class="yti-pip-seek-track">
                        <div class="yti-pip-seek-fill" id="yti-pip-seek-fill"></div>
                        <div class="yti-pip-seek-knob" id="yti-pip-seek-knob"></div>
                    </div>
                </div>
                <div class="yti-pip-transport">
                    <span class="yti-pip-time" id="yti-pip-cur">0:00</span>
                    <div class="yti-pip-controls">
                        <button class="yti-pip-btn" id="yti-pip-prev" title="前の動画">
                            <svg viewBox="0 0 24 24"><path d="M6 6h2.5v12H6zm3.5 6L18 18V6z"/></svg>
                        </button>
                        <button class="yti-pip-btn primary" id="yti-pip-play" title="再生 / 一時停止">
                            <svg class="ic-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                            <svg class="ic-pause" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                        </button>
                        <button class="yti-pip-btn" id="yti-pip-next" title="次の動画">
                            <svg viewBox="0 0 24 24"><path d="M6 6l8.5 6L6 18zm9.5 0H18v12h-2.5z"/></svg>
                        </button>
                    </div>
                    <span class="yti-pip-time right" id="yti-pip-dur">-0:00</span>
                </div>
            </div>

            <!-- 操作を隠している間の進捗表示（1.5pxの線） -->
            <div class="yti-pip-hairline"><div class="yti-pip-hairline-fill" id="yti-pip-hairline-fill"></div></div>
        </div>

        <div class="yti-pip-panel">
            <div class="yti-pip-meta">
                <div class="yti-pip-title" id="yti-pip-title">Now Playing</div>
                <div class="yti-pip-artist" id="yti-pip-artist">YouTube</div>
            </div>
            <div class="yti-pip-note"><span class="yti-pip-eq"><i></i><i></i><i></i></span>歌詞は見つかりませんでした</div>
        </div>

        <div class="yti-pip-lyrics" id="yti-pip-lyrics">
            <div class="yti-pip-lyrics-inner" id="yti-pip-lyrics-inner"></div>
        </div>
    `;
  return container;
}

// PiP の歌詞行に付ける言語クラス。MVモードの表示切替（訳のみ／原文のみ）を
// そのまま流用できるよう、クラス名は MV 側と同じ type-* に揃える。
function pipTextTypeClass(subText, rawText) {
  const jp = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/;
  const ko = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/;
  if (ko.test(subText)) return 'type-native';
  if (jp.test(subText)) return 'type-jp';
  return jp.test(rawText || '') ? 'type-romaji' : 'type-eng';
}

function getPiPVideo() {
  if (pipVideoEl && pipVideoEl.isConnected) return pipVideoEl;
  return targetVideo || document.querySelector('video');
}

function renderPiPLyrics() {
  if (!pipWindow) return;
  const doc = pipWindow.document;
  const wrap = doc.getElementById('yti-pip-lyrics');
  const inner = doc.getElementById('yti-pip-lyrics-inner');
  if (!wrap || !inner) return;
  ytiLyricMotion.reset(wrap);
  inner.innerHTML = '';
  pipActiveLine = null;
  pipTargetScroll = null;
  pipFirstScroll = true;
  wrap.scrollTop = 0;
  // MVモードの「全表示／訳のみ／原文のみ」設定を引き継ぐ
  const mode = localStorage.getItem('mv_lyrics_mode') || 'all';
  wrap.classList.remove('mode-jp-only', 'mode-native-only');
  if (mode === 'jp_only') wrap.classList.add('mode-jp-only');
  else if (mode === 'native_only') wrap.classList.add('mode-native-only');
  const root = doc.getElementById('yti-pip');
  if (!lyricsData || lyricsData.length === 0) {
    // まだこの動画の取得が終わっていないなら行の形のスケルトン、
    // 取得済みで0行なら曲名を主役にした表示（.no-lyrics）に切り替える
    const loading = (getVideoId() || '') !== (lyricsLoadDoneVideoId || '');
    if (root) root.classList.toggle('no-lyrics', !loading);
    if (loading) {
      const sk = doc.createElement('div');
      sk.className = 'yti-pip-skeleton';
      for (let i = 0; i < 4; i++) sk.appendChild(doc.createElement('span'));
      inner.appendChild(sk);
    }
    return;
  }
  if (root) root.classList.remove('no-lyrics');
  const frag = doc.createDocumentFragment();
  lyricsData.forEach((line) => {
    // 前回の描画で残った参照を必ず捨てる。切り離された古い要素が残っていると
    // アクティブ行の座標が0扱いになり、歌詞が先頭へ飛んでしまう。
    line.pipEl = null;
    const el = doc.createElement('div');
    el.className = 'yti-pip-line';
    if (line.isInstrumental) {
      el.classList.add('instrumental');
      const dots = doc.createElement('div');
      dots.className = 'yti-pip-dots';
      for (let i = 0; i < 3; i++) dots.appendChild(doc.createElement('span'));
      el.appendChild(dots);
    } else {
      const rawText = line.text || '';
      rawText.split(/\r\n|\n|\r/).forEach((subText) => {
        if (!subText.trim()) return;
        const span = doc.createElement('span');
        span.className = 'yti-pip-text ' + pipTextTypeClass(subText, rawText);
        // auto-phrase（文節での折り返し）は言語が分かって初めて効く
        if (span.classList.contains('type-jp')) span.lang = 'ja';
        span.textContent = subText;
        if (span.classList.contains('type-native')) ytiKoreanRuby.decorate(span);
        el.appendChild(span);
      });
      if (line.subText) {
        line.subText.split(/\r\n|\n|\r/).forEach((subText) => {
          if (!subText.trim()) return;
          const span = doc.createElement('span');
          span.className = 'yti-pip-sub';
          span.textContent = subText.trim();
          el.appendChild(span);
        });
      }
      if (!el.childNodes.length) return;
    }
    el.onclick = () => {
      const v = getPiPVideo();
      if (v) v.currentTime = line.time;
    };
    line.pipEl = el;
    frag.appendChild(el);
  });
  inner.appendChild(frag);
}

// 再生中の映像を48x27pxのキャンバスへ落として背景に使う。
// CSSで拡大＋ぼかすので、この解像度で十分に「その場の色」が出る。
// 動画はクロスオリジンでキャンバスは汚染されるが、描画するだけで
// ピクセルを読まないため表示には支障がない。
function pipDrawAmbientFrame() {
  if (!pipWindow) return;
  const canvas = pipWindow.document.getElementById('yti-pip-bg-live');
  if (!canvas) return;
  const v = getPiPVideo();
  if (!v || v.readyState < 2 || !v.videoWidth) return;
  // 一時停止中は絵が変わらないので描き直さない（既に1枚描けている場合のみ）
  if (v.paused && canvas.classList.contains('ready')) return;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 毎回そのまま描くとカット割りのたびに背景色が飛んでチラつく。
    // 前の絵の上に薄く重ねて、数秒かけて今の色へ寄せる（時間方向の平滑化）。
    const first = !canvas.classList.contains('ready');
    ctx.globalAlpha = first ? 1 : 0.12;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    if (first) canvas.classList.add('ready');
  } catch (e) {
    // 描画できない環境ではサムネイル背景のまま使い続ける
    canvas.classList.remove('ready');
  }
}

function pipFindActiveIndex(currentTime) {
  return heldLyricIndex(findLyricIndexAt(currentTime));
}

// PiPウィンドウ内の要素。毎フレーム getElementById しないよう、開いた時に一度だけ集める
let pipEls = null;
// シークバーをドラッグ中か（その間だけ進捗バーを毎フレーム更新する）
let pipSeekDragging = false;

function collectPiPElements(doc) {
  const g = (id) => doc.getElementById(id);
  return {
    root: g('yti-pip'),
    title: g('yti-pip-title'),
    artist: g('yti-pip-artist'),
    cur: g('yti-pip-cur'),
    dur: g('yti-pip-dur'),
    play: g('yti-pip-play'),
    fill: g('yti-pip-seek-fill'),
    knob: g('yti-pip-seek-knob'),
    hair: g('yti-pip-hairline-fill'),
    wrap: g('yti-pip-lyrics')
  };
}


// PiPの歌詞欄で、歌っている行を置く位置（上から38%）
function pipLineTarget(wrap, el) {
  return el.offsetTop - wrap.clientHeight * 0.38 + el.clientHeight / 2;
}

let pipNeedRescroll = false;

function pipScrollToLine(wrap, el, fromUserScroll, gentle) {
  const inner = el.parentNode;
  ytiLyricMotion.scrollTo(wrap, inner, pipLineTarget(wrap, el), Array.prototype.indexOf.call(inner.children, el), {
    instant: !!pipFirstScroll,
    stagger: !gentle && !fromUserScroll && lyricStaggerEnabled(),
    isRow: (r) => r.classList && r.classList.contains('yti-pip-line')
  });
  pipFirstScroll = false;
}

// 歌詞を描き直した直後の1回目は、動かさずに目的の位置へ置く
let pipFirstScroll = true;

function pipTick() {
  if (!pipWindow) return;
  try {
    const doc = pipWindow.document;
    if (!pipEls || !pipEls.root || !pipEls.root.isConnected) pipEls = collectPiPElements(doc);
    const els = pipEls;
    // 曲・言語が切り替わったらPiP側も追従して作り直す。
    // lyricsData の「配列そのものが差し替わったか」も見るのが要点：
    // 次の曲へ進んだ瞬間に lyricsData は空配列に置き換わるが、MVモード側の
    // 再描画（＝lyricsRenderVersion）は歌詞が無い曲では走らないことがあるため、
    // バージョンだけを見ていると前の曲の歌詞が残り続けてしまう。
    // 歌詞0行のまま「読み込み中」→「歌詞なし」に変わった時も描き直す
    const pipLoadState = (lyricsData && lyricsData.length) ? 'ready' : ((getVideoId() || '') !== (lyricsLoadDoneVideoId || '') ? 'loading' : 'none');
    if (pipLyricsVersion !== lyricsRenderVersion || pipLyricsRef !== lyricsData || pipLoadStateShown !== pipLoadState) {
      pipLyricsVersion = lyricsRenderVersion;
      pipLyricsRef = lyricsData;
      pipLoadStateShown = pipLoadState;
      renderPiPLyrics();
    }
    const v = getPiPVideo();
    pipFrameCount++;
    // タイトル取得は本体ページのDOM走査＋正規表現で重いので約1Hzに間引く
    if (pipFrameCount % 60 === 1) {
      const { title, artist } = getDisplayMetadata();
      if (els.title && els.title.textContent !== (title || 'Unknown')) els.title.textContent = title || 'Unknown';
      if (els.artist && els.artist.textContent !== (artist || 'YouTube')) els.artist.textContent = artist || 'YouTube';
    }
    // 背景の色は約3Hzで追従（毎フレーム描く必要はない）
    if (pipFrameCount % 20 === 5) pipDrawAmbientFrame();
    // 経過時間・再生ボタンの状態は約4Hzで十分
    if (pipFrameCount % 15 === 0) {
      if (v && !isNaN(v.duration) && v.duration > 0) {
        const curText = formatTime(v.currentTime);
        if (els.cur && els.cur.textContent !== curText) els.cur.textContent = curText;
        const durText = '-' + formatTime(v.duration - v.currentTime);
        if (els.dur && els.dur.textContent !== durText) els.dur.textContent = durText;
      }
      const playing = !!(v && !v.paused);
      if (els.play) els.play.classList.toggle('playing', playing);
      if (els.root) els.root.classList.toggle('is-playing', playing);
    }
    // 進捗バーは約10Hz（シーク中だけ毎フレーム）。幅ではなく transform で伸ばし、
    // レイアウトの再計算を起こさない。
    const seeking = pipSeekDragging;
    if ((pipFrameCount % 6 === 0 || seeking) && v && !isNaN(v.duration) && v.duration > 0) {
      const ratio = Math.max(0, Math.min(1, v.currentTime / v.duration));
      const sx = 'scaleX(' + ratio.toFixed(4) + ')';
      if (els.fill && els.fill.style.transform !== sx) els.fill.style.transform = sx;
      if (els.hair && els.hair.style.transform !== sx) els.hair.style.transform = sx;
      const left = (ratio * 100).toFixed(2) + '%';
      if (els.knob && els.knob.style.left !== left) els.knob.style.left = left;
    }
    // 歌詞：アクティブ行の付け替えと行送りは、行が変わった時の1回だけ。
    // 行送りは MVモードと同じ時間差つきのばね（lyric_motion.js、合成スレッドで動く）。
    const wrap = els.wrap;
    if (wrap && lyricsData && lyricsData.length) {
      const activeIndex = v ? pipFindActiveIndex(v.currentTime) : -1;
      const active = activeIndex >= 0 ? lyricsData[activeIndex] : null;
      const changed = (active !== pipActiveLine);
      if (changed) {
        if (pipActiveLine && pipActiveLine.pipEl) pipActiveLine.pipEl.classList.remove('active');
        if (active && active.pipEl) active.pipEl.classList.add('active');
        pipActiveLine = active;
      }
      const userScrolling = Date.now() < pipUserScrollUntil;
      if (active && active.pipEl && !userScrolling) {
        if (changed || pipNeedRescroll) {
          pipScrollToLine(wrap, active.pipEl, pipNeedRescroll && !changed);
          pipNeedRescroll = false;
        } else if (pipFrameCount % 30 === 0 && !ytiLyricMotion.isMoving(wrap)) {
          // ウィンドウのリサイズやフォント読み込みで座標がずれていたら、そっと合わせ直す
          const target = pipLineTarget(wrap, active.pipEl);
          const max = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
          if (Math.abs(Math.max(0, Math.min(max, target)) - wrap.scrollTop) > 3) pipScrollToLine(wrap, active.pipEl, false, true);
        }
      } else if (userScrolling) {
        // 手を離したら現在の行へ戻す
        pipNeedRescroll = true;
      }
    }
  } catch (e) {}
  // rAF は「表示されている PiP ウィンドウ側」で回す。元タブが裏に回っても止まらない。
  pipRafId = pipWindow.requestAnimationFrame(pipTick);
}

async function enableMiniPlayerPiP() {
  if (!('documentPictureInPicture' in window)) {
    showToast("このブラウザはMini Playerに対応していません");
    return;
  }
  if (pipWindow) {
    pipWindow.close();
    return;
  }
  try {
    const pipEl = createPiPPlayerElement();
    pipWindow = await documentPictureInPicture.requestWindow({
      width: 400,
      height: 600,
    });
    // CSSは埋め込み定数から直接入れる（fetch も chrome.runtime も介さない）
    const style = pipWindow.document.createElement('style');
    style.textContent = YTI_PIP_CSS;
    pipWindow.document.head.appendChild(style);
    pipWindow.document.documentElement.lang = 'ja';
    ytiKoreanRuby.applyTo(pipWindow.document);
    pipWindow.document.body.classList.add('yti-pip-body');
    pipWindow.document.body.appendChild(pipEl);
    const doc = pipWindow.document;
    // Apple Music 風のぼかし背景（サムネイル）。取得できなければ黒のまま。
    const bg = doc.getElementById('yti-pip-bg');
    if (bg) {
      const thumb = getHighResThumbnail();
      if (thumb) {
        bg.onerror = () => {
          bg.src = getLowResThumbnail();
          bg.onerror = null;
        };
        bg.src = thumb;
      }
    }
    // 実再生中の動画要素をそのまま PiP 上部へ移動する（Document PiP の定石）。
    // 閉じる時に元の位置へ戻す。
    const realVideo = targetVideo || document.querySelector('#movie_player .video-stream.html5-main-video') || document.querySelector('video');
    let pipReturnParent = null;
    let pipReturnNext = null;
    let videoStyleBackup = null;
    const stage = doc.getElementById('yti-pip-stage');
    if (stage && realVideo) {
      pipReturnParent = realVideo.parentNode;
      pipReturnNext = realVideo.nextSibling;
      videoStyleBackup = realVideo.getAttribute('style');
      realVideo.classList.add('yti-pip-live-video');
      const fallback = doc.getElementById('yti-pip-stage-fallback');
      if (fallback) fallback.style.display = 'none';
      stage.insertBefore(realVideo, stage.firstChild);
      pipVideoEl = realVideo;
    }
    const restoreVideo = () => {
      try {
        if (!realVideo) return;
        realVideo.classList.remove('yti-pip-live-video');
        if (videoStyleBackup !== null) realVideo.setAttribute('style', videoStyleBackup);
        else realVideo.removeAttribute('style');
        // 元の親（MVモードのオーバーレイなど）がPiP中に消えていることがある。
        // その場合はYouTubeのプレイヤー内へ戻し、動画が行方不明になるのを防ぐ。
        let parent = (pipReturnParent && pipReturnParent.isConnected) ? pipReturnParent : null;
        if (!parent && originalParent && originalParent.isConnected) parent = originalParent;
        if (!parent) parent = document.querySelector('#movie_player .html5-video-container') || document.querySelector('#movie_player');
        if (parent) {
          if (parent === pipReturnParent && pipReturnNext && pipReturnNext.parentNode === parent) {
            parent.insertBefore(realVideo, pipReturnNext);
          } else {
            parent.appendChild(realVideo);
          }
        }
      } catch (e) {}
    };

    const togglePlay = () => {
      const v = getPiPVideo();
      if (!v) return;
      if (v.paused) v.play();
      else v.pause();
    };
    const playBtn = doc.getElementById('yti-pip-play');
    if (playBtn) playBtn.onclick = (e) => {
      e.stopPropagation();
      togglePlay();
    };
    const nextBtn = doc.getElementById('yti-pip-next');
    if (nextBtn) nextBtn.onclick = (e) => {
      e.stopPropagation();
      const b = document.querySelector('.ytp-next-button');
      if (b) b.click();
    };
    const prevBtn = doc.getElementById('yti-pip-prev');
    if (prevBtn) prevBtn.onclick = (e) => {
      e.stopPropagation();
      const b = document.querySelector('.ytp-prev-button');
      if (b) b.click();
    };
    // シークバー：クリック／ドラッグで再生位置を移動
    // ドラッグ中は操作系を自動で隠さないよう、外側のスコープで持つ
    let seekDragging = false;
    const seek = doc.getElementById('yti-pip-seek');
    if (seek) {
      const seekTo = (clientX) => {
        const v = getPiPVideo();
        if (!v || isNaN(v.duration) || v.duration <= 0) return;
        const rect = seek.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        v.currentTime = ratio * v.duration;
      };
      seek.addEventListener('pointerdown', (e) => {
        seekDragging = true;
        pipSeekDragging = true;
        seek.classList.add('dragging');
        seek.setPointerCapture?.(e.pointerId);
        seekTo(e.clientX);
      });
      seek.addEventListener('pointermove', (e) => {
        if (seekDragging) seekTo(e.clientX);
      });
      const endSeek = () => {
        seekDragging = false;
        pipSeekDragging = false;
        seek.classList.remove('dragging');
      };
      seek.addEventListener('pointerup', endSeek);
      seek.addEventListener('pointercancel', endSeek);
    }
    // 動画部分クリックで再生/一時停止、ホイールで音量
    if (stage) {
      stage.addEventListener('click', togglePlay);
      stage.addEventListener('wheel', (e) => {
        const v = getPiPVideo();
        if (!v) return;
        e.preventDefault();
        let vol = v.volume + (e.deltaY > 0 ? -0.05 : 0.05);
        v.volume = Math.max(0, Math.min(1, vol));
      }, { passive: false });
    }
    // 歌詞を手動スクロール中は自動追従を一時停止する
    const lyricsWrap = doc.getElementById('yti-pip-lyrics');
    if (lyricsWrap) {
      const markUserScroll = () => {
        pipUserScrollUntil = Date.now() + 2500;
        ytiLyricMotion.reset(lyricsWrap);
      };
      lyricsWrap.addEventListener('wheel', markUserScroll, { passive: true });
      lyricsWrap.addEventListener('touchmove', markUserScroll, { passive: true });
    }
    // 操作系は普段隠しておき、マウスを動かした時だけ映像の上に出す。
    // 出しっぱなしだと歌詞の場所を食う＆ウィンドウを大きくしないと収まらないため。
    const root = doc.getElementById('yti-pip');
    let controlsTimer = null;
    let pointerOnControls = false;
    const hideControls = () => {
      if (pointerOnControls) return;
      if (seekDragging) return;
      if (root) root.classList.remove('show-controls');
    };
    const showControls = () => {
      if (root) root.classList.add('show-controls');
      if (controlsTimer) clearTimeout(controlsTimer);
      controlsTimer = setTimeout(hideControls, 2200);
    };
    doc.addEventListener('mousemove', showControls);
    doc.addEventListener('pointerdown', showControls);
    const overlayEl = doc.getElementById('yti-pip-overlay');
    if (overlayEl) {
      overlayEl.addEventListener('mouseenter', () => {
        pointerOnControls = true;
      });
      overlayEl.addEventListener('mouseleave', () => {
        pointerOnControls = false;
        showControls();
      });
      // オーバーレイの余白クリックで再生が切り替わらないようにする
      overlayEl.addEventListener('click', (e) => e.stopPropagation());
    }
    // 開いた直後だけ一度見せる（操作系があることを分かるように）
    showControls();
    doc.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        const v = getPiPVideo();
        if (v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        const v = getPiPVideo();
        if (v) v.currentTime = Math.max(0, v.currentTime - 5);
      }
    });

    pipLyricsVersion = -1;
    pipLyricsRef = null;
    pipLoadStateShown = '';
    pipEls = null;
    pipFrameCount = 0;
    pipUserScrollUntil = 0;
    pipRafId = pipWindow.requestAnimationFrame(pipTick);

    pipWindow.addEventListener('pagehide', () => {
      try {
        if (pipRafId && pipWindow) pipWindow.cancelAnimationFrame(pipRafId);
      } catch (e) {}
      pipRafId = null;
      restoreVideo();
      pipVideoEl = null;
      pipActiveLine = null;
      pipTargetScroll = null;
      pipWindow = null;
    });
  } catch (err) {
    pipWindow = null;
  }
}

function formatTime(s) {
  if (isNaN(s)) return "0:00";
  if (s < 0) s = 0;
  const min = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${min}:${sec < 10 ? '0' + sec : sec}`;
}
// ===== MVモードの歌詞の行送り =====
// 行が変わった時だけ、YTM-Immersion と同じ「時間差つきのばね」で行を送る（lyric_motion.js）。
// 以前は rAF で毎フレーム scrollTop を目標へ寄せていたが、それだとメインスレッドが
// 重いフレームで歌詞も止まり、止まり際も段々になっていた。
// rAF のループはカラオケの塗り（毎フレーム必要）がオンの時だけ回す。
let scrollFrameId = null;
let lastActiveEl = null;
let cachedTargetScroll = null;
let recalcTimer = null;
let userScrollResumeTimer = null;
// 歌詞を描き直した直後の1回目は、動かさずに目的の位置へ置く
let lyricsNeedInstantScroll = true;
let autoScrollContainer = null;

function lyricStaggerEnabled() {
  return getMvOption('mv_lyric_stagger', true);
}

function isMvLyricRow(el) {
  return !!el && el.classList && el.classList.contains('lyric-line-container');
}

// 歌っている行を歌詞欄の中央に置く scrollTop
function mvLyricTargetFor(container, el) {
  return el.offsetTop - (container.clientHeight / 2) + (el.clientHeight / 2);
}

// 現在行へ歌詞を送る。syncLyrics で行が変わった時・手動スクロールから戻る時などに呼ぶ。
function scrollMvLyricsToActive(forceInstant) {
  const container = autoScrollContainer;
  if (!container || !container.isConnected) return;
  if (isLyricSelectionMode || container.classList.contains('selecting')) return;
  if (Date.now() < userScrollUntil) return;
  const line = activeLyricLine;
  const el = (line && line.el && line.el.isConnected) ? line.el : null;
  if (!el) return;
  const target = mvLyricTargetFor(container, el);
  const instant = !!forceInstant || lyricsNeedInstantScroll;
  lyricsNeedInstantScroll = false;
  const wasInstrumental = lastActiveEl && lastActiveEl.classList.contains('instrumental-line');
  lastActiveEl = el;
  cachedTargetScroll = target;
  ytiLyricMotion.scrollTo(container, container, target, Array.prototype.indexOf.call(container.children, el), {
    instant,
    stagger: lyricStaggerEnabled(),
    isRow: isMvLyricRow
  });
  // 間奏の「・・・」行は、終わると高さが縮んで行の位置がずれる。落ち着いた頃に合わせ直す
  if (wasInstrumental) {
    if (recalcTimer) clearTimeout(recalcTimer);
    recalcTimer = setTimeout(() => {
      recalcTimer = null;
      if (!activeLyricLine || activeLyricLine.el !== el || !el.isConnected) return;
      const again = mvLyricTargetFor(container, el);
      if (Math.abs(again - container.scrollTop) > 2 && Date.now() >= userScrollUntil) {
        ytiLyricMotion.scrollTo(container, container, again, Array.prototype.indexOf.call(container.children, el), {
          stagger: false,
          isRow: isMvLyricRow
        });
      }
    }, 600);
  }
}

// 行送りと塗りの時計。timeupdate（Chrome では約250ms間隔）では行の切り替わりが歌より遅れるので、
// 再生中は毎フレーム現在行を確かめる（行が変わらない限り DOM は触らない）。
function karaokeLoop() {
  scrollFrameId = null;
  if (!rootContainer) return;
  if (targetVideo && !targetVideo.paused) {
    try {
      syncLyrics();
    } catch (e) {}
    if (karaokeEnabledCache) {
      try {
        updateKaraokeFill();
      } catch (e) {}
    }
  }
  scrollFrameId = requestAnimationFrame(karaokeLoop);
}

// カラオケの塗りのループを、設定に合わせて回す／止める
function updateKaraokeLoop() {
  if (karaokeEnabledCache === null) karaokeEnabledCache = getMvOption('mv_karaoke', true);
  try {
    updateKaraokeFill(); // クラスの付け外しを反映
  } catch (e) {}
  if (rootContainer && !scrollFrameId) scrollFrameId = requestAnimationFrame(karaokeLoop);
}

function startSmoothAutoScroll(container) {
  autoScrollContainer = container;
  lyricsNeedInstantScroll = true;
  // 手動スクロール（ホイール／タッチ）中は自動スクロールを一時停止し、
  // 手を離して少し経ったら現在の行へ戻る。
  if (!container._userScrollHooked) {
    container._userScrollHooked = true;
    const markUserScroll = () => {
      userScrollUntil = Date.now() + 2500;
      // 手で動かしたので、行送りの途中の動きは止める（行が掴んだ位置からずれて見えないように）
      ytiLyricMotion.reset(container);
      if (userScrollResumeTimer) clearTimeout(userScrollResumeTimer);
      userScrollResumeTimer = setTimeout(() => {
        userScrollResumeTimer = null;
        scrollMvLyricsToActive(false);
      }, 2600);
    };
    container.addEventListener('wheel', markUserScroll, { passive: true });
    container.addEventListener('touchmove', markUserScroll, { passive: true });
  }
  if (!container._resizeRecenterHooked) {
    container._resizeRecenterHooked = true;
    // 窓の大きさ・歌詞欄の高さが変わったら、動かさずに中央へ置き直す
    const ro = new ResizeObserver(() => scrollMvLyricsToActive(true));
    ro.observe(container);
  }
  updateKaraokeLoop();
  scrollMvLyricsToActive(true);
}

function stopSmoothAutoScroll() {
  if (scrollFrameId) {
    cancelAnimationFrame(scrollFrameId);
    scrollFrameId = null;
  }
  if (autoScrollContainer) ytiLyricMotion.reset(autoScrollContainer);
  autoScrollContainer = null;
  if (userScrollResumeTimer) {
    clearTimeout(userScrollResumeTimer);
    userScrollResumeTimer = null;
  }
  // 保留中の再計算タイマーが古いコンテナの座標を次のセッションに書き込まないように
  if (recalcTimer) {
    clearTimeout(recalcTimer);
    recalcTimer = null;
  }
}

function cropCanvasBlackBars(sourceCanvas) {
  const ctx = sourceCanvas.getContext('2d', {
    willReadFrequently: true
  });
  const imageData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  let top = 0;
  let bottom = sourceCanvas.height;
  const THRESHOLD = 30;
  const SCAN_STEP = 5;
  for (let y = 0; y < sourceCanvas.height / 2; y++) {
    let isBlackLine = true;
    for (let x = 0; x < sourceCanvas.width; x += SCAN_STEP) {
      const i = (y * sourceCanvas.width + x) * 4;
      if (imageData[i] > THRESHOLD || imageData[i + 1] > THRESHOLD || imageData[i + 2] > THRESHOLD) {
        isBlackLine = false;
        break;
      }
    }
    if (!isBlackLine) {
      top = y;
      break;
    }
  }
  for (let y = sourceCanvas.height - 1; y > sourceCanvas.height / 2; y--) {
    let isBlackLine = true;
    for (let x = 0; x < sourceCanvas.width; x += SCAN_STEP) {
      const i = (y * sourceCanvas.width + x) * 4;
      if (imageData[i] > THRESHOLD || imageData[i + 1] > THRESHOLD || imageData[i + 2] > THRESHOLD) {
        isBlackLine = false;
        break;
      }
    }
    if (!isBlackLine) {
      bottom = y;
      break;
    }
  }
  if (top % 2 !== 0) top--;
  if (bottom % 2 !== 0) bottom++;
  const croppedHeight = bottom - top;
  const detectedRatio = sourceCanvas.width / croppedHeight;
  if (croppedHeight <= 0 || detectedRatio < 1.2 || detectedRatio > 3.8) {
    return sourceCanvas;
  }
  const newCanvas = document.createElement('canvas');
  newCanvas.width = sourceCanvas.width;
  newCanvas.height = croppedHeight;
  const newCtx = newCanvas.getContext('2d');
  newCtx.drawImage(sourceCanvas, 0, top, sourceCanvas.width, croppedHeight, 0, 0, sourceCanvas.width, croppedHeight);
  return newCanvas;
}

function applySharpenFilter(sourceCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext('2d', {
    willReadFrequently: true
  });
  ctx.drawImage(sourceCanvas, 0, 0);
  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const output = ctx.createImageData(w, h);
  const dst = output.data;
  const kernel = [-1, -1, -1, -1, 9, -1, -1, -1, -1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const dstOff = (y * w + x) * 4;
      let r = 0,
        g = 0,
        b = 0;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const srcOff = ((y + ky - 1) * w + (x + kx - 1)) * 4;
          const weight = kernel[ky * 3 + kx];
          r += data[srcOff] * weight;
          g += data[srcOff + 1] * weight;
          b += data[srcOff + 2] * weight;
        }
      }
      dst[dstOff] = r;
      dst[dstOff + 1] = g;
      dst[dstOff + 2] = b;
      dst[dstOff + 3] = data[dstOff + 3];
    }
  }
  ctx.putImageData(output, 0, 0);
  return canvas;
}

function getHighResThumbnail() {
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (videoId) {
    return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  }
  return null;
}

function formatLrcTime(time) {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  const hundredths = Math.floor((time % 1) * 100);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

function downloadLrc() {
  if (!lyricsData || lyricsData.length === 0) {
    showToast("出力する歌詞がありません");
    return;
  }
  let lrcStr = "";
  const title = document.getElementById('mv-song-title')?.textContent.trim() || "";
  const artist = document.getElementById('mv-artist-name')?.textContent.trim() || "";
  if (title) lrcStr += `[ti:${title}]\n`;
  if (artist) lrcStr += `[ar:${artist}]\n`;
  const savedMode = localStorage.getItem('mv_lyrics_mode') || 'all';
  const currentMode = savedMode === 'native_only' ? 2 : (savedMode === 'jp_only' ? 1 : 0);
  lyricsData.forEach(line => {
    if (!line.text || line.isInstrumental) return;
    let targetText = [];
    const lines = line.text.split(/\r\n|\n|\r/);
    lines.forEach(sub => {
      const isJP = !!sub.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
      if (currentMode === 1 && !isJP) return;
      if (currentMode === 2 && isJP) return;
      targetText.push(sub.trim());
    });
    const joinedText = targetText.join(' ');
    if (joinedText) {
      const timeTag = formatLrcTime(line.time);
      lrcStr += `${timeTag}${joinedText}\n`;
    }
  });
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, lrcStr], {
    type: 'text/plain;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = `${title || "lyrics"}.lrc`;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
  showToast("LRCファイルを保存しました");
}
