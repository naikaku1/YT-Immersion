---
title: "Chrome拡張でYouTubeの字幕を取る — timedtextが空ボディで返ってくる問題と対処"
emoji: "💬"
type: "tech"
topics: ["chrome拡張", "javascript", "youtube", "manifestv3"]
published: false
---

## 結論から

YouTube の字幕は `https://www.youtube.com/api/timedtext?v=...&lang=ja&fmt=json3` で取れます。が、拡張機能からこれを直接 `fetch` すると、**多くの環境で 200 OK かつ空ボディ**が返ってきます。`pot`（Proof of Origin Token）というセッション由来のパラメータが必須化されたためです。エラーで落ちてくれないので「なぜか字幕が空」という形で静かに壊れます。

トークンを自前で作るのは現実的ではないので、方針を変えます。**自分で作らず、プレイヤーが作ったものを使う。** 具体的にはこの4段構えです。

1. **パッシブ横取り** — プレイヤー自身の字幕通信を MAIN world で盗み見てキャッシュ
2. **直接 fetch** — まだ通る環境向けに残す
3. **セッションパラメータ移植** — 成功した通信から `pot` を借りて再 fetch
4. **強制ロード＋横取り** — プレイヤーに一瞬ロードさせて奪い、状態を戻す

---

## 前提：`fmt=json3` のレスポンス

```json
{
  "events": [
    {
      "tStartMs": 12340,
      "dDurationMs": 3200,
      "segs": [
        { "utf8": "こんにちは", "tOffsetMs": 0 },
        { "utf8": "世界",       "tOffsetMs": 620 }
      ]
    }
  ]
}
```

`segs[].tOffsetMs` は**単語単位**のオフセットで、自動生成字幕（ASR）にだけ付いてきます。あとで「このレスポンスは ASR か？」を判定するのに使えます。

`fmt` を付けないと XML（srv3）が返るので、パーサは両対応にしておくと安全です。

---

## 1. MAIN world で `fetch` / `XHR` を横取りする

Manifest V3 では content script の実行世界を `MAIN` に指定でき、ページ本体と同じ JS コンテキストに `document_start` で割り込めます。

```json
{
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/*"],
      "js": ["page_script.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://www.youtube.com/*"],
      "js": ["content.js"]
    }
  ]
}
```

`page_script.js` で `fetch` をラップし、`/api/timedtext` のレスポンスの**コピーだけ**を保存します。

```js
const origFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await origFetch.apply(this, args);
  try {
    const url = args[0]?.url ?? args[0];
    if (typeof url === 'string' && url.includes('/api/timedtext')) {
      // clone() なので公式側のボディは消費しない
      response.clone().text().then(text => cacheCaption(url, text)).catch(() => {});
    }
  } catch (_) {}
  return response;
};
```

`XMLHttpRequest` も同様に `open` で URL を控えて `load` で読みます。

**公式の通信を絶対に妨害しないこと**が設計上の要点です。`response.clone()` を使えば本体のストリームは消費されないので、プレイヤーの字幕表示は普段どおり動きます。リクエストを差し替えたりブロックしたりすると、原因追跡が一気に難しくなります。

キャッシュのキーは「動画ID → トラック識別子」の二段。トラック識別子は `lang` / `tlang`（自動翻訳）/ `name` の組み合わせにします。

```js
function parseTimedtext(url) {
  const u = new URL(url, location.href);
  if (!u.href.includes('/api/timedtext')) return null;
  const lang  = u.searchParams.get('lang')  || '';
  const tlang = u.searchParams.get('tlang') || '';
  const name  = u.searchParams.get('name')  || '';
  return {
    videoId: u.searchParams.get('v') || '__unknown__',
    lang, tlang, name,
    key: (lang || '__') + (tlang ? '|t:' + tlang : '') + (name ? '|n:' + name : '')
  };
}
```

保存時は **成功した通信の URL 自体**も残します。これが後で `pot` の「ドナー」になります。

```js
store[meta.videoId][meta.key] = { text, lang: meta.lang, tlang: meta.tlang, url: String(url) };
```

### MAIN ⇄ ISOLATED のブリッジ

拡張の本体ロジック（ISOLATED world）からは `window.__caption_cache__` を直接読めないので、`CustomEvent` でつなぎます。

