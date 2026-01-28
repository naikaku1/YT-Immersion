document.addEventListener('yt-navigate-finish', onNavigate);

document.addEventListener('yt-page-data-updated', () => {
    if (rootContainer) {
        console.log("YouTube data updated. Refreshing UI...");

        setTimeout(() => {
            updateMetadataUI();
            updateMVContent(0);
            updateSidebarContent(0);
        }, 1200);
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
let idleTimer = null;
let buttonObserverTimer = null;
let isInfoPinned = localStorage.getItem('mv_pin_mode') === 'true';
let sidebarObserver = null;
let isInitialized = false;
let savedVolume = null;

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
    } catch (e) { console.error("Init error:", e); }
}

async function onNavigate() {

    if (rootContainer && sessionStorage.getItem('mv_mode_active') === 'true') {
        console.log("Navigated while in MV mode. Hot-swapping video...");

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

    const targetNode = document.querySelector('ytd-watch-next-secondary-results-renderer #items') ||
        document.querySelector('#secondary #items');

    if (!targetNode) {

        setTimeout(startSidebarObserver, 2000);
        return;
    }

    sidebarObserver = new MutationObserver(() => {

        updateSidebarContent(0);
    });

    sidebarObserver.observe(targetNode, { childList: true });

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
    } catch (e) { console.error("Button add error:", e); }
}

async function startMVMode(isAuto = false, isHotSwap = false) {

    if (rootContainer && !isHotSwap) return;

    const newTargetVideo = document.querySelector('.video-stream.html5-main-video') || document.querySelector('video');
    if (!newTargetVideo) { setTimeout(() => startMVMode(isAuto, isHotSwap), 1000); return; }

    sessionStorage.setItem('mv_mode_active', 'true');
    targetVideo = newTargetVideo;

    if (targetVideo && savedVolume === null) {
        savedVolume = targetVideo.volume;
    }

    try {
        if (!targetVideo.getAttribute('crossOrigin')) {
            targetVideo.setAttribute('crossOrigin', 'anonymous');
        }
    } catch (e) { }

    originalParent = targetVideo.parentNode;
    originalNextSibling = targetVideo.nextSibling;

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

            #mv-lyrics-area { position: absolute; bottom: 60px; right: 60px; width: 70vw; max-width: 1200px; height: 30vh; overflow-y: scroll; padding: 5vh 0 10vh 0; box-sizing: border-box; mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%); -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%); pointer-events: auto; text-align: right; scrollbar-width: none; -ms-overflow-style: none; transition: opacity 0.3s; }
            #mv-lyrics-area::-webkit-scrollbar { display: none; }
            .lyric-line-container { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; margin-bottom: 32px; position: relative; transform-origin: right center; transition: all 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94); }
            .lyric-line { font-size: 32px; font-weight: 700; color: rgba(255, 255, 255, 0.35); cursor: pointer; line-height: 1.5; font-feature-settings: "palt"; letter-spacing: 0.02em; white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; max-width: 100%; transition: color 0.5s, text-shadow 0.5s; }
            .lyric-line:hover { color: rgba(255,255,255,0.8); }
            .lyric-line-container.active .lyric-line { color: #fff; text-shadow: 0 0 30px rgba(255, 255, 255, 0.4); }
            .lyric-line-container.active { transform: scale(1.05) translateX(-20px); }
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
        `;
        rootContainer.appendChild(styleEl);

        const overlayContent = document.createElement('div');
        overlayContent.id = 'mv-overlay-content';
        overlayContent.innerHTML = `
            <div id="mv-center-status">
                <svg id="mv-icon-play" class="mv-status-svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                <svg id="mv-icon-pause" class="mv-status-svg" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </div>
            <div id="mv-info-area"></div>
            <div id="mv-lyrics-header"></div>
            <div id="mv-lyrics-area"></div>
            <button id="mv-pin-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg> 固定オフ</button>
            <button id="mv-close-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>

            <button id="mv-shot-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot</button>
            <button id="mv-desktop-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Mini Player</button>
            <div id="mv-glass-slider-container">
                <input type="range" id="mv-glass-slider" min="0" max="100" value="50">
            </div>
            <button id="mv-glass-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:16px;height:16px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" opacity="0.4"/><rect x="7" y="7" width="10" height="10" rx="2" ry="2" opacity="0.7"/></svg> Glass</button>
            <button id="mv-record-btn" class="mv-glass-btn"><svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg> Record</button>
            <div class="record-mode-layout">
                <div class="rm-left-pane">
                    <div class="rm-title" id="rm-song-title">Title</div>
                    <div class="rm-artist" id="rm-artist-name">Artist</div>
                    <div class="rm-lyrics-container"><div class="rm-lyrics-scroll" id="rm-lyrics-scroll"></div></div>
                </div>
                <div class="rm-right-pane">
                    <div class="vinyl-record" id="vinyl-record">
                        <div class="vinyl-label" id="vinyl-label"></div>
                    </div>

                    <div class="rm-tonearm-container">
                        <div class="arm-base"></div> <div class="arm-pipe"> <div class="arm-weight"></div> <div class="arm-headshell"></div> </div>
                    </div>
                </div>
            </div>
            <div id="mv-qr-overlay" style="display:none;"><div id="mv-qr-card"><h3>スマホでスキャン</h3><div id="qrcode"></div><p>同じWi-Fi推奨</p><button class="qr-close-btn" id="qr-close-action">閉じる</button></div></div>
        `;

        const closeBtn = overlayContent.querySelector('#mv-close-btn');
        if (closeBtn) closeBtn.onclick = () => endMVMode(false);
        const qrBtn = overlayContent.querySelector('#mv-qr-btn');

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
        } if (glassBtn) {
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
                e.stopPropagation();
                isInfoPinned = !isInfoPinned;

                localStorage.setItem('mv_pin_mode', isInfoPinned);

                if (isInfoPinned) {

                    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/><path d="M9 4h6v7.17l1.5 2.25V14h-9v-.58l1.5-2.25V4z" fill="currentColor"/></svg> 固定オン';
                    pinBtn.classList.add('active-pin');
                    document.getElementById('mv-info-area')?.classList.add('visible');
                } else {

                    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;margin-right:6px;fill:currentColor;"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg> 固定オフ';
                    pinBtn.classList.remove('active-pin');
                }
            };
        }

        const qrOverlay = overlayContent.querySelector('#mv-qr-overlay');
        const qrClose = overlayContent.querySelector('#qr-close-action');
        if (qrClose) qrClose.onclick = (e) => { e.stopPropagation(); if (qrOverlay) qrOverlay.style.display = 'none'; };

        const sidebarTrigger = document.createElement('div');
        sidebarTrigger.id = 'mv-sidebar-trigger';
        sidebarTrigger.onmouseenter = () => { document.getElementById('mv-sidebar')?.classList.add('visible'); };
        rootContainer.appendChild(sidebarTrigger);

        const sidebar = document.createElement('div');
        sidebar.id = 'mv-sidebar';
        sidebar.onmouseleave = () => { document.getElementById('mv-sidebar')?.classList.remove('visible'); };
        sidebar.innerHTML = '<h2>次はこちら</h2><div id="mv-next-list">読み込み中...</div>';
        rootContainer.appendChild(sidebar);

        rootContainer.appendChild(overlayContent);
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

    const playStatus = () => showCenterStatus('play');
    const pauseStatus = () => showCenterStatus('pause');
    targetVideo.addEventListener('play', playStatus);
    targetVideo.addEventListener('pause', pauseStatus);

    if (!isAuto && !isHotSwap) {
        rootContainer.requestFullscreen().catch(() => { });
    }

    try {
        updateMetadataUI();

        updateMVContent().catch(e => console.log("Content update warning:", e));
    } catch (e) { }

    startSidebarObserver();

    if (targetVideo.paused) targetVideo.play();
}

function endMVMode(keepActive = false) {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    document.removeEventListener('fullscreenchange', onFullscreenChange);

    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });

    if (rootContainer) {
        rootContainer.remove();
        rootContainer = null;
    }

    if (targetVideo && originalParent) {
        try {
            if (originalNextSibling && originalParent.contains(originalNextSibling)) {
                originalParent.insertBefore(targetVideo, originalNextSibling);
            } else {
                originalParent.appendChild(targetVideo);
            }
        } catch (e) { }
    }

    if (targetVideo) {
        targetVideo.removeEventListener('timeupdate', syncLyrics);

        if (savedVolume !== null) {
            targetVideo.volume = savedVolume;
            savedVolume = null;
        }
    }

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

        script.onload = function () { this.remove(); };

        const handler = (e) => {
            window.removeEventListener(eventId, handler);
            const data = e.detail || {};
            const active = data.active;
            const list = data.list || [];

            if (active) {

                const isActiveAsr = (active.kind === 'asr') || (active.vssId && active.vssId.startsWith('a.'));
                if (isActiveAsr) {
                    console.log("Active track is ASR:", active);
                    resolve(true);
                    return;
                }
            }

            if (list.length > 0) {
                const hasStandard = list.some(t => t.kind !== 'asr' && (!t.vssId || !t.vssId.startsWith('a.')));
                if (!hasStandard) {
                    console.log("No standard tracks found in list.");
                    resolve(true);
                    return;
                }
            }

            resolve(false);
        };

        window.addEventListener(eventId, handler, { once: true });
        (document.head || document.documentElement).appendChild(script);

        setTimeout(() => resolve(false), 1000);
    });
}

function getCleanedMetadata() {
    let rawTitle = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent.trim()
        || document.querySelector('#title h1')?.innerText
        || document.title.replace(' - YouTube', '')
        || "";
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
                rawArtist = Array.from(channelLinks)
                    .map(link => link.textContent.trim())
                    .filter(text => text.length > 0)
                    .filter((text, index, self) => self.indexOf(text) === index)
                    .join(' & ');
            }
        }
    }

    if (!rawArtist) {
        rawArtist = document.querySelector('#owner-name a')?.innerText || "";
    }

    const bracketMatch =
        rawTitle.match(/『(.*?)』/) ||
        rawTitle.match(/「(.*?)」/) ||
        rawTitle.match(/["'](.*?)["']/);

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

        songTitle = tempTitle
            .replace(/【.*?】/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/［.*?］/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/（.*?）/g, '')
            .replace(/Official\s*Music\s*Video/gi, '')
            .replace(/Music\s*Video/gi, '')
            .replace(/Official\s*Video/gi, '')
            .replace(/Official\s*MV/gi, '')
            .replace(/Special\s*Film/gi, '')
            .replace(/Performance\s*Video/gi, '')
            .replace(/MV/gi, '')
            .replace(/full/gi, '')
            .replace(/公式/g, '')
            .replace(/\//g, '')
            .trim()
            .replace(/^[\s\-:：]+|[\s\-:：]+$/g, '');

        const quoteCleanup = songTitle.match(/^["'](.*?)["']$/);
        if (quoteCleanup) {
            songTitle = quoteCleanup[1];
        }
    }

    let artistName = rawArtist
        .replace(/Official\s*Channel/gi, '')
        .replace(/Channel/gi, '')
        .replace(/チャンネル/g, '')
        .replace(/公式/g, '')
        .trim();

    return { title: songTitle, artist: artistName };
}

function updateMetadataUI() {
    const infoArea = document.getElementById('mv-info-area');

    const { title: songTitle, artist: artistName } = getCleanedMetadata();

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
    }
}

async function updateMVContent(retryCount = 0) {
    const infoArea = document.getElementById('mv-info-area');
    const lyricsArea = document.getElementById('mv-lyrics-area');
    const lyricsHeader = document.getElementById('mv-lyrics-header');

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

        const isAuto = await isOnlyAutoGeneratedCaptions();
        if (isAuto) {
            console.log("Auto-generated captions detected (API). Skipping.");
            if (lyricsArea) {
                lyricsArea.innerHTML = '<p class="no-lyrics-msg" style="font-size:16px; opacity:0.6;">自動生成字幕のため非表示</p>';
                lyricsArea.classList.add('no-lyrics');
            }
            updateMetadataUI();
            try { updateSidebarContent(0); } catch (e) { }
            return;
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    let segments = document.querySelectorAll('ytd-transcript-segment-renderer');

    if (segments.length === 0) {
        const buttons = document.querySelectorAll('button');
        let openTranscriptBtn = null;
        for (let btn of buttons) {
            if (btn.innerText.includes('文字起こし') || btn.getAttribute('aria-label')?.includes('文字起こし')) {
                openTranscriptBtn = btn; break;
            }
        }
        if (openTranscriptBtn) {
            openTranscriptBtn.click();
            await new Promise(r => setTimeout(r, 1500));
            segments = document.querySelectorAll('ytd-transcript-segment-renderer');
        }
    }

    if (segments.length === 0) {
        if (retryCount < 3) {
            setTimeout(() => updateMVContent(retryCount + 1), 1500);
            return;
        } else if (lyricsArea) {
            lyricsArea.innerHTML = '<p class="no-lyrics-msg">歌詞情報がありません</p>';
            lyricsArea.classList.add('no-lyrics');
            const timer = setTimeout(() => { if (lyricsArea) lyricsArea.classList.add('fade-out'); }, 5000);
            lyricsArea.onmouseenter = () => { clearTimeout(timer); lyricsArea.classList.remove('fade-out'); };
            lyricsArea.onmouseleave = () => { lyricsArea.classList.add('fade-out'); };
        }
    } else {
        const transcriptRenderer = document.querySelector('ytd-transcript-renderer');
        if (transcriptRenderer) {
            const panelText = transcriptRenderer.innerText;
            if (panelText.includes('自動生成') || panelText.includes('Auto-generated')) {
                const closeTranscriptBtn = document.querySelector('ytd-transcript-renderer button[aria-label="閉じる"]');
                if (closeTranscriptBtn) closeTranscriptBtn.click();
                if (lyricsArea) {
                    lyricsArea.innerHTML = '<p class="no-lyrics-msg" style="font-size:16px; opacity:0.6;">自動生成字幕のため非表示</p>';
                    lyricsArea.classList.add('no-lyrics');
                }
                updateMetadataUI();
                return;
            }
        }

        const closeTranscriptBtn = document.querySelector('ytd-transcript-renderer button[aria-label="閉じる"]');
        if (closeTranscriptBtn) closeTranscriptBtn.click();

        lyricsData = Array.from(segments).map(seg => {
            const timeStr = seg.querySelector('.segment-timestamp').textContent.trim();
            const text = seg.querySelector('.segment-text').textContent.trim();
            const parts = timeStr.split(':').map(Number);
            let seconds = 0;
            if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
            if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
            return { time: seconds, text: text, el: null };
        });

        if (lyricsHeader) {
            lyricsHeader.innerHTML = '';

            const langBtn = document.createElement('button');
            langBtn.className = 'mv-lyric-action-btn';
            langBtn.title = "歌詞の表示言語を切り替え";

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
        }
        if (lyricsArea) {
            lyricsArea.innerHTML = '';

            lyricsData.forEach((line, index) => {
                const container = document.createElement('div');
                container.className = 'lyric-line-container';

                const rmLine = document.createElement('div');
                rmLine.className = 'rm-lyric-line';
                line.rmEl = rmLine;

                const rawText = line.text;

                const segmentHasJapanese = !!rawText.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);

                let isOrphanRomaji = false;
                if (!segmentHasJapanese && index > 0) {
                    const prevLine = lyricsData[index - 1];
                    const prevHasJapanese = !!prevLine.text.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
                    const timeDiff = Math.abs(line.time - prevLine.time);
                    if (prevHasJapanese && timeDiff < 0.6) {
                        isOrphanRomaji = true;
                    }
                }

                const subLines = rawText.split(/\r\n|\n|\r/);

                subLines.forEach((subText) => {
                    if (!subText.trim()) return;

                    const textSpan = document.createElement('span');
                    textSpan.className = 'lyric-line';
                    textSpan.innerText = subText;

                    const hasJapanese = subText.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);
                    const hasHangul = subText.match(/[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/);

                    if (hasHangul) {
                        textSpan.classList.add('type-native');
                    } else if (hasJapanese) {
                        textSpan.classList.add('type-jp');
                    } else {
                        if ((segmentHasJapanese && !hasJapanese) || isOrphanRomaji) {
                            textSpan.classList.add('type-romaji');
                        } else {
                            textSpan.classList.add('type-eng');
                        }
                    }

                    container.appendChild(textSpan);

                    const rmSpan = document.createElement('span');
                    rmSpan.innerText = subText;
                    if (textSpan.classList.contains('type-native')) rmSpan.classList.add('type-native');
                    if (textSpan.classList.contains('type-jp')) rmSpan.classList.add('type-jp');
                    if (textSpan.classList.contains('type-romaji')) rmSpan.classList.add('type-romaji');
                    if (textSpan.classList.contains('type-eng')) rmSpan.classList.add('type-eng');
                    rmLine.appendChild(rmSpan);
                });

                line.el = container;

                container.onclick = (e) => {
                    if (isLyricSelectionMode) {
                        e.stopPropagation();
                        container.classList.toggle('selected');
                        const count = lyricsArea.querySelectorAll('.lyric-line-container.selected').length;
                        const copyBtn = lyricsHeader.querySelector('.mv-lyric-action-btn.primary');
                        if (copyBtn) copyBtn.innerHTML = `コピー (${count})`;
                    } else {
                        if (targetVideo) targetVideo.currentTime = line.time;
                    }
                };

                lyricsArea.appendChild(container);

                const rmScroll = document.getElementById('rm-lyrics-scroll');
                if (rmScroll) {
                    rmLine.onclick = (e) => { e.stopPropagation(); if (targetVideo) targetVideo.currentTime = line.time; };
                    rmScroll.appendChild(rmLine);
                }
            });
        }
    }
    updateMetadataUI();
    try { updateSidebarContent(0); } catch (e) { }
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

            card.onclick = (e) => {

            };

            card.innerHTML = `
                <img src="${thumbSrc}" class="mv-next-item-thumb" loading="lazy" style="width: 110px; height: 62px; border-radius: 6px; object-fit: cover; background: #333; margin-right: 15px; flex-shrink: 0;">
                <div class="mv-next-info">
                    <div class="mv-next-title">${titleText}</div>
                    <div class="mv-next-artist">${artistText}</div>
                </div>
            `;
            tempFragment.appendChild(card);
            count++;
        } catch (e) { }
    });

    listContainer.innerHTML = '';
    listContainer.appendChild(tempFragment);

    const sidebarTitle = document.querySelector('#mv-sidebar h2');
    if (sidebarTitle) sidebarTitle.innerText = (sourceMode === 'playlist') ? 'プレイリスト' : '次はこちら';
}

function onUserAction(e) {

    const infoArea = document.getElementById('mv-info-area');
    const closeBtn = document.getElementById('mv-close-btn');
    const qrBtn = document.getElementById('mv-qr-btn');
    const shotBtn = document.getElementById('mv-shot-btn');
    const pinBtn = document.getElementById('mv-pin-btn');
    const lyricsHeader = document.getElementById('mv-lyrics-header');
    const lyricsArea = document.getElementById('mv-lyrics-area');
    const recordBtn = document.getElementById('mv-record-btn');
    const glassBtn = document.getElementById('mv-glass-btn');
    const glassSlider = document.getElementById('mv-glass-slider-container');
    const desktopBtn = document.getElementById('mv-desktop-btn');

    const isRecordMode = rootContainer && rootContainer.classList.contains('record-mode');

    if (rootContainer) {
        rootContainer.classList.remove('hide-cursor');
    }

    if (infoArea) {
        infoArea.classList.add('visible');
        if (closeBtn) closeBtn.classList.add('visible');
        if (qrBtn) qrBtn.classList.add('visible');
        if (shotBtn) shotBtn.classList.add('visible');
        if (pinBtn) pinBtn.classList.add('visible');
        if (lyricsHeader) lyricsHeader.classList.add('visible');
        if (desktopBtn) desktopBtn.classList.add('visible');

        if (recordBtn) recordBtn.classList.add('visible');

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

            const elems = [
                document.getElementById('mv-info-area'),
                document.getElementById('mv-close-btn'),
                document.getElementById('mv-qr-btn'),
                document.getElementById('mv-shot-btn'),
                document.getElementById('mv-pin-btn'),
                document.getElementById('mv-lyrics-header'),
                document.getElementById('mv-record-btn'),
                document.getElementById('mv-glass-btn'),
                document.getElementById('mv-glass-slider-container'),
                document.getElementById('mv-desktop-btn')
            ];

            if (elems[0] && !isInfoPinned) elems[0].classList.remove('visible');

            for (let i = 1; i < elems.length; i++) {
                if (elems[i]) elems[i].classList.remove('visible');
            }

            if (lyricsArea && lyricsArea.classList.contains('no-lyrics')) {
                lyricsArea.classList.add('fade-out');
            }

            if (rootContainer) {
                rootContainer.classList.add('hide-cursor');
            }
        }, 3000);
    }

    if (e && e.type === 'click' && rootContainer) {
        const target = e.target;
        if (target.closest('button') ||
            target.closest('.mv-glass-btn') ||
            target.closest('#mv-pin-btn') ||
            target.closest('.mv-lyric-action-btn') ||
            target.closest('a') ||
            target.closest('.lyric-line') ||
            target.closest('#mv-sidebar') ||
            target.closest('#shot-result-overlay') ||
            target.closest('#shot-selector-overlay') ||
            target.closest('#mv-qr-overlay') ||
            target.closest('input[type="range"]')) {
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
        if (lyricsData[i].time <= currentTime) activeIndex = i; else break;
    }

    let isInstrumental = false;
    if (activeIndex !== -1) {
        const currentLine = lyricsData[activeIndex];
        const nextLine = lyricsData[activeIndex + 1];
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
                line.el.classList.add('active');

                if (lyricsArea && !isLyricSelectionMode) {

                    const containerHeight = lyricsArea.clientHeight;

                    const itemTop = line.el.offsetTop;
                    const itemHeight = line.el.clientHeight;

                    lyricsArea.scrollTo({
                        top: itemTop - containerHeight / 2 + itemHeight / 2,
                        behavior: 'smooth'
                    });
                }
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
    const video = document.querySelector('.video-stream.html5-main-video');
    if (!video) return;

    const isMVMode = !!document.getElementById('mv-root-container');
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
            if (isMVMode && btn) { btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot'; btn.style.background = ""; }
            return;
        }
    } catch (e) {

    }

    if (isMVMode && btn) btn.innerText = "高画質撮影中...";
    takeSingleScreenShot();
}

async function tryBurstCapture(video) {
    const wasPaused = video.paused;
    const currentTime = video.currentTime;
    const rewindTime = 0.5;

    if (currentTime > rewindTime) {
        video.currentTime = currentTime - rewindTime;
        await new Promise(r => setTimeout(r, 300));
    }

    if (video.paused) {
        try { await video.play(); } catch (e) { console.log("Play error", e); }
    }

    const frames = [];
    const captureDuration = 1000;
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < captureDuration) {

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            try {
                const d = ctx.getImageData(0, 0, 1, 1);
            } catch (e) {
                throw new Error("Canvas Tainted");
            }

            const score = calculateSharpness(ctx, canvas.width, canvas.height);
            frames.push({ canvas, score });

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

    return frames;
}

function showShotSelector(frames) {
    const old = document.getElementById('shot-selector-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'shot-selector-overlay';
    Object.assign(overlay.style, {
        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
        background: 'rgba(0,0,0,0.85)', zIndex: 2147483650,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(10px)',
        padding: '20px', boxSizing: 'border-box'
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
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px',
        width: '90%', maxWidth: '1000px', height: 'fit-content', paddingBottom: '20px'
    });

    const renderImages = (targetFrames) => {
        targetFrames.forEach(f => {
            const img = document.createElement('img');

            img.src = f.canvas.toDataURL('image/png');

            Object.assign(img.style, {
                width: '100%', aspectRatio: '16/9', objectFit: 'cover',
                cursor: 'pointer', borderRadius: '8px', border: '2px solid transparent',
                transition: 'transform 0.2s', background: '#000',
                opacity: '0', animation: 'fadeIn 0.3s forwards'
            });

            const style = document.createElement('style');
            style.textContent = `@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`;
            img.appendChild(style);

            img.onmouseenter = () => { img.style.transform = "scale(1.03)"; img.style.borderColor = "#fff"; };
            img.onmouseleave = () => { img.style.transform = "scale(1)"; img.style.borderColor = "transparent"; };

            img.onclick = (e) => {
                stopProp(e);
                selectedSnapshotCanvas = f.canvas;
                showChekiEditor();
                overlay.remove();
            };
            list.appendChild(img);
        });
    };

    renderImages(frames.slice(0, 6));

    listScrollArea.appendChild(list);
    overlay.appendChild(listScrollArea);

    const actionArea = document.createElement('div');
    Object.assign(actionArea.style, {
        marginTop: '15px', display: 'flex', gap: '15px', flexShrink: '0'
    });

    if (frames.length > 6) {
        const showAllBtn = document.createElement('button');
        showAllBtn.innerText = `すべて表示 (${frames.length}枚)`;
        showAllBtn.className = "mv-glass-btn";

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
    closeBtn.innerText = "キャンセル";
    closeBtn.className = "mv-glass-btn";
    closeBtn.style.background = "rgba(255, 50, 50, 0.4)";
    closeBtn.onclick = (e) => { stopProp(e); overlay.remove(); };
    actionArea.appendChild(closeBtn);

    overlay.appendChild(actionArea);

    getTargetContainer().appendChild(overlay);
}

async function tryBurstCapture(video) {
    const wasPaused = video.paused;
    const currentTime = video.currentTime;
    const rewindTime = 0.5;
    if (currentTime > rewindTime) video.currentTime = currentTime - rewindTime;
    if (video.paused) await video.play();

    const frames = [];
    const captureDuration = 1000;
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < captureDuration) {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            try { const d = ctx.getImageData(0, 0, 1, 1); } catch (e) { throw new Error("Canvas Tainted"); }

            const score = calculateSharpness(ctx, canvas.width, canvas.height);

            frames.push({ canvas, score });

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

    return frames;
}
async function takeSingleScreenShot() {
    const video = document.querySelector('.video-stream.html5-main-video');
    const btn = document.getElementById('mv-shot-btn');
    const wasPaused = video.paused;
    video.pause();

    const overlay = document.getElementById('mv-overlay-content');
    const sidebar = document.getElementById('mv-sidebar');
    if (overlay) overlay.style.display = 'none';
    if (sidebar) sidebar.style.display = 'none';

    await new Promise(r => setTimeout(r, 200));

    try {
        const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_CURRENT_TAB' });
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
        if (btn) { btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:17px;height:17px;margin-right:7px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Shot'; btn.style.background = ""; }
    }
}

function calculateSharpness(ctx, w, h) {
    const sampleW = 120;
    const sampleH = (h / w) * sampleW;
    const sc = document.createElement('canvas');
    sc.width = sampleW; sc.height = sampleH;
    const sCtx = sc.getContext('2d');
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
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0);

        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height).data;
        let top = 0;
        let bottom = tempCanvas.height;

        for (let y = 0; y < tempCanvas.height; y++) {
            let isBlackLine = true;
            for (let x = 0; x < tempCanvas.width; x += 20) {
                const i = (y * tempCanvas.width + x) * 4;
                if (imageData[i] > 25 || imageData[i + 1] > 25 || imageData[i + 2] > 25) {
                    isBlackLine = false; break;
                }
            }
            if (!isBlackLine) { top = y; break; }
        }

        for (let y = tempCanvas.height - 1; y >= 0; y--) {
            let isBlackLine = true;
            for (let x = 0; x < tempCanvas.width; x += 20) {
                const i = (y * tempCanvas.width + x) * 4;
                if (imageData[i] > 25 || imageData[i + 1] > 25 || imageData[i + 2] > 25) {
                    isBlackLine = false; break;
                }
            }
            if (!isBlackLine) { bottom = y; break; }
        }

        const croppedHeight = bottom - top;
        const detectedRatio = tempCanvas.width / croppedHeight;

        if (detectedRatio < 1.5 || detectedRatio > 3.0) {
            top = 0;
            bottom = tempCanvas.height;
            console.log("作品の暗転と判断し、カットをスキップしました");
        }

        const canvas = document.createElement('canvas');
        canvas.width = tempCanvas.width;
        canvas.height = bottom - top;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(tempCanvas, 0, top, tempCanvas.width, bottom - top, 0, 0, tempCanvas.width, bottom - top);

        selectedSnapshotCanvas = canvas;
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
        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
        background: 'rgba(0,0,0,0.85)', zIndex: 2147483650,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(10px)',
        padding: '20px', boxSizing: 'border-box'
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
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px',
        width: '90%', maxWidth: '1000px', height: 'fit-content', paddingBottom: '20px'
    });

    const renderImages = (targetFrames) => {
        targetFrames.forEach(f => {

            const img = document.createElement('img');

            img.src = f.canvas.toDataURL('image/png');

            Object.assign(img.style, {
                width: '100%', aspectRatio: '16/9', objectFit: 'cover',
                cursor: 'pointer', borderRadius: '8px', border: '2px solid transparent',
                transition: 'transform 0.2s', background: '#000',
                opacity: '0', animation: 'fadeIn 0.3s forwards'
            });

            const style = document.createElement('style');
            style.textContent = `@keyframes fadeIn { to { opacity: 1; } }`;
            img.appendChild(style);

            img.onmouseenter = () => { img.style.transform = "scale(1.03)"; img.style.borderColor = "#fff"; };
            img.onmouseleave = () => { img.style.transform = "scale(1)"; img.style.borderColor = "transparent"; };

            img.onclick = (e) => {
                stopProp(e);
                selectedSnapshotCanvas = f.canvas;
                showChekiEditor();
                overlay.remove();
            };
            list.appendChild(img);
        });
    };

    renderImages(frames.slice(0, 6));

    listScrollArea.appendChild(list);
    overlay.appendChild(listScrollArea);

    const actionArea = document.createElement('div');
    Object.assign(actionArea.style, {
        marginTop: '15px', display: 'flex', gap: '15px', flexShrink: '0'
    });

    if (frames.length > 6) {
        const showAllBtn = document.createElement('button');
        showAllBtn.innerText = `すべて表示 (${frames.length}枚)`;
        showAllBtn.className = "mv-glass-btn";

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
    closeBtn.innerText = "キャンセル";
    closeBtn.className = "mv-glass-btn";
    closeBtn.style.background = "rgba(255, 50, 50, 0.4)";
    closeBtn.onclick = (e) => { stopProp(e); overlay.remove(); };
    actionArea.appendChild(closeBtn);

    overlay.appendChild(actionArea);

    getTargetContainer().appendChild(overlay);
}

let isChekiRomajiHidden = false;
let selectedSnapshotCanvas = null;
let currentSelectedLyrics = [];

async function generateChekiCanvas(lyrics) {
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

    ctx.save();
    ctx.filter = 'blur(100px) brightness(0.5) saturate(1.4)';
    ctx.drawImage(selectedSnapshotCanvas, -200, -200, canvasW + 400, canvasH + 400);
    ctx.restore();

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
    ctx.beginPath();
    ctx.roundRect(margin, margin, imgW, imgH, 20);
    ctx.clip();
    ctx.drawImage(selectedSnapshotCanvas, margin, margin, imgW, imgH);
    ctx.restore();

    if (lyrics && lyrics.length > 0) {
        ctx.save();
        const lyFontSize = 38;
        ctx.font = `bold ${lyFontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Hiragino Sans", sans-serif`;
        ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        let lyX = margin + 50; let lyY = margin + imgH - 50;
        ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 12; ctx.fillStyle = "#ffffff";
        [...lyrics].reverse().forEach((line, i) => {
            ctx.fillText(line, lyX, lyY - (i * (lyFontSize * 1.5)));
        });
        ctx.restore();
    }

    const infoAreaTop = margin + imgH + 55;
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 52px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(songTitle, margin + 5, infoAreaTop);

    const subInfoY = infoAreaTop + 80;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "600 30px -apple-system, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(artistName, margin + 5, subInfoY);

    const d = new Date();
    const dateStr = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "300 22px monospace";
    ctx.textAlign = "right";
    ctx.fillText(dateStr, margin + imgW - 5, subInfoY + 8);

    return canvas;
}

function showChekiEditor() {
    if (!selectedSnapshotCanvas) return;
    currentSelectedLyrics = [];

    const old = document.getElementById('cheki-editor-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'cheki-editor-overlay';
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(evt => overlay.addEventListener(evt, stopProp));

    overlay.innerHTML = `
        <div class="cheki-container" onclick="event.stopPropagation()">
            <div class="cheki-preview-box">
                <img id="cheki-preview-img" class="cheki-preview-img" src="">
            </div>
            <div class="cheki-controls">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div class="cheki-group-title">🎵 歌詞トッピング</div>
                    <button id="cheki-romaji-toggle" class="mv-lyric-action-btn" style="padding: 2px 10px; font-weight:bold;">Aa</button>
                </div>
                <div class="cheki-lyrics-list" id="cheki-lyrics-list"></div>
                <div class="cheki-actions">
                    <button class="cheki-btn secondary" id="cheki-cancel-btn">キャンセル</button>
                    <button class="cheki-btn primary" id="cheki-create-btn">作成</button>
                </div>
            </div>
        </div>
    `;

    getTargetContainer().appendChild(overlay);

    const listContainer = document.getElementById('cheki-lyrics-list');
    const romajiToggle = document.getElementById('cheki-romaji-toggle');
    const hasJP = (text) => !!text.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/);

    const updatePreview = () => {
        generateChekiCanvas(currentSelectedLyrics).then(canvas => {
            const previewImg = document.getElementById('cheki-preview-img');
            if (previewImg) previewImg.src = canvas.toDataURL('image/png');
        });
    };

    const renderChekiLyrics = () => {
        listContainer.innerHTML = '';
        romajiToggle.style.background = isChekiRomajiHidden ? "#fff" : "rgba(20,20,20,0.6)";
        romajiToggle.style.color = isChekiRomajiHidden ? "#000" : "#fff";

        lyricsData.forEach((line) => {
            if (!line.text) return;
            const subLines = line.text.split(/\r\n|\n|\r/);
            subLines.forEach(subText => {
                const cleanText = subText.trim();
                if (!cleanText) return;
                if (isChekiRomajiHidden && !hasJP(cleanText)) return;

                const item = document.createElement('div');
                item.className = 'cheki-lyric-item';
                if (currentSelectedLyrics.includes(cleanText)) item.classList.add('selected');
                item.innerText = cleanText;

                item.onclick = (e) => {
                    stopProp(e);
                    if (currentSelectedLyrics.includes(cleanText)) {
                        currentSelectedLyrics = currentSelectedLyrics.filter(t => t !== cleanText);
                    } else {

                        if (currentSelectedLyrics.length >= 5) currentSelectedLyrics.shift();
                        currentSelectedLyrics.push(cleanText);
                    }
                    renderChekiLyrics();
                    updatePreview();
                };
                listContainer.appendChild(item);
            });
        });
    };

    romajiToggle.onclick = (e) => {
        stopProp(e);
        isChekiRomajiHidden = !isChekiRomajiHidden;
        if (isChekiRomajiHidden) {
            currentSelectedLyrics = currentSelectedLyrics.filter(text => hasJP(text));
        }
        renderChekiLyrics();
        updatePreview();
    };

    document.getElementById('cheki-cancel-btn').onclick = (e) => { stopProp(e); overlay.remove(); };
    document.getElementById('cheki-create-btn').onclick = (e) => {
        stopProp(e);
        generateChekiCanvas(currentSelectedLyrics).then(finalCanvas => {
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
        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
        background: 'rgba(0,0,0,0.92)', zIndex: 2147483660,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(15px)'
    });

    ['click', 'mousedown', 'mouseup'].forEach(evt => overlay.addEventListener(evt, stopProp));
    const dataUrl = canvas.toDataURL('image/png');

    overlay.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; max-width:90%;" onclick="event.stopPropagation()">
            <img src="${dataUrl}" style="max-height: 80vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);">
            <div class="result-row" style="margin-top:30px; display:flex; gap:15px;">
                <button class="mv-glass-btn" id="res-copy-btn">📋 コピー</button>
                <button class="mv-glass-btn" id="res-save-btn">💾 保存</button>
                <button class="mv-glass-btn" id="res-close-btn" style="background:rgba(255,255,255,0.1);">閉じる</button>
            </div>
        </div>
    `;

    getTargetContainer().appendChild(overlay);
    document.getElementById('res-close-btn').onclick = (e) => { stopProp(e); overlay.remove(); };
    document.getElementById('res-copy-btn').onclick = (e) => {
        stopProp(e);
        canvas.toBlob(blob => {
            const item = new ClipboardItem({ "image/png": blob });
            navigator.clipboard.write([item]).then(() => showToast("クリップボードにコピーしました"));
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
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.innerText = message;
    Object.assign(toast.style, {
        position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(255,255,255,0.95)', color: '#000', padding: '12px 28px',
        borderRadius: '30px', fontWeight: 'bold', zIndex: '2147483647',
        boxShadow: '0 8px 20px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.3s'
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
                        <div class="ipod-battery-icon"><div class="ipod-battery-level"></div></div>
                    </div>

                    <div class="ipod-content-split">
                        <div class="ipod-cover-art-large">
                            <div class="ipod-cover-placeholder">
                                <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                            </div>
                        </div>
                        <div class="ipod-info-side">
                            <div class="ipod-track-info">
                                <div class="ipod-text-title" id="ipod-title">Now Playing</div>
                                <div class="ipod-text-artist" id="ipod-artist">YouTube</div>
                                <div class="ipod-text-album" id="ipod-album">Immersion Mode</div>
                            </div>
                        </div>
                    </div>

                    <div class="ipod-progress-area">
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
            console.error("Failed to fetch style.css", e);

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
                } catch (ex) { }
            });
        }

        ipodPiPWindow.document.body.classList.add('ipod-pip-body');
        ipodPiPWindow.document.body.appendChild(ipodEl);

        const syncData = () => {
            if (!ipodPiPWindow) return;
            const doc = ipodPiPWindow.document;

            const { title: cleanTitle, artist: cleanArtist } = getCleanedMetadata();

            const titleEl = doc.getElementById('ipod-title');
            if (titleEl) titleEl.innerText = cleanTitle || "Unknown";

            const artistEl = doc.getElementById('ipod-artist');
            if (artistEl) artistEl.innerText = cleanArtist || "YouTube";

            const artContainer = doc.querySelector('.ipod-cover-art-large');
            if (artContainer) {

                let thumbUrl = null;
                try { thumbUrl = getHighResThumbnail(); } catch (e) { }

                if (!thumbUrl) {
                    thumbUrl = document.querySelector('meta[property="og:image"]')?.content;
                }

                if (thumbUrl) {

                    let img = artContainer.querySelector('img.ipod-real-art');
                    if (!img) {

                        artContainer.innerHTML = '';
                        img = doc.createElement('img');
                        img.className = 'ipod-real-art';

                        artContainer.appendChild(img);
                    }
                    if (img.src !== thumbUrl) img.src = thumbUrl;
                }
            }

            const video = targetVideo || document.querySelector('video');
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
            if (timeDisplay) timeDisplay.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
            ipodPiPWindow = null;
        });

    } catch (err) {
        console.error("Failed to open Desktop Mode:", err);
    }
}

function formatTime(s) {
    if (isNaN(s)) return "0:00";
    if (s < 0) s = 0;
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min}:${sec < 10 ? '0' + sec : sec}`;
}
