// Web server for setscope. Run with `npm run web`, then open http://127.0.0.1:7331.
// Listens on 127.0.0.1 only. Data lives in Postgres (DATABASE_URL, default: the
// project-local database from scripts/db.sh).
//
// Anyone who can reach the site can browse; liking, categories and queue controls need
// an account; site-wide settings (GetSongBPM key, background collecting) are the owner's
// (the first account).
//
//   GET  /  /app.js                     the page, and web/app.ts with types stripped
//   GET  /api/auth/me                    who you are, and whether sign-up is open
//   POST /api/auth/register|login|logout
//   GET  /api/song?q=  /api/artist?name=  /api/suggest  /api/trending
//   GET  /api/me  /api/for-you  /api/category?name=     (your data; needs login)
//   POST /api/like  /api/label                           (needs login)
//   GET  /api/song-info?song=            key and BPM (GetSongBPM, cached)
//   GET  /api/account   POST /api/account/getsongbpm-key (owner)
//   GET  /api/status    POST /api/background (owner)
//   POST /api/capture  /api/capture-set   from the browser extension
//   POST /api/add-links /api/resume /api/clear-queue /api/include-older /api/more /api/clear-found (needs login)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { analyzeArtist, foundNothing } from "./analysis/artist.ts";
import { correctArtist, correctSong, searchArtists, searchSongs, songsWithTitle } from "./analysis/catalog.ts";
import { today } from "./analysis/common.ts";
import { categoryHints, setsForYou, songsLike } from "./analysis/personal.ts";
import { artistProfile } from "./analysis/profile.ts";
import { analyzeSong, type SongReport } from "./analysis/song.ts";
import { trending } from "./analysis/trending.ts";
import { AccountError, Accounts, SESSION_DAYS, type User } from "./auth/accounts.ts";
import type { Catalog } from "./catalog/catalog.ts";
import { PgCatalog } from "./catalog/pg-catalog.ts";
import { DEFAULT_MONTHS, dataDir, sinceMonths } from "./config.ts";
import { importLegacySets } from "./db/import-legacy.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { normalizeName, parseSongQuery, songKey, trackFromName } from "./normalize.ts";
import { PgUserData, UserDataError } from "./personal/user-data.ts";
import { BackgroundCollector } from "./source/background.ts";
import { isFetchAllowed, PoliteFetcher } from "./source/fetcher.ts";
import { extractTracklistUrls } from "./source/parse.ts";
import { FetchQueue } from "./source/queue.ts";
import { SongInfoService, SongInfoStore } from "./source/songinfo.ts";

export const PORT = Number(process.env.SETSCOPE_PORT ?? 7331);
const WEB_DIR = join(import.meta.dirname, "..", "web");
const COOKIE = "setscope_session";

export interface App {
  catalog: Catalog;
  queue: FetchQueue;
  accounts: Accounts;
  userData: PgUserData;
  songInfo: SongInfoService;
  background: BackgroundCollector | undefined;
  /** Where the GetSongBPM key is saved when the owner sets it on the Account page. */
  keyFile: string | undefined;
  /** The old single-user likes file, imported into the first account created. */
  legacyUserFile: string | undefined;
  /** Mark session cookies Secure (set when served over HTTPS). */
  secureCookies: boolean;
  /** Cutoff from the most recent report, applied to links the extension sends. */
  since: string;
}

export interface AppOptions {
  songInfo?: SongInfoService;
  background?: BackgroundCollector;
  keyFile?: string;
  legacyUserFile?: string;
  secureCookies?: boolean;
}

