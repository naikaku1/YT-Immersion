// ===== 応援法（응원법）・コール =====
// K-POP の応援法やアイドルのコールは、公式の応援法動画やカナルビのブログで覚えるもので、
// MV に重ねて出す道具が無かった。歌詞とは別の層として、掛け声を「いつ・何を」で持ち、
//   - その時刻に掛け声を大きく出す（直前は「まもなく」と残り時間を出す＝練習用）
//   - 見ながら「今の位置に追加」、または「0:42 OK!」のような時刻付きの文字をまとめて貼り付け
// できるようにする。時刻は曲の時計で持つので（外部歌詞の時）、MV・ステージ・ダンス練習で共通に使える。
// content.js / lyrics_pipeline.js の後に読み込む。

const YTI_CHANTS_SHOW_KEY = 'mv_chants_show';
const YTI_CHANT_LEAD = 2.0; // 何秒前から「まもなく」を出すか

const ytiChants = {
  videoId: '',
  key: '',
  clock: 'video',  // 'song'（外部歌詞の曲の時計）| 'video'
  list: [],        // [{ t, d, text }]（clock の時計）
  timer: null,
};

function ytiChantClock() {
  return (usingExternalLyrics && externalLyricsInfo && externalLyricsInfo.timebase === 'song' && ytiCurrentWarp) ? 'song' : 'video';
}
function ytiChantToVideo(t) {
  return (ytiChants.clock === 'song' && ytiCurrentWarp) ? ytiCurrentWarp.map(t).time : t;
}
function ytiVideoToChant(v) {
  return (ytiChants.clock === 'song' && ytiCurrentWarp) ? ytiCurrentWarp.inverse(v) : v;
}

async function ytiChantsLoad(videoId, token) {
  const clock = ytiChantClock();
  let key = 'chants:video:' + videoId;
  if (clock === 'song') {
    const { songKey } = await ytiSongAndArtistKey(videoId);
    if (songKey && !songKey.startsWith('video:')) key = 'chants:' + songKey;
  }
  if (token !== mvContentToken) return;
  Object.assign(ytiChants, { videoId, key, clock: key.startsWith('chants:video:') ? 'video' : 'song', list: [] });
  const saved = await ytiStoreGet(key);
  if (saved && Array.isArray(saved.list)) ytiChants.list = saved.list;
  ytiChantsStart();
}
function ytiChantsSave() {
  ytiChants.list.sort((a, b) => a.t - b.t);
  if (ytiChants.key) ytiStoreSet(ytiChants.key, { at: Date.now(), clock: ytiChants.clock, list: ytiChants.list });
}

