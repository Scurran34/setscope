// Polite fetching of tracklist pages.
//
// Rules this follows (see README "Data access"):
// - Honest User-Agent. We never pretend to be a browser.
// - At least 8s between requests (robots.txt Crawl-delay: 8).
// - Only /tracklist/ pages, plus the front page for the background collector. Track and DJ
//   pages sit behind a human check, and we leave those alone.
// - One request at a time, even when the queue and the background collector both want one.
// - Any sign of a bot check or refusal stops the whole run, says which kind it was, and
//   keeps the site's Retry-After. No retries, no workarounds.
// - A page that isn't a tracklist and isn't a bot check either (the layout changed, or
//   the tracklist is empty) is reported as such, not mistaken for a block.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isChallengePage, isTracklistPage, isTracklistShell } from "./parse.ts";

export const USER_AGENT = "setscope/0.1 (personal non-commercial project; respects robots.txt)";
export const MIN_DELAY_MS = 8_000;
export const FRONT_PAGE = "https://www.1001tracklists.com/";

/** Anything that can hand us the HTML for a URL. Tests pass a fake one. */
export interface HtmlSource {
  /** `signal` lets a Stop cancel a request that's waiting its turn or in flight. */
  fetchHtml(url: string, signal?: AbortSignal): Promise<string>;
}

/** How the site said no: each is a reason to stop asking, explained differently. */
export type BlockKind = "rate_limit" | "auth" | "forbidden" | "challenge" | "unavailable";

/** The site asked us to prove we're human, or refused us. Stop, don't retry. */
export class BlockedError extends Error {
  readonly status: number;
  readonly kind: BlockKind;
  /** From the site's Retry-After header, when it sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, status: number, kind?: BlockKind, retryAfterSeconds?: number) {
    super(message);
    this.name = "BlockedError";
    this.status = status;
    this.kind = kind ?? blockKind(status);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A tracklist page with no tracks listed yet: a real answer, not an error. */
export class EmptyTracklistError extends Error {
  constructor(url: string) {
    super(`${url} has no tracks listed yet.`);
    this.name = "EmptyTracklistError";
  }
}

/** A page that isn't a tracklist or a bot check: probably a site layout change. */
export class LayoutError extends Error {
  constructor(url: string) {
    super(`${url} didn't look like a tracklist page (the site's layout may have changed).`);
    this.name = "LayoutError";
  }
}

/** The person stopped collecting while this request waited or ran. */
export class CancelledError extends Error {
  constructor() {
    super("Stopped.");
    this.name = "CancelledError";
  }
}

export function blockKind(status: number): BlockKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 503) return "unavailable";
  return status === 403 ? "forbidden" : "challenge";
}

/** Retry-After as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - now) / 1000));
}

export interface FetcherOptions {
  delayMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** File that remembers the last request time, so the delay holds across separate runs. */
  stateFile?: string;
}

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

export class PoliteFetcher implements HtmlSource {
  private readonly delayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly stateFile: string | undefined;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Requests line up here, so two callers can't both decide the delay has passed. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: FetcherOptions = {}) {
    // A smaller delay than robots.txt asks for is never allowed, even if requested.
    this.delayMs = Math.max(options.delayMs ?? MIN_DELAY_MS, MIN_DELAY_MS);
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.stateFile = options.stateFile;
    if (this.stateFile && existsSync(this.stateFile)) {
      this.lastRequestAt = Number(readFileSync(this.stateFile, "utf8")) || Number.NEGATIVE_INFINITY;
    }
  }

  /** A set page: its tracklist, or a clear reason why not (blocked, empty, unrecognized). */
  fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
    if (!isFetchAllowed(url)) {
      return Promise.reject(new Error(`Refusing to fetch ${url}: only 1001Tracklists /tracklist/ pages are fetched automatically.`));
    }
    return this.lineUp(async () => {
      const body = await this.request(url, () => true, "", signal);
      if (isTracklistPage(body)) return body;
      if (isChallengePage(body)) throw new BlockedError(`${url} returned a verification page instead of the tracklist.`, 200, "challenge");
      if (isTracklistShell(body)) throw new EmptyTracklistError(url);
      throw new LayoutError(url);
    }, signal);
  }

  /** The 1001Tracklists front page, for finding new sets. It should link to some sets. */
  fetchFrontPage(): Promise<string> {
    return this.lineUp(() => this.request(FRONT_PAGE, (body) => body.includes("/tracklist/"), "a front page with no sets"));
  }

  private lineUp<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = this.chain.then(() => {
      if (signal?.aborted) throw new CancelledError();
      return task();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async request(url: string, looksRight: (body: string) => boolean, wrongPage: string, signal?: AbortSignal): Promise<string> {
    const wait = this.lastRequestAt + this.delayMs - this.now();
    if (wait > 0) await abortable(this.sleep(wait), signal);
    if (signal?.aborted) throw new CancelledError();

    // Record before connecting: a timeout or TLS failure still counts as a request
    // and must not let the next one go out sooner than the delay allows.
    this.lastRequestAt = this.now();
    if (this.stateFile) writeFileSync(this.stateFile, String(this.lastRequestAt));
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      throw new Error(`Network failure while fetching ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const retryAfter = response.headers.get("retry-after");
    const body = await response.text();

    if (BLOCK_STATUSES.has(response.status)) {
      const hint = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
      throw new BlockedError(`HTTP ${response.status} from ${url}: the site is refusing automated requests right now.${hint}`, response.status, undefined, retryAfterSeconds(retryAfter, this.now()));
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    // A 200 that isn't the page we asked for is a "please wait" or verification page.
    if (!looksRight(body)) {
      throw new BlockedError(`${url} returned ${wrongPage} (probably a bot check).`, response.status);
    }
    return body;
  }
}

export function isFetchAllowed(url: string): boolean {
  return /^https:\/\/www\.1001tracklists\.com\/tracklist\/[a-z0-9]+\//i.test(url);
}

/** Wait for `promise`, but give up (with CancelledError) as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
