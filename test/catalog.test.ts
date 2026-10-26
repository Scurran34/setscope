import { describe, expect, it } from "vitest";
import {
  correctArtist,
  correctSong,
  editDistance,
  searchArtists,
  searchSongs,
  wordScore,
} from "../src/analysis/catalog.ts";
import { analyzeSong } from "../src/analysis/song.ts";
import { parseSongQuery } from "../src/normalize.ts";
import { makeSet, SINCE, songSets } from "./fixtures/sets.ts";

const lpSets = [
  makeSet("lp1", "2026-03-20", ["Sarah Story"], ["L.P. Rhythm - How Ya Feelin'", "Kite - Glow", "CHRIS STASSY ft. Marz Fay - U Know Me"]),
  makeSet("cl1", "2026-03-21", ["Chris Lorenzo"], ["Chris Lake - Turn Off The Lights"]),
  makeSet("lp2", "2026-04-01", ["DJ Alpha"], ["L.P. Rhythm - How Ya Feelin'"]),
  makeSet("lp3", "2026-04-02", ["DJ Beta"], ["L.P. Rhythm - Other Song"]),
];

describe("editDistance", () => {
  it("counts single-letter edits, including swapped neighbors", () => {
    expect(editDistance("stussy", "stassy")).toBe(1);
    expect(editDistance("rythm", "rhythm")).toBe(1);
    expect(editDistance("feleing", "feeling")).toBe(1); // swap
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("wordScore", () => {
  it("counts typed words that start a word in the candidate", () => {
    expect(wordScore(["lp", "feel"], ["lp", "rhythm", "how", "ya", "feelin"])).toBe(1);
    expect(wordScore(["lp", "zzz"], ["lp", "rhythm"])).toBe(0.5);
    expect(wordScore([], ["x"])).toBe(0);
  });

  it("gives near spellings partial credit, but not short words", () => {
    expect(wordScore(["chris", "stussy"], ["chris", "stassy"])).toBeCloseTo(0.9);
    expect(wordScore(["stuss"], ["stassy"])).toBeCloseTo(0.8); // still typing, with a typo
    expect(wordScore(["ab"], ["ac"])).toBe(0);
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

describe("typos", () => {
  it("ranks the near spelling first in the dropdown", () => {
    expect(searchArtists(lpSets, "chris stussy", SINCE)[0]).toEqual({ name: "CHRIS STASSY", count: 1 });
    expect(searchArtists(lpSets, "lp rythm", SINCE)[0]).toEqual({ name: "L.P. Rhythm", count: 3 });
  });

  it("auto-corrects only when one cached name is clearly meant", () => {
    expect(correctArtist(lpSets, "chris stussy", SINCE)).toBe("CHRIS STASSY");
    expect(correctArtist(lpSets, "lp rythm", SINCE)).toBe("L.P. Rhythm");
    expect(correctSong(lpSets, "lp rythm - how ya feelin", SINCE)).toBe("L.P. Rhythm - How Ya Feelin'");
    expect(correctArtist(lpSets, "chris", SINCE)).toBeUndefined(); // three Chrises: ambiguous
    expect(correctArtist(lpSets, "nobody at all", SINCE)).toBeUndefined();
    expect(correctArtist(lpSets, "l.p. rhythm", SINCE)).toBeUndefined(); // already exact
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
