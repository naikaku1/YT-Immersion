// ===== 外部歌詞の音声による自動同期 =====
// LRCLIB / NetEase の歌詞は原曲（音源）の時計で付いているため、MVのイントロ映像や
// 曲の途中に挟まる映像パートの分だけズレる。ASR（自動生成字幕）が取れる曲は
// それと照合して合わせる（content.js: autoAlignWithAsr）が、取れない曲のために
// 再生中の音声だけを見て、次のことを推定する。
//   1) 曲の始まり
//      a. 語りや環境音のイントロ映像が終わり、音楽が途切れずに鳴り始めた時刻
//      b. MV独自の前奏（音楽）の後に一瞬の無音を挟んで本編が始まる場合の、その無音の直後
//   2) 映像パートの挿入：曲の途中で、本来は歌が入るはずの所に挟まった区間
// 「音楽が鳴っている」かは音量の大きさではなく、途切れずに鳴り続けているかで見る。
// 語り（セリフ）は声量こそ曲に近いが、言葉の切れ目ごとに音が落ちる（無音になる）。
// 推定に使えるのは「MVの尺 − 原曲の尺」までなので、それを超える補正はしない。
// video.captureStream() で音声を読むだけなので、聞こえる音には一切手を加えない。
//
// 外部歌詞が見つかるまでには通信の分だけ時間がかかり、その間に曲の冒頭が過ぎてしまう。
// そこで曲の読み込み開始時に prime() で音量の記録だけを先に始めておき、
// 歌詞が見つかったら start() でその記録を引き継いで判定する。
// 曲の始まりを判定している間は isHoldingIntro() が true を返す。content.js は
// その間、歌詞を進めずに前奏表示のまま待たせる（補正前の時刻で歌詞が先走らないように）。
//
// 負荷について：音量の読み取りは20Hzだが、判定（過去の記録の走査）は記録の刻み
// （0.25秒）が進んだ時だけ行い、ピーク音量の集計も1秒に1回だけ作り直す。
//
// content.js から ytiAudioSync.prime(video, key) / start({...}) / stop() で使う。

