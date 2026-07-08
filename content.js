document.addEventListener('yt-navigate-finish', onNavigate);
document.addEventListener('yt-page-data-updated', () => {
  if (rootContainer) {
    setTimeout(() => {
      if (!rootContainer) return; // 遅延中にMVモードが終了していたら何もしない
      updateMetadataUI();
      updateMVContent(0);
      updateSidebarContent(0);
    }, 2500);
  }
});
window.addEventListener('load', init);
let lastTitle = "";
let lastLyricIndex = -1;
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
    if (!ytiLyricsCache[d.videoId]) ytiLyricsCache[d.videoId] = {};
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
    const lyricsArea = document.getElementById('mv-lyrics-area');
    if (lyricsArea) lyricsArea.innerHTML = '<p style="opacity:0.5; font-size: 24px; padding: 40px;">Loading next track...</p>';
    const titleEl = document.getElementById('mv-song-title');
    if (titleEl) titleEl.innerText = "Loading...";
    const artistEl = document.getElementById('mv-artist-name');
    if (artistEl) artistEl.innerText = "";
    await new Promise(r => setTimeout(r, 1000));
    startMVMode(true, true);
  } else {
    init();
    if (sessionStorage.getItem('mv_mode_active') === 'true') {
      await new Promise(r => setTimeout(r, 1800));
      startMVMode(true);
    }
  }
}

function startSidebarObserver() {
  if (sidebarObserver) sidebarObserver.disconnect();
  const targetNode = document.querySelector('ytd-watch-next-secondary-results-renderer #items') || document.querySelector('#secondary #items');
  if (!targetNode) {
    setTimeout(startSidebarObserver, 2000);
    return;
  }
  sidebarObserver = new MutationObserver(() => {
    updateSidebarContent(0);
  });
  sidebarObserver.observe(targetNode, {
    childList: true
  });
  updateSidebarContent(0);
}

function startButtonObserver() {
  if (buttonObserverTimer) clearInterval(buttonObserverTimer);
  addMVButton();
  buttonObserverTimer = setInterval(() => {
    if (!document.querySelector('.ytp-mv-mode-button')) {
      addMVButton();
    }
  }, 1500);
}

