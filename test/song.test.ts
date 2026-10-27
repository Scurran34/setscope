import { describe, expect, it } from "vitest";
import { analyzeSong, playedAlongside } from "../src/analysis/song.ts";
import { parseSongQuery } from "../src/normalize.ts";
import { makeSet, SINCE, songSets } from "./fixtures/sets.ts";

describe("analyzeSong", () => {
  const report = analyzeSong(songSets, parseSongQuery("Nova - Pulse"), { since: SINCE });

  it("ignores sets older than the cutoff", () => {
    expect(report.setsConsidered).toBe(5); // s1-s4, s6 (s5 is from 2024)
    expect(report.setsWithSong).toBe(4); // s1-s4
  });

  it("ranks DJs by number of sets, crediting every DJ in a B2B", () => {
    expect(report.topDjs).toEqual([
      { name: "DJ Alpha", count: 3 },
      { name: "DJ Beta", count: 1 },
      { name: "DJ Gamma", count: 1 },
    ]);
  });

  it("finds IDs that recur, grouped by trackId, partial name, or context", () => {
    expect(report.recurringIds).toEqual([
      { name: "ID - ID (played after Nova - Pulse)", count: 2 },
      { name: "ID - ID [1001TL abc123]", count: 2 },
      { name: "Nova - ID", count: 2 },
    ]);
  });

  it("counts co-played songs once per set and excludes the song itself", () => {
    expect(report.coPlayed).toEqual([
      { name: "Kite - Glow", count: 3 },
      { name: "Rook - Drift", count: 2 },
    ]);
  });

  it("matches by 1001Tracklists track URL", () => {
    const byUrl = analyzeSong(songSets, parseSongQuery("https://www.1001tracklists.com/track/abc123/x/index.html"), {
      since: SINCE,
    });
    expect(byUrl.setsWithSong).toBe(2); // s3, s4
  });

  it("respects --top", () => {
    const small = analyzeSong(songSets, parseSongQuery("Nova - Pulse"), { since: SINCE, top: 1 });
    expect(small.topDjs).toEqual([{ name: "DJ Alpha", count: 3 }]);
  });

  it("reports how the matched song is written in the sets", () => {
    expect(report.matchedAs).toEqual([
      { name: "Nova - Pulse", count: 3 },
      { name: "nova - pulse", count: 1 },
    ]);
    expect(report.suggestions).toEqual([]);
  });

  it("suggests same-title songs when the artist doesn't match", () => {
    const miss = analyzeSong(songSets, parseSongQuery("Somebody Else - Pulse"), { since: SINCE });
    expect(miss.setsWithSong).toBe(0);
    expect(miss.suggestions).toEqual([{ name: "Nova - Pulse", count: 4 }]);
  });

  it("returns empty lists when nobody played the song", () => {
    const none = analyzeSong(songSets, parseSongQuery("Nobody - Nothing"), { since: SINCE });
    expect(none.setsWithSong).toBe(0);
    expect(none.topDjs).toEqual([]);
    expect(none.coPlayed).toEqual([]);
  });
});

describe("playedAlongside", () => {
  // "Big - Hit" shares the most sets with Mine, but it's in every set; "Pair - Up" is
  // almost only ever played with Mine.
  const sets = [
    ...Array.from({ length: 4 }, (_, i) => makeSet(`w${i}`, "2026-09-01", [`DJ ${i}`], ["Mine - Song", "Big - Hit", "Pair - Up"])),
    makeSet("w4", "2026-09-01", ["DJ 4"], ["Mine - Song", "Big - Hit"]),
    ...Array.from({ length: 10 }, (_, i) => makeSet(`x${i}`, "2026-09-02", [`DJ x${i}`], ["Big - Hit", "Other - Thing"])),
  ];
  it("lists every song that shared 2+ sets, ranked by how much of its play is with this song", () => {
    expect(playedAlongside(sets, parseSongQuery("Mine - Song"), SINCE).map((r) => [r.name, r.together, r.everywhere])).toEqual([
      ["Pair - Up", 4, 4],
      ["Big - Hit", 5, 15],
    ]);
  });
  it("can rank by shared sets alone", () => {
    expect(playedAlongside(sets, parseSongQuery("Mine - Song"), SINCE, "count").map((r) => r.name)).toEqual(["Big - Hit", "Pair - Up"]);
  });
});
