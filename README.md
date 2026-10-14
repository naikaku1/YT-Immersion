# YT Immersion (Beta)

> **YouTubeを、もっと深く、もっと美しく。**
> **Experience YouTube, Deeper and More Beautifully.**

YT Immersionは、YouTubeのミュージックビデオをApple Music風のスタイリッシュなUIで楽しむためのChrome拡張機能です。Glassmorphismを取り入れたデザインと楽曲に同期した歌詞表示で、視覚的な没入感を提供します。

YT Immersion is a Chrome extension that transforms YouTube music videos with a stylish, Apple Music-inspired UI. Featuring Glassmorphism design and lyrics synced to the music, it delivers a truly immersive visual experience.

---

## 主な機能 / Features

### 歌詞の取得 / Finding the Right Lyrics

- **曲を動画から特定 / Song identified from the video**
  - 動画タイトルの文字列で検索するのではなく、YouTube Music が持っている「MV ⇔ 音源版」の対応から曲を特定し、YouTube Music の公式の時刻付き歌詞（Musixmatch / LyricFind）を使います。アーティストの channelId まで照合するので、同名の別曲・カバーの歌詞は出ません。
  - Instead of searching by the video title, the song is identified from YouTube Music's own MV ⇔ audio-track mapping, and YouTube Music's official timed lyrics (Musixmatch / LyricFind) are used. The artist's channelId must match, so lyrics of same-named songs or covers are never shown.
- **公式の対応表で同期 / Synced with the official time map**
  - YouTube にログインしている時は、YouTube Music の「音源の何秒が MV の何秒か」の対応表を使うので、MV の映像イントロ（例：NewJeans「Ditto」は 82 秒）があっても最初から合います。
  - When signed in to YouTube, YouTube Music's own map of "which second of the track is which second of the MV" is used, so lyrics are in sync from the start even with long cinematic intros (e.g. 82 s on NewJeans "Ditto").
- **語（音節）単位の歌詞 / Word- and syllable-level lyrics**
  - LRCHub・Apple Music（LyricsPlus）・AMLL・NetEase・KuGou の語単位の歌詞を並行して取り、公式歌詞と本文が一致したものだけを、時刻を公式歌詞に合わせてから使います。一致しない歌詞（別の曲・ローマ字だけ・訳が混ざったもの）は使いません。
  - Word-level lyrics from LRCHub, Apple Music (LyricsPlus), AMLL, NetEase and KuGou are fetched in parallel. Only those whose text agrees with the official lyrics are used, after aligning their clock to the official one. Mismatches (another song, romaji only, mixed-in translations) are rejected.
- **自動生成字幕で最終確認 / Final check against auto captions**
  - 自動生成字幕と文字単位で突き合わせ、この動画で実際に歌われている歌詞かを確かめます。ほとんど一致しない歌詞は表示しません。
  - Lyrics are matched character by character against the auto-generated captions; lyrics that the video doesn't actually sing are not shown.
- **1曲＝たくさんの動画 / One song, many videos**
  - 歌詞は「曲」に紐付けるので、MV・ダンス練習・音楽番組・THE FIRST TAKE・ファンカムでも同じ歌詞が使えます（動画ごとの時間合わせは自動）。次の動画の歌詞は先に読み込んでおきます。
  - Lyrics are tied to the song, so the MV, dance practice, music shows, THE FIRST TAKE and fancams all share them (each video is time-aligned automatically). Lyrics for the next video are prefetched.

### 歌詞表示 / Lyrics Display

- **没入型デザイン / Immersive Design**
  - 背景に溶け込む歌詞表示と、楽曲に同期した滑らかなオートスクロール。
  - Seamlessly integrated lyrics with smooth, real-time auto-scrolling.
- **時間差スクロール / Staggered Scroll**
  - 行が変わる時、上の行から順に少しずつ遅れて、ばねのように流れます（YTM-Immersion と同じ動き）。動きは合成スレッドで進むので、ページが重い時でも歌詞が止まりません。設定でオフにすると全行が一緒に動きます。
  - When the line changes, lines flow one after another from the top with a soft spring (the same motion as YTM-Immersion). The motion runs on the compositor, so lyrics keep moving even when the page is busy. Turn it off in settings to move all lines together.
- **2言語表示対応 / Dual Language Support**
  - 原文と訳詞の同時表示や切り替えに対応。原文をメイン・日本語を訳として自動配置。
  - Simultaneous display of original and translated lyrics, with automatic layout (original as main, Japanese as sub).
