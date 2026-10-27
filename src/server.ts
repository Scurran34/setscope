// Web server for setscope. Run with `npm run web`, then open http://127.0.0.1:7331.
// Listens on 127.0.0.1 only. Data lives in Postgres (DATABASE_URL, default: the
// project-local database from scripts/db.sh).
//
// Anyone who can reach the site can browse; liking, categories and queue controls need
// an account; site-wide settings (GetSongBPM key, background collecting) are the owner's
// (the first account).
//
//   GET  /  /app.js  /player.ts          the page, and its browser modules with types stripped
//   GET  /api/auth/me                    who you are, and whether sign-up is open
//   POST /api/auth/register|login|logout
//   GET  /api/song?q=  /api/artist?name=  /api/suggest  /api/trending
//   GET  /api/me  /api/for-you  /api/playlists  /api/playlist?name=   (your data; needs login)
//   POST /api/like  /api/label (add/remove a song in a playlist)  /api/playlists  /api/playlists/delete
//   GET  /api/discover?genre=&page=&seed=   songs you might like (or trending ones), shuffled
//   GET  /api/song-info?song=            key and BPM (GetSongBPM, cached)
//   GET  /api/song/alongside?song=&sort=specific|count&page=   every song played in the same sets
//   GET  /api/account   POST /api/account/getsongbpm-key (owner)
//   GET  /api/status    POST /api/background (owner)
//   POST /api/capture  /api/capture-set   from the browser extension
//   POST /api/add-links /api/resume /api/clear-queue /api/include-older /api/retry-failed (needs login)
//   POST /api/refresh-set { url }        re-read a set now (needs login)
//   GET  /api/discovery?mode=now|most|deep&scope=all|followed|custom&djs=&genre=&period=&page=
//                                        third-party tracks DJs are playing (src/catalog/discover.ts)
//   GET  /api/djs?q=&following=1&page=   DJs with indexed sets;  POST /api/follow { dj, on }
//   GET  /api/dj?name=  /api/dj/selections  /api/dj/own  /api/dj/ids    a DJ's profile, picks, own tracks, IDs
//   GET  /api/vault   POST /api/vault { set, position, on }             the Unreleased Vault
//   POST /api/gather/stop { dj }         cancel a DJ's sets that haven't been fetched yet
//   GET  /api/charts/songs  /api/charts/artists  ?period=week|month|3months|year|all&genre=&q=&page=
//   GET  /api/sets?q=&dj=&year=&page=  /api/set?id=  /api/genres  /api/search?q=  /api/vault-preview
//   GET  /api/play?song=                 something to play for a song: its link, or its best SoundCloud match
//   GET  /api/song-links?song=           confirmed SoundCloud links for a song
//   POST /api/song-links  /api/song-links/remove        confirm (or remove) one (needs login)
//   GET  /api/soundcloud/candidates?song=  /api/soundcloud/remixes?song=  /api/soundcloud/likes?profile=
//                                        live SoundCloud searches, not stored (needs login)
//   POST /api/saved-link                 save a SoundCloud upload in a category (needs login)
//   POST /api/account/soundcloud         the SoundCloud app's credentials (owner)

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type pg from "pg";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { analyzeArtist, foundNothing } from "./analysis/artist.ts";
import { correctArtist, correctSong, searchArtists, searchSongs, songsWithTitle } from "./analysis/catalog.ts";
import { today } from "./analysis/common.ts";
import { categoryHints, setsForYou, songsLike } from "./analysis/personal.ts";
import { artistProfile } from "./analysis/profile.ts";
import { analyzeSong, playedAlongside, type SongReport } from "./analysis/song.ts";
import { trending } from "./analysis/trending.ts";
import { AccountError, Accounts, SESSION_DAYS, type User } from "./auth/accounts.ts";
import { RateLimiter } from "./auth/rate-limit.ts";
import { canonicalPage, discoveryForArtist, recordDiscovery } from "./collect/discovery.ts";
import { PgJobQueue } from "./collect/jobs.ts";
import type { Catalog } from "./catalog/catalog.ts";
import { PgCatalog } from "./catalog/pg-catalog.ts";
import { DEFAULT_MONTHS, dataDir, sinceMonths } from "./config.ts";
import { importLegacySets } from "./db/import-legacy.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { normalizeName, parseSongQuery, songKey, splitArtists, trackFromName } from "./normalize.ts";
import { findTrackId, PgUserData, UserDataError } from "./personal/user-data.ts";
import { BackgroundCollector } from "./source/background.ts";
import { isFetchAllowed, PoliteFetcher } from "./source/fetcher.ts";
import { extractTracklistUrls } from "./source/parse.ts";
import { SongInfoService, SongInfoStore } from "./source/songinfo.ts";
import { ScError, ScRateLimited, SoundCloudClient, type ScTrack } from "./soundcloud/client.ts";
import { isTrackLink, LinkStore } from "./soundcloud/links.ts";
import { classify, remixesOf, songCandidates, type Candidate } from "./soundcloud/match.ts";
import { versionOf } from "./catalog/identity.ts";
import { discover, djProfile, followedIds, idLines, listDjs, MODES, ownTracks, resolveArtist, setFollow, type DiscoveryMode } from "./catalog/discover.ts";
import { Vault } from "./personal/vault.ts";
import { artistChart, genres, idStats, listSets, PERIODS, setCardsByIds, setDetail, songCards, songChart, type Period, type SongCard } from "./catalog/browse.ts";

export const PORT = Number(process.env.SETSCOPE_PORT ?? 7331);
const WEB_DIR = join(import.meta.dirname, "..", "web");
const COOKIE = "setscope_session";
/** A "since" date that holds nothing back: for sets you asked for yourself. */
const ALL_TIME = "0001-01-01";
/** How long a capture key (for gathering through a shared link) stays valid. */
const CAPTURE_TOKEN_MS = 12 * 60 * 60_000;
/** Most sets one gather by someone other than you (through a shared link) can queue. */
const FRIEND_GATHER_MAX = 200;

