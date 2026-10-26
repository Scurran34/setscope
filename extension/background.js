// Background worker. Decides which 1001Tracklists tabs belong to setscope, forwards
// captured links to the local server, and closes the tab when the server has them.
//
// A tab is setscope's only if setscope opened it: either its opener is the setscope
// page, or it's the first 1001Tracklists tab to check in within 30s of setscope
// saying "I'm opening one now". Tabs you open yourself are never touched.

const DEFAULT_SERVER = "http://127.0.0.1:7331";
const ARM_WINDOW_MS = 30_000;

// Service workers get shut down when idle, so state lives in storage.session
// (kept until the browser closes) rather than in variables.
async function getState() {
  const {
    armedAt = 0,
    appTabId = null,
    captureTabs = [],
    search = null,
    server = DEFAULT_SERVER,
  } = await chrome.storage.session.get(["armedAt", "appTabId", "captureTabs", "search", "server"]);
  return { armedAt, appTabId, captureTabs, search, server };
}

async function isCaptureTab(tab) {
  const state = await getState();
  if (state.captureTabs.includes(tab.id)) return true;
  const openedByApp = state.appTabId !== null && tab.openerTabId === state.appTabId;
  const recentlyArmed = Date.now() - state.armedAt < ARM_WINDOW_MS;
  if (!openedByApp && !recentlyArmed) return false;
  // Claim it, and disarm so no other tab gets claimed by the same click.
  await chrome.storage.session.set({ captureTabs: [...state.captureTabs, tab.id], armedAt: 0 });
  return true;
}

async function sendToServer(server, message) {
  const [path, payload] =
    message.type === "captureSet"
      ? ["/api/capture-set", { pageUrl: message.pageUrl, html: message.html }]
      : ["/api/capture", { pageUrl: message.pageUrl, urls: message.urls, complete: message.complete === true }];
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setscope": "1" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tab = sender.tab;
  if (!tab) return false;

  if (message.type === "arm") {
    const search = { query: message.query, kind: message.kind };
    // Send captures back to the same address the setscope page is open on.
    const server = new URL(sender.url ?? DEFAULT_SERVER).origin;
    chrome.storage.session.set({ armedAt: Date.now(), appTabId: tab.id, search, server }).then(() => sendResponse({ ok: true }));
    return true; // we'll call sendResponse asynchronously
  }

  if (message.type === "isCaptureTab") {
    Promise.all([isCaptureTab(tab), getState()]).then(([capture, state]) =>
      sendResponse({ capture, search: capture ? state.search : null }),
    );
    return true;
  }

  if (message.type === "capture" || message.type === "captureSet") {
    getState()
      .then(async (state) => {
        if (!state.captureTabs.includes(tab.id)) throw new Error("Not a setscope tab");
        const result = await sendToServer(state.server, message);
        sendResponse({ ok: true, result });
        // Give the "sent" banner a moment, then close and return to setscope.
        setTimeout(async () => {
          await chrome.storage.session.set({ captureTabs: state.captureTabs.filter((id) => id !== tab.id) });
          // You may have closed it already: nothing to do then.
          chrome.tabs.remove(tab.id).catch(() => {});
          if (state.appTabId !== null) {
            chrome.tabs.update(state.appTabId, { active: true }).catch(() => {});
            chrome.tabs.get(state.appTabId).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
          }
        }, 1500);
      })
      .catch((error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.captureTabs.includes(tabId)) {
    await chrome.storage.session.set({ captureTabs: state.captureTabs.filter((id) => id !== tabId) });
  }
});
