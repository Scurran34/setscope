// Local web server for the setscope web app. Run with `npm run web`, then open
// http://127.0.0.1:7331. Listens on 127.0.0.1 only, so nothing outside this computer
// can reach it.
//
//   GET  /                  the page (web/index.html)
//   GET  /app.js            web/app.ts with the types stripped
//   GET  /api/song?q=...    song report from the cache (&exact=1 turns off auto-correct)
//   GET  /api/artist?name=  artist report from the cache (&exact=1 likewise)
//   GET  /api/suggest?mode=song|artist&q=   cached names that look like q (search dropdown)
//   GET  /api/trending?days=30   songs and artists rising in the cache
//   GET  /api/status        cache size + fetch progress + background collector
//   POST /api/background    { enabled } turn background collecting on or off
//   POST /api/capture       tracklist links found by the browser extension
//   POST /api/capture-set   a whole tracklist page you opened yourself (via the extension)
//   POST /api/more          fetch the next N found sets ({ count }, or all)
//   POST /api/clear-found   forget found-but-not-fetched sets
//   POST /api/clear-queue   forget everything waiting or found
//   POST /api/include-older add the sets that were older than the cutoff to found
//   POST /api/add-links     set links pasted into the page
//   POST /api/resume        retry after the site blocked us
//   GET  /api/me            your liked songs and categories
//   POST /api/like          { song, liked }
//   POST /api/label         { song, category, on }
//   GET  /api/for-you       sets with the most of your liked songs, and songs you might like
//   GET  /api/category?name=   a category's songs, and songs that might fit it
//   GET  /api/song-info?song=  key and BPM (GetSongBPM, cached)
//   GET  /api/account       cache stats, likes, categories, whether a GetSongBPM key is set
//   POST /api/account/getsongbpm-key   { key } save (or clear, with "") the GetSongBPM key

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { analyzeArtist, foundNothing } from "./analysis/artist.ts";
import { correctArtist, correctSong, searchArtists, searchSongs, songsWithTitle } from "./analysis/catalog.ts";
import { artistProfile } from "./analysis/profile.ts";
import { trending } from "./analysis/trending.ts";
import { today } from "./analysis/common.ts";
import { categoryHints, setsForYou, songsLike } from "./analysis/personal.ts";
import { analyzeSong, type SongReport } from "./analysis/song.ts";
import { DEFAULT_MONTHS, dataDir, sinceMonths } from "./config.ts";
import { normalizeName, parseSongQuery, songKey, trackFromName } from "./normalize.ts";
import { isFetchAllowed, PoliteFetcher } from "./source/fetcher.ts";
import { extractTracklistUrls, PARSER_VERSION } from "./source/parse.ts";
import { BackgroundCollector } from "./source/background.ts";
import { FetchQueue } from "./source/queue.ts";
import { SongInfoService, SongInfoStore } from "./source/songinfo.ts";
import { TracklistStore } from "./source/store.ts";
import { UserStore } from "./user.ts";

export const PORT = Number(process.env.SETSCOPE_PORT ?? 7331);
const WEB_DIR = join(import.meta.dirname, "..", "web");

export interface App {
  store: TracklistStore;
  queue: FetchQueue;
  user: UserStore;
  songInfo: SongInfoService;
  background: BackgroundCollector | undefined;
  /** Where the GetSongBPM key is saved when you set it on the Account page. */
  keyFile: string | undefined;
  /** Cutoff from the most recent report, applied to links the extension sends. */
  since: string;
}

/** Thrown for bad input; becomes a 400 with the message shown in the page. */
class BadRequest extends Error {}

