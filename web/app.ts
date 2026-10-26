// The browser side of setscope. The server strips the types and serves this as
// /app.js. `import type` lines vanish at runtime, so the page shares the report
// types with the analysis code without bundling any of it.
//
// Each page has its own address (the part after #), so links, Back and Forward work:
//   #/                               Home: for you, a trending preview, your categories
//   #/trending                       Trending
//   #/account                        Your library, collecting, settings
//   #/artist/<name>                  Artist page (songs open in place, without leaving it)
//   #/artist/<name>/song/<song>      Song page, under its artist
//   #/song/<text>                    A song search; moves to the song's page once found
//   #/category/<name>                One of your categories

import type { ArtistReport } from "../src/analysis/artist.ts";
import type { SetForYou } from "../src/analysis/personal.ts";
import type { ArtistProfile } from "../src/analysis/profile.ts";
import type { SongReport } from "../src/analysis/song.ts";
import type { TrendingItem, TrendingReport } from "../src/analysis/trending.ts";
import type { Ranked, SetSummary } from "../src/model.ts";
import type { BackgroundStatus } from "../src/source/background.ts";
import type { DiscoveryRecord } from "../src/collect/discovery.ts";
import type { QueueStatus } from "../src/collect/jobs.ts";
import type { SongInfoResult } from "../src/source/songinfo.ts";
import { mountPlayerBar, PlayerCore, SoundCloudProvider } from "./player.ts";

type Mode = "song" | "artist";

type Route =
  | { page: "home" }
  | { page: "trending" }
  | { page: "account" }
  | { page: "artist"; name: string; exact: boolean }
  | { page: "song"; artist: string; song: string }
  | { page: "search"; query: string; exact: boolean }
  | { page: "category"; name: string };

interface Status {
  sets: number;
  since: string;
  queue: QueueStatus;
  background?: BackgroundStatus;
}

/** Your likes and categories, refreshed whenever you change them. */
interface Me {
  likes: string[];
  categories: { name: string; songs: string[] }[];
}

type ArtistPage = ArtistReport & { profile: ArtistProfile; discovery?: DiscoveryRecord };

/** Waiting sets listed before "Show the rest". */
const LIST_PREVIEW = 3;
/** Songs listed on an artist page before "Show all". */
const SONG_PREVIEW = 15;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Like $, for elements that only exist on some pages (the queue card lives on Account). */
const maybe = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

let mode: Mode = "song";
let route: Route = { page: "home" };
let me: Me = { likes: [], categories: [] };

/** Who's signed in, and whether sign-up is open, invite-only or closed. */
interface AuthState {
  user: { id: number; email: string; displayName: string; owner: boolean } | null;
  signup: "open" | "invite" | "closed";
}
let auth: AuthState = { user: null, signup: "closed" };
let lastStatus: Status | undefined;
let doneAtLastRender = 0;
let setsAtLastRender = 0;

// ---- small DOM helpers: build elements with text set safely (names come from the web) ----

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

const enc = encodeURIComponent;

/** "A & B ft. C - Title" -> ["A", "B", "C"], close enough to the server's rule for links. */
function artistsOf(song: string): string[] {
  const dash = song.indexOf(" - ");
  const artist = dash === -1 ? song : song.slice(0, dash);
  return artist
    .split(/\s*[,&]\s*|\s+(?:x|vs\.?|ft\.|feat\.?)\s+/i)
    .map((a) => a.trim())
    .filter((a) => a && a.toUpperCase() !== "ID");
}

function artistHash(name: string, exact = false): string {
  return `#/artist/${enc(name)}${exact ? "/exact" : ""}`;
}

/** Song pages live under their (first) artist's page. */
function songHash(song: string, artist = artistsOf(song)[0] ?? song): string {
  return `#/artist/${enc(artist)}/song/${enc(song)}`;
}

function categoryHash(name: string): string {
  return `#/category/${enc(name)}`;
}

function songLink(song: string, label: string = song): HTMLElement {
  return el("a", { class: "link", href: songHash(song) }, label);
}

function artistLink(name: string): HTMLElement {
  return el("a", { class: "link", href: artistHash(name) }, name);
}

function externalLink(href: string, label: string, cls = "link"): HTMLElement {
  return el("a", { class: cls, href, target: "_blank", rel: "noopener" }, label);
}

