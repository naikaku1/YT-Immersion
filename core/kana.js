// ===== 共通コア：かな・ローマ字・ふりがな =====
// 海外のファンが J-POP を一緒に歌えるように、読み（ローマ字）と、漢字のふりがなを出す。
// 漢字の読みは辞書（形態素解析）が無いと決まらないので、ここでは
//   - かなだけの行 → そのままローマ字に
//   - 取得元（NetEase）が持っているローマ字の行 → かなに戻して、元の行の かな の部分と
//     突き合わせ、間に挟まった漢字の読みを切り出す（＝ふりがな）
// の2つを行う。歌詞の当て字（本気＝マジ）も、ローマ字が歌われた音なので正しく出る。
// 読み込むと globalThis.YTICore.kana に入る。

(function (root) {
  const YTICore = root.YTICore = root.YTICore || {};

  const toHira = (s) => String(s || '').replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const isKana = (ch) => /[ぁ-ゖァ-ヺー]/.test(ch);
  const isKanji = (ch) => /[㐀-鿿豈-﫿々〆ヶ]/.test(ch);

  const BASE = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'wo', ん: 'n',
    が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
    ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
  };
  // 拗音・外来音（2文字）
  const DIGRAPH = {
    きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho', ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
    にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo', ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
    りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo', じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
    びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
    しぇ: 'she', ちぇ: 'che', じぇ: 'je', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du', ふぁ: 'fa', ふぃ: 'fi',
    ふぇ: 'fe', ふぉ: 'fo', うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
    つぁ: 'tsa', つぇ: 'tse', つぉ: 'tso', いぇ: 'ye', くぁ: 'kwa', ぐぁ: 'gwa', てゅ: 'tyu', でゅ: 'dyu',
  };

  // かな → ヘボン式ローマ字。かな以外（漢字・英字）はそのまま残す。
  // 助詞の「は」「へ」は、後ろが空白・記号・行末の時だけ wa / e と読む（語の切れ目が分かる時だけ）。
  function kanaToRomaji(text) {
    const s = toHira(text);
    let out = '';
    let i = 0;
    const lastVowel = () => {
      const m = out.match(/[aeiou](?=[^aeiou]*$)/);
      return m ? m[0] : '';
    };
    while (i < s.length) {
      const two = s.slice(i, i + 2);
      const ch = s[i];
      if (DIGRAPH[two]) {
        out += DIGRAPH[two];
        i += 2;
        continue;
      }
      if (ch === 'っ') {
        // 次の音の子音を重ねる（ch は tch）
        const nextTwo = s.slice(i + 1, i + 3);
        const nxt = DIGRAPH[nextTwo] || BASE[s[i + 1]] || '';
        if (nxt) out += nxt.startsWith('ch') ? 't' : nxt[0];
        i += 1;
        continue;
      }
      if (ch === 'ー') {
        out += lastVowel();
        i += 1;
        continue;
      }
      if (ch === 'ん') {
        const nx = BASE[s[i + 1]] || '';
        out += /^[aeiouy]/.test(nx) ? "n'" : 'n';
        i += 1;
        continue;
      }
      const nextCh = s[i + 1];
      if ((ch === 'は' || ch === 'へ') && i > 0 && (!nextCh || /[\s、。！？!?,.」』）)]/.test(nextCh)) && /[぀-鿿]/.test(s[i - 1])) {
        out += ch === 'は' ? 'wa' : 'e';
        i += 1;
        continue;
      }
      if (BASE[ch] !== undefined) {
        out += BASE[ch];
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  // ローマ字 → ひらがな（ふりがなを切り出すための逆変換）。綴りの揺れ（si/shi, tu/tsu, ou/ō）も受ける。
  const R2K = [];
  (() => {
    const seen = new Set();
    const add = (r, k) => {
      if (seen.has(r)) return;
      seen.add(r);
      R2K.push([r, k]);
    };
    // 清音を先に（wo は「を」。外来音の「うぉ」より普通の歌詞で多い）
    for (const [k, r] of Object.entries(BASE)) if (!/[ぁぃぅぇぉゃゅょゎゐゑ]/.test(k)) add(r, k);
    for (const [k, r] of Object.entries(DIGRAPH)) add(r, k);
    [['si', 'し'], ['ti', 'ち'], ['tu', 'つ'], ['hu', 'ふ'], ['zi', 'じ'], ['di', 'ぢ'], ['du', 'づ'], ['sya', 'しゃ'], ['syu', 'しゅ'],
      ['syo', 'しょ'], ['tya', 'ちゃ'], ['tyu', 'ちゅ'], ['tyo', 'ちょ'], ['zya', 'じゃ'], ['zyu', 'じゅ'], ['zyo', 'じょ'], ['jya', 'じゃ'],
      ['jyu', 'じゅ'], ['jyo', 'じょ'], ['wo', 'を'], ['o', 'お'], ['la', 'ら'], ['li', 'り'], ['lu', 'る'], ['le', 'れ'], ['lo', 'ろ'],
      ['ā', 'ああ'], ['ī', 'いい'], ['ū', 'うう'], ['ē', 'ええ'], ['ō', 'おう'], ['va', 'ゔぁ'], ['vi', 'ゔぃ'], ['vu', 'ゔ'], ['ve', 'ゔぇ'], ['vo', 'ゔぉ']]
      .forEach(([r, k]) => add(r, k));
    R2K.sort((a, b) => b[0].length - a[0].length);
  })();

  function romajiToHiragana(romaji) {
    const s = String(romaji || '').normalize('NFKC').toLowerCase().replace(/[^a-zāīūēō'\s-]/g, ' ');
    let out = '';
    let i = 0;
    let skipped = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s|-|'/.test(c)) {
        i++;
        continue;
      }
      // 促音：同じ子音が続く（tch も）
      if (/[bcdfghjkmpqrstvwxyz]/.test(c) && (s[i + 1] === c || (c === 't' && s[i + 1] === 'c')) && c !== 'n') {
        out += 'っ';
        i++;
        continue;
      }
      // ん：n の後が母音・y でない（nn も ん）
      if (c === 'n' && (i + 1 >= s.length || !/[aeiouyāīūēō]/.test(s[i + 1]))) {
        out += 'ん';
        i += (s[i + 1] === 'n' && !/[aeiouy]/.test(s[i + 2] || '')) ? 2 : 1;
        continue;
      }
      let hit = null;
      for (const [r, k] of R2K) {
        if (s.startsWith(r, i)) {
          hit = [r, k];
          break;
        }
      }
      if (!hit) {
        // 読めない字（英字の略語「B」など）は飛ばす。多すぎれば日本語のローマ字ではない（英語の行など）
        skipped++;
        i++;
        continue;
      }
      out += hit[1];
      i += hit[0].length;
    }
    const letters = s.replace(/[^a-zāīūēō]/g, '').length;
    if (!letters || skipped > letters * 0.15) return null;
    return out;
  }

  // 元の行と読み（ひらがな）から、漢字の部分の読みを切り出す。
  // 戻り値: [{ text, reading? }]（reading があるのは漢字の塊だけ）。合わなければ null。
  function furiganaFromReading(text, reading) {
    const src = String(text || '');
    const read = String(reading || '');
    if (!src || !read || !Array.from(src).some(isKanji)) return null;
    // 元の行を「漢字の塊」と「それ以外」に分ける
    const parts = [];
    for (const ch of Array.from(src)) {
      const kind = isKanji(ch) ? 'k' : 'o';
      const last = parts[parts.length - 1];
      if (last && last.kind === kind) last.text += ch;
      else parts.push({ kind, text: ch });
    }
    // 漢字以外は読みと一致すべき文字（かなは ひらがなに、記号・空白・英字は読みに現れないので捨てる）
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = (t) => {
      let re = '';
      for (const ch of Array.from(toHira(t))) {
        if (ch === 'は') re += '(?:は|わ)';
        else if (ch === 'へ') re += '(?:へ|え)';
        else if (ch === 'を') re += '(?:を|お)';
        else if (ch === 'ー') re += '[あいうえおー]?';
        else if (/[ぁ-ゖ]/.test(ch)) re += esc(ch);
        // 英字・記号・空白は読みの側では落ちている
      }
      return re;
    };
    let pattern = '^';
    for (const p of parts) pattern += p.kind === 'k' ? '([ぁ-ゖ]{1,' + (p.text.length * 4 + 2) + '}?)' : literal(p.text);
    pattern += '$';
    let m = null;
    try {
      m = toHira(read).replace(/[^ぁ-ゖー]/g, '').match(new RegExp(pattern));
    } catch (e) {
      return null;
    }
    if (!m) return null;
    let g = 1;
    return parts.map(p => (p.kind === 'k' ? { text: p.text, reading: m[g++] } : { text: p.text }));
  }

  YTICore.kana = { toHira, isKana, isKanji, kanaToRomaji, romajiToHiragana, furiganaFromReading };
  if (typeof module === 'object' && module.exports) module.exports = YTICore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
