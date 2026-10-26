// Deciding which tracklist lines are "the same recording".
//
//   - "Riordan & Locky - Friction" and "riordan & locky - Friction (Extended Mix)" are one
//     track: extended/original/radio/club/dub mixes are the same recording.
//   - "Nova - Pulse (Kite Remix)" is its own track, a remix, linked to "Nova - Pulse".
//   - "ID - ID" and "Fisher - ID" are unidentified. Without 1001Tracklists' own track id,
//     each appearance is its own placeholder: two IDs with the same text are not
//     assumed to be the same song.

import type { Track } from "../model.ts";
import { baseTitle, isId, normalizeName, splitArtists } from "../normalize.ts";

export type VersionType = "original" | "remix" | "edit" | "vip" | "bootleg" | "mashup" | "rework" | "unknown";

export interface TrackIdentity {
  /** null for unidentified tracks: never merged by name. */
  identityKey: string | null;
  idStatus: "identified" | "unidentified";
  versionType: VersionType;
  /** Who made the version: "Kite" in "(Kite Remix)". */
  versionArtists?: string;
  /** identityKey of the original recording, for versions. */
  originalKey?: string;
  mainArtists: string[];
  remixers: string[];
}

// The last "( ... )" or "[ ... ]" group in a title, which is where versions are named.
const LAST_GROUP = /\s*[([]([^()[\]]+)[)\]]\s*$/;

const VERSION_WORDS: [VersionType, RegExp][] = [
  ["vip", /\bvip\b/i],
  ["bootleg", /\b(bootleg|flip)\b/i],
  ["mashup", /\bmash-?up\b/i],
  ["rework", /\bre-?work\b/i],
  ["remix", /\b(remix|rmx|re-?mix)\b/i],
  ["edit", /\bedit\b/i],
];

// Versions that are the same recording as the original.
const SAME_RECORDING = /^(extended|original|radio|club|dub)( mix| edit| version)?$/i;

/** Which version a title names, who made it, and the title without that part. */
export function versionOf(title: string): { type: VersionType; artists?: string; base: string } {
  const match = title.match(LAST_GROUP);
  if (!match) return { type: "original", base: title };
  const inside = match[1]!.trim();
  if (SAME_RECORDING.test(inside)) return { type: "original", base: title.slice(0, match.index).trim() };
  for (const [type, word] of VERSION_WORDS) {
    if (word.test(inside)) {
      const artists = inside.replace(word, "").replace(/\b(mix|version)\b/gi, "").replace(/\s+/g, " ").trim();
      const result: { type: VersionType; artists?: string; base: string } = { type, base: title.slice(0, match.index).trim() };
      if (artists) result.artists = artists;
      return result;
    }
  }
  // "(feat. X)", "(Interlude)" and the like: part of the original's title.
  return { type: "original", base: title };
}

export function identify(track: Track): TrackIdentity {
  const mainArtists = splitArtists(track.artist);
  const version = versionOf(track.title);
  const remixers = version.artists ? splitArtists(version.artists) : [];
  const key = `${normalizeName(track.artist)} - ${baseTitle(track.title)}`;
  const identity: TrackIdentity = {
    identityKey: isId(track) ? null : key,
    idStatus: isId(track) ? "unidentified" : "identified",
    versionType: version.type,
    mainArtists,
    remixers,
  };
  if (version.artists) identity.versionArtists = version.artists;
  if (version.type !== "original" && !isId(track)) {
    identity.originalKey = `${normalizeName(track.artist)} - ${baseTitle(version.base)}`;
  }
  return identity;
}
