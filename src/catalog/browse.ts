// Browsing the shared catalog page by page: song and artist charts, the set list, one
// set's tracklist, and site-wide search. Everything is filtered, sorted and paged in
// Postgres, so the page only ever receives one page of results.
//
// Charts count *unique sets* by the date each set was performed (sets.performed_on),
// not the date setscope collected it: a set played in July counts for July. Sets
// without a date only count toward "All time".

import type pg from "pg";
import { baseTitle, normalizeName, splitArtists } from "../normalize.ts";

export type Period = "week" | "month" | "3months" | "year" | "all";
export const PERIODS: Period[] = ["week", "month", "3months", "year", "all"];
const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = { week: 7, month: 30, "3months": 91, year: 365 };

/** Minimum sets in each window before a trend is shown, so 1 set vs 2 isn't "+100%". */
const TREND_MIN_SETS = 5;
/** Minimum appearances in the earlier window for a percentage change (fewer: "new" or nothing). */
const TREND_MIN_APPEARANCES = 3;

export interface Window {
  /** First day counted, or null for all time. */
  from: string | null;
  /** The equally long window before it, for trends. */
  prevFrom: string | null;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function windowFor(period: Period, today: string): Window {
  if (period === "all") return { from: null, prevFrom: null };
  const days = PERIOD_DAYS[period];
  const from = addDays(today, -(days - 1));
  return { from, prevFrom: addDays(from, -days) };
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

function paged<T>(items: T[], total: number, page: number, pageSize: number): Paged<T> {
  return { items, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * Change in *share* of sets (not raw counts), so collecting more sets one week doesn't
 * look like everything is rising. null when there isn't enough data to say.
 */
export function trendOf(cur: number, curSets: number, prev: number, prevSets: number): number | "new" | null {
  if (curSets < TREND_MIN_SETS || prevSets < TREND_MIN_SETS) return null;
  if (prev === 0) return cur >= TREND_MIN_APPEARANCES ? "new" : null;
  if (prev < TREND_MIN_APPEARANCES) return null;
  return Math.round(((cur / curSets) / (prev / prevSets) - 1) * 100);
}

async function setsIn(pool: pg.Pool, from: string | null, to: string | null): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `select count(*)::int n from sets where ($1::date is null or performed_on >= $1) and ($2::date is null or performed_on < $2)`,
    [from, to],
  );
  return r.rows[0]!.n;
}

export interface ChartQuery {
  period: Period;
  genre?: string;
  q?: string;
  page: number;
  pageSize: number;
  today: string;
}

export interface SongRow {
  rank: number;
  artist: string;
  title: string;
  genre: string | null;
  /** Unique indexed sets it was played in, in the window. */
  sets: number;
  /** Unique DJs who played it, in the window. */
  djs: number;
  trend: number | "new" | null;
  /** A photo of its main artist, when we have one (not cover art). */
  artistImage: string | null;
  /** Its confirmed SoundCloud link, if any. */
  soundcloud: string | null;
}

const like = (q: string | undefined) => (q?.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

export async function songChart(pool: pg.Pool, query: ChartQuery): Promise<Paged<SongRow> & { setsInWindow: number }> {
  const w = windowFor(query.period, query.today);
  const genre = query.genre?.trim() || null;
  const r = await pool.query<{
    artist_text: string; title: string; genre: string | null; sets: number; djs: number; prev: number;
    artist_image: string | null; soundcloud: string | null; total: number;
  }>(
    `with cur as (
       select st.track_id, count(distinct st.set_id)::int sets, count(distinct sd.artist_id)::int djs,
              mode() within group (order by st.genre) filter (where st.genre is not null) genre
         from set_tracks st
         join sets s on s.id = st.set_id
         join tracks t on t.id = st.track_id
         left join set_djs sd on sd.set_id = s.id
        where t.identity_key is not null
          and ($1::date is null or s.performed_on >= $1)
          and ($3::text is null or coalesce(st.genre, t.genre) = $3)
        group by st.track_id
     ), prev as (
       select st.track_id, count(distinct st.set_id)::int sets
         from set_tracks st join sets s on s.id = st.set_id join tracks t on t.id = st.track_id
        where $2::date is not null and s.performed_on >= $2 and s.performed_on < $1
          and ($3::text is null or coalesce(st.genre, t.genre) = $3)
        group by st.track_id
     )
     select t.artist_text, t.title, coalesce(t.genre, cur.genre) genre, cur.sets, cur.djs, coalesce(prev.sets, 0) prev,
            (select a.image_url from track_artists ta join artists a on a.id = ta.artist_id
              where ta.track_id = t.id and ta.role = 'main' and a.image_url is not null order by ta.position limit 1) artist_image,
            (select l.url from external_track_links l where l.track_id = t.id order by l.confidence desc, l.created_at limit 1) soundcloud,
            count(*) over ()::int total
       from cur join tracks t on t.id = cur.track_id left join prev on prev.track_id = cur.track_id
      where ($4::text is null or lower(t.artist_text || ' - ' || t.title) like $4)
      order by cur.sets desc, cur.djs desc, lower(t.artist_text), lower(t.title), t.id
      limit $5 offset $6`,
    [w.from, w.prevFrom, genre, like(query.q), query.pageSize, (query.page - 1) * query.pageSize],
  );
  const [curSets, prevSets] = await Promise.all([setsIn(pool, w.from, null), w.prevFrom ? setsIn(pool, w.prevFrom, w.from) : 0]);
  const offset = (query.page - 1) * query.pageSize;
  const items = r.rows.map((row, i) => ({
    rank: offset + i + 1,
    artist: row.artist_text,
    title: row.title,
    genre: row.genre,
    sets: row.sets,
    djs: row.djs,
    trend: w.prevFrom ? trendOf(row.sets, curSets, row.prev, prevSets) : null,
    artistImage: row.artist_image,
    soundcloud: row.soundcloud,
  }));
  return { ...paged(items, r.rows[0]?.total ?? 0, query.page, query.pageSize), setsInWindow: curSets };
}

export interface ArtistRow {
  rank: number;
  name: string;
  image: string | null;
  country: string | null;
  /** Sets by other DJs that played one of their tracks (as artist, featured artist or remixer), in the window. */
  playedIn: number;
  /** Different songs of theirs that were played. */
  songs: number;
  /** What the ranking uses: see creditScore. */
  score: number;
  /** Their own indexed sets, in the window. */
  ownSets: number;
  trend: number | "new" | null;
}

/** A set where an artist is only featured ("A ft. B": B) counts this much toward B. */
const FEATURE_WEIGHT = 0.5;

/** Is `name` credited only as a feature ("ft." / "feat." / "featuring") in this artist line? */
export function isFeatured(artistText: string, name: string): boolean {
  const at = artistText.search(/\s(?:ft\.?|feat\.?|featuring)\s/i);
  if (at === -1) return false;
  const key = normalizeName(name);
  return splitArtists(artistText.slice(at)).map(normalizeName).includes(key) && !splitArtists(artistText.slice(0, at)).map(normalizeName).includes(key);
}

/** One artist's plays in a window: which sets by other DJs played them, and how. */
export interface ArtistPlays {
  /** set id -> true when every track of theirs in that set only features them. */
  sets: Map<number, boolean>;
  /** track id -> sets (by other DJs) it was played in. */
  songs: Map<number, number>;
}

/**
 * How much an artist counts in the ranking:
 *   1. Sets by *other* DJs that played them (their own sets don't count: an artist's
 *      radio show full of their own songs isn't other DJs choosing them). A set where
 *      they're only featured counts half.
 *   2. Cut by up to half when most of those plays are one song, so a single big hit or
 *      feature doesn't outrank artists DJs keep reaching for across their catalog.
 */
export function creditScore(plays: ArtistPlays): number {
  let base = 0;
  for (const featuredOnly of plays.sets.values()) base += featuredOnly ? FEATURE_WEIGHT : 1;
  // Share of their sets that their single most-played song accounts for.
  const dominance = plays.sets.size ? Math.max(0, ...plays.songs.values()) / plays.sets.size : 0;
  return base * (1 - 0.5 * dominance);
}

interface PlayRow {
  artist_id: number;
  name: string;
  image_url: string | null;
  country: string | null;
  set_id: number;
  track_id: number;
  artist_text: string;
  role: string;
}

/** Every (artist, set, track) play in a window, leaving out artists' own sets. */
async function artistPlays(pool: pg.Pool, from: string | null, to: string | null, genre: string | null, q: string | null, withPhoto: boolean): Promise<Map<number, ArtistPlays & { row: PlayRow }>> {
  const r = await pool.query<PlayRow>(
    `select a.id artist_id, a.name, a.image_url, a.country, st.set_id, st.track_id, t.artist_text, ta.role
       from set_tracks st join sets s on s.id = st.set_id join tracks t on t.id = st.track_id
       join track_artists ta on ta.track_id = st.track_id join artists a on a.id = ta.artist_id
       left join set_djs own on own.set_id = st.set_id and own.artist_id = ta.artist_id
      where t.identity_key is not null and own.artist_id is null
        and ($1::date is null or s.performed_on >= $1) and ($2::date is null or s.performed_on < $2)
        and ($3::text is null or coalesce(st.genre, t.genre) = $3)
        and ($4::text is null or lower(a.name) like $4) and (not $5 or a.image_url is not null)`,
    [from, to, genre, q, withPhoto],
  );
  const out = new Map<number, ArtistPlays & { row: PlayRow; seen: Set<string> }>();
  for (const row of r.rows) {
    const a = out.get(row.artist_id) ?? { row, sets: new Map(), songs: new Map(), seen: new Set() };
    const featured = row.role === "featured" || row.role === "mashup_component" || (row.role === "main" && isFeatured(row.artist_text, row.name));
    a.sets.set(row.set_id, (a.sets.get(row.set_id) ?? true) && featured);
    const pair = `${row.set_id}:${row.track_id}`;
    if (!a.seen.has(pair)) {
      a.seen.add(pair);
      a.songs.set(row.track_id, (a.songs.get(row.track_id) ?? 0) + 1);
    }
    out.set(row.artist_id, a);
  }
  return out;
}

export async function artistChart(pool: pg.Pool, query: ChartQuery & { withPhoto?: boolean }): Promise<Paged<ArtistRow>> {
  const w = windowFor(query.period, query.today);
  const genre = query.genre?.trim() || null;
  const q = like(query.q);
  const [cur, prev, own, windowSets, earlierSets] = await Promise.all([
    artistPlays(pool, w.from, null, genre, q, query.withPhoto ?? false),
    w.prevFrom ? artistPlays(pool, w.prevFrom, w.from, genre, q, query.withPhoto ?? false) : new Map<number, ArtistPlays>(),
    pool.query<{ artist_id: number; sets: number }>(
      `select sd.artist_id, count(*)::int sets from set_djs sd join sets s on s.id = sd.set_id where ($1::date is null or s.performed_on >= $1) group by sd.artist_id`,
      [w.from],
    ),
    setsIn(pool, w.from, null),
    w.prevFrom ? setsIn(pool, w.prevFrom, w.from) : 0,
  ]);
  const ownSets = new Map(own.rows.map((r) => [r.artist_id, r.sets]));
  const ranked = [...cur.entries()]
    .map(([id, a]) => ({ id, a, score: creditScore(a), playedIn: a.sets.size }))
    .sort((x, y) => y.score - x.score || y.playedIn - x.playedIn || x.a.row.name.toLowerCase().localeCompare(y.a.row.name.toLowerCase()) || x.id - y.id);
  const offset = (query.page - 1) * query.pageSize;
  const items = ranked.slice(offset, offset + query.pageSize).map((x, i) => ({
    rank: offset + i + 1,
    name: x.a.row.name,
    image: x.a.row.image_url,
    country: x.a.row.country,
    playedIn: x.playedIn,
    songs: x.a.songs.size,
    score: Math.round(x.score * 10) / 10,
    ownSets: ownSets.get(x.id) ?? 0,
    trend: w.prevFrom ? trendOf(x.playedIn, windowSets, prev.get(x.id)?.sets.size ?? 0, earlierSets) : null,
  }));
  return paged(items, ranked.length, query.page, query.pageSize);
}

export interface SetCard {
  id: string;
  url: string;
  title: string;
  /** The show or event: the title without the DJ names and date. */
  event: string;
  date: string | null;
  djs: { name: string; image: string | null }[];
  tracks: number;
  /** Lines that are unidentified IDs. */
  ids: number;
  soundcloud: string | null;
}

/** "Arielle Free - BBC Radio 1 Dance Chart 2026-10-26" -> "BBC Radio 1 Dance Chart". */
export function eventOf(title: string): string {
  const noDate = title.replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, "").trim();
  const dash = noDate.indexOf(" - ");
  return dash === -1 ? noDate : noDate.slice(dash + 3).trim();
}

export interface SetQuery {
  q?: string;
  /** Only sets this DJ played (name as on artist pages). */
  dj?: string;
  year?: number;
  page: number;
  pageSize: number;
}

export async function listSets(pool: pg.Pool, query: SetQuery, normalize: (s: string) => string): Promise<Paged<SetCard>> {
  const from = query.year ? `${query.year}-01-01` : null;
  const to = query.year ? `${query.year + 1}-01-01` : null;
  const r = await pool.query<{
    source_id: string; url: string; title: string; performed_on: string | null; soundcloud_url: string | null;
    tracks: number; ids: number; djs: { name: string; image: string | null }[] | null; total: number;
  }>(
    `select s.source_id, s.url, s.title, s.performed_on, s.soundcloud_url,
            (select count(*)::int from set_tracks st where st.set_id = s.id) tracks,
            (select count(*)::int from set_tracks st join tracks t on t.id = st.track_id where st.set_id = s.id and t.identity_key is null) ids,
            (select json_agg(json_build_object('name', a.name, 'image', a.image_url) order by sd.position)
               from set_djs sd join artists a on a.id = sd.artist_id where sd.set_id = s.id) djs,
            count(*) over ()::int total
       from sets s
      where ($1::date is null or s.performed_on >= $1) and ($2::date is null or s.performed_on < $2)
        and ($3::text is null or lower(s.title) like $3)
        -- a DJ by any of their names (verified aliases included)
        and ($4::text is null or exists (
              select 1 from set_djs sd join artists a on a.id = sd.artist_id left join artist_aliases al on al.artist_id = a.id
               where sd.set_id = s.id and coalesce(al.canonical_id, a.id) = (
                 select coalesce(al2.canonical_id, a2.id) from artists a2 left join artist_aliases al2 on al2.artist_id = a2.id where a2.name_key = $4)))
      order by s.performed_on desc nulls last, s.id desc
      limit $5 offset $6`,
    [from, to, like(query.q), query.dj?.trim() ? normalize(query.dj) : null, query.pageSize, (query.page - 1) * query.pageSize],
  );
  const items = r.rows.map((row) => ({
    id: row.source_id,
    url: row.url,
    title: row.title,
    event: eventOf(row.title),
    date: row.performed_on,
    djs: row.djs ?? [],
    tracks: row.tracks,
    ids: row.ids,
    soundcloud: row.soundcloud_url,
  }));
  return paged(items, r.rows[0]?.total ?? 0, query.page, query.pageSize);
}

export interface SetLine {
  position: number;
  /** As the tracklist wrote it. */
  artist: string;
  title: string;
  genre: string | null;
  /** An unidentified ID ("ID - ID"): no song page. */
  isId: boolean;
  /** The song page name ("Artist - Title") for identified lines. */
  song: string | null;
  soundcloud: string | null;
}

export async function setDetail(pool: pg.Pool, sourceId: string): Promise<(SetCard & { lines: SetLine[]; lastRefreshed: string | null }) | undefined> {
  const s = await pool.query<{ id: number; source_id: string; url: string; title: string; performed_on: string | null; soundcloud_url: string | null; last_refreshed_at: Date | null }>(
    `select id, source_id, url, title, performed_on, soundcloud_url, last_refreshed_at from sets where source_id = $1`,
    [sourceId],
  );
  const set = s.rows[0];
  if (!set) return undefined;
  const [djs, lines] = await Promise.all([
    pool.query<{ name: string; image_url: string | null }>(
      `select a.name, a.image_url from set_djs sd join artists a on a.id = sd.artist_id where sd.set_id = $1 order by sd.position`,
      [set.id],
    ),
    pool.query<{ position: number; raw_artist: string; raw_title: string; genre: string | null; is_id: boolean; artist_text: string; title: string; soundcloud: string | null }>(
      `select st.position, st.raw_artist, st.raw_title, coalesce(st.genre, t.genre) genre, t.identity_key is null is_id, t.artist_text, t.title,
              (select l.url from external_track_links l where l.track_id = t.id order by l.confidence desc, l.created_at limit 1) soundcloud
         from set_tracks st join tracks t on t.id = st.track_id where st.set_id = $1 order by st.position`,
      [set.id],
    ),
  ]);
  return {
    id: set.source_id,
    url: set.url,
    title: set.title,
    event: eventOf(set.title),
    date: set.performed_on,
    djs: djs.rows.map((d) => ({ name: d.name, image: d.image_url })),
    tracks: lines.rows.length,
    ids: lines.rows.filter((l) => l.is_id).length,
    soundcloud: set.soundcloud_url,
    lastRefreshed: set.last_refreshed_at?.toISOString() ?? null,
    lines: lines.rows.map((l) => ({
      position: l.position,
      artist: l.raw_artist,
      title: l.raw_title,
      genre: l.genre,
      isId: l.is_id,
      song: l.is_id ? null : `${l.artist_text} - ${l.title}`,
      soundcloud: l.soundcloud,
    })),
  };
}

/** Genres used in the catalog, most common first (for filter menus). */
export async function genres(pool: pg.Pool, limit = 40): Promise<{ name: string; lines: number }[]> {
  const r = await pool.query<{ name: string; lines: number }>(
    `select g name, count(*)::int lines from (select coalesce(st.genre, t.genre) g from set_tracks st join tracks t on t.id = st.track_id) x
      where g is not null and g <> '' group by g order by count(*) desc, g limit $1`,
    [limit],
  );
  return r.rows;
}

/** Unidentified ID lines in indexed sets (for the Vault preview). */
export async function idStats(pool: pg.Pool): Promise<{ lines: number; sets: number }> {
  const r = await pool.query<{ lines: number; sets: number }>(
    `select count(*)::int lines, count(distinct st.set_id)::int sets from set_tracks st join tracks t on t.id = st.track_id where t.identity_key is null`,
  );
  return r.rows[0]!;
}

export interface SongCard {
  name: string;
  artist: string;
  title: string;
  genre: string | null;
  /** A photo of its first main artist that has one (not cover art). */
  image: string | null;
  /** A SoundCloud link to play it (confirmed, or matched automatically earlier). */
  soundcloud: string | null;
}

/** Artwork, genre and play link for songs named "Artist - Title" (unknown names are left out). */
export async function songCards(pool: pg.Pool, names: string[]): Promise<Map<string, SongCard>> {
  const keyOf = (name: string) => {
    const dash = name.indexOf(" - ");
    return dash === -1 ? null : `${normalizeName(name.slice(0, dash))} - ${baseTitle(name.slice(dash + 3))}`;
  };
  const keys = [...new Set(names.map(keyOf).filter((k): k is string => k !== null))];
  if (!keys.length) return new Map();
  const r = await pool.query<{ identity_key: string; artist_text: string; title: string; genre: string | null; image: string | null; soundcloud: string | null }>(
    `select t.identity_key, t.artist_text, t.title,
            coalesce(t.genre, (select mode() within group (order by st.genre) from set_tracks st where st.track_id = t.id and st.genre is not null)) genre,
            (select a.image_url from track_artists ta join artists a on a.id = ta.artist_id
              where ta.track_id = t.id and ta.role = 'main' and a.image_url is not null order by ta.position limit 1) image,
            (select l.url from external_track_links l where l.track_id = t.id
              order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc, l.created_at limit 1) soundcloud
       from tracks t where t.identity_key = any($1)`,
    [keys],
  );
  const byKey = new Map(r.rows.map((row) => [row.identity_key, row]));
  const out = new Map<string, SongCard>();
  for (const name of names) {
    const row = byKey.get(keyOf(name) ?? "");
    if (row) out.set(name, { name, artist: row.artist_text, title: row.title, genre: row.genre, image: row.image, soundcloud: row.soundcloud });
  }
  return out;
}

/** Set cards (DJ photos, track counts) for sets by their 1001Tracklists ids. */
export async function setCardsByIds(pool: pg.Pool, ids: string[]): Promise<Map<string, SetCard>> {
  if (!ids.length) return new Map();
  const r = await pool.query<{ source_id: string; url: string; title: string; performed_on: string | null; soundcloud_url: string | null; tracks: number; ids: number; djs: { name: string; image: string | null }[] | null }>(
    `select s.source_id, s.url, s.title, s.performed_on, s.soundcloud_url,
            (select count(*)::int from set_tracks st where st.set_id = s.id) tracks,
            (select count(*)::int from set_tracks st join tracks t on t.id = st.track_id where st.set_id = s.id and t.identity_key is null) ids,
            (select json_agg(json_build_object('name', a.name, 'image', a.image_url) order by sd.position)
               from set_djs sd join artists a on a.id = sd.artist_id where sd.set_id = s.id) djs
       from sets s where s.source_id = any($1)`,
    [ids],
  );
  return new Map(
    r.rows.map((row) => [
      row.source_id,
      { id: row.source_id, url: row.url, title: row.title, event: eventOf(row.title), date: row.performed_on, djs: row.djs ?? [], tracks: row.tracks, ids: row.ids, soundcloud: row.soundcloud_url },
    ]),
  );
}
