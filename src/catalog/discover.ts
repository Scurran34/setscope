// What DJs are supporting: tracks by *other* artists that show up in their sets.
//
// The measurements (breadth, repeat support, momentum) and every formula live in
// support.ts and are written up in docs/RANKINGS.md. In short:
//
//   Playing Now  the window (90 days by default): Σ over supporting DJs of their
//                contribution, fading with the age of their latest play, a little extra
//                for DJs who've only just started playing it
//   Most Played  all indexed history by default: Σ over supporting DJs of 1 + half
//                their repeat bonus, so 15 DJs beat one DJ with 30 plays
//   Deep Cuts    supported by the selected DJs, played by few DJs anywhere: their
//                support × rarity × evidence; 2+ sets needed, and tracks played by more
//                than 1% of indexed DJs (and at least 4) are left out
//   Intros       in the first 2 lines of sets with 10+ tracks listed: 2+ such sets (by 2+
//                DJs when several are selected), and at least 20% of its plays (by these DJs,
//                in the period) are openers; ranked by DJs, then sets, then that share
//   90 + 5       the same for the last 2 lines: the closers DJs finish on
//
// A play counts only if none of the set's DJs is credited on the track (any role,
// aliases folded in). It shows which tracks DJs played, not why: it can't tell organic
// support from promotion, and it only covers sets indexed by Rabbithole.

import type pg from "pg";
import { normalizeName } from "../normalize.ts";
import { periodDays, type Paged, type Period } from "./browse.ts";
import { trackImageSql, type TrackImage } from "./artwork.ts";
import {
  CANON,
  ELIGIBLE_SET,
  PRODUCTION,
  VERSION_TYPES,
  deepCutMaxDjs,
  growth,
  isNewSupporter,
  plays,
  scopeFacts,
  scopeSets,
  scoreDeep,
  scoreMost,
  scoreNow,
  supportByTrack,
  type TrackSupport,
} from "./support.ts";

export { MOMENT_LINES, MOMENT_MIN_TRACKS } from "./support.ts";

export type DiscoveryMode = "now" | "most" | "deep" | "intro" | "closer";
export const MODES: DiscoveryMode[] = ["now", "most", "deep", "intro", "closer"];

/** Intros / 90 + 5: at least this share of a track's plays must be at that moment. */
export const MOMENT_MIN_SHARE = 0.2;
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
  /** A picture for the track, and what it is (see artwork.ts). */
  image: string | null;
  imageKind: TrackImage["kind"] | null;
  soundcloud: string | null;
  /** Breadth: distinct supporting DJs (canonical) in the scope and period. */
  djs: number;
  /** Qualifying set appearances (distinct sets) in the scope and period. */
  sets: number;
  /** Supporting DJs who played it in 2+ of those sets. */
  repeatDjs: number;
  /** Distinct supporting DJs in the last 90 days. */
  recentDjs: number;
  /** DJs whose first indexed play of it is inside the period (see isNewSupporter). */
  newDjs: number;
  /** Change vs the period before, in % (or "new"); null when there isn't enough earlier data. */
  growth: number | "new" | null;
  /** What the mode ranked by (DJ-equivalents; see support.ts). */
  score: number;
  /** A few of them by name, whoever played it most first. */
  supporters: string[];
  lastPlayed: string | null;
  /** Indexed sets containing it anywhere, any DJ, any date. */
  catalogSets: number;
  /** Deep Cuts: DJs outside the selection who play it (anywhere in the index). */
  otherDjs?: number;
  /** Intros / 90 + 5: qualifying sets it was played in at any point, and the share that were openers/closers. */
  allSets?: number;
  share?: number;
}

export interface DiscoveryResult extends Paged<DiscoveryRow> {
  mode: DiscoveryMode;
  /** What the numbers cover: the selected DJs' sets in the period. */
  coverage: { sets: number; djs: number; from: string | null; to: string | null; catalogSets: number; catalogDjs: number };
  /** Set when the data is too thin to trust the ranking much; shown, not hidden. */
  notice: string | null;
}

