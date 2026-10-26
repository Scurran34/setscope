// The browser side of setscope. The server strips the types and serves this as
// /app.js. `import type` lines vanish at runtime, so the page shares the report
// types with the analysis code without bundling any of it.

import type { ArtistReport } from "../src/analysis/artist.ts";
import type { SongReport } from "../src/analysis/song.ts";
import type { Ranked } from "../src/model.ts";
import type { QueueStatus } from "../src/source/queue.ts";

type Mode = "song" | "artist";

interface Status {
  sets: number;
  since: string;
  queue: QueueStatus;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let mode: Mode = "song";
/** The report on screen, so it can refresh as new sets arrive. */
let shown: { mode: Mode; query: string; months: string } | undefined;
let doneAtLastRender = 0;

/** Matches BATCH_SIZE on the server: how many sets "Fetch more" asks for. */
const BATCH = 5;

// ---- small DOM helper: builds elements with text set safely (names come from the web) ----

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

/** `action` can add a button to a row (e.g. "Get sets" next to a DJ). */
function rankedCard(
  title: string,
  items: Ranked[],
  unit: string,
  empty: string,
  action?: (item: Ranked) => HTMLElement | undefined,
): HTMLElement {
  const max = items[0]?.count ?? 1;
  const list = el("ol", { class: "ranked" });
  for (const item of items) {
    const fill = el("span", { class: "fill", style: `width:${(item.count / max) * 100}%` });
    const units = item.count === 1 ? unit : `${unit}s`;
    const row = el("li", { title: `${item.count} ${units}` }, fill, el("span", { class: "n" }, String(item.count)), el("span", { class: "name" }, item.name));
    const button = action?.(item);
    if (button) row.append(button);
    list.append(row);
  }
  return el("div", { class: "card" }, el("h2", {}, title), items.length ? list : el("p", { class: "muted small" }, empty));
}

// ---- talking to the server ----

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

async function analyze(): Promise<void> {
  const query = $<HTMLInputElement>("query").value.trim();
  const months = $<HTMLSelectElement>("months").value;
  const error = $("formError");
  error.hidden = true;
  try {
    if (mode === "song") {
      const report = await getJson<SongReport>(`/api/song?q=${encodeURIComponent(query)}&months=${months}`);
      renderSong(report);
    } else {
      const report = await getJson<ArtistReport>(`/api/artist?name=${encodeURIComponent(query)}&months=${months}`);
      renderArtist(report);
    }
    shown = { mode, query, months };
  } catch (e) {
    error.textContent = (e as Error).message;
    error.hidden = false;
  }
}

// ---- rendering ----

function findButton(label: string, query: string, kind: Mode, primary: boolean): HTMLElement {
  const button = el("button", { type: "button", class: primary ? "primary" : "" }, label);
  button.addEventListener("click", () => openOnSite(query, kind));
  return button;
}

function renderSong(r: SongReport): void {
  const results = $("results");
  const none = r.setsWithSong === 0;
  const summary = el(
    "div",
    { class: "card row" },
    el(
      "div",
      {},
      el("b", {}, r.matchedAs[0]?.name ?? r.song),
      el("div", { class: "muted small" }, none
        ? "No cached sets contain this song yet. Find it on 1001Tracklists and setscope will collect its sets."
        : `In ${r.setsWithSong} of ${r.setsConsidered} cached sets since ${r.since}.`),
      r.matchedAs.length > 1
        ? el("div", { class: "muted small" }, `Also written as: ${r.matchedAs.slice(1).map((m) => m.name).join(", ")}`)
        : "",
    ),
    findButton(none ? "Find sets on 1001Tracklists" : "Find more sets", r.song, "song", none),
  );
  results.replaceChildren(summary);
  if (none && r.suggestions.length > 0) {
    const buttons = r.suggestions.map((sug) => {
      const button = el("button", { type: "button" }, `${sug.name} (${sug.count} ${sug.count === 1 ? "set" : "sets"})`);
      button.addEventListener("click", () => {
        $<HTMLInputElement>("query").value = sug.name;
        void analyze();
      });
      return button;
    });
    results.append(el("div", { class: "card" }, el("h2", {}, "Did you mean"), el("div", { class: "suggestions" }, ...buttons)));
  }
  if (!none) {
    results.append(
      el(
        "div",
        { class: "grid" },
        rankedCard("DJs who play it most", r.topDjs, "set", "none", (dj) => {
          if (!dj.url) return undefined;
          const button = el("button", { type: "button", class: "act", title: `Collect ${dj.name}'s sets from their 1001Tracklists page` }, "Get sets");
          button.addEventListener("click", () => openPage(dj.url!));
          return button;
        }),
        rankedCard("Recurring IDs", r.recurringIds, "set", "No ID showed up in more than one of these sets."),
      ),
      rankedCard("Most played alongside it", r.coPlayed, "set", "none"),
    );
  }
  results.hidden = false;
}

function renderArtist(r: ArtistReport): void {
  const results = $("results");
  const { direction, recent, earlier } = r.trend;
  const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
  const badgeClass = { up: "up", down: "down", flat: "flat", "not enough data": "nodata" }[direction];

  const maxShare = Math.max(0.0001, ...r.monthly.map((m) => (m.sets ? m.setsWithArtist / m.sets : 0)));
  const bars = el("div", { class: "months" });
  for (const m of r.monthly) {
    const share = m.sets ? m.setsWithArtist / m.sets : 0;
    bars.append(el("div", { style: `height:${(share / maxShare) * 100}%`, title: `${m.month}: ${m.setsWithArtist}/${m.sets} sets` }));
  }
  const first = r.monthly[0]?.month ?? "";
  const last = r.monthly[r.monthly.length - 1]?.month ?? "";

  const trend = el(
    "div",
    { class: "card" },
    el("div", { class: "row" }, el("h2", {}, `Is ${r.artist} trending?`), el("span", { class: `badge ${badgeClass}` }, direction.toUpperCase())),
    el("div", { class: "small" }, `Recent (since ${recent.from}): in ${recent.setsWithArtist} of ${recent.sets} sets by other DJs (${pct(recent.share)})`),
    el("div", { class: "small" }, `Earlier (${earlier.from} to ${earlier.to}): ${earlier.setsWithArtist} of ${earlier.sets} (${pct(earlier.share)})`),
    r.monthly.length ? bars : el("p", { class: "muted small" }, "No cached sets in range yet."),
    r.monthly.length ? el("div", { class: "months-labels" }, el("span", {}, first), el("span", {}, last)) : "",
  );

  results.replaceChildren(
    el(
      "div",
      { class: "card row" },
      el("div", {}, el("b", {}, r.artist), el("div", { class: "muted small" }, `${r.ownSets} of their own sets cached since ${r.since}.`)),
      findButton(r.ownSets === 0 ? "Find their sets on 1001Tracklists" : "Find more sets", r.artist, "artist", r.ownSets === 0),
    ),
    trend,
    el(
      "div",
      { class: "grid" },
      rankedCard(`Most played ${r.artist} tracks (recent)`, r.topTracksRecent, "set", "None in cached sets by other DJs."),
      rankedCard(`Who ${r.artist} plays most`, r.mostPlayedArtists, "play", "No sets by this artist cached yet."),
    ),
  );
  results.hidden = false;
}

// ---- opening 1001Tracklists ----

/**
 * Opens 1001Tracklists' own search in a popup, the same request their search box
 * sends. You click the right result (and pass their human check if asked); the
 * extension then sends the set links here and closes the popup.
 */
function openOnSite(query: string, kind: Mode): void {
  if (!armExtension(query, kind)) return;
  window.open("about:blank", POPUP, POPUP_FEATURES);
  const form = el("form", { method: "post", action: "https://www.1001tracklists.com/search/result.php", target: POPUP }) as HTMLFormElement;
  const searchText = query.replace(/\s+-\s+/, " ");
  form.append(
    el("input", { type: "hidden", name: "main_search", value: searchText }),
    el("input", { type: "hidden", name: "search_selection", value: kind === "song" ? "2" : "1" }),
  );
  document.body.append(form);
  form.submit();
  form.remove();
}

/**
 * Opens a 1001Tracklists page in the popup: a set the app couldn't fetch (the
 * extension saves it), or a DJ's page (the extension collects their set links).
 */
function openPage(url: string): void {
  if (armExtension("", "set")) window.open(url, POPUP, POPUP_FEATURES);
}

const POPUP = "setscope-capture";
const POPUP_FEATURES = "popup,width=1100,height=900";

/** Tell the extension the next 1001Tracklists tab is ours to read and close. False if it isn't installed. */
function armExtension(query: string, kind: Mode | "set"): boolean {
  if (!extensionInstalled()) {
    const error = $("formError");
    error.textContent =
      "The setscope extension isn't running in this browser, so nothing can collect the sets. " +
      "Open http://127.0.0.1:7331 in Chrome (with the extension loaded) and try again.";
    error.hidden = false;
    $("setup").hidden = false;
    return false;
  }
  window.postMessage({ source: "setscope-app", type: "arm", query, kind }, location.origin);
  return true;
}

/** "/tracklist/abc/benny-benassi-welcome-to-my-house-384-2026-09-27.html" -> "benny benassi welcome to my house 384 · 2026-09-27" */
function setLabel(url: string): string {
  const slug = url.split("/").pop()?.replace(/\.html$/, "") ?? url;
  const date = slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
  const name = (date ? slug.slice(0, -date.length - 1) : slug).replace(/-/g, " ");
  return date ? `${name} · ${date}` : name;
}

/** Last list drawn, so polling doesn't redraw (and flicker) when nothing changed. */
let waitingShown = "";

function renderWaiting(urls: string[]): void {
  const key = urls.join("\n");
  if (key === waitingShown) return;
  waitingShown = key;
  const list = el("ol", { class: "ranked" });
  urls.forEach((url, i) => {
    // The first one is where fetching stopped; make it easy to spot.
    const first = i === 0;
    const button = el("button", { type: "button", class: first ? "primary" : "" }, "Open");
    button.addEventListener("click", () => openPage(url));
    const row = el("li", { class: first ? "waiting blocked-here" : "waiting" }, button, el("span", { class: "name" }, setLabel(url)));
    if (first) row.append(el("span", { class: "tag" }, "stopped here"));
    list.append(row);
  });
  $("waitingList").replaceChildren(list);
}

// ---- progress polling ----

async function poll(): Promise<void> {
  let status: Status;
  try {
    status = await getJson<Status>("/api/status");
  } catch {
    $("cacheInfo").textContent = "server not reachable";
    return;
  }
  const q = status.queue;
  $("cacheInfo").textContent = `${status.sets} sets cached`;

  const card = $("progressCard");
  const found = q.found.length;
  card.hidden = q.state === "idle" && q.done === 0 && found === 0;
  if (!card.hidden) {
    const minutes = Math.ceil(q.etaSeconds / 60);
    $("progressTitle").textContent =
      q.state === "running" ? `Fetching set ${Math.min(q.done + 1, q.total)} of ${q.total}`
      : q.state === "blocked" ? "Paused"
      : q.done > 0 ? `Done: ${q.done} new sets added`
      : "Sets found";
    $("progressWrap").hidden = q.total === 0;
    $("foundBox").hidden = found === 0;
    if (found > 0) {
      const allMinutes = Math.ceil((found * 8) / 60);
      $("foundMsg").textContent = `${found} more ${found === 1 ? "set" : "sets"} found, not fetched yet (newest first).`;
      $("moreBtn").textContent = `Fetch ${Math.min(BATCH, found)} more`;
      $("allBtn").textContent = `Fetch all ${found} (~${allMinutes} min)`;
    }
    $("progressEta").textContent = q.state === "running" ? `about ${minutes} min left` : "";
    $("progressBar").style.width = `${q.total ? (q.done / q.total) * 100 : 100}%`;
    $("blockedBox").hidden = q.state !== "blocked";
    $("blockedMsg").textContent = q.blocked
      ? `${q.blocked} setscope won't try to get around this. Wait a few minutes and try again, or open the sets below yourself: each one saves and closes on its own.`
      : "";
    if (q.state === "blocked") renderWaiting(q.waiting);
  }

  // Refresh the report as data arrives: every few sets, and once at the end.
  if (shown && q.done !== doneAtLastRender && (q.state !== "running" || q.done - doneAtLastRender >= 3)) {
    doneAtLastRender = q.done;
    await analyze();
  }
}

// ---- search dropdown: cached songs/artists that look like what you're typing ----

let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let suggestItems: Ranked[] = [];
let suggestIndex = -1;

function hideSuggest(): void {
  $("suggest").hidden = true;
  $("query").setAttribute("aria-expanded", "false");
  suggestIndex = -1;
}

function pickSuggestion(item: Ranked): void {
  $<HTMLInputElement>("query").value = item.name;
  hideSuggest();
  void analyze();
}

function drawSuggest(): void {
  const box = $("suggest");
  box.replaceChildren(
    ...suggestItems.map((item, i) => {
      const units = item.count === 1 ? "set" : "sets";
      const option = el(
        "button",
        { type: "button", role: "option", "aria-selected": String(i === suggestIndex) },
        el("span", {}, item.name),
        el("span", { class: "count" }, `${item.count} ${units}`),
      );
      // mousedown (not click) so it fires before the input loses focus and hides the list.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pickSuggestion(item);
      });
      return option;
    }),
  );
  box.hidden = suggestItems.length === 0;
  $("query").setAttribute("aria-expanded", String(!box.hidden));
}

