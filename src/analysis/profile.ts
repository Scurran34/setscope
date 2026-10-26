// An artist's profile page, built from the cached sets: who they are (from the DJ
// cards on set pages: country, picture, links), their own sets, and every song of
// theirs that turns up in sets.

import type { DjProfile, Ranked, SetSummary, Tracklist } from "../model.ts";
import { summarize } from "../model.ts";
import { creditsArtist, displayName, normalizeName, songKey, splitArtists } from "../normalize.ts";
import { Counter, filterSince } from "./common.ts";

export interface ArtistSong {
  name: string;
  /** Cached sets that play it (anyone's). */
  sets: number;
  lastPlayed: string;
  genre?: string;
}

export interface ArtistProfile {
  /** The most common spelling in the sets ("CHRIS STASSY", "L.P. Rhythm"). */
  name: string;
  /** Their 1001Tracklists page. */
  page?: string;
  country?: string;
  image?: string;
  links: { label: string; url: string }[];
  /** Sets they played, newest first. */
  ownSets: SetSummary[];
  /** Other DJs' sets that play at least one of their songs. */
  playedBy: number;
  /** Their songs (as artist or remixer), most played first. */
  songs: ArtistSong[];
  labels: Ranked[];
  genres: Ranked[];
  /** Most recent date they played a set or were played. */
  lastSeen?: string;
}

export function artistProfile(sets: Tracklist[], artist: string, since: string): ArtistProfile {
  const target = normalizeName(artist);
  const inRange = filterSince(sets, since).sort((a, b) => b.date.localeCompare(a.date));
  const spellings = new Counter();
  const isOwn = (set: Tracklist) => set.djs.some((dj) => normalizeName(dj) === target);

  // Their card: from the newest set they played. Their page: card, DJ link, or a track link.
  let card: DjProfile | undefined;
  let page: string | undefined;
  for (const set of inRange) {
    for (const dj of set.djs) if (normalizeName(dj) === target) spellings.add(dj);
    card ??= set.djProfiles?.find((p) => normalizeName(p.name) === target);
    for (const [name, url] of Object.entries(set.djPages ?? {})) if (normalizeName(name) === target) page ??= url;
    for (const t of set.tracks) {
      for (const [name, url] of Object.entries(t.artistPages ?? {})) if (normalizeName(name) === target) page ??= url;
    }
  }

  const songs = new Map<string, ArtistSong>();
  const songGenres = new Map<string, Counter>();
  const labels = new Counter();
  const genres = new Counter();
  let playedBy = 0;
  for (const set of inRange) {
    const theirs = set.tracks.filter((t) => creditsArtist(t, artist));
    if (theirs.length > 0 && !isOwn(set)) playedBy++;
    const seen = new Set<string>();
    for (const t of theirs) {
      for (const a of splitArtists(t.artist)) if (normalizeName(a) === target) spellings.add(a);
      const key = songKey(t);
      if (seen.has(key)) continue; // once per set
      seen.add(key);
      const song = songs.get(key) ?? { name: displayName(t), sets: 0, lastPlayed: set.date };
      song.sets++;
      songs.set(key, song);
      if (t.genre) {
        const counter = songGenres.get(key) ?? new Counter();
        counter.add(t.genre);
        songGenres.set(key, counter);
      }
      if (t.label) labels.add(normalizeName(t.label), t.label);
      if (t.genre) genres.add(t.genre);
    }
  }
  for (const [key, song] of songs) {
    const genre = songGenres.get(key)?.top(1)[0]?.name;
    if (genre) song.genre = genre;
  }

  const ownSets = inRange.filter(isOwn);
  const profile: ArtistProfile = {
    name: spellings.top(1)[0]?.name ?? artist,
    links: card?.links ?? [],
    ownSets: ownSets.map(summarize),
    playedBy,
    songs: [...songs.values()].sort((a, b) => b.sets - a.sets || b.lastPlayed.localeCompare(a.lastPlayed) || a.name.localeCompare(b.name)),
    labels: labels.top(8),
    genres: genres.top(5),
  };
  const pageUrl = card?.page ?? page;
  if (pageUrl) profile.page = pageUrl;
  if (card?.country) profile.country = card.country;
  if (card?.image) profile.image = card.image;
  const lastSeen = [ownSets[0]?.date, [...songs.values()].map((s) => s.lastPlayed).sort().at(-1)].filter(Boolean).sort().at(-1);
  if (lastSeen) profile.lastSeen = lastSeen;
  return profile;
}
