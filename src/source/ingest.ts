// Getting sets into the cache: from URLs (fetched politely) or from pages you saved.

import { BlockedError, type HtmlSource } from "./fetcher.ts";
import { canonicalUrl, dateFromUrl, parseTracklist, tracklistId } from "./parse.ts";
import type { TracklistStore } from "./store.ts";

export interface IngestOptions {
  /** Skip sets whose URL date is before this, without fetching them. */
  since: string;
  /** Stop after this many network requests. */
  limit?: number;
  log?: (line: string) => void;
}

export interface IngestResult {
  fetched: number;
  alreadyCached: number;
  skippedOld: number;
  failed: { url: string; error: string }[];
  /** Set when the site showed a bot check; the run stopped there. */
  blocked?: string;
  /** URLs we never got to (because of `limit` or a block). Re-run to continue. */
  remaining: string[];
}

export async function ingestUrls(
  urls: string[],
  store: TracklistStore,
  source: HtmlSource,
  options: IngestOptions,
): Promise<IngestResult> {
  const log = options.log ?? (() => {});
  const { todo, alreadyCached, skippedOld } = triage(urls, store, options.since);
  const result: IngestResult = { fetched: 0, alreadyCached, skippedOld, failed: [], remaining: [] };

  for (const [i, url] of todo.entries()) {
    if (options.limit !== undefined && result.fetched >= options.limit) {
      result.remaining = todo.slice(i);
      break;
    }
    log(`[${i + 1}/${todo.length}] ${url}`);
    try {
      const html = await source.fetchHtml(url);
      result.fetched++;
      store.save(parseTracklist(html, url), html);
    } catch (error) {
      if (error instanceof BlockedError) {
        result.blocked = error.message;
        result.remaining = todo.slice(i);
        break;
      }
      result.failed.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Split URLs into ones to fetch, ones already cached, and ones too old to bother with. */
export function triage(urls: string[], store: TracklistStore, since: string) {
  let alreadyCached = 0;
  const old: string[] = [];
  const todo = urls.filter((url) => {
    const id = tracklistId(url);
    if (!id) return false;
    if (store.has(id)) {
      alreadyCached++;
      return false;
    }
    const date = dateFromUrl(url);
    if (date && date < since) {
      old.push(url);
      return false;
    }
    return true;
  });
  return { todo, alreadyCached, skippedOld: old.length, old };
}

/** Store a tracklist page you saved from your browser. Returns the set's id. */
export function importSavedTracklist(html: string, store: TracklistStore, fallbackUrl?: string): string {
  const url = canonicalUrl(html) ?? fallbackUrl;
  if (!url) throw new Error("Couldn't tell which tracklist this saved page is (no og:url/canonical link).");
  const set = parseTracklist(html, url);
  store.save(set, html);
  return set.id;
}
