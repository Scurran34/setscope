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
  | { page: "playlist"; name: string }
  | { page: "discover"; params: URLSearchParams; profile?: string };

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
  /** The extension version in the project folder; Chrome should be running this one. */
  extensionVersion?: string | null;
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
  // Playlists were called categories before; old links still work.
  if ((first === "playlist" || first === "category") && second) return { page: "playlist", name: second };
  if (first === "discover") return second ? { page: "discover", params, profile: second } : { page: "discover", params };
  return { page: "home" };
}

/** Show whatever page the address names. */
async function showRoute(): Promise<void> {
  hideSuggest();
  route = parseRoute(location.hash);
  const NAV: Partial<Record<Route["page"], string>> = {
    home: "home", songs: "songs", trending: "songs", song: "songs", search: "songs", artists: "artists", artist: "artists",
    sets: "sets", set: "sets", library: "library", playlist: "library", account: "account", discover: "discover",
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
      case "playlist":
        return show(await playlistPage(route.name));
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
        return show(await discoverPage(route.params, route.profile));
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
          songArt(name, r.artistImage, r.soundcloud),
          el("div", {}, el("a", { href: songHash(name) }, r.title), el("div", { class: "who small" }, ...joined(artistsOf(name).map(artistLink), ", "))),
        ),
      ),
      options.compact ? "" : el("td", { class: "hide-sm muted small" }, r.genre ?? ""),
      el("td", { class: "num" }, String(r.sets)),
      options.compact ? "" : el("td", { class: "num hide-sm muted" }, String(r.djs)),
      el("td", { class: "num" }, trendCell(r.trend)),
      el("td", {}, el("div", { class: "btns", style: "flex-wrap:nowrap" }, addToPlaylistButton(name), songPlayButton(name, r.soundcloud))),
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

// ---- playing any song, playlists, tiles (shared by many pages) ----

/** A song as the server describes it for tiles and lists. */
interface SongCard {
  name: string;
  artist: string;
  title: string;
  genre: string | null;
  image: string | null;
  soundcloud: string | null;
  reason?: string;
}

/** Songs whose SoundCloud link we've looked up this visit: name -> link. */
const songSources = new Map<string, string>();

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(...content: (Node | string)[]): void {
  const box = $("toast");
  box.replaceChildren(...content);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 6000);
}

/** Songs queued by "Play all": the next one starts when one finishes. */
let playQueue: string[] = [];
let playQueueAt = -1;

function titleOf(name: string): string {
  const dash = name.indexOf(" - ");
  return dash === -1 ? name : name.slice(dash + 3);
}

/**
 * Play a song from anywhere: its known link, or ask the server, which finds the best
 * SoundCloud match (and remembers it) when nobody has linked the song yet.
 */
async function playSong(name: string, known?: string | null, fromQueue = false): Promise<boolean> {
  if (!fromQueue) playQueue = [];
  let url = known ?? songSources.get(name);
  let auto = false;
  if (!url) {
    for (const b of document.querySelectorAll<HTMLElement>(`[data-song="${CSS.escape(name)}"]`)) b.textContent = "…";
    try {
      const r = await getJson<{ url: string; auto: boolean; preview?: boolean }>(`/api/play?song=${enc(name)}`);
      url = r.url;
      auto = r.auto;
    } catch (e) {
      for (const b of document.querySelectorAll<HTMLElement>(`[data-song="${CSS.escape(name)}"]`)) markPlaying(b);
      if (!fromQueue) toast((e as Error).message, " ", externalLink(soundcloudSearch(name), "Search SoundCloud ↗", "act-link"));
      return false;
    }
    songSources.set(name, url);
    for (const b of document.querySelectorAll<HTMLElement>(`[data-song="${CSS.escape(name)}"]`)) b.dataset.source = url;
  }
  player.play({ provider: "soundcloud", source: url, title: titleOf(name), subtitle: `${artistsOf(name).join(", ")}${auto ? " · SoundCloud match" : ""}`, pageUrl: url });
  return true;
}

/** "Play all": play a list of songs in order, skipping ones with nothing to play. */
async function playAll(names: string[], known: Map<string, string | null> = new Map()): Promise<void> {
  playQueue = names;
  for (playQueueAt = 0; playQueueAt < playQueue.length; playQueueAt++) {
    if (await playSong(playQueue[playQueueAt]!, known.get(playQueue[playQueueAt]!), true)) return;
  }
  toast("Nothing in this list can be played yet.");
}

