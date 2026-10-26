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
    .replace(/['’`´.]/g, "") // "L.P. Rhythm" -> "lp rhythm", "Feelin'" -> "feelin"
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

/** "Artist - Title" -> a Track, for turning a display name back into a song key. */
export function trackFromName(name: string): Track {
  const dash = name.indexOf(" - ");
  if (dash === -1) throw new Error(`Song must look like "Artist - Title" (got "${name}")`);
  return { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() };
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

// "(Extended Mix)", "(Original Mix)", "(Radio Edit)" are the same song for our purposes.
// Remixes by someone else, like "(Fisher Remix)", are not, so they're left alone.
const VERSION_SUFFIX = /\s*\((?:extended|original|radio|club|dub)(?: mix| edit| version)?\)\s*$/i;

/** Normalized title without version tags: "Friction (Extended Mix)" -> "friction". */
export function baseTitle(title: string): string {
  return normalizeName(title.replace(VERSION_SUFFIX, ""));
}

/** One way of reading "X - Y": who the user named, and the title. */
interface SongGuess {
  artists: string[];
  title: string;
}

/**
 * What the user typed for song mode: "Artist - Title", "Title - Artist", just a
 * title, or a 1001Tracklists track URL (/track/<id>/...).
 */
export interface SongQuery {
  label: string;
  trackId?: string;
  /** Both readings of "X - Y", since people type the two halves in either order. */
  guesses?: SongGuess[];
  /** No artist given: any song with this title matches. */
  titleOnly?: boolean;
}

export function parseSongQuery(input: string): SongQuery {
  const urlMatch = input.match(/\/track\/([a-z0-9]+)\//i);
  if (urlMatch) {
    return { trackId: urlMatch[1], label: input };
  }
  const dash = input.indexOf(" - ");
  if (dash === -1) {
    const title = input.trim();
    if (!title) throw new Error("Type a song title, or Artist - Title.");
    return { label: title, guesses: [{ artists: [], title: baseTitle(title) }], titleOnly: true };
  }
  const left = input.slice(0, dash).trim();
  const right = input.slice(dash + 3).trim();
  const guess = (artist: string, title: string): SongGuess => ({
    artists: splitArtists(artist).map(normalizeName),
    title: baseTitle(title),
  });
  return { label: `${left} - ${right}`, guesses: [guess(left, right), guess(right, left)] };
}

/**
 * A track matches if the titles agree (ignoring version tags) and every artist the
 * user typed is one of the track's main artists. So "Riordan - Friction" matches
 * "Riordan & Locky - Friction (Extended Mix)", but not "X - Friction (Riordan Remix)".
 * A title on its own matches that title by any artist.
 */
export function matchesSong(track: Track, query: SongQuery): boolean {
  if (query.trackId !== undefined && track.trackId === query.trackId) return true;
  if (!query.guesses || isId(track)) return false;
  const title = baseTitle(track.title);
  const mainArtists = new Set(splitArtists(track.artist).map(normalizeName));
  return query.guesses.some(
    (g) => g.title === title && g.artists.every((a) => mainArtists.has(a)),
  );
}
