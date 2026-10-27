// What DJs are supporting: tracks by *other* artists that show up in their sets.
//
// The evidence is set appearances: a track played in an indexed set by a DJ counts once
// for that set. It counts as a third-party pick only if none of the set's DJs is
// credited on the recording in any role (artist, featured, remixer, mashup component),
// with verified aliases applied (Lorenzo is Chris Lorenzo). Unidentified IDs never
// enter these rankings. Everything uses the date each set was *performed*.
//
// Three ways to rank (see rankRows):
//   Playing Now  appearances in recent sets, each worth less the older it is
//                (half as much every 14 days)
//   Most Played  distinct qualifying set appearances
//   Deep Cuts    played by at least 2 of the selected DJs (or in 2+ sets for one DJ),
//                but in no more than 2% of all indexed sets; ranked by supporting DJs,
//                then by how much of its play comes from the selected DJs
//   Intros       in the first 2 lines of sets with 10+ tracks listed: 2+ such sets (by 2+
//                DJs when several are selected), and at least 20% of its plays (by these DJs,
//                in the period) are openers; ranked by DJs, then sets, then that share
//   90 + 5       the same for the last 2 lines: the closers DJs finish on
//
// This shows which tracks DJs played, not why: it can't tell organic support from
// promotion, and it only covers sets indexed by setscope.

import type pg from "pg";
import { normalizeName } from "../normalize.ts";
import { windowFor, type Paged, type Period } from "./browse.ts";

export type DiscoveryMode = "now" | "most" | "deep" | "intro" | "closer";
export const MODES: DiscoveryMode[] = ["now", "most", "deep", "intro", "closer"];

/** Intros / 90 + 5: how many lines at the start or end of a set count, and how long a tracklist must be. */
export const MOMENT_LINES = 2;
export const MOMENT_MIN_TRACKS = 10;
/** Intros / 90 + 5: at least this share of a track's plays must be at that moment. */
export const MOMENT_MIN_SHARE = 0.2;

/** Half-life of a set appearance in Playing Now, in days. */
export const RECENCY_HALF_LIFE_DAYS = 14;
/** Deep Cuts: the most of all indexed sets a track may appear in (and still be "uncommon"). */
export const DEEP_CUT_MAX_SHARE = 0.02;
/** Deep Cuts: below this many indexed sets in total, "rare" can't be judged. */
export const DEEP_CUT_MIN_CATALOG = 50;
/** Fewer sets than this in the selected scope and period: results are shown, flagged as thin. */
export const THIN_SCOPE_SETS = 5;

export interface DiscoveryQuery {
  mode: DiscoveryMode;
  /** Canonical artist ids of the DJs to look at; null for every indexed DJ. */
  djIds: number[] | null;
  genre?: string;
  period: Period;
  page: number;
  pageSize: number;
  today: string;
}

export interface DiscoveryRow {
  rank: number;
  song: string;
  artist: string;
  title: string;
  genre: string | null;
  /** A photo of the track's first credited artist with one (not cover art). */
  image: string | null;
  soundcloud: string | null;
  /** Qualifying set appearances (distinct sets) in the scope and period. */
  sets: number;
  /** Distinct supporting DJs in the scope. */
  djs: number;
  /** A few of them by name, whoever played it most first. */
  supporters: string[];
  lastPlayed: string | null;
  /** Indexed sets containing it anywhere, any DJ, any date (Deep Cuts' "how common"). */
  catalogSets: number;
  /** Intros / 90 + 5: qualifying sets it was played in at any point, and the share that were openers/closers. */
  allSets?: number;
  share?: number;
}

export interface DiscoveryResult extends Paged<DiscoveryRow> {
  mode: DiscoveryMode;
  /** What the numbers cover: the selected DJs' sets in the period. */
  coverage: { sets: number; djs: number; from: string | null; to: string | null; catalogSets: number };
  /** Set when the data is too thin to trust the ranking much; shown, not hidden. */
  notice: string | null;
}

/** Artist id -> canonical artist id (itself, unless it's a verified alias). */
const CANON = `canon as (select a.id, coalesce(al.canonical_id, a.id) cid from artists a left join artist_aliases al on al.artist_id = a.id)`;

interface RawRow {
  track_id: number;
  sets: number;
  last_played: string | null;
  recency: number;
  djs: number;
  dj_ids: number[];
}

