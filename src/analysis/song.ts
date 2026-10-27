// Song mode: given a song, look at the recent sets that contain it.

import type { Ranked, SetSummary, Track, Tracklist } from "../model.ts";
import { summarize } from "../model.ts";
import {
  displayName,
  isId,
  matchesSong,
  normalizeName,
  songKey,
  type SongQuery,
} from "../normalize.ts";
import { searchSongs } from "./catalog.ts";
import type { CategoryHint } from "./personal.ts";
import { Counter, filterSince, newestFirst } from "./common.ts";

export interface SongReport {
  song: string;
  since: string;
  /** Sets in the cache on or after `since`. */
  setsConsidered: number;
  /** Of those, sets that contain the song. */
  setsWithSong: number;
  /** How the matched song is actually written in the sets, so you can see what was counted. */
  matchedAs: Ranked[];
  /** Set when the server swapped a search that found nothing for the cached song it clearly meant. */
  correctedFrom?: string;
  /** Title-only search: other cached songs with the same title (set by the server). */
  otherVersions?: Ranked[];
  /** When nothing matched: cached songs that look like what was typed. */
  suggestions: Ranked[];
  /** DJs credited on the most sets containing the song. */
  topDjs: Ranked[];
  /** How many different DJs played it. */
  uniqueDjs: number;
  /** Unreleased IDs that show up in at least two of those sets. */
  recurringIds: Ranked[];
  /** Other released songs that show up most in those sets. */
  coPlayed: Ranked[];
  /** Most common genre tag on the song across those sets, e.g. "Tech House". */
  genre?: string;
  /** All the sets that play it, newest first. */
  sets: SetSummary[];
  /** Filled in by the server from your own data: */
  liked?: boolean;
  /** Your categories this song is in. */
  categories?: string[];
  /** Categories it keeps getting played next to ("maybe part of Party"). */
  hints?: CategoryHint[];
}

export interface SongOptions {
  since: string;
  top?: number;
}

export function analyzeSong(sets: Tracklist[], query: SongQuery, options: SongOptions): SongReport {
  const top = options.top ?? 10;
  const recent = filterSince(sets, options.since);
  const withSong = recent.filter((set) => set.tracks.some((t) => matchesSong(t, query)));

  const matched = new Counter();
  const genres = new Counter();
  const djs = new Counter();
  const ids = new Counter();
  const others = new Counter();

  for (const set of withSong) {
    for (const dj of set.djs) djs.add(normalizeName(dj), dj, set.djPages?.[dj]);
    const hits = set.tracks.filter((t) => matchesSong(t, query));
    for (const name of new Set(hits.map(displayName))) matched.add(name);
    const genre = hits.find((t) => t.genre)?.genre;
    if (genre) genres.add(genre);

    // Count each song or ID once per set, even if the DJ played it twice.
    const seenIds = new Map<string, string>();
    const seenOthers = new Map<string, string>();
    set.tracks.forEach((track, index) => {
      if (matchesSong(track, query)) return;
      if (isId(track)) {
        const id = idIdentity(set.tracks, index);
        if (id) seenIds.set(id.key, id.label);
      } else {
        seenOthers.set(songKey(track), displayName(track));
      }
    });
    for (const [key, label] of seenIds) ids.add(key, label);
    for (const [key, label] of seenOthers) others.add(key, label);
  }


  const report: SongReport = {
    song: query.label,
    since: options.since,
    setsConsidered: recent.length,
    setsWithSong: withSong.length,
    matchedAs: matched.top(5),
    suggestions: withSong.length === 0 && query.guesses ? searchSongs(sets, query.label, options.since, 5) : [],
    topDjs: djs.top(top),
    uniqueDjs: djs.top(Number.POSITIVE_INFINITY).length,
    recurringIds: ids.top(top, 2),
    coPlayed: others.top(top),
    sets: [...withSong].sort(newestFirst).map(summarize),
  };
  const genre = genres.top(1)[0]?.name;
  if (genre) report.genre = genre;
  return report;
}

/**
 * Decide which ID rows are "the same ID" across sets.
 *  1. 1001Tracklists linked the row to a track page: trust its trackId.
 *  2. Partially known ("Fisher - ID"): use the name.
 *  3. Fully unknown ("ID - ID"): the only clue is context, so key on the nearest
 *     known track played before it. The same ID often follows the same song in
 *     sets by DJs who share promos. This is a heuristic, and the label says so.
 */
function idIdentity(tracks: Track[], index: number): { key: string; label: string } | undefined {
  const track = tracks[index]!;
  if (track.trackId) {
    return { key: `tid:${track.trackId}`, label: `${displayName(track)} [1001TL ${track.trackId}]` };
  }
  if (normalizeName(track.artist) !== "id" || normalizeName(track.title) !== "id") {
    return { key: `name:${songKey(track)}`, label: displayName(track) };
  }
  for (let i = index - 1; i >= 0; i--) {
    const previous = tracks[i]!;
    if (!isId(previous)) {
      return {
        key: `after:${songKey(previous)}`,
        label: `ID - ID (played after ${displayName(previous)})`,
      };
    }
  }
  return undefined;
}

export interface Alongside {
  name: string;
  /** Sets that played both songs. */
  together: number;
  /** Sets (in the window) that played it at all. */
  everywhere: number;
}

/**
 * Every song played in the same sets as this one (2+ shared sets: one is a coincidence).
 *
 * "specific" (the default) ranks by how much of the other song's play is alongside this
 * one: shared sets / (all its sets + 3). A song that almost always comes with this one
 * beats a hit that's simply in every set; the +3 keeps a song seen twice from topping the
 * list on luck. "count" ranks by shared sets alone.
 */
export function playedAlongside(sets: Tracklist[], query: SongQuery, since: string, sort: "specific" | "count" = "specific"): Alongside[] {
  const together = new Counter();
  const everywhere = new Map<string, number>();
  for (const set of filterSince(sets, since)) {
    const others = new Map<string, string>();
    let hasSong = false;
    for (const track of set.tracks) {
      if (matchesSong(track, query)) hasSong = true;
      else if (!isId(track)) others.set(songKey(track), displayName(track));
    }
    for (const key of others.keys()) everywhere.set(key, (everywhere.get(key) ?? 0) + 1);
    if (hasSong) for (const [key, name] of others) together.add(key, name);
  }
  const keyOf = new Map<string, string>();
  for (const set of filterSince(sets, since)) for (const t of set.tracks) if (!isId(t)) keyOf.set(displayName(t), songKey(t));
  const rows = together.top(Number.POSITIVE_INFINITY, 2).map((r) => ({ name: r.name, together: r.count, everywhere: everywhere.get(keyOf.get(r.name) ?? "") ?? r.count }));
  const score = (r: Alongside) => (sort === "count" ? r.together : r.together / (r.everywhere + 3));
  return rows.sort((a, b) => score(b) - score(a) || b.together - a.together || a.name.localeCompare(b.name));
}