export function createApp(
  store: TracklistStore,
  queue: FetchQueue,
  {
    user = new UserStore(),
    songInfo = new SongInfoService(new SongInfoStore()),
    background,
    keyFile,
  }: { user?: UserStore; songInfo?: SongInfoService; background?: BackgroundCollector; keyFile?: string } = {},
) {
  const app: App = { store, queue, user, songInfo, background, keyFile, since: sinceMonths() };
  return createServer((req, res) => {
    if (req.url?.startsWith("/api/") && req.url !== "/api/status") {
      res.on("finish", () => console.log(`${req.method} ${req.url} -> ${res.statusCode}`));
    }
    handle(app, req, res).catch((error: unknown) => {
      const status = error instanceof BadRequest ? 400 : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = `${req.method} ${url.pathname}`;
  const params = url.searchParams;

  switch (route) {
    case "GET /":
      return sendFile(res, "index.html", "text/html; charset=utf-8");
    case "GET /app.js": {
      const source = readFileSync(join(WEB_DIR, "app.ts"), "utf8");
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(stripTypeScriptTypes(source));
      return;
    }
    case "GET /api/song": {
      const q = required(params, "q");
      app.since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const options = { since: app.since, top: intParam(params, "top", 10) };
      let query;
      try {
        query = parseSongQuery(q);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      const sets = app.store.all();
      // Title only: show the most-played song with that title, and list the others.
      const versions = query.titleOnly ? songsWithTitle(sets, q, app.since) : [];
      let report: SongReport;
      if (versions.length > 0) {
        report = { ...analyzeSong(sets, parseSongQuery(versions[0]!.name), options), otherVersions: versions.slice(1, 6) };
      } else {
        report = analyzeSong(sets, query, options);
        // Nothing found, but one cached song is clearly what was meant: show that instead.
        const fix = report.setsWithSong === 0 && params.get("exact") !== "1" ? correctSong(sets, q, app.since) : undefined;
        if (fix) report = { ...analyzeSong(sets, parseSongQuery(fix), options), correctedFrom: q };
      }
      return sendJson(res, 200, withUserData(app, report));
    }
    case "GET /api/artist": {
      const name = required(params, "name");
      app.since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const options = {
        since: app.since,
        today: today(),
        recentMonths: intParam(params, "recentMonths", 6),
        top: intParam(params, "top", 10),
      };
      const sets = app.store.all();
      let report = analyzeArtist(sets, name, options);
      if (foundNothing(report) && params.get("exact") !== "1") {
        const fix = correctArtist(sets, name, app.since);
        if (fix) report = { ...analyzeArtist(sets, fix, options), correctedFrom: name };
        else report.suggestions = searchArtists(sets, name, app.since, 5);
      }
      return sendJson(res, 200, { ...report, profile: artistProfile(sets, report.artist, app.since) });
    }
    case "GET /api/suggest": {
      const q = params.get("q")?.trim() ?? "";
      if (q.length < 2) return sendJson(res, 200, []);
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const search = params.get("mode") === "artist" ? searchArtists : searchSongs;
      return sendJson(res, 200, search(app.store.all(), q, since));
    }
    case "GET /api/trending": {
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const report = trending(app.store.all(), { since, today: today(), recentDays: intParam(params, "days", 30), top: 5 });
      return sendJson(res, 200, report);
    }
    case "GET /api/me": {
      const { likes, categories } = app.user.get();
      return sendJson(res, 200, {
        likes: Object.values(likes),
        categories: Object.values(categories).map((c) => ({ name: c.name, songs: Object.values(c.songs) })),
      });
    }
    case "POST /api/like": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { song?: unknown; liked?: unknown };
      if (typeof body.song !== "string" || typeof body.liked !== "boolean") throw new BadRequest("Expected { song, liked }");
      userAction(() => app.user.setLiked(body.song as string, body.liked as boolean));
      return sendJson(res, 200, { ok: true });
    }
    case "POST /api/label": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { song?: unknown; category?: unknown; on?: unknown };
      if (typeof body.song !== "string" || typeof body.category !== "string" || typeof body.on !== "boolean") {
        throw new BadRequest("Expected { song, category, on }");
      }
      userAction(() => app.user.setLabel(body.song as string, body.category as string, body.on as boolean));
      return sendJson(res, 200, { ok: true });
    }
    case "GET /api/for-you": {
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const liked = new Set(Object.keys(app.user.get().likes));
      const sets = app.store.all();
      return sendJson(res, 200, {
        likes: Object.values(app.user.get().likes),
        sets: setsForYou(sets, liked, since, 30),
        songs: songsLike(sets, liked, since),
      });
    }
    case "GET /api/category": {
      const name = required(params, "name");
      const category = app.user.get().categories[normalizeName(name)];
      if (!category) return sendJson(res, 404, { error: `No category called "${name}"` });
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const members = new Set(Object.keys(category.songs));
      return sendJson(res, 200, {
        name: category.name,
        songs: Object.values(category.songs),
        suggestions: songsLike(app.store.all(), members, since),
      });
    }
    case "GET /api/song-info": {
      const song = required(params, "song");
      if (!song.includes(" - ")) throw new BadRequest('Expected "Artist - Title"');
      return sendJson(res, 200, await app.songInfo.info(song));
    }
    case "GET /api/account": {
      const sets = app.store.all();
      const dates = sets.map((s) => s.date).sort();
      const { likes, categories } = app.user.get();
      return sendJson(res, 200, {
        sets: sets.length,
        oldest: dates[0],
        newest: dates.at(-1),
        likes: Object.values(likes),
        categories: Object.values(categories).map((c) => ({ name: c.name, songs: Object.values(c.songs).length })),
        getSongBpmKey: app.songInfo.hasKey(),
      });
    }
    case "POST /api/account/getsongbpm-key": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { key?: unknown };
      if (typeof body.key !== "string") throw new BadRequest("Expected { key: string }");
      const key = body.key.trim();
      if (key && !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new BadRequest("That doesn't look like an API key.");
      app.songInfo.setApiKey(key || undefined);
      if (app.keyFile) writeFileSync(app.keyFile, key ? `${key}\n` : "");
      return sendJson(res, 200, { getSongBpmKey: Boolean(key) });
    }
    case "GET /api/status":
      return sendJson(res, 200, {
        sets: app.store.all().length,
        since: app.since,
        queue: app.queue.status(),
        background: app.background?.status(),
      });
    case "POST /api/background": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") throw new BadRequest("Expected { enabled: boolean }");
      if (!app.background) throw new BadRequest("Background collecting isn't available here.");
      app.background.setEnabled(body.enabled);
      return sendJson(res, 200, app.background.status());
    }
    case "POST /api/capture": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { pageUrl?: unknown; urls?: unknown };
      if (!Array.isArray(body.urls)) throw new BadRequest("Expected { urls: string[] }");
      const urls = body.urls.filter((u): u is string => typeof u === "string" && isFetchAllowed(u));
      const result = app.queue.enqueue(urls, app.since);
      console.log(`Captured ${urls.length} sets from ${String(body.pageUrl)}: ${result.queued} new to fetch.`);
      return sendJson(res, 200, { found: urls.length, ...result });
    }
    case "POST /api/capture-set": {
      requireOwnHeader(req);
      const body = (await readJson(req, 10_000_000)) as { pageUrl?: unknown; html?: unknown };
      if (typeof body.pageUrl !== "string" || typeof body.html !== "string") {
        throw new BadRequest("Expected { pageUrl: string, html: string }");
      }
      if (!isFetchAllowed(body.pageUrl.split("#")[0]!)) throw new BadRequest("Not a 1001Tracklists tracklist page");
      let set;
      try {
        set = app.queue.importPage(body.html, body.pageUrl.split("#")[0]!);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      console.log(`Imported ${set.id} (${set.tracks.length} tracks) from a page you opened.`);
      return sendJson(res, 200, { id: set.id, title: set.title, tracks: set.tracks.length });
    }
    case "POST /api/more": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { count?: unknown };
      const count = body.count === "all" ? Number.POSITIVE_INFINITY : Number(body.count ?? Number.POSITIVE_INFINITY);
      if (!(count > 0)) throw new BadRequest('"count" must be a positive number or "all"');
      return sendJson(res, 200, { moved: app.queue.more(count) });
    }
    case "POST /api/clear-found":
      requireOwnHeader(req);
      return sendJson(res, 200, { cleared: app.queue.clearFound() });
    case "POST /api/include-older":
      requireOwnHeader(req);
      const moved = app.queue.includeOlder();
      app.queue.more(); // straight into fetching, like everything else
      return sendJson(res, 200, { moved });
    case "POST /api/clear-queue":
      requireOwnHeader(req);
      return sendJson(res, 200, app.queue.clearQueue());
    case "POST /api/add-links": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { text?: unknown };
      if (typeof body.text !== "string") throw new BadRequest("Expected { text: string }");
      const urls = extractTracklistUrls(body.text).filter(isFetchAllowed);
      if (urls.length === 0) throw new BadRequest("No 1001Tracklists set links found in that text.");
      return sendJson(res, 200, { found: urls.length, ...app.queue.enqueue(urls, app.since) });
    }
    case "POST /api/resume":
      requireOwnHeader(req);
      app.queue.resume();
      return sendJson(res, 200, app.queue.status());
    default:
      return sendJson(res, 404, { error: `No route for ${route}` });
  }
}

