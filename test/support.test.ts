// DJ support analytics: the formulas on their own, then the rankings on a small catalog
// built here (names invented, so every expected number can be worked out by reading).

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, ownTracks, playsMost, resolveArtist } from "../src/catalog/discover.ts";
import { playedAlongside } from "../src/catalog/alongside.ts";
import { recommendSets } from "../src/catalog/recommend.ts";
import { markDuplicates, PgCatalog } from "../src/catalog/pg-catalog.ts";
import { songCards } from "../src/catalog/browse.ts";
import { djContribution, effectivePlays, goesWith, growth, scoreDeep, scoreMost, scoreNow, songSupport, SUPPORT } from "../src/catalog/support.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";
import { makeSet } from "./fixtures/sets.ts";

const TODAY = "2026-10-27";
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

describe("support formulas", () => {
  it("15 distinct DJs outrank one DJ with 30 comparable repeated plays", () => {
    expect(scoreMost(Array(15).fill(1))).toBe(15);
    expect(scoreMost([30])).toBe(1.5); // one DJ is worth at most one and a half
    expect(scoreMost(Array(15).fill(1))).toBeGreaterThan(scoreMost([30]));
    // Repeats reinforce breadth: same breadth, more repeats ranks higher.
    expect(scoreMost([4, 4])).toBeGreaterThan(scoreMost([1, 1]));
  });

  it("splits a back-to-back set's single selection between its DJs", () => {
    expect(scoreMost([1, 1], [0.5, 0.5])).toBe(1); // two DJs, one B2B set: one selection
    expect(scoreMost([1, 1], [0.5, 0.5])).toBeLessThan(scoreMost([1, 1])); // two separate sets
  });

  it("gives each DJ between 1 and 2 DJ-equivalents, with diminishing returns", () => {
    expect(djContribution(1)).toBe(1);
    expect(djContribution(4)).toBe(1.5);
    expect(djContribution(16)).toBe(2);
    expect(djContribution(1000)).toBe(2);
    expect(djContribution(2) - djContribution(1)).toBeGreaterThan(djContribution(3) - djContribution(2));
  });

  it("75 radio episodes of one show can't beat two DJs, and radio + festival is one DJ", () => {
    const episodes = Array.from({ length: 75 }, () => ({ type: "radio" as const, series: "show" }));
    expect(effectivePlays(episodes)).toBe(SUPPORT.seriesCap * SUPPORT.radioWeight); // 8 episodes × 0.75
    expect(scoreMost([effectivePlays(episodes)])).toBeLessThan(scoreMost([1, 1]));
    expect(effectivePlays([{ type: "radio", series: "show" }, { type: "live", series: "festival" }])).toBe(1.75);
    // Episodes of another show aren't capped by the first one.
    expect(effectivePlays([...episodes, { type: "radio", series: "other" }])).toBe(6.75);
  });

  it("Playing Now: recent breadth beats older breadth, and new supporters count a little extra", () => {
    const recent10 = Array.from({ length: 10 }, () => ({ plays: 1, latestAge: 5, isNew: false }));
    const older12 = Array.from({ length: 12 }, () => ({ plays: 1, latestAge: 80, isNew: false }));
    expect(scoreNow(recent10, 90)).toBeGreaterThan(scoreNow(older12, 90));
    expect(scoreNow([{ plays: 1, latestAge: 0, isNew: true }], 90)).toBe(1 + SUPPORT.newDjBonus);
  });

  it("Deep Cuts: the same support is worth more when few other DJs play it, and thin evidence counts less", () => {
    const lorenzo5 = [5];
    expect(scoreDeep(lorenzo5, 5, 4)).toBeGreaterThan(scoreDeep(lorenzo5, 5, 121)); // 3 others vs 120 others
    expect(scoreDeep([2], 2, 1)).toBeLessThan(scoreDeep([5], 5, 1));
  });

  it("Goes with it accounts for sample size and the DJs behind a pairing", () => {
    const smallPerfect = goesWith(4, 60, 4, 4);
    const bigConsistent = goesWith(25, 60, 50, 10);
    expect(bigConsistent).toBeGreaterThan(smallPerfect);
    expect(goesWith(10, 20, 10, 1)).toBeLessThan(goesWith(10, 20, 10, 6)); // one DJ's show repeating a pair
  });

  it("only reports growth with enough earlier data", () => {
    expect(growth(10, 50, 5, 50)).toBe(100);
    expect(growth(10, 50, 1, 50)).toBeNull(); // 1 DJ before: too few to compare
    expect(growth(10, 50, 5, 3)).toBeNull(); // too few active DJs before
    expect(growth(4, 50, 0, 50)).toBe("new");
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)("DJ support on the database", () => {
  let pool: pg.Pool;
  let catalog: PgCatalog;
  const save = (id: string, date: string, djs: string[], tracks: string[], title?: string) => {
    const set = makeSet(id, date, djs, tracks);
    if (title) set.title = title;
    return catalog.save(set, "");
  };
  const run = (mode: "now" | "most" | "deep", djIds: number[] | null, period: "all" | "3months" | "year" = "all", pageSize = 50) =>
    discover(pool, { mode, djIds, period, page: 1, pageSize, today: TODAY });
  const row = async (mode: "now" | "most" | "deep", djIds: number[] | null, song: string, period: "all" | "3months" | "year" = "all") =>
    (await run(mode, djIds, period)).items.find((t) => t.song === song);

  beforeAll(async () => {
    pool = await freshSchema("support");
    catalog = new PgCatalog(pool);
    // "Wide - Anthem": 15 DJs, once each, recently.
    for (let i = 0; i < 15; i++) await save(`w${i}`, daysAgo(10 + i), [`Crowd ${i}`], ["Wide - Anthem", "Filler - One"]);
    // "Solo - Loop": one radio DJ, 30 episodes of the same show.
    for (let i = 0; i < 30; i++) await save(`r${i}`, daysAgo(i * 7 + 1), ["Radio Host"], ["Solo - Loop", "Filler - Two"], `Radio Host - Weekly Show ${i} ${daysAgo(i * 7 + 1)}`);
    await pool.query("update sets set set_type = 'radio', series_key = 'weekly' where title like 'Radio Host - Weekly Show%'");
    // Aliases: "Alpha" is DJ A.
    await save("a1", daysAgo(3), ["DJ A"], ["Twice - Named"]);
    await save("a2", daysAgo(4), ["Alpha"], ["Twice - Named"]);
    await pool.query(`insert into artist_aliases (artist_id, canonical_id, evidence)
      select a.id, c.id, 'test fixture' from artists a, artists c where a.name_key = 'alpha' and c.name_key = 'dj a'`);
    // An old set (performed 2 years ago), indexed today.
    await save("old1", daysAgo(730), ["Archive DJ"], ["Old - Gem", "Old - Gem 2"]);
    // Deep cuts for "Lorenzo X": A has 3 other DJs, B is everywhere, C is a one-off.
    for (let i = 0; i < 5; i++) await save(`lx${i}`, daysAgo(20 + i), ["Lorenzo X"], ["Rare - Track A", "Common - Track B", ...(i === 0 ? ["Once - Track C"] : [])]);
    for (const dj of ["Other 1", "Other 2", "Other 3"]) await save(`ra-${dj}`, daysAgo(30), [dj], ["Rare - Track A"]);
    for (let i = 0; i < 12; i++) await save(`cb${i}`, daysAgo(40 + i), [`Fan ${i}`], ["Common - Track B"]);
    // Credits: an AYYBO edit of a Technotronic song, and a vocal feature.
    await save("ed1", daysAgo(5), ["Picker"], ["Technotronic - Pump Up The Jam (AYYBO Edit)", "Calvin ft. Vocalist - Hit", "Nova - Pulse", "Nova - Pulse (Kite Remix)"]);
    await pool.query("update artists set image_url = 'https://img.test/' || name_key where name_key in ('ayybo', 'technotronic')");
    // The same performance indexed twice, and a tour (similar sets, different nights).
    const dup = Array.from({ length: 9 }, (_, i) => `Dup - Song ${i}`);
    await save("dupA", daysAgo(6), ["Twin DJ"], dup, `Twin DJ @ Club ${daysAgo(6)}`);
    await save("dupB", daysAgo(6), ["Twin DJ"], dup, `Twin DJ @ Club ${daysAgo(6)}`);
    await save("tour1", daysAgo(8), ["Twin DJ"], dup, `Twin DJ @ Arena One ${daysAgo(8)}`);
  });
  afterAll(async () => pool?.end());

  it("ranks breadth first: 15 DJs beat one DJ's 30 radio episodes", async () => {
    const r = await run("most", null);
    const at = (song: string) => r.items.findIndex((t) => t.song === song);
    expect(at("Wide - Anthem")).toBeLessThan(at("Solo - Loop"));
    expect(r.items[at("Solo - Loop")]).toMatchObject({ djs: 1, sets: 30, repeatDjs: 1 });
    expect(r.items[at("Wide - Anthem")]).toMatchObject({ djs: 15, sets: 15, repeatDjs: 0 });
  });

  it("counts an alias as the same supporting DJ", async () => {
    expect(await row("most", null, "Twice - Named")).toMatchObject({ djs: 1, sets: 2 });
  });

  it("uses performance dates: an old set indexed today isn't recent", async () => {
    expect(await row("now", null, "Old - Gem", "3months")).toBeUndefined();
    expect(await row("most", null, "Old - Gem", "all")).toMatchObject({ djs: 1, recentDjs: 0 });
    const s = await songSupport(pool, (await pool.query("select id from tracks where identity_key = 'old - gem'")).rows[0].id, TODAY);
    expect(s).toMatchObject({ djs: 1, recentDjs: 0, newDjs: 0, growth: null });
  });

  it("followed/selected DJs change the results, and new sets show up straight away", async () => {
    const lorenzo = (await resolveArtist(pool, "Lorenzo X"))!;
    const mine = await run("most", [lorenzo]);
    expect(mine.items.map((t) => t.song).sort()).toEqual(["Common - Track B", "Once - Track C", "Rare - Track A"]);
    await save("lx-new", daysAgo(1), ["Lorenzo X"], ["Fresh - Pick"]);
    expect((await run("most", [lorenzo])).items.map((t) => t.song)).toContain("Fresh - Pick");
  });

  it("Deep Cuts favour rare support over tracks everyone plays, and skip one-offs", async () => {
    const lorenzo = (await resolveArtist(pool, "Lorenzo X"))!;
    const deep = await run("deep", [lorenzo]);
    const songs = deep.items.map((t) => t.song);
    expect(songs[0]).toBe("Rare - Track A");
    expect(deep.items[0]).toMatchObject({ djs: 1, sets: 5, otherDjs: 3 });
    expect(songs).not.toContain("Once - Track C"); // one set isn't enough evidence
    expect(songs).not.toContain("Common - Track B"); // 13 DJs: too widely played
  });

  it("Played Alongside uses every set with the song, ranks by association, and keeps Most Shared absolute", async () => {
    const wide = (await pool.query("select id from tracks where identity_key = 'wide - anthem'")).rows[0].id;
    const goes = await playedAlongside(pool, wide, { sort: "goes", page: 1, pageSize: 15, today: TODAY });
    expect(goes.anchorSets).toBe(15);
    expect(goes.items[0]).toMatchObject({ name: "Filler - One", together: 15, djs: 15, share: 1 });
    const shared = await playedAlongside(pool, wide, { sort: "shared", page: 1, pageSize: 15, today: TODAY });
    expect(shared.items.map((x) => x.together)).toEqual([...shared.items.map((x) => x.together)].sort((a, b) => b - a));
  });

  it("keeps originals and remixes apart, credits the edit's creator, and not the vocalist as a producer", async () => {
    const r = await run("most", null);
    expect(r.items.filter((t) => t.song.startsWith("Nova - Pulse")).map((t) => t.song).sort()).toEqual(["Nova - Pulse", "Nova - Pulse (Kite Remix)"]);
    const ayybo = await ownTracks(pool, (await resolveArtist(pool, "AYYBO"))!, 1, 10);
    expect(ayybo.items).toEqual([expect.objectContaining({ song: "Technotronic - Pump Up The Jam (AYYBO Edit)", role: "remixer", versionType: "edit" })]);
    const original = await ownTracks(pool, (await resolveArtist(pool, "Technotronic"))!, 1, 10);
    expect(original.items[0]).toMatchObject({ role: "original_artist" });
    const picks = (await playsMost(pool, (await resolveArtist(pool, "Picker"))!)).map((a) => a.name);
    expect(picks).toEqual(expect.arrayContaining(["AYYBO", "Calvin", "Kite", "Nova"]));
    expect(picks).not.toContain("Vocalist");
    expect(picks).not.toContain("Technotronic");
  });

  it("shows the edit's creator, not the original artist, when there's no artwork", async () => {
    const card = (await songCards(pool, ["Technotronic - Pump Up The Jam (AYYBO Edit)"])).get("Technotronic - Pump Up The Jam (AYYBO Edit)");
    expect(card).toMatchObject({ image: "https://img.test/ayybo", imageKind: "creator" });
    // A linked, confirmed SoundCloud upload's artwork comes first.
    const id = (await pool.query("select id from tracks where title like 'Pump Up The Jam%'")).rows[0].id;
    await pool.query(
      `insert into external_track_links (track_id, provider, url, confidence, provenance, artwork_url) values ($1, 'soundcloud', 'https://soundcloud.com/a/b', 1, 'user', 'https://i1.sndcdn.com/artworks-x-large.jpg')`,
      [id],
    );
    const again = (await songCards(pool, ["Technotronic - Pump Up The Jam (AYYBO Edit)"])).get("Technotronic - Pump Up The Jam (AYYBO Edit)");
    expect(again).toMatchObject({ image: "https://i1.sndcdn.com/artworks-x-t300x300.jpg", imageKind: "soundcloud" });
  });

  it("counts a set indexed twice once, but keeps a tour's separate nights", async () => {
    expect(await markDuplicates(pool)).toBe(1);
    const r = await row("most", null, "Dup - Song 0");
    expect(r).toMatchObject({ djs: 1, sets: 2 }); // dupA + tour1, not dupB
  });

  it("recommends sets without letting one prolific radio DJ take over", async () => {
    const sets = await recommendSets(pool, { likedTrackIds: [], followed: [], today: TODAY, limit: 6 });
    expect(sets).toHaveLength(6);
    expect(sets.filter((s) => s.title.startsWith("Radio Host"))).toHaveLength(1); // 30 episodes, one pick
    expect(new Set(sets.map((s) => s.djs.map((d) => d.name).join("&"))).size).toBe(6); // one per DJ
    // Near-copies of a chosen set wait: the 15 "Crowd" sets play the same two tracks.
    expect(sets.filter((s) => s.title.startsWith("Crowd"))).toHaveLength(1);
    expect(sets.every((s) => s.reasons.every((r) => /\d/.test(r) || r.startsWith("Mostly")))).toBe(true);
  });
});
