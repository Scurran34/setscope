// Searching what's in the cache by loose text, for the search-box dropdown,
// "Did you mean", and auto-correcting a search that finds nothing. Exact matching
// lives in normalize.ts; this is for when you only half-remember a name
// ("lp rhythm feelin") or misspell it ("chris stussy" for "CHRIS STASSY").

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
 * Edits (insert, delete, change, or swap two neighbors) to turn `a` into `b`.
 * "stussy" -> "stassy" is 1, "rythm" -> "rhythm" is 1.
 */
export function editDistance(a: string, b: string): number {
  // d[i][j] = edits between the first i letters of a and the first j letters of b.
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** Score for a typo: high, but below a real match so exact spellings still win. */
const TYPO = 0.8;

/**
 * How well one typed word matches one candidate word: 1 if the candidate starts
 * with it ("feel" -> "feelin"), TYPO if it's a near spelling, else 0. Short words
 * must be exact, since "ab" vs "ac" is a different word, not a typo.
 */
function wordMatch(typed: string, candidate: string): number {
  if (candidate.startsWith(typed)) return 1;
  if (typed.length < 4) return 0;
  const allowed = typed.length >= 8 ? 2 : 1;
  // Compare against the whole word and against its start, for words still being typed.
  const distance = Math.min(editDistance(typed, candidate), editDistance(typed, candidate.slice(0, typed.length)));
  return distance <= allowed ? TYPO : 0;
}

/** How well the typed words match a candidate, 0 to 1 (the average of each word's best match). */
export function wordScore(typed: string[], candidate: string[]): number {
  if (typed.length === 0) return 0;
  const total = typed.reduce((sum, t) => sum + Math.max(0, ...candidate.map((c) => wordMatch(t, c))), 0);
  return total / typed.length;
}

interface Scored extends Ranked {
  score: number;
}

function byBest(a: Scored, b: Scored): number {
  return b.score - a.score || b.count - a.count || a.name.localeCompare(b.name);
}

/**
 * Best first: closest text match, then most sets, then alphabetical. If anything
 * matches every typed word, only those are shown; near misses are just noise then.
 */
function best(scored: Scored[], limit: number): Ranked[] {
  const fullMatch = scored.some((s) => s.score === 1);
  return scored
    .filter((s) => !fullMatch || s.score === 1)
    .sort(byBest)
    .slice(0, limit)
    .map(({ name, count }) => ({ name, count }));
}

/**
 * The one cached name a search clearly meant, if any: a close match (all words
 * matching or near-spelled) well ahead of the runner-up, and not just what was typed.
 */
function correction(scored: Scored[], typed: string): string | undefined {
  const [top, second] = [...scored].sort(byBest);
  if (!top || top.score < 0.75) return undefined;
  if (second && second.score > top.score - 0.15) return undefined;
  return normalizeName(top.name) === normalizeName(typed) ? undefined : top.name;
}

/** Cached songs that look like `text`, with how many sets each is in. */
export function searchSongs(sets: Tracklist[], text: string, since: string, limit = 8): Ranked[] {
  return best(scoreSongs(sets, text, since), limit);
}

/** The cached song `text` clearly meant, e.g. a misspelling of one. */
export function correctSong(sets: Tracklist[], text: string, since: string): string | undefined {
  return correction(scoreSongs(sets, text, since), text);
}

function scoreSongs(sets: Tracklist[], text: string, since: string): Scored[] {
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
  return scored;
}

/** Cached artists (DJs or track artists) that look like `text`, with how many sets each appears in. */
export function searchArtists(sets: Tracklist[], text: string, since: string, limit = 8): Ranked[] {
  return best(scoreArtists(sets, text, since), limit);
}

/** The cached artist `text` clearly meant, e.g. "chris stussy" -> "CHRIS STASSY". */
export function correctArtist(sets: Tracklist[], text: string, since: string): string | undefined {
  return correction(scoreArtists(sets, text, since), text);
}

function scoreArtists(sets: Tracklist[], text: string, since: string): Scored[] {
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
  return scored;
}

/** Cached songs with exactly this title (any artist), most-played first: for title-only searches. */
export function songsWithTitle(sets: Tracklist[], title: string, since: string): Ranked[] {
  const wanted = baseTitle(title);
  const counter = new Counter();
  for (const set of filterSince(sets, since)) {
    const seen = new Map(
      set.tracks.filter((t) => !isId(t) && baseTitle(t.title) === wanted).map((t) => [songKey(t), displayName(t)]),
    );
    for (const [key, name] of seen) counter.add(key, name);
  }
  return counter.top(Number.POSITIVE_INFINITY);
}
