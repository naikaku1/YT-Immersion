(function() {
  if (!window._YTI_CommandListener) {
    window._YTI_CommandListener = true;
    window.addEventListener('YTI_ForceChangeTrack', (e) => {
      try {
        const player = document.getElementById('movie_player');
        if (player && typeof player.setOption === 'function') {
          player.toggleSubtitlesOn();
          player.setOption('captions', 'track', {
            languageCode: e.detail
          });
        }
      } catch (err) {}
    });
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
          if (this._url && typeof this._url === 'string' && this._url.includes('/api/timedtext')) {
            window.dispatchEvent(new CustomEvent('YTI_Intercepted_Captions', {
              detail: this.responseText
            }));
          }
        });
        return origSend.apply(this, arguments);
      };
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = args[0]?.url || args[0];
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          response.clone().text().then(text => {
            window.dispatchEvent(new CustomEvent('YTI_Intercepted_Captions', {
              detail: text
            }));
          }).catch(() => {});
        }
        return response;
      };
    } catch (e) {
      console.error(e);
    }
  }
  const scriptTag = document.currentScript;
  const eventId = scriptTag ? scriptTag.getAttribute('data-event-id') : null;
  if (!eventId) return;
  let tracks = [];
  try {
    const player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      const res = player.getPlayerResponse();
      if (res?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
        tracks = res.captions.playerCaptionsTracklistRenderer.captionTracks;
      }
    }
    if (tracks.length === 0 && player && typeof player.getOption === 'function') {
      tracks = player.getOption('captions', 'tracklist') || [];
    }
    if (tracks.length === 0 && typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      tracks = ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    }
  } catch (e) {}
  window.dispatchEvent(new CustomEvent(eventId, {
    detail: JSON.stringify({
      list: tracks
    })
  }));
})();
