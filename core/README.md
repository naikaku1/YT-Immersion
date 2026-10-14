# core/ — YT-Immersion と YTM-Immersion の共通コア

歌詞まわりの「計算」だけを集めた、DOM にも拡張機能の API にも触れないモジュール群です。
content script・Service Worker（`importScripts`）・Node（テスト）のどこからでも読み込めます。
読み込むと `globalThis.YTICore` の下に入ります。

| ファイル | 中身 |
|---|---|
| `text.js` | 照合用の正規化、Dice 係数、曲名・アーティストの候補採点、クレジット行の除去、取得元どうしの本文の突き合わせ（`judgeLyrics` / `pickAgreedLyrics`） |
| `parsers.js` | LRC（拡張 LRC の語タグ）/ NetEase yrc / Lyricify lys / Apple TTML（ハモリ）/ KuGou krc（復号）/ LyricsPlus JSON / YouTube Music の時刻付き歌詞 / 字幕 json3（文字色）→ 共通の行の形 |
| `warp.js` | 曲の時計 → 動画の時計。YouTube Music の segmentMap（公式の曲⇔動画の対応表）＋対応点（段差・速度）。動画で切られた区間の行を隠す |
| `align.js` | 歌詞と自動生成字幕（ASR）の文字単位の突き合わせ。一致率（この動画の歌詞かの判定）・対応点・文字ごとの時刻（語単位の塗り） |
| `pairing.js` | 原文と訳の行の組み合わせ（時間の重なり・順序を保つ・割れた訳をつなぐ） |
| `kana.js` | かな ⇔ ローマ字、歌われた音（ローマ字）からの漢字のふりがな |

行の形（時刻はすべて秒）:

```js
{ start, end?, text, words?: [{ t, end?, c }], bg?: { start, end?, text, words }, agent? }
```

## テスト

```bash
node --test tests/*.test.mjs
```

## YTM-Immersion へ持っていく

`tools/sync-core.sh <YTM-Immersion のパス>` で `src/js/core/` へ写せます。
YTM-Immersion 側では、content script の先頭（または background の `importScripts`）に読み込みを足すと、
`YTICore.parsers.parseYrc(...)` のように使えます。YTM-Immersion の `extra-providers.js` /
`lyrics-agreement.js` と同じ読み方・同じ判定なので、置き換えると両方の改善が積み上がります。
