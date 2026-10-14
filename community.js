// ===== 同期・パート・応援法の共有 =====
// 同期の補正（どの行が動画の何秒か）・パート分け・応援法は、1人が付ければ同じ動画・同じ曲を見る
// 全員が使える。最初に見た人が合わせれば、2人目からは最初から合っている（使われるほど正確になる）。
// 共有するのは時刻・メンバー名・色・掛け声と、行の「指紋」（本文のハッシュ）だけ。歌詞の本文は送らない。
//
// 共有の手段は2つ:
//   1) 書き出し／読み込み（クリップボードの JSON）。サーバーが無くても、SNS や Discord で配れる。
//   2) 共有サーバー（設定で URL を入れた時だけ）。読み込みは自動、送信は「共有する」を ON にした時だけ。
//      GET  {url}/v1/videos/{videoId}  → 下の形の JSON（無ければ 404）
//      POST {url}/v1/videos/{videoId}  ← 同じ形の JSON
//      { v, videoId, songKey, provider, lyricsHash, anchors:[{lrcTime, videoTime, rate}], segments:[...],
//        parts:{ members:[{id,name,color}], lines:{lineKey:[id]} }, chants:{ clock, list:[{t,d,text}] } }
// content.js / lyrics_pipeline.js / parts.js / chants.js の後に読み込む。

const YTI_SHARE_URL_KEY = 'mv_share_url';
const YTI_SHARE_SEND_KEY = 'mv_share_send';

function ytiShareUrl() {
  const u = String(localStorage.getItem(YTI_SHARE_URL_KEY) || '').trim().replace(/\/+$/, '');
  return /^https:\/\//.test(u) ? u : '';
}

function ytiFetchJson(url, method, body) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_JSON', url, method, body }, (res) => {
        if (chrome.runtime.lastError || !res) resolve(null);
        else resolve(res);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// 今の動画のデータ（本文は含めない）
function ytiCollectShareData() {
  const videoId = getVideoId();
  const info = externalLyricsInfo;
  return {
    v: 1,
    videoId,
    songKey: (info && info.songKey) || ytiParts.songKey || '',
    provider: (info && info.provider) || 'caption',
    lyricsHash: info ? ytiLyricsHash(info) : '',
    // 手で合わせた・字幕照合の補正だけ（音声の推定は粗いので配らない）
    anchors: (lyricsAnchors || []).filter(a => a.src === 'manual' || a.src === 'asr')
      .map(a => ({ lrcTime: +a.lrcTime.toFixed(3), videoTime: +a.videoTime.toFixed(3), rate: a.rate || 1 })),
    // YouTube Music の公式の対応表（ログインしている人だけが取れる。未ログインの人に配ると効く）
    segments: (info && info.segments) || [],
    parts: { members: ytiParts.members, lines: ytiParts.lines },
    chants: { clock: ytiChants.clock, list: ytiChants.list },
  };
}

// 受け取ったデータを今の動画へ当てる。手元に自分の補正・パート・応援法があればそちらを優先する。
function ytiApplyShareData(d, opts) {
  if (!d || typeof d !== 'object') return 0;
  const force = !!(opts && opts.force);
  let applied = 0;
  const info = externalLyricsInfo;
  if (info && d.lyricsHash && d.lyricsHash === ytiLyricsHash(info)) {
    // 公式の対応表を持っていない（未ログイン）なら、共有された対応表を使う
    if (Array.isArray(d.segments) && d.segments.length && !(info.segments && info.segments.length) && info.timebase === 'song') {
      info.segments = YTICore.warp.normalizeSegments(d.segments);
      applied++;
    }
    const mine = anchorsSource(lyricsAnchors);
    if (Array.isArray(d.anchors) && d.anchors.length && (force || (mine !== 'manual' && mine !== 'asr'))) {
      lyricsAnchors = d.anchors.map(a => ({ lrcTime: Number(a.lrcTime), videoTime: Number(a.videoTime), rate: Number(a.rate) || 1, src: force ? 'manual' : 'shared', lh: d.lyricsHash }));
      saveLyricsAnchors();
      applied++;
    }
    if (applied) {
      ytiAudioSync.stop();
      applyExternalLyricsData();
    }
  }
  if (d.parts && Array.isArray(d.parts.members) && d.parts.lines && (force || !Object.keys(ytiParts.lines).length)) {
    ytiParts.members = d.parts.members;
    ytiParts.lines = d.parts.lines;
    ytiParts.source = 'shared';
    ytiPartsSave();
    ytiPartsApply();
    applied++;
  }
  if (d.chants && Array.isArray(d.chants.list) && d.chants.list.length && (force || !ytiChants.list.length) && d.chants.clock === ytiChants.clock) {
    ytiChants.list = d.chants.list;
    ytiChantsSave();
    ytiChantsStart();
    applied++;
  }
  return applied;
}