function joined(nodes: HTMLElement[], separator = " · "): (Node | string)[] {
  return nodes.flatMap((n, i) => (i ? [separator, n] : [n]));
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * A card with a ranked list. `linkTo` makes each name a link to its song or artist
 * page; `action` can add a button to a row (e.g. "Get sets" next to a DJ).
 */
function rankedCard(
  title: string,
  items: Ranked[],
  unit: string,
  empty: string,
  options: { linkTo?: Mode; action?: (item: Ranked) => HTMLElement | undefined } = {},
): HTMLElement {
  const max = items[0]?.count ?? 1;
  const list = el("ol", { class: "ranked" });
  for (const item of items) {
    const fill = el("span", { class: "fill", style: `width:${(item.count / max) * 100}%` });
    const label = options.linkTo === "song" ? songLink(item.name) : options.linkTo === "artist" ? artistLink(item.name) : item.name;
    const row = el("li", { title: plural(item.count, unit) }, fill, el("span", { class: "n" }, String(item.count)), el("span", { class: "name" }, label));
    const button = options.action?.(item);
    if (button) row.append(button);
    list.append(row);
  }
  return el("div", { class: "card" }, el("h2", {}, title), items.length ? list : el("p", { class: "muted small" }, empty));
}

function chips(items: { name: string; href: string }[]): HTMLElement {
  return el("div", { class: "chips" }, ...items.map((i) => el("a", { class: "chip", href: i.href }, i.name)));
}

function stat(value: string | number, label: string): HTMLElement {
  return el("span", { class: "stat" }, el("b", {}, String(value)), el("span", {}, label));
}

function soundcloudSearch(song: string): string {
  return `https://soundcloud.com/search/sounds?q=${enc(song.replace(/\s+-\s+/, " "))}`;
}

/** A list of sets: date, title (to 1001Tracklists), and a SoundCloud player link when there is one. */
function setsCard(title: string, sets: (SetSummary & { liked?: string[] })[], empty = "none", preview = Number.POSITIVE_INFINITY): HTMLElement {
  const list = el("ol", { class: "sets" });
  sets.forEach((set, i) => {
    const listen = set.soundcloud ? playButton(set) : el("span", { class: "muted small" }, "no recording");
    const row = el(
      "li",
      {},
      el("span", { class: "muted small date" }, set.date),
      el(
        "span",
        { class: "set-name" },
        externalLink(set.url, set.title),
        set.liked?.length ? el("div", { class: "small muted" }, `♥ ${set.liked.length}: ${set.liked.join(", ")}`) : "",
      ),
      listen,
    );
    if (i >= preview) row.hidden = true;
    list.append(row);
  });
  const card = el("div", { class: "card" }, el("h2", {}, title), sets.length ? list : el("p", { class: "muted small" }, empty));
  if (sets.length > preview) card.append(showAllButton(list, sets.length));
  return card;
}

// ---- playback ----

/** The one player for the whole app (see player.ts). */
const player = new PlayerCore((events) => new SoundCloudProvider($<HTMLIFrameElement>("scFrame"), events));
mountPlayerBar(player, $("player"), $<HTMLIFrameElement>("scFrame"));

/** ▶ Play for a set with a recording; shows ❚❚ while it's the one playing. */
function playButton(set: SetSummary): HTMLElement {
  const button = el("button", { type: "button", class: "play-btn", "data-source": set.soundcloud! }, "▶ Play");
  button.addEventListener("click", () =>
    player.play({
      provider: "soundcloud",
      source: set.soundcloud!,
      title: set.title,
      subtitle: `${set.djs.join(" & ")} · ${set.date}`,
      pageUrl: set.url,
    }),
  );
  markPlaying(button);
  return button;
}

function markPlaying(button: Element): void {
  const state = player.get();
  const mine = player.isCurrent((button as HTMLElement).dataset.source ?? "");
  const on = mine && (state.status === "playing" || state.status === "loading");
  button.classList.toggle("on", on);
  button.textContent = on ? (state.status === "loading" ? "Loading…" : "❚❚ Pause") : "▶ Play";
}

// Keep every play button on the page in step with the player.
player.subscribe(() => {
  for (const button of document.querySelectorAll(".play-btn")) markPlaying(button);
});

/** "Show all N" / "Show fewer" for a list whose extra rows start hidden. */
function showAllButton(list: HTMLElement, total: number): HTMLElement {
  const button = el("button", { type: "button", class: "act" }, `Show all ${total}`);
  let open = false;
  const extra = [...list.children].filter((c) => (c as HTMLElement).hidden) as HTMLElement[];
  button.addEventListener("click", () => {
    open = !open;
    for (const row of extra) row.hidden = !open;
    button.textContent = open ? "Show fewer" : `Show all ${total}`;
  });
  return button;
}

// ---- talking to the server ----

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** POST to one of our own endpoints (they need the X-Setscope header), then refresh progress. */
async function post<T = unknown>(path: string, body: object = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setscope": "1" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  void poll();
  if (res.status === 401) {
    const error = $("formError");
    error.replaceChildren(`${json.error} `, el("a", { class: "link", href: "#/account" }, "Sign in"));
    error.hidden = false;
  }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** The freshness window in months, remembered between visits. */
function months(): string {
  try {
    return localStorage.getItem("setscope.months") ?? "18";
  } catch {
    return "18";
  }
}

function monthsSelect(onChange: () => void): HTMLElement {
  const options: [string, string][] = [["6", "last 6 months"], ["12", "last 12 months"], ["18", "last 18 months"], ["24", "last 24 months"], ["36", "last 3 years"], ["1200", "all time"]];
  const select = el("select", { "aria-label": "Freshness window" }, ...options.map(([v, t]) => el("option", v === months() ? { value: v, selected: "" } : { value: v }, t))) as HTMLSelectElement;
  select.addEventListener("change", () => {
    try {
      localStorage.setItem("setscope.months", select.value);
    } catch {
      // private mode: just don't remember it
    }
    onChange();
  });
  return select;
}

async function loadMe(): Promise<void> {
  try {
    [auth, me] = await Promise.all([getJson<AuthState>("/api/auth/me"), getJson<Me>("/api/me")]);
  } catch {
    // keep what we had
  }
  const account = document.querySelector<HTMLAnchorElement>('.nav a[data-nav="account"]');
  if (account) account.textContent = auth.user ? auth.user.displayName : "Sign in";
}

// ---- navigation ----

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map((p) => decodeURIComponent(p));
  const [first, second, third, fourth] = parts;
  if (first === "trending") return { page: "trending" };
  if (first === "account") return { page: "account" };
  if (first === "artist" && second && third === "song" && fourth) return { page: "song", artist: second, song: fourth };
  if (first === "artist" && second) return { page: "artist", name: second, exact: third === "exact" };
  if (first === "song" && second) return { page: "search", query: second, exact: third === "exact" };
  if (first === "category" && second) return { page: "category", name: second };
  return { page: "home" };
}

/** Show whatever page the address names. */
async function showRoute(): Promise<void> {
  hideSuggest();
  route = parseRoute(location.hash);
  const nav = route.page === "trending" || route.page === "account" ? route.page : route.page === "home" ? "home" : "";
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".nav a")) a.classList.toggle("active", a.dataset.nav === nav);
  if (route.page === "artist") setMode("artist");
  if (route.page === "song" || route.page === "search") setMode("song");
  $<HTMLInputElement>("query").value = route.page === "song" ? route.song : route.page === "search" ? route.query : route.page === "artist" ? route.name : "";
  $("formError").hidden = true;
  await loadMe();
  await render();
  window.scrollTo({ top: 0 });
}

/** Draw the current page from fresh data. */
async function render(): Promise<void> {
  refreshWaiting = false;
  try {
    switch (route.page) {
      case "home":
        return show(await homePage());
      case "trending":
        return show(await trendingPage());
      case "account":
        return show(await accountPage());
      case "artist":
        return show(await artistPage(route.name, route.exact));
      case "song":
        return show(await songPage(route.song, route.artist, true));
      case "search":
        return show(await songPage(route.query, undefined, route.exact));
      case "category":
        return show(await categoryPage(route.name));
    }
  } catch (e) {
    show(el("div", { class: "card" }, el("p", { class: "error" }, (e as Error).message)));
  }
}

/** Replace the page, with a short fade so moving between pages feels like moving. */
function show(...nodes: Node[]): void {
  const view = $("view");
  view.replaceChildren(...nodes);
  view.style.animation = "none";
  void view.offsetWidth;
  view.style.animation = "";
  if (route.page === "account") mountQueueCard();
  if (lastStatus) renderStatus(lastStatus);
}

function pageHead(title: string | Node, sub?: string | Node, crumbs?: (Node | string)[], right?: Node): HTMLElement {
  return el(
    "div",
    { class: "page-head" },
    crumbs ? el("div", { class: "crumbs" }, ...crumbs) : "",
    el("div", { class: "row" }, el("div", {}, el("h1", {}, title), sub ? el("div", { class: "muted small" }, sub) : ""), right ?? ""),
  );
}

const homeCrumb = () => el("a", { href: "#/" }, "Home");

// ---- Home ----

interface ForYou {
  likes: string[];
  sets: SetForYou[];
  songs: Ranked[];
}

