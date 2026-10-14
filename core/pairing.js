// ===== 共通コア：原文と訳（2本の字幕・歌詞）の行の組み合わせ =====
// 以前は「原文の行の ±1.5 秒以内にある最初の訳の行」を付けていたため、
//   - 速いラップでは1行前の訳が付く
//   - 訳が2行に割れていると後半が消える
// ことがあった。ここでは時間の重なりを点数にして、順序を保ったまま対応を決める
// （動的計画法）。1つの原文の行に訳の行が2つ以上付く（割れた訳をつなぐ）ことも許す。
// 読み込むと globalThis.YTICore.pairing に入る。

(function (root) {
  const YTICore = root.YTICore = root.YTICore || {};

  // 行の区間 [start, end)。end が無ければ次の行の頭（最大 8 秒）まで。
  const intervals = (rows) => rows.map((r, i) => {
    const next = rows[i + 1];
    let end = Number.isFinite(r.end) ? r.end : (next ? next.start : r.start + 4);
    if (next && end > next.start + 0.3) end = Math.max(r.start + 0.3, next.start);
    end = Math.min(end, r.start + 8);
    return { start: r.start, end: Math.max(r.start + 0.2, end), text: r.text };
  });

  function score(m, s) {
    const overlap = Math.max(0, Math.min(m.end, s.end) - Math.max(m.start, s.start));
    const sDur = Math.max(0.2, s.end - s.start);
    const ratio = overlap / sDur;
    const startGap = Math.abs(m.start - s.start);
    if (ratio < 0.25 && startGap > 0.8) return -1;
    return ratio + Math.max(0, 0.5 - startGap * 0.25);
  }

  // main / sub: [{start, end?, text}]（同じ時計）。戻り値: main と同じ長さの配列で、各要素は訳の文字列か null。
  function pairLines(main, sub) {
    const M = intervals(main || []);
    const S = intervals(sub || []);
    const out = new Array(M.length).fill(null);
    if (!M.length || !S.length) return out;
    // dp[j][i]: 訳の j 本目までを、原文の i 行目までに順に割り当てた時の最高点
    // 訳の行は「どれにも付けない」か「直前と同じかそれより後の原文に付ける」。
    const nM = M.length;
    const nS = S.length;
    const NEG = -1e9;
    const dp = Array.from({ length: nS + 1 }, () => new Float64Array(nM + 1).fill(NEG));
    const from = Array.from({ length: nS + 1 }, () => new Int32Array(nM + 1).fill(-1));
    for (let i = 0; i <= nM; i++) dp[0][i] = 0;
    for (let j = 1; j <= nS; j++) {
      // 付けない：原文の位置はそのまま
      let runBest = NEG;
      let runArg = 0;
      for (let i = 0; i <= nM; i++) {
        if (dp[j - 1][i] > runBest) {
          runBest = dp[j - 1][i];
          runArg = i;
        }
        // 付けない場合
        if (dp[j - 1][i] > dp[j][i]) {
          dp[j][i] = dp[j - 1][i];
          from[j][i] = -2 - i; // 付けずに i に留まる
        }
        // 原文 i 行目（1始まり）に付ける：直前の訳は i 以下に居ればよい
        if (i >= 1) {
          const sc = score(M[i - 1], S[j - 1]);
          if (sc > 0) {
            const prevBest = runBest; // max over k<=i of dp[j-1][k]
            if (prevBest + sc > dp[j][i]) {
              dp[j][i] = prevBest + sc;
              from[j][i] = runArg;
            }
          }
        }
      }
    }
    // 終端：いちばん良い i から辿る
    let bestI = 0;
    for (let i = 0; i <= nM; i++) if (dp[nS][i] > dp[nS][bestI]) bestI = i;
    const assign = new Array(nS).fill(-1);
    let i = bestI;
    for (let j = nS; j >= 1; j--) {
      const f = from[j][i];
      if (f <= -2) {
        i = -2 - f;
        continue;
      }
      if (f >= 0) {
        assign[j - 1] = i - 1;
        i = f;
      }
    }
    for (let j = 0; j < nS; j++) {
      const mi = assign[j];
      if (mi < 0) continue;
      const t = String(S[j].text || '').trim();
      if (!t) continue;
      out[mi] = out[mi] ? out[mi] + ' ' + t : t;
    }
    return out;
  }

  YTICore.pairing = { pairLines };
  if (typeof module === 'object' && module.exports) module.exports = YTICore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