// ── 共有サーバー ─────────────────────────────────────────
let ytiShareLastSig = '';
async function ytiShareFetch(videoId, token) {
  const base = ytiShareUrl();
  if (!base || !videoId) return;
  const res = await ytiFetchJson(`${base}/v1/videos/${encodeURIComponent(videoId)}`, 'GET');
  if (token !== mvContentToken || !res || !res.success || !res.json) return;
  const n = ytiApplyShareData(res.json);
  if (n && typeof ytiTrace === 'function') ytiTrace(videoId, '共有', `${n}件のデータを使用`);
  ytiShareLastSig = JSON.stringify(ytiCollectShareData());
}
// 実験的な機能：既定では画面にも動作にも出さない（lyrics_pipeline.js の ytiExtrasEnabled）
if (ytiExtrasEnabled()) {
  // 自分で付けた補正・パート・応援法が変わったら送る（10秒ごとに確かめる）
  setInterval(async () => {
    const base = ytiShareUrl();
    if (!base || !getMvOption(YTI_SHARE_SEND_KEY, false) || !rootContainer) return;
    const d = ytiCollectShareData();
    if (!d.videoId || (!d.anchors.length && !Object.keys(d.parts.lines).length && !d.chants.list.length && !d.segments.length)) return;
    const sig = JSON.stringify(d);
    if (sig === ytiShareLastSig) return;
    ytiShareLastSig = sig;
    await ytiFetchJson(`${base}/v1/videos/${encodeURIComponent(d.videoId)}`, 'POST', d);
  }, 10000);

  ytiHooks.lyricsReady.push((videoId, token) => {
    ytiShareLastSig = '';
    // パート・応援法の読み込みを待ってから
    setTimeout(() => ytiShareFetch(videoId, token).catch(() => {}), 2500);
  });

  ytiHooks.settings.push((panel, makeToggle) => {
    const sec = document.createElement('div');
    sec.className = 'mv-settings-title';
    sec.textContent = '共有';
    panel.appendChild(sec);
    const row = document.createElement('div');
    row.className = 'mv-setting-row yti-share-row';
    row.innerHTML = '<div class="mv-setting-text"><span class="mv-setting-label">この動画の同期・パート・応援法</span>' +
      '<span class="mv-setting-desc">歌詞の本文は含みません。書き出した JSON を配れば、読み込んだ人の画面でもそのまま使えます</span></div>' +
      '<div class="yti-share-btns"><button type="button" class="mv-lyric-action-btn ex">書き出す</button><button type="button" class="mv-lyric-action-btn im">読み込む</button></div>';
    row.querySelector('.ex').onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(JSON.stringify(ytiCollectShareData())).then(() => showToast('クリップボードに書き出しました'));
    };
    row.querySelector('.im').onclick = async (e) => {
      e.stopPropagation();
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch (err) {}
      if (!text || text.trim().charAt(0) !== '{') text = prompt('書き出した JSON を貼り付けてください') || '';
      let d = null;
      try {
        d = JSON.parse(text);
      } catch (err) {}
      if (!d) {
        showToast('読み込めませんでした');
        return;
      }
      if (d.videoId && d.videoId !== getVideoId() && !(d.songKey && d.songKey === ytiParts.songKey)) {
        showToast('別の動画・曲のデータです');
        return;
      }
      const n = ytiApplyShareData(d, { force: true });
      showToast(n ? `${n}件のデータを読み込みました` : '当てはまるデータがありませんでした（歌詞の取得元が違う可能性があります）');
    };
    ['click', 'mousedown'].forEach(t => row.addEventListener(t, ev => ev.stopPropagation()));
    panel.appendChild(row);
    const urlRow = document.createElement('div');
    urlRow.className = 'mv-setting-row';
    urlRow.innerHTML = '<div class="mv-setting-text"><span class="mv-setting-label">共有サーバー（任意）</span>' +
      '<span class="mv-setting-desc">URL を入れると、この動画の共有データを自動で読み込みます（https のみ）</span></div>';
    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'mv-setting-select';
    input.placeholder = 'https://…';
    input.value = localStorage.getItem(YTI_SHARE_URL_KEY) || '';
    input.onchange = () => {
      localStorage.setItem(YTI_SHARE_URL_KEY, input.value.trim());
      showToast(ytiShareUrl() ? '共有サーバーを設定しました' : '共有サーバーを外しました');
    };
    ['click', 'mousedown', 'keydown'].forEach(t => input.addEventListener(t, ev => ev.stopPropagation()));
    urlRow.appendChild(input);
    panel.appendChild(urlRow);
    panel.appendChild(makeToggle('自分の補正・パート・応援法を共有サーバーへ送る', '時刻・メンバー名・色・掛け声と行の指紋だけを送ります（歌詞の本文は送りません）', YTI_SHARE_SEND_KEY, false));
  });
}
