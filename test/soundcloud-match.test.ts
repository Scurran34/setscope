// Reading SoundCloud uploads against tracklist songs. All uploads here are made up for
// the tests (TEST FIXTURE, not real SoundCloud data).
import { describe, expect, it } from "vitest";
import type { ScTrack } from "../src/soundcloud/client.ts";
import { classify, readUpload, remixesOf, songCandidates } from "../src/soundcloud/match.ts";

let next = 1;
const upload = (title: string, uploader: string, genre?: string): ScTrack => {
  const id = next++;
  const track: ScTrack = { urn: `soundcloud:tracks:${id}`, title, uploader, permalink: `https://soundcloud.com/x/${id}`, tags: [], durationMs: 1, access: "playable", embeddable: true };
  if (genre) track.genre = genre;
  return track;
};

const song = { artist: "Nova & Kite", title: "Pulse" };

describe("readUpload", () => {
  it("reads 'Artist - Title (Version)'", () => {
    expect(readUpload(upload("Nova & Kite - Pulse (Reed Remix)", "Some Label"))).toEqual({ artists: ["nova", "kite"], base: "pulse", versionType: "remix", versionArtists: "Reed" });
  });
  it("uses the uploader when the title has no artist", () => {
    expect(readUpload(upload("Pulse (Extended Mix)", "Nova"))).toEqual({ artists: ["nova"], base: "pulse", versionType: "original" });
  });
  it("drops promotion around the title", () => {
    expect(readUpload(upload("PREMIERE: Nova - Pulse [Free Download]", "Blog"))).toMatchObject({ artists: ["nova"], base: "pulse", versionType: "original" });
    expect(readUpload(upload("Nova - Pulse [ABC123]", "Label"))).toMatchObject({ base: "pulse", versionType: "original" });
  });
});

describe("classify", () => {
  it("same title, artists and version: this song", () => {
    expect(classify(song, upload("Nova & Kite - Pulse (Original Mix)", "Label"))).toMatchObject({ kind: "this", confidence: 0.9 });
    expect(classify(song, upload("Pulse", "Nova"))).toMatchObject({ kind: "this", confidence: 0.75 });
  });
  it("a remix of it: another version", () => {
    expect(classify(song, upload("Nova & Kite - Pulse (Reed Remix)", "Reed"))).toMatchObject({ kind: "version", reason: "remix by Reed" });
  });
  it("a remix by its uploader without the original artist: a less sure version", () => {
    expect(classify(song, upload("Pulse (Reed Remix)", "Reed"))).toMatchObject({ kind: "version", confidence: 0.55 });
  });
  it("matches remixes by remixer", () => {
    const remix = { artist: "Nova", title: "Pulse (Reed Remix)" };
    expect(classify(remix, upload("Nova - Pulse (Reed Remix)", "Label"))).toMatchObject({ kind: "this" });
    expect(classify(remix, upload("Nova - Pulse (Other Remix)", "Label"))).toMatchObject({ kind: "version" });
    expect(classify(remix, upload("Nova - Pulse", "Label"))).toMatchObject({ kind: "version", reason: "the original" });
  });
  it("same title by someone else: related; unrelated: dropped", () => {
    expect(classify(song, upload("Pulse", "Someone Else"))).toMatchObject({ kind: "related" });
    expect(classify(song, upload("Totally Different", "Nova"))).toBeNull();
  });
});

describe("songCandidates", () => {
  it("puts this song first, then versions, then related", () => {
    const list = songCandidates(song, [upload("Pulse", "Someone Else"), upload("Nova - Pulse (Reed Remix)", "Reed"), upload("Nova & Kite - Pulse", "Label"), upload("Nope", "Nope")]);
    expect(list.map((c) => c.kind)).toEqual(["this", "version", "related"]);
  });
});

describe("remixesOf", () => {
  const results = [
    upload("Nova & Kite - Pulse (Reed Remix)", "Reed", "House"),
    upload("Nova & Kite - Pulse (Mara Bootleg)", "Mara", "Techno"),
    upload("Nova & Kite - Pulse (Lux Edit)", "Lux"),
    upload("Nova & Kite - Pulse", "Label", "House"),
    upload("Pulse", "Someone Else", "House"),
  ];
  it("keeps only versions of the song", () => {
    expect(remixesOf(song, results).map((c) => c.read.versionArtists)).toEqual(["Reed", "Mara", "Lux"]);
  });
  it("starts from the original when the song is itself a remix", () => {
    expect(remixesOf({ artist: "Nova & Kite", title: "Pulse (Reed Remix)" }, results)).toHaveLength(3);
  });
  it("filters by remixer and genre, with Unknown for no genre", () => {
    expect(remixesOf(song, results, { remixer: "mar" }).map((c) => c.read.versionArtists)).toEqual(["Mara"]);
    expect(remixesOf(song, results, { genres: ["house", "Unknown"] }).map((c) => c.read.versionArtists)).toEqual(["Reed", "Lux"]);
  });
  it("skips repeats", () => {
    expect(remixesOf(song, [results[0]!, results[0]!])).toHaveLength(1);
  });
});
