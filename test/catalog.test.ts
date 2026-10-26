import { describe, expect, it } from "vitest";
import { searchArtists, searchSongs, wordScore } from "../src/analysis/catalog.ts";
import { analyzeSong } from "../src/analysis/song.ts";
import { parseSongQuery } from "../src/normalize.ts";
import { makeSet, SINCE, songSets } from "./fixtures/sets.ts";

const lpSets = [
  makeSet("lp1", "2026-03-20", ["Sarah Story"], ["L.P. Rhythm - How Ya Feelin'", "Kite - Glow"]),
  makeSet("lp2", "2026-04-01", ["DJ Alpha"], ["L.P. Rhythm - How Ya Feelin'"]),
  makeSet("lp3", "2026-04-02", ["DJ Beta"], ["L.P. Rhythm - Other Song"]),
];

describe("wordScore", () => {
  it("counts typed words that start a word in the candidate", () => {
    expect(wordScore(["lp", "feel"], ["lp", "rhythm", "how", "ya", "feelin"])).toBe(1);
    expect(wordScore(["lp", "zzz"], ["lp", "rhythm"])).toBe(0.5);
    expect(wordScore([], ["x"])).toBe(0);
  });
});

describe("searchSongs", () => {
  it("finds songs despite punctuation and partial words, most-played first", () => {
    expect(searchSongs(lpSets, "lp rhythm feelin", SINCE)).toEqual([{ name: "L.P. Rhythm - How Ya Feelin'", count: 2 }]);
    expect(searchSongs(lpSets, "lp rhyth", SINCE)).toEqual([
      { name: "L.P. Rhythm - How Ya Feelin'", count: 2 },
      { name: "L.P. Rhythm - Other Song", count: 1 },
    ]);
  });

  it("suggests a same-title song when the artist is wrong", () => {
    expect(searchSongs(songSets, "Somebody Else - Pulse", SINCE)).toEqual([{ name: "Nova - Pulse", count: 4 }]);
  });

  it("ignores sets older than the cutoff", () => {
    expect(searchSongs(lpSets, "how ya feelin", "2026-03-25")).toEqual([{ name: "L.P. Rhythm - How Ya Feelin'", count: 1 }]);
  });
});

describe("searchArtists", () => {
  it("finds DJs and track artists", () => {
    expect(searchArtists(lpSets, "lp rhy", SINCE)).toEqual([{ name: "L.P. Rhythm", count: 3 }]);
    expect(searchArtists(lpSets, "sarah", SINCE)).toEqual([{ name: "Sarah Story", count: 1 }]);
  });
});

describe("song lookups with punctuation", () => {
  it("matches 'lp rhythm - how ya feelin' to the cached spelling", () => {
    const report = analyzeSong(lpSets, parseSongQuery("lp rhythm - how ya feelin"), { since: SINCE });
    expect(report.setsWithSong).toBe(2);
    expect(report.matchedAs).toEqual([{ name: "L.P. Rhythm - How Ya Feelin'", count: 2 }]);
  });

  it("offers 'Did you mean' from the cache when nothing matches", () => {
    const report = analyzeSong(lpSets, parseSongQuery("LP Rhythm - How You Feeling"), { since: SINCE });
    expect(report.setsWithSong).toBe(0);
    expect(report.suggestions[0]).toEqual({ name: "L.P. Rhythm - How Ya Feelin'", count: 2 });
  });
});