/** Thrown for bad input; becomes a 400 with the message shown in the page. */
class BadRequest extends Error {}
/** Thrown when the request needs a login (401) or the owner (403). */
class NotAllowed extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createApp(catalog: Catalog, queue: FetchQueue, accounts: Accounts, userData: PgUserData, options: AppOptions = {}) {
  const app: App = {
    catalog,
    queue,
    accounts,
    userData,
    songInfo: options.songInfo ?? new SongInfoService(new SongInfoStore()),
    background: options.background,
    keyFile: options.keyFile,
    legacyUserFile: options.legacyUserFile,
    secureCookies: options.secureCookies ?? false,
    since: sinceMonths(),
  };
  return createServer((req, res) => {
    if (req.url?.startsWith("/api/") && req.url !== "/api/status") {
      res.on("finish", () => console.log(`${req.method} ${req.url} -> ${res.statusCode}`));
    }
    handle(app, req, res).catch((error: unknown) => {
      const status = error instanceof NotAllowed ? error.status : error instanceof BadRequest ? 400 : 500;
      if (status === 500) console.error(error);
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = `${req.method} ${url.pathname}`;
  const params = url.searchParams;
  const token = cookie(req, COOKIE);
  const user = await app.accounts.userForSession(token);
  const needUser = (what: string): User => {
    if (!user) throw new NotAllowed(`Log in to ${what}.`, 401);
    return user;
  };
  const needOwner = async (what: string): Promise<User> => {
    const u = needUser(what);
    if (!(await app.accounts.isOwner(u.id))) throw new NotAllowed(`Only the site owner can ${what}.`, 403);
    return u;
  };

  switch (route) {
    case "GET /":
      return sendFile(res, "index.html", "text/html; charset=utf-8");
    case "GET /app.js": {
      const source = readFileSync(join(WEB_DIR, "app.ts"), "utf8");
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(stripTypeScriptTypes(source));
      return;
    }

    // ---- accounts ----
    case "GET /api/auth/me":
      return sendJson(res, 200, {
        user: user ? { ...user, owner: await app.accounts.isOwner(user.id) } : null,
        signup: await app.accounts.signupStatus(),
      });
    case "POST /api/auth/register": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as Record<string, unknown>;
      const firstAccount = (await app.accounts.userCount()) === 0;
      const created = await accountAction(() =>
        app.accounts.register({
          email: String(body.email ?? ""),
          password: String(body.password ?? ""),
          displayName: String(body.displayName ?? ""),
          inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : undefined,
        }),
      );
      // Your likes and categories from before accounts existed go to the first account.
      const imported = firstAccount && app.legacyUserFile ? await app.userData.importLegacy(created.id, app.legacyUserFile) : undefined;
      setSessionCookie(app, res, await app.accounts.startSession(created.id));
      return sendJson(res, 200, { user: created, imported });
    }
    case "POST /api/auth/login": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as Record<string, unknown>;
      const found = await accountAction(() => app.accounts.login(String(body.email ?? ""), String(body.password ?? "")));
      setSessionCookie(app, res, await app.accounts.startSession(found.id));
      return sendJson(res, 200, { user: found });
    }
    case "POST /api/auth/logout":
      requireOwnHeader(req);
      await app.accounts.endSession(token);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${app.secureCookies ? "; Secure" : ""}`);
      return sendJson(res, 200, { ok: true });

    // ---- reports (anyone) ----
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
      const sets = await app.catalog.all();
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
      return sendJson(res, 200, await withUserData(app, user, report, sets));
    }
    case "GET /api/artist": {
      const name = required(params, "name");
      app.since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const options = { since: app.since, today: today(), recentMonths: intParam(params, "recentMonths", 6), top: intParam(params, "top", 10) };
      const sets = await app.catalog.all();
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
      return sendJson(res, 200, search(await app.catalog.all(), q, since));
    }
    case "GET /api/trending": {
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      return sendJson(res, 200, trending(await app.catalog.all(), { since, today: today(), recentDays: intParam(params, "days", 30), top: 5 }));
    }
    case "GET /api/song-info": {
      const song = required(params, "song");
      if (!song.includes(" - ")) throw new BadRequest('Expected "Artist - Title"');
      return sendJson(res, 200, await app.songInfo.info(song));
    }

    // ---- your data (needs login) ----
    case "GET /api/me": {
      if (!user) return sendJson(res, 200, { likes: [], categories: [] });
      const { likes, categories } = await app.userData.get(user.id);
      return sendJson(res, 200, {
        likes: Object.values(likes),
        categories: Object.values(categories).map((c) => ({ name: c.name, songs: Object.values(c.songs) })),
      });
    }
    case "POST /api/like": {
      requireOwnHeader(req);
      const u = needUser("like songs");
      const body = (await readJson(req)) as { song?: unknown; liked?: unknown };
      if (typeof body.song !== "string" || typeof body.liked !== "boolean") throw new BadRequest("Expected { song, liked }");
      await userAction(() => app.userData.setLiked(u.id, body.song as string, body.liked as boolean));
      return sendJson(res, 200, { ok: true });
    }
    case "POST /api/label": {
      requireOwnHeader(req);
      const u = needUser("use categories");
      const body = (await readJson(req)) as { song?: unknown; category?: unknown; on?: unknown };
      if (typeof body.song !== "string" || typeof body.category !== "string" || typeof body.on !== "boolean") {
        throw new BadRequest("Expected { song, category, on }");
      }
      await userAction(() => app.userData.setLabel(u.id, body.song as string, body.category as string, body.on as boolean));
      return sendJson(res, 200, { ok: true });
    }
    case "GET /api/for-you": {
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      if (!user) return sendJson(res, 200, { likes: [], sets: [], songs: [] });
      const mine = await app.userData.get(user.id);
      const liked = new Set(Object.keys(mine.likes));
      const sets = await app.catalog.all();
      return sendJson(res, 200, { likes: Object.values(mine.likes), sets: setsForYou(sets, liked, since, 30), songs: songsLike(sets, liked, since) });
    }
    case "GET /api/category": {
      const u = needUser("see your categories");
      const name = required(params, "name");
      const category = (await app.userData.get(u.id)).categories[normalizeName(name)];
      if (!category) return sendJson(res, 404, { error: `No category called "${name}"` });
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const members = new Set(Object.keys(category.songs));
      return sendJson(res, 200, { name: category.name, songs: Object.values(category.songs), suggestions: songsLike(await app.catalog.all(), members, since) });
    }
    case "GET /api/account": {
      const u = needUser("see your account");
      const sets = await app.catalog.all();
      const dates = sets.map((s) => s.date).filter(Boolean).sort();
      const { likes, categories } = await app.userData.get(u.id);
      return sendJson(res, 200, {
        user: { ...u, owner: await app.accounts.isOwner(u.id) },
        sets: sets.length,
        oldest: dates[0],
        newest: dates.at(-1),
        likes: Object.values(likes),
        categories: Object.values(categories).map((c) => ({ name: c.name, songs: Object.values(c.songs).length })),
        getSongBpmKey: app.songInfo.hasKey(),
      });
    }

    // ---- site-wide settings (owner) ----
    case "POST /api/account/getsongbpm-key": {
      requireOwnHeader(req);
      await needOwner("change the GetSongBPM key");
      const body = (await readJson(req)) as { key?: unknown };
      if (typeof body.key !== "string") throw new BadRequest("Expected { key: string }");
      const key = body.key.trim();
      if (key && !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new BadRequest("That doesn't look like an API key.");
      app.songInfo.setApiKey(key || undefined);
      if (app.keyFile) writeFileSync(app.keyFile, key ? `${key}\n` : "");
      return sendJson(res, 200, { getSongBpmKey: Boolean(key) });
    }
    case "POST /api/background": {
      requireOwnHeader(req);
      await needOwner("turn background collecting on or off");
      const body = (await readJson(req)) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") throw new BadRequest("Expected { enabled: boolean }");
      if (!app.background) throw new BadRequest("Background collecting isn't available here.");
      app.background.setEnabled(body.enabled);
      return sendJson(res, 200, app.background.status());
    }

    // ---- collecting ----
    case "GET /api/status":
      return sendJson(res, 200, { sets: await app.catalog.count(), since: app.since, queue: app.queue.status(), background: app.background?.status() });
    case "POST /api/capture": {
      // From the browser extension (which may not carry your login).
      requireOwnHeader(req);
      const body = (await readJson(req)) as { pageUrl?: unknown; urls?: unknown };
      if (!Array.isArray(body.urls)) throw new BadRequest("Expected { urls: string[] }");
      const urls = body.urls.filter((u): u is string => typeof u === "string" && isFetchAllowed(u));
      const result = await app.queue.enqueue(urls, app.since);
      console.log(`Captured ${urls.length} sets from ${String(body.pageUrl)}: ${result.queued} new to fetch.`);
      return sendJson(res, 200, { found: urls.length, ...result });
    }
    case "POST /api/capture-set": {
      requireOwnHeader(req);
      const body = (await readJson(req, 10_000_000)) as { pageUrl?: unknown; html?: unknown };
      if (typeof body.pageUrl !== "string" || typeof body.html !== "string") throw new BadRequest("Expected { pageUrl: string, html: string }");
      const pageUrl = body.pageUrl.split("#")[0]!;
      if (!isFetchAllowed(pageUrl)) throw new BadRequest("Not a 1001Tracklists tracklist page");
      let set;
      try {
        set = await app.queue.importPage(body.html, pageUrl);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      console.log(`Imported ${set.id} (${set.tracks.length} tracks) from a page you opened.`);
      return sendJson(res, 200, { id: set.id, title: set.title, tracks: set.tracks.length });
    }
    case "POST /api/add-links": {
      requireOwnHeader(req);
      needUser("add sets");
      const body = (await readJson(req)) as { text?: unknown };
      if (typeof body.text !== "string") throw new BadRequest("Expected { text: string }");
      const urls = extractTracklistUrls(body.text).filter(isFetchAllowed);
      if (urls.length === 0) throw new BadRequest("No 1001Tracklists set links found in that text.");
      return sendJson(res, 200, { found: urls.length, ...(await app.queue.enqueue(urls, app.since)) });
    }
    case "POST /api/more": {
      requireOwnHeader(req);
      needUser("control the queue");
      const body = (await readJson(req)) as { count?: unknown };
      const count = body.count === "all" ? Number.POSITIVE_INFINITY : Number(body.count ?? Number.POSITIVE_INFINITY);
      if (!(count > 0)) throw new BadRequest('"count" must be a positive number or "all"');
      return sendJson(res, 200, { moved: app.queue.more(count) });
    }
    case "POST /api/clear-found":
      requireOwnHeader(req);
      needUser("control the queue");
      return sendJson(res, 200, { cleared: app.queue.clearFound() });
    case "POST /api/include-older": {
      requireOwnHeader(req);
      needUser("control the queue");
      const moved = app.queue.includeOlder();
      app.queue.more(); // straight into fetching, like everything else
      return sendJson(res, 200, { moved });
    }
    case "POST /api/clear-queue":
      requireOwnHeader(req);
      needUser("control the queue");
      return sendJson(res, 200, app.queue.clearQueue());
    case "POST /api/resume":
      requireOwnHeader(req);
      needUser("control the queue");
      app.queue.resume();
      return sendJson(res, 200, app.queue.status());
    default:
      return sendJson(res, 404, { error: `No route for ${route}` });
  }
}

/** Song reports also say whether you liked the song, its categories, and category hints. */
async function withUserData(app: App, user: User | undefined, report: SongReport, sets: Awaited<ReturnType<Catalog["all"]>>): Promise<SongReport> {
  const name = report.matchedAs[0]?.name;
  if (!name || !user) return report;
  const key = songKey(trackFromName(name));
  const { likes, categories } = await app.userData.get(user.id);
  const all = Object.values(categories);
  return {
    ...report,
    liked: key in likes,
    categories: all.filter((c) => key in c.songs).map((c) => c.name),
    hints: categoryHints(sets, key, all, report.since),
  };
}

/** A change to your data; its validation errors become 400s. */
async function userAction(change: () => Promise<void>): Promise<void> {
  try {
    await change();
  } catch (error) {
    if (error instanceof UserDataError) throw new BadRequest(error.message);
    throw error;
  }
}

async function accountAction<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccountError) throw new BadRequest(error.message);
    throw error;
  }
}

function setSessionCookie(app: App, res: ServerResponse, token: string): void {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${app.secureCookies ? "; Secure" : ""}`);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
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
  const pool = createPool();
  await migrate(pool, (line) => console.log(`database: ${line}`));
  const catalog = new PgCatalog(pool);
  // First run on the database: bring over the file cache.
  if ((await catalog.count()) === 0 && existsSync(join(dir, "sets"))) {
    console.log("Importing your file cache into the database (one time)…");
    const { imported } = await importLegacySets(catalog, dir);
    console.log(`Imported ${imported} sets.`);
  }
  const reparsed = await catalog.reparseOutdated();
  if (reparsed) console.log(`Re-read ${reparsed} sets with the newer parser.`);

  const fetcher = new PoliteFetcher({ stateFile: join(dir, "last-request") });
  const queue = new FetchQueue(catalog, fetcher, { saveFile: join(dir, "queue.json") });
  // GetSongBPM key: SETSCOPE_GETSONGBPM_KEY, or the file data/getsongbpm-key (kept out of git with data/).
  const keyFile = join(dir, "getsongbpm-key");
  const apiKey = process.env.SETSCOPE_GETSONGBPM_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined);
  const songInfo = new SongInfoService(new SongInfoStore(join(dir, "songinfo.json")), { apiKey: apiKey || undefined, baseUrl: process.env.SETSCOPE_GETSONGBPM_URL });
  const background = new BackgroundCollector(catalog, queue, fetcher, { saveFile: join(dir, "background.json"), since: () => sinceMonths() });
  setInterval(() => void background.tick(), 15_000);

  const app = createApp(catalog, queue, new Accounts(pool), new PgUserData(pool), {
    songInfo,
    background,
    keyFile,
    legacyUserFile: join(dir, "user.json"),
    secureCookies: process.env.SETSCOPE_SECURE_COOKIES === "1",
  });
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`setscope is running at http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
    if (!apiKey) console.log("No GetSongBPM key yet: song pages won't show key/BPM. See README.");
  });
}
