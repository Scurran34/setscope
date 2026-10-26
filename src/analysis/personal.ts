// Suggestions from your own choices: liked songs and your categories.
// All of it comes from one idea: songs that keep getting played in the same sets
// probably go together.

import type { Ranked, SetSummary, Tracklist } from "../model.ts";
import { summarize } from "../model.ts";
import { displayName, isId, songKey } from "../normalize.ts";
import { Counter, filterSince } from "./common.ts";

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
    .sort((a, b) => b.liked.length - a.liked.length || b.set.date.localeCompare(a.set.date))
    .slice(0, limit)
    .map((s) => ({ ...summarize(s.set), liked: s.liked }));
}

/**
 * Songs played alongside your picks (`seeds`): for each set that has at least one
 * seed, every other song in it gets a point. Seeds and `exclude` are left out.
 */
export function songsLike(
  sets: Tracklist[],
  seeds: Set<string>,
  since: string,
  options: { exclude?: Set<string>; limit?: number } = {},
): Ranked[] {
  const counter = new Counter();
  for (const set of filterSince(sets, since)) {
    const keys = songKeys(set);
    if (![...keys.keys()].some((k) => seeds.has(k))) continue;
    for (const [key, name] of keys) {
      if (!seeds.has(key) && !options.exclude?.has(key)) counter.add(key, name);
    }
  }
  // One shared set is a coincidence; two or more is a pattern.
  return counter.top(options.limit ?? 10, 2);
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
