// SoundCloud's public API, with the app's own credentials (an Artist Pro account can
// register an app). Docs: https://developers.soundcloud.com/docs/api/guide
//
//   - Access tokens come from the client-credentials flow and are reused until they
//     expire, then refreshed (SoundCloud allows only 50 new tokens per 12 hours per app).
//     The current token is kept in a file so a restart doesn't use up another one.
//   - Responses are kept in memory for 10 minutes, then forgotten: SoundCloud's terms
//     don't allow storing their content, so nothing here is written to the database.
//   - "Next page" links from SoundCloud are only followed if they point at
//     api.soundcloud.com (so a crafted link can't make the server fetch anything else).
//   - 429 (rate limited) and auth failures come back as clear errors, never as "no results".

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://api.soundcloud.com";
const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
const CACHE_MS = 10 * 60_000;

/** A track as setscope uses it (a small, read-only view of SoundCloud's track object). */
export interface ScTrack {
  urn: string;
  title: string;
  /** The uploader's name. */
  uploader: string;
  uploaderUrl?: string;
  permalink: string;
  /** The uploader's own genre tag, if any (uploader-defined, often inconsistent). */
  genre?: string;
  tags: string[];
  durationMs: number;
  /** SoundCloud plays / likes: SoundCloud engagement, not DJ-set plays. */
  plays?: number;
  likes?: number;
  /** playable = full stream, preview = a snippet, blocked = can't be streamed here. */
  access: "playable" | "preview" | "blocked";
  /** Can SoundCloud's embedded player play it on other sites? */
  embeddable: boolean;
  artwork?: string;
  createdAt?: string;
  label?: string;
}

export interface ScUser {
  urn: string;
  username: string;
  permalink: string;
  avatar?: string;
  likesCount?: number;
  followers?: number;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page (a SoundCloud next_href), if there is one. */
  next?: string;
}

/** SoundCloud said slow down (429). */
export class ScRateLimited extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(retryAfterSeconds: number | undefined) {
    super(`SoundCloud's rate limit was reached${retryAfterSeconds ? `; try again in about ${Math.ceil(retryAfterSeconds / 60)} min` : ""}.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Missing or rejected credentials, a bad link, or another problem the person should see. */
export class ScError extends Error {}

interface Token {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface ClientOptions {
  clientId?: string;
  clientSecret?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Where the current access token is kept between restarts. */
  tokenFile?: string;
}

type RawTrack = {
  urn?: string;
  id?: number;
  title?: string;
  user?: { username?: string; permalink_url?: string; avatar_url?: string };
  permalink_url?: string;
  genre?: string | null;
  tag_list?: string | null;
  duration?: number;
  playback_count?: number | null;
  favoritings_count?: number | null;
  access?: string | null;
  embeddable_by?: string | null;
  artwork_url?: string | null;
  created_at?: string;
  label_name?: string | null;
  kind?: string;
};

export class SoundCloudClient {
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly tokenFile: string | undefined;
  private token: Token | undefined;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();

  constructor(options: ClientOptions = {}) {
    this.clientId = options.clientId?.trim() || undefined;
    this.clientSecret = options.clientSecret?.trim() || undefined;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.tokenFile = options.tokenFile;
    if (this.tokenFile && existsSync(this.tokenFile)) {
      try {
        this.token = JSON.parse(readFileSync(this.tokenFile, "utf8")) as Token;
      } catch {
        this.token = undefined;
      }
    }
  }

  configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** New credentials (from the Account page): forget the old token and cache. */
  setCredentials(clientId: string | undefined, clientSecret: string | undefined): void {
    this.clientId = clientId?.trim() || undefined;
    this.clientSecret = clientSecret?.trim() || undefined;
    this.token = undefined;
    this.cache.clear();
    if (this.tokenFile) writeFileSync(this.tokenFile, "{}");
  }

  /** Track search. `genres` filters by the uploader's genre tag. */
  async searchTracks(options: { q: string; genres?: string[]; limit?: number; cursor?: string; access?: string }): Promise<Page<ScTrack>> {
    const url = options.cursor
      ? this.checkedCursor(options.cursor)
      : withParams(`${API}/tracks`, {
          q: options.q,
          genres: options.genres?.length ? options.genres.join(",") : undefined,
          access: options.access ?? "playable,preview,blocked",
          limit: String(options.limit ?? 50),
          linked_partitioning: "true",
        });
    return this.trackPage(url);
  }

  /** A soundcloud.com link: a track or a user. */
  async resolve(link: string): Promise<{ kind: "track"; track: ScTrack } | { kind: "user"; user: ScUser }> {
    const url = new URL(link);
    if (!/(^|\.)soundcloud\.com$/.test(url.hostname) || url.protocol !== "https:") throw new ScError("That isn't a soundcloud.com link.");
    const raw = (await this.get(withParams(`${API}/resolve`, { url: `https://${url.hostname}${url.pathname}` }))) as RawTrack & { kind?: string; username?: string };
    if (raw.kind === "user") return { kind: "user", user: toUser(raw as unknown as Record<string, unknown>) };
    if (raw.kind === "track") return { kind: "track", track: toTrack(raw) };
    throw new ScError("That link isn't a SoundCloud track or profile.");
  }

