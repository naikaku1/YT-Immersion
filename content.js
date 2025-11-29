document.addEventListener('yt-navigate-finish', onNavigate);
window.addEventListener('load', init);

function init() {
    if (document.querySelector('.ytp-mv-mode-button')) return;
    const controlBar = document.querySelector('.ytp-right-controls');
    if (controlBar) {
        const btn = document.createElement('div');
        btn.className = 'ytp-button ytp-mv-mode-button';
        btn.innerText = 'MVモード';
        btn.onclick = startMVMode;
        controlBar.insertBefore(btn, controlBar.firstChild);
    }
}

// グローバル変数
let originalParent = null;
let originalNextSibling = null;
let targetVideo = null;
let rootContainer = null;
let lyricsData = [];
let idleTimer = null;

// 動画遷移時の処理
async function onNavigate() {
    init(); // ボタンが消えてたら復活

    // MVモード起動中でなければ何もしない
    if (!rootContainer) return;

    // MVモード中ならデータを更新する
    await updateMVContent();
}

async function startMVMode() {
    if (rootContainer) return;

    targetVideo = document.querySelector('video');
    if (!targetVideo) {
        alert("動画が見つかりません。");
        return;
    }

    // 動画移植
    originalParent = targetVideo.parentNode;
    originalNextSibling = targetVideo.nextSibling;

    rootContainer = document.createElement('div');
    rootContainer.id = 'mv-root-container';
    rootContainer.appendChild(targetVideo);

    const overlayContent = document.createElement('div');
    overlayContent.id = 'mv-overlay-content';
    
    // 曲情報エリア
    const infoArea = document.createElement('div');
    infoArea.id = 'mv-info-area';
    overlayContent.appendChild(infoArea);

    // 歌詞エリア
    const lyricsArea = document.createElement('div');
    lyricsArea.id = 'mv-lyrics-area';
    overlayContent.appendChild(lyricsArea);

    // 閉じるボタン
    const closeBtn = document.createElement('button');
    closeBtn.id = 'mv-close-btn';
    closeBtn.innerText = '閉じる';
    closeBtn.onclick = endMVMode;
    overlayContent.appendChild(closeBtn);

    rootContainer.appendChild(overlayContent);
    document.body.appendChild(rootContainer);

    // イベント登録
    targetVideo.addEventListener('timeupdate', syncLyrics);
    document.addEventListener('mousemove', onUserAction);
    document.addEventListener('click', onUserAction);

    // 再生・一時停止アニメーション用イベント
    targetVideo.addEventListener('play', onVideoPlay);
    targetVideo.addEventListener('pause', onVideoPause);

    // 画面クリックで再生/一時停止
    rootContainer.addEventListener('click', (e) => {
        if (e.target.closest('.lyric-line') || e.target.closest('#mv-close-btn')) {
            return;
        }
        if (targetVideo.paused) {
            targetVideo.play();
        } else {
            targetVideo.pause();
        }
    });

    onUserAction();

    // 全画面化
    rootContainer.requestFullscreen().catch(err => {});

    // コンテンツ読み込み開始
    await updateMVContent();

    if (targetVideo.paused) targetVideo.play();
}