// 「0:42 OK!」「[01:02.50] 김민지!」「1:05-1:08 사랑해」のような行をまとめて読む
function ytiParseChantText(text) {
  const out = [];
  const re = /^\s*\[?(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]?(?:\s*[-~〜]\s*\[?(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]?)?\s+(.+)$/;
  const sec = (m, s, f) => Number(m) * 60 + Number(s) + (f ? Number(('0.' + f)) : 0);
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(re);
    if (!m) continue;
    const t = sec(m[1], m[2], m[3]);
    const end = m[4] ? sec(m[4], m[5], m[6]) : null;
    out.push({ t, d: end && end > t ? end - t : 1.5, text: m[7].trim() });
  }
  return out;
}

// ── 表示 ───────────────────────────────────────────────
function ytiChantEl() {
  let el = document.getElementById('yti-chant');
  if (el && el.isConnected) return el;
  if (!rootContainer) return null;
  el = document.createElement('div');
  el.id = 'yti-chant';
  el.innerHTML = '<div class="yti-chant-soon"><span class="lbl">まもなく</span><span class="txt"></span><span class="bar"><i></i></span></div><div class="yti-chant-now"></div>';
  rootContainer.appendChild(el);
  return el;
}
function ytiChantsTick() {
  if (!rootContainer || !targetVideo || !ytiChants.list.length || !getMvOption(YTI_CHANTS_SHOW_KEY, true)) {
    const el = document.getElementById('yti-chant');
    if (el) el.classList.remove('now', 'soon');
    return;
  }
  if (typeof ytiAdActive !== 'undefined' && ytiAdActive) return;
  const v = targetVideo.currentTime;
  let now = null;
  let soon = null;
  for (const c of ytiChants.list) {
    const s = ytiChantToVideo(c.t);
    if (v >= s && v < s + (c.d || 1.5)) now = c;
    else if (s > v && s - v <= YTI_CHANT_LEAD && !soon) soon = { c, left: s - v };
  }
  const el = ytiChantEl();
  if (!el) return;
  el.classList.toggle('now', !!now);
  el.classList.toggle('soon', !!soon && !now);
  if (now) {
    const n = el.querySelector('.yti-chant-now');
    if (n.textContent !== now.text) n.textContent = now.text;
  }
  if (soon && !now) {
    const t = el.querySelector('.yti-chant-soon .txt');
    if (t.textContent !== soon.c.text) t.textContent = soon.c.text;
    el.querySelector('.yti-chant-soon .bar i').style.transform = `scaleX(${(1 - soon.left / YTI_CHANT_LEAD).toFixed(3)})`;
  }
}
function ytiChantsStart() {
  if (ytiChants.timer) return;
  ytiChants.timer = setInterval(() => {
    if (!rootContainer || !rootContainer.isConnected) {
      clearInterval(ytiChants.timer);
      ytiChants.timer = null;
      return;
    }
    ytiChantsTick();
  }, 80);
}

// ── 編集パネル ─────────────────────────────────────────────
function ytiFmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}
function ytiChantsPanel(open) {
  let p = document.getElementById('yti-chant-panel');
  if (!open) {
    if (p) p.remove();
    return;
  }
  if (!rootContainer) return;
  if (!p) {
    p = document.createElement('div');
    p.id = 'yti-chant-panel';
    ['click', 'mousedown', 'pointerdown', 'keydown'].forEach(t => p.addEventListener(t, e => e.stopPropagation()));
    rootContainer.appendChild(p);
  }
  p.innerHTML = `
    <div class="hd">応援法・コール <span class="sub"></span><button type="button" class="x" title="閉じる">×</button></div>
    <div class="add"><input type="text" class="tx" placeholder="掛け声（例：김민지! / オイ！）"><button type="button" class="now">今の位置に追加</button></div>
    <div class="list"></div>
    <details><summary>時刻付きの文字をまとめて貼り付け</summary>
      <textarea class="bulk" placeholder="0:42 OK!&#10;1:05-1:08 사랑해&#10;[01:30.50] 김민지!"></textarea>
      <div class="row"><label><input type="checkbox" class="songclk"> 時刻は「曲（音源）」の時刻</label><button type="button" class="imp">追加</button></div>
    </details>`;
  p.querySelector('.sub').textContent = ytiChants.clock === 'song' ? '（曲に保存：他の動画でも出ます）' : '（この動画に保存）';
  p.querySelector('.x').onclick = () => ytiChantsPanel(false);
  const tx = p.querySelector('.tx');
  p.querySelector('.now').onclick = () => {
    const text = tx.value.trim();
    if (!text || !targetVideo) return;
    ytiChants.list.push({ t: Math.max(0, ytiVideoToChant(targetVideo.currentTime) - 0.15), d: 1.5, text });
    tx.value = '';
    ytiChantsSave();
    ytiChantsPanel(true);
    ytiChantsStart();
  };
  tx.onkeydown = (e) => {
    if (e.key === 'Enter') p.querySelector('.now').click();
  };
  const songclk = p.querySelector('.songclk');
  songclk.checked = ytiChants.clock === 'song';
  songclk.disabled = ytiChants.clock !== 'song';
  p.querySelector('.imp').onclick = () => {
    const items = ytiParseChantText(p.querySelector('.bulk').value);
    if (!items.length) {
      showToast('「0:42 掛け声」の形の行が見つかりません');
      return;
    }
    // 動画の時刻で書かれていれば曲の時計へ直して保存する
    for (const it of items) {
      if (ytiChants.clock === 'song' && !songclk.checked) it.t = ytiVideoToChant(it.t);
      ytiChants.list.push(it);
    }
    ytiChantsSave();
    showToast(`${items.length}件の掛け声を追加しました`);
    ytiChantsPanel(true);
    ytiChantsStart();
  };
  const list = p.querySelector('.list');
  ytiChants.list.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'it';
    const vt = ytiChantToVideo(c.t);
    row.innerHTML = '<button type="button" class="tm"></button><span class="tt"></span><button type="button" class="del" title="削除">削除</button>';
    row.querySelector('.tm').textContent = ytiFmt(vt);
    row.querySelector('.tm').onclick = () => {
      if (targetVideo) targetVideo.currentTime = Math.max(0, vt - YTI_CHANT_LEAD);
    };
    row.querySelector('.tt').textContent = c.text;
    row.querySelector('.del').onclick = () => {
      ytiChants.list.splice(i, 1);
      ytiChantsSave();
      ytiChantsPanel(true);
    };
    list.appendChild(row);
  });
  if (!ytiChants.list.length) list.textContent = 'まだ掛け声がありません';
}

// 実験的な機能：既定では画面にも動作にも出さない（lyrics_pipeline.js の ytiExtrasEnabled）
if (ytiExtrasEnabled()) {
  function ytiChantsEnsureHeaderButton() {
    const header = document.getElementById('mv-lyrics-header');
    if (!header || header.querySelector('.yti-chant-btn')) return;
    const b = document.createElement('button');
    b.className = 'mv-lyric-action-btn yti-chant-btn';
    b.textContent = '応援法';
    b.title = '応援法・コールの表示と編集';
    b.onclick = (e) => {
      e.stopPropagation();
      ytiChantsPanel(!document.getElementById('yti-chant-panel'));
    };
    header.appendChild(b);
  }
  setInterval(() => {
    if (rootContainer && ytiChants.videoId) ytiChantsEnsureHeaderButton();
  }, 1000);

  ytiHooks.lyricsReady.push((videoId, token) => {
    ytiChantsLoad(videoId, token).catch(() => {});
  });
  ytiHooks.settings.push((panel, makeToggle) => {
    panel.appendChild(makeToggle('応援法・コールを表示', '掛け声の時刻に大きく出し、直前は「まもなく」で知らせます。ヘッダーの「応援法」で追加できます', YTI_CHANTS_SHOW_KEY, true, () => ytiChantsTick()));
  });
}
