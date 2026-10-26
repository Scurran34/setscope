// Key and BPM for a song, from GetSongBPM's free API (you register for a key; their
// terms require a visible link back to GetSongBPM.com, which the song page shows).
//
// Lookups are on demand: a song is looked up the first time its page is opened, then
// cached in data/songinfo.json for good. "Not found" is remembered for 30 days so we
// don't keep asking. Network errors are never cached.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { baseTitle, normalizeName, songKey, splitArtists, trackFromName } from "../normalize.ts";

export const DEFAULT_GETSONGBPM_URL = "https://api.getsong.co";
const NOT_FOUND_RETRY_DAYS = 30;
/** GetSongBPM allows 3000 calls an hour; one every 1.5s stays well under. */
const MIN_GAP_MS = 1_500;

export interface SongInfo {
  found: boolean;
  bpm?: number;
  /** e.g. "F#m" */
  key?: string;
  /** Open Key / Camelot-style notation, e.g. "4m" */
  openKey?: string;
  /** The song's page on GetSongBPM, for the credit link. */
  url?: string;
  fetchedAt: string;
}

export type SongInfoResult =
  | { status: "ok"; info: SongInfo }
  | { status: "not-found"; info: SongInfo }
  | { status: "no-key" }
  | { status: "error"; message: string };

export class SongInfoStore {
  private readonly file: string | undefined;
  private data: Record<string, SongInfo> = {};

  /** Without a file, nothing is saved (tests). */
  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8")) as Record<string, SongInfo>;
  }

  get(key: string): SongInfo | undefined {
    return this.data[key];
  }

  set(key: string, info: SongInfo): void {
    this.data[key] = info;
    if (this.file) writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

export interface LookupOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One search result, as much of it as we use. Fields are read defensively. */
interface Hit {
  title?: string;
  uri?: string;
  tempo?: string | number;
  key_of?: string;
  open_key?: string;
  artist?: { name?: string };
}

export class SongInfoService {
  private readonly store: SongInfoStore;
  private apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<SongInfoResult>>();
  /** Lookups run one at a time, at least MIN_GAP_MS apart. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastCallAt = Number.NEGATIVE_INFINITY;

  constructor(store: SongInfoStore, options: LookupOptions = {}) {
    this.store = store;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GETSONGBPM_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  /** Set or clear the API key (from the Account page). */
  setApiKey(key: string | undefined): void {
    this.apiKey = key?.trim() || undefined;
  }

  /** Key and BPM for "Artist - Title": from the cache, or one API call. */
  async info(song: string): Promise<SongInfoResult> {
    const track = trackFromName(song);
    const key = songKey(track);
    const cached = this.store.get(key);
    if (cached && (cached.found || this.now() - Date.parse(cached.fetchedAt) < NOT_FOUND_RETRY_DAYS * 86_400_000)) {
      return cached.found ? { status: "ok", info: cached } : { status: "not-found", info: cached };
    }
    if (!this.apiKey) return { status: "no-key" };

    // Opening the same song twice at once shouldn't cost two calls.
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const lookup = this.queue(() => this.lookup(track.artist, track.title)).then((result) => {
      if (result.status === "ok" || result.status === "not-found") this.store.set(key, result.info);
      return result;
    });
    this.inFlight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastCallAt + MIN_GAP_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = this.now();
      return task();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async lookup(artist: string, title: string): Promise<SongInfoResult> {
    const mainArtist = splitArtists(artist)[0] ?? artist;
    const url = new URL(`${this.baseUrl}/search/`);
    url.searchParams.set("api_key", this.apiKey!);
    url.searchParams.set("type", "both");
    url.searchParams.set("lookup", `song:${title.replace(/\s*\([^)]*\)\s*$/, "")} artist:${mainArtist}`);

    let body: unknown;
    try {
      const response = await this.fetchFn(url, { headers: { Accept: "application/json" } });
      if (response.status === 401 || response.status === 403) {
        return { status: "error", message: "GetSongBPM rejected the API key (check it, or their service may be blocking requests)." };
      }
      if (!response.ok) return { status: "error", message: `GetSongBPM answered HTTP ${response.status}.` };
      body = await response.json();
    } catch (error) {
      return { status: "error", message: `Couldn't reach GetSongBPM: ${error instanceof Error ? error.message : String(error)}` };
    }

    const fetchedAt = new Date(this.now()).toISOString();
    const hits = (body as { search?: unknown }).search;
    const hit = Array.isArray(hits) ? bestHit(hits as Hit[], artist, title) : undefined;
    if (!hit) return { status: "not-found", info: { found: false, fetchedAt } };

    const info: SongInfo = { found: true, fetchedAt };
    const bpm = Number(hit.tempo);
    if (Number.isFinite(bpm) && bpm > 0) info.bpm = Math.round(bpm);
    if (hit.key_of) info.key = hit.key_of;
    if (hit.open_key) info.openKey = hit.open_key;
    if (hit.uri) info.url = hit.uri;
    return { status: "ok", info };
  }
}

/** The result whose title and artist match ours; never just "the first result", which can be a different song. */
function bestHit(hits: Hit[], artist: string, title: string): Hit | undefined {
  const wantTitle = baseTitle(title.replace(/\s*\([^)]*\)\s*$/, ""));
  const ourArtists = new Set(splitArtists(artist).map(normalizeName));
  return hits.find(
    (h) =>
      h.title !== undefined &&
      baseTitle(h.title) === wantTitle &&
      splitArtists(h.artist?.name ?? "").some((a) => ourArtists.has(normalizeName(a))),
  );
}