async function updateSuggest(): Promise<void> {
  const q = $<HTMLInputElement>("query").value.trim();
  const months = $<HTMLSelectElement>("months").value;
  if (q.length < 2) {
    suggestItems = [];
  } else {
    try {
      suggestItems = await getJson<Ranked[]>(`/api/suggest?mode=${mode}&q=${encodeURIComponent(q)}&months=${months}`);
    } catch {
      suggestItems = [];
    }
  }
  suggestIndex = -1;
  drawSuggest();
}

$("query").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => void updateSuggest(), 150);
});
$("query").addEventListener("keydown", (event) => {
  if ($("suggest").hidden) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    suggestIndex = (suggestIndex + step + suggestItems.length) % suggestItems.length;
    drawSuggest();
  } else if (event.key === "Enter" && suggestIndex >= 0) {
    event.preventDefault();
    pickSuggestion(suggestItems[suggestIndex]!);
  } else if (event.key === "Escape") {
    hideSuggest();
  }
});
$("query").addEventListener("blur", hideSuggest);

// ---- wiring ----

function setMode(next: Mode): void {
  mode = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === next));
  }
  $<HTMLInputElement>("query").placeholder = next === "song" ? "Artist - Title" : "Artist name";
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}
$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  hideSuggest();
  void analyze();
});
$("resumeBtn").addEventListener("click", () => void post("/api/resume"));
$("moreBtn").addEventListener("click", () => void post("/api/more", { count: BATCH }));
$("allBtn").addEventListener("click", () => void post("/api/more", { count: "all" }));
$("clearBtn").addEventListener("click", () => void post("/api/clear-found"));
$("addLinksBtn").addEventListener("click", async () => {
  const msg = $("addLinksMsg");
  try {
    const r = await post<{ found: number; queued: number; fetchingNow: number; alreadyCached: number; skippedOld: number }>(
      "/api/add-links",
      { text: $<HTMLTextAreaElement>("linksText").value },
    );
    msg.textContent = `${r.found} links: ${r.queued} new (fetching ${r.fetchingNow} now), ${r.alreadyCached} already cached, ${r.skippedOld} too old.`;
    $<HTMLTextAreaElement>("linksText").value = "";
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
});

/** POST to one of our own endpoints (they need the X-Setscope header), then refresh progress. */
async function post<T = unknown>(path: string, body: object = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setscope": "1" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  void poll();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** The extension marks this page when it's installed. */
function extensionInstalled(): boolean {
  return document.documentElement.dataset.setscopeExtension === "1";
}

// Give the extension a moment to mark the page before deciding to show setup steps.
setTimeout(() => {
  $("setup").hidden = extensionInstalled();
}, 800);

void poll();
setInterval(() => void poll(), 1500);