  /** A user by profile name, e.g. "chrisstussy" (from soundcloud.com/chrisstussy). */
  async user(nameOrLink: string): Promise<ScUser> {
    const link = /^https?:\/\//.test(nameOrLink) ? nameOrLink : `https://soundcloud.com/${encodeURIComponent(nameOrLink.trim().replace(/^@/, ""))}`;
    const found = await this.resolve(link);
    if (found.kind !== "user") throw new ScError("That link is a track, not a profile.");
    return found.user;
  }

  /** The tracks a user has liked, newest first, when their likes are public. */
  async userLikes(userUrn: string, cursor?: string): Promise<Page<ScTrack>> {
    if (!/^soundcloud:users:\d+$/.test(userUrn)) throw new ScError("Not a SoundCloud user.");
    const url = cursor
      ? this.checkedCursor(cursor)
      : withParams(`${API}/users/${encodeURIComponent(userUrn)}/likes/tracks`, { access: "playable,preview,blocked", limit: "50", linked_partitioning: "true" });
    return this.trackPage(url);
  }

  // ---------- plumbing ----------

  private async trackPage(url: string): Promise<Page<ScTrack>> {
    const raw = (await this.get(url)) as { collection?: RawTrack[]; next_href?: string | null } | RawTrack[];
    const list = Array.isArray(raw) ? raw : (raw.collection ?? []);
    const page: Page<ScTrack> = { items: list.filter((t) => t && (t.kind === undefined || t.kind === "track")).map(toTrack) };
    const next = Array.isArray(raw) ? undefined : raw.next_href;
    if (next) page.next = next;
    return page;
  }

  /** Only follow SoundCloud's own API pagination links. */
  private checkedCursor(cursor: string): string {
    let url: URL;
    try {
      url = new URL(cursor);
    } catch {
      throw new ScError("Bad page link.");
    }
    if (url.protocol !== "https:" || url.hostname !== "api.soundcloud.com") throw new ScError("Bad page link.");
    return url.href;
  }