```js
// MAIN 側：キャッシュした瞬間に通知（push）
window.dispatchEvent(new CustomEvent('CaptionData', {
  detail: JSON.stringify({ videoId, lang, tlang, key, url, text })
}));

// MAIN 側：「今までのぶんを全部くれ」にも答える（pull）
window.addEventListener('RequestCache', (e) => {
  const videoId = e.detail;
  const entries = (window.__caption_cache__ || {})[videoId] || {};
  window.dispatchEvent(new CustomEvent('CacheResponse', {
    detail: JSON.stringify({ videoId, entries })
  }));
});
```

**push だけでは足りません。** MAIN world は `document_start`、ISOLATED 側は `document_idle` 以降に動き出すので、その間に流れた通信は取りこぼします。「あとから全部取り出せる」pull 側を必ず用意してください。ここは実際にハマったところで、「たまに字幕が取れない」の正体でした。

---

## 2〜3. 直接 fetch と、`pot` の移植

キャッシュに無ければ素直に fetch を試します（環境によっては今も通ります）。ダメだったときに効くのが**セッションパラメータの移植**です。

「トラック A の取得には成功している＝有効な `pot` を含む URL が手元にある。ならその `pot` をトラック B の URL に移植すればいい」という発想です。`pot` はトラックごとではなくセッションに紐づくので、これが通ります。

```js
function graftSessionParams(baseUrl, donorUrl) {
  const dst = new URL(baseUrl,  location.href);
  const src = new URL(donorUrl, location.href);
  ['pot', 'potc', 'c', 'cver', 'cplayer',
   'cbr', 'cbrver', 'cos', 'cosver', 'cplatform'].forEach(p => {
    const v = src.searchParams.get(p);
    // baseUrl 側の署名パラメータは上書きしない。欠けているものだけ補う
    if (v !== null && !dst.searchParams.has(p)) dst.searchParams.set(p, v);
  });
  return dst.toString();
}
```

`!dst.searchParams.has(p)` が地味に重要です。`baseUrl`（player response に入っているトラック URL）には署名系パラメータが含まれており、donor 側で潰すと当然弾かれます。**足りないぶんだけ補う**のが正解です。

---

## 4. 最終手段：プレイヤーにロードさせて奪う

全滅したら、プレイヤー自身に取りに行かせて盗みます。MAIN world 側にプレイヤー API を叩くリスナーを置きます。

```js
window.addEventListener('ForceChangeTrack', (e) => {
  const player = document.getElementById('movie_player');
  player.toggleSubtitlesOn();
  const opt = JSON.parse(e.detail);   // { languageCode, kind: 'asr' }

  const applyTrack = (attempt) => {
    let target = opt;
    if (opt.kind === 'asr') {
      // 部分指定のままだと同言語の「手動字幕」が選ばれ、ASR がロードされない。
      // tracklist から実物のトラックオブジェクトを解決して渡す
      const list = player.getOption('captions', 'tracklist') || [];
      const m = list.find(t =>
        (t.kind === 'asr' || /^a\./.test(String(t.vss_id || t.vssId || ''))) &&
        (!opt.languageCode || t.languageCode === opt.languageCode));
      if (m) target = m;
      // 字幕モジュールのロード直後は tracklist が空のことがある
      else if (attempt < 5) return setTimeout(() => applyTrack(attempt + 1), 400);
    }
    player.setOption('captions', 'track', target);
  };
  applyTrack(0);
});
```

`{ languageCode: 'ja', kind: 'asr' }` のような**部分オブジェクトを渡しても ASR は選ばれません**。`tracklist` から実物を引いて渡す必要があり、しかもロード直後は空なのでリトライを噛ませます。

ISOLATED 側では横取りを待ちつつ、**CC の状態を必ず復元**します。