player.subscribe((state) => {
  if (state.status !== "ended" || !playQueue.length || playQueueAt < 0) return;
  void (async () => {
    for (playQueueAt++; playQueueAt < playQueue.length; playQueueAt++) {
      if (await playSong(playQueue[playQueueAt]!, null, true)) return;
    }
    playQueue = [];
  })();
});

/** Round ▶ for a song; works whether or not the song has a link yet. */
function songPlayButton(name: string, known: string | null, extraClass = "", round = true): HTMLElement {
  const source = known ?? songSources.get(name) ?? "";
  const cls = round ? `play-btn play-round ${extraClass}` : `play-btn primary ${extraClass}`;
  const b = el("button", { type: "button", class: cls.trim(), "data-song": name, "data-source": source, "aria-label": `Play ${name}` }, round ? "▶" : "▶ Play");
  b.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void playSong(name, known);
  });
  markPlaying(b);
  return b;
}

/** Artwork with a ▶ that shows on hover (always on touch screens). */
function songArt(name: string, image: string | null, known: string | null, cls = ""): HTMLElement {
  return el("div", { class: cls.includes("small") ? "art-wrap small" : "art-wrap" }, art(artistsOf(name)[0] ?? name, image, cls), songPlayButton(name, known, "art-play"));
}

let openMenu: HTMLElement | undefined;
function closeMenu(): void {
  openMenu?.remove();
  openMenu = undefined;
}
document.addEventListener("click", (event) => {
  if (openMenu && !openMenu.contains(event.target as Node)) closeMenu();
});

/** "+": add a song to one of your playlists, or a new one, in one or two clicks. */
function addToPlaylistButton(song: string, label = "＋"): HTMLElement {
  const button = el("button", { type: "button", class: label === "＋" ? "icon-btn" : "", title: "Add to playlist", "aria-label": `Add ${song} to a playlist` }, label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!auth.user) {
      location.hash = "#/account";
      return;
    }
    if (openMenu) return closeMenu();
    const menu = el("div", { class: "menu", role: "menu" }, el("div", { class: "menu-title" }, "Add to playlist"));
    const inList = (name: string) => me.categories.find((c) => c.name === name)?.songs.includes(song) ?? false;
    for (const playlist of me.categories) {
      const item = el("button", { type: "button", class: "item", role: "menuitemcheckbox", "aria-checked": String(inList(playlist.name)) }, playlist.name, el("span", { class: "muted" }, inList(playlist.name) ? "✓" : ""));
      item.addEventListener("click", async () => {
        const on = !inList(playlist.name);
        await post("/api/label", { song, category: playlist.name, on });
        await loadMe();
        closeMenu();
        toast(on ? `Added to ${playlist.name}` : `Removed from ${playlist.name}`);
      });
      menu.append(item);
    }
    const input = el("input", { type: "text", placeholder: "New playlist…", "aria-label": "New playlist name" }) as HTMLInputElement;
    const form = el("form", {}, input);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      try {
        await post("/api/label", { song, category: name, on: true });
        await loadMe();
        closeMenu();
        toast(`Added to ${name}`);
      } catch (error) {
        input.value = "";
        input.placeholder = (error as Error).message;
      }
    });
    menu.append(form);
    const box = button.getBoundingClientRect();
    menu.style.top = `${box.bottom + window.scrollY + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(box.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 236))}px`;
    document.body.append(menu);
    openMenu = menu;
    if (!me.categories.length) input.focus();
  });
  return button;
}

/** One song as a square tile: artwork with hover ▶, title, artists, and +. */
function songTile(card: SongCard, extra?: Node): HTMLElement {
  return el(
    "div",
    { class: "tile" },
    songArt(card.name, card.image, card.soundcloud),
    el("a", { class: "t", href: songHash(card.name) }, card.title),
    el("div", { class: "a" }, ...joined(artistsOf(card.name).map((a) => el("a", { href: artistHash(a) }, a)), ", ")),
    card.reason ? el("div", { class: "why" }, card.reason) : "",
    el("div", { class: "tile-actions" }, addToPlaylistButton(card.name), extra ?? ""),
  );
}

interface FeaturedSet extends SetCard {
  liked: string[];
}

