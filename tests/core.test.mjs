// 共通コア（core/*.js）の単体テスト。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../core/text.js');
require('../core/parsers.js');
require('../core/warp.js');
require('../core/align.js');
require('../core/pairing.js');
const C = globalThis.YTICore;

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

test('拡張LRC（LRCHub の dynamic_lrc）の語タグを語の時刻として読む', () => {
  const lines = C.parsers.parseLrc('[00:00.10]<00:00.10>無<00:00.10>敵<00:00.36>の<00:00.68>笑\n[00:03.01]<00:03.01>知<00:03.27>り');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '無敵の笑');
  assert.equal(lines[0].words.length, 4);
  assert.ok(near(lines[0].words[2].t, 0.36));
  assert.ok(near(lines[1].start, 3.01));
});

test('LRC の1行に時刻が複数付いていたら時刻の数だけ行を起こす', () => {
  const lines = C.parsers.parseLrc('[00:10.00][01:10.00]サビ\n[00:05.00]歌い出し');
  assert.deepEqual(lines.map(l => [l.start, l.text]), [[5, '歌い出し'], [10, 'サビ'], [70, 'サビ']]);
});

test('NetEase yrc を語単位で読む', () => {
  const lines = C.parsers.parseYrc('{"t":0,"c":[{"tx":"作词: "}]}\n[1000,2000](1000,500,0)Hel(1500,500,0)lo (2000,1000,0)world');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello world');
  assert.ok(near(lines[0].words[1].t, 1.5));
  assert.ok(near(lines[0].end, 3.0));
});

test('Apple TTML のハモリは本編に混ぜず bg に分ける', () => {
  const ttml = '<tt><body><div><p begin="00:01.000" end="00:03.000" ttm:agent="v1">' +
    '<span begin="00:01.000" end="00:01.500">Yes</span> <span begin="00:01.600" end="00:02.000">I</span>' +
    '<span ttm:role="x-bg"><span begin="00:02.100" end="00:02.400">(oh</span><span begin="00:02.400" end="00:02.800">oh)</span></span>' +
    '</p></div></body></tt>';
  const lines = C.parsers.parseTtml(ttml);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Yes I');
  assert.equal(lines[0].bg.text, 'ohoh');
  assert.equal(lines[0].agent, 'v1');
});

test('YouTube Music の cueRange が全部 0 の歌詞は同期歌詞として使わない', () => {
  assert.equal(C.parsers.convertYtmTimed([{ lyricLine: 'a', cueRange: { startTimeMilliseconds: '0', endTimeMilliseconds: '0' } }]), null);
  const ok = C.parsers.convertYtmTimed([{ lyricLine: 'a', cueRange: { startTimeMilliseconds: '880', endTimeMilliseconds: '3780' } }]);
  assert.ok(near(ok[0].start, 0.88));
});

test('json3 字幕の色を行のパート色として拾う', () => {
  const json = JSON.stringify({
    pens: [{}, { fcForeColor: 0xFF66CC }],
    events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '사랑해', pPenId: 1 }] }],
  });
  const lines = C.parsers.parseJson3Lines(json);
  assert.equal(lines[0].color, '#FF66CC');
});

test('segmentMap：曲の0秒がMVの82秒（Ditto）。区間の外の行は切られた所として隠す', () => {
  const segs = C.warp.segmentsFromSegmentMap({ segment: [{ primaryVideoStartTimeMilliseconds: '82035', counterpartVideoStartTimeMilliseconds: '0', durationMilliseconds: '185965' }] });
  const w = C.warp.buildWarp({ segments: segs });
  assert.ok(near(w.map(10).time, 92.035));
  assert.equal(w.map(10).cut, false);
  assert.equal(w.map(190).cut, true);
  assert.ok(near(w.inverse(92.035), 10));
});

