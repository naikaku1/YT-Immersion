/* ==========================================================================
 * YT Immersion — Liquid Glass (リキッドグラス) コアモジュール
 *
 * Aave の "Building Glass for the Web" の手法をベースに、SVG の
 * feDisplacementMap を使った「本物の屈折レンズ」を backdrop-filter で実現する。
 *   参考: https://aave.com/design/building-glass-for-the-web
 *
 * 仕組み:
 *   1. Canvas で角丸矩形レンズの変位マップ (R=横ずれ, G=縦ずれ, 128=中立) を生成。
 *      4回対称なので左上 1/4 だけ計算して残り 3 象限へミラー (計算量 25%)。
 *   2. feImage でマップを読み込み、R/G/B を僅かに違う強さで 3 パス屈折させて
 *      レンズ縁の色収差 (クロマフリンジ) を再現。
 *   3. feGaussianBlur + feColorMatrix(saturate) でフロスト仕上げ。
 *   4. 対象要素には CSS 変数 --yti-lg に url("#id") を書き込むだけ。
 *      実際の適用は style.css 側の「#mv-root-container.lg-on ...」という
 *      クラスゲート付きルールが行う。probe 失敗時は lg-on が付かないので、
 *      既存の blur() 宣言 (Tier 2) にそのままフォールバックする。
 *
 * Tier 構成:
 *   Tier 1: backdrop-filter: url(#...) による真の屈折 (Chromium + data:画像許可時)
 *   Tier 2: 従来の blur()/saturate() 強化版 (style.css の基本ルール)
 *   Tier 3: backdrop-filter 非対応環境 → 半透明背景のみ (既存宣言のまま劣化)
 *
 * パフォーマンス規約 (記事準拠):
 *   - 変位マップの再生成は「サイズが変わった時」だけ (ResizeObserver + debounce)。
 *     位置の変化はコストゼロ (フィルタは要素に追従する)。
 *   - マップ / フィルタはサイズとレシピをキーに共有キャッシュ (同サイズは1個を共用)。
 *   - DPR は 2 でキャップ。
 *   - フィルタ再構築時は毎回新しい id を振る (フィルタ出力キャッシュ対策)。
 *   - 非表示時は style.css 側の .visible / .animate ゲートで参照自体が外れるため
 *     レンズの計算コストが掛からない。
 *
 * 公開 API (window.ytiLiquidGlass):
 *   init(rootEl, hostEl) : defs を冪等に生成し probe → 自動アタッチ開始
 *   destroy()            : オブザーバ等を停止 (defs は rootEl ごと破棄される)
 *   setIntensity(v)      : 0..1 — 既存 Glass スライダーと連動しレンズ深度を更新
 *   refresh()            : 対象を再スキャン (SPA 再描画後などに任意で)
 * ========================================================================== */
