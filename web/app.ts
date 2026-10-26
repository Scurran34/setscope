// The browser side of setscope. The server strips the types and serves this as
// /app.js. `import type` lines vanish at runtime, so the page shares the report
// types with the analysis code without bundling any of it.
//
// Each page has its own address (the part after #), so links, Back and Forward work:
//   #/                               Home: discovery first (trending songs and artists, recent sets)
//   #/songs?period=&genre=&q=&page=  Most played songs, by when sets were performed
//   #/artists?period=&genre=&q=&page= Artist rankings
//   #/sets?q=&dj=&year=&page=        DJ sets;  #/set/<id>  one set's tracklist
//   #/find/<text>                    Search results: songs, artists, sets
//   #/trending                       Rising songs and artists
//   #/library                        Your likes, categories, picks for you
//   #/account                        Your account, collecting, settings
//   #/artist/<name>                  Artist page (songs open in place, without leaving it)
//   #/artist/<name>/song/<song>      Song page, under its artist
//   #/song/<text>                    A song search; moves to the song's page once found
//   #/category/<name>                One of your categories
//   #/discover                       A SoundCloud curator's likes

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
import type { ArtistRow, Paged, Period, SetCard, SetLine, SongRow } from "../src/catalog/browse.ts";
import { mountPlayerBar, PlayerCore, SoundCloudProvider, type Playable } from "./player.ts";

type Mode = "song" | "artist";

type Route =
  | { page: "home" }
  | { page: "trending" }
  | { page: "account" }
  | { page: "library" }
  | { page: "songs"; params: URLSearchParams }
  | { page: "artists"; params: URLSearchParams }
  | { page: "sets"; params: URLSearchParams }
  | { page: "set"; id: string }
  | { page: "find"; query: string }
  | { page: "artist"; name: string; exact: boolean }
  | { page: "song"; artist: string; song: string }
  | { page: "search"; query: string; exact: boolean }
  | { page: "category"; name: string }
  | { page: "discover"; profile?: string };

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
  /** Is the SoundCloud app connected (search, remixes, Explore)? */
  soundcloud?: boolean;
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

/** A number in the stats strip under a page's hero. */
function bigStat(value: string | number, label: string): HTMLElement {
  return el("div", {}, el("b", {}, String(value)), el("span", {}, label));
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
        el("a", { class: "link", href: `#/set/${enc(set.id)}` }, set.title),
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
  return playableButton({
    provider: "soundcloud",
    source: set.soundcloud!,
    title: set.title,
    subtitle: `${set.djs.join(" & ")} · ${set.date}`,
    pageUrl: set.url,
  });
}

/** ▶ Play for anything the player can play (a set, a SoundCloud upload). `round`: the icon-only chart button. */
function playableButton(item: Playable, round = false): HTMLElement {
  const button = el("button", { type: "button", class: round ? "play-btn play-round" : "play-btn", "data-source": item.source, "aria-label": `Play ${item.title}` }, "▶ Play");
  button.addEventListener("click", () => player.play(item));
  markPlaying(button);
  return button;
}

