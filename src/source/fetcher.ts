// Polite fetching of tracklist pages.
//
// Rules this follows (see README "Data access"):
// - Honest User-Agent. We never pretend to be a browser.
// - At least 8s between requests (robots.txt Crawl-delay: 8).
// - Only /tracklist/ pages. Track and DJ pages sit behind a human check, and we leave those alone.
// - Any sign of a bot check stops the whole run. No retries, no workarounds.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isTracklistPage } from "./parse.ts";

export const USER_AGENT = "setscope/0.1 (personal non-commercial project; respects robots.txt)";
export const MIN_DELAY_MS = 8_000;

/** Anything that can hand us the HTML for a URL. Tests pass a fake one. */
export interface HtmlSource {
  fetchHtml(url: string): Promise<string>;
}

/** The site asked us to prove we're human, or refused us. Stop, don't retry. */
export class BlockedError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BlockedError";
    this.status = status;
  }
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

  async fetchHtml(url: string): Promise<string> {
    if (!isFetchAllowed(url)) {
      throw new Error(`Refusing to fetch ${url}: only 1001Tracklists /tracklist/ pages are fetched automatically.`);
    }

    const wait = this.lastRequestAt + this.delayMs - this.now();
    if (wait > 0) await this.sleep(wait);

    // Record before connecting: a timeout or TLS failure still counts as a request
    // and must not let the next one go out sooner than the delay allows.
    this.lastRequestAt = this.now();
    if (this.stateFile) writeFileSync(this.stateFile, String(this.lastRequestAt));
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
      });
    } catch (error) {
      throw new Error(`Network failure while fetching ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const retryAfter = response.headers.get("retry-after");
    const body = await response.text();

    if (BLOCK_STATUSES.has(response.status)) {
      const hint = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
      throw new BlockedError(`HTTP ${response.status} from ${url}: the site is refusing automated requests right now.${hint}`, response.status);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    // A 200 that isn't a tracklist is a "please wait" or verification page.
    if (!isTracklistPage(body)) {
      throw new BlockedError(`${url} returned a page without a tracklist (probably a bot check).`, response.status);
    }
    return body;
  }
}

export function isFetchAllowed(url: string): boolean {
  return /^https:\/\/www\.1001tracklists\.com\/tracklist\/[a-z0-9]+\//i.test(url);
}