(() => {
  'use strict';
  if (window.ytiLiquidGlass) return; // 二重注入ガード

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PREFIX = 'yti-lg';
  const PROP = '--yti-lg'; // 各サーフェスに url("#...") を書き込む CSS 変数
  const GRAIN_ID = 'yti-lg-grain'; // 共有グレイン (feTurbulence / CSP セーフ)
  const DPR_CAP = 2;
  const RESCAN_DELAY = 80; // ms
  const RESIZE_DELAY = 80; // ms

  // 1x1 透明 PNG。ホストページの img-src CSP が data: を許可しているかの probe 用
  // (feImage の data: 読み込みは YouTube 側の CSP に従うため実行時確認が必須)
  const PROBE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // ---- サーフェス種別ごとのレンズレシピ --------------------------------
  //   scale     : レンズ縁での最大変位(px)。ガラスの「深さ」
  //   chroma    : 色収差量 (R/B パスを scale*(1±chroma) で回す)
  //   blur      : フロスト用 feGaussianBlur の stdDeviation
  //   saturate  : 背景の彩度ブースト
  //   bezel     : 屈折する縁バンドの幅(px)
  //   curvature : 変位カーブの指数。大きいほど縁に張り付く
  const RECIPES = {
    pill:   { scale: 26, chroma: 0.22, blur: 2.4, saturate: 1.55, bezel: 15, curvature: 2.2 },
    btn:    { scale: 18, chroma: 0.22, blur: 2.0, saturate: 1.50, bezel: 11, curvature: 2.2 },
    toast:  { scale: 28, chroma: 0.25, blur: 2.6, saturate: 1.60, bezel: 16, curvature: 2.1 },
    circle: { scale: 32, chroma: 0.28, blur: 2.2, saturate: 1.50, bezel: 22, curvature: 1.9 },
    card:   { scale: 34, chroma: 0.20, blur: 3.0, saturate: 1.45, bezel: 22, curvature: 2.4 }
  };

  // 自動アタッチ対象 (セレクタ → レシピ名)。
  // <select> は Tier 2 のまま (フォームウィジェットへの url() フィルタは避ける)。
  const AUTO_TARGETS = [
    ['.mv-glass-btn', 'pill'],
    ['button.mv-lyric-action-btn', 'btn'],
    ['#mv-center-status', 'circle'],
    ['.mv-lg-toast', 'toast'],
    ['.lyric-selection-container', 'card'],
    ['.cheki-controls', 'card']
  ];

  // ---- 内部状態 ----------------------------------------------------------
  let root = null;      // #mv-root-container
  let svgEl = null;     // 隠し <svg> (defs ホスト)
  let defsEl = null;
  let tier1 = false;    // probe 成功で true
  let destroyed = false;
  let intensity = 1;    // Glass スライダー連動係数
  let uid = 0;

  let mutationObs = null;
  let resizeObs = null;
  let rescanTimer = null;
  let resizeTimer = null;
  let lastDpr = window.devicePixelRatio || 1;
  const dirtyEls = new Set();

  const attachedEls = new Map(); // el -> { recipe, filterKey }
  const filterCache = new Map(); // filterKey -> { id, node, base, chroma, refs:Set }
  const mapCache = new Map();    // mapKey -> dataUri (純データなのでセッション跨ぎで保持)

  // ==========================================================================
  // 変位マップ生成 — 角丸矩形の SDF から縁バンドの屈折ベクトルを焼き込む
  //   R: 横方向変位 / G: 縦方向変位 / 128 = 変位なし
  //   左上 1/4 象限のみ計算し、X 反転で R を、Y 反転で G を符号反転してミラー
  // ==========================================================================
  function generateDisplacementMap(w, h, radius, bezel, curvature) {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const mapW = Math.max(2, Math.round(w * dpr));
    const mapH = Math.max(2, Math.round(h * dpr));
    const r = Math.min(radius * dpr, mapW / 2, mapH / 2);
    const bez = Math.max(2, Math.min(bezel * dpr, mapW / 2, mapH / 2));
    const cv = document.createElement('canvas');
    cv.width = mapW;
    cv.height = mapH;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(mapW, mapH);
    const d = img.data;
    const halfW = Math.ceil(mapW / 2);
    const halfH = Math.ceil(mapH / 2);
    const cx = mapW / 2;
    const cy = mapH / 2;
    // 角丸矩形 SDF: 直線エッジ部分の半長
    const ex = mapW / 2 - r;
    const ey = mapH / 2 - r;
    for (let y = 0; y < halfH; y++) {
      for (let x = 0; x < halfW; x++) {
        // 中心基準の座標 (この象限では負)
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        const qx = Math.abs(px) - ex;
        const qy = Math.abs(py) - ey;
        const ax = Math.max(qx, 0);
        const ay = Math.max(qy, 0);
        const outside = Math.hypot(ax, ay);
        const sdf = outside + Math.min(Math.max(qx, qy), 0) - r; // 内側で負
        let dx = 0;
        let dy = 0;
        if (sdf < 0 && -sdf < bez) {
          // ベゼルバンド内: SDF 勾配(外向き法線)に沿って変位。
          // 強度はリムで最大、バンド内端で 0 に落ちる
          const t = 1 - (-sdf / bez); // リムで 1
          const m = Math.pow(t, curvature); // カーブプロファイル
          let gx;
          let gy;
          if (outside > 0) {
            gx = ax / outside;
            gy = ay / outside;
          } else if (qx > qy) {
            gx = 1;
            gy = 0;
          } else {
            gx = 0;
            gy = 1;
          }
          // 符号を戻す (-x, -y 象限で計算しているため)
          gx *= Math.sign(px) || -1;
          gy *= Math.sign(py) || -1;
          // 内向きに曲げる → レンズの拡大鏡っぽい見え方になる
          dx = -gx * m;
          dy = -gy * m;
        }
        const R = Math.round(128 + dx * 127);
        const G = Math.round(128 + dy * 127);
        const put = (X, Y, sR, sG) => {
          const i = (Y * mapW + X) * 4;
          d[i] = sR;
          d[i + 1] = sG;
          d[i + 2] = 128;
          d[i + 3] = 255;
        };
        const mx = mapW - 1 - x;
        const my = mapH - 1 - y;
        put(x, y, R, G);
        put(mx, y, 255 - R, G);       // 縦軸ミラー: X を反転
        put(x, my, R, 255 - G);       // 横軸ミラー: Y を反転
        put(mx, my, 255 - R, 255 - G);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }

  function getMap(w, h, radius, bezel, curvature) {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const key = `${w}x${h}:${radius}:${bezel}:${curvature}:${dpr}`;
    let uri = mapCache.get(key);
    if (!uri) {
      uri = generateDisplacementMap(w, h, radius, bezel, curvature);
      mapCache.set(key, uri);
    }
    return uri;
  }

  // ==========================================================================
  // SVG フィルタ構築 — 色収差は変位スケール違いの 3 パス (R / G / B) で作る
  //   ※ feComposite(arithmetic) は premultiplied RGBA で計算されるため、
  //     3 パスとも alpha=1 を維持する (合算 alpha は 1 にクランプされる)。
  //     alpha=0 のパスは色ごと消えてしまうので不可。
  //   ※ color-interpolation-filters="sRGB" は必須 (既定の linearRGB だと
  //     中立グレー 128 がずれて背景全体が明るく漂ってしまう)。
  //   ※ 再構築のたびに新しい id を振る (フィルタ出力キャッシュ対策)。
  // ==========================================================================
  function buildFilterNode(mapUri, w, h, rec) {
    const id = `${PREFIX}-f${++uid}`;
    const s = rec.scale * intensity;
    const f = document.createElementNS(SVG_NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '-20%');
    f.setAttribute('y', '-20%');
    f.setAttribute('width', '140%');
    f.setAttribute('height', '140%');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML =
      `<feImage href="${mapUri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(s * (1 + rec.chroma)).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="dR"/>` +
      `<feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${s.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="dG"/>` +
      `<feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(s * (1 - rec.chroma)).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="dB"/>` +
      `<feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB"/>` +
      `<feComposite in="cR" in2="cG" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="cRG"/>` +
      `<feComposite in="cRG" in2="cB" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="refract"/>` +
      `<feGaussianBlur in="refract" stdDeviation="${rec.blur}" result="frost"/>` +
      `<feColorMatrix in="frost" type="saturate" values="${rec.saturate}"/>`;
    return { id, node: f };
  }

  function acquireFilter(recipeName, w, h, radius) {
    const rec = RECIPES[recipeName];
    const bezel = Math.max(6, Math.min(rec.bezel, Math.min(w, h) / 2 - 1));
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const key = `${recipeName}:${w}x${h}:${radius}:${dpr}`;
    let entry = filterCache.get(key);
    if (!entry) {
      const mapUri = getMap(w, h, radius, bezel, rec.curvature);
      const built = buildFilterNode(mapUri, w, h, rec);
      defsEl.appendChild(built.node);
      entry = { id: built.id, node: built.node, base: rec.scale, chroma: rec.chroma, refs: new Set() };
      filterCache.set(key, entry);
    }
    return { key, entry };
  }

  function releaseFilter(key, el) {
    const entry = filterCache.get(key);
    if (!entry) return;
    entry.refs.delete(el);
    if (entry.refs.size === 0) {
      // 直後に同サイズ要素が現れる場合に備えて少し待ってから破棄
      setTimeout(() => {
        const e = filterCache.get(key);
        if (e && e.refs.size === 0) {
          if (e.node && e.node.parentNode) e.node.remove();
          filterCache.delete(key);
        }
      }, 500);
    }
  }

  // 共有グレインフィルタ (feTurbulence — 画像を読まないので CSP の影響を受けない)
  function buildGrainFilter() {
    const f = document.createElementNS(SVG_NS, 'filter');
    f.setAttribute('id', GRAIN_ID);
    f.setAttribute('x', '0%');
    f.setAttribute('y', '0%');
    f.setAttribute('width', '100%');
    f.setAttribute('height', '100%');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML =
      '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch" result="n"/>' +
      '<feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.05 0.05 0.05 0 0" result="g"/>' +
      '<feComposite in="g" in2="SourceGraphic" operator="over"/>';
    return f;
  }

  // ==========================================================================
  // アタッチ / 計測
  // ==========================================================================
  function computeRadius(el, w, h) {
    let v = '0px';
    try {
      v = getComputedStyle(el).borderTopLeftRadius || '0px';
    } catch (e) {}
    let r = parseFloat(v) || 0;
    if (String(v).indexOf('%') !== -1) r = (r / 100) * Math.min(w, h);
    return Math.max(0, Math.min(Math.round(r), Math.floor(Math.min(w, h) / 2)));
  }

  function applyLens(el) {
    if (!tier1 || !defsEl || !el.isConnected) return;
    const info = attachedEls.get(el);
    if (!info) return;
    const w = el.offsetWidth; // transform の影響を受けないレイアウトサイズ
    const h = el.offsetHeight;
    if (w < 8 || h < 8) return; // 未レイアウト。ResizeObserver が後で再試行する
    const radius = computeRadius(el, w, h);
    const { key, entry } = acquireFilter(info.recipe, w, h, radius);
    if (info.filterKey === key) return; // サイズ・形状に変化なし
    const oldKey = info.filterKey;
    entry.refs.add(el);
    info.filterKey = key;
    el.style.setProperty(PROP, `url("#${entry.id}")`);
    if (oldKey) {
      // 新フィルタを差してから旧フィルタを解放 (未フィルタ状態の1フレームを防ぐ)
      requestAnimationFrame(() => releaseFilter(oldKey, el));
    }
  }

  function attachEl(el, recipeName) {
    if (attachedEls.has(el)) return;
    attachedEls.set(el, { recipe: recipeName, filterKey: null });
    applyLens(el);
    if (resizeObs) resizeObs.observe(el);
  }

  function detachEl(el) {
    const info = attachedEls.get(el);
    if (!info) return;
    if (info.filterKey) releaseFilter(info.filterKey, el);
    attachedEls.delete(el);
    if (resizeObs) {
      try { resizeObs.unobserve(el); } catch (e) {}
    }
    try { el.style.removeProperty(PROP); } catch (e) {}
  }

  function rescan() {
    if (destroyed || !tier1 || !root || !root.isConnected) return;
    // 破棄済み要素の後始末 (トースト等はここで自然回収される)
    attachedEls.forEach((info, el) => {
      if (!el.isConnected) detachEl(el);
    });
    for (const [selector, recipeName] of AUTO_TARGETS) {
      root.querySelectorAll(selector).forEach((el) => {
        if (el.tagName === 'SELECT') return; // Tier 2 のまま
        if (!attachedEls.has(el)) attachEl(el, recipeName);
      });
    }
  }

  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      rescan();
    }, RESCAN_DELAY);
  }

  // ==========================================================================
  // オブザーバ — SPA 再描画 / サイズ変化への追従
  // ==========================================================================
  function startObservers() {
    // 歌詞ヘッダー再構築・トースト・オーバーレイ生成などを拾って自動アタッチ
    mutationObs = new MutationObserver(scheduleRescan);
    mutationObs.observe(root, { childList: true, subtree: true });

    // サイズが変わった要素だけマップ / フィルタを作り直す (debounce)
    resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) dirtyEls.add(entry.target);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        dirtyEls.forEach((el) => {
          if (el.isConnected) applyLens(el);
        });
        dirtyEls.clear();
      }, RESIZE_DELAY);
    });

    window.addEventListener('resize', onWindowResize);
  }

  // モニタ間移動などで DPR が変わったらマップキャッシュを捨てて焼き直す
  function onWindowResize() {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === lastDpr) return; // 要素単位の変化は ResizeObserver が拾う
    lastDpr = dpr;
    mapCache.clear();
    attachedEls.forEach((info, el) => {
      const oldKey = info.filterKey;
      info.filterKey = null; // キー無効化 → applyLens が再取得
      if (oldKey) releaseFilter(oldKey, el);
      if (el.isConnected) applyLens(el);
    });
  }

  // ==========================================================================
  // probe — CSS.supports だけでは信用できないため data: 画像の実読込も確認
  // ==========================================================================
  function probeTier1(cb) {
    let ok = false;
    try {
      ok = CSS.supports('backdrop-filter', 'url(#yti-lg-probe)') ||
        CSS.supports('-webkit-backdrop-filter', 'url(#yti-lg-probe)');
    } catch (e) {}
    if (!ok) {
      cb(false);
      return;
    }
    const img = new Image();
    img.onload = () => cb(true);
    img.onerror = () => cb(false);
    img.src = PROBE_PNG;
  }

  // ==========================================================================
  // 公開 API
  // ==========================================================================
  const api = {
    /**
     * defs を冪等に生成して probe → 自動アタッチを開始する。
     * startMVMode() から呼ぶ。rootEl = #mv-root-container、
     * hostEl = #mv-overlay-content (スクリーンショット時に非表示になる側)。
     */
    init(rootEl, hostEl) {
      if (!rootEl) return;
      if (root === rootEl && svgEl && svgEl.isConnected) {
        // ホットスワップ再入: defs は生きているので再スキャンのみ
        scheduleRescan();
        return;
      }
      api.destroy();
      destroyed = false;
      root = rootEl;
      const host = hostEl || rootEl;

      // 隠し <svg> — display:none だとフィルタが無効化されるため 0x0 で置く
      svgEl = document.createElementNS(SVG_NS, 'svg');
      svgEl.setAttribute('id', `${PREFIX}-defs-host`);
      svgEl.setAttribute('aria-hidden', 'true');
      svgEl.setAttribute('focusable', 'false');
      svgEl.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none;';
      defsEl = document.createElementNS(SVG_NS, 'defs');
      defsEl.appendChild(buildGrainFilter());
      svgEl.appendChild(defsEl);
      host.appendChild(svgEl);

      // defs が存在する印 (グレイン等の CSS ゲートに使う)
      root.classList.add('lg-defs');

      probeTier1((ok) => {
        if (destroyed || root !== rootEl || !ok) return;
        tier1 = true;
        root.classList.add('lg-on'); // Tier 1 レンズのクラスゲート開放
        startObservers();
        rescan();
      });
    },

    /** endMVMode() から呼ぶ。defs 本体は rootContainer ごと破棄される */
    destroy() {
      destroyed = true;
      tier1 = false;
      if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
      if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
      if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
      window.removeEventListener('resize', onWindowResize);
      dirtyEls.clear();
      attachedEls.clear();
      filterCache.clear(); // ノードは rootContainer ごと DOM から消える
      if (root) {
        root.classList.remove('lg-on', 'lg-defs');
        root = null;
      }
      svgEl = null;
      defsEl = null;
    },

    /**
     * 既存 Glass スライダー (0..1) と連動してレンズ深度を更新する。
     * url() フィルタは CSS 変数で tween できないため、feDisplacementMap の
     * scale 属性を直接書き換える (input イベント駆動なので毎フレームではない)。
     */
    setIntensity(v) {
      const val = Math.max(0, Math.min(1, Number(v) || 0));
      intensity = 0.35 + val * 1.3; // スライダー 50 でちょうど 1.0
      filterCache.forEach((entry) => {
        const s = entry.base * intensity;
        const passes = entry.node.querySelectorAll('feDisplacementMap');
        if (passes.length === 3) {
          passes[0].setAttribute('scale', (s * (1 + entry.chroma)).toFixed(2));
          passes[1].setAttribute('scale', s.toFixed(2));
          passes[2].setAttribute('scale', (s * (1 - entry.chroma)).toFixed(2));
        }
      });
    },

    /** 任意タイミングでの再スキャン */
    refresh() {
      scheduleRescan();
    }
  };

  window.ytiLiquidGlass = api;
})();
