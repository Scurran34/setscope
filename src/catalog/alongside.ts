// "Played alongside it": every identified track that shares sets with a song, over every
// eligible indexed set that plays the song (all time unless a window is asked for). Two
// orders (see goesWith in support.ts):
//   Goes with it      association strength, adjusted for sample size and DJ count
//   Most shared sets  the raw number of sets that play both
// A track needs 2+ shared sets to be listed: one is a coincidence.

import type pg from "pg";
import { trackImageSql, type TrackImage } from "./artwork.ts";
import { ALONGSIDE_MIN_ANCHOR_SETS, CANON, ELIGIBLE_SET, goesWith } from "./support.ts";
import type { Paged } from "./browse.ts";

export type AlongsideSort = "goes" | "shared";

export interface AlongsideRow {
  rank: number;
  name: string;
  /** Sets that play both. */
  together: number;
  /** Distinct canonical DJs behind those shared sets. */
  djs: number;
  /** Sets that play the other track at all. */
  everywhere: number;
  /** Share of this song's sets that also play it (0–1). */
  share: number;
  /** goesWith() score. */
  score: number;
  image: string | null;
  imageKind: TrackImage["kind"] | null;
  soundcloud: string | null;
}

export interface AlongsideResult extends Paged<AlongsideRow> {
  sort: AlongsideSort;
  /** Eligible sets that play the song: every number here is out of these. */
  anchorSets: number;
  /** Set when the song is in too few sets for associations to mean much. */
  notice: string | null;
}

interface Raw {
  track_id: number;
  name: string;
  together: number;
  djs: number;
  everywhere: number;
}

export async function playedAlongside(pool: pg.Pool, trackId: number, options: { sort: AlongsideSort; page: number; pageSize: number; today: string; from?: string | null }): Promise<AlongsideResult> {
  const r = await pool.query<Raw & { anchor_sets: number }>(
    `with ${CANON},
     eligible as (select s.id from sets s where ${ELIGIBLE_SET("s", "$2::date")} and ($3::date is null or s.performed_on >= $3)),
     anchor as (select distinct st.set_id from set_tracks st join eligible e on e.id = st.set_id where st.track_id = $1),
     pairs as (
       select distinct st.track_id, st.set_id
         from anchor a join set_tracks st on st.set_id = a.set_id join tracks t on t.id = st.track_id
        where t.identity_key is not null and st.track_id <> $1
     ),
     shared as (select track_id, count(*)::int together from pairs group by track_id having count(*) >= 2),
     shared_djs as (
       select p.track_id, count(distinct c.cid)::int djs
         from pairs p join shared sh on sh.track_id = p.track_id join set_djs sd on sd.set_id = p.set_id join canon c on c.id = sd.artist_id
        group by p.track_id
     ),
     everywhere as (
       select st.track_id, count(distinct st.set_id)::int n
         from set_tracks st join eligible e on e.id = st.set_id where st.track_id in (select track_id from shared) group by st.track_id
     )
     select sh.track_id::int, t.artist_text || ' - ' || t.title name, sh.together, coalesce(d.djs, 0) djs, ev.n everywhere,
            (select count(*)::int from anchor) anchor_sets
       from shared sh join tracks t on t.id = sh.track_id join everywhere ev on ev.track_id = sh.track_id
       left join shared_djs d on d.track_id = sh.track_id`,
    [trackId, options.today, options.from ?? null],
  );
  const anchorSets = r.rows[0]?.anchor_sets ?? (await pool.query<{ n: number }>(
    `select count(distinct st.set_id)::int n from set_tracks st join sets s on s.id = st.set_id where st.track_id = $1 and ${ELIGIBLE_SET("s", "$2::date")} and ($3::date is null or s.performed_on >= $3)`,
    [trackId, options.today, options.from ?? null],
  )).rows[0]!.n;
  const scored = r.rows.map((row) => ({ ...row, score: goesWith(row.together, anchorSets, row.everywhere, row.djs) }));
  scored.sort((a, b) =>
    options.sort === "shared"
      ? b.together - a.together || b.djs - a.djs || b.score - a.score || a.name.localeCompare(b.name)
      : b.score - a.score || b.together - a.together || a.name.localeCompare(b.name),
  );
  const offset = (options.page - 1) * options.pageSize;
  const page = scored.slice(offset, offset + options.pageSize);
  const extra = await pool.query<{ id: number; image: TrackImage | null; soundcloud: string | null }>(
    `select t.id::int, ${trackImageSql("t")} image,
            (select l.url from external_track_links l where l.track_id = t.id
              order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc, l.created_at limit 1) soundcloud
       from tracks t where t.id = any($1)`,
    [page.map((x) => x.track_id)],
  );
  const more = new Map(extra.rows.map((x) => [x.id, x]));
  return {
    sort: options.sort,
    anchorSets,
    notice: anchorSets < ALONGSIDE_MIN_ANCHOR_SETS ? `This song is in only ${anchorSets} indexed ${anchorSets === 1 ? "set" : "sets"}, so these pairings are a hint, not a pattern.` : null,
    items: page.map((x, i) => ({
      rank: offset + i + 1,
      name: x.name,
      together: x.together,
      djs: x.djs,
      everywhere: x.everywhere,
      share: anchorSets ? Math.round((x.together / anchorSets) * 1000) / 1000 : 0,
      score: Math.round(x.score * 1000) / 1000,
      image: more.get(x.track_id)?.image?.url ?? null,
      imageKind: more.get(x.track_id)?.image?.kind ?? null,
      soundcloud: more.get(x.track_id)?.soundcloud ?? null,
    })),
    page: options.page,
    pageSize: options.pageSize,
    total: scored.length,
    pages: Math.max(1, Math.ceil(scored.length / options.pageSize)),
  };
}

/** The eligible sets that play both tracks, newest first (source ids, for set cards). */
export async function sharedSets(pool: pg.Pool, trackId: number, otherId: number, today: string, limit = 50): Promise<string[]> {
  const r = await pool.query<{ source_id: string }>(
    `select s.source_id from sets s
      where ${ELIGIBLE_SET("s", "$3::date")}
        and exists (select 1 from set_tracks a where a.set_id = s.id and a.track_id = $1)
        and exists (select 1 from set_tracks b where b.set_id = s.id and b.track_id = $2)
      order by s.performed_on desc, s.id desc limit $4`,
    [trackId, otherId, today, limit],
  );
  return r.rows.map((row) => row.source_id);
}