interface Ranked {
  support: TrackSupport;
  score: number;
  newDjs: number;
  growth: number | "new" | null;
  otherDjs?: number;
  allSets?: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every indexed set, and every canonical DJ who performed one (eligible sets only). */
async function catalogTotals(pool: pg.Pool, today: string): Promise<{ sets: number; djs: number }> {
  const r = await pool.query<{ sets: number; djs: number }>(
    `with ${CANON}
     select (select count(*)::int from sets s where ${ELIGIBLE_SET("s", "$1::date")}) sets,
            (select count(distinct c.cid)::int from sets s join set_djs sd on sd.set_id = s.id join canon c on c.id = sd.artist_id
              where ${ELIGIBLE_SET("s", "$1::date")}) djs`,
    [today],
  );
  return r.rows[0]!;
}

export async function discover(pool: pg.Pool, query: DiscoveryQuery): Promise<DiscoveryResult> {
  const windowDays = periodDays(query.period);
  const genre = query.genre?.trim() || null;
  const moment = query.mode === "intro" || query.mode === "closer" ? query.mode : null;
  const base = { djIds: query.djIds, genre, today: query.today };
  const [rows, scope, totals] = await Promise.all([plays(pool, { ...base, moment }), scopeSets(pool, query.djIds, query.today), catalogTotals(pool, query.today)]);
  const support = supportByTrack(rows, windowDays);
  const facts = scopeFacts(scope, windowDays);
  const multiDj = query.djIds === null || query.djIds.length > 1;

  const newOf = (t: TrackSupport) => (windowDays === null ? 0 : t.djs.filter((d) => isNewSupporter(d, windowDays, facts.earliest.get(d.dj))).length);
  const growthOf = (t: TrackSupport) => (windowDays === null ? null : growth(t.djs.length, facts.activeNow, t.prevDjs, facts.activeBefore));
  const row = (t: TrackSupport, score: number, extra: Partial<Ranked> = {}): Ranked => ({ support: t, score, newDjs: newOf(t), growth: growthOf(t), ...extra });

  let ranked: Ranked[];
  if (query.mode === "now") {
    const days = windowDays ?? 3650;
    ranked = [...support.values()].map((t) =>
      row(t, scoreNow(t.djs.map((d) => ({ plays: d.plays, latestAge: d.latestAge, share: d.share, isNew: windowDays !== null && isNewSupporter(d, windowDays, facts.earliest.get(d.dj)) })), days)),
    );
  } else if (query.mode === "most") {
    ranked = [...support.values()].map((t) => row(t, scoreMost(t.djs.map((d) => d.plays), t.djs.map((d) => d.share))));
  } else if (query.mode === "deep") {
    // Who plays each track anywhere in the index, for "how common is it elsewhere".
    const everywhere = new Map<number, Set<number>>();
    for (const p of await plays(pool, { djIds: null, genre: null, moment: null, today: query.today })) {
      let djs = everywhere.get(p.track);
      if (!djs) everywhere.set(p.track, (djs = new Set()));
      djs.add(p.dj);
    }
    const selected = query.djIds ? new Set(query.djIds) : null;
    const cap = deepCutMaxDjs(totals.djs);
    ranked = [];
    for (const t of support.values()) {
      const all = everywhere.get(t.track) ?? new Set(t.djs.map((d) => d.dj));
      if (all.size > cap) continue; // played too widely to be a deep cut
      // Enough evidence: 2+ sets, and across several DJs either 2+ DJs or 3+ sets.
      if (t.sets < 2 || (multiDj && t.djs.length < 2 && t.sets < 3)) continue;
      const outside = selected ? [...all].filter((dj) => !selected.has(dj)).length : 0;
      ranked.push(row(t, scoreDeep(t.djs.map((d) => d.plays), t.sets, all.size, t.djs.map((d) => d.share)), { otherDjs: outside }));
    }
  } else {
    // Intros / 90 + 5: the same tracks' plays at any point in the set, for the share.
    const anywhere = supportByTrack(await plays(pool, { ...base, moment: null }), windowDays);
    const share = (t: TrackSupport) => t.sets / Math.max(t.sets, anywhere.get(t.track)?.sets ?? t.sets);
    ranked = [...support.values()]
      .filter((t) => t.sets >= 2 && share(t) >= MOMENT_MIN_SHARE && (!multiDj || t.djs.length >= 2))
      .map((t) => row(t, t.djs.length + share(t), { allSets: anywhere.get(t.track)?.sets ?? t.sets }));
  }
  const names = await pool.query<{ id: number; name: string }>("select id::int, artist_text || ' - ' || title name from tracks where id = any($1)", [ranked.map((r) => r.support.track)]);
  const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.support.djs.length - a.support.djs.length ||
      b.support.sets - a.support.sets ||
      a.support.latestAge - b.support.latestAge ||
      (nameOf.get(a.support.track) ?? "").localeCompare(nameOf.get(b.support.track) ?? "") ||
      a.support.track - b.support.track,
  );