/** One recommended set at a time, big, changing every 20 seconds (or with the dots). */
function featuredSet(sets: FeaturedSet[], compact = false): HTMLElement {
  const box = el("section", { class: `featured${compact ? " compact" : ""}` });
  if (!sets.length) return box;
  const pick = [...sets].sort(() => Math.random() - 0.5);
  let at = 0;
  const bg = el("div", { class: "bg" });
  const body = el("div", { class: "body" });
  const dots = el("div", { class: "dots" });
  const draw = () => {
    const s = pick[at]!;
    const photo = s.djs.find((d) => d.image)?.image;
    bg.style.backgroundImage = photo ? `url(${JSON.stringify(photo)})` : "linear-gradient(120deg,#2b2160,#0d0f1a)";
    const playable: Playable | null = s.soundcloud ? { provider: "soundcloud", source: s.soundcloud, title: s.title, subtitle: `${s.djs.map((d) => d.name).join(" & ")} · ${s.date ?? ""}`, pageUrl: s.url } : null;
    body.replaceChildren(
      el("div", { class: "kicker" }, "Recommended set for you"),
      el("h2", {}, el("a", { href: `#/set/${enc(s.id)}`, style: "text-decoration:none" }, s.event)),
      el("div", { class: "meta" }, ...joined(s.djs.map((d) => artistLink(d.name)), " & "), ` · ${s.date ?? ""} · ${plural(s.tracks, "track")}`),
      el("div", { class: "liked" }, `Plays ${s.liked.length} of your liked songs: `, s.liked.slice(0, 3).map(titleOf).join(", "), s.liked.length > 3 ? "…" : ""),
      el("div", { class: "btns", style: "margin-top:14px" }, playable ? playableButton(playable) : "", el("a", { class: "act-link", href: `#/set/${enc(s.id)}` }, "Open tracklist →")),
    );
    dots.replaceChildren(
      ...pick.map((_, i) => {
        const d = el("button", { type: "button", class: i === at ? "on" : "", "aria-label": `Recommended set ${i + 1}` });
        d.addEventListener("click", () => show2(i));
        return d;
      }),
    );
  };
  const show2 = (i: number) => {
    box.classList.add("fading");
    setTimeout(() => {
      at = i;
      draw();
      box.classList.remove("fading");
    }, 250);
  };
  draw();
  if (pick.length > 1) {
    const timer = setInterval(() => {
      if (!box.isConnected) return clearInterval(timer);
      if (!box.matches(":hover")) show2((at + 1) % pick.length);
    }, 20_000);
  }
  box.append(bg, body, pick.length > 1 ? dots : "");
  return box;
}

/** "Songs you might like": 3 pages of 6 that turn every 10 seconds, with Shuffle and View all. */
function suggestionCarousel(title = "Songs you might like"): HTMLElement {
  const card = el("section", { class: "card carousel" }, el("h2", {}, title), el("p", { class: "muted small" }, "Loading…"));
  const pages = el("div", { class: "pages" });
  const dots = el("div", { class: "dots" });
  let items: SongCard[] = [];
  let at = 0;
  const per = 6;
  const draw = () => {
    const count = Math.max(1, Math.ceil(items.length / per));
    pages.replaceChildren(el("div", { class: "tiles" }, ...items.slice(at * per, at * per + per).map((c) => songTile(c))));
    dots.replaceChildren(
      ...Array.from({ length: count }, (_, i) => {
        const d = el("button", { type: "button", class: i === at ? "on" : "", "aria-label": `Page ${i + 1}` });
        d.addEventListener("click", () => turn(i));
        return d;
      }),
    );
  };
  const turn = (i: number) => {
    card.classList.add("fading");
    setTimeout(() => {
      at = i;
      draw();
      card.classList.remove("fading");
    }, 300);
  };
  const load = async () => {
    try {
      const r = await getJson<{ items: SongCard[]; mode: string }>(`/api/discover?size=${per * 3}&seed=${Math.floor(Math.random() * 1e9)}`);
      items = r.items;
      at = 0;
      const shuffle = el("button", { type: "button", class: "act" }, "Shuffle");
      shuffle.addEventListener("click", () => void load());
      card.replaceChildren(
        sectionHead(r.mode === "personal" ? title : "Popular right now", "#/discover", shuffle),
        items.length ? pages : el("p", { class: "muted small" }, "Like a few songs to get suggestions."),
        items.length > per ? dots : "",
      );
      draw();
    } catch (e) {
      failed(card, title, e);
    }
  };
  void load();
  const timer = setInterval(() => {
    if (!card.isConnected) return clearInterval(timer);
    const count = Math.ceil(items.length / per);
    if (count > 1 && !card.matches(":hover") && !openMenu) turn((at + 1) % count);
  }, 10_000);
  return card;
}