/** Every third-party track the scope played in the period, with its counts. */
async function appearances(pool: pg.Pool, from: string | null, djIds: number[] | null, genre: string | null, today: string, moment: "intro" | "closer" | null = null): Promise<RawRow[]> {
  const r = await pool.query<RawRow>(
    `with ${CANON},
     set_dj as (select sd.set_id, c.cid from set_djs sd join canon c on c.id = sd.artist_id),
     scoped as (
       select s.id, s.performed_on from sets s
        where ($1::date is null or s.performed_on >= $1) and (s.performed_on is null or s.performed_on <= $4)
          and ($2::bigint[] is null or exists (select 1 from set_dj d where d.set_id = s.id and d.cid = any($2)))
     ),
     set_len as (select set_id, count(*) n, max(position) last_pos from set_tracks group by set_id),
     lines as (
       select distinct st.track_id, sc.id set_id, sc.performed_on
         from scoped sc join set_tracks st on st.set_id = sc.id join tracks t on t.id = st.track_id
         join set_len sl on sl.set_id = sc.id
        where t.identity_key is not null
          and ($3::text is null or coalesce(st.genre, t.genre) = $3)
          -- Intros / 90 + 5: only the first or last lines of a reasonably complete tracklist
          and ($5::text is null or (sl.n >= ${MOMENT_MIN_TRACKS} and (
                ($5 = 'intro' and st.position < ${MOMENT_LINES}) or ($5 = 'closer' and st.position > sl.last_pos - ${MOMENT_LINES}))))
     ),
     -- (set, track) pairs where one of the set's DJs is credited on the track: not third-party
     own as (
       select distinct l.set_id, l.track_id
         from lines l join set_dj d on d.set_id = l.set_id
         join track_artists ta on ta.track_id = l.track_id join canon c on c.id = ta.artist_id and c.cid = d.cid
     ),
     q as (
       select l.track_id, l.set_id, l.performed_on
         from lines l left join own o on o.set_id = l.set_id and o.track_id = l.track_id
        where o.set_id is null
     ),
     agg as (
       select track_id, count(*)::int sets, max(performed_on)::text last_played,
              sum(coalesce(power(0.5, greatest(0, $4::date - performed_on)::float8 / ${RECENCY_HALF_LIFE_DAYS}), 0))::float8 recency
         from q group by track_id
     ),
     sup_dj as (
       select q.track_id, d.cid, count(distinct q.set_id) n
         from q join set_dj d on d.set_id = q.set_id
        where ($2::bigint[] is null or d.cid = any($2))
        group by q.track_id, d.cid
     ),
     -- supporting DJs, the ones who played it most first
     sup as (select track_id, count(*)::int djs, array_agg(cid order by n desc, cid)::int[] dj_ids from sup_dj group by track_id)
     select agg.track_id, agg.sets, agg.last_played, agg.recency, coalesce(sup.djs, 0) djs, coalesce(sup.dj_ids, '{}') dj_ids
       from agg left join sup on sup.track_id = agg.track_id`,
    [from, djIds, genre, today, moment],
  );
  return r.rows;
}

interface Ranked extends RawRow {
  catalogSets: number;
  name: string;
  /** Intros / 90 + 5: qualifying sets at any position. */
  allSets?: number;
}

/** Order the rows for a mode (and drop what isn't a Deep Cut). Documented at the top of the file. */
export function rankRows(rows: Ranked[], mode: DiscoveryMode, options: { catalogTotal: number; multiDj: boolean }): Ranked[] {
  const byName = (a: Ranked, b: Ranked) => a.name.localeCompare(b.name) || a.track_id - b.track_id;
  const newer = (a: Ranked, b: Ranked) => (b.last_played ?? "").localeCompare(a.last_played ?? "");
  if (mode === "most") return [...rows].sort((a, b) => b.sets - a.sets || b.djs - a.djs || newer(a, b) || byName(a, b));
  if (mode === "now") return [...rows].sort((a, b) => b.recency - a.recency || b.sets - a.sets || b.djs - a.djs || byName(a, b));
  if (mode === "intro" || mode === "closer") {
    const share = (r: Ranked) => r.sets / Math.max(r.sets, r.allSets ?? r.sets);
    // Across several DJs, a favourite means 2+ of them, so one DJ's signature opener doesn't take over.
    return rows
      .filter((r) => r.sets >= 2 && share(r) >= MOMENT_MIN_SHARE && (!options.multiDj || r.djs >= 2))
      .sort((a, b) => b.djs - a.djs || b.sets - a.sets || share(b) - share(a) || newer(a, b) || byName(a, b));
  }
  const cap = Math.max(3, Math.ceil(DEEP_CUT_MAX_SHARE * options.catalogTotal));
  return rows
    .filter((r) => r.catalogSets <= cap && (options.multiDj ? r.djs >= 2 : r.sets >= 2))
    .sort((a, b) => b.djs - a.djs || b.sets / b.catalogSets - a.sets / a.catalogSets || a.catalogSets - b.catalogSets || newer(a, b) || byName(a, b));
}

