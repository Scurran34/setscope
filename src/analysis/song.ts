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
  /** Unreleased IDs that show up in at least two of those sets. */
  recurringIds: Ranked[];
  /** Other released songs that show up most in those sets. */
  coPlayed: Ranked[];
  /** Most common genre tag on the song across those sets, e.g. "Tech House". */
  genre?: string;
  /** The sets that play it, newest first. */
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
    recurringIds: ids.top(top, 2),
    coPlayed: others.top(top),
    sets: [...withSong].sort(newestFirst).slice(0, 10).map(summarize),
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
