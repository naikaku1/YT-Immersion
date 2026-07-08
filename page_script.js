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

  function _yti_cacheCaption(url, text) {
    if (!text || !text.trim()) return;
    const meta = _yti_parseTimedtext(url);
    if (!meta) return;
    const store = window.__yt_lyrics_cache__;
    if (!store[meta.videoId]) store[meta.videoId] = {};
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