function markPlaying(button: Element): void {
  const state = player.get();
  const mine = player.isCurrent((button as HTMLElement).dataset.source ?? "");
  const on = mine && (state.status === "playing" || state.status === "loading");
  button.classList.toggle("on", on);
  if (button.classList.contains("play-round")) button.textContent = on ? (state.status === "loading" ? "…" : "❚❚") : "▶";
  else button.textContent = on ? (state.status === "loading" ? "Loading…" : "❚❚ Pause") : "▶ Play";
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
  $("meName").textContent = auth.user ? auth.user.displayName : "Sign in";
  $("meDot").textContent = auth.user ? (auth.user.displayName.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase() : "?";
}

// ---- navigation ----

function parseRoute(hash: string): Route {
  // Names in addresses are encoded, so a literal "?" only starts our own filters.
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").map((p) => decodeURIComponent(p));
  const [first, second, third, fourth] = parts;
  if (first === "trending") return { page: "trending" };
  if (first === "account") return { page: "account" };
  if (first === "library") return { page: "library" };
  if (first === "songs") return { page: "songs", params };
  if (first === "artists") return { page: "artists", params };
  if (first === "sets") return { page: "sets", params };
  if (first === "set" && second) return { page: "set", id: second };
  if (first === "find" && second) return { page: "find", query: second };
  if (first === "artist" && second && third === "song" && fourth) return { page: "song", artist: second, song: fourth };
  if (first === "artist" && second) return { page: "artist", name: second, exact: third === "exact" };
  if (first === "song" && second) return { page: "search", query: second, exact: third === "exact" };
  if (first === "category" && second) return { page: "category", name: second };
  if (first === "discover") return second ? { page: "discover", profile: second } : { page: "discover" };
  return { page: "home" };
}

/** Show whatever page the address names. */
async function showRoute(): Promise<void> {
  hideSuggest();
  route = parseRoute(location.hash);
  const NAV: Partial<Record<Route["page"], string>> = {
    home: "home", songs: "songs", trending: "songs", song: "songs", search: "songs", artists: "artists", artist: "artists",
    sets: "sets", set: "sets", library: "library", category: "library", account: "account", discover: "discover",
  };
  const nav = NAV[route.page] ?? "";
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) a.classList.toggle("active", a.dataset.nav === nav);
  if (route.page === "artist") setMode("artist");
  if (route.page === "song" || route.page === "search") setMode("song");
  $<HTMLInputElement>("query").value = route.page === "find" ? route.query : "";
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
      case "library":
        return show(await libraryPage());
      case "songs":
        return show(await songsPage(route.params));
      case "artists":
        return show(await artistsPage(route.params));
      case "sets":
        return show(await setsPage(route.params));
      case "set":
        return show(await setPage(route.id));
      case "find":
        return show(await findPage(route.query));
      case "discover":
        return show(discoverPage(route.profile));
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

// ---- artwork, filters and paging (shared by the browse pages) ----

/** A real photo when we have one; otherwise a plain colored tile with initials (never a made-up cover). */
function art(name: string, image: string | null | undefined, cls = ""): HTMLElement {
  const fallback = () => {
    const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
    const initials = words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "♪";
    let hue = 0;
    for (const c of name) hue = (hue * 31 + c.codePointAt(0)!) % 360;
    return el("div", { class: `art ${cls}`, style: `background:linear-gradient(135deg,hsl(${hue} 55% 34%),hsl(${(hue + 60) % 360} 55% 16%))`, "aria-hidden": "true" }, initials);
  };
  if (!image) return fallback();
  const img = el("img", { class: `art ${cls}`, src: image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
}

/** Round ▶ for chart rows; a dimmed one when there's nothing to play yet. */
function playRound(item: Playable | null, missing = "No SoundCloud link yet: open the song to find one"): HTMLElement {
  if (item) return playableButton(item, true);
  return el("button", { type: "button", class: "play-round", disabled: "", title: missing, "aria-label": missing }, "▶");
}

const PERIOD_LABELS: Record<Period, string> = { week: "This Week", month: "This Month", "3months": "Last 3 Months", year: "Last 12 Months", all: "All Time" };
const PERIOD_WORDS: Record<Period, string> = { week: "week", month: "month", "3months": "3 months", year: "12 months", all: "" };

function periodTabs(current: Period, pick: (p: Period) => void): HTMLElement {
  return el(
    "div",
    { class: "tabs", role: "group", "aria-label": "Time" },
    ...(Object.keys(PERIOD_LABELS) as Period[]).map((p) => {
      const b = el("button", { type: "button", class: p === current ? "on" : "", "aria-pressed": String(p === current) }, PERIOD_LABELS[p]);
      b.addEventListener("click", () => pick(p));
      return b;
    }),
  );
}

let genreList: { name: string; lines: number }[] | undefined;

/** "All genres" + the catalog's genres, most common first. */
async function genreSelect(current: string, pick: (genre: string) => void): Promise<HTMLElement> {
  genreList ??= await getJson<{ name: string; lines: number }[]>("/api/genres").catch(() => []);
  const select = el(
    "select",
    { "aria-label": "Genre" },
    el("option", { value: "" }, "All genres"),
    ...genreList.map((g) => el("option", g.name === current ? { value: g.name, selected: "" } : { value: g.name }, g.name)),
  ) as HTMLSelectElement;
  select.addEventListener("change", () => pick(select.value));
  return select;
}

/** The same list page with some filters changed (and back to page 1 unless a page is given). */
function listHash(page: string, params: URLSearchParams, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(params);
  if (!("page" in changes)) next.delete("page");
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return `#/${page}${query ? `?${query}` : ""}`;
}

/** 1 2 3 … 20 › */
function pager(p: { page: number; pages: number }, hrefFor: (page: number) => string): HTMLElement {
  const nav = el("nav", { class: "pager", "aria-label": "Pages" });
  if (p.pages <= 1) return nav;
  const shown = new Set([1, p.pages, p.page - 1, p.page, p.page + 1].filter((n) => n >= 1 && n <= p.pages));
  if (p.page > 1) nav.append(el("a", { href: hrefFor(p.page - 1), "aria-label": "Previous page" }, "‹"));
  let last = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (n - last > 1) nav.append(el("span", { class: "gap" }, "…"));
    nav.append(n === p.page ? el("span", { class: "on", "aria-current": "page" }, String(n)) : el("a", { href: hrefFor(n) }, String(n)));
    last = n;
  }
  if (p.page < p.pages) nav.append(el("a", { href: hrefFor(p.page + 1), "aria-label": "Next page" }, "›"));
  return nav;
}

function trendCell(trend: number | "new" | null): HTMLElement {
  if (trend === null) return el("span", { class: "trend none", title: "Not enough sets in one of the two windows to say" }, "–");
  if (trend === "new") return el("span", { class: "trend new" }, "NEW");
  return el("span", { class: `trend ${trend >= 0 ? "up" : "down"}` }, `${trend >= 0 ? "▲" : "▼"} ${trend >= 0 ? "+" : ""}${trend}%`);
}

function sectionHead(title: string, seeAll?: string, right?: Node): HTMLElement {
  return el("div", { class: "section-head" }, el("h2", {}, title), el("div", { class: "btns" }, right ?? "", seeAll ? el("a", { class: "see-all", href: seeAll }, "See all →") : ""));
}

function songName(row: { artist: string; title: string }): string {
  return `${row.artist} - ${row.title}`;
}

/** The songs chart table (Home preview and the Songs page). */
function songsTable(rows: SongRow[], options: { compact?: boolean } = {}): HTMLElement {
  const head = el(
    "tr",
    {},
    el("th", { class: "rank" }, "#"),
    el("th", {}, "Song"),
    options.compact ? "" : el("th", { class: "hide-sm" }, "Genre"),
    el("th", { class: "num" }, "Sets"),
    options.compact ? "" : el("th", { class: "num hide-sm" }, "DJs"),
    el("th", { class: "num" }, "Trend"),
    el("th", {}, ""),
  );
  const body = rows.map((r) => {
    const name = songName(r);
    return el(
      "tr",
      {},
      el("td", { class: "rank" }, String(r.rank)),
      el(
        "td",
        { class: "song-col" },
        el(
          "div",
          { class: "song-cell" },
          art(r.artist, r.artistImage),
          el("div", {}, el("a", { href: songHash(name) }, r.title), el("div", { class: "who small" }, ...joined(artistsOf(name).map(artistLink), ", "))),
        ),
      ),
      options.compact ? "" : el("td", { class: "hide-sm muted small" }, r.genre ?? ""),
      el("td", { class: "num" }, String(r.sets)),
      options.compact ? "" : el("td", { class: "num hide-sm muted" }, String(r.djs)),
      el("td", { class: "num" }, trendCell(r.trend)),
      el("td", {}, playRound(r.soundcloud ? { provider: "soundcloud", source: r.soundcloud, title: r.title, subtitle: r.artist, pageUrl: r.soundcloud } : null)),
    );
  });
  return el("table", { class: "chart" }, el("thead", {}, head), el("tbody", {}, ...body));
}

/** One DJ set as a card: the DJ's photo (when we have one), event, DJs, date, track count. */
function setCardEl(set: SetCard): HTMLElement {
  const photo = set.djs.find((d) => d.image)?.image;
  const cover = el("div", { class: "cover" });
  const plain = () => {
    let hue = 0;
    for (const c of set.event) hue = (hue * 31 + c.codePointAt(0)!) % 360;
    cover.style.background = `linear-gradient(135deg,hsl(${hue} 50% 30%),hsl(${(hue + 70) % 360} 55% 14%))`;
    cover.replaceChildren(el("div", { class: "initials", "aria-hidden": "true" }, (set.djs[0]?.name ?? set.event).slice(0, 2).toUpperCase()));
  };
  if (photo) {
    const img = el("img", { src: photo, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", plain);
    cover.append(img);
  } else plain();
  const facts = [set.date ?? "date unknown", plural(set.tracks, "track"), set.ids ? plural(set.ids, "ID") : ""].filter(Boolean).join(" · ");
  return el(
    "div",
    { class: "set-card" },
    el(
      "a",
      { href: `#/set/${enc(set.id)}`, style: "text-decoration:none" },
      cover,
      el("div", { class: "info" }, el("div", { class: "event" }, set.event), el("div", { class: "djs" }, set.djs.map((d) => d.name).join(" & ") || "Unknown DJ"), el("div", { class: "facts" }, facts)),
    ),
    set.soundcloud
      ? playRound({ provider: "soundcloud", source: set.soundcloud, title: set.title, subtitle: `${set.djs.map((d) => d.name).join(" & ")} · ${set.date ?? ""}`, pageUrl: set.url })
      : "",
  );
}

function peopleList(rows: ArtistRow[]): HTMLElement {
  return el(
    "ol",
    { class: "people" },
    ...rows.map((a) =>
      el(
        "li",
        {},
        el(
          "a",
          { href: artistHash(a.name) },
          el("span", { class: "n" }, String(a.rank)),
          art(a.name, a.image, "round"),
          el("span", { class: "who" }, a.name, el("small", {}, `played in ${plural(a.playedIn, "set")}`)),
          trendCell(a.trend),
          el("span", { class: "chev", "aria-hidden": "true" }, "›"),
        ),
      ),
    ),
  );
}

function circles(rows: ArtistRow[]): HTMLElement {
  return el(
    "div",
    { class: "circles" },
    ...rows.map((a) => el("a", { href: artistHash(a.name) }, art(a.name, a.image, "round"), a.name, el("span", { class: "sub" }, `in ${plural(a.playedIn, "set")}`))),
  );
}

/** Fill a card once its data arrives (each Home section loads on its own). */
function loading(card: HTMLElement, title: string): HTMLElement {
  card.replaceChildren(el("h2", {}, title), el("p", { class: "muted small" }, "Loading…"));
  return card;
}

function failed(card: HTMLElement, title: string, error: unknown): void {
  card.replaceChildren(el("h2", {}, title), el("p", { class: "error small" }, (error as Error).message));
}

// ---- Home ----

async function homePage(): Promise<HTMLElement> {
  const heroInput = el("input", { type: "text", placeholder: "Search artists, songs, or sets…", "aria-label": "Search" }) as HTMLInputElement;
  const heroForm = el("form", { class: "hero-search", role: "search" }, heroInput, el("button", { type: "submit", class: "primary" }, "Search"));
  heroForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = heroInput.value.trim();
    if (text) location.hash = `#/find/${enc(text)}`;
  });
  const hero = el(
    "section",
    { class: "hero" },
    el("h1", {}, "Discover what's being played now."),
    el("p", {}, `The songs DJs keep reaching for, the artists behind them, and full tracklists, from ${plural(lastStatus?.sets ?? 0, "indexed DJ set")}.`),
    heroForm,
    el(
      "div",
      { class: "entry" },
      el("a", { href: "#/songs?period=week" }, "Top songs this week"),
      el("a", { href: "#/trending" }, "Rising"),
      el("a", { href: "#/artists" }, "Artists"),
      el("a", { href: "#/sets" }, "Latest sets"),
      el("a", { href: "#/discover" }, "Explore SoundCloud"),
    ),
  );

  // Trending songs, with its own time and genre filters.
  const songsCard = loading(el("section", { class: "card" }), "Trending Songs");
  let period: Period = "week";
  let genre = "";
  const drawSongs = async () => {
    try {
      const r = await getJson<Paged<SongRow>>(`/api/charts/songs?period=${period}&genre=${enc(genre)}&size=6`);
      const filters = el("div", { class: "filters" }, periodTabs(period, (p) => ((period = p), void drawSongs())), await genreSelect(genre, (g) => ((genre = g), void drawSongs())));
      songsCard.replaceChildren(
        sectionHead("Trending Songs", listHash("songs", new URLSearchParams(), { period, genre })),
        filters,
        r.items.length ? songsTable(r.items, { compact: true }) : el("p", { class: "empty" }, `No indexed sets ${period === "all" ? "yet" : `in the last ${PERIOD_WORDS[period]}`}.`),
      );
    } catch (e) {
      failed(songsCard, "Trending Songs", e);
    }
  };

  const artistsCard = loading(el("section", { class: "card" }), "Trending Artists");
  const exploreCard = loading(el("section", { class: "card" }), "Popular Artists to Explore");
  const setsSection = loading(el("section", { class: "card" }), "Recent DJ Sets");
  const youCard = loading(el("section", { class: "card" }), "Your Music");
  const vaultCard = vaultSpot();

  void drawSongs();
  void getJson<Paged<ArtistRow>>("/api/charts/artists?period=week&size=5")
    .then((r) => artistsCard.replaceChildren(sectionHead("Trending Artists", "#/artists?period=week"), r.items.length ? peopleList(r.items) : el("p", { class: "empty" }, "No sets this week yet.")))
    .catch((e) => failed(artistsCard, "Trending Artists", e));
  void getJson<Paged<ArtistRow>>("/api/charts/artists?period=3months&photo=1&size=8")
    .then((r) => exploreCard.replaceChildren(sectionHead("Popular Artists to Explore", "#/artists?period=3months"), circles(r.items)))
    .catch((e) => failed(exploreCard, "Popular Artists to Explore", e));
  void getJson<Paged<SetCard>>("/api/sets?size=8")
    .then((r) => setsSection.replaceChildren(sectionHead("Recent DJ Sets", "#/sets"), el("div", { class: "set-grid" }, ...r.items.map(setCardEl))))
    .catch((e) => failed(setsSection, "Recent DJ Sets", e));
  fillYourMusic(youCard);

  const scCard = el(
    "section",
    { class: "card" },
    sectionHead("Discover on SoundCloud"),
    el(
      "p",
      { class: "muted small" },
      auth.soundcloud
        ? "Browse what a DJ, label or friend has liked on SoundCloud, or open any song to find its SoundCloud upload and remixes."
        : "Once SoundCloud is connected (Account), you can browse curators' likes and find songs' uploads and remixes here.",
    ),
    el("div", { class: "btns" }, el("a", { class: "act-link", href: "#/discover" }, "Explore curators' likes →")),
  );

  return el(
    "div",
    { class: "stack" },
    hero,
    el("div", { class: "split" }, songsCard, artistsCard),
    exploreCard,
    setsSection,
    scCard,
    el("div", { class: "split" }, youCard, vaultCard),
  );
}

/** Home's one personal section: a few liked songs and your categories. */
function fillYourMusic(card: HTMLElement): void {
  if (!auth.user) {
    card.replaceChildren(
      sectionHead("Your Music"),
      el("p", { class: "muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to like songs, save SoundCloud finds and sort them into your own categories."),
    );
    return;
  }
  const likes = me.likes.slice(-6).reverse();
  card.replaceChildren(
    sectionHead(`Your Music`, "#/library"),
    likes.length
      ? el("ol", { class: "people" }, ...likes.map((song) => el("li", {}, el("a", { href: songHash(song) }, art(song, null), el("span", { class: "who" }, song.slice(song.indexOf(" - ") + 3), el("small", {}, artistsOf(song).join(", ")))))))
      : el("p", { class: "muted small" }, "Like songs (♡ on a song page) and they'll show up here."),
    me.categories.length ? el("div", { style: "margin-top:12px" }, chips(me.categories.map((c) => ({ name: `${c.name} (${c.songs.length})`, href: categoryHash(c.name) })))) : "",
  );
}

/** Where the Unreleased Vault will go: following IDs until they're identified or released. */
function vaultSpot(): HTMLElement {
  const stat = el("p", { class: "small muted" });
  void getJson<{ lines: number; sets: number }>("/api/vault-preview")
    .then((r) => (stat.textContent = `${plural(r.lines, "unidentified ID line")} across ${plural(r.sets, "indexed set")} so far.`))
    .catch(() => {});
  return el(
    "section",
    { class: "card vault-spot" },
    el("div", { class: "section-head" }, el("h2", {}, "Unreleased Vault"), el("span", { class: "soon" }, "Coming soon")),
    el("p", { class: "small" }, "Save the IDs you hear in sets, and setscope will tell you when one gets identified or released."),
    stat,
  );
}

// ---- Songs ----

async function songsPage(params: URLSearchParams): Promise<HTMLElement> {
  const period = (params.get("period") ?? "month") as Period;
  const genre = params.get("genre") ?? "";
  const q = params.get("q") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const r = await getJson<Paged<SongRow> & { setsInWindow: number }>(`/api/charts/songs?period=${period}&genre=${enc(genre)}&q=${enc(q)}&page=${page}`);
  const to = (changes: Record<string, string | null>) => (location.hash = listHash("songs", params, changes));

  const search = el("input", { type: "search", placeholder: "Search songs…", value: q, "aria-label": "Search songs" }) as HTMLInputElement;
  const form = el("form", {}, search);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    to({ q: search.value.trim() });
  });
  return el(
    "div",
    { class: "stack" },
    pageHead("Most Played Songs", "Songs played in the most DJ sets, counted by when each set was performed.", undefined, el("a", { class: "see-all", href: "#/trending" }, "Rising songs →")),
    el(
      "section",
      { class: "card" },
      el("div", { class: "filters" }, periodTabs(period, (p) => to({ period: p })), form, await genreSelect(genre, (g) => to({ genre: g }))),
      r.items.length ? songsTable(r.items) : el("p", { class: "empty" }, q ? `No songs matching “${q}” in this window.` : "No indexed sets in this window."),
      pager(r, (n) => listHash("songs", params, { page: String(n) })),
      el(
        "p",
        { class: "footnote" },
        `${plural(r.total, "song")} from ${plural(r.setsInWindow, "set")} indexed by setscope${period === "all" ? "" : ` in the last ${PERIOD_WORDS[period]}`}, not every set in existence. `,
        period === "all" ? "" : `Trend compares each song's share of sets with the ${PERIOD_WORDS[period]} before, and shows only when both windows have enough sets.`,
      ),
    ),
  );
}

// ---- Artists ----

async function artistsPage(params: URLSearchParams): Promise<HTMLElement> {
  const period = (params.get("period") ?? "3months") as Period;
  const genre = params.get("genre") ?? "";
  const q = params.get("q") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const r = await getJson<Paged<ArtistRow>>(`/api/charts/artists?period=${period}&genre=${enc(genre)}&q=${enc(q)}&page=${page}`);
  const to = (changes: Record<string, string | null>) => (location.hash = listHash("artists", params, changes));
  const search = el("input", { type: "search", placeholder: "Search artists…", value: q, "aria-label": "Search artists" }) as HTMLInputElement;
  const form = el("form", {}, search);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    to({ q: search.value.trim() });
  });
  const rows = r.items.map((a) =>
    el(
      "tr",
      {},
      el("td", { class: "rank" }, String(a.rank)),
      el("td", { class: "song-col" }, el("div", { class: "song-cell" }, art(a.name, a.image, "round"), el("div", {}, el("a", { href: artistHash(a.name) }, a.name), a.country ? el("div", { class: "who small muted" }, a.country) : ""))),
      el("td", { class: "num" }, String(a.playedIn)),
      el("td", { class: "num hide-sm muted" }, String(a.ownSets)),
      el("td", { class: "num" }, trendCell(a.trend)),
    ),
  );
  return el(
    "div",
    { class: "stack" },
    pageHead("Artists", "Ranked by how many DJ sets played their tracks (as artist or remixer)."),
    el(
      "section",
      { class: "card" },
      el("div", { class: "filters" }, periodTabs(period, (p) => to({ period: p })), form, await genreSelect(genre, (g) => to({ genre: g }))),
      r.items.length
        ? el(
            "table",
            { class: "chart" },
            el("thead", {}, el("tr", {}, el("th", { class: "rank" }, "#"), el("th", {}, "Artist"), el("th", { class: "num" }, "Played in sets"), el("th", { class: "num hide-sm" }, "Their own sets"), el("th", { class: "num" }, "Trend"))),
            el("tbody", {}, ...rows),
          )
        : el("p", { class: "empty" }, q ? `No artists matching “${q}”.` : "No indexed sets in this window."),
      pager(r, (n) => listHash("artists", params, { page: String(n) })),
      el("p", { class: "footnote" }, "Counts DJ sets indexed by setscope, by performance date. Photos come from 1001Tracklists profiles."),
    ),
  );
}