export async function discover(pool: pg.Pool, query: DiscoveryQuery): Promise<DiscoveryResult> {
  const w = windowFor(query.period, query.today);
  const genre = query.genre?.trim() || null;
  const moment = query.mode === "intro" || query.mode === "closer" ? query.mode : null;
  const raw = await appearances(pool, w.from, query.djIds, genre, query.today, moment);
  // For Intros / 90 + 5: the same tracks' plays at any point in the set, for the share.
  const anywhere = moment ? new Map((await appearances(pool, w.from, query.djIds, genre, query.today)).map((r) => [r.track_id, r.sets])) : undefined;
  const ids = raw.map((r) => r.track_id);
  const [catalog, total, names, coverage] = await Promise.all([
    pool.query<{ track_id: number; n: number }>("select track_id, count(distinct set_id)::int n from set_tracks where track_id = any($1) group by track_id", [ids]),
    pool.query<{ n: number }>("select count(*)::int n from sets"),
    pool.query<{ id: number; name: string }>("select id, artist_text || ' - ' || title name from tracks where id = any($1)", [ids]),
    scopeCoverage(pool, w.from, query.djIds, query.today),
  ]);
  const catalogSets = new Map(catalog.rows.map((r) => [r.track_id, r.n]));
  const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
  const catalogTotal = total.rows[0]!.n;
  const multiDj = query.djIds === null || query.djIds.length > 1;
  const ranked = rankRows(
    raw.map((r) => ({ ...r, catalogSets: catalogSets.get(r.track_id) ?? r.sets, name: nameOf.get(r.track_id) ?? "", ...(anywhere ? { allSets: anywhere.get(r.track_id) ?? r.sets } : {}) })),
    query.mode,
    { catalogTotal, multiDj },
  );
  const offset = (query.page - 1) * query.pageSize;
  const pageRows = ranked.slice(offset, offset + query.pageSize);
  const items = await describe(pool, pageRows, offset);

  let notice: string | null = null;
  if (coverage.sets === 0) notice = "None of these DJs' sets in this period are indexed yet. Gather their sets from their DJ pages.";
  else if (query.mode === "deep" && catalogTotal < DEEP_CUT_MIN_CATALOG) notice = `Only ${catalogTotal} sets are indexed in total, too few to tell what's genuinely uncommon. Deep Cuts get better as more sets are gathered.`;
  else if (coverage.sets < THIN_SCOPE_SETS) notice = `Based on just ${coverage.sets} indexed ${coverage.sets === 1 ? "set" : "sets"}: treat this as a hint, not a trend.`;
  return {
    mode: query.mode,
    items,
    page: query.page,
    pageSize: query.pageSize,
    total: ranked.length,
    pages: Math.max(1, Math.ceil(ranked.length / query.pageSize)),
    coverage: { ...coverage, catalogSets: catalogTotal },
    notice,
  };
}

/** How many of the scope's sets the period covers, and from how many DJs. */
async function scopeCoverage(pool: pg.Pool, from: string | null, djIds: number[] | null, today: string): Promise<{ sets: number; djs: number; from: string | null; to: string | null }> {
  const r = await pool.query<{ sets: number; djs: number; first: string | null; last: string | null }>(
    `with ${CANON},
     set_dj as (select sd.set_id, c.cid from set_djs sd join canon c on c.id = sd.artist_id),
     scoped as (
       select s.id, s.performed_on from sets s
        where ($1::date is null or s.performed_on >= $1) and (s.performed_on is null or s.performed_on <= $3)
          and ($2::bigint[] is null or exists (select 1 from set_dj d where d.set_id = s.id and d.cid = any($2)))
     )
     select (select count(*)::int from scoped) sets,
            (select count(distinct d.cid)::int from scoped sc join set_dj d on d.set_id = sc.id where ($2::bigint[] is null or d.cid = any($2))) djs,
            (select min(performed_on)::text from scoped) first, (select max(performed_on)::text from scoped) last`,
    [from, djIds, today],
  );
  const row = r.rows[0]!;
  return { sets: row.sets, djs: row.djs, from: row.first, to: row.last };
}