  const offset = (query.page - 1) * query.pageSize;
  const items = await describe(pool, ranked.slice(offset, offset + query.pageSize), offset, query.today);
  const coverage = {
    sets: facts.setsInWindow,
    djs: facts.djsInWindow,
    from: facts.from === null ? null : addDays(query.today, -facts.from),
    to: facts.to === null ? null : addDays(query.today, -facts.to),
    catalogSets: totals.sets,
    catalogDjs: totals.djs,
  };
  let notice: string | null = null;
  if (coverage.sets === 0) notice = "None of these DJs' sets in this period are indexed yet. Gather their sets from their DJ pages.";
  else if (query.mode === "deep" && totals.sets < DEEP_CUT_MIN_CATALOG) notice = `Only ${totals.sets} sets are indexed in total, too few to tell what's genuinely uncommon. Deep Cuts get better as more sets are gathered.`;
  else if (coverage.sets < THIN_SCOPE_SETS) notice = `Based on just ${coverage.sets} indexed ${coverage.sets === 1 ? "set" : "sets"}: treat this as a hint, not a trend.`;
  return {
    mode: query.mode,
    items,
    page: query.page,
    pageSize: query.pageSize,
    total: ranked.length,
    pages: Math.max(1, Math.ceil(ranked.length / query.pageSize)),
    coverage,
    notice,
  };
}

