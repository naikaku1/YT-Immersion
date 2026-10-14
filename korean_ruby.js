// ===== 韓国語の読み（カナルビ）=====
// YTM-Immersion の korean-ruby.js と同じ読み方。韓国語の語の上に、読みを
// カタカナで小さく振る。ハングルは字母の組み立てから機械的に読めるので、
// 辞書も通信も要らない。
//
// 読みは「書いてある字」ではなく「聞こえる音」に寄せる。語の中で起きる主な
// 音の変化（連音・ㅎ の脱落と激音化・鼻音化・流音化・口蓋音化）を先に当ててから写す。
//   같을 → カトゥル、있는 → インヌン、몰라 → モルラ
// 「ㄴ」が挟まる発音（색연필 → 생년필）のような、語の切れ目を知らないと
// 決まらない例外は扱わない。
//
// 歌詞を描く時に decorate() でハングルの塊を span.lyric-ko[data-ruby] で包んでおき、
// （YouTube の字幕（CC）は、この中で字幕の入れ物を見張って同じように包む）
// 表示の入り切りは <html> の yti-korean-ruby クラスだけで行う（CSS の ::before で上に出す）。
// 切っている間の span はただのインラインなので、行の折り返しは変わらない。
// カラオケ塗り（background-clip: text）は子孫の字にも掛かるので、ルビも一緒に塗られる。
//
// content.js より先に読み込まれる。content.js からは ytiKoreanRuby.decorate(el) と
// ytiKoreanRuby.setEnabled(on) / ytiKoreanRuby.applyTo(doc) を使う。

const YTI_KOREAN_RUBY_KEY = 'mv_korean_ruby'; // 既定OFF