/** Names, artwork, genre, play link and supporting DJ names for one page of rows. */
async function describe(pool: pg.Pool, rows: Ranked[], offset: number): Promise<DiscoveryRow[]> {
  if (!rows.length) return [];
  const [tracks, djs] = await Promise.all([
    pool.query<{ id: number; artist_text: string; title: string; genre: string | null; image: string | null; soundcloud: string | null }>(
      `select t.id, t.artist_text, t.title,
              coalesce(t.genre, (select mode() within group (order by st.genre) from set_tracks st where st.track_id = t.id and st.genre is not null)) genre,
              (select a.image_url from track_artists ta join artists a on a.id = ta.artist_id
                where ta.track_id = t.id and ta.role in ('main', 'featured', 'mashup_component') and a.image_url is not null order by ta.position limit 1) image,
              (select l.url from external_track_links l where l.track_id = t.id
                order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc, l.created_at limit 1) soundcloud
         from tracks t where t.id = any($1)`,
      [rows.map((r) => r.track_id)],
    ),
    pool.query<{ id: number; name: string }>("select id, name from artists where id = any($1)", [[...new Set(rows.flatMap((r) => r.dj_ids))]]),
  ]);
  const track = new Map(tracks.rows.map((t) => [t.id, t]));
  const djName = new Map(djs.rows.map((d) => [d.id, d.name]));
  return rows.map((r, i) => {
    const t = track.get(r.track_id)!;
    return {
      rank: offset + i + 1,
      song: `${t.artist_text} - ${t.title}`,
      artist: t.artist_text,
      title: t.title,
      genre: t.genre,
      image: t.image,
      soundcloud: t.soundcloud,
      sets: r.sets,
      djs: r.djs,
      supporters: r.dj_ids.map((id) => djName.get(id) ?? "").filter(Boolean).slice(0, 3),
      lastPlayed: r.last_played,
      catalogSets: r.catalogSets,
      ...(r.allSets !== undefined ? { allSets: r.allSets, share: Math.round((r.sets / Math.max(r.sets, r.allSets)) * 100) / 100 } : {}),
    };
  });
}

// ---------- DJs ----------

/** The canonical artist id for a name (an alias resolves to the artist it belongs to). */
export async function resolveArtist(pool: pg.Pool, name: string): Promise<number | undefined> {
  const r = await pool.query<{ cid: number }>(
    "select coalesce(al.canonical_id, a.id) cid from artists a left join artist_aliases al on al.artist_id = a.id where a.name_key = $1",
    [normalizeName(name)],
  );
  return r.rows[0]?.cid;
}

export interface DjRow {
  name: string;
  image: string | null;
  country: string | null;
  /** Indexed sets they performed (any of their names). */
  sets: number;
  lastSet: string | null;
  following?: boolean;
}

/** DJs who performed indexed sets (aliases folded in), most indexed sets first. */
export async function listDjs(pool: pg.Pool, options: { q?: string; onlyIds?: number[]; userId?: number; page: number; pageSize: number }): Promise<Paged<DjRow>> {
  const like = options.q?.trim() ? `%${normalizeName(options.q)}%` : null;
  const r = await pool.query<{ name: string; image_url: string | null; country: string | null; sets: number; last_set: string | null; following: boolean; total: number }>(
    `with ${CANON},
     performed as (
       select c.cid, count(distinct sd.set_id)::int sets, max(s.performed_on)::text last_set,
              bool_or(a.name_key like coalesce($1, '%')) matches
         from set_djs sd join sets s on s.id = sd.set_id join canon c on c.id = sd.artist_id join artists a on a.id = sd.artist_id
        group by c.cid
     )
     select a.name,
            coalesce(a.image_url, (select x.image_url from artist_aliases al join artists x on x.id = al.artist_id
                                    where al.canonical_id = a.id and x.image_url is not null limit 1)) image_url,
            a.country, p.sets, p.last_set,
            exists (select 1 from followed_artists f where f.user_id = $3 and f.artist_id = a.id) following,
            count(*) over ()::int total
       from performed p join artists a on a.id = p.cid
      where (p.matches or a.name_key like coalesce($1, '%')) and ($2::bigint[] is null or p.cid = any($2))
      order by p.sets desc, p.last_set desc nulls last, lower(a.name)
      limit $4 offset $5`,
    [like, options.onlyIds ?? null, options.userId ?? null, options.pageSize, (options.page - 1) * options.pageSize],
  );
  const total = r.rows[0]?.total ?? 0;
  return {
    items: r.rows.map((row) => ({ name: row.name, image: row.image_url, country: row.country, sets: row.sets, lastSet: row.last_set, following: row.following })),
    page: options.page,
    pageSize: options.pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / options.pageSize)),
  };
}