async function homePage(): Promise<HTMLElement> {
  const [forYou, trend] = await Promise.all([
    getJson<ForYou>(`/api/for-you?months=${months()}`),
    getJson<TrendingReport>(`/api/trending?days=30&months=${months()}`),
  ]);
  const sets = lastStatus?.sets ?? 0;
  const page = el(
    "div",
    { class: "stack" },
    pageHead("What are DJs playing?", `${plural(sets, "set")} cached · ${plural(forYou.likes.length, "liked song")} · search a song or artist above`),
  );

  if (!auth.user) {
    page.append(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "For you"),
        el("p", { class: "muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to like songs and get sets and songs picked for you."),
      ),
    );
  } else if (forYou.likes.length === 0) {
    page.append(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "For you"),
        el("p", { class: "muted small" }, "Like songs (♡ on a song page) and this fills with sets that play them and songs you might like."),
      ),
    );
  } else {
    page.append(
      el(
        "div",
        { class: "grid" },
        setsCard("Sets with the most of your liked songs", forYou.sets, "No cached set has your liked songs yet.", 5),
        rankedCard("Songs you might like", forYou.songs, "shared set", "Like a few more songs, or gather more sets, to get suggestions.", { linkTo: "song" }),
      ),
    );
  }

  const preview = (title: string, kind: Mode, items: TrendingItem[]) => trendingList(title, kind, items.slice(0, 3));
  page.append(
    el(
      "div",
      { class: "card" },
      el("div", { class: "row" }, el("h2", {}, `Trending since ${trend.recentFrom}`), el("a", { class: "act-link", href: "#/trending" }, "See all trending →")),
      trend.enoughData
        ? el("div", { class: "grid" }, preview("Songs", "song", trend.songs), preview("Artists", "artist", trend.artists))
        : el("p", { class: "muted small" }, "Not enough cached sets to spot trends yet. Gather more sets, or turn on background collecting in Account."),
    ),
  );
  if (me.categories.length) {
    page.append(
      el("div", { class: "card" }, el("h2", {}, "Your categories"), chips(me.categories.map((c) => ({ name: `${c.name} (${c.songs.length})`, href: categoryHash(c.name) })))),
    );
  }
  return page;
}

// ---- Trending ----

function trendingList(title: string, kind: Mode, items: TrendingItem[]): HTMLElement {
  const list = el("ol", { class: "ranked" });
  for (const item of items) {
    const isNew = item.changePercent === null;
    list.append(
      el(
        "li",
        { title: `${item.recent} sets lately, ${item.earlier} before` },
        el("span", { class: "n" }, String(item.recent)),
        el("span", { class: "name" }, kind === "song" ? songLink(item.name) : artistLink(item.name)),
        el("span", { class: isNew ? "change new" : "change" }, isNew ? "NEW" : `+${item.changePercent}%`),
      ),
    );
  }
  return el("div", {}, el("h2", { class: "small" }, title), items.length ? list : el("p", { class: "muted small" }, "Nothing rising yet."));
}

let trendDays = "30";

async function trendingPage(): Promise<HTMLElement> {
  const r = await getJson<TrendingReport>(`/api/trending?days=${trendDays}&months=${months()}`);
  const windowSelect = el(
    "select",
    { "aria-label": "Trending window" },
    ...[["14", "last 2 weeks"], ["30", "last month"], ["90", "last 3 months"]].map(([v, t]) => el("option", v === trendDays ? { value: v!, selected: "" } : { value: v! }, t!)),
  ) as HTMLSelectElement;
  windowSelect.addEventListener("change", () => {
    trendDays = windowSelect.value;
    void render();
  });
  const note = r.enoughData
    ? `Share of sets after ${r.recentFrom} (${r.setsRecent} sets) vs. before (${r.setsEarlier}). Based on the sets you've collected, not all of 1001Tracklists.`
    : `Not enough cached sets to spot trends: it needs 5+ sets after ${r.recentFrom} and 5+ before (you have ${r.setsRecent} and ${r.setsEarlier}). Try a longer window, or gather more sets.`;
  return el(
    "div",
    { class: "stack" },
    pageHead("Trending", `Rising since ${r.recentFrom}`, undefined, windowSelect),
    el("p", { class: "muted small" }, note),
    r.enoughData
      ? el(
          "div",
          { class: "grid" },
          el("div", { class: "card" }, trendingList("Rising songs", "song", r.songs)),
          el("div", { class: "card" }, trendingList("Rising artists", "artist", r.artists)),
        )
      : "",
    el(
      "div",
      { class: "grid" },
      rankedCard(`Most played songs since ${r.recentFrom}`, r.topSongs, "set", "No sets in this window yet.", { linkTo: "song" }),
      rankedCard(`Most played artists since ${r.recentFrom}`, r.topArtists, "set", "No sets in this window yet.", { linkTo: "artist" }),
    ),
  );
}

// ---- Account ----

interface Account {
  user: { email: string; displayName: string; owner: boolean };
  sets: number;
  oldest?: string;
  newest?: string;
  likes: string[];
  categories: { name: string; songs: number }[];
  getSongBpmKey: boolean;
}

async function accountPage(): Promise<HTMLElement> {
  if (!auth.user) return signInPage();
  const a = await getJson<Account>("/api/account");
  const owner = a.user.owner;
  const signOut = el("button", { type: "button", class: "act" }, "Sign out");
  signOut.addEventListener("click", async () => {
    await post("/api/auth/logout");
    await loadMe();
    await render();
  });

  const likes = el("ol", { class: "ranked" });
  for (const song of a.likes) {
    const unlike = el("button", { type: "button", class: "act" }, "Unlike");
    unlike.addEventListener("click", async () => {
      await post("/api/like", { song, liked: false });
      await render();
    });
    likes.append(el("li", {}, el("span", { class: "name" }, songLink(song)), unlike));
  }


  const keyInput = el("input", { type: "password", placeholder: a.getSongBpmKey ? "•••••••• (saved)" : "Paste your API key", class: "small-input", autocomplete: "off" }) as HTMLInputElement;
  const keyMsg = el("span", { class: "small muted" }, a.getSongBpmKey ? "Key saved: song pages show key & BPM." : "No key yet: song pages can't show key & BPM.");
  const saveKey = el("button", { type: "button", class: "act" }, "Save");
  saveKey.addEventListener("click", async () => {
    try {
      await post("/api/account/getsongbpm-key", { key: keyInput.value });
      await render();
    } catch (e) {
      keyMsg.textContent = (e as Error).message;
    }
  });
  const clearKey = el("button", { type: "button", class: "act" }, "Remove");
  clearKey.addEventListener("click", async () => {
    await post("/api/account/getsongbpm-key", { key: "" });
    await render();
  });

  const linksText = el("textarea", { rows: "3", placeholder: "https://www.1001tracklists.com/tracklist/..." }) as HTMLTextAreaElement;
  const linksMsg = el("span", { class: "muted small" });
  const addLinks = el("button", { type: "button", class: "act" }, "Add");
  addLinks.addEventListener("click", async () => {
    try {
      const r = await post<{ found: number; queued: number; alreadyCached: number; skippedOld: number }>("/api/add-links", { text: linksText.value });
      linksMsg.textContent = `${plural(r.found, "link")}: ${r.queued} new, ${r.alreadyCached} already cached, ${r.skippedOld} older than your window.`;
      linksText.value = "";
    } catch (e) {
      linksMsg.textContent = (e as Error).message;
    }
  });

  const bgToggle = el("input", { type: "checkbox", id: "bgToggle" }) as HTMLInputElement;
  bgToggle.addEventListener("change", () => void post("/api/background", { enabled: bgToggle.checked }));

  return el(
    "div",
    { class: "stack" },
    pageHead(a.user.displayName, `${a.user.email}${owner ? " · site owner" : ""}`, undefined, signOut),
    el(
      "div",
      { class: "grid" },
      el("div", { class: "card" }, el("h2", {}, `Liked songs (${a.likes.length})`), a.likes.length ? likes : el("p", { class: "muted small" }, "Nothing liked yet.")),
      el(
        "div",
        { class: "card" },
        el("h2", {}, `Your categories (${a.categories.length})`),
        a.categories.length
          ? chips(a.categories.map((c) => ({ name: `${c.name} (${c.songs})`, href: categoryHash(c.name) })))
          : el("p", { class: "muted small" }, "Add a song to a category from its page."),
      ),
    ),
    el("h2", {}, "Collecting sets"),
    el("div", { id: "queueMount" }, el("div", { class: "card muted small", id: "queueIdle" }, "Nothing queued. Use “Gather more sets” on a song or artist page.")),
    owner
      ? el(
          "div",
          { class: "card" },
          el("div", { class: "row" }, el("label", { class: "switch" }, bgToggle, " ", el("b", {}, "Background collecting")), el("span", { id: "bgStatus", class: "small muted" })),
        )
      : "",
    el(
      "details",
      { class: "card" },
      el("summary", {}, el("b", {}, "Add sets by link"), " ", el("span", { class: "muted small" }, "paste 1001Tracklists set links, or any text containing them")),
      linksText,
      el("div", { class: "row" }, linksMsg, addLinks),
    ),
    owner ? el("h2", {}, "Song data") : "",
    owner
      ? el(
          "div",
          { class: "card" },
          el("div", { class: "row" }, el("b", {}, "Key & BPM from GetSongBPM"), externalLink("https://getsongbpm.com/api", "Get a free key", "act-link")),
          el("div", { class: "btns", style: "margin-top:8px" }, keyInput, saveKey, a.getSongBpmKey ? clearKey : ""),
          el("div", { style: "margin-top:6px" }, keyMsg),
        )
      : "",
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Your cache"),
      stat(a.sets, "sets cached"),
      a.oldest ? stat(a.oldest, "oldest set") : "",
      a.newest ? stat(a.newest, "newest set") : "",
      el("div", { class: "muted small" }, `Chrome extension: ${extensionInstalled() ? "connected" : "not detected in this browser"}`),
    ),
  );
}