/** Names, artwork, genre, play link and supporting DJ names for one page of rows. */
async function describe(pool: pg.Pool, rows: Ranked[], offset: number, today: string): Promise<DiscoveryRow[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.support.track);
  const [tracks, djs] = await Promise.all([
    pool.query<{ id: number; artist_text: string; title: string; genre: string | null; image: TrackImage | null; soundcloud: string | null; catalog_sets: number }>(
      `select t.id::int, t.artist_text, t.title,
              coalesce(t.genre, (select mode() within group (order by st.genre) from set_tracks st where st.track_id = t.id and st.genre is not null)) genre,
              ${trackImageSql("t")} image,
              (select l.url from external_track_links l where l.track_id = t.id
                order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc, l.created_at limit 1) soundcloud,
              (select count(distinct st.set_id)::int from set_tracks st where st.track_id = t.id
                and not exists (select 1 from set_duplicates dup where dup.set_id = st.set_id)) catalog_sets
         from tracks t where t.id = any($1)`,
      [ids],
    ),
    pool.query<{ id: number; name: string }>("select id::int, name from artists where id = any($1)", [[...new Set(rows.flatMap((r) => r.support.djs.slice(0, 3).map((d) => d.dj)))]]),
  ]);
  const track = new Map(tracks.rows.map((t) => [t.id, t]));
  const djName = new Map(djs.rows.map((d) => [d.id, d.name]));
  return rows.map((r, i) => {
    const t = track.get(r.support.track)!;
    return {
      rank: offset + i + 1,
      song: `${t.artist_text} - ${t.title}`,
      artist: t.artist_text,
      title: t.title,
      genre: t.genre,
      image: t.image?.url ?? null,
      imageKind: t.image?.kind ?? null,
      soundcloud: t.soundcloud,
      djs: r.support.djs.length,
      sets: r.support.sets,
      repeatDjs: r.support.repeatDjs,
      recentDjs: r.support.recentDjs,
      newDjs: r.newDjs,
      growth: r.growth,
      score: Math.round(r.score * 100) / 100,
      supporters: r.support.djs.slice(0, 3).map((d) => djName.get(d.dj) ?? "").filter(Boolean),
      lastPlayed: addDays(today, -r.support.latestAge),
      catalogSets: t.catalog_sets,
      ...(r.otherDjs !== undefined ? { otherDjs: r.otherDjs } : {}),
      ...(r.allSets !== undefined ? { allSets: r.allSets, share: Math.round((r.support.sets / Math.max(r.support.sets, r.allSets)) * 100) / 100 } : {}),
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
  /**
   * How they're credited: main (an original of theirs), remixer (they made this version:
   * see versionType), featured (vocals), or original_artist (someone else's version of
   * their song: credited as the original, not as its maker).
   */
  role: "main" | "remixer" | "featured" | "original_artist";
  versionType: string;
  image: string | null;
  imageKind: TrackImage["kind"] | null;
  soundcloud: string | null;
  /** Indexed sets by *other* DJs that played it. */
  otherSets: number;
  otherDjs: number;
  /** Their own indexed sets that played it. */
  ownSets: number;
}

/**
 * Tracks they made (an original, or a remix/edit/VIP of theirs), then ones they sing on,
 * then other people's versions of their songs (credited as the original artist, listed
 * last), each most supported by other DJs first. Mashups that merely contain one of
 * their songs aren't theirs, so they're left out.
 */
export async function ownTracks(pool: pg.Pool, artistId: number, page: number, pageSize: number): Promise<Paged<OwnTrack>> {
  const r = await pool.query<{ track_id: number; artist_text: string; title: string; role: OwnTrack["role"]; version_type: string; other_sets: number; other_djs: number; own_sets: number; total: number }>(
    `with ${CANON},
     set_dj as (select sd.set_id, c.cid from set_djs sd join canon c on c.id = sd.artist_id),
     -- Their credits, best first: what they made, then vocals, then their song in someone else's version.
     -- Mashups that merely use one of their songs (mashup_component) aren't theirs.
     mine as (
       select ta.track_id,
              (array_agg(case when ta.role = 'main' and t.version_type in ${VERSION_TYPES} then 'original_artist' else ta.role end
                         order by case when ${PRODUCTION("ta", "t")} then 1 when ta.role = 'featured' then 2 else 3 end))[1] role
         from track_artists ta join canon c on c.id = ta.artist_id join tracks t on t.id = ta.track_id
        where c.cid = $1 and ta.role in ('main', 'featured', 'remixer') group by ta.track_id
     ),
     plays as (
       select m.track_id, st.set_id, exists (select 1 from set_dj d where d.set_id = st.set_id and d.cid = $1) own
         from mine m join set_tracks st on st.track_id = m.track_id group by m.track_id, st.set_id
     )
     select t.id track_id, t.artist_text, t.title, m.role, t.version_type::text,
            count(distinct p.set_id) filter (where not p.own)::int other_sets,
            (select count(distinct d.cid)::int from plays p2 join set_dj d on d.set_id = p2.set_id where p2.track_id = t.id and not p2.own and d.cid <> $1) other_djs,
            count(distinct p.set_id) filter (where p.own)::int own_sets,
            count(*) over ()::int total
       from mine m join tracks t on t.id = m.track_id left join plays p on p.track_id = m.track_id
      where t.identity_key is not null
      group by t.id, t.artist_text, t.title, m.role, t.version_type
      order by (m.role = 'original_artist'), other_sets desc, own_sets desc, lower(t.title), t.id
      limit $2 offset $3`,
    [artistId, pageSize, (page - 1) * pageSize],
  );
  const extra = await pool.query<{ id: number; image: TrackImage | null; soundcloud: string | null }>(
    `select t.id,
            ${trackImageSql("t")} image,
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
      versionType: x.version_type,
      image: more.get(x.track_id)?.image?.url ?? null,
      imageKind: more.get(x.track_id)?.image?.kind ?? null,
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

export interface ArtistLink {
  name: string;
  image: string | null;
  /** Distinct indexed sets behind the number. */
  sets: number;
}

/** Image of an artist, or of one of their verified aliases. */
const IMAGE_OF = (a: string) =>
  `coalesce(${a}.image_url, (select x.image_url from artist_aliases al2 join artists x on x.id = al2.artist_id where al2.canonical_id = ${a}.id and x.image_url is not null limit 1))`;

/** The DJs who play this artist's tracks most (in other people's sets: not their own). */
export async function supporters(pool: pg.Pool, artistId: number, limit = 12): Promise<ArtistLink[]> {
  const r = await pool.query<{ name: string; image: string | null; sets: number }>(
    `with ${CANON},
     -- what they made, or sing on: not other people's versions of their songs, or mashups using them
     theirs as (select distinct ta.track_id from track_artists ta join canon c on c.id = ta.artist_id join tracks t on t.id = ta.track_id
                 where c.cid = $1 and (${PRODUCTION("ta", "t")} or (ta.role = 'featured' and t.version_type not in ${VERSION_TYPES}))),
     played as (
       select c.cid, count(distinct st.set_id)::int sets
         from set_tracks st join theirs t on t.track_id = st.track_id
         join set_djs sd on sd.set_id = st.set_id join canon c on c.id = sd.artist_id
        where c.cid <> $1
        group by c.cid
     )
     select a.name, ${IMAGE_OF("a")} image, p.sets from played p join artists a on a.id = p.cid
      order by p.sets desc, lower(a.name) limit $2`,
    [artistId, limit],
  );
  return r.rows;
}

/** The producers whose tracks this DJ plays most (by sets), leaving out their own: a remix counts for its remixer. */
export async function playsMost(pool: pg.Pool, artistId: number, limit = 12): Promise<ArtistLink[]> {
  const r = await pool.query<{ name: string; image: string | null; sets: number }>(
    `with ${CANON},
     mine as (select distinct sd.set_id from set_djs sd join canon c on c.id = sd.artist_id where c.cid = $1),
     played as (
       select c.cid, count(distinct st.set_id)::int sets
         from mine m join set_tracks st on st.set_id = m.set_id join tracks t on t.id = st.track_id
         join track_artists ta on ta.track_id = st.track_id join canon c on c.id = ta.artist_id
        where t.identity_key is not null and ${PRODUCTION("ta", "t")} and c.cid <> $1
        group by c.cid
     )
     select a.name, ${IMAGE_OF("a")} image, p.sets from played p join artists a on a.id = p.cid
      order by p.sets desc, lower(a.name) limit $2`,
    [artistId, limit],
  );
  return r.rows;
}

/**
 * For each of these tracks, sets by DJs other than the artist that played it, month by
 * month for the last 12 months (oldest first): the sparkline on their productions.
 */
export async function monthlyPlays(pool: pg.Pool, artistId: number, songs: string[], today: string): Promise<Map<string, number[]>> {
  if (!songs.length) return new Map();
  const r = await pool.query<{ song: string; ago: number; n: number }>(
    `with ${CANON},
     own as (select sd.set_id from set_djs sd join canon c on c.id = sd.artist_id where c.cid = $1)
     select t.artist_text || ' - ' || t.title song,
            ((extract(year from $3::date) - extract(year from s.performed_on)) * 12 + extract(month from $3::date) - extract(month from s.performed_on))::int ago,
            count(distinct s.id)::int n
       from tracks t join set_tracks st on st.track_id = t.id join sets s on s.id = st.set_id
      where t.artist_text || ' - ' || t.title = any($2) and s.performed_on > ($3::date - interval '12 months')
        and s.id not in (select set_id from own)
      group by 1, 2`,
    [artistId, songs, today],
  );
  const out = new Map(songs.map((s) => [s, Array.from({ length: 12 }, () => 0)]));
  for (const row of r.rows) {
    const months = out.get(row.song);
    if (months && row.ago >= 0 && row.ago < 12) months[11 - row.ago] = row.n;
  }
  return out;
}
