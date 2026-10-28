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

export type CreditRole = "main" | "featured" | "remixer" | "mashup_component";

/** Someone credited on a recording, and how. */
export interface Credit {
  name: string;
  role: CreditRole;
}

const FEATURING = /\s(?:ft\.?|feat\.?|featuring)\s/i;
const VS = /\svs\.?\s/i;
/** "Disturbia X Zombie Nation X Pump It Up": song titles joined with a capital X. */
const MASHUP_X = /\S\sX\s\S/;

/**
 * Who made this recording, from how the tracklist line is written:
 *   "A & B - Title"                    A, B: main
 *   "A ft. B - Title"                  A: main, B: featured (vocalists are written this way too)
 *   "A - Title (C Remix)"              C: remixer (also edits, bootlegs, reworks, VIPs)
 *   "A vs. B - X vs. Y (C Edit)"       A, B: mashup_component (their songs are in it), C: remixer
 *   "A vs. B - X X Y"                  also a mashup (titles joined with "X"): A, B mashup_component
 *   "A vs. B - Title"                  a collaboration: A, B main (a mashup has "vs." or "X" in the title too)
 * The source doesn't say who was sampled or who sang when it isn't marked "ft.", so
 * those roles are never guessed.
 */
export function credits(track: Track, oneAct: string[] = []): Credit[] {
  const version = versionOf(track.title);
  // A mashup: called one, or "vs." in the title, or "A vs. B - X X Y" (titles joined by "X").
  const mashup = version.type === "mashup" || VS.test(version.base) || (VS.test(track.artist) && MASHUP_X.test(version.base));
  // Names like "Cause & Affect" are one act when 1001Tracklists gives them their own
  // page (passed in as `oneAct`, plus any linked as one name on this line): don't split those.
  const whole = [...new Set([...oneAct, ...Object.keys(track.artistPages ?? {})])].filter((n) => /\s(?:&|x|vs\.?|pres\.?|\/)\s|,\s/i.test(n));
  const split = (text: string) => splitKeeping(text, whole);
  const ftAt = track.artist.search(FEATURING);
  const lead = split(ftAt === -1 ? track.artist : track.artist.slice(0, ftAt));
  const featured = ftAt === -1 ? [] : split(track.artist.slice(ftAt).replace(/^\s*(?:ft\.?|feat\.?|featuring)\s/i, ""));
  const out: Credit[] = [];
  const seen = new Set<string>();
  const add = (name: string, role: CreditRole) => {
    const key = normalizeName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name, role });
  };
  for (const name of lead) add(name, mashup ? "mashup_component" : "main");
  for (const name of featured) add(name, mashup ? "mashup_component" : "featured");
  if (version.artists) for (const name of split(version.artists)) add(name, "remixer");
  return out;
}

/** splitArtists, but names in `whole` stay in one piece. */
function splitKeeping(text: string, whole: string[]): string[] {
  let marked = text;
  const kept: string[] = [];
  for (const name of [...whole].sort((a, b) => b.length - a.length)) {
    const at = marked.toLowerCase().indexOf(name.toLowerCase());
    if (at === -1) continue;
    kept.push(marked.slice(at, at + name.length));
    marked = `${marked.slice(0, at)}\u0000${kept.length - 1}\u0000${marked.slice(at + name.length)}`;
  }
  return splitArtists(marked).map((part) => part.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!));
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