function playlistHash(name: string): string {
  return `#/playlist/${enc(name)}`;
}

/** A playlist cover: up to four artist photos, or a plain tile for an empty one. */
function mosaic(images: string[]): HTMLElement {
  if (!images.length) return el("div", { class: "mosaic one" }, el("div", { class: "empty-cover", "aria-hidden": "true" }, "♪"));
  const shown = images.length >= 4 ? images.slice(0, 4) : images.slice(0, 1);
  return el("div", { class: `mosaic${shown.length === 1 ? " one" : ""}` }, ...shown.map((src) => el("img", { src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })));
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

/** Home's one personal section: a recommended set, a few recent likes, your playlists. */
function fillYourMusic(card: HTMLElement): void {
  if (!auth.user) {
    card.replaceChildren(
      sectionHead("Your Music"),
      el("p", { class: "muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to like songs, make playlists, and get sets picked for you."),
    );
    return;
  }
  card.replaceChildren(sectionHead("Your Music", "#/library"), el("p", { class: "muted small" }, "Loading…"));
  void getJson<ForYou>(`/api/for-you?months=${months()}`)
    .then((r) => {
      card.replaceChildren(
        sectionHead("Your Music", "#/library"),
        r.sets.length ? featuredSet(r.sets, true) : el("p", { class: "muted small" }, "Like songs (♡ on a song page) to get sets picked for you."),
        r.likedSongs.length ? el("div", { class: "tiles", style: "margin-top:16px" }, ...r.likedSongs.slice(0, 4).map((c) => songTile(c))) : "",
        me.categories.length ? el("div", { style: "margin-top:14px" }, chips(me.categories.map((c) => ({ name: `${c.name} (${c.songs.length})`, href: playlistHash(c.name) })))) : "",
      );
    })
    .catch((e) => failed(card, "Your Music", e));
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
      l.isId ? "" : el("div", { class: "btns", style: "flex-wrap:nowrap" }, addToPlaylistButton(l.song!), songPlayButton(l.song!, l.soundcloud)),
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

interface ForYou {
  likes: string[];
  likedSongs: SongCard[];
  sets: FeaturedSet[];
  songs: Ranked[];
}

interface PlaylistSummary {
  name: string;
  count: number;
  cover: string[];
}

/** New playlist: ask for a name, create it, open it. */
async function newPlaylist(): Promise<void> {
  const name = prompt("Name your playlist")?.trim();
  if (!name) return;
  try {
    const r = await post<{ name: string }>("/api/playlists", { name });
    await loadMe();
    location.hash = playlistHash(r.name);
  } catch (e) {
    toast((e as Error).message);
  }
}

async function libraryPage(): Promise<HTMLElement> {
  if (!auth.user) return signInPage();
  const [forYou, playlists] = await Promise.all([getJson<ForYou>(`/api/for-you?months=${months()}`), getJson<PlaylistSummary[]>("/api/playlists")]);
  const SHOWN = 12;
  const liked = forYou.likedSongs;
  const likedGrid = el("div", { class: "tiles" }, ...liked.slice(0, SHOWN).map((c) => songTile(c, unlikeButton(c.name))));
  const allLikes = el("button", { type: "button", class: "act" }, `Show all ${liked.length}`);
  allLikes.addEventListener("click", () => {
    likedGrid.replaceChildren(...liked.map((c) => songTile(c, unlikeButton(c.name))));
    allLikes.remove();
  });
  const playAllLikes = el("button", { type: "button", class: "primary" }, "▶ Play all");
  playAllLikes.addEventListener("click", () => void playAll(liked.map((c) => c.name), new Map(liked.map((c) => [c.name, c.soundcloud]))));
  const newCard = el("a", { class: "cover-card new-card", href: "#/library" }, el("div", { class: "mosaic one" }, el("div", { class: "empty-cover" }, "＋")), el("div", { class: "t" }, "New playlist"), el("div", { class: "a" }, "Name it, then add songs with ＋"));
  newCard.addEventListener("click", (event) => {
    event.preventDefault();
    void newPlaylist();
  });
  return el(
    "div",
    { class: "stack" },
    pageHead("Your Library", `${plural(liked.length, "liked song")} · ${plural(playlists.length, "playlist")}`),
    forYou.sets.length ? featuredSet(forYou.sets) : "",
    el(
      "section",
      { class: "card" },
      sectionHead("Playlists"),
      el(
        "div",
        { class: "covers" },
        ...playlists.map((p) => el("a", { class: "cover-card", href: playlistHash(p.name) }, mosaic(p.cover), el("div", { class: "t" }, p.name), el("div", { class: "a" }, plural(p.count, "track")))),
        newCard,
      ),
    ),
    el(
      "section",
      { class: "card" },
      sectionHead(`Liked songs`, undefined, liked.length ? playAllLikes : undefined),
      liked.length ? likedGrid : el("p", { class: "muted small" }, "Nothing liked yet: ♡ a song on its page."),
      liked.length > SHOWN ? el("div", { style: "margin-top:14px" }, allLikes) : "",
    ),
    suggestionCarousel(),
  );
}

function unlikeButton(song: string): HTMLElement {
  const b = el("button", { type: "button", class: "icon-btn on", title: "Unlike", "aria-label": `Unlike ${song}` }, "♥");
  b.addEventListener("click", async () => {
    await post("/api/like", { song, liked: false });
    await loadMe();
    b.closest(".tile")?.remove();
  });
  return b;
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

  const openQueue = el("button", { type: "button" }, "Open the queue");
  openQueue.addEventListener("click", () => setQueueOpen(true));

  return el(
    "div",
    { class: "stack" },
    pageHead(a.user.displayName, `${a.user.email}${owner ? " · site owner" : ""}`, undefined, signOut),
    el(
      "div",
      { class: "card small" },
      `${plural(a.likes.length, "liked song")} and ${plural(a.categories.length, "playlist")} · `,
      el("a", { class: "link", href: "#/library" }, "Open your Library"),
    ),
    el(
      "div",
      { class: "card" },
      el("div", { class: "row" }, el("div", {}, el("b", {}, "Collecting sets"), el("div", { class: "small muted" }, "The queue, background collecting, and adding sets by link are under Queue in the top bar, on every page.")), openQueue),
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
      el(
        "div",
        { class: "muted small" },
        `Chrome extension: ${!extensionInstalled() ? "not detected in this browser" : extensionOutdated() ? `connected, but out of date (${extensionVersion()}; reload it in chrome://extensions)` : `connected (version ${extensionVersion()})`}`,
      ),
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
    `Last gathered ${when}: ${plural(d.setsSeen, "set")} on their 1001Tracklists page${d.complete ? " (all of them)" : " (stopped early; gather again for more)"}`,
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
    const item = el("li", {}, el("div", { class: "song-line" }, songPlayButton(song.name, null), row), panel);
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
  const playSlot = none ? "" : songPlayButton(name, null, "", false);
  const head = el(
    "section",
    { class: "profile-hero" },
    backdrop,
    none ? art(name, r.image, "lg") : songArt(name, r.image, null, "lg"),
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
        none ? "" : addToPlaylistButton(name, "＋ Playlist"),
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

/** Which of your playlists have this song, one-click add, and "fits your playlist" hints. */
function categoriesCard(song: string, inCategories: string[], hints: { category: string; sets: number; of: number }[]): HTMLElement {
  if (!auth.user) {
    return el("div", { class: "card muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to like songs and add them to your playlists.");
  }
  const label = async (playlist: string, on: boolean) => {
    await post("/api/label", { song, category: playlist, on });
    await loadMe();
    await render();
  };
  const current = inCategories.map((c) => {
    const remove = el("button", { type: "button", class: "chip-x", title: `Remove from ${c}` }, "×");
    remove.addEventListener("click", () => void label(c, false));
    return el("span", { class: "chip" }, el("a", { class: "link", href: playlistHash(c) }, c), remove);
  });
  const hintRows = hints.map((h) => {
    const yes = el("button", { type: "button", class: "act" }, `Add to ${h.category}`);
    yes.addEventListener("click", () => void label(h.category, true));
    return el("div", { class: "small hint" }, "Fits your playlist ", el("a", { class: "link", href: playlistHash(h.category) }, `“${h.category}”`), ` · in ${h.sets} of its ${h.of} sets with ${h.category} songs `, yes);
  });
  return el(
    "div",
    { class: "card" },
    el("div", { class: "row" }, el("h2", {}, "Your playlists"), addToPlaylistButton(song, "＋ Add to playlist")),
    current.length ? el("div", { class: "chips" }, ...current) : el("div", { class: "muted small" }, "Not in any of your playlists yet."),
    ...hintRows,
  );
}

// ---- Playlist ----

interface PlaylistData {
  name: string;
  songs: string[];
  songCards: SongCard[];
  links: { url: string; title: string; artist: string }[];
  suggestionCards: SongCard[];
}

async function playlistPage(name: string): Promise<HTMLElement> {
  const r = await getJson<PlaylistData>(`/api/playlist?name=${enc(name)}&months=${months()}`);
  const known = new Map(r.songCards.map((c) => [c.name, c.soundcloud]));
  const rows = el("ol", { class: "tracklist" });
  r.songCards.forEach((c, i) => {
    const remove = el("button", { type: "button", class: "act" }, "Remove");
    remove.addEventListener("click", async () => {
      await post("/api/label", { song: c.name, category: r.name, on: false });
      await loadMe();
      await render();
    });
    rows.append(
      el(
        "li",
        {},
        el("span", { class: "pos" }, String(i + 1)),
        songArt(c.name, c.image, c.soundcloud, "small"),
        el("span", { class: "t" }, el("a", { href: songHash(c.name) }, c.title), el("div", { class: "who small muted" }, ...joined(artistsOf(c.name).map(artistLink), ", "))),
        el("span", { class: "muted small hide-sm" }, c.genre ?? ""),
        remove,
      ),
    );
  });
  r.links.forEach((link, i) => {
    const remove = el("button", { type: "button", class: "act" }, "Remove");
    remove.addEventListener("click", async () => {
      await post("/api/saved-link", { category: r.name, url: link.url, on: false });
      await render();
    });
    rows.append(
      el(
        "li",
        {},
        el("span", { class: "pos" }, String(r.songCards.length + i + 1)),
        el("div", { class: "art-wrap small" }, art(link.artist, null, "small"), playableButton({ provider: "soundcloud", source: link.url, title: link.title, subtitle: link.artist, pageUrl: link.url }, true)),
        el("span", { class: "t" }, externalLink(link.url, link.title), el("div", { class: "who small muted" }, `${link.artist} · saved from SoundCloud`)),
        remove,
      ),
    );
  });
  const playAllBtn = el("button", { type: "button", class: "primary" }, "▶ Play all");
  playAllBtn.addEventListener("click", () => void playAll(r.songs, known));
  const del = el("button", { type: "button" }, "Delete playlist");
  del.addEventListener("click", async () => {
    if (!confirm(`Delete “${r.name}”? The songs stay in setscope.`)) return;
    await post("/api/playlists/delete", { name: r.name });
    await loadMe();
    location.hash = "#/library";
  });
  const covers = [...new Set(r.songCards.map((c) => c.image).filter((i): i is string => Boolean(i)))];
  const total = r.songCards.length + r.links.length;
  return el(
    "div",
    { class: "stack" },
    el(
      "section",
      { class: "profile-hero" },
      el("div", { style: "width:168px;flex:none" }, mosaic(covers)),
      el(
        "div",
        { class: "body" },
        el("div", { class: "crumbs" }, homeCrumb(), " › ", el("a", { href: "#/library" }, "Library"), " › Playlist"),
        el("div", { class: "kicker" }, "Playlist"),
        el("h1", {}, r.name),
        el("div", { class: "meta" }, plural(total, "track")),
        el("div", { class: "btns", style: "margin-top:14px" }, total ? playAllBtn : "", del),
      ),
    ),
    el(
      "section",
      { class: "card" },
      total ? rows : el("p", { class: "empty" }, "Empty for now. Add songs with ＋ anywhere you see them, or from the suggestions below."),
    ),
    r.suggestionCards.length
      ? el(
          "section",
          { class: "card" },
          sectionHead(`Might fit “${r.name}”`),
          el(
            "div",
            { class: "tiles" },
            ...r.suggestionCards.map((c) => {
              const add = el("button", { type: "button", class: "act" }, "Add");
              add.addEventListener("click", async () => {
                await post("/api/label", { song: c.name, category: r.name, on: true });
                await loadMe();
                await render();
              });
              return songTile(c, add);
            }),
          ),
        )
      : "",
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
  auto?: boolean;
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

/** "Save…" → pick or type one of your playlists. */
function saveToCategory(url: string): HTMLElement {
  const wrap = el("span", { class: "btns" });
  const open = el("button", { type: "button", class: "act" }, "Save…");
  open.addEventListener("click", () => {
    const input = el("input", { type: "text", placeholder: "Playlist", list: "scCategoryNames", class: "small-input" }) as HTMLInputElement;
    const save = el("button", { type: "button", class: "act" }, "Save");
    const names = el("datalist", { id: "scCategoryNames" }, ...me.categories.map((c) => el("option", { value: c.name })));
    const submit = async () => {
      const category = input.value.trim();
      if (!category) return;
      save.textContent = "Saving…";
      try {
        await post("/api/saved-link", { category, url, on: true });
        await loadMe();
        wrap.replaceChildren(el("span", { class: "small muted" }, "Saved to "), el("a", { class: "link small", href: playlistHash(category) }, category));
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
      const how = link.auto
        ? `matched automatically when someone pressed play (${Math.round(link.confidence * 100)}% match). Wrong? Remove it`
        : link.provenance === "user" ? "pasted" : link.provenance === "search_match" ? `picked from search (${Math.round(link.confidence * 100)}% match)` : "from 1001Tracklists";
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

/**
 * Discover: songs you might like (or, without likes, what's popular), shuffled each visit,
 * with a reserved spot for promoted releases and a SoundCloud curator browser below.
 */
async function discoverPage(params: URLSearchParams, profile: string | undefined): Promise<HTMLElement> {
  const genre = params.get("genre") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  let seed = params.get("seed");
  if (!seed) {
    // A fresh shuffle each visit; it goes in the address so paging keeps the same order.
    seed = String(Math.floor(Math.random() * 1e9));
    history.replaceState(null, "", listHash("discover", params, { seed }));
  }
  const r = await getJson<{ mode: string; items: SongCard[]; page: number; pages: number; total: number }>(
    `/api/discover?genre=${enc(genre)}&page=${page}&seed=${seed}&months=${months()}`,
  );
  const here = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const to = (changes: Record<string, string | null>) => (location.hash = listHash("discover", here, changes));
  const shuffle = el("button", { type: "button" }, "⤨ Shuffle");
  shuffle.addEventListener("click", () => to({ seed: String(Math.floor(Math.random() * 1e9)) }));
  const personal = r.mode === "personal";
  return el(
    "div",
    { class: "stack" },
    pageHead(
      personal ? "Songs you might like" : "Discover",
      personal ? "Played in the same sets as your likes, with lesser-known songs mixed in. Shuffled every visit." : "Popular in DJ sets this month. Like songs to make this yours.",
    ),
    el("div", { class: "filters" }, await genreSelect(genre, (g) => to({ genre: g })), shuffle),
    el(
      "section",
      { class: "card promo" },
      el("div", { class: "label" }, "Promoted"),
      el("p", { class: "small muted", style: "margin:6px 0 0" }, "Reserved for artists and labels to feature new releases later. Nothing is promoted yet, and nothing here is paid."),
    ),
    r.items.length ? el("div", { class: "tiles" }, ...r.items.map((c) => songTile(c))) : el("div", { class: "card empty" }, "Nothing here for that genre yet."),
    pager(r, (n) => listHash("discover", here, { page: String(n) })),
    curatorBrowser(profile),
  );
}

/** A SoundCloud curator's public likes (a DJ, a label, a friend). */
function curatorBrowser(profile: string | undefined): HTMLElement {
  const input = el("input", { type: "text", placeholder: "SoundCloud profile name or link", value: profile ?? "", style: "flex:1; min-width:200px" }) as HTMLInputElement;
  const go = el("button", { type: "button" }, "Show likes");
  const body = el("div", {});
  const submit = () => {
    const name = input.value.trim().replace(/^https?:\/\/(www\.)?soundcloud\.com\//, "").replace(/\/.*$/, "");
    if (name) location.hash = `#/discover/${enc(name)}`;
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  const section = el(
    "details",
    { class: "card", ...(profile ? { open: "" } : {}) },
    el("summary", {}, el("b", {}, "From SoundCloud curators"), " ", el("span", { class: "muted small" }, "what a DJ, label or friend has liked lately")),
    el("div", { class: "row", style: "margin-top:10px" }, input, go),
    el("div", { class: "muted small", style: "margin-top:6px" }, "Only public likes, live from SoundCloud. Nothing is stored unless you save it to a playlist."),
    body,
  );
  if (!profile) return section;
  if (!auth.user) {
    body.replaceChildren(el("p", { class: "muted small" }, el("a", { class: "link", href: "#/account" }, "Sign in"), " to browse SoundCloud likes."));
    return section;
  }
  const list = el("ol", { class: "ranked sc-list" });
  const more = el("button", { type: "button", class: "act" }, "Load more");
  let next: string | null = null;
  const load = async (cursor?: string) => {
    more.textContent = "Loading…";
    try {
      const r = await getJson<{ user: { username: string; permalink: string }; tracks: ScTrackJson[]; next: string | null }>(
        `/api/soundcloud/likes?profile=${enc(profile)}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
      );
      list.append(...r.tracks.map((t) => scTrackRow(t)));
      next = r.next;
      more.hidden = !next;
      body.replaceChildren(
        el("h3", {}, "Liked by ", externalLink(r.user.permalink, r.user.username)),
        list.children.length ? list : el("p", { class: "muted small" }, "No public likes."),
        more,
      );
    } catch (e) {
      body.replaceChildren(el("p", { class: "error small" }, (e as Error).message));
    }
    more.textContent = "Load more";
  };
  more.addEventListener("click", () => {
    if (next) void load(next);
  });
  body.replaceChildren(el("p", { class: "muted small" }, "Loading…"));
  void load();
  return section;
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
  // Still collects, but an old copy may stop early: say so where it's seen.
  if (extensionOutdated()) {
    showExtensionNotices();
    window.scrollTo({ top: 0 });
  }
  window.postMessage({ source: "setscope-app", type: "arm", query, kind }, location.origin);
  return true;
}

function extensionInstalled(): boolean {
  return document.documentElement.dataset.setscopeExtension === "1";
}

/** The version Chrome is running ("old" for copies from before versions were reported). */
function extensionVersion(): string {
  return document.documentElement.dataset.setscopeExtensionVersion ?? "old";
}

/** Installed, but not the copy in the project folder: Chrome needs a reload of it. */
function extensionOutdated(): boolean {
  return extensionInstalled() && Boolean(auth.extensionVersion) && extensionVersion() !== auth.extensionVersion;
}

function showExtensionNotices(): void {
  $("setup").hidden = extensionInstalled();
  const outdated = extensionOutdated();
  $("extUpdate").hidden = !outdated;
  if (outdated) {
    const have = extensionVersion();
    $("extHave").textContent = have === "old" ? "an old version" : `version ${have}`;
    $("extWant").textContent = `version ${auth.extensionVersion}`;
    $("extWant2").textContent = `version ${auth.extensionVersion}`;
  }
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
  strip.hidden = (!active && !refreshWaiting) || !$("queueDrawer").hidden;
  renderQueueBadge(q);
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

/** Put the queue card in the queue drawer and wire its buttons (once, at startup). */
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

/** The Queue button's badge: sets waiting (amber while paused), hidden when nothing is. */
function renderQueueBadge(q: QueueStatus): void {
  const badge = $("queueBadge");
  const waiting = q.waiting.length + (q.state === "running" ? 1 : 0);
  badge.hidden = waiting === 0;
  badge.textContent = waiting > 99 ? "99+" : String(waiting);
  badge.classList.toggle("paused", q.state === "blocked");
  $("queueBtn").title = waiting ? `Collecting sets: ${plural(waiting, "set")} to go${q.state === "blocked" ? " (paused)" : ""}` : "Collecting sets";
}

function setQueueOpen(open: boolean): void {
  $("queueDrawer").hidden = !open;
  $("drawerShade").hidden = !open;
  $("queueBtn").setAttribute("aria-expanded", String(open));
  $("bgCard").hidden = !auth.user?.owner;
  if (lastStatus) renderStatus(lastStatus);
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

window.addEventListener("hashchange", () => {
  setQueueOpen(false);
  closeMenu();
  void showRoute();
});
$("stripRefresh").addEventListener("click", () => void render());

// The queue drawer: from the top bar's Queue button, or "Open queue" in the strip.
mountQueueCard();
$("queueBtn").addEventListener("click", () => setQueueOpen($("queueDrawer").hidden === true));
$("stripDetails").addEventListener("click", () => setQueueOpen(true));
$("queueClose").addEventListener("click", () => setQueueOpen(false));
$("drawerShade").addEventListener("click", () => setQueueOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setQueueOpen(false);
    closeMenu();
  }
});
$("bgToggle").addEventListener("change", () => void post("/api/background", { enabled: $<HTMLInputElement>("bgToggle").checked }));
$("addLinksBtn").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("addLinksText");
  const msg = $("addLinksMsg");
  try {
    const r = await post<{ found: number; queued: number; alreadyCached: number }>("/api/add-links", { text: text.value });
    msg.textContent = `${plural(r.found, "link")}: ${r.queued} new, ${r.alreadyCached} already in setscope.`;
    text.value = "";
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
});

// Give the extension a moment to mark the page before deciding to show setup or update steps.
setTimeout(showExtensionNotices, 800);

void poll().then(() => showRoute());
setInterval(() => void poll(), 1500);