const ytiKoreanRuby = (() => {
  const HANGUL_RUN = /[가-힣]+/g;
  const HAS_HANGUL = /[가-힣]/;

  // ── 字母と音の変化 ───────────────────────────────────────
  // 初声: ㄱ0 ㄲ1 ㄴ2 ㄷ3 ㄸ4 ㄹ5 ㅁ6 ㅂ7 ㅃ8 ㅅ9 ㅆ10 ㅇ11 ㅈ12 ㅉ13 ㅊ14 ㅋ15 ㅌ16 ㅍ17 ㅎ18
  // 終声: なし0 ㄱ1 ㄲ2 ㄳ3 ㄴ4 ㄵ5 ㄶ6 ㄷ7 ㄹ8 ㄺ9 ㄻ10 ㄼ11 ㄽ12 ㄾ13 ㄿ14 ㅀ15
  //       ㅁ16 ㅂ17 ㅄ18 ㅅ19 ㅆ20 ㅇ21 ㅈ22 ㅊ23 ㅋ24 ㅌ25 ㅍ26 ㅎ27
  // 終声を [残る終声, 次の字へ移る初声] に分ける（連音）。ㅇ は移らない。
  const SPLIT = {
    1: [0, 0], 2: [0, 1], 3: [1, 9], 4: [0, 2], 5: [4, 12], 6: [4, 18], 7: [0, 3], 8: [0, 5],
    9: [8, 0], 10: [8, 6], 11: [8, 7], 12: [8, 9], 13: [8, 16], 14: [8, 17], 15: [8, 18],
    16: [0, 6], 17: [0, 7], 18: [17, 9], 19: [0, 9], 20: [0, 10], 21: [21, -1], 22: [0, 12],
    23: [0, 14], 24: [0, 15], 25: [0, 16], 26: [0, 17], 27: [0, 18],
  };
  // 終声の代表音
  const REP = {
    0: '', 1: 'k', 2: 'k', 3: 'k', 4: 'n', 5: 'n', 6: 'n', 7: 't', 8: 'l', 9: 'k', 10: 'm',
    11: 'l', 12: 'l', 13: 'l', 14: 'p', 15: 'l', 16: 'm', 17: 'p', 18: 'p', 19: 't', 20: 't',
    21: 'ng', 22: 't', 23: 't', 24: 'k', 25: 't', 26: 'p', 27: 't',
  };
  const K_FINAL = new Set([1, 2, 3, 9, 24]);
  const H_FINAL = new Set([27, 6, 15]);

  const decompose = (ch) => {
    const c = ch.codePointAt(0) - 0xAC00;
    return { l: Math.floor(c / 588), v: Math.floor((c % 588) / 28), t: c % 28 };
  };

  // 綴りの規則だけでは決まらない読み（語の切れ目・漢字語・ㄴの挿入）。歌詞によく出るものを、
  // 聞こえる音の綴りに置き換えてから規則を当てる（語の一部として出てきても効くように前方一致で）。
  const EXCEPTIONS = [
    ['꽃잎', '꼰닙'], ['솜이불', '솜니불'], ['눈빛', '눈삗'], ['손길', '손낄'], ['발길', '발낄'], ['물결', '물껼'],
    ['눈길', '눈낄'], ['맛없', '마덥'], ['멋없', '머덥'], ['끝없', '끄덥'], ['맛있', '마싣'], ['멋있', '머싣'],
    ['할게', '할께'], ['갈게', '갈께'], ['볼게', '볼께'], ['줄게', '줄께'], ['될게', '될께'], ['올게', '올께'],
    ['있을게', '이쓸께'], ['할걸', '할껄'], ['갈걸', '갈껄'], ['솔직히', '솔찌키'], ['문법', '문뻡'], ['용돈', '용똔'],
    ['잠자리', '잠짜리'], ['길가', '길까'], ['밤길', '밤낄'], ['봄비', '봄삐'], ['산새', '산쌔'], ['그믐달', '그믐딸'],
    ['색연필', '생년필'], ['한여름', '한녀름'], ['나뭇잎', '나문닙'], ['깻잎', '깬닙'], ['앞일', '암닐'], ['내일', '내일'],
  ];
  const applyExceptions = (word) => {
    let w = word;
    for (const [from, to] of EXCEPTIONS) if (w.includes(from)) w = w.split(from).join(to);
    return w;
  };

  // 1 語（ハングルの塊）の中で音の変化を当てる。
  const soundSyllables = (word) => {
    const syl = Array.from(applyExceptions(word)).map(ch => (HAS_HANGUL.test(ch) ? decompose(ch) : { raw: ch }));
    for (let i = 0; i < syl.length - 1; i++) {
      const a = syl[i];
      const b = syl[i + 1];
      if (a.raw !== undefined || b.raw !== undefined || !a.t) continue;
      if (H_FINAL.has(a.t)) {
        const keep = a.t === 6 ? 4 : a.t === 15 ? 8 : 0;
        if (b.l === 0) { a.t = keep; b.l = 15; continue; }          // ㅎ+ㄱ → ㅋ
        if (b.l === 3) { a.t = keep; b.l = 16; continue; }          // ㅎ+ㄷ → ㅌ
        if (b.l === 12) { a.t = keep; b.l = 14; continue; }         // ㅎ+ㅈ → ㅊ
        if (b.l === 11) { a.t = 0; if (keep) b.l = keep === 4 ? 2 : 5; continue; } // 좋아 → 조아、잃은 → 이른
        if (b.l === 2) { a.t = keep || 4; if (keep === 8) b.l = 5; continue; }     // 놓는 → 논는
        if (b.l === 9) { a.t = keep; b.l = 10; continue; }          // ㅎ+ㅅ → ㅆ
        if (b.l >= 14 && b.l <= 17) { a.t = keep; continue; }       // 놓쳐 → 노처
      }
      if (b.l === 18) {                                              // 激音化: ㄱㄷㅂㅈ + ㅎ
        let asp = null;
        if (K_FINAL.has(a.t)) asp = 15;
        else if (a.t === 22 || a.t === 23) asp = 14;
        else if (a.t === 7 || a.t === 19) asp = 16;
        else if (a.t === 17 || a.t === 26) asp = 17;
        if (asp !== null) { b.l = asp; a.t = a.t === 9 ? 8 : 0; continue; }
      }
      if (b.l === 11 && b.v === 20 && (a.t === 7 || a.t === 25)) {   // 口蓋音化: 굳이 → 구지
        b.l = a.t === 7 ? 12 : 14;
        a.t = 0;
        continue;
      }
      if (b.l === 11) {                                              // 連音
        const s = SPLIT[a.t];
        if (s && s[1] >= 0) { a.t = s[0]; b.l = s[1]; }
        continue;
      }
      const rep = REP[a.t];
      if (b.l === 2 || b.l === 6) {                                  // 鼻音化・流音化（ㄴ ㅁ の前）
        if (rep === 'k') a.t = 21;
        else if (rep === 't') a.t = 4;
        else if (rep === 'p') a.t = 16;
        else if (rep === 'l' && b.l === 2) b.l = 5;
        continue;
      }
      if (b.l === 5) {                                               // ㄹ の前
        if (rep === 'n') { a.t = 8; continue; }
        if (rep === 'm' || rep === 'ng') { b.l = 2; continue; }
        if (rep === 'k') { a.t = 21; b.l = 2; continue; }
        if (rep === 'p') { a.t = 16; b.l = 2; continue; }
        if (rep === 't') { a.t = 4; b.l = 2; continue; }
      }
    }
    return syl;
  };

  // ── カタカナ ────────────────────────────────────────────
  // 母音ごとの段。子音の行と掛け合わせる。ㅓ/ㅗ はどちらもオ、ㅡ/ㅜ はどちらもウ
  // （日本語に無い音なので、ファンのカナルビと同じく近い音で書く）。
  const VOWEL_KANA = ['ア', 'エ', 'ヤ', 'イェ', 'オ', 'エ', 'ヨ', 'イェ', 'オ', 'ワ', 'ウェ', 'ウェ', 'ヨ', 'ウ', 'ウォ', 'ウェ', 'ウィ', 'ユ', 'ウ', 'ウィ', 'イ'];
  const row = (a, e, ya, ye, o, yo, u, wa, we, wo, wi, yu, i) => [a, e, ya, ye, o, e, yo, ye, o, wa, we, we, yo, u, wo, we, wi, yu, u, wi, i];
  const ROWS = {
    k: row('カ', 'ケ', 'キャ', 'キェ', 'コ', 'キョ', 'ク', 'クァ', 'クェ', 'クォ', 'クィ', 'キュ', 'キ'),
    g: row('ガ', 'ゲ', 'ギャ', 'ギェ', 'ゴ', 'ギョ', 'グ', 'グァ', 'グェ', 'グォ', 'グィ', 'ギュ', 'ギ'),
    n: row('ナ', 'ネ', 'ニャ', 'ニェ', 'ノ', 'ニョ', 'ヌ', 'ヌァ', 'ヌェ', 'ヌォ', 'ヌィ', 'ニュ', 'ニ'),
    t: row('タ', 'テ', 'テャ', 'テェ', 'ト', 'ティョ', 'トゥ', 'トァ', 'トェ', 'トォ', 'ティ', 'テュ', 'ティ'),
    d: row('ダ', 'デ', 'デャ', 'デェ', 'ド', 'ディョ', 'ドゥ', 'ドァ', 'ドェ', 'ドォ', 'ディ', 'デュ', 'ディ'),
    r: row('ラ', 'レ', 'リャ', 'リェ', 'ロ', 'リョ', 'ル', 'ルァ', 'ルェ', 'ルォ', 'ルィ', 'リュ', 'リ'),
    m: row('マ', 'メ', 'ミャ', 'ミェ', 'モ', 'ミョ', 'ム', 'ムァ', 'ムェ', 'ムォ', 'ムィ', 'ミュ', 'ミ'),
    p: row('パ', 'ペ', 'ピャ', 'ピェ', 'ポ', 'ピョ', 'プ', 'プァ', 'プェ', 'プォ', 'プィ', 'ピュ', 'ピ'),
    b: row('バ', 'ベ', 'ビャ', 'ビェ', 'ボ', 'ビョ', 'ブ', 'ブァ', 'ブェ', 'ブォ', 'ブィ', 'ビュ', 'ビ'),
    s: row('サ', 'セ', 'シャ', 'シェ', 'ソ', 'ショ', 'ス', 'スァ', 'スェ', 'スォ', 'スィ', 'シュ', 'シ'),
    j: row('ジャ', 'ジェ', 'ジャ', 'ジェ', 'ジョ', 'ジョ', 'ジュ', 'ジュァ', 'ジュェ', 'ジュォ', 'ジュィ', 'ジュ', 'ジ'),
    ch: row('チャ', 'チェ', 'チャ', 'チェ', 'チョ', 'チョ', 'チュ', 'チュァ', 'チュェ', 'チュォ', 'チュィ', 'チュ', 'チ'),
    h: row('ハ', 'ヘ', 'ヒャ', 'ヒェ', 'ホ', 'ヒョ', 'フ', 'ファ', 'フェ', 'フォ', 'フィ', 'ヒュ', 'ヒ'),
  };
  // 語頭（または前に終声がある時）は清音、語中は濁音に聞こえる（바보 パボ、사진 サジン）
  const kanaRow = (l, voiced) => {
    switch (l) {
      case 0: return voiced ? 'g' : 'k';
      case 3: return voiced ? 'd' : 't';
      case 7: return voiced ? 'b' : 'p';
      case 12: return voiced ? 'j' : 'ch';
      case 1: case 15: return 'k';
      case 2: return 'n';
      case 4: case 16: return 't';
      case 5: return 'r';
      case 6: return 'm';
      case 8: case 17: return 'p';
      case 9: case 10: return 's';
      case 13: case 14: return 'ch';
      case 18: return 'h';
      default: return null;  // ㅇ
    }
  };
  const FINAL_KANA = { k: 'ク', t: 'ッ', p: 'プ', n: 'ン', l: 'ル', m: 'ム', ng: 'ン' };
  const TENSE = new Set([1, 4, 8, 10, 13]);   // ㄲ ㄸ ㅃ ㅆ ㅉ

  const kanaWord = (word) => {
    const syl = soundSyllables(word);
    let out = '';
    syl.forEach((s, i) => {
      if (s.raw !== undefined) { out += s.raw; return; }
      const prev = i > 0 && syl[i - 1].raw === undefined ? syl[i - 1] : null;
      const voiced = !!prev && (!prev.t || [4, 8, 16, 21].includes(prev.t));
      // 濃音は、前の字に終声が無ければ「ッ」を前に置く（오빠 オッパ、있어 イッソ）
      if (TENSE.has(s.l) && prev && !prev.t) out += 'ッ';
      let v = s.v;
      // 의: 語頭はウィ、語末（助詞）はエ、子音の後や語中はイ（희망 ヒマン、서로의 ソロエ）
      if (v === 19) {
        if (s.l !== 11) v = 20;
        else if (prev) v = i === syl.length - 1 ? 5 : 20;
      }
      const r = kanaRow(s.l, voiced);
      out += r ? ROWS[r][v] : VOWEL_KANA[v];
      const f = REP[s.t];
      if (f) out += FINAL_KANA[f];
    });
    return out;
  };

  // ── ローマ字（改訂ローマ字表記・聞こえる音で） ───────────────────
  const L_LATIN = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
  const V_LATIN = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
  const latinWord = (word) => {
    const syl = soundSyllables(word);
    let out = '';
    syl.forEach((s, i) => {
      if (s.raw !== undefined) {
        out += s.raw;
        return;
      }
      // ㄹ の後の ㄹ は l（몰라 → molla）
      const init = (s.l === 5 && i > 0 && syl[i - 1].t === 8) ? 'l' : L_LATIN[s.l];
      out += init + V_LATIN[s.v] + REP[s.t];
    });
    return out;
  };
  // 行全体（ハングル以外はそのまま）
  const romanize = (text) => String(text || '').replace(HANGUL_RUN, (m) => latinWord(m));

  // ── 表示 ────────────────────────────────────────────────
  // 要素の中のハングルの塊を span.lyric-ko で包み、data-ruby に読みを入れる。
  // 何度呼んでも二重に包まない。
  const decorate = (el) => {
    if (!el || !HAS_HANGUL.test(el.textContent || '')) return;
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (HAS_HANGUL.test(n.data) && !(n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('lyric-ko'))) {
        nodes.push(n);
      }
    }
    for (const node of nodes) {
      const text = node.data;
      const frag = doc.createDocumentFragment();
      let at = 0;
      for (const m of text.matchAll(HANGUL_RUN)) {
        if (m.index > at) frag.appendChild(doc.createTextNode(text.slice(at, m.index)));
        const span = doc.createElement('span');
        span.className = 'lyric-ko';
        span.textContent = m[0];
        span.dataset.ruby = kanaWord(m[0]);
        frag.appendChild(span);
        at = m.index + m[0].length;
      }
      if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
      node.parentNode.replaceChild(frag, node);
    }
  };

  const isEnabled = () => localStorage.getItem(YTI_KOREAN_RUBY_KEY) === 'true';

  // 入り切りのクラスを付ける。Mini Player（別ウィンドウ）の document にも使う。
  const applyTo = (doc) => {
    if (doc && doc.documentElement) doc.documentElement.classList.toggle('yti-korean-ruby', isEnabled());
  };

  // ── YouTube の字幕（CC）──────────────────────────────────
  // プレイヤーは字幕の行（.ytp-caption-segment）を表示のたびに作り直すので、
  // 字幕の入れ物を見張って、ハングルを含む行が出てきたら包む。
  // 包んだ分の書き換えでもう一度呼ばれるが、包み済みの字は飛ばすので一度で止まる。
  // 入れ物はプレイヤーごと作り直されることがあるので、1秒ごとに付け直しを確かめる。
  let ccContainer = null;
  let ccObserver = null;

  const decorateCaptions = () => {
    if (!ccContainer || !isEnabled()) return;
    ccContainer.querySelectorAll('.ytp-caption-segment').forEach(decorate);
  };

  const watchCaptions = () => {
    const c = document.querySelector('#movie_player .ytp-caption-window-container');
    if (c === ccContainer) return;
    if (ccObserver) ccObserver.disconnect();
    ccContainer = c;
    ccObserver = null;
    if (!c) return;
    ccObserver = new MutationObserver(decorateCaptions);
    ccObserver.observe(c, { childList: true, subtree: true, characterData: true });
    decorateCaptions();
  };

  const setEnabled = (on) => {
    localStorage.setItem(YTI_KOREAN_RUBY_KEY, on ? 'true' : 'false');
    applyTo(document);
    decorateCaptions();
  };

  // プレイヤーの歯車メニューにも入り切りを置く（letterbox.js の「黒帯カット」と同じ作り）。
  // メニューが開く直前（pointerdown）に入れておくと、YouTubeが測るメニューの高さに含まれる。
  const ensureMenuItem = () => {
    const menu = document.querySelector('#movie_player .ytp-settings-menu');
    if (!menu) return;
    let main = null;
    for (const panel of menu.querySelectorAll('.ytp-panel')) {
      if (panel.querySelector('.ytp-panel-header')) continue; // サブメニュー（画質など）
      main = panel.querySelector('.ytp-panel-menu');
      if (main) break;
    }
    if (!main) return;
    let item = main.querySelector('.yti-ko-ruby-menuitem');
    if (!item) {
      item = document.createElement('div');
      item.className = 'ytp-menuitem yti-ko-ruby-menuitem';
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', '韓国語の読み');
      item.innerHTML =
        '<div class="ytp-menuitem-icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M8 4.5h8M4 20V11h7v9M13 11h7v9h-7"/></svg></div>' +
        '<div class="ytp-menuitem-label">韓国語の読み</div>' +
        '<div class="ytp-menuitem-content"><div class="ytp-menuitem-toggle-checkbox"></div></div>';
      const toggle = (e) => {
        e.stopPropagation();
        e.preventDefault();
        setEnabled(!isEnabled());
        item.setAttribute('aria-checked', String(isEnabled()));
      };
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') toggle(e);
      });
      // 「黒帯カット」があればその直後、無ければトグル群の直後に置く
      const lbxItem = main.querySelector('.yti-lbx-menuitem');
      const toggles = main.querySelectorAll('.ytp-menuitem[role="menuitemcheckbox"]:not(.yti-ko-ruby-menuitem)');
      if (lbxItem) lbxItem.after(item);
      else if (toggles.length) toggles[toggles.length - 1].after(item);
      else main.prepend(item);
    }
    item.setAttribute('aria-checked', String(isEnabled()));
  };

  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest('.ytp-settings-button')) ensureMenuItem();
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest && e.target.closest('.ytp-settings-button')) {
      ensureMenuItem();
    }
  }, true);

  applyTo(document);
  watchCaptions();
  setInterval(watchCaptions, 1000);

  return { decorate, applyTo, setEnabled, isEnabled, readingOf: kanaWord, romanize };
})();