export interface App {
  pool: pg.Pool;
  catalog: Catalog;
  queue: PgJobQueue;
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
  /** Slows down floods of captures / pasted links (per account, or per address without one). */
  captureLimit: RateLimiter;
  soundcloud: SoundCloudClient;
  vault: Vault;
  links: LinkStore;
  /** Where the SoundCloud app's credentials are saved when the owner sets them. */
  soundcloudFile: string | undefined;
  /** SoundCloud searches per account, so one person can't use up the app's hourly allowance. */
  soundcloudLimit: RateLimiter;
  /** Likes lookups for the whole site: SoundCloud allows the app 500 a day. */
  likesLimit: RateLimiter;
  /** Tracks SoundCloud had no match for, and until when not to search again. */
  noMatch: Map<number, number>;
  /** Capture keys handed to the extension: key -> whose, until when. */
  captureTokens: Map<string, { userId: number; expires: number }>;
}

export interface AppDeps {
  pool: pg.Pool;
  catalog: Catalog;
  queue: PgJobQueue;
  accounts: Accounts;
  userData: PgUserData;
}

export interface AppOptions {
  captureLimit?: RateLimiter;
  songInfo?: SongInfoService;
  background?: BackgroundCollector;
  keyFile?: string;
  legacyUserFile?: string;
  secureCookies?: boolean;
  soundcloud?: SoundCloudClient;
  soundcloudFile?: string;
  soundcloudLimit?: RateLimiter;
  likesLimit?: RateLimiter;
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

export function createApp({ pool, catalog, queue, accounts, userData }: AppDeps, options: AppOptions = {}) {
  const app: App = {
    pool,
    catalog,
    queue,
    accounts,
    userData,
    captureLimit: options.captureLimit ?? new RateLimiter(30, 10 * 60_000),
    songInfo: options.songInfo ?? new SongInfoService(new SongInfoStore()),
    background: options.background,
    keyFile: options.keyFile,
    legacyUserFile: options.legacyUserFile,
    secureCookies: options.secureCookies ?? false,
    since: sinceMonths(),
    soundcloud: options.soundcloud ?? new SoundCloudClient(),
    vault: new Vault(pool),
    links: new LinkStore(pool),
    soundcloudFile: options.soundcloudFile,
    soundcloudLimit: options.soundcloudLimit ?? new RateLimiter(120, 10 * 60_000),
    likesLimit: options.likesLimit ?? new RateLimiter(400, 24 * 60 * 60_000),
    noMatch: new Map(),
    captureTokens: new Map(),
  };
  return createServer((req, res) => {
    if (req.url?.startsWith("/api/") && req.url !== "/api/status") {
      res.on("finish", () => console.log(`${req.method} ${req.url} -> ${res.statusCode}`));
    }
    handle(app, req, res).catch((error: unknown) => {
      const status = error instanceof NotAllowed ? error.status : error instanceof ScRateLimited ? 429 : error instanceof BadRequest || error instanceof ScError ? 400 : 500;
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
    case "GET /app.js":
      return sendScript(res, "app.ts");
    case "GET /player.ts": // imported by app.ts
      return sendScript(res, "player.ts");

    // ---- accounts ----
    case "GET /api/auth/me":
      return sendJson(res, 200, {
        user: user ? { ...user, owner: await app.accounts.isOwner(user.id) } : null,
        signup: await app.accounts.signupStatus(),
        soundcloud: app.soundcloud.configured(),
        extensionVersion: extensionVersion(),
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
      // A photo of the song's first artist, when we have one (shown in place of cover art, which we don't have).
      const first = report.matchedAs[0]?.name;
      const image = first ? await artistImage(app.pool, trackFromName(first).artist) : null;
      return sendJson(res, 200, { ...(await withUserData(app, user, report, sets)), image });
    }
    case "GET /api/song/alongside": {
      // Every song played in the same sets, 15 a page; "specific" (default) or "count" order.
      const song = songParam(params);
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const sort = params.get("sort") === "count" ? "count" : "specific";
      let query;
      try {
        query = parseSongQuery(song);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      const all = playedAlongside(await app.catalog.all(), query, since, sort);
      const page = intParam(params, "page", 1);
      const size = pageSizeParam(params, 15);
      const slice = all.slice((page - 1) * size, page * size);
      const cards = await songCards(app.pool, slice.map((r) => r.name));
      return sendJson(res, 200, {
        items: slice.map((r, i) => ({ ...r, rank: (page - 1) * size + i + 1, image: cards.get(r.name)?.image ?? null, soundcloud: cards.get(r.name)?.soundcloud ?? null })),
        page,
        pageSize: size,
        total: all.length,
        pages: Math.max(1, Math.ceil(all.length / size)),
        sort,
      });
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
      const profile = artistProfile(sets, report.artist, app.since);
      const discovery = await discoveryForArtist(app.pool, profile.name, profile.page);
      return sendJson(res, 200, { ...report, profile, discovery });
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

    // ---- discovery: what DJs are playing ----
    case "GET /api/discovery": {
      const mode = discoveryMode(params);
      const scope = params.get("scope") ?? "all";
      let djIds: number[] | null = null;
      let scopeNotice: string | null = null;
      if (scope === "followed") {
        if (!user) scopeNotice = "Sign in and follow DJs to see what they're playing. Showing all DJs for now.";
        else {
          djIds = await followedIds(app.pool, user.id);
          if (!djIds.length) {
            scopeNotice = "You aren't following any DJs yet: follow some from the DJs page. Showing all DJs for now.";
            djIds = null;
          }
        }
      } else if (scope === "custom") {
        const names = (params.get("djs") ?? "").split(",").map((n) => n.trim()).filter(Boolean).slice(0, 50);
        const ids = (await Promise.all(names.map((n) => resolveArtist(app.pool, n)))).filter((id): id is number => id !== undefined);
        djIds = [...new Set(ids)];
        if (!djIds.length) {
          scopeNotice = names.length ? "None of those DJs are indexed. Showing all DJs." : "Pick some DJs. Showing all DJs for now.";
          djIds = null;
        }
      }
      const result = await discover(app.pool, { ...discoveryParams(params, mode), djIds, pageSize: pageSizeParam(params, 15) });
      return sendJson(res, 200, { ...result, notice: scopeNotice ?? result.notice, scope: djIds ? scope : "all" });
    }
    case "GET /api/djs": {
      const following = params.get("following") === "1";
      if (following && !user) return sendJson(res, 200, { items: [], page: 1, pageSize: 24, total: 0, pages: 1 });
      const onlyIds = following && user ? await followedIds(app.pool, user.id) : undefined;
      if (onlyIds && !onlyIds.length) return sendJson(res, 200, { items: [], page: 1, pageSize: 24, total: 0, pages: 1 });
      const options: Parameters<typeof listDjs>[1] = { page: intParam(params, "page", 1), pageSize: pageSizeParam(params, 24) };
      const q = params.get("q")?.trim();
      if (q) options.q = q;
      if (onlyIds) options.onlyIds = onlyIds;
      if (user) options.userId = user.id;
      return sendJson(res, 200, await listDjs(app.pool, options));
    }
    case "POST /api/follow": {
      requireOwnHeader(req);
      const u = needUser("follow DJs");
      const body = (await readJson(req)) as { dj?: unknown; on?: unknown };
      if (typeof body.dj !== "string" || typeof body.on !== "boolean") throw new BadRequest("Expected { dj, on }");
      const id = await resolveArtist(app.pool, body.dj);
      if (id === undefined) throw new BadRequest(`"${body.dj}" isn't indexed.`);
      await setFollow(app.pool, u.id, id, body.on);
      return sendJson(res, 200, { following: body.on });
    }
    case "GET /api/dj": {
      const id = await artistParam(app, params);
      const profile = await djProfile(app.pool, id, user?.id);
      const pages = await gatherPages(app, id, profile.page);
      return sendJson(res, 200, { ...profile, waiting: await app.queue.waitingFrom(pages), discovery: await discoveryForArtist(app.pool, profile.name, profile.page ?? undefined) });
    }
    case "GET /api/dj/selections": {
      const id = await artistParam(app, params);
      const mode = discoveryMode(params);
      return sendJson(res, 200, await discover(app.pool, { ...discoveryParams(params, mode), djIds: [id], pageSize: pageSizeParam(params, 15) }));
    }
    case "GET /api/dj/own":
      return sendJson(res, 200, await ownTracks(app.pool, await artistParam(app, params), intParam(params, "page", 1), pageSizeParam(params, 15)));
    case "GET /api/dj/ids":
      return sendJson(res, 200, await idLines(app.pool, await artistParam(app, params), intParam(params, "page", 1), pageSizeParam(params, 15), user?.id));
    case "POST /api/gather/stop": {
      requireOwnHeader(req);
      const stopper = needUser("stop gathering");
      // The owner stops everyone's gathering for this DJ; others stop only their own.
      const onlyFor = (await app.accounts.isOwner(stopper.id)) ? undefined : stopper.id;
      const body = (await readJson(req)) as { dj?: unknown };
      if (typeof body.dj !== "string") throw new BadRequest("Expected { dj }");
      const id = await resolveArtist(app.pool, body.dj);
      if (id === undefined) throw new BadRequest(`"${body.dj}" isn't indexed.`);
      const profile = await djProfile(app.pool, id);
      return sendJson(res, 200, { stopped: await app.queue.stopGathering(await gatherPages(app, id, profile.page), onlyFor) });
    }
    case "GET /api/vault": {
      const u = needUser("see your Vault");
      return sendJson(res, 200, await app.vault.list(u.id));
    }
    case "POST /api/vault": {
      requireOwnHeader(req);
      const u = needUser("save IDs to your Vault");
      const body = (await readJson(req)) as { set?: unknown; position?: unknown; on?: unknown };
      if (typeof body.set !== "string" || !Number.isInteger(body.position) || typeof body.on !== "boolean") throw new BadRequest("Expected { set, position, on }");
      await userAction(() => app.vault.setSaved(u.id, body.set as string, body.position as number, body.on as boolean));
      return sendJson(res, 200, { saved: body.on });
    }

    // ---- browsing (charts by performance date, sets, search) ----
    case "GET /api/charts/songs":
      return sendJson(res, 200, await songChart(app.pool, { ...chartParams(params), pageSize: pageSizeParam(params, 25) }));
    case "GET /api/charts/artists":
      return sendJson(res, 200, await artistChart(app.pool, { ...chartParams(params), pageSize: pageSizeParam(params, 24), withPhoto: params.get("photo") === "1" }));
    case "GET /api/sets": {
      const year = params.get("year") ? intParam(params, "year", 0) : undefined;
      const query: Parameters<typeof listSets>[1] = { page: intParam(params, "page", 1), pageSize: pageSizeParam(params, 24) };
      const q = params.get("q")?.trim();
      const dj = params.get("dj")?.trim();
      if (q) query.q = q;
      if (dj) query.dj = dj;
      if (year) query.year = year;
      return sendJson(res, 200, await listSets(app.pool, query, normalizeName));
    }
    case "GET /api/set": {
      const set = await setDetail(app.pool, required(params, "id"));
      if (!set) return sendJson(res, 404, { error: "That set isn't indexed." });
      return sendJson(res, 200, set);
    }
    case "GET /api/genres":
      return sendJson(res, 200, await genres(app.pool));
    case "GET /api/vault-preview":
      return sendJson(res, 200, await idStats(app.pool));
    case "GET /api/search": {
      // One box for everything: songs, artists and sets (IDs join when the Vault arrives).
      const q = required(params, "q");
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const all = await app.catalog.all();
      const sets = await listSets(app.pool, { q, page: 1, pageSize: 6 }, normalizeName);
      return sendJson(res, 200, { songs: searchSongs(all, q, since, 8), artists: searchArtists(all, q, since, 8), sets: sets.items, setsTotal: sets.total });
    }

    // ---- your data (needs login) ----
    case "GET /api/me": {
      if (!user) return sendJson(res, 200, { likes: [], categories: [], following: 0 });
      const { likes, categories } = await app.userData.get(user.id);
      return sendJson(res, 200, {
        likes: Object.values(likes),
        categories: Object.values(categories).map((c) => ({ name: c.name, songs: Object.values(c.songs) })),
        following: (await followedIds(app.pool, user.id)).length,
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
      if (!user) return sendJson(res, 200, { likes: [], likedSongs: [], sets: [], songs: [] });
      const mine = await app.userData.get(user.id);
      const liked = new Set(Object.keys(mine.likes));
      const sets = await app.catalog.all();
      const forYou = setsForYou(sets, liked, since, 8);
      const cards = await setCardsByIds(app.pool, forYou.map((s) => s.id));
      const likes = Object.values(mine.likes).reverse(); // newest first
      return sendJson(res, 200, {
        likes,
        likedSongs: await cardsFor(app, likes),
        // Sets that play the most of your liked songs, with photos: the page features one at a time.
        sets: forYou.map((s) => ({ ...(cards.get(s.id) ?? s), liked: s.liked })),
        songs: songsLike(sets, liked, since),
      });
    }
    case "GET /api/discover": {
      // Songs you might like, shuffled so it isn't the same best-known songs every time.
      // Without likes (or not signed in): what's being played most this month.
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const genre = params.get("genre")?.trim() ?? "";
      const page = intParam(params, "page", 1);
      const size = Math.min(intParam(params, "size", 24), 60);
      const seed = intParam(params, "seed", 1);
      const sets = await app.catalog.all();
      const mine = user ? await app.userData.get(user.id) : undefined;
      const liked = new Set(Object.keys(mine?.likes ?? {}));
      let names: { name: string; reason: string }[] = [];
      if (liked.size) {
        names = songsLike(sets, liked, since, { limit: 200 }).map((r) => ({ name: r.name, reason: `Played alongside your likes in ${plural(r.count, "set")}` }));
      }
      const personal = names.length >= 12;
      if (!personal) {
        const chart = await songChart(app.pool, { period: "month", page: 1, pageSize: 200, today: today() });
        const have = new Set(names.map((n) => n.name));
        for (const row of chart.items) {
          const name = `${row.artist} - ${row.title}`;
          if (!have.has(name) && !liked.has(songKey(trackFromName(name)))) names.push({ name, reason: `In ${plural(row.sets, "set")} this month` });
        }
      }
      const cards = await songCards(app.pool, names.map((n) => n.name));
      const pool = names
        .map((n, rank) => ({ ...n, rank, card: cards.get(n.name) }))
        .filter((n) => n.card && (!genre || (genre.toLowerCase() === "unknown" ? !n.card.genre : n.card.genre?.toLowerCase() === genre.toLowerCase())));
      const shuffled = weightedShuffle(pool, seed);
      const start = (page - 1) * size;
      return sendJson(res, 200, {
        mode: personal ? "personal" : "trending",
        items: shuffled.slice(start, start + size).map((n) => ({ ...n.card!, reason: n.reason })),
        page,
        pageSize: size,
        total: shuffled.length,
        pages: Math.max(1, Math.ceil(shuffled.length / size)),
      });
    }
    case "GET /api/playlists": {
      const u = needUser("see your playlists");
      const { categories } = await app.userData.get(u.id);
      const saved = await app.links.saved(u.id);
      const lists = Object.entries(categories).map(([key, c]) => ({ key, name: c.name, songs: Object.values(c.songs), links: saved[key]?.links.length ?? 0 }));
      const cards = await songCards(app.pool, lists.flatMap((l) => l.songs.slice(0, 12)));
      return sendJson(res, 200, lists.map((l) => ({
        name: l.name,
        count: l.songs.length + l.links,
        // Up to four different artist photos from its songs, for the cover.
        cover: [...new Set(l.songs.map((s) => cards.get(s)?.image).filter((i): i is string => Boolean(i)))].slice(0, 4),
      })));
    }
    case "POST /api/playlists": {
      requireOwnHeader(req);
      const u = needUser("make playlists");
      const body = (await readJson(req)) as { name?: unknown };
      if (typeof body.name !== "string") throw new BadRequest("Expected { name }");
      let name = "";
      await userAction(async () => void (name = await app.userData.createPlaylist(u.id, body.name as string)));
      return sendJson(res, 200, { name });
    }
    case "POST /api/playlists/delete": {
      requireOwnHeader(req);
      const u = needUser("delete playlists");
      const body = (await readJson(req)) as { name?: unknown };
      if (typeof body.name !== "string") throw new BadRequest("Expected { name }");
      return sendJson(res, 200, { deleted: await app.userData.deletePlaylist(u.id, body.name) });
    }
    case "GET /api/category": // the old name for playlists
    case "GET /api/playlist": {
      const u = needUser("see your playlists");
      const name = required(params, "name");
      const playlist = (await app.userData.get(u.id)).categories[normalizeName(name)];
      if (!playlist) return sendJson(res, 404, { error: `No playlist called "${name}"` });
      const since = sinceMonths(intParam(params, "months", DEFAULT_MONTHS));
      const members = new Set(Object.keys(playlist.songs));
      const links = (await app.links.saved(u.id))[normalizeName(name)]?.links ?? [];
      const songs = Object.values(playlist.songs);
      const suggestions = members.size ? songsLike(await app.catalog.all(), members, since, { limit: 12 }) : [];
      return sendJson(res, 200, {
        name: playlist.name,
        songs,
        songCards: await cardsFor(app, songs),
        links,
        suggestions,
        suggestionCards: await cardsFor(app, suggestions.map((s) => s.name)),
      });
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
        soundcloud: app.soundcloud.configured(),
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
    case "POST /api/account/soundcloud": {
      requireOwnHeader(req);
      await needOwner("connect SoundCloud");
      const body = (await readJson(req)) as { clientId?: unknown; clientSecret?: unknown };
      if (typeof body.clientId !== "string" || typeof body.clientSecret !== "string") throw new BadRequest("Expected { clientId, clientSecret }");
      const clientId = body.clientId.trim();
      const clientSecret = body.clientSecret.trim();
      if (Boolean(clientId) !== Boolean(clientSecret)) throw new BadRequest("Enter both the client ID and the client secret (or neither, to disconnect).");
      if (clientId && (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId) || !/^[A-Za-z0-9_-]{8,128}$/.test(clientSecret))) {
        throw new BadRequest("Those don't look like SoundCloud app credentials.");
      }
      app.soundcloud.setCredentials(clientId || undefined, clientSecret || undefined);
      // The secret stays on this machine (data/, readable only by you) and is never sent back to the page.
      if (app.soundcloudFile) writeFileSync(app.soundcloudFile, clientId ? JSON.stringify({ clientId, clientSecret }) : "{}", { mode: 0o600 });
      return sendJson(res, 200, { soundcloud: app.soundcloud.configured() });
    }
    case "POST /api/background": {
      requireOwnHeader(req);
      await needOwner("turn background collecting on or off");
      const body = (await readJson(req)) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") throw new BadRequest("Expected { enabled: boolean }");
      if (!app.background) throw new BadRequest("Background collecting isn't available here.");
      app.background.setEnabled(body.enabled);
      return sendJson(res, 200, await app.background.status());
    }

    // ---- SoundCloud ----
    case "GET /api/song-links": {
      const song = songParam(params);
      const viewer = user ? { id: user.id, owner: await app.accounts.isOwner(user.id) } : undefined;
      return sendJson(res, 200, { links: await app.links.forSong(song, viewer), soundcloud: app.soundcloud.configured() });
    }
    case "GET /api/play": {
      // Play any song: its confirmed link, an earlier automatic match, or (if SoundCloud is
      // connected) the best "this song" match from a search, which is then remembered.
      const song = songParam(params);
      let trackId: number;
      try {
        trackId = await findTrackId(app.pool, song);
      } catch (error) {
        if (error instanceof UserDataError) throw new BadRequest(error.message);
        throw error;
      }
      const known = await app.links.playable(trackId);
      if (known) return sendJson(res, 200, known);
      if (!app.soundcloud.configured()) return sendJson(res, 404, { error: "Connect SoundCloud (Account → SoundCloud app) to play songs that haven't been linked yet." });
      const missUntil = app.noMatch.get(trackId);
      if (missUntil && missUntil > Date.now()) return sendJson(res, 404, { error: `Couldn't find “${song}” on SoundCloud.` });
      if (!app.soundcloudLimit.take(user ? `user:${user.id}` : `addr:${req.socket.remoteAddress ?? "?"}`)) {
        throw new NotAllowed("That's a lot of SoundCloud searches in a short time. Wait a few minutes and try again.", 429);
      }
      const track = trackFromName(song);
      const page = await app.soundcloud.searchTracks({ q: searchWords(`${track.artist} ${track.title}`), limit: 30 });
      const usable = songCandidates(track, page.items).filter((c) => c.kind === "this" && c.confidence >= 0.75 && c.track.embeddable && c.track.access !== "blocked");
      const best = usable.find((c) => c.track.access === "playable") ?? usable[0];
      if (!best) {
        app.noMatch.set(trackId, Date.now() + 24 * 60 * 60_000);
        return sendJson(res, 404, { error: `Couldn't find a playable upload of “${song}” on SoundCloud.` });
      }
      await app.links.saveAutoMatch(trackId, { url: best.track.permalink, externalId: best.track.urn, confidence: best.confidence });
      return sendJson(res, 200, { url: best.track.permalink, auto: true, confidence: best.confidence, preview: best.track.access === "preview" });
    }
    case "POST /api/song-links": {
      requireOwnHeader(req);
      const u = needUser("link songs to SoundCloud");
      const body = (await readJson(req)) as { song?: unknown; url?: unknown; from?: unknown };
      if (typeof body.song !== "string" || typeof body.url !== "string" || (body.from !== "search" && body.from !== "pasted")) {
        throw new BadRequest('Expected { song, url, from: "search" | "pasted" }');
      }
      if (!isTrackLink(body.url)) throw new BadRequest("That isn't a SoundCloud track link (https://soundcloud.com/artist/track).");
      limitSoundCloud(app, u);
      // Look the link up so we store SoundCloud's own id and a real link, never something made up.
      const found = await app.soundcloud.resolve(body.url);
      if (found.kind !== "track") throw new BadRequest("That link is a profile, not a track.");
      const song = body.song;
      const match = classify(trackFromName(song), found.track);
      await userAction(() =>
        app.links.addSongLink(u.id, song, {
          url: found.track.permalink || body.url as string,
          externalId: found.track.urn,
          confidence: body.from === "pasted" ? 1 : (match?.confidence ?? 0.2),
          provenance: body.from === "pasted" ? "user" : "search_match",
        }),
      );
      return sendJson(res, 200, { links: await app.links.forSong(song, { id: u.id, owner: await app.accounts.isOwner(u.id) }), track: found.track, match: match?.kind ?? null });
    }
    case "POST /api/song-links/remove": {
      requireOwnHeader(req);
      const u = needUser("remove song links");
      const body = (await readJson(req)) as { song?: unknown; url?: unknown };
      if (typeof body.song !== "string" || typeof body.url !== "string") throw new BadRequest("Expected { song, url }");
      const viewer = { id: u.id, owner: await app.accounts.isOwner(u.id) };
      const song = body.song;
      const url = body.url;
      let removed = false;
      await userAction(async () => void (removed = await app.links.removeSongLink(viewer, song, url)));
      if (!removed) throw new NotAllowed("Only whoever added a link (or the site owner) can remove it.", 403);
      return sendJson(res, 200, { links: await app.links.forSong(song, viewer) });
    }
    case "GET /api/soundcloud/candidates": {
      const u = needUser("search SoundCloud");
      const song = songParam(params);
      limitSoundCloud(app, u);
      const track = trackFromName(song);
      const page = await app.soundcloud.searchTracks({ q: searchWords(`${track.artist} ${track.title}`), limit: 50 });
      return sendJson(res, 200, { candidates: songCandidates(track, page.items).slice(0, 20).map(candidateJson) });
    }
    case "GET /api/soundcloud/remixes": {
      const u = needUser("search SoundCloud");
      const song = songParam(params);
      limitSoundCloud(app, u);
      const track = trackFromName(song);
      const genres = (params.get("genres") ?? "").split(",").map((g) => g.trim()).filter(Boolean).slice(0, 10);
      // "Unknown" (no genre tag) can't be asked of SoundCloud, so then we filter here instead.
      const askGenres = genres.length && !genres.some((g) => g.toLowerCase() === "unknown") ? genres : undefined;
      const searchOptions: { q: string; limit: number; genres?: string[]; cursor?: string } = { q: searchWords(`${track.artist} ${versionOf(track.title).base}`), limit: 100 };
      if (askGenres) searchOptions.genres = askGenres;
      const cursor = params.get("cursor");
      if (cursor) searchOptions.cursor = cursor;
      const page = await app.soundcloud.searchTracks(searchOptions);
      const filters: { remixer?: string; genres?: string[] } = {};
      const remixer = params.get("remixer")?.trim();
      if (remixer) filters.remixer = remixer;
      if (genres.length) filters.genres = genres;
      return sendJson(res, 200, { remixes: remixesOf(track, page.items, filters).map(candidateJson), next: page.next ?? null, scanned: page.items.length });
    }
    case "GET /api/soundcloud/likes": {
      const u = needUser("browse SoundCloud likes");
      const profile = required(params, "profile");
      limitSoundCloud(app, u);
      if (!app.likesLimit.take("site")) throw new NotAllowed("SoundCloud only allows a limited number of likes lookups a day, and today's are used up. Try again tomorrow.", 429);
      const curator = await app.soundcloud.user(profile);
      const page = await app.soundcloud.userLikes(curator.urn, params.get("cursor") ?? undefined);
      return sendJson(res, 200, { user: curator, tracks: page.items.map(trackJson), next: page.next ?? null });
    }
    case "POST /api/saved-link": {
      requireOwnHeader(req);
      const u = needUser("save SoundCloud tracks");
      const body = (await readJson(req)) as { category?: unknown; url?: unknown; on?: unknown };
      if (typeof body.category !== "string" || typeof body.url !== "string" || typeof body.on !== "boolean") {
        throw new BadRequest("Expected { category, url, on }");
      }
      if (!isTrackLink(body.url)) throw new BadRequest("That isn't a SoundCloud track link.");
      const { category, url, on } = body as { category: string; url: string; on: boolean };
      let saved = { url, title: "", artist: "" };
      if (on) {
        // Title and uploader as SoundCloud shows them, looked up rather than taken from the page.
        limitSoundCloud(app, u);
        const found = await app.soundcloud.resolve(url);
        if (found.kind !== "track") throw new BadRequest("That link is a profile, not a track.");
        saved = { url: found.track.permalink || url, title: found.track.title, artist: found.track.uploader };
      }
      await userAction(() => app.links.setSaved(u.id, category, saved, on));
      return sendJson(res, 200, { ok: true });
    }

    // ---- collecting ----
    case "GET /api/status":
      return sendJson(res, 200, {
        sets: await app.catalog.count(),
        since: app.since,
        queue: await app.queue.status(),
        background: await app.background?.status(),
      });
    case "POST /api/capture-token": {
      // A short-lived key the page hands the extension, so a capture sent from someone
      // else's computer (through a shared link) counts as theirs.
      requireOwnHeader(req);
      const u = needUser("gather sets");
      const key = randomBytes(24).toString("base64url");
      const expires = Date.now() + CAPTURE_TOKEN_MS;
      app.captureTokens.set(key, { userId: u.id, expires });
      for (const [k, t] of app.captureTokens) if (t.expires < Date.now()) app.captureTokens.delete(k);
      return sendJson(res, 200, { token: key, expires: new Date(expires).toISOString() });
    }
    case "POST /api/capture": {
      // From the browser extension (which may not carry your login). It only acts on a
      // page you opened yourself, so from this computer there's no cap and no date window:
      // every set on the page is queued, newest first. From anyone else (a shared link),
      // it needs their capture key, and a friend's gather is capped.
      requireOwnHeader(req);
      const body = (await readJson(req, 5_000_000)) as { pageUrl?: unknown; urls?: unknown; complete?: unknown; limit?: unknown; token?: unknown };
      const who = await captureUser(app, req, user, body.token);
      if (!Array.isArray(body.urls)) throw new BadRequest("Expected { urls: string[] }");
      if (body.urls.length > 20_000) throw new BadRequest("Too many links in one capture.");
      const urls = [...new Set(body.urls.filter((u): u is string => typeof u === "string" && isFetchAllowed(u)))];
      // Remember how far gathering got on this DJ/track page, for "last gathered" on artist pages.
      const page = typeof body.pageUrl === "string" && /^https:\/\/(www\.)?1001tracklists\.com\/(artist|dj|track|source)\//.test(body.pageUrl) ? body.pageUrl : undefined;
      // "Gather the newest N" from a DJ page: a bound you chose; without one, every set is queued.
      let limit = typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : undefined;
      if (!who.trusted) limit = Math.min(limit ?? FRIEND_GATHER_MAX, FRIEND_GATHER_MAX);
      const options: { requestedBy?: number; page?: string; limit?: number } = {};
      if (who.user) options.requestedBy = who.user.id;
      if (page) options.page = canonicalPage(page);
      if (limit) options.limit = limit;
      const result = await app.queue.enqueue(urls, ALL_TIME, options);
      const discovery = page ? await recordDiscovery(app.pool, page, { found: urls.length, ...result, complete: body.complete === true }) : undefined;
      console.log(`Captured ${urls.length} sets from ${page ? canonicalPage(page) : "a page"}${who.user ? ` for ${who.user.displayName}` : ""}: ${result.queued} new, ${result.alreadyCached} already in setscope.`);
      return sendJson(res, 200, { found: urls.length, ...result, discovery });
    }
    case "POST /api/capture-set": {
      // A set page someone opened themselves: no limit from this computer; from a shared
      // link it needs their capture key (and is rate-limited like other requests).
      requireOwnHeader(req);
      const body = (await readJson(req, 10_000_000)) as { pageUrl?: unknown; html?: unknown; token?: unknown };
      await captureUser(app, req, user, body.token);
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
      const u = needUser("add sets");
      limitCaptures(app, req, u);
      const body = (await readJson(req)) as { text?: unknown };
      if (typeof body.text !== "string") throw new BadRequest("Expected { text: string }");
      const urls = extractTracklistUrls(body.text).filter(isFetchAllowed).slice(0, 400);
      if (urls.length === 0) throw new BadRequest("No 1001Tracklists set links found in that text.");
      // Links you chose yourself: no date window.
      return sendJson(res, 200, { found: urls.length, ...(await app.queue.enqueue(urls, ALL_TIME, { requestedBy: u.id })) });
    }
    case "POST /api/refresh-set": {
      requireOwnHeader(req);
      const u = needUser("refresh sets");
      limitCaptures(app, req, u);
      const body = (await readJson(req)) as { url?: unknown };
      if (typeof body.url !== "string" || !isFetchAllowed(body.url)) throw new BadRequest("Expected { url } of a 1001Tracklists set");
      // Someone asked: ahead of scheduled refreshes, behind new sets.
      return sendJson(res, 200, { queued: await app.queue.enqueueRefresh([body.url], { requestedBy: u.id, priority: -1 }) });
    }
    case "POST /api/include-older":
      requireOwnHeader(req);
      needUser("control the queue");
      return sendJson(res, 200, { moved: await app.queue.includeOlder() });
    case "POST /api/retry-failed":
      requireOwnHeader(req);
      needUser("control the queue");
      return sendJson(res, 200, { retried: await app.queue.retryFailed() });
    case "POST /api/clear-queue":
      // Everyone's waiting sets: the owner's call.
      requireOwnHeader(req);
      await needOwner("clear everyone's queue");
      return sendJson(res, 200, await app.queue.clearQueue());
    case "POST /api/resume":
      requireOwnHeader(req);
      needUser("control the queue");
      await app.queue.resume();
      return sendJson(res, 200, await app.queue.status());
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

/**
 * The extension version in this project's extension/ folder. Chrome keeps running the
 * copy it loaded until you press reload, so the page compares the two.
 */
function extensionVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "extension", "manifest.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function artistImage(pool: pg.Pool, artistText: string): Promise<string | null> {
  const names = splitArtists(artistText).map(normalizeName);
  if (!names.length) return null;
  const r = await pool.query<{ image_url: string }>(
    "select image_url from artists where name_key = any($1) and image_url is not null order by array_position($1, name_key) limit 1",
    [names],
  );
  return r.rows[0]?.image_url ?? null;
}

/** Song cards for names, in the same order (a name we can't find gets a bare card). */
async function cardsFor(app: App, names: string[]): Promise<SongCard[]> {
  const cards = await songCards(app.pool, names);
  return names.map((name) => {
    const card = cards.get(name);
    if (card) return card;
    const t = trackFromName(name);
    return { name, artist: t.artist, title: t.title, genre: null, image: null, soundcloud: null };
  });
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * A shuffle that still favors the best matches: each item gets a random key weighted by
 * its rank (Efraimidis-Spirakis), from a seed so paging through one shuffle is stable.
 */
function weightedShuffle<T extends { rank: number }>(items: T[], seed: number): T[] {
  let state = (seed >>> 0) || 1;
  const random = () => {
    // xorshift32: small, fast, and the same sequence for the same seed.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000 + 1e-9;
  };
  return items
    .map((item) => ({ item, key: Math.pow(random(), 1 / (1 / Math.sqrt(item.rank + 1))) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

function discoveryMode(params: URLSearchParams): DiscoveryMode {
  const mode = (params.get("mode") ?? "now") as DiscoveryMode;
  if (!MODES.includes(mode)) throw new BadRequest(`"mode" must be one of ${MODES.join(", ")}`);
  return mode;
}

/** Period, genre, page and today for a discovery query; each mode has its own default period. */
function discoveryParams(params: URLSearchParams, mode: DiscoveryMode): { mode: DiscoveryMode; period: Period; genre?: string; page: number; today: string } {
  const fallback: Record<DiscoveryMode, Period> = { now: "month", most: "3months", deep: "year", intro: "year", closer: "year" };
  const period = (params.get("period") || fallback[mode]) as Period;
  if (!PERIODS.includes(period)) throw new BadRequest(`"period" must be one of ${PERIODS.join(", ")}`);
  const out: { mode: DiscoveryMode; period: Period; genre?: string; page: number; today: string } = { mode, period, page: intParam(params, "page", 1), today: today() };
  const genre = params.get("genre")?.trim();
  if (genre) out.genre = genre;
  return out;
}

/** The artist named by ?name= (an alias gives the artist it belongs to). */
async function artistParam(app: App, params: URLSearchParams): Promise<number> {
  const name = required(params, "name");
  const id = await resolveArtist(app.pool, name);
  if (id === undefined) throw new NotAllowed(`"${name}" isn't in the indexed sets yet.`, 404);
  return id;
}

/** The 1001Tracklists pages a DJ's sets were gathered from (any of their names). */
async function gatherPages(app: App, artistId: number, page: string | null): Promise<string[]> {
  const r = await app.pool.query<{ page_url: string }>(
    `select page_url from discovery_progress where artist_id = $1 or artist_id in (select artist_id from artist_aliases where canonical_id = $1)`,
    [artistId],
  );
  return [...new Set([...r.rows.map((x) => x.page_url), ...(page ? [canonicalPage(page)] : [])])];
}

function chartParams(params: URLSearchParams): { period: Period; genre?: string; q?: string; page: number; today: string } {
  const period = (params.get("period") ?? "month") as Period;
  if (!PERIODS.includes(period)) throw new BadRequest(`"period" must be one of ${PERIODS.join(", ")}`);
  const out: { period: Period; genre?: string; q?: string; page: number; today: string } = { period, page: intParam(params, "page", 1), today: today() };
  const genre = params.get("genre")?.trim();
  const q = params.get("q")?.trim();
  if (genre) out.genre = genre;
  if (q) out.q = q;
  return out;
}

function pageSizeParam(params: URLSearchParams, fallback: number): number {
  return Math.min(intParam(params, "size", fallback), 100);
}

/**
 * Straight from this computer (not through a tunnel or proxy, which add forwarding
 * headers): the person running setscope.
 */
function fromThisComputer(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  return loopback && !req.headers["x-forwarded-for"] && !req.headers["cf-connecting-ip"] && !req.headers["forwarded"];
}

/**
 * Who a capture is from. From this computer it's trusted as before (a key, if sent,
 * says which account). From anywhere else a valid capture key is required, and the
 * usual rate limit applies; the owner's key is trusted like this computer.
 */
async function captureUser(app: App, req: IncomingMessage, cookieUser: User | undefined, token: unknown): Promise<{ user?: User; trusted: boolean }> {
  const entry = typeof token === "string" ? app.captureTokens.get(token) : undefined;
  const tokenUser = entry && entry.expires > Date.now() ? await app.accounts.userById(entry.userId) : undefined;
  const user = tokenUser ?? cookieUser;
  if (fromThisComputer(req)) return user ? { user, trusted: true } : { trusted: true };
  if (!user) throw new NotAllowed("Sign in on setscope (and reload the page) before gathering sets, so they're added under your account.", 401);
  limitCaptures(app, req, user);
  return { user, trusted: await app.accounts.isOwner(user.id) };
}

/** "Artist - Title" from ?song=. */
function songParam(params: URLSearchParams): string {
  const song = required(params, "song");
  if (!song.includes(" - ")) throw new BadRequest('Expected "Artist - Title"');
  return song;
}

/** Search words from a song name: brackets and punctuation SoundCloud's search doesn't need. */
function searchWords(text: string): string {
  return text.replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function limitSoundCloud(app: App, user: User): void {
  if (!app.soundcloudLimit.take(`user:${user.id}`)) throw new NotAllowed("That's a lot of SoundCloud searches in a short time. Wait a few minutes and try again.", 429);
}

/** What the page needs about an upload (SoundCloud's own fields, as SoundCloud gave them). */
function trackJson(t: ScTrack) {
  return {
    urn: t.urn,
    title: t.title,
    uploader: t.uploader,
    uploaderUrl: t.uploaderUrl,
    url: t.permalink,
    genre: t.genre ?? null,
    durationMs: t.durationMs,
    plays: t.plays ?? null,
    likes: t.likes ?? null,
    access: t.access,
    embeddable: t.embeddable,
    artwork: t.artwork ?? null,
    createdAt: t.createdAt ?? null,
  };
}

function candidateJson(c: Candidate) {
  return { ...trackJson(c.track), kind: c.kind, confidence: c.confidence, reason: c.reason, versionType: c.read.versionType, versionArtists: c.read.versionArtists ?? null };
}

/** At most 30 pasted lists / refresh requests per 10 minutes per account (or address). */
function limitCaptures(app: App, req: IncomingMessage, user: User | undefined): void {
  const key = user ? `user:${user.id}` : `addr:${req.socket.remoteAddress ?? "?"}`;
  if (!app.captureLimit.take(key)) throw new NotAllowed("That's a lot of requests in a short time. Wait a few minutes and try again.", 429);
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

/** A browser module from web/, with its TypeScript types stripped. */
function sendScript(res: ServerResponse, file: string): void {
  const source = readFileSync(join(WEB_DIR, file), "utf8");
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
  res.end(stripTypeScriptTypes(source));
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
  const recredited = await catalog.rebuildCreditsIfOutdated();
  if (recredited) console.log(`Re-derived artist credits for ${recredited} tracks with the current rules.`);
  const reparsed = await catalog.reparseOutdated();
  if (reparsed) console.log(`Re-read ${reparsed} sets with the newer parser.`);

  const fetcher = new PoliteFetcher({ stateFile: join(dir, "last-request") });
  const queue = new PgJobQueue(pool, catalog, fetcher);
  // The old file queue (data/queue.json), if any, joins the database queue once.
  const legacyQueue = join(dir, "queue.json");
  if (existsSync(legacyQueue)) {
    const saved = JSON.parse(readFileSync(legacyQueue, "utf8")) as string[] | { waiting?: string[]; found?: string[]; older?: string[] };
    const lists = Array.isArray(saved) ? { waiting: saved } : saved;
    // Not started: recover() below pauses the queue, so nothing is fetched until someone says so.
    const result = await queue.enqueue([...(lists.waiting ?? []), ...(lists.found ?? []), ...(lists.older ?? [])], sinceMonths(), { start: false });
    renameSync(legacyQueue, `${legacyQueue}.imported`);
    console.log(`Moved the old file queue into the database: ${result.queued} waiting, ${result.skippedOld} older.`);
  }
  await queue.recover();
  // GetSongBPM key: SETSCOPE_GETSONGBPM_KEY, or the file data/getsongbpm-key (kept out of git with data/).
  const keyFile = join(dir, "getsongbpm-key");
  const apiKey = process.env.SETSCOPE_GETSONGBPM_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined);
  const songInfo = new SongInfoService(new SongInfoStore(join(dir, "songinfo.json")), { apiKey: apiKey || undefined, baseUrl: process.env.SETSCOPE_GETSONGBPM_URL });
  // SoundCloud app credentials: SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET, or data/soundcloud.json
  // (set from the Account page; kept out of git with data/).
  const soundcloudFile = join(dir, "soundcloud.json");
  const savedSc = existsSync(soundcloudFile) ? (JSON.parse(readFileSync(soundcloudFile, "utf8") || "{}") as { clientId?: string; clientSecret?: string }) : {};
  const soundcloud = new SoundCloudClient({
    clientId: process.env.SOUNDCLOUD_CLIENT_ID ?? savedSc.clientId,
    clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET ?? savedSc.clientSecret,
    tokenFile: join(dir, "soundcloud-token.json"),
  });
  const background = new BackgroundCollector(catalog, queue, fetcher, { saveFile: join(dir, "background.json"), since: () => sinceMonths() });
  setInterval(() => void background.tick(), 15_000);

  const app = createApp({ pool, catalog, queue, accounts: new Accounts(pool), userData: new PgUserData(pool) }, {
    songInfo,
    background,
    keyFile,
    legacyUserFile: join(dir, "user.json"),
    soundcloud,
    soundcloudFile,
    secureCookies: process.env.SETSCOPE_SECURE_COOKIES === "1",
  });
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`setscope is running at http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
    if (!apiKey) console.log("No GetSongBPM key yet: song pages won't show key/BPM. See README.");
    if (!soundcloud.configured()) console.log("SoundCloud isn't connected yet: song links and remix search are off. See README.");
  });
}
