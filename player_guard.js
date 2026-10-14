// ===== 長時間の連続再生で止まらないための見張り =====
// MV モードは YouTube の <video> を自前の全画面の入れ物へ移して表示している。そのため
// YouTube 自身の画面（広告のスキップボタン・「動画が一時停止されました。続きを視聴しますか？」
// の確認・シークバー）が見えなくなり、何時間も流しっぱなしにする使い方で黙って止まっていた。
// ここでは
//   1) 広告：広告中であることを出し、スキップできるようになったらボタンを出す（押すのはユーザー）。
//      広告の間は歌詞を進めない（広告の再生位置で歌詞が流れるのを防ぐ）。
//   2) 一時停止の確認：同じ確認を MV モードの中に出し、押したら YouTube の「はい」を押す。
//   3) 再生の操作：シーク・時間・前後の曲・音量を MV モードの下端に出す。
//   4) プレイヤーへの操作（字幕の強制切替・文字起こしパネル）を1本ずつに並べる。
//      失敗が続く時は、画面がちらつくだけの強制操作をしばらく止める。
// content.js の後に読み込む。

// ── 4) プレイヤー操作の直列化と、効かない操作の一時停止 ─────────────────
const ytiPlayerMutex = (() => {
  let chain = Promise.resolve();
  // 1本の動画の中では字幕の取り方を何通りも試すので、失敗は「動画ごと」に数える
  let failStreak = 0;
  let lastFailVideo = '';
  let disabledUntil = 0;
  return {
    // fn は Promise を返す。結果が空（null・空配列）なら失敗として数える。
    run(label, fn) {
      if (Date.now() < disabledUntil) return Promise.resolve(null);
      const task = chain.then(() => fn()).then((r) => {
        const empty = !r || (Array.isArray(r) && !r.length) || (typeof r === 'string' && !r);
        const vid = (typeof getVideoId === 'function' && getVideoId()) || '';
        if (empty) {
          if (vid !== lastFailVideo) {
            lastFailVideo = vid;
            failStreak++;
          }
          // 3本続けてどの方法でも取れなかった＝プレイヤーの仕組みが変わった。画面がちらつくだけなので止める
          if (failStreak >= 3) {
            disabledUntil = Date.now() + 15 * 60 * 1000;
            failStreak = 0;
            lastFailVideo = '';
            ytiTrace('', 'guard', '字幕の強制取得が3本続けて失敗したため15分止めます（' + label + '）');
          }
        } else {
          failStreak = 0;
          lastFailVideo = '';
        }
        return r;
      }).catch(() => null);
      chain = task.then(() => {}, () => {});
      return task;
    },
    isDisabled: () => Date.now() < disabledUntil,
  };
})();

// ── 取得の経過（どの段で取れたか・何秒かかったか）。歌詞の出典の上に出す ──────
const ytiTraceLog = [];
let ytiTraceVideo = '';
let ytiTraceStart = 0;
function ytiTrace(videoId, stage, detail) {
  const vid = videoId || (typeof getVideoId === 'function' ? getVideoId() : '');
  if (vid && vid !== ytiTraceVideo) {
    ytiTraceVideo = vid;
    ytiTraceLog.length = 0;
    ytiTraceStart = Date.now();
  }
  const sec = ((Date.now() - ytiTraceStart) / 1000).toFixed(1);
  ytiTraceLog.push(`${sec}s ${stage}: ${detail}`);
  if (ytiTraceLog.length > 30) ytiTraceLog.shift();
  try {
    console.debug('[YT Immersion] ' + stage + ': ' + detail);
  } catch (e) {}
}
function ytiTraceText() {
  return ytiTraceLog.join('\n');
}

