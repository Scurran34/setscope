import { describe, expect, it } from "vitest";
import { monthsBefore } from "../src/analysis/common.ts";
import { creditedArtists, isId, normalizeName, parseSongQuery, songKey, splitArtists } from "../src/normalize.ts";

describe("normalize", () => {
  it("makes spelling variants of a name equal", () => {
    expect(normalizeName("  Karretero  ")).toBe(normalizeName("karretero"));
    expect(normalizeName("Holaláa")).toBe("holalaa");
    expect(songKey({ artist: "A feat. B", title: "X" })).toBe(songKey({ artist: "a ft. b", title: "x" }));
  });

  it("detects ID tracks", () => {
    expect(isId({ artist: "ID", title: "ID" })).toBe(true);
    expect(isId({ artist: "Fisher", title: "ID" })).toBe(true);
    expect(isId({ artist: "Idris Elba", title: "Idol" })).toBe(false);
  });

  it("splits collaborators but keeps names that contain separators as words", () => {
    expect(splitArtists("Roland Clark & Amy Alexander")).toEqual(["Roland Clark", "Amy Alexander"]);
    expect(splitArtists("Glovibes ft. Lana Parrilla")).toEqual(["Glovibes", "Lana Parrilla"]);
    expect(splitArtists("A x B vs. C, D")).toEqual(["A", "B", "C", "D"]);
    expect(splitArtists("Malcolm X")).toEqual(["Malcolm X"]);
  });

  it("credits remixers", () => {
    expect(creditedArtists({ artist: "Glovibes", title: "It's Over Now (Lello Russo & Alex Rai Remix)" })).toEqual([
      "Glovibes",
      "Lello Russo",
      "Alex Rai",
    ]);
  });

  it("rejects song input without an artist", () => {
    expect(() => parseSongQuery("Just A Title")).toThrow(/Artist - Title/);
  });

  it("shifts dates by months, clamping the day", () => {
    expect(monthsBefore("2026-10-25", 18)).toBe("2025-04-25");
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2026-01-15", 1)).toBe("2025-12-15");
  });
});
