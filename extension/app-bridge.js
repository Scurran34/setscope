// Runs on the setscope page (http://127.0.0.1:7331).
// 1. Marks the page so it knows the extension is installed, and which version (so it
//    can say when Chrome is still running an old copy).
// 2. Passes "I'm about to open 1001Tracklists" on to the background worker.

document.documentElement.dataset.setscopeExtension = "1";
document.documentElement.dataset.setscopeExtensionVersion = chrome.runtime.getManifest().version;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "setscope-app") return;
  if (event.data.type === "arm") {
    chrome.runtime.sendMessage({ type: "arm", query: String(event.data.query ?? ""), kind: String(event.data.kind ?? "") });
  }
});
