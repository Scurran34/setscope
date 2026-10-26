// Artist mode: how much other DJs play this artist, and who this artist plays.

import type { Ranked, Tracklist } from "../model.ts";
import { creditedArtists, creditsArtist, displayName, normalizeName, songKey } from "../normalize.ts";
import { Counter, filterBetween, filterSince, monthsBefore } from "./common.ts";

export type TrendDirection = "up" | "down" | "flat" | "not enough data";

export interface WindowStats {
  from: string;
  to: string;
  /** Sets by other DJs in this window. */
  sets: number;
  /** Of those, sets with at least one of the artist's tracks. */
  setsWithArtist: number;
  /** setsWithArtist / sets, or 0 when there are no sets. */
  share: number;
}

export interface MonthBucket {
  month: string; // "YYYY-MM"
  sets: number;
  setsWithArtist: number;
}

export interface ArtistReport {
  artist: string;
  since: string;
  trend: { direction: TrendDirection; recent: WindowStats; earlier: WindowStats };
  monthly: MonthBucket[];
  /** The artist's tracks played on the most sets (by other DJs) in the recent window. */
  topTracksRecent: Ranked[];
  /** Sets the artist played themselves since the cutoff. */
  ownSets: number;
  /** Artists whose tracks appear most in the artist's own sets. */
  mostPlayedArtists: Ranked[];
}

export interface ArtistOptions {
  since: string;
  /** "YYYY-MM-DD" treated as now. Injected so tests don't depend on the clock. */
  today: string;
  /** Length of the "recent" window; the earlier window runs from `since` to its start. */
  recentMonths?: number;
  top?: number;
}

// Below these numbers a trend is noise, so we say so instead of guessing.
const MIN_SETS_PER_WINDOW = 5;
const MIN_TOTAL_APPEARANCES = 3;
const UP_RATIO = 1.25;
const DOWN_RATIO = 0.8;

export function analyzeArtist(sets: Tracklist[], artist: string, options: ArtistOptions): ArtistReport {
  const top = options.top ?? 10;
  const recentFrom = monthsBefore(options.today, options.recentMonths ?? 6);
  const target = normalizeName(artist);
  const isOwnSet = (set: Tracklist) => set.djs.some((dj) => normalizeName(dj) === target);
  const hasArtist = (set: Tracklist) => set.tracks.some((t) => creditsArtist(t, artist));

  const inRange = filterSince(sets, options.since);
  // A DJ playing their own tracks says little about demand, so usage counts other DJs only.
  const othersSets = inRange.filter((s) => !isOwnSet(s));
  const ownSets = inRange.filter(isOwnSet);

  const windowStats = (from: string, to: string): WindowStats => {
    const inWindow = filterBetween(othersSets, from, to);
    const withArtist = inWindow.filter(hasArtist).length;
    return {
      from,
      to,
      sets: inWindow.length,
      setsWithArtist: withArtist,
      share: inWindow.length === 0 ? 0 : withArtist / inWindow.length,
    };
  };
  // "to" is exclusive, so push it a day past today to include sets from today.
  const recent = windowStats(recentFrom, dayAfter(options.today));
  const earlier = windowStats(options.since, recentFrom);

  return {
    artist,
    since: options.since,
    trend: { direction: trendDirection(recent, earlier), recent, earlier },
    monthly: monthlyBuckets(othersSets, hasArtist),
    topTracksRecent: topTracks(filterSince(othersSets, recentFrom), artist, top),
    ownSets: ownSets.length,
    mostPlayedArtists: playedArtists(ownSets, target, top),
  };
}

/** Compare share of sets, not raw counts: raw counts mostly reflect how many sets you cached. */
export function trendDirection(recent: WindowStats, earlier: WindowStats): TrendDirection {
  if (recent.sets < MIN_SETS_PER_WINDOW || earlier.sets < MIN_SETS_PER_WINDOW) return "not enough data";
  if (recent.setsWithArtist + earlier.setsWithArtist < MIN_TOTAL_APPEARANCES) return "not enough data";
  if (earlier.share === 0) return "up";
  const ratio = recent.share / earlier.share;
  if (ratio >= UP_RATIO) return "up";
  if (ratio <= DOWN_RATIO) return "down";
  return "flat";
}

function monthlyBuckets(sets: Tracklist[], hasArtist: (s: Tracklist) => boolean): MonthBucket[] {
  const buckets = new Map<string, MonthBucket>();
  for (const set of sets) {
    const month = set.date.slice(0, 7);
    const bucket = buckets.get(month) ?? { month, sets: 0, setsWithArtist: 0 };
    bucket.sets++;
    if (hasArtist(set)) bucket.setsWithArtist++;
    buckets.set(month, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function topTracks(sets: Tracklist[], artist: string, top: number): Ranked[] {
  const counter = new Counter();
  for (const set of sets) {
    const seen = new Map<string, string>();
    for (const track of set.tracks) {
      if (creditsArtist(track, artist)) seen.set(songKey(track), displayName(track));
    }
    for (const [key, label] of seen) counter.add(key, label);
  }
  return counter.top(top);
}

function playedArtists(ownSets: Tracklist[], target: string, top: number): Ranked[] {
  const counter = new Counter();
  for (const set of ownSets) {
    // A track played twice in one set counts once.
    const unique = new Map(set.tracks.map((t) => [songKey(t), t]));
    for (const track of unique.values()) {
      const names = new Map(creditedArtists(track).map((a) => [normalizeName(a), a]));
      for (const [key, name] of names) {
        if (key !== target) counter.add(key, name);
      }
    }
  }
  return counter.top(top);
}

function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