/** Sign in, or create an account (the first one freely, then with an invite code). */
function signInPage(): HTMLElement {
  const field = (label: string, input: HTMLElement) => el("label", { class: "field" }, el("span", { class: "small muted" }, label), input);
  const input = (type: string, autocomplete: string) => el("input", { type, autocomplete, required: "" }) as HTMLInputElement;

  const loginEmail = input("text", "email");
  const loginPassword = input("password", "current-password");
  const loginMsg = el("p", { class: "error small" });
  const login = el("form", { class: "stack-form" }, field("Email", loginEmail), field("Password", loginPassword), el("button", { type: "submit", class: "primary" }, "Sign in"), loginMsg);
  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await post("/api/auth/login", { email: loginEmail.value, password: loginPassword.value });
      await loadMe();
      await render();
    } catch (e) {
      loginMsg.textContent = (e as Error).message;
    }
  });

  const name = input("text", "nickname");
  const email = input("text", "email");
  const password = input("password", "new-password");
  const invite = input("text", "off");
  const signupMsg = el("p", { class: "error small" });
  const signup = el(
    "form",
    { class: "stack-form" },
    field("Your name", name),
    field("Email", email),
    field("Password (10+ characters)", password),
    auth.signup === "invite" ? field("Invite code", invite) : "",
    el("button", { type: "submit", class: "primary" }, "Create account"),
    signupMsg,
  );
  signup.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const r = await post<{ imported?: { imported: number } }>("/api/auth/register", { displayName: name.value, email: email.value, password: password.value, inviteCode: invite.value });
      await loadMe();
      await render();
      if (r.imported?.imported) {
        const note = $("formError");
        note.textContent = `Moved ${plural(r.imported.imported, "like or category entry")} from before accounts into your account.`;
        note.hidden = false;
      }
    } catch (e) {
      signupMsg.textContent = (e as Error).message;
    }
  });

  const first = auth.signup === "open";
  return el(
    "div",
    { class: "stack" },
    pageHead(first ? "Create the owner account" : "Sign in", first ? "You're the first person here: this account will own the site (and gets your existing likes)." : "setscope is private: you need an account to like songs and collect sets."),
    el(
      "div",
      { class: "grid" },
      first ? "" : el("div", { class: "card" }, el("h2", {}, "Sign in"), login),
      auth.signup === "closed"
        ? el("div", { class: "card muted small" }, el("h2", {}, "New here?"), "Sign-up is closed. Ask the owner for an invite code.")
        : el("div", { class: "card" }, el("h2", {}, first ? "Your account" : "Create an account"), signup),
    ),
  );
}

// ---- Artist ----

async function artistPage(name: string, exact: boolean): Promise<HTMLElement> {
  const r = await getJson<ArtistPage>(`/api/artist?name=${enc(name)}&months=${months()}${exact ? "&exact=1" : ""}`);
  const p = r.profile;
  const initial = (p.name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  const avatar = p.image ? el("img", { class: "avatar", src: p.image, alt: "" }) : el("div", { class: "avatar" }, initial);
  const links = [...(p.page ? [{ label: "1001Tracklists", url: p.page }] : []), ...p.links];

  const header = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "profile" },
      avatar,
      el(
        "div",
        { class: "profile-body" },
        el("div", { class: "crumbs" }, homeCrumb(), " › Artist"),
        el("h1", {}, p.name),
        el("div", { class: "muted small" }, [p.country, p.lastSeen && `last seen ${p.lastSeen}`].filter(Boolean).join(" · ") || "No profile on the cached set pages yet"),
        r.discovery ? el("div", { class: "small gathered" }, gatheredLine(r.discovery)) : "",
        correctionNotice("artist", p.name, r.correctedFrom),
        el("div", {}, stat(p.ownSets.length, "of their sets cached"), stat(p.playedBy, "sets by others play them"), stat(p.songs.length, "of their songs played")),
        p.genres.length ? el("div", { class: "small" }, el("b", {}, "Genres: "), p.genres.map((g) => g.name).join(", ")) : "",
        p.labels.length ? el("div", { class: "small" }, el("b", {}, "Labels: "), p.labels.map((l) => l.name).join(", ")) : "",
        links.length ? el("div", { class: "chips" }, ...links.map((l) => externalLink(l.url, l.label, "chip"))) : "",
        el("div", { class: "btns", style: "margin-top:10px" }, findButton(p.ownSets.length ? "Gather more sets" : "Find their sets on 1001Tracklists", p.name, "artist", p.ownSets.length === 0)),
      ),
    ),
  );

  const page = el("div", { class: "stack" }, header);
  const suggestions = didYouMean("artist", r.suggestions ?? []);
  if (suggestions) page.append(suggestions);
  page.append(artistTrendCard(r), artistSongsCard(p));
  page.append(
    el(
      "div",
      { class: "grid" },
      setsCard(`Their sets (${p.ownSets.length})`, p.ownSets, "None of their own sets cached yet.", 5),
      rankedCard(`Who ${p.name} plays most`, r.mostPlayedArtists, "play", "No sets by this artist cached yet.", { linkTo: "artist" }),
    ),
  );
  return page;
}

