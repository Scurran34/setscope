import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";
import { makeSet } from "./fixtures/sets.ts";

const available = await databaseAvailable();

describe.skipIf(!available)("PgCatalog", () => {
  let pool: pg.Pool;
  let catalog: PgCatalog;
  beforeAll(async () => {
    pool = await freshSchema("pg_catalog");
    catalog = new PgCatalog(pool);
  });
  afterAll(async () => pool?.end());

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  it("stores a set with its DJs and ordered tracklist, and gives it back unchanged", async () => {
    const set = {
      ...makeSet("s1", "2026-09-10", ["DJ Alpha", "DJ Beta"], ["Nova - Pulse #tl1", "ID - ID", "Nova - Pulse (Kite Remix)"]),
      djProfiles: [{ name: "DJ Alpha", country: "France", links: [{ label: "SoundCloud", url: "https://soundcloud.com/a" }] }],
      soundcloud: "https://api.soundcloud.com/tracks/1",
    };
    await catalog.save(set, "<html>s1</html>");
    expect(await catalog.has("s1")).toBe(true);
    expect(await catalog.has("nope")).toBe(false);
    const [loaded] = await catalog.all();
    expect(loaded).toMatchObject({ id: "s1", date: "2026-09-10", djs: ["DJ Alpha", "DJ Beta"], soundcloud: "https://api.soundcloud.com/tracks/1" });
    expect(loaded!.tracks.map((t) => `${t.artist} - ${t.title}`)).toEqual(["Nova - Pulse", "ID - ID", "Nova - Pulse (Kite Remix)"]);
    expect(loaded!.djProfiles).toEqual([{ name: "DJ Alpha", country: "France", links: [{ label: "SoundCloud", url: "https://soundcloud.com/a" }] }]);
    expect(await q("select country from artists where name_key = 'dj alpha'")).toEqual([{ country: "France" }]);
  });

  it("shares one track across sets, keeps remixes separate and linked, and never merges IDs by name", async () => {
    await catalog.save(makeSet("s2", "2026-09-11", ["DJ Gamma"], ["nova - pulse (Extended Mix)", "ID - ID", "Rook - Drift"]), "<html>s2</html>");
    const tracks = await q(`select artist_text, title, identity_key, version_type, id_status,
        (select identity_key from tracks p where p.id = t.parent_track_id) as parent
      from tracks t order by id`);
    expect(tracks).toEqual([
      { artist_text: "Nova", title: "Pulse", identity_key: "nova - pulse", version_type: "original", id_status: "identified", parent: null },
      { artist_text: "ID", title: "ID", identity_key: null, version_type: "original", id_status: "unidentified", parent: null },
      { artist_text: "Nova", title: "Pulse (Kite Remix)", identity_key: "nova - pulse (kite remix)", version_type: "remix", id_status: "identified", parent: "nova - pulse" },
      { artist_text: "ID", title: "ID", identity_key: null, version_type: "original", id_status: "unidentified", parent: null },
      { artist_text: "Rook", title: "Drift", identity_key: "rook - drift", version_type: "original", id_status: "identified", parent: null },
    ]);
    // Nova - Pulse appears in both sets as the same track.
    expect(await q("select count(distinct track_id)::int as n from set_tracks where raw_title ilike 'pulse%' and raw_title not ilike '%remix%'")).toEqual([{ n: 1 }]);
    expect(await q("select a.name, ta.role from track_artists ta join artists a on a.id = ta.artist_id join tracks t on t.id = ta.track_id where t.version_type = 'remix' order by ta.role")).toEqual([
      { name: "Nova", role: "main" },
      { name: "Kite", role: "remixer" },
    ]);
  });

  it("on a refresh, records what changed line by line and keeps unchanged placeholders", async () => {
    const before = await q("select position, track_id from set_tracks where set_id = (select id from sets where source_id = 's2') order by position");
    // The ID got identified, nothing else changed.
    await catalog.save(makeSet("s2", "2026-09-11", ["DJ Gamma"], ["nova - pulse (Extended Mix)", "Fisher - Losing It", "Rook - Drift"]), "<html>s2 v2</html>");
    const after = await q("select position, track_id from set_tracks where set_id = (select id from sets where source_id = 's2') order by position");
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]!.track_id).not.toBe(before[1]!.track_id);
    expect(await q("select position, old_text, new_text from track_metadata_history")).toEqual([
      { position: 1, old_text: "ID - ID", new_text: "Fisher - Losing It" },
    ]);
    expect(await q("select html from set_pages where set_id = (select id from sets where source_id = 's2')")).toEqual([{ html: "<html>s2 v2</html>" }]);
  });

  it("links a remix to its original even when the remix was saved first", async () => {
    await catalog.save(makeSet("r1", "2026-09-12", ["DJ R"], ["Mira - Glow (Kite Remix)"]), "");
    await catalog.save(makeSet("r2", "2026-09-13", ["DJ R"], ["Mira - Glow"]), "");
    expect(await q(`select (select title from tracks p where p.id = t.parent_track_id) as parent from tracks t where title = 'Glow (Kite Remix)'`)).toEqual([{ parent: "Glow" }]);
  });

  it("prefers a DJ's set-list page over a track-credit page", async () => {
    await catalog.save({ ...makeSet("p1", "2026-09-14", ["Mira"], ["Other - Thing"]), djPages: { Mira: "https://www.1001tracklists.com/artist/mira/tracklists.html" } }, "");
    const p2 = makeSet("p2", "2026-09-15", ["DJ R"], []);
    p2.tracks = [{ artist: "Mira", title: "Glow", artistPages: { Mira: "https://www.1001tracklists.com/artist/mira/tracks.html" } }];
    await catalog.save(p2, "");
    expect(await q("select tl_page from artists where name_key = 'mira'")).toEqual([{ tl_page: "https://www.1001tracklists.com/artist/mira/tracklists.html" }]);
  });

  it("re-saving an unchanged set changes nothing", async () => {
    const tracksBefore = await q("select count(*)::int as n from tracks");
    await catalog.save(makeSet("s2", "2026-09-11", ["DJ Gamma"], ["nova - pulse (Extended Mix)", "Fisher - Losing It", "Rook - Drift"]), "<html>s2 v2</html>");
    expect(await q("select count(*)::int as n from tracks")).toEqual(tracksBefore);
    expect(await q("select count(*)::int as n from track_metadata_history")).toEqual([{ n: 1 }]);
    expect(await catalog.count()).toBe(6);
  });
});
