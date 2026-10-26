// Searching what's in the cache by loose text, for the search-box dropdown and
// "Did you mean". Exact matching lives in normalize.ts; this is for when you only
// half-remember a name ("lp rhythm feelin").

import type { Ranked, Tracklist } from "../model.ts";
import { baseTitle, displayName, isId, normalizeName, songKey, splitArtists } from "../normalize.ts";
import { Counter, filterSince } from "./common.ts";

/** "L.P. Rhythm - How Ya Feelin'" -> ["lp", "rhythm", "how", "ya", "feelin"] */
function words(s: string): string[] {
  return normalizeName(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Share of the typed words that start some word in the candidate, 0 to 1.
 * Prefixes count so the dropdown works while you're still typing ("feel" -> "feelin").
 */
export function wordScore(typed: string[], candidate: string[]): number {
  if (typed.length === 0) return 0;
  const hits = typed.filter((t) => candidate.some((c) => c.startsWith(t))).length;
  return hits / typed.length;
}

interface Scored extends Ranked {
  score: number;
}

/**
 * Best first: closest text match, then most sets, then alphabetical. If anything
 * matches every typed word, only those are shown; near misses are just noise then.
 */
function best(scored: Scored[], limit: number): Ranked[] {
  const fullMatch = scored.some((s) => s.score === 1);
  return scored
    .filter((s) => !fullMatch || s.score === 1)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, count }) => ({ name, count }));
}

/** Cached songs that look like `text`, with how many sets each is in. */
export function searchSongs(sets: Tracklist[], text: string, since: string, limit = 8): Ranked[] {
  const typed = words(text.replace(/\s+-\s+/, " "));
  // Same title, any artist: "Somebody - Pulse" should still suggest "Nova - Pulse".
  const dash = text.indexOf(" - ");
  const titles = dash === -1 ? [] : [baseTitle(text.slice(dash + 3)), baseTitle(text.slice(0, dash))];

  const counter = new Counter();
  for (const set of filterSince(sets, since)) {
    const seen = new Map(set.tracks.filter((t) => !isId(t)).map((t) => [songKey(t), displayName(t)]));
    for (const [key, name] of seen) counter.add(key, name);
  }
  const scored: Scored[] = [];
  for (const song of counter.top(Number.POSITIVE_INFINITY)) {
    const dashAt = song.name.indexOf(" - ");
    const sameTitle = titles.includes(baseTitle(song.name.slice(dashAt + 3)));
    const score = Math.max(wordScore(typed, words(song.name)), sameTitle ? 0.6 : 0);
    if (score >= 0.5) scored.push({ ...song, score });
  }
  return best(scored, limit);
}

/** Cached artists (DJs or track artists) that look like `text`, with how many sets each appears in. */
export function searchArtists(sets: Tracklist[], text: string, since: string, limit = 8): Ranked[] {
  const typed = words(text);
  const counter = new Counter();
  for (const set of filterSince(sets, since)) {
    const names = new Map<string, string>();
    for (const dj of set.djs) names.set(normalizeName(dj), dj);
    for (const t of set.tracks) for (const a of splitArtists(t.artist)) names.set(normalizeName(a), a);
    for (const [key, name] of names) counter.add(key, name);
  }
  const scored: Scored[] = [];
  for (const artist of counter.top(Number.POSITIVE_INFINITY)) {
    const score = wordScore(typed, words(artist.name));
    if (score >= 0.5) scored.push({ ...artist, score });
  }
  return best(scored, limit);
}