const ytiAudioSync = (() => {
  const BIN = 0.25;          // 音量を記録する時間の刻み（秒、動画の再生位置基準）
  const SMOOTH_BINS = 4;     // 1秒の移動平均で見る
  const NEAR_PEAK = 15;      // 曲のピーク音量からこのdB以内なら「音楽が鳴っている」候補
  const DROP_BELOW_PEAK = 30; // 刻みの中で一瞬でもピークよりこれ以上落ちたら「途切れた」
  const SILENCE_BELOW_PEAK = 45; // 前奏と本編の間の「無音」とみなす深さ
  const MIN_RUN = 4;         // 「鳴り始めた」とみなす、途切れずに鳴り続ける時間（秒）
  const QUICK_RUN = 1.25;    // 冒頭から曲が鳴っている時は、これだけ聞けば判断する（秒）
  const RESUME_RUN = 1.5;    // 映像パートの後、曲が戻ったとみなす連続時間（秒）
  const MIN_BREAK = 2.5;     // 映像パートとみなす静かな区間の最短（秒）
  const MUSIC_LEVEL = -40;   // 曲が鳴っている時の音量の下限の目安（dBFS、音量設定には左右されない）
  // 推定方法を変えたら上げる。古い方法で推定して保存された補正は読み込み時に捨てる
  const AUDIO_SYNC_VERSION = 4;

  let audioCtx = null;
  let st = null;

  function getContext() {
    if (!audioCtx) {
      try {
        audioCtx = new AudioContext();
      } catch (e) {
        audioCtx = null;
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // 音量の記録だけを始める（判定はしない）。key は動画ID。
  function prime(video, key) {
    if (st && st.v === video && st.key === key) return true;
    stop();
    if (!video || typeof video.captureStream !== 'function') return false;
    if (!getContext()) return false;
    st = {
      key,
      opts: null,
      v: video,
      bins: new Map(),       // binIndex -> { sum, n, min }（dB）
      coverEnd: -1,          // 0秒からこの刻みまでは途切れずに記録できている
      lastBin: -1,
      peak: null,
      peakAt: 0,
      graph: null,
      timer: null,
      introDone: false,
      offset: 0,
      anchors: [],
      quietFrom: -1,
      dropoutWatchUntil: -1,
      silentSince: Date.now(),
      startedAt: Date.now(),
    };
    const onSeeking = () => {
      if (st) st.quietFrom = -1;
    };
    // 同じvideo要素で次の動画の読み込みが始まったら、前の動画の記録は捨てる。
    // 前の動画から取った音声ストリームは無音になるので、取り直す。
    const onLoadStart = () => {
      if (!st) return;
      st.bins.clear();
      st.coverEnd = -1;
      st.lastBin = -1;
      st.peak = null;
      st.quietFrom = -1;
      disconnect();
    };
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('loadstart', onLoadStart);
    st.onSeeking = onSeeking;
    st.onLoadStart = onLoadStart;
    st.timer = setInterval(tick, 50);
    return true;
  }

  // 判定を始める。prime() 済みの同じ動画なら、それまでの記録を引き継ぐ。
  // opts: { video, key, lrcLines:[{baseTime}], trackDuration, onAnchors(anchors, kind) }
  function start(opts) {
    const v = opts && opts.video;
    if (!v) return false;
    const videoDur = isFinite(v.duration) ? v.duration : 0;
    const trackDur = opts.trackDuration || 0;
    // 挿入された映像パートの合計として許される最大値（原曲の尺が分からなければイントロのみ60秒まで）
    const budget = (videoDur > 0 && trackDur > 0) ? (videoDur - trackDur) + 3 : 60;
    if (budget < 1.5) { // MVと原曲の尺がほぼ同じ＝ズレる余地がない
      stop();
      return false;
    }
    if (!prime(v, opts.key)) return false;
    Object.assign(st, { opts, videoDur, trackDur, budget, introDone: false, offset: 0, anchors: [], dropoutWatchUntil: -1 });
    st.lastBin = -1; // 次の刻みで、溜まっている記録をまとめて判定する
    return true;
  }

  function stop() {
    if (!st) return;
    clearInterval(st.timer);
    if (st.onSeeking) st.v.removeEventListener('seeking', st.onSeeking);
    if (st.onLoadStart) st.v.removeEventListener('loadstart', st.onLoadStart);
    disconnect();
    st = null;
  }

  // この動画の音量を記録中か（視聴ページで再生が始まった時から先に記録しておくため）
  function primedKey() {
    return st ? st.key : '';
  }

  // 曲の始まりを判定中で、歌詞を進めずに待たせるべきか
  function isHoldingIntro() {
    if (!st || !st.opts || st.introDone) return false;
    // 曲の頭から聞けていない時は判定できないので、待たせない
    const cur = Math.floor(st.v.currentTime / BIN);
    return st.coverEnd >= cur - 2;
  }

  function connect() {
    if (st.graph) return true;
    try {
      const stream = st.v.captureStream();
      if (!stream.getAudioTracks().length) return false;
      const ctx = audioCtx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // 解析ノードを動かし続けるため出力へ繋ぐが、音量0なので何も鳴らない
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(ctx.destination);
      // 歌声の帯域（300〜3400Hz）の強さも記録する。歌い出し（行の頭）で強くなるので、
      // 歌詞の行の頭の並びと突き合わせると、映像パートで曲の始まりが隠れていても位置が分かる
      const binHz = ctx.sampleRate / analyser.fftSize;
      st.graph = {
        stream, source, analyser, sink, buf: new Float32Array(analyser.fftSize),
        freq: new Float32Array(analyser.frequencyBinCount),
        vLo: Math.max(1, Math.floor(300 / binHz)), vHi: Math.min(analyser.frequencyBinCount - 1, Math.ceil(3400 / binHz)),
      };
      return true;
    } catch (e) {
      return false;
    }
  }

  function disconnect() {
    if (!st || !st.graph) return;
    const g = st.graph;
    try {
      g.source.disconnect();
      g.analyser.disconnect();
      g.sink.disconnect();
    } catch (e) {}
    try {
      g.stream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    st.graph = null;
  }

  function levelOf(bi) {
    const b = st.bins.get(bi);
    return b ? b.sum / b.n : null;
  }

  // 1秒の移動平均（記録の無い刻みは飛ばす）
  function smoothed(bi) {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < SMOOTH_BINS; k++) {
      const l = levelOf(bi + k);
      if (l !== null) {
        sum += l;
        n++;
      }
    }
    return n ? sum / n : null;
  }

  // 観測済みの音量の上位5%＝この曲が「鳴っている」時の音量の目安。
  // 全刻みを並べ替えるので、1秒に1回だけ作り直す。
  function peakLevel(uptoBi) {
    if (st.peak !== null && uptoBi - st.peakAt < 4) return st.peak;
    const arr = [];
    for (let k = 0; k <= uptoBi; k++) {
      const l = smoothed(k);
      if (l !== null) arr.push(l);
    }
    if (arr.length < 16) return null;
    arr.sort((a, b) => a - b);
    st.peak = arr[Math.floor(arr.length * 0.95)];
    st.peakAt = uptoBi;
    return st.peak;
  }

  // その刻み（0.25秒）の間、音楽として鳴り続けていたか。
  // ピーク音量との比較だけだと、曲が鳴り始める前（ピークがまだ静かなイントロの音量）に
  // 静かな環境音まで「音楽」と見なしてしまうので、音楽らしい絶対的な音量も要求する。
  function isMusicBin(bi, peak) {
    const b = st.bins.get(bi);
    if (!b || b.n < 2) return false;
    const mean = b.sum / b.n;
    return b.min >= peak - DROP_BELOW_PEAK && mean >= peak - NEAR_PEAK && mean >= MUSIC_LEVEL;
  }

  function tick() {
    if (!st) return;
    const v = st.v;
    if (!v.isConnected) {
      stop();
      return;
    }
    if (v.paused || v.seeking || v.readyState < 3) return;
    if (!connect()) return;
    if (audioCtx.state !== 'running') {
      audioCtx.resume().catch(() => {});
      return;
    }
    const g = st.graph;
    g.analyser.getFloatTimeDomainData(g.buf);
    let sum = 0;
    for (let i = 0; i < g.buf.length; i++) sum += g.buf[i] * g.buf[i];
    const rms = Math.sqrt(sum / g.buf.length);
    // 完全な無音（-∞）が平均を支配しないよう -90dB で頭打ちにする
    const db = rms > 3e-5 ? 20 * Math.log10(rms) : -90;
    // 歌声の帯域の強さ（dB）
    g.analyser.getFloatFrequencyData(g.freq);
    let vp = 0;
    for (let i = g.vLo; i <= g.vHi; i++) vp += Math.pow(10, g.freq[i] / 10);
    const vdb = vp > 0 ? 10 * Math.log10(vp / (g.vHi - g.vLo + 1)) : -120;
    const t = v.currentTime;
    const bi = Math.floor(t / BIN);
    const cell = st.bins.get(bi);
    if (cell) {
      cell.sum += db;
      cell.n++;
      if (db < cell.min) cell.min = db;
      cell.vsum += vdb;
      cell.vn++;
    } else {
      st.bins.set(bi, { sum: db, n: 1, min: db, vsum: vdb, vn: 1 });
      while (st.bins.has(st.coverEnd + 1)) st.coverEnd++;
    }
    // 音が取れない環境（キャプチャが常に無音）では何も推定できないので早めに諦める
    if (db > -90) st.silentSince = Date.now();
    else if (Date.now() - st.silentSince > 10000 && !v.muted && v.volume > 0) {
      console.info('[YT Immersion] 音声を取得できないため、音声による自動同期を停止しました');
      stop();
      return;
    }
    if (!st.opts) {
      // 歌詞が見つからないまま8分経ったら記録もやめる（外部歌詞を使わない曲）。
      // 視聴ページの再生開始から記録しているので、MV モードに入るのが遅くても間に合うよう長めに持つ。
      if (Date.now() - st.startedAt > 480000) stop();
      return;
    }
    // 判定は刻みが進んだ時だけ（20Hzの毎回では行わない）
    if (bi === st.lastBin) return;
    st.lastBin = bi;
    if (!st.introDone) detectIntro(bi);
    else {
      if (st.vocalPending) detectByVocals(bi);
      if (st.dropoutWatchUntil >= 0) detectDropoutStart(bi);
      if (st) detectBreak(bi);
    }
  }

  function coveredFromStart(bi) {
    return st.coverEnd >= bi;
  }

  // 冒頭から曲が鳴っていると判断した。オフセット0のまま進め、
  // 前奏（MV独自）→一瞬の無音→本編 という構成でないかを、許される範囲で見張り続ける。
  function concludeMusicFromStart() {
    st.introDone = true;
    // 音量では「冒頭から曲」に見えても、映像パートの BGM のことがある。歌声の並びで確かめる
    st.vocalPending = true;
    st.dropoutWatchUntil = Math.min(st.budget, 60);
  }

  // 曲の始まりを探す。途切れずに鳴り続ける区間が MIN_RUN 秒以上続いた最初の時刻。
  function detectIntro(bi) {
    const t = bi * BIN;
    const limit = Math.min(st.budget, 90);
    if (t > limit + MIN_RUN + 6) {
      // 曲の頭から聞けていない（途中から再生した）時は、イントロの長さが分からない。
      // その状態で間奏を推定すると前提のズレが積み重なるだけなので、何もせずに終える。
      if (!coveredFromStart(Math.floor(limit / BIN))) {
        stop();
        return;
      }
      // 許される範囲内で鳴り始めが見つからなかった。補正しない（0のまま）が、歌声の並びでは探す
      st.introDone = true;
      st.vocalPending = true;
      return;
    }
    if (!coveredFromStart(bi)) return;
    // 冒頭（0.5秒以内）から QUICK_RUN 秒、音楽らしい音量で途切れずに鳴っているなら、
    // ピーク音量の集計（4秒分必要）を待たずにすぐ「冒頭から曲」と判断する。
    // 歌い出しが曲の頭にある曲で、判定待ちのせいで歌詞が遅れないようにするため。
    const quickBins = Math.round(QUICK_RUN / BIN);
    if (bi >= quickBins + 2) {
      let sum = 0;
      let minDb = 0;
      let n = 0;
      for (let j = 0; j < quickBins + 2; j++) {
        const b = st.bins.get(j);
        if (!b) continue;
        sum += b.sum / b.n;
        n++;
        if (j >= 2) minDb = Math.min(minDb, b.min);
      }
      const mean = n ? sum / n : -120;
      if (mean >= MUSIC_LEVEL && minDb >= mean - DROP_BELOW_PEAK + 5) {
        concludeMusicFromStart();
        return;
      }
    }
    if (t < MIN_RUN + 1) return;
    const peak = peakLevel(bi);
    if (peak === null || peak < -60) return;
    const runBins = Math.round(MIN_RUN / BIN);
    for (let k = 0; k + runBins <= bi; k++) {
      let miss = 0;
      for (let j = k; j < k + runBins && miss <= 1; j++) {
        if (!isMusicBin(j, peak)) miss++;
      }
      if (miss > 1) continue;
      // 1刻みだけの取りこぼしを許しているので、実際に鳴り始めた刻みまで進める
      let first = k;
      while (first < k + runBins - 1 && !isMusicBin(first, peak)) first++;
      const startT = first * BIN;
      if (startT > limit) {
        st.introDone = true;
        return;
      }
      // それより前が「途切れがちな音（語り・効果音）」か「静か」なら、映像のイントロとみなす
      let gappy = 0;
      for (let j = 0; j < first; j++) {
        if (!isMusicBin(j, peak)) gappy++;
      }
      const introLike = first > 0 && gappy >= first * 0.5;
      if (startT < 1.5 || !introLike) {
        // 冒頭から鳴っている。ただし静かなイントロしかまだ聞いていない段階では、
        // その音を「曲」と取り違えているだけかもしれないので、
        // 音楽らしい音量を一度でも観測するまでは結論を出さない。
        if (peak >= MUSIC_LEVEL) concludeMusicFromStart();
        return;
      }
      st.introDone = true;
      st.offset = startT;
      st.anchors = [{ lrcTime: 0, videoTime: startT, src: 'audio', ver: AUDIO_SYNC_VERSION }];
      emit('intro');
      return;
    }
  }

  // MV独自の前奏（音楽）の後、0.5秒以上のほぼ無音を挟んで本編が始まる構成を見つける。
  // 曲の中の短いブレイクは残響が残るので、ここまで深い無音にはまずならない。
  function detectDropoutStart(bi) {
    if (st.offset !== 0 || st.anchors.length) {
      st.dropoutWatchUntil = -1;
      return;
    }
    const t = bi * BIN;
    if (t > st.dropoutWatchUntil + MIN_RUN + 1) {
      st.dropoutWatchUntil = -1;
      return;
    }
    const peak = peakLevel(bi);
    if (peak === null) return;
    // 直近 MIN_RUN 秒が途切れずに鳴っていて、その直前に深い無音があるか
    const runBins = Math.round(MIN_RUN / BIN);
    const runStart = bi - runBins; // 書き込み途中の bi は使わない
    if (runStart < 8) return;
    for (let j = runStart; j < bi; j++) {
      if (!isMusicBin(j, peak)) return;
    }
    // 一瞬でもほぼ無音になった刻みを数える（無音と曲の境目の刻みは半分ずつなので、
    // 平均ではなく最小値で見る）。深い無音が0.5秒以上あること。
    let silent = 0;
    let deep = 0;
    for (let j = runStart - 1; j >= 0 && silent < 12; j--) {
      const b = st.bins.get(j);
      if (!b || b.min > peak - SILENCE_BELOW_PEAK) break;
      silent++;
      if (b.sum / b.n <= peak - SILENCE_BELOW_PEAK) deep++;
    }
    if (silent < 2 || deep < 1) return;
    // 無音の前にも、ある程度の長さの前奏が鳴っていたこと
    const silenceStart = runStart - silent;
    let before = 0;
    for (let j = Math.max(0, silenceStart - 12); j < silenceStart; j++) {
      if (isMusicBin(j, peak)) before++;
    }
    if (before < 8) return;
    const startT = runStart * BIN;
    if (startT < 3 || startT > st.dropoutWatchUntil) return;
    st.dropoutWatchUntil = -1;
    st.offset = startT;
    st.anchors = [{ lrcTime: 0, videoTime: startT, src: 'audio', ver: AUDIO_SYNC_VERSION }];
    emit('intro');
  }

  // 曲の途中で「音楽でない区間」（静か・語りなど途切れがちな音）を見つけ、
  // その間に歌詞が予定されていれば「挿入された映像パート」とみなす。
  function detectBreak(bi) {
    if (!st.trackDur) return;
    const peak = peakLevel(bi);
    if (peak === null) return;
    // 直近の刻みは書き込み途中なので、1つ前までで判断する
    const cur = bi - 1;
    if (cur < 0) return;
    if (!isMusicBin(cur, peak)) {
      if (st.quietFrom < 0) st.quietFrom = cur * BIN;
      return;
    }
    if (st.quietFrom < 0) return;
    // 曲が RESUME_RUN 秒続けて戻ってきたら、映像パートが終わったとみなす
    const resumeBins = Math.round(RESUME_RUN / BIN);
    for (let j = cur - resumeBins + 1; j <= cur; j++) {
      if (!isMusicBin(j, peak)) return;
    }
    const qs = st.quietFrom;
    const qe = (cur - resumeBins + 1) * BIN;
    st.quietFrom = -1;
    const len = qe - qs;
    if (len < MIN_BREAK) return;
    if (len > st.budget - st.offset) return;
    const lrcAtStart = qs - st.offset;
    // 曲が始まって間もない／終わり際は本来の曲の構成として扱う
    if (lrcAtStart < 8 || lrcAtStart > st.trackDur - 8) return;
    const lines = st.opts.lrcLines || [];
    const singingExpected = lines.some(ln => ln.baseTime + st.offset > qs + 0.5 && ln.baseTime + st.offset < qe - 0.5);
    if (!singingExpected) return;
    st.offset += len;
    st.anchors.push({ lrcTime: lrcAtStart, videoTime: qe, src: 'audio', ver: AUDIO_SYNC_VERSION });
    emit('break');
  }

  // ── 歌声の並びによる曲の始まりの推定 ─────────────────────────
  // 行の頭（曲の時計）を o 秒ずらした所に、歌声の帯域の立ち上がりが並ぶ o を探す。
  // 映像パートに BGM が流れていて音量では曲の始まりが分からない MV でも、歌い出しの並びは曲に固有。
  // 確からしい時（他のずらし方より明らかに揃う時）だけ使う。
  function vocalLevel(bi) {
    const b = st.bins.get(bi);
    return (b && b.vn) ? b.vsum / b.vn : null;
  }
  function detectByVocals(bi) {
    if (!coveredFromStart(bi)) {
      st.vocalPending = false;
      return;
    }
    const lines = (st.opts.lrcLines || []).map(l => l.baseTime).filter(t => Number.isFinite(t)).slice(0, 18);
    if (lines.length < 8) {
      st.vocalPending = false;
      return;
    }
    const maxOff = Math.min(st.budget, 150);
    const span = lines[lines.length - 1];
    const observableOff = bi * BIN - span - 1;
    // 確かめられるずらしの範囲が増えた時だけ（8秒ごと）計算する
    if (observableOff < 4 || observableOff - (st.vocalEvalAt || -99) < 8) return;
    st.vocalEvalAt = observableOff;
    const upto = Math.min(maxOff, observableOff);
    // 立ち上がりの強さ（直前の2刻みより強くなった分）
    const onset = [];
    for (let k = 0; k <= bi; k++) {
      const c = vocalLevel(k);
      const p = Math.min(vocalLevel(k - 1) ?? c ?? -120, vocalLevel(k - 2) ?? c ?? -120);
      onset.push(c === null ? 0 : Math.max(0, c - p));
    }
    const scores = [];
    for (let ob = 0; ob * BIN <= upto; ob++) {
      let sum = 0;
      for (const lt of lines) {
        const b = Math.round(lt / BIN) + ob;
        sum += Math.max(onset[b - 1] || 0, onset[b] || 0, onset[b + 1] || 0);
      }
      scores.push(sum / lines.length);
    }
    if (scores.length < 12) return;
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length) || 1;
    let second = 0;
    for (let i = 0; i < scores.length; i++) if (Math.abs(i - best) > 4 && scores[i] > second) second = scores[i];
    const z = (scores[best] - mean) / sd;
    const off = best * BIN;
    if (z >= 5 && scores[best] >= second * 1.2 && Math.abs(off - st.offset) > 1.5) {
      st.vocalPending = false;
      st.offset = off;
      st.anchors = [{ lrcTime: 0, videoTime: off, src: 'audio', ver: AUDIO_SYNC_VERSION }];
      emit('intro');
      return;
    }
    if (upto >= maxOff) st.vocalPending = false;
  }

  function emit(kind) {
    try {
      if (st && st.opts.onAnchors) st.opts.onAnchors(st.anchors.map(a => Object.assign({}, a)), kind);
    } catch (e) {}
  }

  return {
    prime,
    start,
    stop,
    isHoldingIntro,
    isRunning: () => !!(st && st.opts),
    version: AUDIO_SYNC_VERSION, primedKey };
})();