function addMVButton() {
  try {
    const controlBar = document.querySelector('.ytp-right-controls');
    if (!controlBar) return;
    if (!document.querySelector('.ytp-mv-mode-button')) {
      const btn = document.createElement('div');
      btn.className = 'ytp-button ytp-mv-mode-button';
      btn.innerText = 'MVモード';
      btn.style.textAlign = 'center';
      btn.style.width = 'auto';
      btn.style.cursor = 'pointer';
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        startMVMode(false);
      };
      controlBar.insertBefore(btn, controlBar.firstChild);
    }
  } catch (e) {}
}
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

                height: var(--mv-lyrics-height, 300px);
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
                bottom: calc(60px + var(--mv-lyrics-height, 300px) + 20px);
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
                margin-bottom: 32px;
                position: relative;

                transform-origin: right center;

                transition: transform 0.4s cubic-bezier(0.2, 0, 0.2, 1);
            }

            .lyric-line {
                font-size: 32px;
                font-weight: 700;

                color: rgba(255, 255, 255, 0.15);

                filter: blur(1.5px);

                cursor: pointer;
                line-height: 1.5;
                font-feature-settings: "palt";
                letter-spacing: 0.02em;
                white-space: pre-wrap;
                word-break: break-all;
                overflow-wrap: break-word;
                max-width: 100%;

                transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
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
            #mv-song-title { font-size: 42px; font-weight: 800; margin: 0 0 8px 0; line-height: 1.1; letter-spacing: -0.02em; color: #ffffff; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7); white-space: nowrap; overflow: hidden; display: block; max-width: 40vw; }
            #mv-song-title.marquee { display: flex; width: fit-content; }
            #mv-song-title.marquee span { display: inline-block; padding-right: 50px; animation: scroll-left 18s ease-in infinite; }
            @keyframes scroll-left { 0% { transform: translateX(0); } 20% { transform: translateX(0); } 100% { transform: translateX(-100%); } }
            .mv-header-group { position: absolute; top: 30px; display: flex; align-items: center; gap: 12px; z-index: 2000; pointer-events: none; }
            .mv-header-group > * { pointer-events: auto; position: static !important; margin: 0 !important; }
            .mv-header-group.left { left: 30px; }
            .mv-header-group.right { right: 30px; }

            .mv-header-group.right.active #mv-pin-btn { background: #ffffff !important; color: #000000 !important; border-color: transparent; box-shadow: 0 4px 12px rgba(0,0,0,0.2); text-shadow: none; }
            .mv-header-group.right.active #mv-pin-btn svg { fill: #000000 !important; }

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
<input type="range" id="mv-pos-slider" min="100" max="900" value="300" style="width: 80px; height: 4px; border-radius: 2px; -webkit-appearance: none; background: rgba(255,255,255,0.2); outline: none; cursor: pointer;">            </div>

            <div class="mv-header-group left">
                <button id="mv-shot-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot</button>
                <button id="mv-desktop-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Mini Player</button>
            </div>

            <div id="mv-glass-slider-container">
                <input type="range" id="mv-glass-slider" min="0" max="100" value="50">
            </div>
            <button id="mv-glass-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:16px;height:16px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" opacity="0.4"/><rect x="7" y="7" width="10" height="10" rx="2" ry="2" opacity="0.7"/></svg> Glass</button>

            <div class="mv-header-group right">
                <button id="mv-settings-btn" class="mv-glass-btn" title="表示オプション"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
                <button id="mv-record-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg> Record</button>
                <button id="mv-pin-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg> 固定オフ</button>
                <button id="mv-close-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
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

            <img id="mv-ambient-background" src="" alt="">

            <div id="mv-ambient-controls">
                <div class="amb-toggle-wrapper" id="amb-toggle-btn">
                    <span class="amb-label">Ambient</span>
                    <div class="amb-switch"></div>
                </div>
                <div class="amb-slider-container">
                    <svg class="amb-icon" viewBox="0 0 24 24"><path d="M20 15.31L23.31 12 20 8.69V4h-4.69L12 0.69 8.69 4H4v4.69L0.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>
                    <input type="range" id="amb-brightness-slider" min="10" max="150" value="50">
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
      enableIpodPiP();
    };
    const settingsBtn = overlayContent.querySelector('#mv-settings-btn');
    if (settingsBtn) {
      const panel = buildSettingsPanel();
      overlayContent.appendChild(panel);
      settingsBtn.onclick = (e) => {
        e.stopPropagation();
        panel.classList.toggle('open');
      };
      document.addEventListener('click', (ev) => {
        if (!panel.classList.contains('open')) return;
        if (ev.target.closest('#mv-settings-panel') || ev.target.closest('#mv-settings-btn')) return;
        panel.classList.remove('open');
      });
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
        const savedHeight = localStorage.getItem('mv_lyrics_height') || '300';
        posSlider.value = savedHeight;
        rootContainer.style.setProperty('--mv-lyrics-height', savedHeight + 'px');
        posSlider.oninput = (e) => {
          e.stopPropagation();
          const val = e.target.value;
          rootContainer.style.setProperty('--mv-lyrics-height', val + 'px');
          localStorage.setItem('mv_lyrics_height', val);
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
        pinBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/><path d="M9 4h6v7.17l1.5 2.25V14h-9v-.58l1.5-2.25V4z" fill="currentColor"/></svg> 固定オン';
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
          pinBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11V22H13V16H18V14L16,12Z"/></svg> 固定オン';
          if (parentGroup) parentGroup.classList.add('active');
          document.getElementById('mv-info-area')?.classList.add('visible');
          showToast("コントローラーを固定しました");
        } else {
          pinBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg> 固定オフ';
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
    rootContainer.appendChild(overlayContent);
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
    document.body.appendChild(rootContainer);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('mousemove', onUserAction);
    document.addEventListener('click', onUserAction);
    onUserAction();
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
  if (!isAuto && !isHotSwap) {
    rootContainer.requestFullscreen().catch(() => {});
  }
  try {
    updateMetadataUI();
    updateMVContent().catch(() => {});
  } catch (e) {}
  startSidebarObserver();
  const lyricsArea = document.getElementById('mv-lyrics-area');
  if (lyricsArea) startSmoothAutoScroll(lyricsArea);
  // タイトル常時表示オプションが有効なら、起動時から曲名を表示する
  if (isTitleAlwaysOn) {
    setTimeout(() => document.getElementById('mv-info-area')?.classList.add('visible'), 150);
  }
  if (targetVideo.paused) targetVideo.play();
}

function endMVMode(keepActive = false) {
  // 進行中の歌詞ロードを打ち切る（終了後もCCボタン等を操作し続けないように）
  mvContentToken++;
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
  if (!keepActive) {
    targetVideo = null;
    sessionStorage.removeItem('mv_mode_active');
  }
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
async function interceptFromCCButton() {
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
async function scrapeTranscriptFromDOM() {
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
const INTERLUDE_THRESHOLD = 12;

function renderLyricsDOM(lyricsArea) {
  if (!lyricsArea) return;
  // 歌詞を作り直すので、前の曲のスクロール目標・active要素参照をリセットする
  lastActiveEl = null;
  cachedTargetScroll = null;
  lastLyricIndex = -1;
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
      else if (hasJapanese) textSpan.classList.add('type-jp');
      else textSpan.classList.add((segmentHasJapanese && !hasJapanese) || isOrphanRomaji ? 'type-romaji' : 'type-eng');
      container.appendChild(textSpan);
      const rmSpan = document.createElement('span');
      rmSpan.innerText = subText;
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
    line.el = container;
    // #1 クイックコピー：行ホバーで現れるボタンでその行の歌詞を即コピー（再生位置は動かさない）
    if (!line.isInstrumental) {
      const quickCopyBtn = document.createElement('button');
      quickCopyBtn.className = 'lyric-quick-copy';
      quickCopyBtn.title = 'この行をコピー';
      quickCopyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
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
      // 外部歌詞モード：行ホバーの時計ボタンで「この行＝今」のアンカーを打つ。
      // イントロや間奏の映像パートで生じたズレを、その行以降だけ合わせ直せる。
      if (usingExternalLyrics && typeof line.baseTime === 'number') {
        const syncBtn = document.createElement('button');
        syncBtn.className = 'lyric-quick-copy lyric-sync-tap';
        syncBtn.title = 'この行を「今」に同期（この行以降のタイミングを合わせ直します）';
        syncBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 10v3l2 2"/><path d="M9 2h6"/></svg>';
        syncBtn.onclick = (e) => {
          e.stopPropagation();
          addLyricsAnchorForLine(line);
        };
        container.appendChild(syncBtn);
      }
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
}

function buildLyricsUIWithLanguageSwitch(lyricsArea, lyricsHeader) {
  if (!lyricsHeader) lyricsHeader = document.getElementById('mv-lyrics-header');
  if (!lyricsArea) lyricsArea = document.getElementById('mv-lyrics-area');
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
      langBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> 全表示';
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
  copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
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
  selectBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
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
      selectBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
      copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
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

function processRawLyricsToProcessed(rawLyrics) {
  const processed = [];
  for (let i = 0; i < rawLyrics.length; i++) {
    const currentLine = rawLyrics[i];
    processed.push(currentLine);
    if (i < rawLyrics.length - 1) {
      const nextLine = rawLyrics[i + 1];
      const endTime = currentLine.duration ? (currentLine.time + currentLine.duration) : (currentLine.time + 4.0);
      const trueGap = nextLine.time - endTime;
      if (trueGap >= 8.0) {
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

function mergeDualLyrics(mainRaw, subRaw) {
  if (!subRaw || subRaw.length === 0) return processRawLyricsToProcessed(mainRaw);
  const processedMain = processRawLyricsToProcessed(mainRaw);
  processedMain.forEach(mainLine => {
    if (mainLine.isInstrumental) return;
    const match = subRaw.find(sub => Math.abs(sub.time - mainLine.time) < 1.5);
    if (match && match.text.trim() !== mainLine.text.trim()) {
      mainLine.subText = match.text;
    }
  });
  return processedMain;
}

function getCleanedMetadata() {
  let rawTitle = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent.trim() || document.querySelector('#title h1')?.innerText || document.title.replace(' - YouTube', '') || "";
  let songTitle = rawTitle;
  let rawArtist = "";
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
    const artistParts = rawArtist.split('&').map(s => s.trim());
    artistParts.forEach(art => {
      if (art) tempTitle = tempTitle.replace(art, '');
    });
    songTitle = tempTitle.replace(/【.*?】/g, '').replace(/\[.*?\]/g, '').replace(/［.*?］/g, '').replace(/\(.*?\)/g, '').replace(/（.*?）/g, '').replace(/Official\s*Music\s*Video/gi, '').replace(/Music\s*Video/gi, '').replace(/Official\s*Video/gi, '').replace(/Official\s*MV/gi, '').replace(/Special\s*Film/gi, '').replace(/Performance\s*Video/gi, '').replace(/MV/gi, '').replace(/full/gi, '').replace(/公式/g, '').replace(/\//g, '').trim().replace(/^[\s\-:：]+|[\s\-:：]+$/g, '');
    const quoteCleanup = songTitle.match(/^["'](.*?)["']$/);
    if (quoteCleanup) {
      songTitle = quoteCleanup[1];
    }
  }
  let artistName = rawArtist.replace(/Official\s*Channel/gi, '').replace(/Channel/gi, '').replace(/チャンネル/g, '').replace(/公式/g, '').trim();
  return {
    title: songTitle,
    artist: artistName
  };
}

function updateMetadataUI() {
  const infoArea = document.getElementById('mv-info-area');
  const {
    title: songTitle,
    artist: artistName
  } = getCleanedMetadata();
  if (infoArea) {
    const rmTitle = document.getElementById('rm-song-title');
    const rmArtist = document.getElementById('rm-artist-name');
    const vinylLabel = document.getElementById('vinyl-label');
    if (rmTitle) rmTitle.innerText = songTitle;
    if (rmArtist) rmArtist.innerText = artistName;
    if (vinylLabel) {
      const vThumb = getHighResThumbnail();
      if (vThumb) vinylLabel.style.backgroundImage = `url('${vThumb}')`;
    }
    infoArea.innerHTML = `<h1 id="mv-song-title">${songTitle}</h1><p id="mv-artist-name">${artistName}</p>`;
    const titleEl = document.getElementById('mv-song-title');
    if (titleEl) {
      if (titleEl.scrollWidth > titleEl.clientWidth) {
        titleEl.classList.add('marquee');
        titleEl.innerHTML = `<span>${songTitle}</span><span>${songTitle}</span>`;
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

// LRCLIBから同期歌詞を検索。タイトル・アーティスト類似度＋動画尺との整合でスコアリング。
// 結果はvideoIdごとにlocalStorageへキャッシュ（ヒット30日・ミス24時間）し、再取得を避ける。
async function fetchLrclibLyrics(videoId) {
  const cacheKey = 'yti_lrc_cache_' + (videoId || '');
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const c = JSON.parse(raw);
      const age = Date.now() - (c.ts || 0);
      if (c.miss && age < 24 * 3600 * 1000) return null;
      if (!c.miss && Array.isArray(c.lines) && c.lines.length && age < 30 * 24 * 3600 * 1000) {
        return { lines: c.lines, trackName: c.trackName || '', artistName: c.artistName || '', duration: c.duration || 0 };
      }
    }
  } catch (e) {}
  const saveCache = (obj) => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(Object.assign({ ts: Date.now() }, obj)));
    } catch (e) {}
  };
  const meta = getCleanedMetadata();
  if (!meta.title) return null;
  const videoDur = (targetVideo && isFinite(targetVideo.duration)) ? targetVideo.duration : 0;
  const queries = [];
  if (meta.artist) {
    queries.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(meta.title)}&artist_name=${encodeURIComponent(meta.artist)}`);
    queries.push(`https://lrclib.net/api/search?q=${encodeURIComponent(meta.artist + ' ' + meta.title)}`);
  }
  queries.push(`https://lrclib.net/api/search?q=${encodeURIComponent(meta.title)}`);
  const normTitle = yti_normalizeForMatch(meta.title);
  const normArtist = yti_normalizeForMatch(meta.artist);
  for (const url of queries) {
    const text = await fetchViaBackground(url);
    if (!text) continue;
    let list = [];
    try {
      list = JSON.parse(text);
    } catch (e) {
      continue;
    }
    if (!Array.isArray(list)) continue;
    let best = null;
    let bestScore = 0;
    for (const item of list) {
      if (!item || !item.syncedLyrics) continue;
      let score = yti_diceSim(normTitle, yti_normalizeForMatch(item.trackName || ''));
      if (normArtist) {
        score = score * 0.7 + yti_diceSim(normArtist, yti_normalizeForMatch(item.artistName || '')) * 0.3;
      }
      if (videoDur > 30 && item.duration) {
        // 原曲がMVより長いことは通常ない（MVは映像パディングで曲より長い）
        if (item.duration > videoDur + 5) score -= 0.3;
        else score += Math.max(0, 0.15 - (Math.abs(videoDur - item.duration) / videoDur) * 0.3);
      }
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (best && bestScore >= 0.45) {
      const lines = parseLrcText(best.syncedLyrics);
      if (lines.length >= 4) {
        const result = {
          lines,
          trackName: best.trackName || meta.title,
          artistName: best.artistName || meta.artist,
          duration: best.duration || 0
        };
        saveCache(result);
        return result;
      }
    }
  }
  saveCache({ miss: true });
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
      return arr.filter(a => a && typeof a.lrcTime === 'number' && typeof a.videoTime === 'number')
        .sort((a, b) => a.lrcTime - b.lrcTime);
    }
  } catch (e) {}
  return [];
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
  const anchors = lyricsAnchors;
  const offsetAt = (t) => {
    if (!anchors.length) return 0;
    // 最初のアンカーより前の行にも先頭オフセット（=イントロ分）を適用する
    let off = anchors[0].videoTime - anchors[0].lrcTime;
    for (const a of anchors) {
      if (a.lrcTime <= t + 0.001) off = a.videoTime - a.lrcTime;
      else break;
    }
    return off;
  };
  const shifted = externalLyricsInfo.lines.map(l => ({
    time: Math.max(0, l.baseTime + offsetAt(l.baseTime)),
    baseTime: l.baseTime,
    text: l.text,
    el: null
  }));
  // アンカーの打ち間違いで時刻が逆行しても行順・ハイライトが壊れないよう単調化
  for (let i = 1; i < shifted.length; i++) {
    if (shifted[i].time < shifted[i - 1].time) shifted[i].time = shifted[i - 1].time + 0.01;
  }
  lyricsData = processRawLyricsToProcessed(shifted);
  const lyricsArea = document.getElementById('mv-lyrics-area');
  const rootContainer = document.getElementById('mv-root-container');
  if (rootContainer) rootContainer.classList.remove('no-lyrics-mode');
  if (lyricsArea) {
    lyricsArea.classList.remove('no-lyrics', 'fade-out');
    renderLyricsDOM(lyricsArea);
  }
  // アンカーで行時刻が変わったので、カラオケ用の単語タイミングも付け直す
  if (asrWordStream) attachKaraokeTiming(asrWordStream);
  try {
    syncLyrics();
  } catch (e) {}
}

// 「この行を今に合わせる」：この行以降のアンカーを張り替える（前半の同期は保持）
function addLyricsAnchorForLine(line) {
  if (!targetVideo || typeof line.baseTime !== 'number') return;
  lyricsAnchors = lyricsAnchors.filter(a => a.lrcTime < line.baseTime - 0.001);
  lyricsAnchors.push({ lrcTime: line.baseTime, videoTime: targetVideo.currentTime });
  lyricsAnchors.sort((a, b) => a.lrcTime - b.lrcTime);
  saveLyricsAnchors();
  applyExternalLyricsData();
  showToast('この行を現在の再生位置に同期しました');
}

// 全体を±deltaへ微調整（アンカーが無ければ先頭アンカーを新設）
function nudgeLyricsOffset(delta) {
  if (!lyricsAnchors.length) lyricsAnchors = [{ lrcTime: 0, videoTime: delta }];
  else lyricsAnchors = lyricsAnchors.map(a => ({ lrcTime: a.lrcTime, videoTime: a.videoTime + delta }));
  saveLyricsAnchors();
  applyExternalLyricsData();
  const off = lyricsAnchors[0].videoTime - lyricsAnchors[0].lrcTime;
  showToast(`オフセット: ${off >= 0 ? '+' : ''}${off.toFixed(1)}秒`);
}

// ===== ASRハイブリッド自動整合 =====
// ASR字幕は誤字だらけだがタイミングは実音声由来で正確。テキストはLRCLIB、
// 時計はASRから借りる：行同士をあいまい照合し、オフセットの階段を推定する。
function autoAlignWithAsr(lrcLines, asrSegs) {
  if (!lrcLines || lrcLines.length < 4 || !asrSegs || asrSegs.length < 4) return null;
  const asr = asrSegs
    .map(s => ({ time: s.time, norm: yti_normalizeForMatch(s.text) }))
    .filter(s => s.norm.length >= 2);
  if (asr.length < 4) return null;
  const cands = [];
  for (const line of lrcLines) {
    const norm = yti_normalizeForMatch(line.text);
    if (norm.length < 5) continue;
    let bestSim = 0;
    let bestTime = 0;
    for (let i = 0; i < asr.length; i++) {
      // ASRは行の切れ目がLRCとズレるため、隣接2セグメント連結も試す
      let sim = yti_diceSim(norm, asr[i].norm);
      if (i + 1 < asr.length) {
        const sim2 = yti_diceSim(norm, asr[i].norm + asr[i + 1].norm);
        if (sim2 > sim) sim = sim2;
      }
      if (sim > bestSim) {
        bestSim = sim;
        bestTime = asr[i].time;
      }
    }
    if (bestSim >= 0.55) {
      cands.push({ lrcTime: line.baseTime, videoTime: bestTime, delta: bestTime - line.baseTime });
    }
  }
  if (cands.length < 3) return null;
  cands.sort((a, b) => a.lrcTime - b.lrcTime);
  // オフセットの連続性（±2秒）で区間分け。単発の飛び値は捨てる。
  const groups = [];
  let cur = [cands[0]];
  for (let i = 1; i < cands.length; i++) {
    if (Math.abs(cands[i].delta - cur[cur.length - 1].delta) <= 2.0) cur.push(cands[i]);
    else {
      groups.push(cur);
      cur = [cands[i]];
    }
  }
  groups.push(cur);
  const solid = groups.filter(g => g.length >= 2);
  if (!solid.length) return null;
  // マッチの大半が安定区間に属していなければ照合自体を信用しない
  const covered = solid.reduce((n, g) => n + g.length, 0);
  if (covered < cands.length * 0.6) return null;
  const median = (arr) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const anchors = [];
  for (const g of solid) {
    const off = median(g.map(c => c.delta));
    // 直前の区間とオフセットがほぼ同じなら統合（間に飛び値があっただけ）
    if (anchors.length) {
      const prevOff = anchors[anchors.length - 1].videoTime - anchors[anchors.length - 1].lrcTime;
      if (Math.abs(prevOff - off) < 1.0) continue;
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
function updateKaraokeFill() {
  const root = document.getElementById('mv-root-container');
  if (!root) return;
  if (karaokeEnabledCache === null) karaokeEnabledCache = getMvOption('mv_karaoke', false);
  if (!karaokeEnabledCache) {
    if (root.classList.contains('karaoke-on')) root.classList.remove('karaoke-on');
    return;
  }
  if (!root.classList.contains('karaoke-on')) root.classList.add('karaoke-on');
  if (!targetVideo || !lyricsData || !lyricsData.length) return;
  const t = targetVideo.currentTime;
  let idx = -1;
  for (let i = 0; i < lyricsData.length; i++) {
    if (lyricsData[i].time <= t) idx = i;
    else break;
  }
  if (idx < 0) return;
  const line = lyricsData[idx];
  if (!line || line.isInstrumental) return;
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
  if (!getMvOption('mv_karaoke', false)) return;
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
  badge.textContent = `♪ ${externalLyricsInfo.trackName} — ${externalLyricsInfo.artistName}`;
  badge.title = 'LRCLIBから取得した外部歌詞です。ズレている場合は、今歌われている行の時計ボタンで同期できます';
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
  mkBtn('同期リセット', 'この動画の同期補正をすべて消去', () => {
    lyricsAnchors = [];
    saveLyricsAnchors();
    applyExternalLyricsData();
    showToast('同期をリセットしました');
  });
}

// 字幕が取れなかったときの外部歌詞フォールバック本体。
// 成功時は表示まで済ませて true を返す。呼び出し元は直後に世代チェックすること。
async function tryExternalLyricsFallback(videoId, lyricsArea, lyricsHeader, token, asrTrack) {
  if (!getMvOption('mv_external_lyrics', false)) return false;
  if (lyricsArea) {
    lyricsArea.classList.remove('no-lyrics', 'fade-out');
    lyricsArea.innerHTML = '<p style="color:rgba(255,255,255,0.3); font-size:20px; padding:20px;">外部データベースで歌詞を検索中...</p>';
  }
  const result = await fetchLrclibLyrics(videoId);
  if (token !== mvContentToken) return false;
  if (!result) return false;
  externalLyricsInfo = result;
  usingExternalLyrics = true;
  lyricsAnchors = loadLyricsAnchors(videoId);
  let autoAligned = false;
  // ASRの生レスポンスを1回だけ堅牢取得（キャッシュ→fetch→強制ロード横取り）し、
  // 行時計（自動整合）と単語時計（カラオケ塗り）の両方に使う
  if (asrTrack) {
    const asrRaw = await getAsrRawText(videoId, asrTrack, true);
    if (token !== mvContentToken) return false;
    if (asrRaw) {
      const words = parseCaptionWords(asrRaw);
      if (words && words.length >= 8) asrWordStream = words;
      // 保存済みの手動同期があればそれを優先。無ければASRの時計で自動整合を試みる。
      if (lyricsAnchors.length === 0) {
        const asrSegs = parseCaptionResponse(asrRaw);
        if (asrSegs && asrSegs.length) {
          const autoAnchors = autoAlignWithAsr(result.lines, asrSegs);
          if (autoAnchors && autoAnchors.length) {
            lyricsAnchors = autoAnchors;
            autoAligned = true;
          }
        }
      }
    }
  }
  loadedLyricsVideoId = videoId || '';
  currentLyricsLang = '';
  applyExternalLyricsData();
  buildExternalLyricsHeader(lyricsHeader);
  if (autoAligned) showToast('外部歌詞を自動生成字幕と自動同期しました');
  else if (lyricsAnchors.length) showToast('外部歌詞を表示中（保存済みの同期補正を適用）');
  else showToast('外部歌詞を表示中。ズレる場合は行の時計ボタンで同期できます');
  return true;
}

async function updateMVContent(retryCount = 0, token = null) {
  // 世代トークン：新しいロードが始まったら、進行中の古いチェーン（リトライ含む）は
  // ここで打ち切る。複数チェーンが同時にCCボタンを操作して両方失敗する競合を防ぐ。
  if (token === null) token = ++mvContentToken;
  if (token !== mvContentToken) return;
  const infoArea = document.getElementById('mv-info-area');
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
  isLyricSelectionMode = false;
  if (retryCount === 0) {
    if (infoArea) infoArea.innerHTML = '';
    if (lyricsArea) lyricsArea.innerHTML = '<p style="color:rgba(255,255,255,0.3); font-size:20px; padding:20px;">読み込み中...</p>';
    if (lyricsHeader) lyricsHeader.innerHTML = '';
    lyricsData = [];
    lyricsByLanguage = {};
    currentLyricsLang = '';
    usingExternalLyrics = false;
    externalLyricsInfo = null;
    lyricsAnchors = [];
    asrWordStream = null;
    if (rootContainer) rootContainer.classList.remove('no-lyrics-mode');
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
  if (isStaleResponse || !tracks || tracks.length === 0) {
    const maxRetry = isStaleResponse ? 10 : 5;
    if (retryCount < maxRetry) {
      setTimeout(() => updateMVContent(retryCount + 1, token), 1000);
      return;
    } else {
      // 字幕トラックが1本も無い動画：外部歌詞（LRCLIB）を探す
      const gotExternal = await tryExternalLyricsFallback(videoId, lyricsArea, lyricsHeader, token, null);
      if (token !== mvContentToken) return;
      if (!gotExternal && lyricsArea) {
        showNoLyrics(lyricsArea, '歌詞情報がありません');
      }
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
    if (!gotExternal && lyricsArea) {
      showNoLyrics(lyricsArea, '自動生成字幕のため非表示', { fontSize: '16px', opacity: '0.6' });
    }
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
    if (!gotExternal && lyricsArea) {
      showNoLyrics(lyricsArea, '歌詞の取得に失敗しました');
    }
    updateMetadataUI();
    try {
      updateSidebarContent(0);
    } catch (e) {}
    return;
  }
  lyricsData = mergeDualLyrics(newMainRaw, newSubRaw);
  loadedLyricsVideoId = videoId || '';
  currentLyricsLang = mainTrack.code;
  localStorage.setItem('mv_lyrics_lang_code', mainTrack.code);
  localStorage.setItem('mv_lyrics_sub_lang_code', subTrack ? subTrack.code : 'none');
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
        langBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> 全表示';
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
    copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
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
    selectBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
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
        selectBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 選択';
        copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 全コピー';
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
    lrcBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> LRC保存';
    lrcBtn.onclick = () => {
      downloadLrc();
    };
    lyricsHeader.appendChild(lrcBtn);
  }
  if (lyricsArea) renderLyricsDOM(lyricsArea);
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
  updateMetadataUI();
  try {
    updateSidebarContent(0);
  } catch (e) {}
}

function updateSidebarContent(retryCount = 0) {
  const listContainer = document.getElementById('mv-next-list');
  if (!listContainer) return;
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
      const card = document.createElement('a');
      card.className = 'mv-next-item';
      card.href = href;
      card.onclick = (e) => {};
      card.innerHTML = `
                <img src="${thumbSrc}" class="mv-next-item-thumb" loading="lazy" style="width: 110px; height: 62px; border-radius: 6px; object-fit: cover; background: #333; margin-right: 15px; flex-shrink: 0;">
                <div class="mv-next-info">
                    <div class="mv-next-title">${titleText}</div>
                    <div class="mv-next-artist">${artistText}</div>
                </div>
            `;
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
  const title = document.createElement('div');
  title.className = 'mv-settings-title';
  title.textContent = '表示オプション';
  panel.appendChild(title);
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
  panel.appendChild(makeToggle('字幕がない曲は外部歌詞を検索（Beta）', 'LRCLIBから同期歌詞を取得して表示します', 'mv_external_lyrics', false, () => {
    showToast('設定を変更しました');
    loadedLyricsVideoId = '';
    updateMVContent(0);
  }));
  panel.appendChild(makeToggle('カラオケ風ハイライト（Beta）', '歌に合わせて現在行を左から塗ります', 'mv_karaoke', false, (on) => {
    karaokeEnabledCache = on;
    showToast(on ? 'カラオケ風ハイライトをONにしました' : 'カラオケ風ハイライトをOFFにしました');
    // OFF中は単語タイミングを取得していないため、ONにしたら歌詞をロードし直して取得する
    if (on && !asrWordStream) {
      loadedLyricsVideoId = '';
      updateMVContent(0);
    }
  }));
  ['click', 'mousedown', 'mouseup'].forEach(evt => panel.addEventListener(evt, e => e.stopPropagation()));
  return panel;
}

function onUserAction(e) {
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
    idleTimer = setTimeout(() => {
      const ia = document.getElementById('mv-info-area');
      const settingsPanelEl = document.getElementById('mv-settings-panel');
      if (settingsPanelEl) settingsPanelEl.classList.remove('open');
      const elems = [document.getElementById('mv-info-area'), document.getElementById('mv-close-btn'), document.getElementById('mv-settings-btn'), document.getElementById('mv-shot-btn'), document.getElementById('mv-pin-btn'), document.getElementById('mv-lyrics-header'), document.getElementById('mv-record-btn'), document.getElementById('mv-glass-btn'), document.getElementById('mv-glass-slider-container'), document.getElementById('mv-pos-slider-container'), document.getElementById('mv-desktop-btn'), document.getElementById('mv-ambient-controls')];
      if (elems[0] && !isInfoPinned && !isTitleAlwaysOn) elems[0].classList.remove('visible');
      for (let i = 1; i < elems.length; i++) {
        if (elems[i]) elems[i].classList.remove('visible');
      }
      if (lyricsArea && lyricsArea.classList.contains('no-lyrics')) {
        lyricsArea.classList.add('fade-out');
      }
      if (posSliderContainer) {
        posSliderContainer.style.opacity = '0';
        posSliderContainer.style.pointerEvents = 'none';
      }
      if (rootContainer) {
        rootContainer.classList.add('hide-cursor');
      }
    }, 3000);
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

function syncLyrics() {
  if (!targetVideo) return;
  const currentTime = targetVideo.currentTime;
  const vinyl = document.getElementById('vinyl-record');
  const rightPane = document.querySelector('.rm-right-pane');
  if (vinyl && rightPane) {
    if (targetVideo.paused) {
      vinyl.classList.remove('spinning');
      rightPane.classList.remove('playing');
    } else {
      vinyl.classList.add('spinning');
      rightPane.classList.add('playing');
    }
  }
  let activeIndex = -1;
  for (let i = 0; i < lyricsData.length; i++) {
    if (lyricsData[i].time <= currentTime) activeIndex = i;
    else break;
  }
  let isInstrumental = false;
  if (activeIndex !== -1) {
    const currentLine = lyricsData[activeIndex];
    const nextLine = lyricsData[activeIndex + 1];
    if (currentLine.isInstrumental && currentLine.el) {
      const endTime = nextLine ? nextLine.time : currentLine.time + 5.0;
      const duration = endTime - currentLine.time;
      const elapsed = Math.max(0, currentTime - currentLine.time);
      
      
      let totalProgress = (elapsed / duration) * 3.0;
      
      const dots = currentLine.el.querySelectorAll('.instrumental-dot');
      dots.forEach((d, i) => {
        
        let dotProgress = Math.max(0.0, Math.min(1.0, totalProgress - i));
        d.style.setProperty('--dot-progress', dotProgress);
      });
    }
    const timeSinceStart = currentTime - currentLine.time;
    const timeToNext = nextLine ? (nextLine.time - currentTime) : 999;
    if (timeSinceStart > 5 && timeToNext > 5) isInstrumental = true;
    const gap = nextLine ? (nextLine.time - currentLine.time) : 0;
    if (gap > 10 && timeSinceStart > 8) isInstrumental = true;
  }
  if (activeIndex !== lastLyricIndex) {
    lastLyricIndex = activeIndex;
  }
  const lyricsArea = document.getElementById('mv-lyrics-area');
  const rmScroll = document.getElementById('rm-lyrics-scroll');
  lyricsData.forEach((line, index) => {
    const isActive = (index === activeIndex);
    if (line.el) {
      if (isActive) {
        // スクロール自体は startSmoothAutoScroll のrAFループが一元管理する。
        // ここで scrollTo すると毎フレームの直接代入と競合してガタつき・
        // スクロール不能の原因になるため、activeクラスの付与のみ行う。
        line.el.classList.add('active');
      } else {
        line.el.classList.remove('active');
      }
    }
    if (line.rmEl) {
      if (isActive) {
        line.rmEl.classList.add('active');
        if (rmScroll && rmScroll.parentElement) {
          const containerHeight = rmScroll.parentElement.clientHeight;
          const itemTop = line.rmEl.offsetTop;
          const itemHeight = line.rmEl.clientHeight;
          const offset = -(itemTop - containerHeight / 2 + itemHeight / 2 + 160);
          rmScroll.style.transform = `translateY(${offset}px)`;
        }
      } else {
        line.rmEl.classList.remove('active');
      }
    }
  });
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
        btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot';
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
      btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot';
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
let ipodPiPWindow = null;

function createIpodElement() {
  const container = document.createElement('div');
  container.id = 'ipod-pip-container';
  container.innerHTML = `
        <div class="ipod-chassis">
            <div class="ipod-screen-frame">
                <div class="ipod-screen">
                    <div class="ipod-screen-glass"></div>
                    <div class="ipod-header">
                        <span id="ipod-time-display">12:42 PM</span>
                        <span class="ipod-now-playing-label">Now Playing</span>
                        <div class="ipod-battery-icon"><div class="ipod-battery-level"></div></div>
                    </div>

                    <div class="ipod-video-stage" id="ipod-video-stage">
                        <div class="ipod-video-placeholder" id="ipod-video-placeholder">
                            <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                        </div>
                        <div class="ipod-np-overlay" id="ipod-np-overlay">
                            <div class="ipod-np-meta">
                                <div class="ipod-np-title" id="ipod-title">Now Playing</div>
                                <div class="ipod-np-artist" id="ipod-artist">YouTube</div>
                            </div>
                            <div class="ipod-scrubber-bar" id="ipod-scrubber">
                                <div class="ipod-scrubber-fill" id="ipod-scrubber-fill"></div>
                            </div>
                            <div class="ipod-time-labels">
                                <span id="ipod-current-time">0:00</span>
                                <span id="ipod-duration-time">-3:42</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="ipod-wheel-area">
                <div class="ipod-click-wheel" id="ipod-wheel">
                    <div class="wheel-label label-menu">MENU</div>
                    <div class="wheel-label label-next">
                        <svg class="wheel-icon" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                    </div>
                    <div class="wheel-label label-prev">
                        <svg class="wheel-icon" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                    </div>
                    <div class="wheel-label label-play">
                        <svg class="wheel-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        <svg class="wheel-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    </div>
                    <div class="ipod-center-btn" id="ipod-center-btn"></div>
                </div>
            </div>
        </div>
    `;
  return container;
}
async function enableIpodPiP() {
  if (!('documentPictureInPicture' in window)) {
    showToast("このブラウザはDesktop Modeに対応していません");
    return;
  }
  if (ipodPiPWindow) {
    ipodPiPWindow.close();
    return;
  }
  try {
    const ipodEl = createIpodElement();
    ipodPiPWindow = await documentPictureInPicture.requestWindow({
      width: 280,
      height: 450,
    });
    try {
      const cssUrl = chrome.runtime.getURL('style.css');
      const response = await fetch(cssUrl);
      const cssText = await response.text();
      const style = document.createElement('style');
      style.textContent = cssText;
      ipodPiPWindow.document.head.appendChild(style);
    } catch (e) {
      [...document.styleSheets].forEach((styleSheet) => {
        try {
          if (styleSheet.cssRules) {
            const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
            const style = document.createElement('style');
            style.textContent = cssRules;
            ipodPiPWindow.document.head.appendChild(style);
          } else if (styleSheet.href) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleSheet.href;
            ipodPiPWindow.document.head.appendChild(link);
          }
        } catch (ex) {}
      });
    }
    ipodPiPWindow.document.body.classList.add('ipod-pip-body');
    ipodPiPWindow.document.body.appendChild(ipodEl);
    // 実再生中の動画要素をそのまま iPod の画面内へ移動して、iPodの画面で
    // 動画が流れているように見せる（Document PiP の定石）。閉じる時に元へ戻す。
    const realVideo = targetVideo || document.querySelector('.video-stream.html5-main-video') || document.querySelector('video');
    let ipodReturnParent = null;
    let ipodReturnNext = null;
    let videoStyleBackup = null;
    const stage = ipodPiPWindow.document.getElementById('ipod-video-stage');
    if (stage && realVideo) {
      ipodReturnParent = realVideo.parentNode;
      ipodReturnNext = realVideo.nextSibling;
      videoStyleBackup = realVideo.getAttribute('style');
      realVideo.classList.add('ipod-live-video');
      const ph = ipodPiPWindow.document.getElementById('ipod-video-placeholder');
      if (ph) ph.style.display = 'none';
      stage.insertBefore(realVideo, stage.firstChild);
    }
    const restoreVideo = () => {
      try {
        if (!realVideo) return;
        realVideo.classList.remove('ipod-live-video');
        if (videoStyleBackup !== null) realVideo.setAttribute('style', videoStyleBackup);
        else realVideo.removeAttribute('style');
        if (ipodReturnParent) {
          if (ipodReturnNext && ipodReturnNext.parentNode === ipodReturnParent) {
            ipodReturnParent.insertBefore(realVideo, ipodReturnNext);
          } else {
            ipodReturnParent.appendChild(realVideo);
          }
        }
      } catch (e) {}
    };
    const syncData = () => {
      if (!ipodPiPWindow) return;
      const doc = ipodPiPWindow.document;
      const {
        title: cleanTitle,
        artist: cleanArtist
      } = getCleanedMetadata();
      const titleEl = doc.getElementById('ipod-title');
      if (titleEl) titleEl.innerText = cleanTitle || "Unknown";
      const artistEl = doc.getElementById('ipod-artist');
      if (artistEl) artistEl.innerText = cleanArtist || "YouTube";
      const video = realVideo || targetVideo || document.querySelector('video');
      if (video) {
        const cur = video.currentTime;
        const dur = video.duration;
        if (!isNaN(dur) && dur > 0) {
          const pct = (cur / dur) * 100;
          const fill = doc.getElementById('ipod-scrubber-fill');
          if (fill) fill.style.width = `${pct}%`;
          const curEl = doc.getElementById('ipod-current-time');
          if (curEl) curEl.innerText = formatTime(cur);
          const durEl = doc.getElementById('ipod-duration-time');
          if (durEl) durEl.innerText = "-" + formatTime(dur - cur);
        }
      }
      const now = new Date();
      const timeDisplay = doc.getElementById('ipod-time-display');
      if (timeDisplay) timeDisplay.innerText = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    };
    syncData();
    const syncInterval = setInterval(syncData, 1000);
    const doc = ipodPiPWindow.document;
    const getVideo = () => targetVideo || document.querySelector('video');
    const togglePlay = (e) => {
      e.stopPropagation();
      const v = getVideo();
      if (v) {
        if (v.paused) v.play();
        else v.pause();
      }
    };
    const centerBtn = doc.getElementById('ipod-center-btn');
    if (centerBtn) centerBtn.onclick = togglePlay;
    const playBtn = doc.querySelector('.label-play');
    if (playBtn) playBtn.onclick = togglePlay;
    const menuBtn = doc.querySelector('.label-menu');
    if (menuBtn) menuBtn.onclick = (e) => {
      e.stopPropagation();
      const v = getVideo();
      if (v) v.currentTime = 0;
    };
    const nextWheel = doc.querySelector('.label-next');
    if (nextWheel) nextWheel.onclick = (e) => {
      e.stopPropagation();
      const nextBtn = document.querySelector('.ytp-next-button');
      if (nextBtn) nextBtn.click();
    };
    const prevWheel = doc.querySelector('.label-prev');
    if (prevWheel) prevWheel.onclick = (e) => {
      e.stopPropagation();
      const prevBtn = document.querySelector('.ytp-prev-button');
      if (prevBtn) prevBtn.click();
    };
    const wheel = doc.getElementById('ipod-wheel');
    if (wheel) wheel.addEventListener('wheel', (e) => {
      const v = getVideo();
      if (!v) return;
      e.preventDefault();
      const delta = e.deltaY;
      let vol = v.volume;
      if (delta > 0) vol -= 0.05;
      else vol += 0.05;
      if (vol > 1) vol = 1;
      if (vol < 0) vol = 0;
      v.volume = vol;
    });
    ipodPiPWindow.addEventListener('pagehide', () => {
      clearInterval(syncInterval);
      restoreVideo();
      ipodPiPWindow = null;
    });
  } catch (err) {}
}

function formatTime(s) {
  if (isNaN(s)) return "0:00";
  if (s < 0) s = 0;
  const min = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${min}:${sec < 10 ? '0' + sec : sec}`;
}
let scrollFrameId = null;
let lastActiveEl = null;
let cachedTargetScroll = null;
let recalcTimer = null;

function startSmoothAutoScroll(container) {
  if (scrollFrameId) cancelAnimationFrame(scrollFrameId);
  // 手動スクロール（ホイール／タッチ）中は自動スクロールを一時停止し、
  // 少し経ったら現在の行へ戻る。従来は毎フレーム引き戻されて手動で読めなかった。
  if (!container._userScrollHooked) {
    container._userScrollHooked = true;
    const markUserScroll = () => {
      userScrollUntil = Date.now() + 2500;
    };
    container.addEventListener('wheel', markUserScroll, { passive: true });
    container.addEventListener('touchmove', markUserScroll, { passive: true });
  }
  const updateScroll = () => {
    // 例外が起きてもループを止めない（1度の例外で自動スクロールが死ぬのを防ぐ）
    try {
      // カラオケ塗りは timeupdate(約4Hz)では粗いため、このrAFループで毎フレーム更新する
      updateKaraokeFill();
      if (!container || !container.isConnected || isLyricSelectionMode ||
          container.classList.contains('selecting') || Date.now() < userScrollUntil) {
        scrollFrameId = requestAnimationFrame(updateScroll);
        return;
      }
      const activeEl = container.querySelector('.lyric-line-container.active');
      if (activeEl) {
        if (activeEl !== lastActiveEl) {
          const wasInstrumental = lastActiveEl && lastActiveEl.classList.contains('instrumental-line');
          const containerHeight = container.clientHeight;
          const elHeight = activeEl.clientHeight;

          cachedTargetScroll = activeEl.offsetTop - (containerHeight / 2) + (elHeight / 2);


          if (wasInstrumental) {
            if (recalcTimer) clearTimeout(recalcTimer);
            recalcTimer = setTimeout(() => {

              if (activeEl === container.querySelector('.lyric-line-container.active')) {
                cachedTargetScroll = activeEl.offsetTop - (containerHeight / 2) + (elHeight / 2);
              }
            }, 600);
          }
          lastActiveEl = activeEl;
        }
        if (cachedTargetScroll !== null) {
          const currentScrollTop = container.scrollTop;
          const diff = cachedTargetScroll - currentScrollTop;
          if (Math.abs(diff) > 0.5) {
            container.scrollTop = currentScrollTop + (diff * 0.25);
          }
        }
      }
    } catch (e) {}
    scrollFrameId = requestAnimationFrame(updateScroll);
  };
  updateScroll();
}

function stopSmoothAutoScroll() {
  if (scrollFrameId) {
    cancelAnimationFrame(scrollFrameId);
    scrollFrameId = null;
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