// ---- Sets ----

async function setsPage(params: URLSearchParams): Promise<HTMLElement> {
  const q = params.get("q") ?? "";
  const dj = params.get("dj") ?? "";
  const year = params.get("year") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const r = await getJson<Paged<SetCard>>(`/api/sets?q=${enc(q)}&dj=${enc(dj)}${year ? `&year=${year}` : ""}&page=${page}`);
  const to = (changes: Record<string, string | null>) => (location.hash = listHash("sets", params, changes));
  const search = el("input", { type: "search", placeholder: "Search sets or events…", value: q, "aria-label": "Search sets" }) as HTMLInputElement;
  const djInput = el("input", { type: "search", placeholder: "DJ", value: dj, "aria-label": "DJ", style: "width:160px" }) as HTMLInputElement;
  const form = el("form", {}, search, djInput, el("button", { type: "submit" }, "Filter"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    to({ q: search.value.trim(), dj: djInput.value.trim() });
  });
  const thisYear = new Date().getFullYear();
  const years = el(
    "select",
    { "aria-label": "Year" },
    el("option", { value: "" }, "All years"),
    ...Array.from({ length: 7 }, (_, i) => String(thisYear - i)).map((y) => el("option", y === year ? { value: y, selected: "" } : { value: y }, y)),
  ) as HTMLSelectElement;
  years.addEventListener("change", () => to({ year: years.value }));
  return el(
    "div",
    { class: "stack" },
    pageHead("Sets", `${plural(r.total, "DJ set")} indexed${dj ? ` with ${dj}` : ""}, newest performances first.`),
    el("div", { class: "filters" }, form, years, dj || q || year ? el("a", { class: "see-all", href: "#/sets" }, "Clear filters") : ""),
    r.items.length ? el("div", { class: "set-grid" }, ...r.items.map(setCardEl)) : el("div", { class: "card empty" }, "No sets match those filters."),
    pager(r, (n) => listHash("sets", params, { page: String(n) })),
  );
}