/** "Last gathered Oct 26: 46 sets on their 1001Tracklists page (all of them) · 40 were already here · 6 new" */
function gatheredLine(d: DiscoveryRecord): string {
  const when = new Date(d.lastSuccessAt).toLocaleDateString([], { month: "short", day: "numeric" });
  const parts = [
    `Last gathered ${when}: ${plural(d.setsSeen, "set")} on their 1001Tracklists page${d.complete ? " (all of them)" : " (stopped at 300; gather again for more)"}`,
    `${d.setsIndexed} were already here`,
    `${d.setsNew} new`,
  ];
  if (d.setsOlder) parts.push(`${d.setsOlder} older than your window`);
  return parts.join(" · ");
}

function artistTrendCard(r: ArtistReport): HTMLElement {
  const { direction, recent, earlier } = r.trend;
  const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
  const badgeClass = { up: "up", down: "down", flat: "flat", "not enough data": "nodata" }[direction];
  const maxShare = Math.max(0.0001, ...r.monthly.map((m) => (m.sets ? m.setsWithArtist / m.sets : 0)));
  const bars = el("div", { class: "months" });
  for (const m of r.monthly) {
    const share = m.sets ? m.setsWithArtist / m.sets : 0;
    bars.append(el("div", { style: `height:${(share / maxShare) * 100}%`, title: `${m.month}: ${m.setsWithArtist}/${m.sets} sets` }));
  }
  return el(
    "div",
    { class: "card" },
    el("div", { class: "row" }, el("h2", {}, "Are other DJs playing them more?"), el("span", { class: `badge ${badgeClass}` }, direction.toUpperCase())),
    el("div", { class: "small" }, `Recent (since ${recent.from}): in ${recent.setsWithArtist} of ${recent.sets} sets by other DJs (${pct(recent.share)})`),
    el("div", { class: "small" }, `Earlier (${earlier.from} to ${earlier.to}): ${earlier.setsWithArtist} of ${earlier.sets} (${pct(earlier.share)})`),
    r.monthly.length ? bars : el("p", { class: "muted small" }, "No cached sets in range yet."),
    r.monthly.length ? el("div", { class: "months-labels" }, el("span", {}, r.monthly[0]!.month), el("span", {}, r.monthly.at(-1)!.month)) : "",
  );
}

/** Their songs; each row opens that song's numbers in place, without leaving the artist page. */
function artistSongsCard(p: ArtistProfile): HTMLElement {
  const list = el("ul", { class: "songs" });
  p.songs.forEach((song, i) => {
    const panel = el("div", { class: "song-panel" });
    panel.hidden = true;
    const row = el(
      "button",
      { type: "button", class: "song-row", "aria-expanded": "false" },
      el("span", { class: "caret" }, "▸"),
      el("span", { class: "name" }, song.name),
      song.genre ? el("span", { class: "muted small" }, song.genre) : "",
      el("span", { class: "muted small" }, plural(song.sets, "set")),
    );
    let loaded = false;
    row.addEventListener("click", async () => {
      const open = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(open));
      panel.hidden = !open;
      if (open && !loaded) {
        loaded = true;
        panel.replaceChildren(el("p", { class: "muted small" }, "Loading…"));
        try {
          const r = await getJson<SongReport>(`/api/song?q=${enc(song.name)}&months=${months()}&exact=1`);
          panel.replaceChildren(songSummary(r, p.name));
        } catch (e) {
          panel.replaceChildren(el("p", { class: "error small" }, (e as Error).message));
        }
      }
    });
    const item = el("li", {}, row, panel);
    if (i >= SONG_PREVIEW) item.hidden = true;
    list.append(item);
  });
  const card = el(
    "div",
    { class: "card" },
    el("h2", {}, `Their songs in sets (${p.songs.length})`),
    p.songs.length ? list : el("p", { class: "muted small" }, "None of their songs in the cached sets yet."),
  );
  if (p.songs.length > SONG_PREVIEW) card.append(showAllButton(list, p.songs.length));
  return card;
}

/** A song's key numbers, small enough to sit inside the artist page. */
function songSummary(r: SongReport, artist: string): HTMLElement {
  const name = r.matchedAs[0]?.name ?? r.song;
  return el(
    "div",
    {},
    el("div", { class: "row" }, songFacts(name, r.genre), el("div", { class: "btns" }, likeButton(name, r.liked ?? false, () => void 0), el("a", { class: "act-link", href: songHash(name, artist) }, "Open song page →"))),
    el(
      "div",
      { class: "grid", style: "margin-top:10px" },
      rankedCard("DJs who play it", r.topDjs.slice(0, 5), "set", "none", { linkTo: "artist" }),
      rankedCard("Played alongside", r.coPlayed.slice(0, 5), "set", "none", { linkTo: "song" }),
      ...(r.recurringIds.length ? [rankedCard("Recurring IDs", r.recurringIds.slice(0, 5), "set", "")] : []),
    ),
  );
}

// ---- Song ----

async function songPage(query: string, artist: string | undefined, exact: boolean): Promise<HTMLElement> {
  const r = await getJson<SongReport>(`/api/song?q=${enc(query)}&months=${months()}${exact ? "&exact=1" : ""}`);
  const none = r.setsWithSong === 0;
  const name = r.matchedAs[0]?.name ?? r.song;
  // A search that found the song moves to its proper page, under the artist.
  if (route.page === "search" && !none) {
    history.replaceState(null, "", songHash(name));
    route = parseRoute(location.hash);
  }
  const mainArtist = artist ?? artistsOf(name)[0];
  const crumbs: (Node | string)[] = [homeCrumb(), " › "];
  if (mainArtist && !none) crumbs.push(artistLink(mainArtist), " › ");
  crumbs.push("Song");

  const artists = artistsOf(name);
  const head = el(
    "div",
    { class: "card" },
    el("div", { class: "crumbs" }, ...crumbs),
    el(
      "div",
      { class: "row" },
      el(
        "div",
        {},
        el("h1", {}, name),
        artists.length && !none ? el("div", { class: "small" }, "by ", ...joined(artists.map(artistLink))) : "",
        el("div", { class: "muted small" }, none
          ? "No cached sets contain this song yet. Find it on 1001Tracklists and setscope will collect its sets."
          : `In ${r.setsWithSong} of ${r.setsConsidered} cached sets since ${r.since}.`),
        r.matchedAs.length > 1 ? el("div", { class: "muted small" }, `Also written as: ${r.matchedAs.slice(1).map((m) => m.name).join(", ")}`) : "",
        correctionNotice("song", name, r.correctedFrom),
        r.otherVersions?.length ? el("div", { class: "small" }, `Other songs called “${r.song}”:`, chips(r.otherVersions.map((v) => ({ name: v.name, href: songHash(v.name) })))) : "",
        none ? "" : songFacts(name, r.genre),
      ),
      el("div", { class: "btns" }, none ? "" : likeButton(name, r.liked ?? false, () => void render()), findButton(none ? "Find sets on 1001Tracklists" : "Gather more sets", name, "song", none)),
    ),
  );
  const page = el("div", { class: "stack" }, head);
  if (none) {
    const suggestions = didYouMean("song", r.suggestions);
    if (suggestions) page.append(suggestions);
    return page;
  }
  page.append(
    categoriesCard(name, r.categories ?? [], r.hints ?? []),
    el(
      "div",
      { class: "grid" },
      rankedCard("DJs who play it most", r.topDjs, "set", "none", {
        linkTo: "artist",
        action: (dj) => {
          if (!dj.url) return undefined;
          const button = el("button", { type: "button", class: "act", title: `Collect ${dj.name}'s sets from their 1001Tracklists page` }, "Get sets");
          button.addEventListener("click", () => openPage(dj.url!));
          return button;
        },
      }),
      rankedCard("Recurring IDs", r.recurringIds, "set", "No ID showed up in more than one of these sets."),
    ),
    rankedCard("Most played alongside it", r.coPlayed, "set", "none", { linkTo: "song" }),
    setsCard(`Sets with this song (newest ${r.sets.length} of ${r.setsWithSong})`, r.sets, "none", 5),
  );
  return page;
}