- **語単位のカラオケ / Word-by-word karaoke**
  - 語（音節）ごとに、歌い終わった語は白く、歌っている語は歌の進みに合わせて塗ります。折り返した長い行でも正しく塗れます。伸ばす音だけ少し光ります。ハモリ（背景の声）は本編の下に小さく出ます。語単位の歌詞が無い曲は、自動生成字幕との文字単位の突き合わせで語の時刻を推定します。
  - Each word (syllable) fills as it is sung; long wrapped lines fill correctly, sustained notes glow, and background vocals appear smaller below the main line. Songs without word-level lyrics get word timing from a character-level alignment with the auto captions.
- **歌に遅れない行送り / Frame-accurate line changes**
  - 行の切り替えを毎フレーム確かめ、光らせ始めを少しだけ早めています（以前は約 0.25 秒ごと）。
  - The current line is checked every frame and lit slightly ahead of the vocal (previously every ~0.25 s).
- **外部歌詞フォールバック（Beta） / External Lyrics Fallback (Beta)**
  - 字幕がない曲や自動生成字幕しかない曲では、[LRCLIB](https://lrclib.net) と NetEase Cloud Music を並列に検索して同期歌詞を自動取得します（日本・韓国の曲も多く見つかります）。取得結果は動画ごとにキャッシュされます。
  - For videos without proper captions, synced lyrics are searched on [LRCLIB](https://lrclib.net) and NetEase Cloud Music in parallel (good coverage of Japanese and Korean songs), and cached per video.
- **自動同期 / Automatic Sync**
  - MVのイントロや間奏の映像パートで生じる歌詞のズレを自動で補正します。自動生成字幕がある曲は、歌詞と字幕を時間順に照合して合わせます（サビの繰り返しにも強い照合）。字幕が無い曲は、再生中の音声から曲の始まりと途中の映像パートを推定して合わせます。語り（セリフ）から始まるMVでも、音が途切れずに鳴り始めた所を曲の始まりとして見分けます（音声は読み取るだけで、聞こえる音は変わりません）。
  - Lyrics drift caused by MV intros and mid-song cinematic breaks is corrected automatically. When auto-generated captions exist, lyrics are aligned to them in time order (robust to repeated choruses). Otherwise, the song start and inserted cinematic breaks are estimated from the playback audio (spoken intros are told apart from music by their gaps) (audio is only read, never altered).
  - 曲の始まりを判定している数秒の間は、歌詞を先に進めずに前奏表示（・・・）のまま待ちます。MV独自の前奏の後に一瞬の無音を挟んで本編が始まる構成も検出します。
  - While the song start is being determined, lyrics wait on the intro indicator (・・・) instead of running ahead. MVs with their own musical prelude followed by a brief silence are also detected.
  - 短縮版・TVサイズ・音楽番組のステージのように曲の一部が切られた動画では、切られた部分の歌詞を隠します（以前は後ろの歌詞に詰まって流れていました）。速度の違う動画（sped up 等）は、歌詞の進む速さも合わせます。
  - In short versions, TV-size edits and music-show stages, lyrics of the cut sections are hidden (previously they piled up onto later lines). For sped-up or slowed videos, the lyrics' pace is adjusted too.
  - 字幕・外部歌詞の冒頭にある「作詞：〜」「『曲名』」「♪」などの歌詞でない行は表示しません。
  - Non-lyric lines such as credits, title cards and "♪" at the start are not shown.
  - それでもズレる時は、「今歌っている行」をワンタップで合わせ直せます（行ホバーの時計ボタン）。補正は動画ごとに保存され、次回からそのまま適用されます。
  - If it still drifts, re-sync with one tap on the line currently being sung (clock button on hover). Corrections are saved per video.

### 訳・読み / Translation & Pronunciation

> 訳は、動画に見ている人の言語の字幕がある時に、外部歌詞の下にも自動で出ます。ふりがな・ローマ字・端末内翻訳は**実験的な機能で、既定では表示しません**（下の「実験的な機能」）。
> Translations from the video's own captions are shown automatically. Furigana, romaji and on-device translation are **experimental and hidden by default** (see "Experimental features").

- **訳 / Translation**
  - 歌詞の下に、見ている人の言語の訳を出します。この動画にあるその言語の字幕 → 取得元の訳 → Chrome 内蔵の端末内翻訳（API キー不要・歌詞は外へ送りません）の順に探します。端末内翻訳は初回だけ「訳を表示（端末内）」ボタンで翻訳モデルを取り込みます。原文と訳の行は時間の重なりで組み合わせるので、速いラップでもずれず、2行に割れた訳もつながります。
  - A translation in the viewer's language is shown under each line, taken from the video's own captions in that language, then the lyrics source's translation, then Chrome's built-in on-device translator (no API key; lyrics never leave the browser). Lines are paired by time overlap, so fast rap stays aligned and split translations are joined.
- **日本語の読み / Japanese readings**
  - 漢字のふりがな、またはローマ字の行を出せます。歌われた音（ローマ字の歌詞）から作るので、当て字（本気＝マジ）も歌の通りに出ます。
  - Furigana over kanji, or a romaji line. They are derived from the sung reading, so artistic readings (本気 → マジ) come out as sung.
- **韓国語の読み / Korean readings**
  - カタカナのルビに加えて、聞こえる音のローマ字も出せます。語の切れ目で決まる読み（꽃잎 → コンニプ、할게 → ハルケ）にも対応しました。
  - In addition to katakana ruby, sung-sound romanization is available, including readings decided by word boundaries (꽃잎 → kkonnip).

### 推し活（実験的・既定では非表示） / For Fans (experimental, hidden by default)

- **パート分け（歌割り） / Member line distribution**
  - だれがどの行を歌うかを、行の色の帯と名前で出します。LRCHub の歌い手データ・レーベルが色分けした字幕から自動で付き、無い曲はヘッダーの「パート」から、再生しながら数字キー（1〜9）で付けられます。メンバーごとの歌唱秒数も出ます。
  - Who sings each line is shown with a color bar and name. It comes from LRCHub's singer data or label color-coded captions, and can be tagged live with number keys (1–9) via the "パート" button. Seconds sung per member are shown.
- **推し / Your favorite member**
  - メンバーを選ぶと推し以外の行が薄くなり、「.」「,」キーで推しのパートへ前後に移動できます。パート分けは「曲」に保存するので、MV で付けたものがダンス練習やステージでも出ます。
  - Pick a member to dim the other lines and jump between their parts with "." and ",". Tags are stored per song, so they also appear on dance practices and stages.
- **応援法・コール / Fan chants & calls**
  - 掛け声をその時刻に大きく出し、直前は「まもなく」と残り時間で知らせます。ヘッダーの「応援法」から、見ながら追加するか、「0:42 OK!」のような時刻付きの文字をまとめて貼り付けられます。
  - Chants appear in large type at their time, with a "coming up" countdown. Add them while watching, or paste timestamped text like "0:42 OK!" in bulk.
- **共有 / Sharing**
  - この動画の同期の補正・パート分け・応援法を JSON で書き出し・読み込みできます（歌詞の本文は含みません）。共有サーバーの URL を設定すると、自動で読み込み・送信もできます。
  - Export/import this video's sync corrections, member parts and chants as JSON (no lyric text). With a sharing server URL set, they are fetched and sent automatically.

### 長時間の再生 / Long Listening Sessions

- （実験的・既定では非表示）MV モードの中に、シーク・時間・前後の動画・音量の操作を出します。
- 広告の間は歌詞を止めて「広告をスキップ」ボタンを出し、「動画が一時停止されました。続きを視聴しますか？」の確認も MV モードの中に出します（押すのはユーザーです）。
- Seek, time, previous/next and volume controls are available inside MV Mode. During ads, lyrics pause and a "Skip ad" button appears; the "Video paused. Continue watching?" prompt is also shown inside MV Mode (you press it yourself).
- 字幕を取るためのプレイヤー操作は1本ずつ順に行い、続けて失敗する時は画面がちらつくだけの操作をしばらく止めます。歌詞の出典にマウスを載せると、どこから取れたか・何秒かかったかが見られます。
- Player operations used to fetch captions run one at a time and pause themselves after repeated failures. Hover the lyrics source badge to see where the lyrics came from and how long each step took.

### 黒帯カット / Letterbox Removal

- **MVモード / MV Mode**
  - 曲の一部だけ上下に黒帯が入るMVでも、黒帯の部分を映像の続きのような光で埋め、画面が途切れずに続いているように見せます（Ambient Light風）。黒帯が出たり消えたりしても自動で追従します。
  - Black bars that appear in parts of a music video are filled with a soft continuation of the picture, so the screen feels seamless (Ambient Light style). It follows the bars as they come and go.
- **通常再生 / Normal Playback**
  - 黒帯を切り取り、プレイヤーの枠ごと本来の比率（シネマスコープ等）の動画として表示します。黒帯が消える場面では元の比率へ自動で戻ります。
  - Crops the black bars and resizes the player so the video looks like it was shot in that aspect ratio. Returns to the original ratio automatically when the bars disappear.

### 推し活支援 / Fan Tools

- **ベストショット撮影 / Best Shot Capture**
  - バースト撮影（連写）からブレの少ないフレームを自動抽出。
  - Automatically extracts the clearest frames using burst capture.
- **チェキ風画像作成 / Instax-style Card Creator**
  - 撮影したフレームにお好みの歌詞を添えてカードとして保存。
  - Create and save custom photo cards with your favorite lyrics.

### 独自プレイヤー / Unique Players

- **Mini Player (PiP)**
  - 縦長のPiPウィンドウ。上に動画、下にApple Music風の歌詞スクロール。
  - A portrait picture-in-picture window: video on top, Apple Music-style scrolling lyrics below.
- **レコードモード / Record Mode**
  - アナログレコードの質感を再現した再生画面。
  - A playback screen replicating the aesthetic of vinyl records.

---

## インストール方法 / Installation

1. [Releases](../../releases) から最新のソースコードをダウンロードし、解凍します。
   Download and extract the latest source code from [Releases](../../releases).
2. Chromeの拡張機能ページ（`chrome://extensions/`）を開きます。
   Open `chrome://extensions/` in your Chrome browser.
3. 「デベロッパーモード」をオンにします。
   Enable "Developer mode".
4. 「パッケージ化されていない拡張機能を読み込む」から解凍したフォルダを選択します。
   Click "Load unpacked" and select the extracted folder.

---

## 使い方 / Usage

### 基本 / Basics

1. YouTubeでミュージックビデオを開きます。
   Open a music video on YouTube.
2. プレイヤー右下のMVモードボタン（歌詞の行が入った画面のアイコン）から起動します。隣の縦長アイコンは Mini Player です。
   Launch with the MV Mode button at the bottom right of the player (screen icon with lyric lines). The tall icon next to it opens the Mini Player.
3. 終了は「閉じる」ボタンまたは `Esc` キーで行います。
   Exit using the close button or the `Esc` key.

### キーボード / Keyboard

| キー / Key | 動作 / Action |
|---|---|
| `[` `]` | 歌詞全体を 0.5 秒ずつ合わせる（外部歌詞）/ Nudge lyrics by 0.5 s (external lyrics) |
| `.` `,` | （実験的）推しのパートへ前後に移動 / (experimental) Jump to your favorite member's next / previous part |
| `1`〜`9`, `0` | （実験的）パート編集中：今の行にメンバーを付ける／外す / (experimental) While editing parts: tag / untag the current line |

### 歌詞がズレたら / If Lyrics Are Out of Sync

外部歌詞の表示中にズレを感じたら、次の3つで直せます。補正は動画ごとに自動保存されます。

If external lyrics drift out of sync, you can fix it in three ways. Corrections are saved automatically per video.

| 操作 / Action | 効果 / Effect |
|---|---|
| 行ホバーの ⏱ ボタン / Clock button on line hover | その行を「今」に同期（以降の行だけ補正）/ Syncs that line to "now" (adjusts following lines only) |
| ヘッダーの −0.5s / +0.5s | 歌詞全体を微調整 / Nudges all lyrics slightly |
| ヘッダーの「同期リセット」/ "Reset Sync" | 補正をすべて消去して自動同期をやり直す / Clears all corrections and re-runs auto sync |

---

## 設定一覧 / Settings

| 設定 / Setting | 既定値 / Default | 説明 / Description |
|---|---|---|
| タイトルを常に表示 / Always show title | オフ / Off | 曲名・アーティストを常時表示 / Keeps title & artist visible |
| 自動生成字幕を使わない / Exclude auto-generated captions | オン / On | AIの自動字幕を歌詞として表示しない / Hides ASR captions from lyrics display |
| 原文を優先 / Prefer original language | オン / On | 海外曲は原語をメイン・日本語を訳として表示 / Original as main, Japanese as translation |
| 字幕がない曲は外部歌詞を表示 / External lyrics | オン / On | YouTube Music の公式歌詞と語単位の取得元を突き合わせて表示 / Official YouTube Music lyrics, cross-checked with word-level sources |
| 韓国語の読みを表示 / Show Korean pronunciation | オフ / Off | 韓国語の歌詞と字幕（CC）の上に読みをカタカナで振る。プレイヤーの歯車メニュー「韓国語の読み」からも切替可 / Shows a small katakana reading above Korean lyrics and captions (CC). Also toggleable from the player's gear menu |
| 歌詞の時間差スクロール / Staggered lyric scroll | オン / On | 上の行から順に遅れて流れる / Lines flow one after another from the top |
| カラオケ風ハイライト / Karaoke highlight | オン / On | 語ごとに塗る / Fills word by word |
| （実験的）訳の言語 / Translation language | ブラウザの言語 / Browser language | 歌詞の下に出す訳の言語 / Language of the translation line |
| （実験的）端末内翻訳を使う / On-device translation | オン / On | Chrome 内蔵の翻訳で訳を作る / Uses Chrome's built-in translator |
| （実験的）日本語の読み / Japanese readings | 表示しない / Off | ふりがな・ローマ字 / Furigana or romaji |
| （実験的）韓国語のローマ字 / Korean romanization | 表示しない / Off | 聞こえる音のローマ字 / Sung-sound romanization |
| （実験的）パート（歌割り）を表示 / Show member parts | オン / On | だれが歌う行かを色と名前で / Color and name per line |
| （実験的）応援法・コールを表示 / Show fan chants | オン / On | 掛け声を時刻に合わせて / Chants at their time |
| （実験的）共有サーバー / Sharing server | なし / None | 同期・パート・応援法の共有先（任意）/ Optional server for sharing |
| 黒帯をカット（MVモード）/ Remove letterbox (MV Mode) | オン / On | 黒帯を映像の続きのような光で埋める / Fills black bars with a continuation of the picture |
| 黒帯をカット（通常再生）/ Remove letterbox (Normal) | オフ / Off | 黒帯を切り取り本来の比率で表示。プレイヤーの歯車メニュー「黒帯カット」からも切替可 / Crops black bars to the true aspect ratio. Also toggleable from the player's gear menu |

---

## 免責事項 / Disclaimer

- **プライバシー / Privacy**
  - 本拡張機能は、利用者の個人情報を収集・送信することはありません。歌詞を探すために、動画ID・曲名・アーティスト名を次へ送ります：YouTube（www.youtube.com の YouTube Music の仕組み。ログイン中はページと同じ認証で問い合わせますが、認証情報そのものは外へ送りません）、LRCHub（lrchub.coreone.work）、LyricsPlus（lyricsplus のミラー）、NetEase Cloud Music（music.163.com）、AMLL TTML DB（raw.githubusercontent.com / cdn.jsdelivr.net）、KuGou（kugou.com）、LRCLIB（lrclib.net）。訳は Chrome 内蔵の端末内翻訳で作り、歌詞を外へ送りません。共有サーバーは URL を設定した時だけ使い、送るのは時刻・メンバー名・色・掛け声と行の指紋だけです（「送る」をオンにした時のみ）。「字幕がない曲は外部歌詞を表示」をオフにすると、外部への問い合わせは行いません。
  - This extension does not collect or transmit any personal information. To find lyrics, the video ID, track title and artist name are sent to: YouTube (YouTube Music's mechanism on www.youtube.com; when signed in, requests use the page's own authentication, which never leaves the page), LRCHub, LyricsPlus mirrors, NetEase Cloud Music, AMLL TTML DB (GitHub / jsDelivr), KuGou and LRCLIB. Translations are made on-device by Chrome; lyrics are not sent anywhere. A sharing server is used only if you set its URL, and only timing, member names, colors, chants and line fingerprints are sent (only when sending is turned on). Turning off "External lyrics" stops all external lookups.
- **非公式 / Unofficial**
  - 本プロジェクトは個人の制作物であり、Google LLCおよびYouTubeとは関係ありません。
  - This is a personal project and is not affiliated with Google LLC or YouTube.
- **保証 / Warranty**
  - 本ツールの利用により生じた損害について、開発者は一切の責任を負いません。
  - The developer assumes no responsibility for any damages resulting from the use of this tool.

---

## 実験的な機能 / Experimental features

パート分け・推し・応援法・共有・ふりがな/ローマ字・端末内翻訳は、既定では画面にも動作にも出しません。
試す時は、YouTube のページでデベロッパーツールのコンソールを開いて次を実行し、ページを読み込み直してください（元に戻すには `removeItem`）。
Member parts, favorite-member mode, fan chants, sharing, furigana/romaji and on-device translation are hidden by default. To try them, run the following in the DevTools console on YouTube and reload (use `removeItem` to turn them off).

```js
localStorage.setItem('mv_extra_features', 'true')
```

## 開発 / Development

ビルドは不要です。共通コア（`core/`）のテスト:

```bash
node --test tests/*.test.mjs
```

`core/` は YTM-Immersion と共有できる形にしてあります（`core/README.md`、`tools/sync-core.sh`）。

## ライセンス / License

MIT License
Copyright (c) 2025 Naikaku