// ── 1) 広告 ─────────────────────────────────────────────
let ytiAdActive = false;
function ytiSkipButton() {
  return document.querySelector('#movie_player .ytp-skip-ad-button, #movie_player .ytp-ad-skip-button-modern, #movie_player .ytp-ad-skip-button');
}
function ytiAdRemainingText() {
  const el = document.querySelector('#movie_player .ytp-ad-duration-remaining, #movie_player .ytp-ad-preview-text-modern, #movie_player .ytp-ad-preview-text');
  return el ? (el.textContent || '').trim() : '';
}
function ytiEnsureAdBar() {
  if (!rootContainer) return null;
  let bar = document.getElementById('yti-ad-bar');
  if (bar && bar.isConnected) return bar;
  bar = document.createElement('div');
  bar.id = 'yti-ad-bar';
  bar.innerHTML = '<span class="yti-ad-label">広告</span><span class="yti-ad-remain"></span><button class="yti-ad-skip" type="button">広告をスキップ</button>';
  bar.querySelector('.yti-ad-skip').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = ytiSkipButton();
    if (b) b.click();
  });
  rootContainer.appendChild(bar);
  return bar;
}
function ytiUpdateAdState() {
  const player = document.getElementById('movie_player');
  const ad = !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  if (ad !== ytiAdActive) {
    ytiAdActive = ad;
    if (rootContainer) rootContainer.classList.toggle('yti-ad', ad);
    if (!ad) {
      // 広告が終わったら本編の位置で歌詞を合わせ直す
      try {
        syncLyrics();
      } catch (e) {}
    }
  }
  if (ad && rootContainer) {
    const bar = ytiEnsureAdBar();
    if (bar) {
      bar.querySelector('.yti-ad-remain').textContent = ytiAdRemainingText();
      const skip = ytiSkipButton();
      const can = !!(skip && skip.offsetParent !== null);
      bar.querySelector('.yti-ad-skip').style.display = can ? '' : 'none';
    }
  }
}

// ── 2) 「続きを視聴しますか？」 ───────────────────────────────
function ytiFindContinueDialog() {
  const dlg = document.querySelector('ytd-popup-container tp-yt-paper-dialog:not([aria-hidden="true"]) yt-confirm-dialog-renderer');
  if (!dlg) return null;
  const host = dlg.closest('tp-yt-paper-dialog');
  if (host && (host.style.display === 'none' || host.getAttribute('aria-hidden') === 'true')) return null;
  const btn = dlg.querySelector('#confirm-button button, #confirm-button tp-yt-paper-button, yt-button-renderer#confirm-button button');
  return btn ? { dlg, btn, text: (dlg.querySelector('#text, yt-formatted-string#text') || {}).textContent || '' } : null;
}
function ytiUpdateContinuePrompt() {
  if (!rootContainer) return;
  const found = ytiFindContinueDialog();
  let box = document.getElementById('yti-continue');
  if (!found) {
    if (box) box.remove();
    return;
  }
  if (box) return;
  box = document.createElement('div');
  box.id = 'yti-continue';
  box.innerHTML = '<div class="yti-continue-text"></div><button type="button">続きを再生</button>';
  box.querySelector('.yti-continue-text').textContent = (found.text || '動画が一時停止されました。続きを視聴しますか？').trim();
  box.querySelector('button').addEventListener('click', (e) => {
    e.stopPropagation();
    const f = ytiFindContinueDialog();
    if (f) f.btn.click();
    box.remove();
    if (targetVideo && targetVideo.paused) targetVideo.play().catch(() => {});
  });
  rootContainer.appendChild(box);
}

