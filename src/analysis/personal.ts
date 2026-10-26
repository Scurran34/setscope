// Suggestions from your own choices: liked songs and your categories.
// All of it comes from one idea: songs that keep getting played in the same sets
// probably go together.

import type { Ranked, SetSummary, Tracklist } from "../model.ts";
import { summarize } from "../model.ts";
import { displayName, isId, songKey } from "../normalize.ts";
import { Counter, filterSince, newestFirst } from "./common.ts";

export interface SetForYou extends SetSummary {
  /** Your liked songs that this set plays. */
  liked: string[];
}

function songKeys(set: Tracklist): Map<string, string> {
  return new Map(set.tracks.filter((t) => !isId(t)).map((t) => [songKey(t), displayName(t)]));
}

/** Sets that play the most of your liked songs, newest first among ties. */
export function setsForYou(sets: Tracklist[], liked: Set<string>, since: string, limit = 10): SetForYou[] {
  return filterSince(sets, since)
    .map((set) => ({ set, liked: [...songKeys(set)].filter(([key]) => liked.has(key)).map(([, name]) => name) }))
    .filter((s) => s.liked.length > 0)
    .sort((a, b) => b.liked.length - a.liked.length || newestFirst(a.set, b.set))
    .slice(0, limit)
    .map((s) => ({ ...summarize(s.set), liked: s.liked }));
}

/**
 * Songs played alongside your picks (`seeds`): songs that share 2+ sets with them.
 *
 * Ranked by how *specific* the link is, not just how often: shared sets divided by the
 * square root of all the sets the song is in. Otherwise the biggest songs of the moment
 * would top everyone's list just for being everywhere. Seeds and `exclude` are left out.
 */
export function songsLike(
  sets: Tracklist[],
  seeds: Set<string>,
  since: string,
  options: { exclude?: Set<string>; limit?: number } = {},
): Ranked[] {
  const shared = new Counter();
  const everywhere = new Map<string, number>();
  for (const set of filterSince(sets, since)) {
    const keys = songKeys(set);
    for (const key of keys.keys()) everywhere.set(key, (everywhere.get(key) ?? 0) + 1);
    if (![...keys.keys()].some((k) => seeds.has(k))) continue;
    for (const [key, name] of keys) {
      if (!seeds.has(key) && !options.exclude?.has(key)) shared.add(key, name);
    }
  }
  const keyOf = new Map<string, string>();
  for (const set of filterSince(sets, since)) for (const [key, name] of songKeys(set)) if (!keyOf.has(name)) keyOf.set(name, key);
  const lift = (r: Ranked) => r.count / Math.sqrt(everywhere.get(keyOf.get(r.name) ?? "") ?? r.count);
  // One shared set is a coincidence; two or more is a pattern.
  return shared
    .top(Number.POSITIVE_INFINITY, 2)
    .sort((a, b) => lift(b) - lift(a) || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, options.limit ?? 10);
}

export interface CategoryHint {
  category: string;
  /** Sets with this song that also play a song from the category... */
  sets: number;
  /** ...out of all cached sets with this song. */
  of: number;
}

/**
 * "Maybe part of Party": categories whose songs keep showing up in the same sets as
 * this song. Needs 2+ shared sets making up at least 30% of the song's sets.
 */
export function categoryHints(
  sets: Tracklist[],
  song: string,
  categories: { name: string; songs: Record<string, string> }[],
  since: string,
): CategoryHint[] {
  const withSong = filterSince(sets, since).filter((set) => songKeys(set).has(song));
  const hints: CategoryHint[] = [];
  for (const category of categories) {
    if (song in category.songs) continue;
    const members = new Set(Object.keys(category.songs));
    const shared = withSong.filter((set) => [...songKeys(set).keys()].some((k) => members.has(k))).length;
    if (shared >= 2 && shared / withSong.length >= 0.3) hints.push({ category: category.name, sets: shared, of: withSong.length });
  }
  return hints.sort((a, b) => b.sets / b.of - a.sets / a.of || a.category.localeCompare(b.category));
}
