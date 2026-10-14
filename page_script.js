(function() {
  if (!window._YTI_CommandListener) {
    window._YTI_CommandListener = true;
    window.addEventListener('YTI_ForceChangeTrack', (e) => {
      try {
        const player = document.getElementById('movie_player');
        if (player && typeof player.setOption === 'function') {
          player.toggleSubtitlesOn();
          // 文字列＝言語コード（従来互換）。JSON文字列ならトラック指定オブジェクト
          // （kind:'asr' 等でASRトラックを明示選択できる）として扱う。
          let opt = e.detail;
          if (typeof opt === 'string' && opt.charAt(0) === '{') {
            try {
              opt = JSON.parse(opt);
            } catch (_) {}
          }
          if (typeof opt === 'string') opt = { languageCode: opt };
          const applyTrack = (attempt) => {
            let target = opt;
            // kind:'asr' 指定時はプレイヤー自身のトラックリストから実物のトラック
            // オブジェクトを解決して渡す。部分指定のままだと同言語の手動字幕が
            // 選ばれてしまい、ASRをロードできない。
            if (opt && opt.kind === 'asr' && typeof player.getOption === 'function') {
              let m = null;
              try {
                const list = player.getOption('captions', 'tracklist') || [];
                m = list.find(t =>
                  (t.kind === 'asr' || /^a\./.test(String(t.vss_id || t.vssId || ''))) &&
                  (!opt.languageCode || t.languageCode === opt.languageCode)) || null;
              } catch (_) {}
              if (m) {
                target = m;
              } else if (attempt < 5) {
                // 字幕モジュールのロード直後は tracklist が空のことがある
                setTimeout(() => applyTrack(attempt + 1), 400);
                return;
              }
            }
            try {
              player.setOption('captions', 'track', target);
            } catch (_) {}
          };
          applyTrack(0);
        }
      } catch (err) {}
    });
  }
  // ===== 字幕通信（timedtext）パッシブ・インターセプト + メモリキャッシュ =====
  // 動画IDをキーに、YouTube公式の字幕レスポンス（JSON/XML）を window.__yt_lyrics_cache__ へ
  // 自動キャッシュする。公式通信は一切妨害せず、横取りしたコピーのみを保存する。
  if (!window.__yt_lyrics_cache__) {
    window.__yt_lyrics_cache__ = {};
  }

  function _yti_parseTimedtext(url) {
    try {
      if (!url || typeof url !== 'string') return null;
      const u = new URL(url, location.href);
      if (!/\/api\/timedtext/.test(u.pathname) && !u.href.includes('/api/timedtext')) return null;
      const v = u.searchParams.get('v') ||
        (new URLSearchParams(location.search)).get('v') || '__unknown__';
      const lang = u.searchParams.get('lang') || '';
      const tlang = u.searchParams.get('tlang') || '';
      const name = u.searchParams.get('name') || '';
      const key = (lang || '__') + (tlang ? '|t:' + tlang : '') + (name ? '|n:' + name : '');
      return { videoId: v, lang: lang, tlang: tlang, name: name, key: key };
    } catch (e) {
      return null;
    }
  }

  // 視聴ページの next 応答（videoId ごとに直近の数本だけ）
  if (!window.__yti_next__) window.__yti_next__ = {};
  function _yti_storeNext(j) {
    try {
      const vid = j && j.currentVideoEndpoint && j.currentVideoEndpoint.watchEndpoint && j.currentVideoEndpoint.watchEndpoint.videoId;
      if (!vid || !j.contents || !j.contents.twoColumnWatchNextResults) return;
      const store = window.__yti_next__;
      delete store[vid];
      store[vid] = j;
      const ids = Object.keys(store);
      for (let i = 0; i < ids.length - 4; i++) delete store[ids[i]];
    } catch (_) {}
  }
  // SPA 遷移の完了イベントにも同じ応答が入っている（fetch を経ない経路の保険）
  document.addEventListener('yt-navigate-finish', (e) => {
    try {
      const r = e && e.detail && e.detail.response;
      _yti_storeNext((r && r.response) || r);
    } catch (_) {}
  });

  function _yti_cacheCaption(url, text) {
    if (!text || !text.trim()) return;
    const meta = _yti_parseTimedtext(url);
    if (!meta) return;
    const store = window.__yt_lyrics_cache__;
    if (!store[meta.videoId]) {
      store[meta.videoId] = {};
      // 見た動画の字幕を全部抱え続けると、長時間の連続再生でメモリが膨らむ。
      // 新しい順に20本だけ残す（オブジェクトのキーは追加順に並ぶ）。
      const ids = Object.keys(store);
      for (let i = 0; i < ids.length - 20; i++) delete store[ids[i]];
    }
    store[meta.videoId][meta.key] = {
      text: text,
      lang: meta.lang,
      tlang: meta.tlang,
      name: meta.name,
      // 実際に成功した通信のURL。pot等のセッションパラメータを他トラックの
      // 取得に移植するためのドナーとして使う
      url: String(url || ''),
      ts: Date.now()
    };
    store[meta.videoId].__last = text;
    // 既存ロジック（forceIntercept 等）との後方互換
    try {
      window.dispatchEvent(new CustomEvent('YTI_Intercepted_Captions', { detail: text }));
    } catch (e) {}
    // ISOLATED 世界（content.js）側のミラーキャッシュ用：メタ情報付きで通知
    try {
      window.dispatchEvent(new CustomEvent('YTI_CaptionData', {
        detail: JSON.stringify({
          videoId: meta.videoId,
          lang: meta.lang,
          tlang: meta.tlang,
          name: meta.name,
          key: meta.key,
          url: String(url || ''),
          text: text
        })
      }));
    } catch (e) {}
  }

  if (!window._YTI_NetworkHooked) {
    window._YTI_NetworkHooked = true;
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return origOpen.apply(this, arguments);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
          try {
            if (this._url && typeof this._url === 'string' && this._url.includes('/api/timedtext')) {
              let text = '';
              try {
                text = (this.responseType === '' || this.responseType === 'text') ? this.responseText : '';
              } catch (_) {}
              if (text) _yti_cacheCaption(this._url, text);
            }
          } catch (_) {}
        });
        return origSend.apply(this, arguments);
      };
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        try {
          const url = (args[0] && args[0].url) ? args[0].url : args[0];
          if (typeof url === 'string' && url.includes('/api/timedtext')) {
            // clone() で公式通信のボディは消費せず、コピーだけを読む（公式挙動を破壊しない）
            response.clone().text().then(text => {
              _yti_cacheCaption(url, text);
            }).catch(() => {});
          } else if (typeof url === 'string' && url.includes('/youtubei/v1/next') && response.ok) {
            // 視聴ページの SPA 遷移で届く next 応答。ytInitialData は最初のページのまま
            // 更新されないので、曲名・アーティスト（概要欄のミュージック）と次の動画はここから読む。
            response.clone().json().then(_yti_storeNext).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
    } catch (e) {
      console.error(e);
    }
  }

  // ===== キャッシュ取り出しブリッジ =====
  // content.js（ISOLATED）からの要求に対し、document_start から蓄積した
  // 永続キャッシュを返す。これにより content.js のリスナー登録前に流れた
  // 字幕通信も取りこぼさずに参照できる。
  if (!window._YTI_CacheBridge) {
    window._YTI_CacheBridge = true;
    window.addEventListener('YTI_RequestCache', (e) => {
      let videoId = '';
      try {
        videoId = (typeof e.detail === 'string') ? e.detail : ((e.detail && e.detail.videoId) || '');
      } catch (_) {}
      const store = window.__yt_lyrics_cache__ || {};
      const entries = (videoId && store[videoId]) ? store[videoId] : {};
      try {
        window.dispatchEvent(new CustomEvent('YTI_CacheResponse', {
          detail: JSON.stringify({ videoId: videoId, entries: entries })
        }));
      } catch (_) {}
    });
  }
  // ===== 構造化楽曲メタデータ（概要欄の「ミュージック」セクション）ブリッジ =====
  // Content IDでマッチした動画は ytInitialData に曲名・アーティスト・アルバムが
  // 構造化データとして入っている。動画タイトルのパースより遥かに正確なので、
  // 外部歌詞DBの検索キーとして使う。
  if (!window._YTI_MusicMetaBridge) {
    window._YTI_MusicMetaBridge = true;

    // infoRowのラベルはロケールで変わる。主要言語を辞書で拾い、
    // 未知のロケールでは行順によるフォールバックへ落とす。
    const _YTI_LBL = {
      song: /^(ソング|曲|曲名|song|canci[oó]n|chanson|lied|canzone|m[uú]sica|musica|노래|음악|歌曲|歌名|bài h[aá]t|เพลง)$/i,
      artist: /^(アーティスト|artist|artiste|k[uü]nstler|artista|interpret|아티스트|艺术家|藝人|ngh[eệ] s[iĩ]|ศิลปิน)$/i,
      album: /^(アルバム|album|[aá]lbum|앨범|专辑|專輯)$/i
    };

    function _yti_textOf(node) {
      if (!node) return '';
      if (typeof node === 'string') return node;
      if (node.simpleText) return String(node.simpleText);
      if (Array.isArray(node.runs)) return node.runs.map(r => (r && r.text) ? r.text : '').join('');
      return '';
    }

    // ytInitialData のどこに置かれるかは頻繁に変わるため、固定パスではなく
    // 「infoRows を持つオブジェクト」を全探索する。
    function _yti_collectInfoRows(root) {
      const found = [];
      const seen = new Set();
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 25 || found.length >= 8) return;
        if (seen.has(o)) return;
        seen.add(o);
        if (Array.isArray(o)) {
          for (const v of o) walk(v, depth + 1);
          return;
        }
        if (Array.isArray(o.infoRows) && o.infoRows.length) found.push(o.infoRows);
        for (const k in o) walk(o[k], depth + 1);
      };
      walk(root, 0);
      return found;
    }

    function _yti_parseMusicRows(rows) {
      const pairs = [];
      for (const r of rows) {
        const ir = (r && r.infoRowRenderer) ? r.infoRowRenderer : r;
        if (!ir || typeof ir !== 'object') continue;
        const label = _yti_textOf(ir.title).trim();
        const value = (_yti_textOf(ir.defaultMetadata) || _yti_textOf(ir.expandedMetadata)).trim();
        // 「ライセンス提供」等は値が長文になりがち。曲名/アーティストではない
        if (!value || value.length > 120) continue;
        pairs.push({ label, value });
      }
      if (!pairs.length) return null;
      const out = { song: '', artist: '', album: '' };
      let labelHit = false;
      for (const p of pairs) {
        if (!out.song && _YTI_LBL.song.test(p.label)) { out.song = p.value; labelHit = true; }
        else if (!out.artist && _YTI_LBL.artist.test(p.label)) { out.artist = p.value; labelHit = true; }
        else if (!out.album && _YTI_LBL.album.test(p.label)) { out.album = p.value; labelHit = true; }
      }
      // 未知ロケール：ラベルが1つも一致しなかった時だけ行順で推測する。
      // ミュージックセクションは ソング→アーティスト→アルバム の順が慣例。
      if (!labelHit && pairs.length >= 2) {
        out.song = pairs[0].value;
        out.artist = pairs[1].value;
        if (pairs.length >= 3) out.album = pairs[2].value;
      }
      return out.song ? out : null;
    }

    // 戻り値 { meta, stale }。stale は「前ページのデータしか無い」ことを示す。
    // これを null と同一視すると、呼び出し側が「楽曲メタ無し」と誤って確定
    // キャッシュしてしまうため、区別して返す。
    function _yti_extractMusicMeta(videoId) {
      // SPA 遷移後は next 応答から読む（ytInitialData は最初のページのまま）
      const nx = videoId && window.__yti_next__ && window.__yti_next__[videoId];
      if (nx) {
        for (const rows of _yti_collectInfoRows(nx)) {
          const m = _yti_parseMusicRows(rows);
          if (m) return { meta: m, stale: false };
        }
        return { meta: null, stale: false };
      }
      if (typeof ytInitialData === 'undefined' || !ytInitialData) return { meta: null, stale: true };
      // SPA遷移後も ytInitialData は前ページのまま残る。必ず動画IDを検証する。
      const curId = ytInitialData?.currentVideoEndpoint?.watchEndpoint?.videoId || '';
      if (videoId && curId && curId !== videoId) return { meta: null, stale: true };
      for (const rows of _yti_collectInfoRows(ytInitialData)) {
        const m = _yti_parseMusicRows(rows);
        if (m) return { meta: m, stale: false };
      }
      return { meta: null, stale: false };
    }

    window.addEventListener('YTI_RequestMusicMeta', (e) => {
      let videoId = '';
      try {
        videoId = (typeof e.detail === 'string') ? e.detail : ((e.detail && e.detail.videoId) || '');
      } catch (_) {}
      let res = { meta: null, stale: true };
      try {
        res = _yti_extractMusicMeta(videoId);
      } catch (_) {}
      try {
        window.dispatchEvent(new CustomEvent('YTI_MusicMetaResponse', {
          detail: JSON.stringify({ videoId: videoId, meta: res.meta, stale: !!res.stale })
        }));
      } catch (_) {}
    });
  }

  // ===== 再生中の動画の基本情報ブリッジ =====
  // SPA遷移の直後は、ページ側のタイトル要素（h1）がまだ前の動画のまま残っている。
  // プレイヤーの getVideoData() は新しい動画の読み込み開始と同時に切り替わるので、
  // 曲名を即座に出すための情報源として使う。応答は同期的に返る。
  if (!window._YTI_VideoDataBridge) {
    window._YTI_VideoDataBridge = true;
    window.addEventListener('YTI_RequestVideoData', () => {
      let out = { videoId: '', title: '', author: '', category: '' };
      try {
        const player = document.getElementById('movie_player');
        const d = (player && typeof player.getVideoData === 'function') ? player.getVideoData() : null;
        if (d) out = { videoId: d.video_id || '', title: d.title || '', author: d.author || '', category: '' };
        // 動画のカテゴリ（「音楽」か）。音声の記録を音楽の動画だけに絞るのに使う
        const pr = (player && typeof player.getPlayerResponse === 'function') ? player.getPlayerResponse() : null;
        const mf = pr && pr.microformat && pr.microformat.playerMicroformatRenderer;
        if (mf && pr.videoDetails && pr.videoDetails.videoId === out.videoId) out.category = mf.category || '';
      } catch (_) {}
      try {
        window.dispatchEvent(new CustomEvent('YTI_VideoDataResponse', { detail: JSON.stringify(out) }));
      } catch (_) {}
    });
  }

  // ===== 次に再生される動画（自動再生・再生リスト）=====
  // 歌詞を先に引いておき、曲が変わった瞬間に出すために使う。
  if (!window._YTI_NextVideoBridge) {
    window._YTI_NextVideoBridge = true;
    window.addEventListener('YTI_RequestNextVideo', (e) => {
      let videoId = '';
      try {
        videoId = String(e.detail || '');
      } catch (_) {}
      let next = '';
      try {
        let j = videoId && window.__yti_next__ && window.__yti_next__[videoId];
        if (!j && typeof ytInitialData !== 'undefined' && ytInitialData &&
            ytInitialData.currentVideoEndpoint && ytInitialData.currentVideoEndpoint.watchEndpoint &&
            ytInitialData.currentVideoEndpoint.watchEndpoint.videoId === videoId) j = ytInitialData;
        const two = j && j.contents && j.contents.twoColumnWatchNextResults;
        const pl = two && two.playlist && two.playlist.playlist;
        if (pl && Array.isArray(pl.contents)) {
          const items = pl.contents.map(c => c && c.playlistPanelVideoRenderer).filter(Boolean);
          const at = items.findIndex(it => it.videoId === videoId);
          if (at >= 0 && items[at + 1]) next = items[at + 1].videoId;
        }
        if (!next) {
          const sets = two && two.autoplay && two.autoplay.autoplay && two.autoplay.autoplay.sets;
          const ep = sets && sets[0] && sets[0].autoplayVideo && sets[0].autoplayVideo.watchEndpoint;
          if (ep && ep.videoId) next = ep.videoId;
        }
      } catch (_) {}
      try {
        window.dispatchEvent(new CustomEvent('YTI_NextVideoResponse', { detail: JSON.stringify({ videoId, next }) }));
      } catch (_) {}
    });
  }

  // ===== 端末内翻訳（Chrome 内蔵の Translator / LanguageDetector API）=====
  // API キーも外部への送信も無い翻訳。モデルの初回ダウンロードにはユーザーの操作が要るので、
  // content.js 側のボタンを押した流れ（ユーザー操作）でここが呼ばれる。
  if (!window._YTI_TranslateBridge) {
    window._YTI_TranslateBridge = true;
    const translators = {};
    window.addEventListener('YTI_TranslateRequest', async (e) => {
      let req = null;
      try {
        req = JSON.parse(e.detail);
      } catch (_) {}
      if (!req || !req.id) return;
      const reply = (o) => {
        try {
          window.dispatchEvent(new CustomEvent('YTI_TranslateResponse', { detail: JSON.stringify(Object.assign({ id: req.id }, o)) }));
        } catch (_) {}
      };
      try {
        if (req.op === 'detect') {
          if (typeof LanguageDetector === 'undefined') return reply({ ok: false, status: 'unsupported' });
          const det = await LanguageDetector.create();
          const r = await det.detect(String(req.text || ''));
          return reply({ ok: true, lang: (r && r[0] && r[0].detectedLanguage) || '' });
        }
        if (typeof Translator === 'undefined') return reply({ ok: false, status: 'unsupported' });
        const opt = { sourceLanguage: req.source, targetLanguage: req.target };
        if (req.op === 'availability') return reply({ ok: true, status: await Translator.availability(opt) });
        const key = req.source + '>' + req.target;
        if (!translators[key]) {
          translators[key] = await Translator.create(Object.assign({}, opt, {
            monitor(m) {
              m.addEventListener('downloadprogress', (ev) => {
                try {
                  window.dispatchEvent(new CustomEvent('YTI_TranslateProgress', { detail: JSON.stringify({ key, loaded: ev.loaded }) }));
                } catch (_) {}
              });
            }
          }));
        }
        const out = [];
        for (const t of (req.texts || [])) out.push(t ? await translators[key].translate(t) : '');
        reply({ ok: true, texts: out });
      } catch (err) {
        reply({ ok: false, status: 'error', error: String((err && err.message) || err) });
      }
    });
  }

  const scriptTag = document.currentScript;
  const eventId = scriptTag ? scriptTag.getAttribute('data-event-id') : null;
  if (!eventId) return;
  let tracks = [];
  let defaultLang = '';
  let responseVideoId = '';
  try {
    let renderer = null;
    let fullRes = null;
    const player = document.getElementById('movie_player');
    const urlVideoId = (new URLSearchParams(location.search)).get('v') || '';
    if (player && typeof player.getPlayerResponse === 'function') {
      const res = player.getPlayerResponse();
      renderer = res?.captions?.playerCaptionsTracklistRenderer || null;
      responseVideoId = res?.videoDetails?.videoId || '';
      fullRes = res || null;
    }
    // SPA遷移後は ytInitialPlayerResponse が前ページの内容のまま残るため、
    // 動画IDが現在のURLと一致する場合に限りフォールバックとして使う
    if ((!renderer || !renderer.captionTracks) && typeof ytInitialPlayerResponse !== 'undefined') {
      const initId = ytInitialPlayerResponse?.videoDetails?.videoId || '';
      if (!urlVideoId || initId === urlVideoId) {
        renderer = ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer || renderer;
        if (!responseVideoId) responseVideoId = initId;
        if (!fullRes) fullRes = ytInitialPlayerResponse;
      }
    }
    if (renderer && renderer.captionTracks) {
      tracks = renderer.captionTracks;
    }
    if ((!tracks || tracks.length === 0) && player && typeof player.getOption === 'function') {
      tracks = player.getOption('captions', 'tracklist') || [];
    }
    // 原文（アップロード元 = 実際の音声）の言語コードを特定する
    try {
      if (renderer && renderer.captionTracks && renderer.captionTracks.length) {
        const ct = renderer.captionTracks;
        // 1) 自動生成(ASR)字幕の言語 = 実際の音声言語。最も信頼できる原文シグナル。
        //    （K-POP等の海外MVでも音声から生成されるため必ず原語になる）
        const asr = ct.find(t => t.kind === 'asr' || (t.vssId && String(t.vssId).startsWith('a.')));
        if (asr) defaultLang = asr.languageCode || '';
        // 2) メタデータ上の既定音声言語
        if (!defaultLang) {
          const mf = fullRes?.microformat?.playerMicroformatRenderer;
          if (mf && mf.defaultAudioLanguage) defaultLang = mf.defaultAudioLanguage;
        }
        // 3) 翻訳元トラック
        if (!defaultLang && renderer.defaultTranslationSourceTrackIndices && renderer.defaultTranslationSourceTrackIndices.length) {
          const idx = renderer.defaultTranslationSourceTrackIndices[0];
          if (ct[idx]) defaultLang = ct[idx].languageCode || '';
        }
        // 4) 既定の音声トラックに対応する字幕の言語
        //    ※視聴者のロケールに合わせた字幕（日本なら日本語）を指すことがあるため
        //      原文判定としての優先度は低い（旧実装で最優先にしていたのがK-POPで
        //      「原文＝日本語」と誤判定される原因だった）
        if (!defaultLang) {
          const at = renderer.audioTracks;
          const dati = (typeof renderer.defaultAudioTrackIndex === 'number') ? renderer.defaultAudioTrackIndex : 0;
          if (at && at[dati] && typeof at[dati].defaultCaptionTrackIndex === 'number' && ct[at[dati].defaultCaptionTrackIndex]) {
            defaultLang = ct[at[dati].defaultCaptionTrackIndex].languageCode || '';
          }
        }
        // 5) 手動字幕（自動生成でない）の先頭
        if (!defaultLang) {
          const manual = ct.find(t => t.kind !== 'asr' && !(t.vssId && String(t.vssId).startsWith('a.')));
          if (manual) defaultLang = manual.languageCode || '';
        }
        // 6) 最後の保険：リスト先頭
        if (!defaultLang && ct[0]) defaultLang = ct[0].languageCode || '';
      }
    } catch (e) {}
  } catch (e) {}
  window.dispatchEvent(new CustomEvent(eventId, {
    detail: JSON.stringify({
      list: tracks,
      defaultLang: defaultLang,
      videoId: responseVideoId
    })
  }));
})();