async function setPage(id: string): Promise<HTMLElement> {
  const s = await getJson<SetCard & { lines: SetLine[]; lastRefreshed: string | null }>(`/api/set?id=${enc(id)}`);
  const photo = s.djs.find((d) => d.image)?.image;
  const backdrop = el("div", { class: "backdrop" });
  if (photo) backdrop.style.backgroundImage = `url(${JSON.stringify(photo)})`;
  const playable: Playable | null = s.soundcloud ? { provider: "soundcloud", source: s.soundcloud, title: s.title, subtitle: `${s.djs.map((d) => d.name).join(" & ")} · ${s.date ?? ""}`, pageUrl: s.url } : null;
  const refresh = el("button", { type: "button" }, "Re-read this set");
  refresh.addEventListener("click", async () => {
    refresh.textContent = "Queued…";
    try {
      await post("/api/refresh-set", { url: s.url });
      refresh.textContent = "Queued: it'll update shortly";
    } catch (e) {
      refresh.textContent = (e as Error).message;
    }
  });
  const hero = el(
    "section",
    { class: "profile-hero" },
    backdrop,
    art(s.djs[0]?.name ?? s.event, photo, "lg"),
    el(
      "div",
      { class: "body" },
      el("div", { class: "crumbs" }, homeCrumb(), " › ", el("a", { href: "#/sets" }, "Sets"), " › Set"),
      el("div", { class: "kicker" }, "DJ set"),
      el("h1", {}, s.event),
      el("div", { class: "meta" }, ...joined(s.djs.map((d) => artistLink(d.name)), " & "), ` · ${s.date ?? "date unknown"}`),
      el("div", { class: "tags" }, el("span", {}, plural(s.tracks, "track")), s.ids ? el("span", {}, `${plural(s.ids, "unidentified ID")}`) : ""),
      el("div", { class: "btns", style: "margin-top:14px" }, playable ? playableButton(playable) : el("span", { class: "muted small" }, "No recording linked"), externalLink(s.url, "Open on 1001Tracklists", "act-link"), auth.user ? refresh : ""),
    ),
  );
  const lines = s.lines.map((l) =>
    el(
      "li",
      {},
      el("span", { class: "pos" }, String(l.position + 1)),
      el(
        "span",
        { class: "t" },
        l.isId ? el("span", {}, el("span", { class: "id" }, "ID "), `${l.artist} - ${l.title}`) : el("a", { href: songHash(l.song!) }, l.title),
        l.isId ? "" : el("div", { class: "who small muted" }, ...joined(artistsOf(l.song!).map(artistLink), ", ")),
      ),
      el("span", { class: "muted small hide-sm" }, l.genre ?? ""),
      l.soundcloud ? playableButton({ provider: "soundcloud", source: l.soundcloud, title: l.title, subtitle: l.artist, pageUrl: l.soundcloud }, true) : "",
    ),
  );
  return el(
    "div",
    { class: "stack" },
    hero,
    el(
      "section",
      { class: "card" },
      el("h2", {}, "Tracklist"),
      lines.length ? el("ol", { class: "tracklist" }, ...lines) : el("p", { class: "muted small" }, "No tracks listed."),
      el("p", { class: "footnote" }, "As written on 1001Tracklists.", s.lastRefreshed ? ` Last re-read ${new Date(s.lastRefreshed).toLocaleDateString()}.` : ""),
    ),
  );
}