test('対応点の段差が減る（短縮版で2番が切られた）と、切られた行は隠れて後ろに詰まらない', () => {
  const lines = [];
  for (let s = 0; s < 120; s += 5) lines.push({ start: s, text: 'line' + s });
  // 60〜90秒（2番）が切られた：90秒以降は 30 秒早まる
  const w = C.warp.buildWarp({ anchors: [{ lrcTime: 0, videoTime: 10 }, { lrcTime: 90, videoTime: 70 }] });
  const mapped = C.warp.applyToLines(lines, w);
  const hidden = mapped.filter(l => l.hidden).map(l => l.baseTime);
  assert.deepEqual(hidden, [60, 65, 70, 75, 80, 85]);
  const shown = mapped.filter(l => !l.hidden);
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i].time >= shown[i - 1].time);
});

test('速度の違い（rate）は行の中の語にも同じ傾きで効く', () => {
  const w = C.warp.buildWarp({ anchors: [{ lrcTime: 0, videoTime: 0, rate: 0.8 }] });
  const [l] = C.warp.applyToLines([{ start: 10, text: 'ab', words: [{ t: 10, c: 'a' }, { t: 11, c: 'b' }] }], w);
  assert.ok(near(l.time, 8));
  assert.ok(near(l.words[1].t, 8.8));
});

function makeAsr(lines, mapFn) {
  // 各行の文字を 1 文字 0.25 秒で「歌った」ASR を作る（語は2文字ずつ）
  const words = [];
  for (const l of lines) {
    const chars = Array.from(l.text);
    for (let k = 0; k < chars.length; k += 2) {
      const v = mapFn(l.start + k * 0.25);
      if (v === null) continue;
      words.push({ time: v, text: chars.slice(k, k + 2).join('') });
    }
  }
  return words;
}

test('ASR との文字単位の突き合わせで、イントロの段差と切られた区間を見つける', () => {
  const texts = ['あいうえおかきくけこ', 'さしすせそたちつてと', 'なにぬねのはひふへほ', 'まみむめもやゆよらり',
    'るれろわをんがぎぐげ', 'ござじずぜぞだぢづで', 'どばびぶべぼぱぴぷぺ', 'ぽアイウエオカキクケ'];
  const lines = texts.map((t, i) => ({ start: 10 + i * 10, text: t + i }));
  // MV：イントロ映像 30 秒。曲の 40〜60 秒（3・4行目）は切られ、以降は 20 秒早まる
  const map = (s) => (s >= 40 && s < 60) ? null : (s < 40 ? s + 30 : s + 10);
  const r = C.align.alignLyricsToAsr(lines, makeAsr(lines, map));
  assert.ok(r.coverage > 0.6, 'coverage ' + r.coverage);
  assert.ok(r.anchors.length >= 2);
  assert.ok(near(r.anchors[0].videoTime - r.anchors[0].lrcTime, 30, 0.3));
  const last = r.anchors[r.anchors.length - 1];
  assert.ok(near(last.videoTime - last.lrcTime, 10, 0.3));
  const mapped = C.warp.applyToLines(lines, C.warp.buildWarp({ anchors: r.anchors }));
  const hidden = mapped.filter(l => l.hidden).map(l => l.baseTime);
  assert.deepEqual(hidden, [40, 50]);
  assert.ok(r.charTimes[0] && near(r.charTimes[0][2], 40.5, 0.3));
});

test('別の曲の歌詞は ASR とほとんど一致しない（合否判定に使える）', () => {
  const lines = [{ start: 0, text: 'きみのなまえをよんだ' }, { start: 5, text: 'よるのそらにひかる' }];
  const other = [{ start: 0, text: 'ドレミファソラシド' }, { start: 5, text: 'ABCDEFGHIJK' }];
  const asr = makeAsr(lines, s => s + 5);
  assert.ok(C.align.alignLyricsToAsr(lines, asr).coverage > 0.6);
  assert.ok(C.align.alignLyricsToAsr(other, asr).coverage < 0.15);
});

test('訳が2行に割れていても両方を同じ原文の行につなぐ', () => {
  const main = [{ start: 0, text: 'A' }, { start: 4, text: 'B' }, { start: 8, text: 'C' }];
  const sub = [{ start: 0, end: 2, text: 'a1' }, { start: 2, end: 4, text: 'a2' }, { start: 4.1, end: 8, text: 'b' }, { start: 8.2, end: 11, text: 'c' }];
  assert.deepEqual(C.pairing.pairLines(main, sub), ['a1 a2', 'b', 'c']);
});