// 歌詞とメタデータを取得して表示を更新する関数
async function updateMVContent() {
    const infoArea = document.getElementById('mv-info-area');
    const lyricsArea = document.getElementById('mv-lyrics-area');
    
    // 一旦クリア
    if(infoArea) infoArea.innerHTML = '';
    if(lyricsArea) lyricsArea.innerHTML = '<p style="color:#888; text-align:right; font-size:20px; padding:20px;">読み込み中...</p>';
    lyricsData = [];

    // YouTubeのデータ更新を少し待つ
    await new Promise(r => setTimeout(r, 1500));

    // 1. 歌詞データ取得
    let segments = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (segments.length === 0) {
        const buttons = document.querySelectorAll('button');
        let openTranscriptBtn = null;
        for (let btn of buttons) {
            if (btn.innerText.includes('文字起こし') || btn.getAttribute('aria-label')?.includes('文字起こし')) {
                openTranscriptBtn = btn;
                break;
            }
        }
        
        if (openTranscriptBtn) {
            openTranscriptBtn.click();
            await new Promise(r => setTimeout(r, 1500));
            segments = document.querySelectorAll('ytd-transcript-segment-renderer');
        }
    }

    if (segments.length === 0) {
        if(lyricsArea) lyricsArea.innerHTML = '<p style="color:#888; text-align:right; font-size:20px; padding:20px;">歌詞が見つかりませんでした</p>';
    } else {
        const closeTranscriptBtn = document.querySelector('ytd-transcript-renderer button[aria-label="閉じる"]');
        if(closeTranscriptBtn) closeTranscriptBtn.click();

        lyricsData = Array.from(segments).map(seg => {
            const timeStr = seg.querySelector('.segment-timestamp').textContent.trim();
            const text = seg.querySelector('.segment-text').textContent.trim();
            const parts = timeStr.split(':').map(Number);
            let seconds = 0;
            if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
            if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
            return { time: seconds, text: text, el: null };
        });

        if(lyricsArea) {
            lyricsArea.innerHTML = '';
            lyricsData.forEach(line => {
                const p = document.createElement('p');
                p.className = 'lyric-line';
                p.innerText = line.text;
                p.onclick = () => { if(targetVideo) targetVideo.currentTime = line.time; };
                lyricsArea.appendChild(p);
                line.el = p;
            });
        }
    }

    // 2. メタデータ取得 & 整形
    let rawTitle = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent.trim() || "";
    let songTitle = rawTitle;
    let rawArtist = document.querySelector('ytd-video-owner-renderer ytd-channel-name a')?.textContent.trim() || "";

    const bracketMatch = rawTitle.match(/『(.*?)』/);
    if (bracketMatch) {
        songTitle = bracketMatch[1];
    } else {
        songTitle = songTitle
            .replace(/【.*?】/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/Official\s*Music\s*Video/gi, '')
            .replace(/Music\s*Video/gi, '')
            .replace(/MV/gi, '')
            .replace(/full/gi, '')
            .replace(/公式/g, '')
            .replace(rawArtist, '')
            // 先頭に残ったハイフンや記号を削除
            .replace(/^[\s\-\/\|：:]+/, '') 
            .replace(/[\s\-\/\|：:]+$/, '')
            .trim();
    }

    let artistName = rawArtist
        .replace(/公式チャンネル/g, '')
        .replace(/公式/g, '')
        .replace(/Official\s*Channel/gi, '')
        .replace(/Official/gi, '')
        .replace(/Channel/gi, '')
        .trim();

    if(infoArea) {
        infoArea.innerHTML = `<h1 id="mv-song-title">${songTitle}</h1><p id="mv-artist-name">${artistName}</p>`;
    }
}

function endMVMode() {
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => {});
    }

    if (rootContainer) {
        rootContainer.remove();
        rootContainer = null;
    }
    if (targetVideo && originalParent) {
        if (originalNextSibling) {
            originalParent.insertBefore(targetVideo, originalNextSibling);
        } else {
            originalParent.appendChild(targetVideo);
        }
    }
    if (targetVideo) {
        targetVideo.removeEventListener('timeupdate', syncLyrics);
        targetVideo.removeEventListener('play', onVideoPlay);
        targetVideo.removeEventListener('pause', onVideoPause);
    }
    document.removeEventListener('mousemove', onUserAction);
    document.removeEventListener('click', onUserAction);
    targetVideo = null;
}

function onUserAction() {
    const infoArea = document.getElementById('mv-info-area');
    const closeBtn = document.getElementById('mv-close-btn');
    if(!infoArea || !rootContainer) return;

    infoArea.classList.add('visible');
    closeBtn.classList.add('visible');
    rootContainer.classList.remove('user-inactive');

    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        // コンテナが存在しない場合は何もしない（エラー対策）
        if (!rootContainer || !infoArea || !closeBtn) return;

        infoArea.classList.remove('visible');
        closeBtn.classList.remove('visible');
        rootContainer.classList.add('user-inactive');
    }, 3000);
}

function syncLyrics() {
    if(!targetVideo) return;
    const currentTime = targetVideo.currentTime;
    let activeIndex = -1;

    for (let i = 0; i < lyricsData.length; i++) {
        if (lyricsData[i].time <= currentTime) {
            activeIndex = i;
        } else {
            break;
        }
    }

    let isInstrumental = false;
    if (activeIndex !== -1) {
        const currentLine = lyricsData[activeIndex];
        const nextLine = lyricsData[activeIndex + 1];
        const timeSinceStart = currentTime - currentLine.time;
        const timeToNext = nextLine ? (nextLine.time - currentTime) : 0;

        if (timeSinceStart > 5 && timeToNext > 5) {
            isInstrumental = true;
        }
    }

    lyricsData.forEach((line, i) => {
        if (i === activeIndex && !isInstrumental) {
            if (!line.el.classList.contains('active')) {
                line.el.classList.add('active');
                line.el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        } else {
            line.el.classList.remove('active');
        }
    });
}

function onVideoPlay() {
    showBezelAnimation('play');
}

function onVideoPause() {
    showBezelAnimation('pause');
}

function showBezelAnimation(type) {
    if (!rootContainer) return;

    const oldBezel = document.querySelector('.mv-bezel-icon');
    if (oldBezel) oldBezel.remove();

    const bezel = document.createElement('div');
    bezel.className = 'mv-bezel-icon animate';

    let svgContent = '';
    if (type === 'play') {
        svgContent = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>';
    } else {
        svgContent = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>';
    }

    bezel.innerHTML = svgContent;
    rootContainer.appendChild(bezel);

    setTimeout(() => {
        if (bezel && bezel.parentNode) {
            bezel.remove();
        }
    }, 500);
}
