import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artistChart, creditScore, eventOf, isFeatured, listSets, setDetail, songChart, trendOf, windowFor } from "../src/catalog/browse.ts";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { normalizeName } from "../src/normalize.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";
import { makeSet } from "./fixtures/sets.ts";

const TODAY = "2026-10-25";

describe("chart windows and trends", () => {
  it("counts back from today, with an equally long window before it", () => {
    expect(windowFor("week", TODAY)).toEqual({ from: "2026-10-19", prevFrom: "2026-10-12" });
    expect(windowFor("month", TODAY)).toEqual({ from: "2026-09-26", prevFrom: "2026-08-27" });
    expect(windowFor("all", TODAY)).toEqual({ from: null, prevFrom: null });
  });

  it("compares share of sets, and stays quiet without enough data", () => {
    expect(trendOf(5, 5, 3, 5)).toBe(67); // 100% of sets vs 60%
    expect(trendOf(5, 10, 5, 5)).toBe(-50); // same count, but twice as many sets collected
    expect(trendOf(3, 5, 0, 5)).toBe("new");
    expect(trendOf(1, 5, 0, 5)).toBeNull(); // one play isn't "new"
    expect(trendOf(5, 5, 2, 5)).toBeNull(); // too few earlier plays for a percentage
    expect(trendOf(5, 4, 3, 5)).toBeNull(); // too few sets in a window
  });

  it("knows when an artist is only featured", () => {
    expect(isFeatured("Dom Dolla ft. Clementine Douglas", "Clementine Douglas")).toBe(true);
    expect(isFeatured("Dom Dolla ft. Clementine Douglas", "Dom Dolla")).toBe(false);
    expect(isFeatured("MK & Clementine Douglas", "Clementine Douglas")).toBe(false);
    expect(isFeatured("MK & Sonny Fodera feat. Clementine Douglas", "clementine douglas")).toBe(true);
  });

  it("credits breadth over one hit, and features at half", () => {
    const plays = (sets: [number, boolean][], songs: number[]) => ({ sets: new Map(sets), songs: new Map(songs.map((n, i) => [i, n])) });
    const tenSets = Array.from({ length: 10 }, (_, i): [number, boolean] => [i, false]);
    expect(creditScore(plays(tenSets, [10]))).toBe(5); // one song in every set: halved
    expect(creditScore(plays(tenSets, [2, 2, 2, 2, 2]))).toBe(9); // five songs, 2 sets each
    expect(creditScore(plays(tenSets.map(([id]) => [id, true]), [2, 2, 2, 2, 2]))).toBe(4.5); // only ever featured
  });

  it("reads the event from a set title", () => {
    expect(eventOf("Arielle Free - BBC Radio 1 Dance Chart 2026-10-26")).toBe("BBC Radio 1 Dance Chart");
    expect(eventOf("Trimtone & Mousse T - Love To Be... Radio 319 2026-10-25")).toBe("Love To Be... Radio 319");
    expect(eventOf("Just A Title")).toBe("Just A Title");
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)("browsing the catalog", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await freshSchema("browse");
    const catalog = new PgCatalog(pool);
    // Earlier week (Oct 12-18): Nova - Pulse in 3 of 5 sets, Rook - Drift in all 5.
    for (let i = 0; i < 5; i++) {
      await catalog.save(makeSet(`p${i}`, `2026-10-1${2 + i}`, [`DJ p${i}`], i < 3 ? ["Nova - Pulse", "Rook - Drift"] : ["Rook - Drift"]), "");
    }
    // This week (Oct 19-25): Nova in all 5, Kite - Glow (tagged Techno) in 3, Rook in 2, plus an ID.
    for (let i = 0; i < 5; i++) {
      const tracks = ["Nova - Pulse", "ID - ID", ...(i < 3 ? ["Kite - Glow"] : []), ...(i < 2 ? ["Rook - Drift"] : [])];
      const set = makeSet(`c${i}`, `2026-10-${19 + i}`, [`DJ c${i}`], tracks);
      for (const t of set.tracks) if (t.artist === "Kite") t.genre = "Techno";
      await catalog.save(set, "");
    }
    // Performed long ago (collected now): counts for its own date, not today.
    await catalog.save(makeSet("old", "2025-01-01", ["DJ Old"], ["Nova - Pulse", "Old - Song"]), "");
  });
  afterAll(async () => pool?.end());

  it("ranks songs by unique sets in the window, by performance date, with trends", async () => {
    const week = await songChart(pool, { period: "week", page: 1, pageSize: 10, today: TODAY });
    expect(week.items.map((s) => [s.rank, `${s.artist} - ${s.title}`, s.sets, s.djs, s.trend])).toEqual([
      [1, "Nova - Pulse", 5, 5, 67],
      [2, "Kite - Glow", 3, 3, "new"],
      [3, "Rook - Drift", 2, 2, -60],
    ]);
    expect(week.setsInWindow).toBe(5);
    expect(week.items[1]!.genre).toBe("Techno");
  });

  it("all time includes old performances, never IDs, and pages stably", async () => {
    const all = await songChart(pool, { period: "all", page: 1, pageSize: 10, today: TODAY });
    expect(all.items.map((s) => [s.title, s.sets, s.trend])).toEqual([
      ["Pulse", 9, null],
      ["Drift", 7, null],
      ["Glow", 3, null],
      ["Song", 1, null],
    ]);
    const page2 = await songChart(pool, { period: "all", page: 2, pageSize: 2, today: TODAY });
    expect(page2).toMatchObject({ total: 4, pages: 2, page: 2 });
    expect(page2.items.map((s) => [s.rank, s.title])).toEqual([[3, "Glow"], [4, "Song"]]);
  });

  it("filters by genre and by search text", async () => {
    expect((await songChart(pool, { period: "all", genre: "Techno", page: 1, pageSize: 10, today: TODAY })).items.map((s) => s.title)).toEqual(["Glow"]);
    expect((await songChart(pool, { period: "all", q: "ROOK", page: 1, pageSize: 10, today: TODAY })).items.map((s) => s.title)).toEqual(["Drift"]);
    expect((await songChart(pool, { period: "all", q: "100%_", page: 1, pageSize: 10, today: TODAY })).items).toEqual([]);
  });

  it("ranks artists by sets that played them, and can keep only those with photos", async () => {
    const week = await artistChart(pool, { period: "week", page: 1, pageSize: 10, today: TODAY });
    expect(week.items.map((a) => [a.name, a.playedIn, a.songs, a.score])).toEqual([
      ["Nova", 5, 1, 2.5],
      ["Kite", 3, 1, 1.5],
      ["Rook", 2, 1, 1],
    ]);
    // Rook's own set full of Rook songs: his own picks don't raise his ranking.
    await new PgCatalog(pool).save(makeSet("rook", "2026-10-24", ["Rook"], ["Rook - Drift", "Rook - Two", "Rook - Three"]), "");
    const withOwnSet = await artistChart(pool, { period: "week", page: 1, pageSize: 10, today: TODAY });
    expect(withOwnSet.items.find((a) => a.name === "Rook")).toMatchObject({ playedIn: 2, songs: 1, score: 1, ownSets: 1 });
    await pool.query("delete from sets where source_id = 'rook'");
    await pool.query("update artists set image_url = 'https://example.test/kite.jpg' where name_key = 'kite'");
    const photos = await artistChart(pool, { period: "week", page: 1, pageSize: 10, today: TODAY, withPhoto: true });
    expect(photos.items.map((a) => [a.rank, a.name, a.image])).toEqual([[1, "Kite", "https://example.test/kite.jpg"]]);
  });

  it("lists sets newest first, filtered by DJ, year and text", async () => {
    const all = await listSets(pool, { page: 1, pageSize: 3 }, normalizeName);
    expect(all.total).toBe(11);
    expect(all.items.map((s) => [s.id, s.date])).toEqual([["c4", "2026-10-23"], ["c3", "2026-10-22"], ["c2", "2026-10-21"]]);
    expect((await listSets(pool, { dj: "dj  C1", page: 1, pageSize: 10 }, normalizeName)).items.map((s) => s.id)).toEqual(["c1"]);
    expect((await listSets(pool, { year: 2025, page: 1, pageSize: 10 }, normalizeName)).items.map((s) => s.id)).toEqual(["old"]);
    expect((await listSets(pool, { q: "dj old", page: 1, pageSize: 10 }, normalizeName)).items.map((s) => s.id)).toEqual(["old"]);
    expect(all.items[0]).toMatchObject({ djs: [{ name: "DJ c4", image: null }], tracks: 2, ids: 1 });
  });

  it("gives a set's full tracklist in order, with IDs marked", async () => {
    const set = await setDetail(pool, "c0");
    expect(set?.lines.map((l) => [l.position, l.isId, l.song])).toEqual([
      [0, false, "Nova - Pulse"],
      [1, true, null],
      [2, false, "Kite - Glow"],
      [3, false, "Rook - Drift"],
    ]);
    expect(await setDetail(pool, "missing")).toBeUndefined();
  });
});