export async function followedIds(pool: pg.Pool, userId: number): Promise<number[]> {
  const r = await pool.query<{ cid: number }>(
    `select distinct coalesce(al.canonical_id, f.artist_id) cid from followed_artists f left join artist_aliases al on al.artist_id = f.artist_id where f.user_id = $1`,
    [userId],
  );
  return r.rows.map((row) => row.cid);
}

export async function setFollow(pool: pg.Pool, userId: number, artistId: number, on: boolean): Promise<void> {
  if (on) await pool.query("insert into followed_artists (user_id, artist_id) values ($1, $2) on conflict do nothing", [userId, artistId]);
  else {
    // Unfollow every name of theirs.
    await pool.query(
      `delete from followed_artists where user_id = $1 and artist_id in (
         select a.id from artists a left join artist_aliases al on al.artist_id = a.id where coalesce(al.canonical_id, a.id) = $2)`,
      [userId, artistId],
    );
  }
}

export interface DjProfile {
  name: string;
  /** Other names this artist is listed under (verified aliases), with the evidence. */
  aliases: { name: string; evidence: string }[];
  image: string | null;
  country: string | null;
  page: string | null;
  links: { label: string; url: string }[];
  /** Indexed sets they performed. */
  sets: number;
  firstSet: string | null;
  lastSet: string | null;
  following: boolean;
}

export async function djProfile(pool: pg.Pool, artistId: number, userId?: number): Promise<DjProfile> {
  const [a, aliases, sets, following] = await Promise.all([
    pool.query<{ name: string; image_url: string | null; country: string | null; tl_page: string | null; links: { label: string; url: string }[] }>(
      "select name, image_url, country, tl_page, links from artists where id = $1",
      [artistId],
    ),
    pool.query<{ name: string; evidence: string; image_url: string | null; tl_page: string | null }>(
      "select a.name, al.evidence, a.image_url, a.tl_page from artist_aliases al join artists a on a.id = al.artist_id where al.canonical_id = $1",
      [artistId],
    ),
    pool.query<{ n: number; first: string | null; last: string | null }>(
      `select count(distinct sd.set_id)::int n, min(s.performed_on)::text first, max(s.performed_on)::text last
         from set_djs sd join sets s on s.id = sd.set_id
        where sd.artist_id = $1 or sd.artist_id in (select artist_id from artist_aliases where canonical_id = $1)`,
      [artistId],
    ),
    userId ? pool.query("select 1 from followed_artists where user_id = $1 and artist_id = $2", [userId, artistId]) : { rowCount: 0 },
  ]);
  const row = a.rows[0]!;
  return {
    name: row.name,
    aliases: aliases.rows.map((x) => ({ name: x.name, evidence: x.evidence })),
    image: row.image_url ?? aliases.rows.find((x) => x.image_url)?.image_url ?? null,
    country: row.country,
    // Their set list on 1001Tracklists, from whichever of their names has one.
    page: [row.tl_page, ...aliases.rows.map((x) => x.tl_page)].find((p) => p?.endsWith("/tracklists.html")) ?? row.tl_page,
    links: row.links,
    sets: sets.rows[0]!.n,
    firstSet: sets.rows[0]!.first,
    lastSet: sets.rows[0]!.last,
    following: (following.rowCount ?? 0) > 0,
  };
}

export interface OwnTrack {
  song: string;
  title: string;
  artist: string;
  /** How they're credited: main, featured or remixer. */
  role: string;
  image: string | null;
  soundcloud: string | null;
  /** Indexed sets by *other* DJs that played it. */
  otherSets: number;
  otherDjs: number;
  /** Their own indexed sets that played it. */
  ownSets: number;
}

/**
 * Tracks they made (as artist, featured artist or remixer), most supported by other
 * DJs first. Mashups that merely contain one of their songs aren't theirs, so they're
 * left out.
 */
