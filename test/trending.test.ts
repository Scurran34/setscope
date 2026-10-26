import { describe, expect, it } from "vitest";
import { trending } from "../src/analysis/trending.ts";
import { makeSet, SINCE, TODAY } from "./fixtures/sets.ts";

// Recent window: the 30 days before TODAY (2026-09-25 onward). 10 sets each side.
const earlier = Array.from({ length: 10 }, (_, i) =>
  makeSet(`e${i}`, `2026-0${(i % 8) + 1}-10`, [`DJ E${i}`], [
    "Old - Classic",
    ...(i < 2 ? ["Rook - Drift"] : []), // 20% of earlier sets
  ]),
);
const recent = Array.from({ length: 10 }, (_, i) =>
  makeSet(`r${i}`, `2026-10-${String(i + 10).padStart(2, "0")}`, [`DJ R${i}`], [
    "Old - Classic",
    ...(i < 6 ? ["Rook - Drift"] : []), // 60% of recent sets: +200%
    ...(i < 4 ? ["Fresh - Debut"] : []), // brand new
    ...(i < 2 ? ["Rare - Blip"] : []), // too few to count
  ]),
);
// Rook's own set shouldn't count toward Rook as an artist.
const ownSet = makeSet("own", "2026-10-20", ["Rook"], ["Rook - Drift", "Rook - Tide"]);

describe("trending", () => {
  const report = trending([...earlier, ...recent, ownSet], { since: SINCE, today: TODAY });

  it("splits the cache into a recent window and the time before it", () => {
    expect(report).toMatchObject({ recentFrom: "2026-09-25", setsRecent: 11, setsEarlier: 10, enoughData: true });
  });

  it("lists songs whose share of sets rose, with the percent, and new ones as null", () => {
    expect(report.songs).toEqual([
      { name: "Rook - Drift", recent: 7, earlier: 2, changePercent: 218 },
      { name: "Fresh - Debut", recent: 4, earlier: 0, changePercent: null },
    ]);
  });

  it("does the same for artists, skipping their own sets", () => {
    // Fresh went from 0% to 36% of sets, Rook from 20% to 55%: Fresh gained more ground.
    expect(report.artists).toEqual([
      { name: "Fresh", recent: 4, earlier: 0, changePercent: null },
      { name: "Rook", recent: 6, earlier: 2, changePercent: 173 },
    ]);
  });

  it("says when there isn't enough data instead of guessing", () => {
    const thin = trending(recent.slice(0, 3), { since: SINCE, today: TODAY });
    expect(thin).toMatchObject({ enoughData: false, songs: [], artists: [] });
  });

  it("lets you choose the window", () => {
    expect(trending(recent, { since: SINCE, today: TODAY, recentDays: 14 }).recentFrom).toBe("2026-10-11");
  });
});
