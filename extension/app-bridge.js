// Runs on the setscope page (http://127.0.0.1:7331, or a shared *.trycloudflare.com link).
// 1. Marks the page so it knows the extension is installed, and which version (so it
//    can say when Chrome is still running an old copy).
// 2. Passes "I'm about to open 1001Tracklists" on to the background worker.

document.documentElement.dataset.setscopeExtension = "1";
document.documentElement.dataset.setscopeExtensionVersion = chrome.runtime.getManifest().version;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "setscope-app") return;
  if (event.data.type === "arm") {
    const limit = Number.isInteger(event.data.limit) && event.data.limit > 0 ? event.data.limit : null;
    // The page's capture key: says whose gather this is when setscope runs on someone else's computer.
    const token = typeof event.data.token === "string" ? event.data.token : null;
    chrome.runtime.sendMessage({ type: "arm", query: String(event.data.query ?? ""), kind: String(event.data.kind ?? ""), limit, token });
  }
});
