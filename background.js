/* QuickPeek background service worker (MV3) */

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: "quickpeek-open-link",
      title: "QuickPeek: 预览此链接",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "quickpeek-open-page",
      title: "QuickPeek: 预览当前页面",
      contexts: ["page"]
    });
  } catch (e) {
    // ignore duplicates on update
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  const url = info.linkUrl || info.pageUrl;
  chrome.tabs.sendMessage(tab.id, { type: "OPEN_QUICKPEEK", url });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "quickpeek-toggle") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_QUICKPEEK" });
});

// Proxy cross-origin fetch via extension background (bypasses page CORS)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'PROXY_FETCH') return;
  (async () => {
    try {
      const { url, method = 'GET', headers = {}, body } = msg;
      const res = await fetch(url, { method, headers, body, credentials: 'omit', redirect: 'follow' });
      const contentType = res.headers.get('content-type') || '';
      const headersObj = Object.fromEntries(res.headers.entries());
      let data;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }
      sendResponse({ ok: res.ok, status: res.status, headers: headersObj, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep the message channel open for async response
});
