// Turning messy artist/title strings into comparable keys.
// Tracklists are typed by hand by many different people, so the same song shows up as
// "Fisher - Losing It", "FISHER - Losing It" or "Fisher - Losing  It". These helpers
// make those compare equal.

import type { Track } from "./model.ts";

/** Lowercase, strip accents, unify "feat."/"ft.", collapse whitespace. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents: "Holaláa" -> "Holalaa"
    .toLowerCase()
    .replace(/\bfeat\.?\s/g, "ft. ")
    .replace(/\bft\s/g, "ft. ")
    .replace(/\s+/g, " ")
    .trim();
}

function isIdPart(s: string): boolean {
  return normalizeName(s) === "id";
}

/** True for unreleased/unknown tracks: "ID - ID", "Fisher - ID", "ID - Losing It". */
export function isId(track: Track): boolean {
  return isIdPart(track.artist) || isIdPart(track.title);
}

/** "Artist - Title" for display. */
export function displayName(track: Track): string {
  return `${track.artist} - ${track.title}`;
}

/**
 * Key that identifies a song regardless of capitalization or spacing.
 * We key on the name rather than trackId because 1001Tracklists leaves trackId
 * off some rows, and keying on it would split one song into two buckets.
 */
export function songKey(track: Track): string {
  return `${normalizeName(track.artist)} - ${normalizeName(track.title)}`;
}

// " & ", ", ", " x ", " vs. ", " ft. " all separate collaborators.
// Word separators need spaces on both sides so "Malcolm X" stays one artist.
const ARTIST_SEPARATOR = /\s*[,&]\s*|\s+(?:x|vs\.?|ft\.)\s+/i;

/** "A & B ft. C" -> ["A", "B", "C"]. */
export function splitArtists(artist: string): string[] {
  return artist
    .replace(/\bfeat\.?\s/gi, "ft. ")
    .split(ARTIST_SEPARATOR)
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && !isIdPart(a));
}

// "(Lello Russo & Alex Rai Remix)", "(Mousse T Feel Much Better Remix)" is not a clean
// remixer credit, but we only use this to add names, so an over-long match just fails
// to match anyone rather than causing a wrong count.
const REMIX_CREDIT = /\(([^()]+?)\s+(?:remix|edit|rework|bootleg|flip|vip)\)/gi;

/** Remixers credited in the title, e.g. "Song (A & B Remix)" -> ["A", "B"]. */
export function remixers(title: string): string[] {
  const names: string[] = [];
  for (const match of title.matchAll(REMIX_CREDIT)) {
    names.push(...splitArtists(match[1] ?? ""));
  }
  return names;
}

/** Everyone who can claim this track: main artists plus remixers. */
export function creditedArtists(track: Track): string[] {
  return [...splitArtists(track.artist), ...remixers(track.title)];
}

/** Does `track` credit `artist` (as main artist or remixer)? */
export function creditsArtist(track: Track, artist: string): boolean {
  const target = normalizeName(artist);
  return creditedArtists(track).some((a) => normalizeName(a) === target);
}

/**
 * Parse what the user typed for song mode. Accepts "Artist - Title" or a
 * 1001Tracklists track URL (/track/<id>/...).
 */
export interface SongQuery {
  key?: string;
  trackId?: string;
  label: string;
}

export function parseSongQuery(input: string): SongQuery {
  const urlMatch = input.match(/\/track\/([a-z0-9]+)\//i);
  if (urlMatch) {
    return { trackId: urlMatch[1], label: input };
  }
  const dash = input.indexOf(" - ");
  if (dash === -1) {
    throw new Error(`Song must look like "Artist - Title" (got "${input}")`);
  }
  const track = { artist: input.slice(0, dash), title: input.slice(dash + 3) };
  return { key: songKey(track), label: displayName(track) };
}

export function matchesSong(track: Track, query: SongQuery): boolean {
  if (query.trackId !== undefined && track.trackId === query.trackId) return true;
  return query.key !== undefined && songKey(track) === query.key;
}
