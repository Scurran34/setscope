import { describe, expect, it } from "vitest";
import { artistProfile } from "../src/analysis/profile.ts";
import type { Tracklist } from "../src/model.ts";
import { makeSet, SINCE } from "./fixtures/sets.ts";

const withCard = (set: Tracklist): Tracklist => ({
  ...set,
  djProfiles: [{ name: "KITE", page: "https://www.1001tracklists.com/artist/kite/tracklists.html", country: "France", links: [{ label: "SoundCloud", url: "https://soundcloud.com/kite" }] }],
});

const sets: Tracklist[] = [
  withCard(makeSet("own1", "2026-09-20", ["KITE"], ["Rook - Drift", "Kite - Glow"])),
  makeSet("o1", "2026-09-10", ["DJ A"], ["Kite - Glow", "Kite - Glow", "Nova - Pulse (Kite Remix)"]),
  makeSet("o2", "2026-08-01", ["DJ B"], ["Kite & Rook - Ember"]),
  makeSet("o3", "2026-07-01", ["DJ C"], ["Nobody - Else"]),
  makeSet("old", "2020-01-01", ["DJ D"], ["Kite - Glow"]),
].map((set) => ({ ...set, tracks: set.tracks.map((t) => (t.artist.startsWith("Kite") ? { ...t, genre: "House", label: "KITE RECORDS" } : t)) }));

describe("artistProfile", () => {
  const p = artistProfile(sets, "kite", SINCE);

  it("takes who they are from their DJ card", () => {
    expect(p).toMatchObject({
      name: "Kite",
      page: "https://www.1001tracklists.com/artist/kite/tracklists.html",
      country: "France",
      links: [{ label: "SoundCloud", url: "https://soundcloud.com/kite" }],
    });
  });

  it("lists their sets and counts other DJs' sets that play them", () => {
    expect(p.ownSets.map((s) => s.id)).toEqual(["own1"]);
    expect(p.playedBy).toBe(2); // o1, o2 (o3 doesn't, own1 is theirs, old is out of range)
    expect(p.lastSeen).toBe("2026-09-20");
  });

  it("lists their songs, collabs and remixes, most played first, once per set", () => {
    expect(p.songs).toEqual([
      { name: "Kite - Glow", sets: 2, lastPlayed: "2026-09-20", genre: "House" },
      { name: "Nova - Pulse (Kite Remix)", sets: 1, lastPlayed: "2026-09-10" },
      { name: "Kite & Rook - Ember", sets: 1, lastPlayed: "2026-08-01", genre: "House" },
    ]);
    expect(p.labels).toEqual([{ name: "KITE RECORDS", count: 3 }]);
  });

  it("still works for someone with no card or sets", () => {
    expect(artistProfile(sets, "Nobody", SINCE)).toMatchObject({ name: "Nobody", links: [], ownSets: [], playedBy: 1 });
  });
});