function findButton(label: string, query: string, kind: Mode, primary: boolean): HTMLElement {
  const button = el("button", { type: "button", class: primary ? "primary" : "" }, label);
  button.addEventListener("click", () => openOnSite(query, kind));
  return button;
}

/** "Showing results for X · Search for <typed> instead" when the server auto-corrected. */
function correctionNotice(kind: Mode, correctedTo: string, correctedFrom: string | undefined): HTMLElement | string {
  if (!correctedFrom) return "";
  const href = kind === "song" ? `#/song/${enc(correctedFrom)}/exact` : artistHash(correctedFrom, true);
  return el("div", { class: "small" }, "Showing results for ", el("b", {}, correctedTo), " · ", el("a", { class: "link", href }, `Search for “${correctedFrom}” instead`));
}

function didYouMean(kind: Mode, suggestions: Ranked[]): HTMLElement | undefined {
  if (suggestions.length === 0) return undefined;
  return el("div", { class: "card" }, el("h2", {}, "Did you mean"), chips(suggestions.map((s) => ({ name: s.name, href: kind === "song" ? songHash(s.name) : artistHash(s.name) }))));
}

function likeButton(song: string, liked: boolean, after: () => void): HTMLElement {
  const button = el("button", { type: "button", class: liked ? "like on" : "like", "aria-pressed": String(liked) }, liked ? "♥ Liked" : "♡ Like");
  button.addEventListener("click", async () => {
    if (!auth.user) {
      location.hash = "#/account";
      return;
    }
    liked = !liked;
    await post("/api/like", { song, liked });
    button.className = liked ? "like on" : "like";
    button.setAttribute("aria-pressed", String(liked));
    button.textContent = liked ? "♥ Liked" : "♡ Like";
    await loadMe();
    after();
  });
  return button;
}

/** "Tech House · F#m (4m) · 126 BPM · Find on SoundCloud", with key/BPM filled in when they arrive. */
function songFacts(song: string, genre: string | undefined): HTMLElement {
  const info = el("span", { class: "muted" }, "looking up key & BPM…");
  const line = el("div", { class: "small facts" }, genre ? el("b", {}, genre) : "", genre ? " · " : "", info, " · ", externalLink(soundcloudSearch(song), "Find on SoundCloud"));
  void (async () => {
    let r: SongInfoResult;
    try {
      r = await getJson<SongInfoResult>(`/api/song-info?song=${enc(song)}`);
    } catch {
      info.textContent = "key & BPM unavailable";
      return;
    }
    if (r.status === "ok") {
      const parts = [r.info.key && (r.info.openKey ? `${r.info.key} (${r.info.openKey})` : r.info.key), r.info.bpm && `${r.info.bpm} BPM`].filter(Boolean);
      info.replaceChildren(el("b", {}, parts.join(" · ") || "no key/BPM listed"), " ", externalLink(r.info.url ?? "https://getsongbpm.com", "data: GetSongBPM.com", "link credit"));
    } else if (r.status === "not-found") {
      info.replaceChildren("not on ", externalLink("https://getsongbpm.com", "GetSongBPM.com"));
    } else if (r.status === "no-key") {
      info.replaceChildren("key & BPM: ", el("a", { class: "link", href: "#/account" }, "add a GetSongBPM key"));
    } else {
      info.textContent = r.message;
    }
  })();
  return line;
}

