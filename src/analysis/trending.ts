// Trending: songs and artists that show up in a bigger share of sets lately than
// before. Same idea as artist mode's trend, run over everything in the cache.

import type { Ranked, Tracklist } from "../model.ts";
import { creditedArtists, displayName, isId, normalizeName, songKey } from "../normalize.ts";
import { Counter, filterBetween, filterSince } from "./common.ts";

export interface TrendingItem {
  name: string;
  /** Sets in the recent window that have it. */
  recent: number;
  /** Sets in the earlier window that have it. */
  earlier: number;
  /** Percent rise in share of sets, or null when it wasn't in any earlier set (new). */
  changePercent: number | null;
}

export interface TrendingReport {
  /** Start of the recent window: "after this date". */
  recentFrom: string;
  since: string;
  setsRecent: number;
  setsEarlier: number;
  /** False when either window has too few sets to say anything. */
  enoughData: boolean;
  songs: TrendingItem[];
  artists: TrendingItem[];
  /** Simply the most played since recentFrom, rising or not. */
  topSongs: Ranked[];
  topArtists: Ranked[];
}

export interface TrendingOptions {
  since: string;
  today: string;
  /** Length of the recent window in days. */
  recentDays?: number;
  top?: number;
}

/** Below these counts a "trend" is noise. */
const MIN_SETS_PER_WINDOW = 5;
const MIN_RECENT_APPEARANCES = 3;
/** Share has to grow at least this much (1.25 = +25%) to count. */
const MIN_GROWTH = 1.25;

export function trending(sets: Tracklist[], options: TrendingOptions): TrendingReport {
  const recentFrom = daysBefore(options.today, options.recentDays ?? 30);
  const inRange = filterSince(sets, options.since);
  const recentSets = filterSince(inRange, recentFrom);
  const earlierSets = filterBetween(inRange, options.since, recentFrom);
  const enoughData = recentSets.length >= MIN_SETS_PER_WINDOW && earlierSets.length >= MIN_SETS_PER_WINDOW;
  const top = options.top ?? 5;

  const songs = (set: Tracklist) =>
    new Map(set.tracks.filter((t) => !isId(t)).map((t) => [songKey(t), displayName(t)]));
  // An artist's own sets don't count toward their popularity, same as artist mode.
  const artists = (set: Tracklist) => {
    const djs = new Set(set.djs.map(normalizeName));
    const names = new Map<string, string>();
    for (const t of set.tracks) {
      for (const a of creditedArtists(t)) if (!djs.has(normalizeName(a))) names.set(normalizeName(a), a);
    }
    return names;
  };

  return {
    recentFrom,
    since: options.since,
    setsRecent: recentSets.length,
    setsEarlier: earlierSets.length,
    enoughData,
    songs: enoughData ? rising(recentSets, earlierSets, songs, top) : [],
    artists: enoughData ? rising(recentSets, earlierSets, artists, top) : [],
    topSongs: mostPlayed(recentSets, songs, 10),
    topArtists: mostPlayed(recentSets, artists, 10),
  };
}

function mostPlayed(sets: Tracklist[], keysOf: (set: Tracklist) => Map<string, string>, top: number): Ranked[] {
  const counter = new Counter();
  for (const set of sets) for (const [key, name] of keysOf(set)) counter.add(key, name);
  return counter.top(top);
}

/** Count, per key, the sets in each window that contain it, and keep the ones rising fastest. */
function rising(
  recentSets: Tracklist[],
  earlierSets: Tracklist[],
  keysOf: (set: Tracklist) => Map<string, string>,
  top: number,
): TrendingItem[] {
  const counts = new Map<string, { name: string; recent: number; earlier: number }>();
  const tally = (list: Tracklist[], field: "recent" | "earlier") => {
    for (const set of list) {
      for (const [key, name] of keysOf(set)) {
        const entry = counts.get(key) ?? { name, recent: 0, earlier: 0 };
        entry[field]++;
        counts.set(key, entry);
      }
    }
  };
  tally(recentSets, "recent");
  tally(earlierSets, "earlier");

  const items: (TrendingItem & { lift: number })[] = [];
  for (const { name, recent, earlier } of counts.values()) {
    if (recent < MIN_RECENT_APPEARANCES) continue;
    const recentShare = recent / recentSets.length;
    const earlierShare = earlier / earlierSets.length;
    if (earlier > 0 && recentShare / earlierShare < MIN_GROWTH) continue;
    items.push({
      name,
      recent,
      earlier,
      changePercent: earlier === 0 ? null : Math.round((recentShare / earlierShare - 1) * 100),
      // Rank by how many more sets (as a share) have it now: a song going from 0 to
      // 10% of sets beats one going from 1% to 2%, even though the second "doubled".
      lift: recentShare - earlierShare,
    });
  }
  return items
    .sort((a, b) => b.lift - a.lift || a.name.localeCompare(b.name))
    .slice(0, top)
    .map(({ lift: _lift, ...item }) => item);
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
