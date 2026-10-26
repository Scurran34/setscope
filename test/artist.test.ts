import { describe, expect, it } from "vitest";
import { analyzeArtist, trendDirection, type WindowStats } from "../src/analysis/artist.ts";
import { artistSets, SINCE, TODAY } from "./fixtures/sets.ts";

describe("analyzeArtist", () => {
  const report = analyzeArtist(artistSets, "Kite", { since: SINCE, today: TODAY });

  it("compares the recent window to the earlier one by share of sets", () => {
    expect(report.trend.recent).toMatchObject({ from: "2026-04-25", sets: 10, setsWithArtist: 5, share: 0.5 });
    expect(report.trend.earlier).toMatchObject({ from: SINCE, to: "2026-04-25", sets: 10, setsWithArtist: 1 });
    expect(report.trend.direction).toBe("up");
  });

  it("buckets usage by month, excluding the artist's own sets", () => {
    const may = report.monthly.find((m) => m.month === "2026-05");
    expect(may).toEqual({ month: "2026-05", sets: 2, setsWithArtist: 1 });
    expect(report.monthly.some((m) => m.month === "2026-09" && m.sets === 1)).toBe(true); // not own1
  });

  it("ranks the artist's tracks in the recent window, including collabs and remixes", () => {
    expect(report.topTracksRecent).toEqual([
      { name: "Kite - Glow", count: 3 },
      { name: "Kite & Rook - Ember", count: 1 },
      { name: "Nova - Pulse (Kite Remix)", count: 1 },
    ]);
  });

  it("ranks who the artist plays in their own sets, skipping themselves and old sets", () => {
    expect(report.ownSets).toBe(2);
    expect(report.mostPlayedArtists).toEqual([
      { name: "Rook", count: 3 }, // Drift (once per set), Haze, Tide
      { name: "Nova", count: 2 }, // Haze, Pulse
    ]);
  });
});

describe("trendDirection", () => {
  const w = (sets: number, withArtist: number): WindowStats => ({
    from: "",
    to: "",
    sets,
    setsWithArtist: withArtist,
    share: sets === 0 ? 0 : withArtist / sets,
  });

  it("refuses to call a trend on too few sets", () => {
    expect(trendDirection(w(4, 4), w(10, 1))).toBe("not enough data");
    expect(trendDirection(w(10, 1), w(10, 1))).toBe("not enough data");
  });

  it("calls up, down and flat from the share ratio", () => {
    expect(trendDirection(w(10, 5), w(10, 2))).toBe("up");
    expect(trendDirection(w(10, 2), w(10, 5))).toBe("down");
    expect(trendDirection(w(10, 3), w(10, 3))).toBe("flat");
  });

  it("treats appearing from zero as up", () => {
    expect(trendDirection(w(10, 3), w(10, 0))).toBe("up");
  });
});