  private async get(url: string, retried = false): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > this.now()) return cached.value;
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { Accept: "application/json; charset=utf-8", Authorization: `OAuth ${token}` } });
    } catch (error) {
      throw new ScError(`Couldn't reach SoundCloud: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 401 && !retried) {
      // The token may have expired early; get a fresh one once.
      this.token = undefined;
      return this.get(url, true);
    }
    if (res.status === 429) throw new ScRateLimited(Number(res.headers.get("retry-after")) || undefined);
    if (res.status === 404) throw new ScError("SoundCloud couldn't find that (it may be private or removed).");
    if (res.status === 401 || res.status === 403) throw new ScError("SoundCloud refused the request (the profile's likes may be private, or the app's credentials were rejected).");
    if (!res.ok) throw new ScError(`SoundCloud answered HTTP ${res.status}.`);
    const value = await res.json();
    this.cache.set(url, { expires: this.now() + CACHE_MS, value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  /** A valid access token: the current one, a refreshed one, or (only if needed) a new one. */
  private async accessToken(): Promise<string> {
    if (!this.configured()) throw new ScError("SoundCloud isn't connected yet: the owner can add the app's credentials on the Account page.");
    if (this.token?.accessToken && this.token.expiresAt - 60_000 > this.now()) return this.token.accessToken;
    if (this.token?.refreshToken) {
      try {
        return await this.requestToken({ grant_type: "refresh_token", refresh_token: this.token.refreshToken });
      } catch (error) {
        if (error instanceof ScRateLimited) throw error;
        // Fall through to a new token.
      }
    }
    return this.requestToken({ grant_type: "client_credentials" });
  }

  private async requestToken(body: Record<string, string>): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json; charset=utf-8", "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
        body: new URLSearchParams(body).toString(),
      });
    } catch (error) {
      throw new ScError(`Couldn't reach SoundCloud: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 429) throw new ScRateLimited(Number(res.headers.get("retry-after")) || undefined);
    if (!res.ok) throw new ScError("SoundCloud rejected the app's credentials (check the client ID and secret on the Account page).");
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!json.access_token) throw new ScError("SoundCloud didn't return an access token.");
    this.token = { accessToken: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    if (json.refresh_token) this.token.refreshToken = json.refresh_token;
    if (this.tokenFile) writeFileSync(this.tokenFile, JSON.stringify(this.token), { mode: 0o600 });
    return json.access_token;
  }
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  return url.href;
}

/** "deep house" "techno" "\"Tech House\" vip" -> ["deep", "house", ...]: SoundCloud's tag_list format, quoted multi-word tags kept whole. */
function parseTags(tagList: string | null | undefined): string[] {
  if (!tagList) return [];
  return [...tagList.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2])!.trim()).filter(Boolean);
}

export function toTrack(raw: RawTrack): ScTrack {
  const access = raw.access === "playable" || raw.access === "preview" || raw.access === "blocked" ? raw.access : "playable";
  const track: ScTrack = {
    urn: raw.urn ?? (raw.id !== undefined ? `soundcloud:tracks:${raw.id}` : ""),
    title: raw.title ?? "",
    uploader: raw.user?.username ?? "",
    permalink: raw.permalink_url ?? "",
    tags: parseTags(raw.tag_list),
    durationMs: raw.duration ?? 0,
    access,
    embeddable: raw.embeddable_by !== "none",
  };
  if (raw.user?.permalink_url) track.uploaderUrl = raw.user.permalink_url;
  if (raw.genre?.trim()) track.genre = raw.genre.trim();
  if (typeof raw.playback_count === "number") track.plays = raw.playback_count;
  if (typeof raw.favoritings_count === "number") track.likes = raw.favoritings_count;
  if (raw.artwork_url) track.artwork = raw.artwork_url;
  if (raw.created_at) track.createdAt = raw.created_at;
  if (raw.label_name) track.label = raw.label_name;
  return track;
}

function toUser(raw: Record<string, unknown>): ScUser {
  const user: ScUser = {
    urn: String(raw.urn ?? (raw.id !== undefined ? `soundcloud:users:${raw.id}` : "")),
    username: String(raw.username ?? ""),
    permalink: String(raw.permalink_url ?? ""),
  };
  if (typeof raw.avatar_url === "string") user.avatar = raw.avatar_url;
  if (typeof raw.public_favorites_count === "number") user.likesCount = raw.public_favorites_count;
  if (typeof raw.followers_count === "number") user.followers = raw.followers_count;
  return user;
}
