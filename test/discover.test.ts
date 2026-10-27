import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, djProfile, followedIds, idLines, listDjs, ownTracks, rankRows, resolveArtist, setFollow } from "../src/catalog/discover.ts";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { listSets } from "../src/catalog/browse.ts";
import { normalizeName } from "../src/normalize.ts";
import { Accounts } from "../src/auth/accounts.ts";
import { Vault } from "../src/personal/vault.ts";
import { UserDataError } from "../src/personal/user-data.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";
import { makeSet } from "./fixtures/sets.ts";

const TODAY = "2026-10-27";

describe("rankRows", () => {
  const row = (name: string, sets: number, djs: number, catalogSets: number, recency = 0, last = "2026-10-01") => ({ track_id: name.length, name, sets, djs, catalogSets, recency, last_played: last, dj_ids: [] });
  it("Deep Cuts need real support and must be uncommon across the whole catalog", () => {
    const rows = [row("Everywhere", 30, 20, 60), row("Once", 1, 1, 1), row("Gem", 3, 3, 4), row("Pair", 2, 2, 2)];
    // 200 indexed sets: at most 4 (2%) to count as uncommon.
    expect(rankRows(rows, "deep", { catalogTotal: 200, multiDj: true }).map((r) => r.name)).toEqual(["Gem", "Pair"]);
    // One DJ selected: 2+ of their sets is enough support.
    expect(rankRows(rows, "deep", { catalogTotal: 200, multiDj: false }).map((r) => r.name)).toEqual(["Gem", "Pair"]);
  });
  it("Most Played counts sets; Playing Now weighs recent sets", () => {
    const rows = [row("Old favourite", 10, 5, 10, 0.5), row("New one", 4, 4, 4, 3.2)];
    expect(rankRows(rows, "most", { catalogTotal: 100, multiDj: true })[0]!.name).toBe("Old favourite");
    expect(rankRows(rows, "now", { catalogTotal: 100, multiDj: true })[0]!.name).toBe("New one");
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)("discovery on the database", () => {
  let pool: pg.Pool;
  let catalog: PgCatalog;
  let djA: number;
  let user: number;
  beforeAll(async () => {
    pool = await freshSchema("discover");
    catalog = new PgCatalog(pool);
    const mashup = "Other & DJ A vs. Someone - Thing vs. Stuff (Masher Edit)";
    await catalog.save(makeSet("a1", "2026-10-20", ["DJ A"], ["Nova - Pulse", "DJ A - Own Song", "Kite - Glow", "ID - ID", mashup]), "");
    await catalog.save(makeSet("a2", "2026-09-01", ["DJ A"], ["Nova - Pulse", "Rook - Drift"]), "");
    await catalog.save(makeSet("b1", "2026-10-25", ["DJ B"], ["Nova - Pulse", "Kite - Glow", "DJ A - Own Song", "Calvin ft. Rihanna - Hit", mashup]), "");
    // "Alpha" is DJ A under another name (a verified alias).
    await catalog.save(makeSet("x1", "2026-10-26", ["Alpha"], ["DJ A - Own Song", "Kite - Glow"]), "");
    await pool.query(`insert into artist_aliases (artist_id, canonical_id, evidence)
      select a.id, c.id, 'test fixture' from artists a, artists c where a.name_key = 'alpha' and c.name_key = 'dj a'`);
    djA = (await resolveArtist(pool, "DJ A"))!;
    const accounts = new Accounts(pool);
    user = (await accounts.register({ email: "fan@example.test", password: "a long password", displayName: "Fan" })).id;
  });
  afterAll(async () => pool?.end());

  const run = (mode: "now" | "most" | "deep", djIds: number[] | null, period: "all" | "month" = "all") =>
    discover(pool, { mode, djIds, period, page: 1, pageSize: 15, today: TODAY });

  it("counts a track only in sets where none of the DJs made it, aliases included", async () => {
    const r = await run("most", null);
    const sets = Object.fromEntries(r.items.map((t) => [t.song, t.sets]));
    expect(sets["Nova - Pulse"]).toBe(3);
    expect(sets["Kite - Glow"]).toBe(3); // a1, b1, x1: nobody in those sets made it
    expect(sets["DJ A - Own Song"]).toBe(1); // only DJ B's set: DJ A's and Alpha's (= DJ A) don't count
    expect(sets[mashupName()]).toBe(1); // DJ A's song is inside it, so it's not a pick in DJ A's set
    expect(r.items.some((t) => t.song.startsWith("ID"))).toBe(false);
    expect(r.coverage).toMatchObject({ sets: 4, djs: 2, catalogSets: 4 });
  });

  it("scopes to the chosen DJs, folding in their aliases", async () => {
    const r = await run("most", [djA]);
    expect(r.items.map((t) => [t.song, t.sets, t.djs, t.supporters])).toEqual([
      ["Kite - Glow", 2, 1, ["DJ A"]], // a1 and x1 (Alpha); ties with Nova, but played more recently
      ["Nova - Pulse", 2, 1, ["DJ A"]],
      ["Rook - Drift", 1, 1, ["DJ A"]],
    ]);
    expect(r.coverage).toMatchObject({ sets: 3, djs: 1 });
    expect(r.notice).toMatch(/hint, not a trend/);
  });

  it("Playing Now favours the most recent sets", async () => {
    const r = await run("now", [djA], "month");
    expect(r.items.map((t) => t.song)).toEqual(["Kite - Glow", "Nova - Pulse"]); // Kite: Oct 20 + Oct 26; Nova: only Oct 20 in the month
  });

  it("Deep Cuts need at least two supporting DJs, and say when the catalog is too small to judge", async () => {
    const r = await run("deep", null);
    expect(r.items.map((t) => [t.song, t.djs])).toEqual([
      ["Kite - Glow", 2],
      ["Nova - Pulse", 2],
    ]);
    expect(r.notice).toMatch(/too few to tell what's genuinely uncommon/);
  });

  it("lists performing DJs only, with aliases folded in", async () => {
    const djs = await listDjs(pool, { page: 1, pageSize: 10 });
    expect(djs.items.map((d) => [d.name, d.sets])).toEqual([
      ["DJ A", 3],
      ["DJ B", 1],
    ]);
    expect((await listDjs(pool, { q: "alpha", page: 1, pageSize: 10 })).items.map((d) => d.name)).toEqual(["DJ A"]);
    expect(await resolveArtist(pool, "Rihanna")).toBeDefined(); // she's credited on a track...
    expect(djs.items.some((d) => d.name === "Rihanna")).toBe(false); // ...but she isn't a DJ
    // Their set list includes sets under their alias.
    expect((await listSets(pool, { dj: "DJ A", page: 1, pageSize: 10 }, normalizeName)).items.map((x) => x.id)).toEqual(["x1", "a1", "a2"]);
    const profile = await djProfile(pool, djA);
    expect(profile).toMatchObject({ name: "DJ A", sets: 3, aliases: [{ name: "Alpha", evidence: "test fixture" }] });
  });

  it("keeps their own productions apart, without mashups that only use their song", async () => {
    const own = await ownTracks(pool, djA, 1, 15);
    expect(own.items.map((t) => [t.song, t.role, t.otherSets, t.ownSets])).toEqual([["DJ A - Own Song", "main", 1, 2]]);
  });

  it("lists IDs line by line, and follows DJs by any of their names", async () => {
    const ids = await idLines(pool, djA, 1, 15, user);
    expect(ids.items.map((l) => [l.setId, l.position, l.text, l.saved])).toEqual([["a1", 3, "ID - ID", false]]);
    await setFollow(pool, user, djA, true);
    expect(await followedIds(pool, user)).toEqual([djA]);
    await setFollow(pool, user, djA, false);
    expect(await followedIds(pool, user)).toEqual([]);
  });

  it("keeps saved IDs tied to their line, and shows when a re-read tracklist names them", async () => {
    const vault = new Vault(pool);
    await vault.setSaved(user, "a1", 3, true);
    expect((await vault.list(user)).map((v) => [v.status, v.text, v.song])).toEqual([["unidentified", "ID - ID", null]]);
    await expect(vault.setSaved(user, "a1", 0, true)).rejects.toBeInstanceOf(UserDataError); // already identified
    // The set is re-read and 1001Tracklists has named the ID.
    await catalog.save(makeSet("a1", "2026-10-20", ["DJ A"], ["Nova - Pulse", "DJ A - Own Song", "Kite - Glow", "Fisher - Losing It", mashupName()]), "");
    const [item] = await vault.list(user);
    expect(item).toMatchObject({ status: "identified", savedText: "ID - ID", text: "Fisher - Losing It", song: "Fisher - Losing It" });
    expect(item!.changedAt).not.toBeNull();
    expect((await idLines(pool, djA, 1, 15, user)).items).toEqual([]);
  });

  function mashupName() {
    return "Other & DJ A vs. Someone - Thing vs. Stuff (Masher Edit)";
  }
});

describe.skipIf(!available)("Intros and 90 + 5", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await freshSchema("discover_moments");
    const catalog = new PgCatalog(pool);
    const filler = (set: string) => Array.from({ length: 8 }, (_, i) => `Filler ${set} - Track ${i}`);
    // Three DJs open with "Open - Up" and close with "Last - Call". "Hit - Song" ends one set
    // but is in every set, so it isn't a closer. "Solo - Sign" closes two sets by one DJ.
    const sets: [string, string, string[]][] = [
      ["m1", "DJ One", ["Open - Up", ...filler("m1"), "Hit - Song", "Last - Call"]],
      ["m2", "DJ Two", ["Open - Up", ...filler("m2").slice(0, 4), "Hit - Song", ...filler("m2").slice(4), "Last - Call"]],
      ["m3", "DJ Three", ["Intro - Two", "Open - Up", "Hit - Song", ...filler("m3"), "Solo - Sign"]],
      ["m4", "DJ Three", ["Other - Zero", ...filler("m4").slice(0, 4), "Hit - Song", ...filler("m4").slice(4), "Other - One", "Solo - Sign"]],
      ["m5", "DJ Four", ["Short - Set", "Hit - Song", "Last - Call"]], // too short to say how it opens or closes
    ];
    for (const [id, dj, tracks] of sets) await catalog.save(makeSet(id, "2026-10-10", [dj], tracks), "");
  });
  afterAll(async () => pool?.end());

  const run = (mode: "intro" | "closer", djIds: number[] | null) => discover(pool, { mode, djIds, period: "all", page: 1, pageSize: 15, today: TODAY });

  it("finds what several DJs open and close with, but not hits that are everywhere", async () => {
    const intros = await run("intro", null);
    expect(intros.items.map((t) => [t.song, t.sets, t.djs, t.allSets])).toEqual([["Open - Up", 3, 3, 3]]);
    const closers = await run("closer", null);
    expect(closers.items.map((t) => [t.song, t.sets, t.djs, t.share])).toEqual([["Last - Call", 2, 2, 0.67]]);
  });

  it("for one DJ, two sets are enough", async () => {
    const three = (await resolveArtist(pool, "DJ Three"))!;
    expect((await run("closer", [three])).items.map((t) => [t.song, t.sets])).toEqual([["Solo - Sign", 2]]);
  });
});
