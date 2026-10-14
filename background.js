// 共通コア（文字列照合・歌詞データの読み取り）と歌詞の取得元
importScripts('core/text.js', 'core/parsers.js', 'providers.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CAPTURE_CURRENT_TAB') {
    chrome.tabs.captureVisibleTab(null, {
      format: 'png'
    }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message
        });
      } else {
        sendResponse({
          success: true,
          dataUrl: dataUrl
        });
      }
    });
    return true;
  }
  if (request.type === 'FETCH_URL') {
    // 応答が極端に遅いAPI（LRCLIBは数十秒かかることがある）で待ち続けないよう打ち切る
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), request.timeoutMs || 20000);
    fetch(request.url, { signal: ctrl.signal }).then(res => {
      // 404 等のエラーページを本文として返すと、呼び出し側が JSON として読もうとして失敗するだけなので弾く
      if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
      return res.text();
    }).finally(() => clearTimeout(timer)).then(text => sendResponse({
      success: true,
      text: text
    })).catch(err => sendResponse({
      success: false,
      error: err.message
    }));
    return true;
  }
  // 共有サーバー（設定で URL を入れた時だけ）との JSON のやり取り。https のみ。
  if (request.type === 'FETCH_JSON') {
    let url = null;
    try {
      url = new URL(request.url);
    } catch (e) {}
    if (!url || url.protocol !== 'https:' || !['GET', 'POST'].includes(request.method || 'GET')) {
      sendResponse({ success: false, error: 'bad request' });
      return false;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    fetch(url.toString(), {
      method: request.method || 'GET',
      headers: request.body ? { 'Content-Type': 'application/json' } : {},
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: ctrl.signal,
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {}
      sendResponse({ success: res.ok, status: res.status, json });
    }).catch(err => sendResponse({ success: false, error: err.message })).finally(() => clearTimeout(timer));
    return true;
  }
  if (request.type === 'FETCH_LYRICS_PROVIDER') {
    ytiProviders.fetchProvider(request.provider, request.want)
      .then(result => sendResponse({ success: !!result, result }))
      .catch(err => sendResponse({ success: false, error: String(err && err.message || err) }));
    return true;
  }
});
