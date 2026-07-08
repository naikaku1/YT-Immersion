# YT Immersion (Beta)

> **YouTubeを、もっと深く、もっと美しく。**
> **Experience YouTube, Deeper and More Beautifully.**

YT Immersionは、YouTubeのミュージックビデオをApple Music風のスタイリッシュなUIで楽しむためのChrome拡張機能です。Glassmorphismを取り入れたデザインと楽曲に同期した歌詞表示で、視覚的な没入感を提供します。

YT Immersion is a Chrome extension that transforms YouTube music videos with a stylish, Apple Music-inspired UI. Featuring Glassmorphism design and lyrics synced to the music, it delivers a truly immersive visual experience.

---

## 主な機能 / Features

### 歌詞表示 / Lyrics Display

- **没入型デザイン / Immersive Design**
  - 背景に溶け込む歌詞表示と、楽曲に同期した滑らかなオートスクロール。
  - Seamlessly integrated lyrics with smooth, real-time auto-scrolling.
- **2言語表示対応 / Dual Language Support**
  - 原文と訳詞の同時表示や切り替えに対応。原文をメイン・日本語を訳として自動配置。
  - Simultaneous display of original and translated lyrics, with automatic layout (original as main, Japanese as sub).
- **カラオケ風ハイライト（Beta） / Karaoke-style Highlight (Beta)**
  - Apple Musicのように、歌に合わせて現在の行が左から塗られていきます。自動生成字幕（ASR）の単語タイミングを「時計」としてだけ利用し、画面には正しい歌詞のみを表示します。単語タイミングが取得できない曲では行単位の近似表示になります。
  - The current line fills from left to right in sync with the vocals, like Apple Music. Word-level timing is borrowed from auto-generated (ASR) captions purely as a clock — only the real lyrics are ever displayed. Falls back to a per-line approximation when word timing is unavailable.
- **外部歌詞フォールバック（Beta） / External Lyrics Fallback (Beta)**
  - 字幕がない曲や自動生成字幕しかない曲では、[LRCLIB](https://lrclib.net) から同期歌詞を自動取得します。取得結果は動画ごとにキャッシュされます。
  - For videos without proper captions, synced lyrics are automatically fetched from [LRCLIB](https://lrclib.net) and cached per video.
- **ズレ補正（アンカー同期） / Timing Correction (Anchor Sync)**
  - MVのイントロや間奏の映像パートで生じる歌詞のズレを、自動生成字幕との照合で自動補正。手動でも「今歌っている行」をワンタップで合わせ直せます（行ホバーの時計ボタン）。補正は動画ごとに保存され、次回からそのまま適用されます。
  - Lyrics drift caused by MV intros and mid-song cinematic breaks is auto-corrected by matching against auto-generated captions. You can also re-sync manually with one tap on the line currently being sung (clock button on hover). Corrections are saved per video.

### 推し活支援 / Fan Tools

- **ベストショット撮影 / Best Shot Capture**
  - バースト撮影（連写）からブレの少ないフレームを自動抽出。
  - Automatically extracts the clearest frames using burst capture.
- **チェキ風画像作成 / Instax-style Card Creator**
  - 撮影したフレームにお好みの歌詞を添えてカードとして保存。
  - Create and save custom photo cards with your favorite lyrics.

### 独自プレイヤー / Unique Players

- **iPod風 PiP / iPod-style PiP**
  - クラシックな操作感を楽しめるPiPプレイヤー。
  - A nostalgic picture-in-picture player with classic controls.
- **レコードモード / Record Mode**
  - アナログレコードの質感を再現した再生画面。
  - A playback screen replicating the aesthetic of vinyl records.

---

## インストール方法 / Installation

1. 最新のソースコードをダウンロードし、解凍します。
   Download and extract the latest source code
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
2. プレイヤー下の「MVモード」ボタンから起動します。
   Launch by clicking the "MV Mode" button below the player.
3. 終了は「閉じる」ボタンまたは `Esc` キーで行います。
   Exit using the close button or the `Esc` key.

### Beta機能を有効にする / Enabling Beta Features

カラオケ風ハイライトと外部歌詞フォールバックは**初期設定ではオフ**です。MVモード内の設定パネル（表示オプション）から有効にしてください。

Karaoke-style Highlight and External Lyrics Fallback are **disabled by default**. Enable them from the settings panel (Display Options) inside MV Mode.

### 歌詞がズレたら / If Lyrics Are Out of Sync

外部歌詞の表示中にズレを感じたら、次の3つで直せます。補正は動画ごとに自動保存されます。

If external lyrics drift out of sync, you can fix it in three ways. Corrections are saved automatically per video.

| 操作 / Action | 効果 / Effect |
|---|---|
| 行ホバーの ⏱ ボタン / Clock button on line hover | その行を「今」に同期（以降の行だけ補正）/ Syncs that line to "now" (adjusts following lines only) |
| ヘッダーの −0.5s / +0.5s | 歌詞全体を微調整 / Nudges all lyrics slightly |
| ヘッダーの「同期リセット」/ "Reset Sync" | 補正をすべて消去 / Clears all corrections |

---

## 設定一覧 / Settings

| 設定 / Setting | 既定値 / Default | 説明 / Description |
|---|---|---|
| タイトルを常に表示 / Always show title | オフ / Off | 曲名・アーティストを常時表示 / Keeps title & artist visible |
| 自動生成字幕を使わない / Exclude auto-generated captions | オン / On | AIの自動字幕を歌詞として表示しない / Hides ASR captions from lyrics display |
| 原文を優先 / Prefer original language | オン / On | 海外曲は原語をメイン・日本語を訳として表示 / Original as main, Japanese as translation |
| 字幕がない曲は外部歌詞を検索（Beta）/ External lyrics fallback (Beta) | オフ / Off | LRCLIBから同期歌詞を取得 / Fetches synced lyrics from LRCLIB |
| カラオケ風ハイライト（Beta）/ Karaoke-style highlight (Beta) | オフ / Off | 歌に合わせて現在行を左から塗る / Fills the current line in sync with the vocals |

---

## 免責事項 / Disclaimer

- **プライバシー / Privacy**
  - 本拡張機能は、利用者の個人情報を収集・送信することはありません。外部歌詞機能を有効にした場合のみ、歌詞検索のために曲名・アーティスト名がLRCLIB（lrclib.net）へ送信されます。
  - This extension does not collect or transmit any personal information. Only when the external lyrics feature is enabled, the track title and artist name are sent to LRCLIB (lrclib.net) to search for lyrics.
- **非公式 / Unofficial**
  - 本プロジェクトは個人の制作物であり、Google LLCおよびYouTubeとは関係ありません。
  - This is a personal project and is not affiliated with Google LLC or YouTube.
- **保証 / Warranty**
  - 本ツールの利用により生じた損害について、開発者は一切の責任を負いません。
  - The developer assumes no responsibility for any damages resulting from the use of this tool.

---

## ライセンス / License

MIT License
Copyright (c) 2025 Naikaku
