// Runs on 1001Tracklists pages, but only does anything in a tab setscope opened.
//
// - Search results: opens the result if exactly one matches your search, otherwise
//   asks you to click the right one.
// - Human check: does nothing. You pass it; the page reloads and this runs again.
// - Track, DJ or artist page: collects the set links, sends them to setscope, and
//   the background worker closes the tab.
// - Tracklist page (a set setscope couldn't fetch itself): sends the page so setscope
//   can read the tracks, then closes the tab.

const TRACKLIST_LINK = /\/tracklist\/[a-z0-9]+\/[^"'\s?#]*\.html/i;
const CAPTURE_PAGES = /^\/(track|dj|artist|source)\//;

function banner(text) {
  let box = document.getElementById("setscope-banner");
  if (!box) {
    box = document.createElement("div");
    box.id = "setscope-banner";
    box.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:#5b4bd6;color:#fff;padding:10px 18px;border-radius:10px;" +
      "font:600 14px -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
    document.documentElement.append(box);
  }
  box.textContent = text;
}

function isChallenge() {
  return /validate your are real human|validate you are (a )?real human|you will be forwarded/i.test(document.body?.innerText ?? "");
}

function tracklistLinks() {
  const urls = new Set();
  for (const a of document.querySelectorAll("a[href*='/tracklist/']")) {
    const path = a.getAttribute("href").match(TRACKLIST_LINK)?.[0];
    if (path) urls.add(new URL(path, "https://www.1001tracklists.com").href);
  }
  return [...urls];
}

/** Links can render after load, so wait until the count stops growing (max ~10s). */
async function waitForLinks() {
  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const count = tracklistLinks().length;
    if (count > 0 && count === previous) break;
    previous = count;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return tracklistLinks();
}

function normalize(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * On the search results page: if exactly one result matches what you typed in
 * setscope, open it (the same as clicking it). Otherwise let you pick.
 */
function openExactMatch(search) {
  if (!search?.query) return false;
  const wanted = normalize(search.query);
  const linkPattern = search.kind === "song" ? /^\/track\// : /^\/(dj|artist)\//;
  const matches = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (linkPattern.test(href) && normalize(a.textContent) === wanted) matches.set(href, a);
  }
  if (matches.size !== 1) return false;
  const [href, link] = [...matches][0];
  banner(`setscope: opening ${link.textContent.trim()}…`);
  location.assign(new URL(href, location.origin).href);
  return true;
}

async function main() {
  const { capture, search } = await chrome.runtime.sendMessage({ type: "isCaptureTab" });
  if (!capture || isChallenge()) return;

  if (location.pathname.startsWith("/search/")) {
    if (!openExactMatch(search)) banner("setscope: click the right result");
    return;
  }
  if (location.pathname.startsWith("/tracklist/")) {
    await captureSet();
    return;
  }
  if (!CAPTURE_PAGES.test(location.pathname)) {
    banner("setscope: open the track or DJ page you want");
    return;
  }

  banner("setscope: collecting sets…");
  const urls = await waitForLinks();
  if (urls.length === 0) {
    banner("setscope: no sets on this page");
    return;
  }
  const reply = await chrome.runtime.sendMessage({ type: "capture", pageUrl: location.href, urls });
  if (reply?.ok) {
    const { queued, alreadyCached } = reply.result;
    banner(`setscope: sent ${urls.length} sets (${queued} new, ${alreadyCached} already cached). Closing…`);
  } else {
    banner(`setscope: couldn't reach the app (${reply?.error ?? "unknown error"}). Is npm run web running?`);
  }
}

/** Wait for the track rows to render, then send the whole page to setscope. */
async function captureSet() {
  banner("setscope: reading this set…");
  for (let i = 0; i < 20 && document.querySelectorAll(".tlpItem").length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (document.querySelectorAll(".tlpItem").length === 0) {
    banner("setscope: no tracks on this page");
    return;
  }
  const reply = await chrome.runtime.sendMessage({
    type: "captureSet",
    pageUrl: location.href,
    html: document.documentElement.outerHTML,
  });
  banner(
    reply?.ok
      ? `setscope: saved ${reply.result.tracks} tracks. Closing…`
      : `setscope: couldn't save this set (${reply?.error ?? "unknown error"}).`,
  );
}

main();
