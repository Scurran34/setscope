// Is this SoundCloud upload the song from the tracklists, a different version of it, or
// just something with a similar name?
//
// SoundCloud titles are typed by uploaders, so the same song shows up as
//   "Chris Stussy - Desire" (uploaded by a label),
//   "Desire" (uploaded by Chris Stussy himself),
//   "PREMIERE: Chris Stussy - Desire [Free Download]".
// We read each upload as artists + title + version, using the same version rules as
// the catalog (identity.ts), and compare. Nothing is linked automatically: the person
// confirms a candidate (or pastes a link) before it's saved.

import { versionOf, type VersionType } from "../catalog/identity.ts";
import { baseTitle, normalizeName, splitArtists } from "../normalize.ts";
import type { ScTrack } from "./client.ts";

export type MatchKind = "this" | "version" | "related";

export interface Candidate {
  track: ScTrack;
  kind: MatchKind;
  /** 0..1, how sure we are of `kind`. A guess, shown to the person, never auto-applied. */
  confidence: number;
  /** Why, in a few words ("same title and artist, different version"). */
  reason: string;
  /** How the upload was read. */
  read: UploadReading;
}

export interface UploadReading {
  artists: string[];
  base: string;
  versionType: VersionType;
  versionArtists?: string;
}

export interface SongRef {
  artist: string;
  title: string;
}

// "PREMIERE:", "Premiere |", "OUT NOW:" at the start of a title.
const PREFIX = /^\s*(premiere|premier|out now|free download|free dl|exclusive|preview|clip)\s*[:|-]\s*/i;
// Bracket groups that are promotion, not part of the title: "[Free Download]", "(OUT NOW)", "[LABEL123]".
const PROMO_GROUP = /\s*[([]\s*(?:free\s*(?:download|dl)|out now|premiere|preview|clip|forthcoming|exclusive|buy\s*=?\s*free\s*download|[A-Z]{2,}\d{2,})[^()[\]]*[)\]]/gi;

/** How we read an upload: "Artist - Title (X Remix)", or just "Title" by the uploader. */
export function readUpload(track: ScTrack): UploadReading {
  let title = track.title.replace(PREFIX, "").replace(PROMO_GROUP, "").trim();
  let artistText = track.uploader;
  const dash = title.search(/\s[-–—]\s/);
  if (dash !== -1) {
    artistText = title.slice(0, dash).trim();
    title = title.slice(dash + 3).trim();
  }
  const version = versionOf(title);
  const reading: UploadReading = {
    artists: splitArtists(artistText).map(normalizeName),
    base: baseTitle(version.base),
    versionType: version.type,
  };
  if (version.artists) reading.versionArtists = version.artists;
  return reading;
}

function sameNames(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return !a && !b;
  const x = splitArtists(a).map(normalizeName).sort();
  const y = splitArtists(b).map(normalizeName).sort();
  return x.length === y.length && x.every((name, i) => name === y[i]);
}

/** Classify one upload against a song from the tracklists. null = not related at all. */
export function classify(song: SongRef, track: ScTrack): Candidate | null {
  const ours = versionOf(song.title);
  const ourBase = baseTitle(ours.base);
  const ourArtists = splitArtists(song.artist).map(normalizeName);
  const read = readUpload(track);
  const uploader = normalizeName(track.uploader);

  const exactTitle = read.base === ourBase;
  const looseTitle = !exactTitle && ourBase.length >= 4 && (read.base.includes(ourBase) || (ourBase.includes(read.base) && read.base.length >= 4));
  // An artist matches if they're named in the upload, or they uploaded it themselves.
  const named = ourArtists.filter((a) => read.artists.includes(a) || uploader === a);
  const allNamed = ourArtists.length > 0 && named.length === ourArtists.length;
  const someNamed = named.length > 0;
  const sameVersion = read.versionType === ours.type && (ours.type === "original" || sameNames(read.versionArtists, ours.artists));

  const candidate = (kind: MatchKind, confidence: number, reason: string): Candidate => ({ track, kind, confidence, reason, read });

  if (exactTitle && someNamed && sameVersion) {
    return candidate("this", allNamed ? 0.9 : 0.75, allNamed ? "same title, artist and version" : "same title and version, some of the artists");
  }
  if (exactTitle && someNamed) return candidate("version", 0.8, describeVersion(read));
  if (exactTitle && read.versionType !== "original") {
    // "Desire (X Remix)" uploaded by X: probably a version of this song, but the original
    // artist isn't named, so it could be a different "Desire".
    const byRemixer = read.versionArtists !== undefined && splitArtists(read.versionArtists).map(normalizeName).includes(uploader);
    return candidate("version", byRemixer ? 0.55 : 0.4, `${describeVersion(read)}, original artist not named`);
  }
  if (exactTitle) return candidate("related", 0.3, "same title, different artist");
  if (looseTitle && someNamed) return candidate("related", 0.35, "similar title by the same artist");
  return null;
}

function describeVersion(read: UploadReading): string {
  if (read.versionType === "original") return "the original";
  return read.versionArtists ? `${read.versionType} by ${read.versionArtists}` : `a ${read.versionType}`;
}

const KIND_ORDER: Record<MatchKind, number> = { this: 0, version: 1, related: 2 };

/** Candidates for linking a song: best first, unrelated uploads dropped. */
export function songCandidates(song: SongRef, tracks: ScTrack[]): Candidate[] {
  return tracks
    .map((track, index) => ({ c: classify(song, track), index }))
    .filter((x): x is { c: Candidate; index: number } => x.c !== null)
    .sort((a, b) => KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] || b.c.confidence - a.c.confidence || a.index - b.index)
    .map((x) => x.c);
}

const REMIX_TYPES = new Set<VersionType>(["remix", "edit", "vip", "bootleg", "mashup", "rework"]);

export interface RemixFilters {
  /** Only remixes whose remixer (or uploader) contains this text. */
  remixer?: string;
  /** Uploader genre tags to keep; "Unknown" keeps uploads without one. */
  genres?: string[];
}

/** Uploads that are a remix/edit/bootleg... of this song's original, in SoundCloud's order. */
export function remixesOf(song: SongRef, tracks: ScTrack[], filters: RemixFilters = {}): Candidate[] {
  const original: SongRef = { artist: song.artist, title: versionOf(song.title).base };
  const remixer = filters.remixer ? normalizeName(filters.remixer) : "";
  const genres = filters.genres?.length ? new Set(filters.genres.map((g) => g.toLowerCase())) : undefined;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const track of tracks) {
    if (seen.has(track.urn)) continue;
    seen.add(track.urn);
    const c = classify(original, track);
    if (!c || c.kind !== "version" || !REMIX_TYPES.has(c.read.versionType)) continue;
    if (remixer && !normalizeName(`${c.read.versionArtists ?? ""} ${track.uploader}`).includes(remixer)) continue;
    if (genres && !genres.has(track.genre ? track.genre.toLowerCase() : "unknown")) continue;
    out.push(c);
  }
  return out;
}