test('速いラップでも1行前の訳を付けない', () => {
  const main = [{ start: 0, text: 'A' }, { start: 1.0, text: 'B' }, { start: 2.0, text: 'C' }];
  const sub = [{ start: 0.05, end: 0.95, text: 'a' }, { start: 1.05, end: 1.95, text: 'b' }, { start: 2.05, end: 3, text: 'c' }];
  assert.deepEqual(C.pairing.pairLines(main, sub), ['a', 'b', 'c']);
});

test('取得元の突き合わせ：ローマ字の外れを見分ける', () => {
  const ja = '無敵の笑顔で荒らすメディア\n知りたいその秘密ミステリアス\n抜けてるとこさえ彼女のエリア';
  const ja2 = '無敵の笑顔で 荒らすメディア\n知りたい その秘密ミステリアス\n抜けてるとこさえ彼女のエリア';
  const romaji = 'muteki no egao de arasu media\nshiritai sono himitsu misuteriasu\nnuketeru toko sae kanojo no eria';
  const v = C.text.judgeLyrics([{ providerId: 'ytm', lyrics: ja }, { providerId: 'lrclib', lyrics: romaji }, { providerId: 'netease', lyrics: ja2 }], { track: 'アイドル' });
  assert.equal(v.get('ytm'), 'confirmed');
  assert.equal(v.get('netease'), 'confirmed');
  assert.equal(v.get('lrclib'), 'contradicted');
});

test('版の印（live 等）が違う候補は採らない', () => {
  const want = { track: 'Lemon', artist: '米津玄師', durationSec: 255 };
  const pick = C.text.pickRemoteCandidate([
    { title: 'Lemon (Live)', artist: '米津玄師', durationSec: 255 },
    { title: 'Lemon', artist: '米津玄師', durationSec: 256 },
  ], want);
  assert.equal(pick.title, 'Lemon');
});

require('../core/kana.js');

test('かな → ローマ字（拗音・促音・長音・撥音・助詞の「は」）', () => {
  assert.equal(C.kana.kanaToRomaji('きょうはいいてんき'), 'kyouhaiitenki');
  assert.equal(C.kana.kanaToRomaji('ちょっと まって'), 'chotto matte');
  assert.equal(C.kana.kanaToRomaji('ラーメン'), 'raamen');
  assert.equal(C.kana.kanaToRomaji('きみは すき'), 'kimiwa suki');
  assert.equal(C.kana.kanaToRomaji('げんいん'), "gen'in");
});

test('ローマ字 → ひらがな（揺れた綴り・英字の混じり）', () => {
  assert.equal(C.kana.romajiToHiragana('mu te ki no e ga o de'), 'むてきのえがおで');
  assert.equal(C.kana.romajiToHiragana('na ni wo ki ka re te mo'), 'なにをきかれても');
  assert.equal(C.kana.romajiToHiragana('ka n pe ki'), 'かんぺき');
  assert.equal(C.kana.romajiToHiragana('ji tto'), 'じっと');
  assert.equal(C.kana.romajiToHiragana('I love you so much baby tonight'), null);
});

test('歌われた音（ローマ字）から漢字のふりがなを切り出す（当て字も歌の通り）', () => {
  const segs = C.kana.furiganaFromReading('本気で好きだよ', C.kana.romajiToHiragana('ma ji de su ki da yo'));
  assert.deepEqual(segs.filter(s => s.reading).map(s => [s.text, s.reading]), [['本気', 'まじ'], ['好', 'す']]);
  const s2 = C.kana.furiganaFromReading('君は完璧で究極のアイドル', C.kana.romajiToHiragana('ki mi wa ka n pe ki de kyu u kyo ku no a i do ru'));
  assert.deepEqual(s2.filter(s => s.reading).map(s => s.reading), ['きみ', 'かんぺき', 'きゅうきょく']);
  assert.equal(C.kana.furiganaFromReading('ひらがなだけ', 'ひらがなだけ'), null);
});
