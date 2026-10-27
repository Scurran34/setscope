// Runs on 1001Tracklists pages, but only does anything in a tab setscope opened.
//
// - Search results: opens the result if exactly one matches your search, otherwise
//   asks you to click the right one.
// - Human check: does nothing. You pass it; the page reloads and this runs again.
// - Track, DJ or artist page: scrolls to load every set on it (the page loads 20 at a
//   time), sends the links to setscope, and the background worker closes the tab.
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Links can render after load, so wait until the count stops growing (max ~10s). */
async function waitForLinks() {
  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const count = tracklistLinks().length;
    if (count > 0 && count === previous) break;
    previous = count;
    await pause(500);
  }
  return tracklistLinks();
}

/**
 * Only a safety stop for a page that never ends: a page you open is collected in full
 * (the biggest DJ pages have a few thousand sets, loaded 10 at a time).
 */
const MAX_SETS_PER_PAGE = 10_000;

/**
 * Track and DJ pages show the first ~16 sets and load 20 more each time you scroll to
 * the bottom. Scroll the way you would, pausing between loads, until nothing new
 * appears (or the cap). Only on a page you opened from setscope.
 */
/** How many of these links aren't in Rabbithole yet (asks the app; on failure, assumes all are new). */
async function countNew(urls) {
  const reply = await chrome.runtime.sendMessage({ type: "known", urls });
  if (!reply?.ok) return urls.length;
  const known = new Set(reply.result.known);
  return urls.filter((u) => !known.has(u.match(/\/tracklist\/([a-z0-9]+)\//i)?.[1])).length;
}

async function loadAllSets(limit, target) {
  // With a limit ("their last 20 sets") the newest sets are at the top, so stop scrolling
  // once there are that many (plus a few, in case the page mixes in other links).
  // With a target ("25 new sets") keep going past sets Rabbithole already has, to older
  // ones, until that many new ones are on screen (or the page ends).
  const enough = limit ? Math.min(MAX_SETS_PER_PAGE, limit + 5) : MAX_SETS_PER_PAGE;
  let urls = await waitForLinks();
  let complete = false;
  let stalls = 0;
  let fresh = target ? await countNew(urls) : 0;
  while (urls.length < enough && stalls < 2 && !(target && fresh >= target)) {
    banner(
      target ? `Rabbithole: finding ${target} new sets… ${Math.min(fresh, target)} so far (${urls.length - fresh} already in Rabbithole)`
      : limit ? `Rabbithole: gathering their last ${limit} sets… ${Math.min(urls.length, limit)} so far`
      : `Rabbithole: loading more sets… ${urls.length} so far`,
    );
    window.scrollTo(0, document.documentElement.scrollHeight);
    let grew = false;
    for (let i = 0; i < 8 && !grew; i++) {
      await pause(500);
      grew = tracklistLinks().length > urls.length;
    }
    if (grew) {
      stalls = 0;
      await pause(1_000); // let the batch finish rendering, and don't hammer the site
    } else {
      stalls++;
    }
    urls = tracklistLinks();
    if (target && grew) fresh = await countNew(urls);
  }
  // Stopped because nothing new appeared (the page's end), not because of the cap.
  complete = stalls >= 2;
  window.scrollTo(0, 0);
  return { urls: urls.slice(0, MAX_SETS_PER_PAGE), complete };
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
  banner(`Rabbithole: opening ${link.textContent.trim()}…`);
  location.assign(new URL(href, location.origin).href);
  return true;
}

async function main() {
  const { capture, search } = await chrome.runtime.sendMessage({ type: "isCaptureTab" });
  if (!capture || isChallenge()) return;

  if (location.pathname.startsWith("/search/")) {
    if (!openExactMatch(search)) banner("Rabbithole: click the right result");
    return;
  }
  if (location.pathname.startsWith("/tracklist/")) {
    await captureSet();
    return;
  }
  if (!CAPTURE_PAGES.test(location.pathname)) {
    banner("Rabbithole: open the track or DJ page you want");
    return;
  }

  banner(search?.target ? `Rabbithole: finding ${search.target} new sets…` : search?.limit ? `Rabbithole: gathering the last ${search.limit} sets…` : "Rabbithole: collecting sets…");
  const { urls, complete } = await loadAllSets(search?.limit ?? null, search?.target ?? null);
  if (urls.length === 0) {
    banner("Rabbithole: no sets on this page");
    return;
  }
  const reply = await chrome.runtime.sendMessage({ type: "capture", pageUrl: location.href, urls, complete, limit: search?.limit ?? null, target: search?.target ?? null, label: search?.query ?? null });
  if (reply?.ok) {
    const { queued, alreadyCached, skippedOld } = reply.result;
    const older = skippedOld ? ` · ${skippedOld} older than your window` : "";
    if (search?.target) {
      const more = queued < search.target ? ` (only ${queued} new on this page)` : "";
      banner(`Rabbithole: collecting ${queued} new sets${more} · ${alreadyCached} already in Rabbithole. Follow it in Rabbithole's header. Closing…`);
    } else if (search?.limit) {
      const taken = Math.min(urls.length, search.limit);
      banner(`Rabbithole: the last ${taken} sets · ${queued} new · ${alreadyCached} already in Rabbithole${older}. Closing…`);
    } else {
      const more = complete ? "" : " · stopped early, gather again for more";
      banner(`Rabbithole: ${urls.length} sets on this page · ${alreadyCached} already in Rabbithole · ${queued} new${older}${more}. Closing…`);
    }
  } else {
    banner(`Rabbithole: couldn't reach the app (${reply?.error ?? "unknown error"}). Is npm run web running?`);
  }
}

/** Wait for the track rows to render, then send the whole page to setscope. */
async function captureSet() {
  banner("Rabbithole: reading this set…");
  for (let i = 0; i < 20 && document.querySelectorAll(".tlpItem").length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (document.querySelectorAll(".tlpItem").length === 0) {
    banner("Rabbithole: no tracks on this page");
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