// ── 3) 再生の操作 ───────────────────────────────────────────
function ytiFmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
const YTI_ICON = {
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>',
};
let ytiTransportDragging = false;
function ytiBuildTransport() {
  if (!rootContainer || document.getElementById('yti-transport')) return;
  const bar = document.createElement('div');
  bar.id = 'yti-transport';
  bar.innerHTML = `
    <button type="button" class="yti-tp-btn" data-act="prev" title="前の動画">${YTI_ICON.prev}</button>
    <button type="button" class="yti-tp-btn" data-act="play" title="再生／一時停止">${YTI_ICON.pause}</button>
    <button type="button" class="yti-tp-btn" data-act="next" title="次の動画">${YTI_ICON.next}</button>
    <span class="yti-tp-time">0:00</span>
    <input type="range" class="yti-tp-seek" min="0" max="1000" value="0" step="1" aria-label="再生位置">
    <span class="yti-tp-dur">0:00</span>
    <button type="button" class="yti-tp-btn" data-act="mute" title="ミュート">${YTI_ICON.vol}</button>
    <input type="range" class="yti-tp-vol" min="0" max="100" value="100" step="1" aria-label="音量">`;
  const seek = bar.querySelector('.yti-tp-seek');
  const vol = bar.querySelector('.yti-tp-vol');
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-act]');
    if (!b || !targetVideo) return;
    const act = b.dataset.act;
    if (act === 'play') {
      if (targetVideo.paused) targetVideo.play().catch(() => {});
      else targetVideo.pause();
    } else if (act === 'next') {
      const n = document.querySelector('#movie_player .ytp-next-button');
      if (n) n.click();
    } else if (act === 'prev') {
      // 曲の途中なら頭へ、頭なら前の動画へ（YouTube の前ボタンと同じ）
      const p = document.querySelector('#movie_player .ytp-prev-button');
      if (targetVideo.currentTime > 3 || !p || p.style.display === 'none') targetVideo.currentTime = 0;
      else p.click();
    } else if (act === 'mute') {
      targetVideo.muted = !targetVideo.muted;
    }
    ytiUpdateTransport();
  });
  seek.addEventListener('input', () => {
    ytiTransportDragging = true;
    if (targetVideo && isFinite(targetVideo.duration)) {
      bar.querySelector('.yti-tp-time').textContent = ytiFmtTime(targetVideo.duration * seek.value / 1000);
    }
  });
  seek.addEventListener('change', () => {
    ytiTransportDragging = false;
    if (targetVideo && isFinite(targetVideo.duration)) targetVideo.currentTime = targetVideo.duration * seek.value / 1000;
  });
  vol.addEventListener('input', () => {
    if (!targetVideo) return;
    targetVideo.volume = vol.value / 100;
    if (targetVideo.muted && vol.value > 0) targetVideo.muted = false;
    ytiUpdateTransport();
  });
  ['mousedown', 'mouseup', 'pointerdown'].forEach(t => bar.addEventListener(t, e => e.stopPropagation()));
  rootContainer.appendChild(bar);
  ytiUpdateTransport();
}
function ytiUpdateTransport() {
  const bar = document.getElementById('yti-transport');
  if (!bar || !targetVideo) return;
  const v = targetVideo;
  const playBtn = bar.querySelector('[data-act="play"]');
  const wantPlayIcon = v.paused ? 'play' : 'pause';
  if (playBtn.dataset.icon !== wantPlayIcon) {
    playBtn.innerHTML = YTI_ICON[wantPlayIcon];
    playBtn.dataset.icon = wantPlayIcon;
  }
  const muteBtn = bar.querySelector('[data-act="mute"]');
  const wantMute = (v.muted || v.volume === 0) ? 'mute' : 'vol';
  if (muteBtn.dataset.icon !== wantMute) {
    muteBtn.innerHTML = YTI_ICON[wantMute];
    muteBtn.dataset.icon = wantMute;
  }
  if (!ytiTransportDragging) {
    const d = v.duration;
    bar.querySelector('.yti-tp-time').textContent = ytiFmtTime(v.currentTime);
    bar.querySelector('.yti-tp-dur').textContent = ytiFmtTime(d);
    bar.querySelector('.yti-tp-seek').value = (isFinite(d) && d > 0) ? Math.round(v.currentTime / d * 1000) : 0;
  }
  const vol = bar.querySelector('.yti-tp-vol');
  const vv = Math.round((v.muted ? 0 : v.volume) * 100);
  if (Number(vol.value) !== vv) vol.value = vv;
  // 広告中は前後・シークを使わせない（広告の位置をシークしてしまう）
  bar.classList.toggle('yti-tp-ad', ytiAdActive);
}

// ── 見張りの本体（MV モードの間だけ 4 回／秒） ───────────────────────────
let ytiGuardTimer = null;
function ytiGuardTick() {
  if (!rootContainer || !rootContainer.isConnected) {
    clearInterval(ytiGuardTimer);
    ytiGuardTimer = null;
    ytiAdActive = false;
    return;
  }
  try {
    ytiUpdateAdState();
  } catch (e) {}
  try {
    ytiUpdateContinuePrompt();
  } catch (e) {}
  // 再生バーは実験的な機能（既定では出さない）
  if (typeof ytiExtrasEnabled === 'function' && ytiExtrasEnabled()) {
    try {
      ytiBuildTransport();
      ytiUpdateTransport();
    } catch (e) {}
  }
}
function ytiStartGuard() {
  if (ytiGuardTimer) return;
  ytiGuardTimer = setInterval(ytiGuardTick, 250);
  ytiGuardTick();
}
// content.js の startMVMode が入れ物を作った時に ytiStartGuard を呼ぶ。全画面の切り替えでも念のため
document.addEventListener('fullscreenchange', () => {
  if (document.getElementById('mv-root-container')) ytiStartGuard();
});

// ── 鍵盤：[ ] で歌詞全体を 0.5 秒ずつ合わせる（外部歌詞の時） ─────────────────
document.addEventListener('keydown', (e) => {
  if (!rootContainer || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if ((e.key === '[' || e.key === ']') && usingExternalLyrics) {
    nudgeLyricsOffset(e.key === '[' ? -0.5 : 0.5);
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