export async function ownTracks(pool: pg.Pool, artistId: number, page: number, pageSize: number): Promise<Paged<OwnTrack>> {
  const r = await pool.query<{ track_id: number; artist_text: string; title: string; role: string; other_sets: number; other_djs: number; own_sets: number; total: number }>(
    `with ${CANON},
     set_dj as (select sd.set_id, c.cid from set_djs sd join canon c on c.id = sd.artist_id),
     mine as (
       select ta.track_id, (array_agg(ta.role order by case ta.role when 'main' then 1 when 'featured' then 2 else 3 end))[1] role
         from track_artists ta join canon c on c.id = ta.artist_id
        where c.cid = $1 and ta.role in ('main', 'featured', 'remixer') group by ta.track_id
     ),
     plays as (
       select m.track_id, st.set_id, exists (select 1 from set_dj d where d.set_id = st.set_id and d.cid = $1) own
         from mine m join set_tracks st on st.track_id = m.track_id group by m.track_id, st.set_id
     )
     select t.id track_id, t.artist_text, t.title, m.role,
            count(distinct p.set_id) filter (where not p.own)::int other_sets,
            (select count(distinct d.cid)::int from plays p2 join set_dj d on d.set_id = p2.set_id where p2.track_id = t.id and not p2.own and d.cid <> $1) other_djs,
            count(distinct p.set_id) filter (where p.own)::int own_sets,
            count(*) over ()::int total
       from mine m join tracks t on t.id = m.track_id left join plays p on p.track_id = m.track_id
      where t.identity_key is not null
      group by t.id, t.artist_text, t.title, m.role
      order by other_sets desc, own_sets desc, lower(t.title), t.id
      limit $2 offset $3`,
    [artistId, pageSize, (page - 1) * pageSize],
  );
  const extra = await pool.query<{ id: number; image: string | null; soundcloud: string | null }>(
    `select t.id,
            (select a.image_url from track_artists ta join artists a on a.id = ta.artist_id where ta.track_id = t.id and a.image_url is not null order by ta.position limit 1) image,
            (select l.url from external_track_links l where l.track_id = t.id order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc limit 1) soundcloud
       from tracks t where t.id = any($1)`,
    [r.rows.map((x) => x.track_id)],
  );
  const more = new Map(extra.rows.map((x) => [x.id, x]));
  const total = r.rows[0]?.total ?? 0;
  return {
    items: r.rows.map((x) => ({
      song: `${x.artist_text} - ${x.title}`,
      title: x.title,
      artist: x.artist_text,
      role: x.role,
      image: more.get(x.track_id)?.image ?? null,
      soundcloud: more.get(x.track_id)?.soundcloud ?? null,
      otherSets: x.other_sets,
      otherDjs: x.other_djs,
      ownSets: x.own_sets,
    })),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface IdLine {
  setId: string;
  setTitle: string;
  date: string | null;
  position: number;
  /** As the tracklist writes it now ("ID - ID", "Fisher - ID"). */
  text: string;
  saved?: boolean;
}

/** Unidentified lines in their sets, newest first. Each line is its own ID: none are merged. */
export async function idLines(pool: pg.Pool, artistId: number, page: number, pageSize: number, userId?: number): Promise<Paged<IdLine>> {
  const r = await pool.query<{ source_id: string; title: string; performed_on: string | null; position: number; raw_artist: string; raw_title: string; saved: boolean; total: number }>(
    `with ${CANON}
     select s.source_id, s.title, s.performed_on::text, st.position, st.raw_artist, st.raw_title,
            exists (select 1 from vault_items v where v.user_id = $4 and v.set_id = s.id and v.position = st.position) saved,
            count(*) over ()::int total
       from sets s join set_tracks st on st.set_id = s.id join tracks t on t.id = st.track_id
      where t.identity_key is null
        and exists (select 1 from set_djs sd join canon c on c.id = sd.artist_id where sd.set_id = s.id and c.cid = $1)
      order by s.performed_on desc nulls last, s.id desc, st.position
      limit $2 offset $3`,
    [artistId, pageSize, (page - 1) * pageSize, userId ?? null],
  );
  const total = r.rows[0]?.total ?? 0;
  return {
    items: r.rows.map((x) => ({ setId: x.source_id, setTitle: x.title, date: x.performed_on, position: x.position, text: `${x.raw_artist} - ${x.raw_title}`, saved: x.saved })),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
