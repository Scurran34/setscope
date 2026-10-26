// Local web server for the setscope web app. Run with `npm run web`, then open
// http://127.0.0.1:7331. Listens on 127.0.0.1 only, so nothing outside this computer
// can reach it.
//
//   GET  /                  the page (web/index.html)
//   GET  /app.js            web/app.ts with the types stripped
//   GET  /api/song?q=...    song report from the cache
//   GET  /api/artist?name=  artist report from the cache
//   GET  /api/suggest?mode=song|artist&q=   cached names that look like q (search dropdown)
//   GET  /api/status        cache size + fetch progress
//   POST /api/capture       tracklist links found by the browser extension
//   POST /api/capture-set   a whole tracklist page you opened yourself (via the extension)
//   POST /api/more          fetch the next N found sets ({ count }, or all)
//   POST /api/clear-found   forget found-but-not-fetched sets
//   POST /api/add-links     set links pasted into the page
//   POST /api/resume        retry after the site blocked us

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { analyzeArtist } from "./analysis/artist.ts";
import { searchArtists, searchSongs } from "./analysis/catalog.ts";
import { today } from "./analysis/common.ts";
import { analyzeSong } from "./analysis/song.ts";
import { BATCH_SIZE, DEFAULT_MONTHS, dataDir, sinceMonths } from "./config.ts";
import { parseSongQuery } from "./normalize.ts";
import { isFetchAllowed, PoliteFetcher } from "./source/fetcher.ts";
import { extractTracklistUrls } from "./source/parse.ts";
import { FetchQueue } from "./source/queue.ts";
import { TracklistStore } from "./source/store.ts";

export const PORT = Number(process.env.SETSCOPE_PORT ?? 7331);
const WEB_DIR = join(import.meta.dirname, "..", "web");

export interface App {
  store: TracklistStore;
  queue: FetchQueue;
  /** Cutoff from the most recent report, applied to links the extension sends. */
  since: string;
}

/** Thrown for bad input; becomes a 400 with the message shown in the page. */
class BadRequest extends Error {}

export function createApp(store: TracklistStore, queue: FetchQueue) {
  const app: App = { store, queue, since: sinceMonths() };
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
      let query;
      try {
        query = parseSongQuery(q);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      return sendJson(res, 200, analyzeSong(app.store.all(), query, { since: app.since, top: intParam(params, "top", 10) }));
    }
    case "GET /api/artist": {
      const name = required(params, "name");
      app.since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      return sendJson(
        res,
        200,
        analyzeArtist(app.store.all(), name, {
          since: app.since,
          today: today(),
          recentMonths: intParam(params, "recentMonths", 6),
          top: intParam(params, "top", 10),
        }),
      );
    }
    case "GET /api/suggest": {
      const q = params.get("q")?.trim() ?? "";
      if (q.length < 2) return sendJson(res, 200, []);
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const search = params.get("mode") === "artist" ? searchArtists : searchSongs;
      return sendJson(res, 200, search(app.store.all(), q, since));
    }
    case "GET /api/status":
      return sendJson(res, 200, { sets: app.store.all().length, since: app.since, queue: app.queue.status() });
    case "POST /api/capture": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { pageUrl?: unknown; urls?: unknown };
      if (!Array.isArray(body.urls)) throw new BadRequest("Expected { urls: string[] }");
      const urls = body.urls.filter((u): u is string => typeof u === "string" && isFetchAllowed(u));
      const result = app.queue.enqueue(urls, app.since, BATCH_SIZE);
      console.log(`Captured ${urls.length} sets from ${String(body.pageUrl)}: ${result.queued} new, fetching ${result.fetchingNow}.`);
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
      const count = body.count === "all" ? Number.POSITIVE_INFINITY : Number(body.count ?? BATCH_SIZE);
      if (!(count > 0)) throw new BadRequest('"count" must be a positive number or "all"');
      return sendJson(res, 200, { moved: app.queue.more(count) });
    }
    case "POST /api/clear-found":
      requireOwnHeader(req);
      return sendJson(res, 200, { cleared: app.queue.clearFound() });
    case "POST /api/add-links": {
      requireOwnHeader(req);
      const body = (await readJson(req)) as { text?: unknown };
      if (typeof body.text !== "string") throw new BadRequest("Expected { text: string }");
      const urls = extractTracklistUrls(body.text).filter(isFetchAllowed);
      if (urls.length === 0) throw new BadRequest("No 1001Tracklists set links found in that text.");
      return sendJson(res, 200, { found: urls.length, ...app.queue.enqueue(urls, app.since, BATCH_SIZE) });
    }
    case "POST /api/resume":
      requireOwnHeader(req);
      app.queue.resume();
      return sendJson(res, 200, app.queue.status());
    default:
      return sendJson(res, 404, { error: `No route for ${route}` });
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
  // Sets cached before DJ page links were recorded: re-read their saved HTML (no network).
  if (store.all().some((set) => set.djPages === undefined)) {
    console.log(`Updated ${store.reparseAll()} cached sets with DJ page links.`);
  }
  const fetcher = new PoliteFetcher({ stateFile: join(dir, "last-request") });
  const queue = new FetchQueue(store, fetcher, { saveFile: join(dir, "queue.json") });
  createApp(store, queue).listen(PORT, "127.0.0.1", () => {
    console.log(`setscope is running at http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
  });
}