// ---- Search results ----

interface FindResult {
  songs: Ranked[];
  artists: Ranked[];
  sets: SetCard[];
  setsTotal: number;
}

async function findPage(text: string): Promise<HTMLElement> {
  const r = await getJson<FindResult>(`/api/search?q=${enc(text)}&months=${months()}`);
  const nothing = !r.songs.length && !r.artists.length && !r.sets.length;
  return el(
    "div",
    { class: "stack" },
    pageHead(`Results for “${text}”`, nothing ? "Nothing indexed matches that yet." : `${plural(r.artists.length, "artist")} · ${plural(r.songs.length, "song")} · ${plural(r.setsTotal, "set")}`),
    el(
      "div",
      { class: "grid" },
      rankedCard("Songs", r.songs, "set", "No matching songs.", { linkTo: "song" }),
      rankedCard("Artists", r.artists, "set", "No matching artists.", { linkTo: "artist" }),
    ),
    r.sets.length
      ? el("section", { class: "card" }, sectionHead("Sets", r.setsTotal > r.sets.length ? listHash("sets", new URLSearchParams(), { q: text }) : undefined), el("div", { class: "set-grid" }, ...r.sets.map(setCardEl)))
      : "",
    el(
      "div",
      { class: "card small" },
      "Not what you meant? ",
      el("a", { class: "link", href: `#/song/${enc(text)}` }, "Search it as a song title"),
      " (with spelling fixes), or look it up on 1001Tracklists: ",
      findButton("Find songs", text, "song", false),
      " ",
      findButton("Find an artist", text, "artist", false),
    ),
  );
}

// ---- Library ----

async function libraryPage(): Promise<HTMLElement> {
  if (!auth.user) return signInPage();
  const [a, forYou] = await Promise.all([getJson<Account>("/api/account"), getJson<ForYou>(`/api/for-you?months=${months()}`)]);
  const likes = el("ol", { class: "ranked" });
  for (const song of a.likes) {
    const unlike = el("button", { type: "button", class: "act" }, "Unlike");
    unlike.addEventListener("click", async () => {
      await post("/api/like", { song, liked: false });
      await loadMe();
      await render();
    });
    likes.append(el("li", {}, el("span", { class: "name" }, songLink(song)), unlike));
  }
  return el(
    "div",
    { class: "stack" },
    pageHead("Your Library", `${plural(a.likes.length, "liked song")} · ${a.categories.length} ${a.categories.length === 1 ? "category" : "categories"}`),
    el(
      "div",
      { class: "grid" },
      el("section", { class: "card" }, el("h2", {}, `Liked songs (${a.likes.length})`), a.likes.length ? likes : el("p", { class: "muted small" }, "Nothing liked yet: ♡ a song on its page.")),
      el(
        "section",
        { class: "card" },
        el("h2", {}, `Your categories (${a.categories.length})`),
        a.categories.length
          ? chips(a.categories.map((c) => ({ name: `${c.name} (${c.songs})`, href: categoryHash(c.name) })))
          : el("p", { class: "muted small" }, "Add a song to a category from its page, or save a SoundCloud find into one."),
      ),
    ),
    forYou.likes.length
      ? el(
          "div",
          { class: "grid" },
          setsCard("Sets with the most of your liked songs", forYou.sets, "No indexed set has your liked songs yet.", 5),
          rankedCard("Songs you might like", forYou.songs, "shared set", "Like a few more songs, or gather more sets, to get suggestions.", { linkTo: "song" }),
        )
      : "",
  );
}

interface ForYou {
  likes: string[];
  sets: SetForYou[];
  songs: Ranked[];
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
  soundcloud: boolean;
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

