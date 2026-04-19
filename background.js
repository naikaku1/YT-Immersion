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
    fetch(request.url).then(res => res.text()).then(text => sendResponse({
      success: true,
      text: text
    })).catch(err => sendResponse({
      success: false,
      error: err.message
    }));
    return true;
  }
});