/** Song reports also say whether you liked the song, its categories, and category hints. */
function withUserData(app: App, report: SongReport): SongReport {
  const name = report.matchedAs[0]?.name;
  if (!name) return report;
  const key = songKey(trackFromName(name));
  const { likes, categories } = app.user.get();
  const all = Object.values(categories);
  return {
    ...report,
    liked: key in likes,
    categories: all.filter((c) => key in c.songs).map((c) => c.name),
    hints: categoryHints(app.store.all(), key, all, report.since),
  };
}

/** Run a change to your data; its validation errors become 400s. */
function userAction(change: () => void): void {
  try {
    change();
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }
}

/**
 * Write endpoints need an `X-Setscope` header. A random website can't add a custom
 * header to a cross-site request without the browser asking us first (a CORS
 * preflight), and we never say yes, so only our page and our extension get through.
 */
function requireOwnHeader(req: IncomingMessage): void {
  if (req.headers["x-setscope"] !== "1") throw new BadRequest("Missing X-Setscope header");
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name)?.trim();
  if (!value) throw new BadRequest(`Missing "${name}"`);
  return value;
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`"${name}" must be a positive whole number`);
  return n;
}

async function readJson(req: IncomingMessage, maxChars = 1_000_000): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxChars) throw new BadRequest("Request too large");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new BadRequest("Body must be JSON");
  }
}

