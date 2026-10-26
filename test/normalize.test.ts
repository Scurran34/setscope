import { describe, expect, it } from "vitest";
import { monthsBefore } from "../src/analysis/common.ts";
import {
  creditedArtists,
  isId,
  matchesSong,
  normalizeName,
  parseSongQuery,
  songKey,
  splitArtists,
} from "../src/normalize.ts";

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

  it("matches a song when you name only some of its artists, in either order", () => {
    const friction = { artist: "Riordan & Locky", title: "Friction" };
    expect(matchesSong(friction, parseSongQuery("Riordan - Friction"))).toBe(true);
    expect(matchesSong(friction, parseSongQuery("Friction - Riordan"))).toBe(true);
    expect(matchesSong(friction, parseSongQuery("locky & riordan - friction"))).toBe(true);
    expect(matchesSong(friction, parseSongQuery("Riordan & Fisher - Friction"))).toBe(false);
    expect(matchesSong(friction, parseSongQuery("Riordan - Frictions"))).toBe(false);
  });

  it("ignores version tags but not someone else's remix", () => {
    const q = parseSongQuery("Riordan - Friction");
    expect(matchesSong({ artist: "Riordan", title: "Friction (Extended Mix)" }, q)).toBe(true);
    expect(matchesSong({ artist: "Fisher", title: "Friction (Riordan Remix)" }, q)).toBe(false);
  });

  it("never matches ID rows by name", () => {
    expect(matchesSong({ artist: "ID", title: "ID" }, parseSongQuery("ID - ID"))).toBe(false);
  });

  it("accepts a title on its own, matching it by any artist", () => {
    const q = parseSongQuery("friction (extended mix)");
    expect(q).toMatchObject({ titleOnly: true, label: "friction (extended mix)" });
    expect(matchesSong({ artist: "Riordan & Locky", title: "Friction" }, q)).toBe(true);
    expect(matchesSong({ artist: "Riordan", title: "Frictions" }, q)).toBe(false);
    expect(() => parseSongQuery("   ")).toThrow(/title/);
  });

  it("shifts dates by months, clamping the day", () => {
    expect(monthsBefore("2026-10-25", 18)).toBe("2025-04-25");
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2026-01-15", 1)).toBe("2025-12-15");
  });
});
