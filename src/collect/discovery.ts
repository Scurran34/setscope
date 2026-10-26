// What "Gather more sets" found on each 1001Tracklists DJ or track page, so the next
// visit can say how far collection got: "46 sets on their page, all in setscope,
// last gathered Oct 26". The page itself is read in your browser by the extension
// (those pages need a human check); this only records the outcome.

import type pg from "pg";
import { normalizeName } from "../normalize.ts";

export interface DiscoveryOutcome {
  /** Distinct set links the extension collected from the page. */
  found: number;
  alreadyCached: number;
  queued: number;
  skippedOld: number;
  /** True when the extension scrolled until the page had no more sets (not cut off by its cap). */
  complete: boolean;
}

export interface DiscoveryRecord {
  pageUrl: string;
  setsSeen: number;
  setsIndexed: number;
  setsNew: number;
  setsOlder: number;
  complete: boolean;
  lastSuccessAt: string;
}

/** "https://1001tracklists.com/artist/mau-p/tracklists.html#x" -> "https://www.1001tracklists.com/artist/mau-p/tracklists.html" */
export function canonicalPage(url: string): string {
  const u = new URL(url);
  return `https://www.1001tracklists.com${u.pathname}`;
}

/** The artist a DJ page belongs to, by the /artist/<slug>/ or /dj/<slug>/ part of its URL. */
function pageSlug(pageUrl: string): string | undefined {
  return new URL(pageUrl).pathname.match(/^\/(?:artist|dj)\/([^/]+)\//)?.[1];
}

export async function recordDiscovery(pool: pg.Pool, pageUrl: string, outcome: DiscoveryOutcome): Promise<DiscoveryRecord> {
  const page = canonicalPage(pageUrl);
  const slug = pageSlug(page);
  const artist = slug
    ? (await pool.query<{ id: number }>("select id from artists where tl_page like $1 or tl_page like $2 limit 1", [`%/artist/${slug}/%`, `%/dj/${slug}/%`])).rows[0]?.id
    : undefined;
  const r = await pool.query<{ last_success_at: Date }>(
    `insert into discovery_progress (page_url, artist_id, sets_seen, sets_indexed, sets_new, sets_older, historical_done, last_attempt_at, last_success_at, last_error)
     values ($1, $2, $3, $4, $5, $6, $7, now(), now(), null)
     on conflict (page_url) do update set
       artist_id = coalesce(excluded.artist_id, discovery_progress.artist_id),
       sets_seen = excluded.sets_seen, sets_indexed = excluded.sets_indexed, sets_new = excluded.sets_new,
       sets_older = excluded.sets_older, historical_done = excluded.historical_done,
       last_attempt_at = now(), last_success_at = now(), last_error = null
     returning last_success_at`,
    [page, artist ?? null, outcome.found, outcome.alreadyCached, outcome.queued, outcome.skippedOld, outcome.complete],
  );
  return {
    pageUrl: page,
    setsSeen: outcome.found,
    setsIndexed: outcome.alreadyCached,
    setsNew: outcome.queued,
    setsOlder: outcome.skippedOld,
    complete: outcome.complete,
    lastSuccessAt: r.rows[0]!.last_success_at.toISOString(),
  };
}

/** The most recent gathering for an artist's page, if there's been one. */
export async function discoveryForArtist(pool: pg.Pool, artistName: string, pageUrl?: string): Promise<DiscoveryRecord | undefined> {
  const r = await pool.query<{
    page_url: string;
    sets_seen: number;
    sets_indexed: number;
    sets_new: number;
    sets_older: number;
    historical_done: boolean;
    last_success_at: Date;
  }>(
    `select d.* from discovery_progress d left join artists a on a.id = d.artist_id
      where (a.name_key = $1 or d.page_url = $2) and d.last_success_at is not null
      order by d.last_success_at desc limit 1`,
    [normalizeName(artistName), pageUrl ? canonicalPage(pageUrl) : null],
  );
  const row = r.rows[0];
  return (
    row && {
      pageUrl: row.page_url,
      setsSeen: row.sets_seen,
      setsIndexed: row.sets_indexed,
      setsNew: row.sets_new,
      setsOlder: row.sets_older,
      complete: row.historical_done,
      lastSuccessAt: row.last_success_at.toISOString(),
    }
  );
}