function sendFile(res: ServerResponse, file: string, type: string): void {
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(readFileSync(join(WEB_DIR, file)));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Start the server when run directly (not when imported by tests).
if (import.meta.main) {
  const dir = dataDir();
  const store = new TracklistStore(dir);
  // Sets read by an older parser: re-read their saved HTML to pick up new fields (no network).
  if (store.all().some((set) => (set.parserVersion ?? 1) < PARSER_VERSION)) {
    console.log(`Re-read ${store.reparseAll()} cached sets with the newer parser.`);
  }
  const fetcher = new PoliteFetcher({ stateFile: join(dir, "last-request") });
  const queue = new FetchQueue(store, fetcher, { saveFile: join(dir, "queue.json") });
  const user = new UserStore(join(dir, "user.json"));
  // GetSongBPM key: SETSCOPE_GETSONGBPM_KEY, or the file data/getsongbpm-key (kept out of git with data/).
  const keyFile = join(dir, "getsongbpm-key");
  const apiKey = process.env.SETSCOPE_GETSONGBPM_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined);
  const songInfo = new SongInfoService(new SongInfoStore(join(dir, "songinfo.json")), {
    apiKey: apiKey || undefined,
    baseUrl: process.env.SETSCOPE_GETSONGBPM_URL,
  });
  const background = new BackgroundCollector(store, queue, fetcher, {
    saveFile: join(dir, "background.json"),
    since: () => sinceMonths(),
  });
  setInterval(() => void background.tick(), 15_000);
  const app = createApp(store, queue, { user, songInfo, background, keyFile });
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`setscope is running at http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
    if (!apiKey) console.log("No GetSongBPM key yet: song pages won't show key/BPM. See README.");
  });
}