/** Your categories for this song, an "add to category" box, and "maybe part of" hints. */
function categoriesCard(song: string, inCategories: string[], hints: { category: string; sets: number; of: number }[]): HTMLElement {
  if (!auth.user) {
    return el("div", { class: "card muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to like songs and sort them into your own categories.");
  }
  const label = async (category: string, on: boolean) => {
    await post("/api/label", { song, category, on });
    await loadMe();
    await render();
  };
  const current = inCategories.map((c) => {
    const remove = el("button", { type: "button", class: "chip-x", title: `Remove from ${c}` }, "×");
    remove.addEventListener("click", () => void label(c, false));
    return el("span", { class: "chip" }, el("a", { class: "link", href: categoryHash(c) }, c), remove);
  });
  const input = el("input", { type: "text", placeholder: "Add to a category…", list: "categoryNames", class: "small-input" }) as HTMLInputElement;
  const add = el("button", { type: "button", class: "act" }, "Add");
  const submit = () => {
    const name = input.value.trim();
    if (name) void label(name, true);
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  const names = el("datalist", { id: "categoryNames" }, ...me.categories.map((c) => el("option", { value: c.name })));
  const hintRows = hints.map((h) => {
    const yes = el("button", { type: "button", class: "act" }, `Add to ${h.category}`);
    yes.addEventListener("click", () => void label(h.category, true));
    return el("div", { class: "small hint" }, "Maybe part of ", el("a", { class: "link", href: categoryHash(h.category) }, `“${h.category}”`), ` · in ${h.sets} of its ${h.of} sets with ${h.category} songs `, yes);
  });
  return el(
    "div",
    { class: "card" },
    el("div", { class: "row" }, el("h2", {}, "Your categories"), el("div", { class: "btns" }, input, add, names)),
    current.length ? el("div", { class: "chips" }, ...current) : el("div", { class: "muted small" }, "Not in any of your categories yet."),
    ...hintRows,
  );
}

// ---- Category ----

interface CategoryData {
  name: string;
  songs: string[];
  suggestions: Ranked[];
}

async function categoryPage(name: string): Promise<HTMLElement> {
  const r = await getJson<CategoryData>(`/api/category?name=${enc(name)}&months=${months()}`);
  const songs = el("ol", { class: "ranked" });
  for (const song of r.songs) {
    const remove = el("button", { type: "button", class: "act" }, "Remove");
    remove.addEventListener("click", async () => {
      await post("/api/label", { song, category: r.name, on: false });
      if (r.songs.length === 1) location.hash = "#/account";
      else await render();
    });
    songs.append(el("li", {}, el("span", { class: "name" }, songLink(song)), remove));
  }
  return el(
    "div",
    { class: "stack" },
    pageHead(r.name, `Your category · ${plural(r.songs.length, "song")}`, [homeCrumb(), " › ", el("a", { href: "#/account" }, "Account"), " › Category"]),
    el("div", { class: "card" }, songs),
    rankedCard(`Might fit “${r.name}”`, r.suggestions, "shared set", "Add a few more songs, or gather more sets, to get suggestions.", {
      linkTo: "song",
      action: (item) => {
        const add = el("button", { type: "button", class: "act" }, "Add");
        add.addEventListener("click", async () => {
          await post("/api/label", { song: item.name, category: r.name, on: true });
          await render();
        });
        return add;
      },
    }),
  );
}

// ---- opening 1001Tracklists ----

const POPUP = "setscope-capture";
const POPUP_FEATURES = "popup,width=1100,height=900";

/**
 * Opens 1001Tracklists' own search in a popup, the same request their search box
 * sends. The extension opens the matching result (or you click it), collects every
 * set on that page, sends the links here, and closes the popup.
 */
function openOnSite(query: string, kind: Mode): void {
  if (!armExtension(query, kind)) return;
  window.open("about:blank", POPUP, POPUP_FEATURES);
  const form = el("form", { method: "post", action: "https://www.1001tracklists.com/search/result.php", target: POPUP }) as HTMLFormElement;
  form.append(
    el("input", { type: "hidden", name: "main_search", value: query.replace(/\s+-\s+/, " ") }),
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

function extensionInstalled(): boolean {
  return document.documentElement.dataset.setscopeExtension === "1";
}

// ---- collecting status: the strip on every page, the full card on Account ----

/** "/tracklist/abc/benny-benassi-welcome-to-my-house-384-2026-09-27.html" -> "benny benassi welcome to my house 384 · 2026-09-27" */
function setLabel(url: string): string {
  const slug = url.split("/").pop()?.replace(/\.html$/, "") ?? url;
  const date = slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
  const name = (date ? slug.slice(0, -date.length - 1) : slug).replace(/-/g, " ");
  return date ? `${name} · ${date}` : name;
}

/** Plain-words explanation for each kind of pause. */
function pauseMessage(q: QueueStatus): string {
  switch (q.pauseReason) {
    case "site": {
      // When the site says how long to wait (Retry-After), pass that on.
      const seconds = Number(q.blocked?.match(/Retry-After: (\d+)/)?.[1]);
      const wait = seconds >= 60 ? `about ${seconds >= 5400 ? `${Math.round(seconds / 3600)} hours` : seconds >= 3000 ? "an hour" : `${Math.round(seconds / 60)} minutes`}` : "15–30 minutes";
      return `1001Tracklists asked setscope to slow down, so it stopped. Next: wait ${wait}, then press Try again.`;
    }
    case "failure":
      return "A request failed (connection or page problem). Check your internet, then press Try again.";
    case "restart":
      return `${plural(q.waiting.length, "set")} were waiting when setscope last stopped. Press Try again to continue, or Clear queue.`;
    default:
      return "Paused.";
  }
}

function renderStatus(status: Status): void {
  lastStatus = status;
  $("cacheInfo").textContent = `${plural(status.sets, "set")} cached`;
  renderStrip(status.queue);
  renderQueueCard(status.queue);
  if (status.background) renderBackground(status.background);
}

/** One line on every page while something is being fetched or is paused. */
function renderStrip(q: QueueStatus): void {
  const strip = $("strip");
  const paused = q.state === "blocked";
  const active = q.state === "running" || paused || q.waiting.length > 0 || q.older > 0;
  $("stripRefresh").hidden = !refreshWaiting;
  strip.hidden = (!active && !refreshWaiting) || route.page === "account";
  if (strip.hidden) return;
  if (!active) {
    strip.classList.remove("paused");
    $("stripTitle").textContent = "New sets in";
    $("stripBar").hidden = true;
    $("stripMsg").textContent = "";
    return;
  }
  strip.classList.toggle("paused", paused);
  $("stripTitle").textContent =
    q.state === "running" ? `Collecting sets · ${q.done} of ${q.total}`
    : paused ? `Paused · ${plural(q.waiting.length, "set")} waiting`
    : `${plural(q.older, "older set")} set aside`;
  $("stripBar").hidden = q.state !== "running";
  ($("stripBar").firstElementChild as HTMLElement).style.width = `${q.total ? (q.done / q.total) * 100 : 0}%`;
  $("stripMsg").textContent =
    q.state === "running" ? `about ${Math.ceil(q.etaSeconds / 60)} min left`
    : paused ? (q.pauseReason === "site" ? "1001Tracklists asked to slow down" : "")
    : "older than your window";
}

let listOpen = false;
/** Last list drawn, so polling doesn't redraw (and flicker) when nothing changed. */
let listShown = "";

/** Put the queue card on the Account page and wire its buttons. */
function mountQueueCard(): void {
  const mount = maybe("queueMount");
  if (!mount || maybe("queueCard")) return;
  const template = $<HTMLTemplateElement>("queueTemplate");
  mount.append(template.content.cloneNode(true));
  listShown = "";
  $("resumeBtn").addEventListener("click", () => void post("/api/resume"));
  $("clearBtn").addEventListener("click", () => void post("/api/clear-queue"));
  $("olderBtn").addEventListener("click", () => void post("/api/include-older"));
  $("retryBtn").addEventListener("click", () => void post("/api/retry-failed"));
  // Batches are gone: everything found is fetched on its own. These stay hidden.
  $("moreBtn").hidden = true;
  $("allBtn").hidden = true;
}

function renderQueueCard(q: QueueStatus): void {
  const card = maybe("queueCard");
  if (!card) return;
  const paused = q.state === "blocked";
  const empty = q.state === "idle" && q.waiting.length === 0 && q.older === 0 && q.done === 0 && q.failed === 0;
  card.hidden = empty;
  const idle = maybe("queueIdle");
  if (idle) idle.hidden = !empty;
  if (empty) return;

  $("qTitle").textContent =
    q.state === "running" ? `Collecting set ${Math.min(q.done + 1, q.total)} of ${q.total}`
    : paused ? `Paused · ${plural(q.waiting.length, "set")} waiting`
    : q.done > 0 ? `Done: ${plural(q.done, "new set")} added`
    : `${plural(q.older, "older set")} set aside`;
  $("qEta").textContent = q.state === "running" ? `about ${Math.ceil(q.etaSeconds / 60)} min left` : "";
  $("qBarWrap").hidden = q.state !== "running";
  $("qBar").style.width = `${q.total ? (q.done / q.total) * 100 : 100}%`;
  $("qMsg").textContent = paused ? pauseMessage(q) : q.state === "running" ? "One set every 8 seconds, to stay polite. Pages update as sets arrive." : "";
  $("qDetails").hidden = !paused || !q.blocked || q.pauseReason === "restart";
  $("qDetailsText").textContent = q.blocked ?? "";
  $("resumeBtn").hidden = !paused;
  $("clearBtn").hidden = q.waiting.length === 0 && q.older === 0;
  $("failedBox").hidden = q.failed === 0;
  $("failedMsg").textContent = `${plural(q.failed, "set")} couldn't be fetched after a few tries (connection or page problems).`;
  $("olderBox").hidden = q.older === 0;
  $("olderMsg").textContent = `${plural(q.older, "set")} older than your window were set aside. Include them, then pick a longer window to see them in reports.`;
  renderWaiting(q.waiting, paused, q.pauseReason === "site");
}

/** Sets still to fetch: the next few, then "Show the rest" / "Hide the rest". Open buttons while paused. */
function renderWaiting(urls: string[], paused: boolean, blockedBySite: boolean): void {
  const key = `${listOpen}|${paused}|${blockedBySite}|${urls.join("\n")}`;
  if (key === listShown) return;
  listShown = key;
  if (urls.length === 0) {
    $("qList").replaceChildren();
    return;
  }
  const list = el("ol", { class: "ranked" });
  urls.forEach((url, i) => {
    const row = el("li", { class: paused && i === 0 ? "blocked-here" : "" }, el("span", { class: "name small" }, setLabel(url)));
    if (paused && i === 0) row.append(el("span", { class: "tag" }, blockedBySite ? "stopped here" : "next"));
    if (paused) {
      const open = el("button", { type: "button", class: i === 0 ? "act primary" : "act" }, "Open");
      open.addEventListener("click", () => openPage(url));
      row.append(open);
    }
    if (i >= LIST_PREVIEW && !listOpen) row.hidden = true;
    list.append(row);
  });
  const parts: (Node | string)[] = [
    el("div", { class: "small muted" }, paused ? "Up next. Open any one yourself: it saves and closes on its own." : "Up next:"),
    list,
  ];
  if (urls.length > LIST_PREVIEW) {
    const toggle = el("button", { type: "button", class: "act" }, listOpen ? "Hide the rest" : `Show the rest (${urls.length - LIST_PREVIEW})`);
    toggle.addEventListener("click", () => {
      listOpen = !listOpen;
      listShown = "";
      renderWaiting(urls, paused, blockedBySite);
    });
    parts.push(toggle);
  }
  $("qList").replaceChildren(...parts);
}

function renderBackground(b: BackgroundStatus): void {
  const toggle = maybe<HTMLInputElement>("bgToggle");
  const status = maybe("bgStatus");
  if (!toggle || !status) return;
  toggle.checked = b.enabled;
  const until = b.pausedUntil ? new Date(b.pausedUntil).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const text: Record<BackgroundStatus["state"], string> = {
    off: "Off. Turn on to slowly cache new sets from the 1001Tracklists front page while you're not collecting.",
    collecting: `Collecting · ${b.today} of ${b.dailyCap} today`,
    resting: `On · ${b.today} of ${b.dailyCap} today${b.pending ? ` · ${b.pending} front-page sets to go, one every 90 seconds` : " · checks the front page about once an hour"}`,
    "waiting-for-queue": `On · waiting for your queue to finish first · ${b.today} of ${b.dailyCap} today`,
    "daily-limit": `On · reached today's limit of ${b.dailyCap} sets; continues tomorrow`,
    paused: `Paused until ${until}: 1001Tracklists asked setscope to slow down.`,
  };
  status.textContent = text[b.state];
}

async function poll(): Promise<void> {
  let status: Status;
  try {
    status = await getJson<Status>("/api/status");
  } catch {
    $("cacheInfo").textContent = "server not reachable";
    return;
  }
  renderStatus(status);

  // Refresh the page as data arrives: every few sets of your own, and once at the end.
  // Background collecting refreshes Home and Trending only, so an open artist page or
  // an expanded song doesn't jump around under you.
  const q = status.queue;
  const news = setsAtLastRender !== 0 && status.sets !== setsAtLastRender && (q.state !== "running" || q.done - doneAtLastRender >= 3);
  if (setsAtLastRender === 0) setsAtLastRender = status.sets;
  if (!news) return;
  doneAtLastRender = q.done;
  setsAtLastRender = status.sets;
  // Home and Trending just update. Pages you're reading (an artist with a song open,
  // a song, a category) don't change under you: the strip offers a Refresh instead.
  if (route.page === "home" || route.page === "trending") await render();
  else if (route.page !== "account") {
    refreshWaiting = true;
    renderStrip(q);
  }
}

/** New sets arrived while you were on a page that doesn't redraw itself. */
let refreshWaiting = false;

// ---- search box and dropdown: cached songs/artists that look like what you're typing ----

let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let suggestItems: Ranked[] = [];
let suggestIndex = -1;
/** Bumped on every lookup and every close, so only the latest lookup's answer is drawn. */
let suggestRequest = 0;

function go(kind: Mode, text: string): void {
  hideSuggest();
  const hash = kind === "artist" ? artistHash(text) : text.includes(" - ") ? songHash(text) : `#/song/${enc(text)}`;
  if (location.hash === hash) void render();
  else location.hash = hash;
}

/** Search-box text goes through a search, so auto-correct and title-only matching apply. */
function search(kind: Mode, text: string): void {
  hideSuggest();
  const hash = kind === "artist" ? artistHash(text) : `#/song/${enc(text)}`;
  if (location.hash === hash) void render();
  else location.hash = hash;
}

function hideSuggest(): void {
  clearTimeout(suggestTimer); // a lookup still on its way shouldn't reopen the list
  suggestRequest++;
  $("suggest").hidden = true;
  $("query").setAttribute("aria-expanded", "false");
  suggestIndex = -1;
}

function drawSuggest(): void {
  const box = $("suggest");
  box.replaceChildren(
    ...suggestItems.map((item, i) => {
      const option = el(
        "button",
        { type: "button", role: "option", "aria-selected": String(i === suggestIndex) },
        el("span", {}, item.name),
        el("span", { class: "count" }, plural(item.count, "set")),
      );
      // mousedown (not click) so it fires before the input loses focus and hides the list.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        go(mode, item.name);
      });
      return option;
    }),
  );
  box.hidden = suggestItems.length === 0;
  $("query").setAttribute("aria-expanded", String(!box.hidden));
}

async function updateSuggest(): Promise<void> {
  const request = ++suggestRequest;
  const q = $<HTMLInputElement>("query").value.trim();
  let items: Ranked[] = [];
  if (q.length >= 2) {
    try {
      items = await getJson<Ranked[]>(`/api/suggest?mode=${mode}&q=${enc(q)}&months=${months()}`);
    } catch {
      items = [];
    }
  }
  // Closed, or a newer lookup started, while this one was in flight.
  if (request !== suggestRequest || document.activeElement !== $("query")) return;
  suggestItems = items;
  suggestIndex = -1;
  drawSuggest();
}

function setMode(next: Mode): void {
  mode = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === next));
  }
  $<HTMLInputElement>("query").placeholder = next === "song" ? "Song title, or Artist - Title" : "Artist name";
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}
$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $<HTMLInputElement>("query").value.trim();
  if (text) search(mode, text);
});
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
    go(mode, suggestItems[suggestIndex]!.name);
  } else if (event.key === "Escape") {
    hideSuggest();
  }
});
$("query").addEventListener("blur", hideSuggest);

window.addEventListener("hashchange", () => void showRoute());
$("stripRefresh").addEventListener("click", () => void render());

// Give the extension a moment to mark the page before deciding to show setup steps.
setTimeout(() => {
  $("setup").hidden = extensionInstalled();
}, 800);

void poll().then(() => showRoute());
setInterval(() => void poll(), 1500);