```js
function forceIntercept(videoId, track, restoreCode) {
  return new Promise((resolve) => {
    const ccBtn   = document.querySelector('.ytp-subtitles-button');
    const ccWasOn = ccBtn?.getAttribute('aria-pressed') === 'true';

    const finish = (result) => {
      window.removeEventListener('CaptionData', handler);
      clearTimeout(timeoutId);
      if (!ccWasOn && ccBtn?.getAttribute('aria-pressed') === 'true') {
        ccBtn.click();                    // 元が OFF なら OFF に戻す
      } else if (ccWasOn && restoreCode) {
        // 元が ON なら元の言語トラックへ戻す
        window.dispatchEvent(new CustomEvent('ForceChangeTrack', { detail: restoreCode }));
      }
      resolve(result);
    };

    const handler = (e) => {
      const d = JSON.parse(e.detail);
      if (!d?.text) return;
      if (videoId && d.videoId && d.videoId !== videoId) return; // 別動画の混入を弾く
      if (d.tlang) return;                                       // 自動翻訳は除外
      finish(d.text);
    };

    window.addEventListener('CaptionData', handler);
    const timeoutId = setTimeout(() => finish(null), 6000);
    window.dispatchEvent(new CustomEvent('ForceChangeTrack', {
      detail: JSON.stringify({ languageCode: track.code, kind: 'asr' })
    }));
  });
}
```

この復元処理は手を抜けません。`toggleSubtitlesOn()` で CC を ON のまま残すと、**YouTube がその字幕言語を記憶して、次以降の動画で勝手に外国語字幕や自動翻訳を出すようになります**。ユーザーの設定を汚染してしまうので、「元が OFF なら OFF に／元が ON なら元のトラックに戻す」までを 1 セットにします。

### 4段まとめ

```js
async function getCaptionText(videoId, track) {
  // 1) 横取りキャッシュ（ついでに pot ドナー URL を確保）
  await requestCacheFromPage(videoId);
  let donorUrl = '';
  for (const ent of Object.values(cache[videoId] || {})) {
    if (!ent?.text || ent.tlang) continue;
    if (ent.url?.includes('pot=')) donorUrl = ent.url;
    if (matchesTrack(ent, track)) return ent.text;
  }
  // 2) 直接 fetch
  let raw = await fetchRaw(track.baseUrl);
  if (raw) return raw;
  // 3) pot 移植 fetch
  if (donorUrl) {
    raw = await fetchRaw(graftSessionParams(track.baseUrl, donorUrl));
    if (raw) return raw;
  }
  // 4) 強制ロード＋横取り
  return await forceIntercept(videoId, track, restoreCode);
}
```

各段に `console.info` を仕込んでおくと、ユーザー環境で「どこまで到達して落ちたか」がすぐ分かります。これは入れておくのを強く勧めます。

---

## SPA という伏兵

YouTube は SPA なので、`ytInitialPlayerResponse` は**遷移後も前のページの内容のまま残ります**。これを無条件に使うと前の動画の字幕を掴みます。動画 ID で必ず検証してください。

```js
if (!renderer && typeof ytInitialPlayerResponse !== 'undefined') {
  const initId = ytInitialPlayerResponse?.videoDetails?.videoId || '';
  if (!urlVideoId || initId === urlVideoId) {
    renderer = ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer;
  }
}
```

同じ理由で、`player.getPlayerResponse()` の `videoDetails.videoId` が今の URL と食い違っている間は「まだ前の動画」なので、リトライして待ちます。

```js
const isStale = res.videoId && videoId && res.videoId !== videoId;
if (isStale || tracks.length === 0) {
  if (retryCount < (isStale ? 10 : 5)) {
    return setTimeout(() => load(retryCount + 1, token), 1000);
  }
  // ここまで来たら字幕なし確定
}
```

非同期処理の世代管理も必須です。動画を高速に切り替えると、古い取得チェーンが後から解決して新しい動画の表示を上書きします。トークンを発行して `token !== currentToken` なら破棄する、という定番の対処で潰せます。

---

## まとめ

- `timedtext` の直接 fetch は**エラーではなく空ボディ**で失敗する。静かに壊れるので気づきにくい
- 自前でトークンを作らず、**MAIN world でプレイヤーの通信を非破壊に横取りする**のが最も堅い
- 取れないときは、成功した URL から**セッションパラメータを移植**する／**プレイヤーに一瞬ロードさせて奪う**
- push 通知だけでなく、**あとからキャッシュを引ける pull 側のブリッジ**を必ず用意する
- 副作用を伴う手段（CC のトグル）は、**必ず元の状態に戻す**までを 1 セットにする
- SPA では `ytInitialPlayerResponse` も `getPlayerResponse()` も**前の動画のまま残る**。動画 ID で必ず検証する

同じところで詰まっている方の役に立てば幸いです。