  const scId = el("input", { type: "text", placeholder: a.soundcloud ? "•••••••• (saved)" : "Client ID", class: "small-input", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const scSecret = el("input", { type: "password", placeholder: a.soundcloud ? "•••••••• (saved)" : "Client secret", class: "small-input", autocomplete: "off" }) as HTMLInputElement;
  const scMsg = el("span", { class: "small muted" }, a.soundcloud
    ? "Connected: song pages can find SoundCloud links and remixes."
    : "Not connected: song links, remix search and Discover are off.");
  const saveSc = el("button", { type: "button", class: "act" }, "Save");
  saveSc.addEventListener("click", async () => {
    try {
      await post("/api/account/soundcloud", { clientId: scId.value, clientSecret: scSecret.value });
      await render();
    } catch (e) {
      scMsg.textContent = (e as Error).message;
    }
  });
  const clearSc = el("button", { type: "button", class: "act" }, "Disconnect");
  clearSc.addEventListener("click", async () => {
    await post("/api/account/soundcloud", { clientId: "", clientSecret: "" });
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
      { class: "card small" },
      `${plural(a.likes.length, "liked song")} and ${a.categories.length} ${a.categories.length === 1 ? "category" : "categories"} · `,
      el("a", { class: "link", href: "#/library" }, "Open your Library"),
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
    owner
      ? el(
          "div",
          { class: "card" },
          el("div", { class: "row" }, el("b", {}, "SoundCloud app"), externalLink("https://soundcloud.com/you/apps", "Your SoundCloud apps", "act-link")),
          el("div", { class: "muted small" }, "The secret stays on this computer (in data/) and is never shown again or sent to the page."),
          el("div", { class: "btns", style: "margin-top:8px" }, scId, scSecret, saveSc, a.soundcloud ? clearSc : ""),
          el("div", { style: "margin-top:6px" }, scMsg),
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
  const links = [...(p.page ? [{ label: "1001Tracklists", url: p.page }] : []), ...p.links];
  const backdrop = el("div", { class: "backdrop" });
  if (p.image) backdrop.style.backgroundImage = `url(${JSON.stringify(p.image)})`;

  const hero = el(
    "section",
    { class: "profile-hero" },
    backdrop,
    art(p.name, p.image, "xl round"),
    el(
      "div",
      { class: "body" },
      el("div", { class: "crumbs" }, homeCrumb(), " › ", el("a", { href: "#/artists" }, "Artists"), " › Artist"),
      el("div", { class: "kicker" }, "Artist"),
      el("h1", {}, p.name),
      el("div", { class: "meta" }, [p.country, p.genres[0]?.name].filter(Boolean).join(" · ") || "No profile on the indexed set pages yet"),
      r.discovery ? el("div", { class: "small gathered" }, gatheredLine(r.discovery)) : "",
      correctionNotice("artist", p.name, r.correctedFrom),
      p.genres.length > 1 || p.labels.length ? el("div", { class: "tags" }, ...p.genres.slice(0, 4).map((g) => el("span", {}, g.name)), ...p.labels.slice(0, 3).map((l) => el("span", {}, l.name))) : "",
      el(
        "div",
        { class: "btns", style: "margin-top:14px" },
        findButton(p.ownSets.length ? "Gather more sets" : "Find their sets on 1001Tracklists", p.name, "artist", true),
        el("a", { class: "act-link", href: listHash("sets", new URLSearchParams(), { dj: p.name }) }, "Their sets →"),
      ),
      links.length ? el("div", { class: "chips", style: "margin-top:12px" }, ...links.map((l) => externalLink(l.url, l.label, "chip"))) : "",
    ),
  );
  const stats = el(
    "div",
    { class: "stats" },
    bigStat(p.ownSets.length, "Their sets indexed"),
    bigStat(p.playedBy, "Sets playing their songs"),
    bigStat(p.songs.length, "Songs played"),
    bigStat(p.lastSeen ?? "–", "Last seen"),
  );

  const page = el("div", { class: "stack" }, hero, stats);
  const suggestions = didYouMean("artist", r.suggestions ?? []);
  if (suggestions) page.append(suggestions);
  page.append(
    el("div", { class: "split" }, artistSongsCard(p), setsCard(`Recent sets (${p.ownSets.length})`, p.ownSets, "None of their own sets indexed yet.", 6)),
    el(
      "div",
      { class: "grid" },
      artistTrendCard(r),
      rankedCard(`Who ${p.name} plays most`, r.mostPlayedArtists, "play", "No sets by this artist indexed yet.", { linkTo: "artist" }),
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
  const r = await getJson<SongReport & { image: string | null }>(`/api/song?q=${enc(query)}&months=${months()}${exact ? "&exact=1" : ""}`);
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
  const dash = name.indexOf(" - ");
  const title = none || dash === -1 ? name : name.slice(dash + 3);
  const backdrop = el("div", { class: "backdrop" });
  if (r.image) backdrop.style.backgroundImage = `url(${JSON.stringify(r.image)})`;
  // ▶ Play appears once we know the song has a confirmed SoundCloud link.
  const playSlot = el("span", {});
  if (!none) {
    void getJson<{ links: { url: string }[] }>(`/api/song-links?song=${enc(name)}`)
      .then((l) => {
        const link = l.links[0];
        if (link) playSlot.replaceChildren(playableButton({ provider: "soundcloud", source: link.url, title, subtitle: artists.join(", "), pageUrl: link.url }));
      })
      .catch(() => {});
  }
  const head = el(
    "section",
    { class: "profile-hero" },
    backdrop,
    art(name, r.image, "lg"),
    el(
      "div",
      { class: "body" },
      el("div", { class: "crumbs" }, ...crumbs),
      el("div", { class: "kicker" }, "Song"),
      el("h1", {}, title),
      artists.length && !none ? el("div", { class: "meta" }, ...joined(artists.map(artistLink), ", ")) : "",
      none ? el("div", { class: "meta" }, "No indexed sets contain this song yet. Find it on 1001Tracklists and setscope will collect its sets.") : "",
      r.matchedAs.length > 1 ? el("div", { class: "muted small" }, `Also written as: ${r.matchedAs.slice(1).map((m) => m.name).join(", ")}`) : "",
      correctionNotice("song", name, r.correctedFrom),
      r.otherVersions?.length ? el("div", { class: "small" }, `Other songs called “${r.song}”:`, chips(r.otherVersions.map((v) => ({ name: v.name, href: songHash(v.name) })))) : "",
      none ? "" : songFacts(name, r.genre),
      el(
        "div",
        { class: "btns", style: "margin-top:14px" },
        playSlot,
        none ? "" : likeButton(name, r.liked ?? false, () => void render()),
        findButton(none ? "Find sets on 1001Tracklists" : "Gather more sets", name, "song", none),
      ),
    ),
  );
  const page = el("div", { class: "stack" }, head);
  if (none) {
    const suggestions = didYouMean("song", r.suggestions);
    if (suggestions) page.append(suggestions);
    return page;
  }
  page.append(
    el(
      "div",
      { class: "stats" },
      bigStat(r.setsWithSong, "Sets"),
      bigStat(r.uniqueDjs, "Unique DJs"),
      bigStat(`${r.setsConsidered ? Math.round((r.setsWithSong / r.setsConsidered) * 1000) / 10 : 0}%`, `of indexed sets since ${r.since}`),
      bigStat(r.sets[0]?.date ?? "–", "Last played"),
    ),
    categoriesCard(name, r.categories ?? [], r.hints ?? []),
    soundcloudCard(name),
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
    setsCard(`Recently played in sets (${r.setsWithSong})`, r.sets, "none", 10),
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
  const line = el("div", { class: "small facts" }, genre ? el("b", {}, genre) : "", genre ? " · " : "", info, " · ", externalLink(soundcloudSearch(song), "SoundCloud search ↗"));
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
  links: { url: string; title: string; artist: string }[];
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
  const saved = el("ol", { class: "ranked" });
  for (const link of r.links) {
    const remove = el("button", { type: "button", class: "act" }, "Remove");
    remove.addEventListener("click", async () => {
      await post("/api/saved-link", { category: r.name, url: link.url, on: false });
      if (r.songs.length + r.links.length === 1) location.hash = "#/account";
      else await render();
    });
    saved.append(
      el(
        "li",
        {},
        el("span", { class: "name" }, link.title, el("span", { class: "muted small" }, ` · ${link.artist} on SoundCloud`)),
        playableButton({ provider: "soundcloud", source: link.url, title: link.title, subtitle: link.artist, pageUrl: link.url }),
        externalLink(link.url, "Open", "act-link"),
        remove,
      ),
    );
  }
  const counts = [r.songs.length ? plural(r.songs.length, "song") : "", r.links.length ? plural(r.links.length, "SoundCloud track") : ""].filter(Boolean).join(" · ");
  return el(
    "div",
    { class: "stack" },
    pageHead(r.name, `Your category · ${counts || "empty"}`, [homeCrumb(), " › ", el("a", { href: "#/account" }, "Account"), " › Category"]),
    r.songs.length ? el("div", { class: "card" }, songs) : "",
    r.links.length ? el("div", { class: "card" }, el("h2", {}, "Saved from SoundCloud"), saved) : "",
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

// ---- SoundCloud ----
// Results come live from SoundCloud and aren't stored, except what you confirm (a song's
// link) or save (into a category). SoundCloud plays/likes are SoundCloud's numbers, kept
// apart from setscope's own counts of DJ-set plays.

interface ScTrackJson {
  urn: string;
  title: string;
  uploader: string;
  uploaderUrl?: string;
  url: string;
  genre: string | null;
  durationMs: number;
  plays: number | null;
  likes: number | null;
  access: "playable" | "preview" | "blocked";
  embeddable: boolean;
  artwork: string | null;
}

interface ScCandidate extends ScTrackJson {
  kind: "this" | "version" | "related";
  confidence: number;
  reason: string;
  versionType: string;
  versionArtists: string | null;
}

interface SongLinkJson {
  url: string;
  externalId: string | null;
  confidence: number;
  provenance: "source_page" | "user" | "search_match";
  addedBy: string | null;
  removable?: boolean;
}

const KIND_LABEL: Record<ScCandidate["kind"], string> = { this: "This song", version: "Another version", related: "Related upload" };

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One SoundCloud upload: title, uploader, SoundCloud's numbers, and Play / Open / Save. */
function scTrackRow(t: ScTrackJson, ...extra: (Node | string)[]): HTMLElement {
  const playable = t.access !== "blocked" && t.embeddable;
  const facts = [
    t.genre ?? "no genre tag",
    t.durationMs ? duration(t.durationMs) : "",
    t.access === "preview" ? "preview only" : t.access === "blocked" ? "not streamable here" : "",
    t.plays !== null ? `${compact(t.plays)} SoundCloud plays` : "",
  ].filter(Boolean);
  return el(
    "li",
    {},
    el(
      "span",
      { class: "name" },
      t.title,
      el("div", { class: "muted small" }, "by ", t.uploaderUrl ? externalLink(t.uploaderUrl, t.uploader) : t.uploader, ` · ${facts.join(" · ")}`),
    ),
    ...extra,
    playable ? playableButton({ provider: "soundcloud", source: t.url, title: t.title, subtitle: t.uploader, pageUrl: t.url }) : "",
    externalLink(t.url, "Open on SoundCloud", "act-link"),
    auth.user ? saveToCategory(t.url) : "",
  );
}

/** "Save…" → pick or type one of your categories. */
function saveToCategory(url: string): HTMLElement {
  const wrap = el("span", { class: "btns" });
  const open = el("button", { type: "button", class: "act" }, "Save…");
  open.addEventListener("click", () => {
    const input = el("input", { type: "text", placeholder: "Category", list: "scCategoryNames", class: "small-input" }) as HTMLInputElement;
    const save = el("button", { type: "button", class: "act" }, "Save");
    const names = el("datalist", { id: "scCategoryNames" }, ...me.categories.map((c) => el("option", { value: c.name })));
    const submit = async () => {
      const category = input.value.trim();
      if (!category) return;
      save.textContent = "Saving…";
      try {
        await post("/api/saved-link", { category, url, on: true });
        await loadMe();
        wrap.replaceChildren(el("span", { class: "small muted" }, "Saved to "), el("a", { class: "link small", href: categoryHash(category) }, category));
      } catch (e) {
        wrap.replaceChildren(el("span", { class: "small error" }, (e as Error).message));
      }
    };
    save.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
    });
    wrap.replaceChildren(input, names, save);
    input.focus();
  });
  wrap.append(open);
  return wrap;
}

/** The song's SoundCloud links, finding and confirming one, and remix search. */
function soundcloudCard(song: string): HTMLElement {
  const card = el("div", { class: "card" }, el("h2", {}, "On SoundCloud"), el("p", { class: "muted small" }, "Loading…"));
  void (async () => {
    let data: { links: SongLinkJson[]; soundcloud: boolean };
    try {
      data = await getJson(`/api/song-links?song=${enc(song)}`);
    } catch (e) {
      card.replaceChildren(el("h2", {}, "On SoundCloud"), el("p", { class: "error small" }, (e as Error).message));
      return;
    }
    const linked = el("ol", { class: "ranked" });
    for (const link of data.links) {
      const how = link.provenance === "user" ? "pasted" : link.provenance === "search_match" ? `picked from search (${Math.round(link.confidence * 100)}% match)` : "from 1001Tracklists";
      const remove = el("button", { type: "button", class: "act" }, "Remove");
      remove.addEventListener("click", async () => {
        await post("/api/song-links/remove", { song, url: link.url });
        await render();
      });
      linked.append(
        el(
          "li",
          {},
          el("span", { class: "name" }, externalLink(link.url, link.url.replace("https://soundcloud.com/", "")), el("div", { class: "muted small" }, `${how}${link.addedBy ? ` by ${link.addedBy}` : ""}`)),
          playableButton({ provider: "soundcloud", source: link.url, title: song, subtitle: "SoundCloud", pageUrl: link.url }),
          link.removable ? remove : "",
        ),
      );
    }
    const parts: (Node | string)[] = [el("h2", {}, "On SoundCloud")];
    parts.push(data.links.length ? linked : el("p", { class: "muted small" }, "No SoundCloud link confirmed for this song yet."));
    if (!data.soundcloud) {
      parts.push(
        el(
          "p",
          { class: "muted small" },
          "SoundCloud search isn't connected",
          ...(auth.user?.owner ? [" (", el("a", { class: "link", href: "#/account" }, "connect it on Account"), ")"] : []),
          ". You can still ",
          externalLink(soundcloudSearch(song), "search SoundCloud yourself"),
          ".",
        ),
      );
    } else if (!auth.user) {
      parts.push(el("p", { class: "muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to find this song and its remixes on SoundCloud."));
    } else {
      parts.push(findCandidates(song), remixSearch(song));
    }
    card.replaceChildren(...parts);
  })();
  return card;
}

/** "Find on SoundCloud": candidates sorted into this song / another version / related. */
function findCandidates(song: string): HTMLElement {
  const box = el("div", { class: "sc-find" });
  const find = el("button", { type: "button", class: "act" }, "Find on SoundCloud");
  const paste = el("input", { type: "text", placeholder: "…or paste a soundcloud.com track link", class: "small-input", style: "width:280px" }) as HTMLInputElement;
  const pasteBtn = el("button", { type: "button", class: "act" }, "Link it");
  const msg = el("span", { class: "small muted" });
  const results = el("div", {});

  const confirm = async (url: string, from: "search" | "pasted", button: HTMLElement) => {
    button.textContent = "Linking…";
    try {
      await post("/api/song-links", { song, url, from });
      await render();
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = "small error";
      button.textContent = from === "pasted" ? "Link it" : "Use as this song's link";
    }
  };
  pasteBtn.addEventListener("click", () => {
    if (paste.value.trim()) void confirm(paste.value.trim(), "pasted", pasteBtn);
  });

  find.addEventListener("click", async () => {
    find.textContent = "Searching…";
    try {
      const { candidates } = await getJson<{ candidates: ScCandidate[] }>(`/api/soundcloud/candidates?song=${enc(song)}`);
      results.replaceChildren();
      if (!candidates.length) results.append(el("p", { class: "muted small" }, "Nothing on SoundCloud looks like this song. Paste a link if you know one."));
      for (const kind of ["this", "version", "related"] as const) {
        const group = candidates.filter((c) => c.kind === kind);
        if (!group.length) continue;
        const list = el("ol", { class: "ranked sc-list" });
        for (const c of group) {
          const use = el("button", { type: "button", class: kind === "this" ? "act primary" : "act" }, "Use as this song's link");
          use.addEventListener("click", () => void confirm(c.url, "search", use));
          list.append(scTrackRow(c, el("span", { class: "small muted", title: c.reason }, `${Math.round(c.confidence * 100)}%`), use));
        }
        results.append(el("h3", {}, KIND_LABEL[kind], el("span", { class: "muted small" }, ` · ${group.length}`)), list);
      }
      find.textContent = "Search again";
    } catch (e) {
      find.textContent = "Find on SoundCloud";
      msg.textContent = (e as Error).message;
      msg.className = "small error";
    }
  });
  box.append(
    el("div", { class: "btns", style: "margin-top:8px" }, find, paste, pasteBtn, msg),
    el("div", { class: "muted small" }, "Matches are guesses from titles and uploaders: nothing is linked until you pick one."),
    results,
  );
  return box;
}

/** Remixes, edits and bootlegs of the song on SoundCloud, with filters and Load more. */
function remixSearch(song: string): HTMLElement {
  const genres = el("input", { type: "text", placeholder: "Genres, e.g. House, Techno, Unknown", class: "small-input", style: "width:240px" }) as HTMLInputElement;
  const remixer = el("input", { type: "text", placeholder: "Remixer", class: "small-input", style: "width:140px" }) as HTMLInputElement;
  const sort = el("select", {}, el("option", { value: "relevance" }, "Sort: SoundCloud relevance"), el("option", { value: "plays" }, "Sort: SoundCloud plays")) as HTMLSelectElement;
  const go = el("button", { type: "button", class: "act" }, "Search remixes");
  const more = el("button", { type: "button", class: "act" }, "Load more");
  more.hidden = true;
  const msg = el("div", { class: "small muted" });
  const list = el("ol", { class: "ranked sc-list" });
  let found: ScCandidate[] = [];
  let next: string | null = null;
  let scanned = 0;

  const draw = () => {
    const shown = sort.value === "plays" ? [...found].sort((a, b) => (b.plays ?? -1) - (a.plays ?? -1)) : found;
    list.replaceChildren(...shown.map((c) => scTrackRow(c, el("span", { class: "small muted", title: c.reason }, c.versionArtists ? `${c.versionType} by ${c.versionArtists}` : c.versionType))));
    more.hidden = !next;
    msg.textContent = found.length
      ? `${plural(found.length, "version")} found in ${scanned} SoundCloud results${sort.value === "plays" ? " (sorted by SoundCloud plays, among those loaded)" : ""}.`
      : `No remixes found in ${scanned} SoundCloud results${next ? ". Try Load more." : "."}`;
  };
  const load = async (fresh: boolean) => {
    const button = fresh ? go : more;
    const label = button.textContent;
    button.textContent = "Searching…";
    try {
      const params = new URLSearchParams({ song });
      if (genres.value.trim()) params.set("genres", genres.value);
      if (remixer.value.trim()) params.set("remixer", remixer.value.trim());
      if (!fresh && next) params.set("cursor", next);
      const r = await getJson<{ remixes: ScCandidate[]; next: string | null; scanned: number }>(`/api/soundcloud/remixes?${params}`);
      if (fresh) {
        found = [];
        scanned = 0;
      }
      const seen = new Set(found.map((c) => c.urn));
      found.push(...r.remixes.filter((c) => !seen.has(c.urn)));
      scanned += r.scanned;
      next = r.next;
      draw();
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = "small error";
    }
    button.textContent = label;
  };
  go.addEventListener("click", () => void load(true));
  more.addEventListener("click", () => void load(false));
  sort.addEventListener("change", draw);
  return el(
    "details",
    { class: "sc-remixes" },
    el("summary", {}, el("b", {}, "Remixes & edits on SoundCloud")),
    el("div", { class: "btns", style: "margin-top:8px" }, genres, remixer, sort, go),
    el("div", { class: "muted small" }, "Genres are the uploader's own tags; “Unknown” finds uploads without one."),
    msg,
    list,
    more,
  );
}

/** Discover: the public likes of a SoundCloud curator (a DJ, a label, a friend). */
function discoverPage(profile: string | undefined): HTMLElement {
  const input = el("input", { type: "text", placeholder: "SoundCloud profile name or link", value: profile ?? "", style: "flex:1; min-width:200px" }) as HTMLInputElement;
  const go = el("button", { type: "button", class: "primary" }, "Show likes");
  const body = el("div", {});
  const submit = () => {
    const name = input.value.trim().replace(/^https?:\/\/(www\.)?soundcloud\.com\//, "").replace(/\/.*$/, "");
    if (name) location.hash = `#/discover/${enc(name)}`;
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  const page = el(
    "div",
    { class: "stack" },
    pageHead("Discover", "What a SoundCloud curator has liked lately, live from SoundCloud", [homeCrumb(), " › Discover"]),
    el("div", { class: "card" }, el("div", { class: "row" }, input, go), el("div", { class: "muted small", style: "margin-top:6px" }, "Only public likes. Nothing here is stored unless you save it to a category.")),
    body,
  );
  if (!auth.user) {
    body.replaceChildren(el("div", { class: "card muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to browse SoundCloud likes."));
    return page;
  }
  if (!profile) return page;

  const list = el("ol", { class: "ranked sc-list" });
  const more = el("button", { type: "button", class: "act" }, "Load more");
  const card = el("div", { class: "card" }, el("p", { class: "muted small" }, "Loading…"));
  body.replaceChildren(card);
  let next: string | null = null;
  const load = async (cursor?: string) => {
    more.textContent = "Loading…";
    try {
      const r = await getJson<{ user: { username: string; permalink: string; avatar?: string }; tracks: ScTrackJson[]; next: string | null }>(
        `/api/soundcloud/likes?profile=${enc(profile)}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
      );
      list.append(...r.tracks.map((t) => scTrackRow(t)));
      next = r.next;
      more.hidden = !next;
      card.replaceChildren(
        el("div", { class: "row" }, el("h2", {}, "Liked by ", externalLink(r.user.permalink, r.user.username)), el("span", { class: "muted small" }, `${plural(list.children.length, "track")} loaded`)),
        list.children.length ? list : el("p", { class: "muted small" }, "No public likes."),
        more,
      );
    } catch (e) {
      card.replaceChildren(el("p", { class: "error small" }, (e as Error).message));
    }
    more.textContent = "Load more";
  };
  more.addEventListener("click", () => {
    if (next) void load(next);
  });
  void load();
  return page;
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
interface Suggestion {
  kind: "Artists" | "Songs" | "Sets";
  name: string;
  detail: string;
  href: string;
}

let suggestItems: Suggestion[] = [];
let suggestIndex = -1;
/** Bumped on every lookup and every close, so only the latest lookup's answer is drawn. */
let suggestRequest = 0;

function goTo(hash: string): void {
  hideSuggest();
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
  const nodes: HTMLElement[] = [];
  suggestItems.forEach((item, i) => {
    if (item.kind !== suggestItems[i - 1]?.kind) nodes.push(el("div", { class: "group" }, item.kind));
    const option = el(
      "button",
      { type: "button", role: "option", "aria-selected": String(i === suggestIndex) },
      el("span", {}, item.name),
      el("span", { class: "count" }, item.detail),
    );
    // mousedown (not click) so it fires before the input loses focus and hides the list.
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      goTo(item.href);
    });
    nodes.push(option);
  });
  box.replaceChildren(...nodes);
  box.hidden = suggestItems.length === 0;
  $("query").setAttribute("aria-expanded", String(!box.hidden));
}

async function updateSuggest(): Promise<void> {
  const request = ++suggestRequest;
  const q = $<HTMLInputElement>("query").value.trim();
  let items: Suggestion[] = [];
  if (q.length >= 2) {
    try {
      const r = await getJson<FindResult>(`/api/search?q=${enc(q)}&months=${months()}`);
      items = [
        ...r.artists.slice(0, 3).map((a): Suggestion => ({ kind: "Artists", name: a.name, detail: plural(a.count, "set"), href: artistHash(a.name) })),
        ...r.songs.slice(0, 5).map((t): Suggestion => ({ kind: "Songs", name: t.name, detail: plural(t.count, "set"), href: songHash(t.name) })),
        ...r.sets.slice(0, 3).map((x): Suggestion => ({ kind: "Sets", name: x.event, detail: `${x.djs.map((d) => d.name).join(" & ")} · ${x.date ?? ""}`, href: `#/set/${enc(x.id)}` })),
      ];
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

/** Which kind of page we're on (used when opening 1001Tracklists for more sets). */
function setMode(next: Mode): void {
  mode = next;
}

$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $<HTMLInputElement>("query").value.trim();
  if (text) goTo(`#/find/${enc(text)}`);
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
    goTo(suggestItems[suggestIndex]!.href);
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
