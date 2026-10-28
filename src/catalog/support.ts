// DJ support, measured three separate ways (docs/RANKINGS.md has the full write-up):
//
//   Breadth    how many different DJs played a recording (canonical DJs: an alias is
//              the same DJ, and a DJ playing it 30 times is still one DJ)
//   Repeat     how often those DJs come back to it, with diminishing returns: each DJ's
//              plays are worth min(1 + 0.25·log2(plays), 2) DJ-equivalents, so one DJ can
//              add at most one extra DJ's worth however many times they play it. Radio
//              and podcast episodes count 0.75 of a play here, and at most 8 episodes of
//              one recurring show count, so a weekly show can't drown out other DJs
//   Momentum   who played it recently (performance dates, never collection dates), DJs
//              who've only just started playing it, and support compared with the
//              period before, when there's enough earlier data to say
//
// Each mode combines them in its own documented way (scoreNow, scoreMost, scoreDeep);
// the underlying numbers are always shown next to the ranking. The evidence is set
// appearances in sets Rabbithole has indexed: it shows what DJs played, not why, and
// can't tell organic support from promotion.

import type pg from "pg";

/** Every tunable number in one place, so the docs and the tests can point at them. */
export const SUPPORT = {
  /** A DJ's contribution: 1 + REPEAT_LOG·log2(plays), capped at REPEAT_CAP. */
  repeatLog: 0.25,
  repeatCap: 2,
  /** Most Played / Playing Now: how much of a DJ's repeat bonus counts (breadth stays first). */
  repeatWeight: 0.5,
  /** A radio or podcast episode counts this much of a play toward the repeat bonus (never toward breadth). */
  radioWeight: 0.75,
  /** At most this many episodes of one recurring show count toward one DJ's repeats. */
  seriesCap: 8,
  /** "Recent supporting DJs": played it in the last this-many days. */
  recentDays: 90,
  /** Playing Now: a DJ who first played it inside the window counts this much extra. */
  newDjBonus: 0.25,
  /** Deep Cuts: rarity = prior / (prior + DJs anywhere in the index who play it). */
  deepRarityPrior: 3,
  /** Deep Cuts: no more than this share of all indexed DJs may play it (and at least deepMinDjs). */
  deepMaxDjShare: 0.01,
  deepMinDjs: 4,
  /** Growth is only reported with at least this many active DJs in each period... */
  minActiveDjs: 5,
  /** ...and with the track played by at least this many DJs in the earlier one. */
  minPrevDjs: 2,
} as const;

// ---------- the formulas (pure, deterministic) ----------

export interface Play {
  /** Days between the performance and today. */
  age: number;
  type: SetType;
  series: string | null;
}
export type SetType = "live" | "radio" | "podcast" | "unknown";

/**
 * One DJ's plays of a track, as the number the repeat bonus uses: live and unlisted sets
 * count 1, radio/podcast episodes SUPPORT.radioWeight, and no more than SUPPORT.seriesCap
 * episodes of any one recurring show. Never below 1 (they played it at least once).
 */
export function effectivePlays(plays: Pick<Play, "type" | "series">[]): number {
  const perSeries = new Map<string, number>();
  let total = 0;
  for (const p of plays) {
    if (p.series && (p.type === "radio" || p.type === "podcast")) {
      const seen = perSeries.get(p.series) ?? 0;
      perSeries.set(p.series, seen + 1);
      if (seen >= SUPPORT.seriesCap) continue;
    }
    total += p.type === "radio" || p.type === "podcast" ? SUPPORT.radioWeight : 1;
  }
  return Math.max(1, total);
}

/** min(1 + 0.25·log2(plays), 2): one DJ is worth between 1 and 2 DJ-equivalents. */
export function djContribution(plays: number): number {
  return Math.min(1 + SUPPORT.repeatLog * Math.log2(Math.max(1, plays)), SUPPORT.repeatCap);
}

/**
 * Most Played: Σ over supporting DJs of share × (1 + repeatWeight·(contribution − 1)).
 * Equal to the number of DJs, plus up to half a DJ each for coming back to it. `shares`
 * (default 1 each) splits a back-to-back set between its DJs: a DJ whose only plays were
 * in a B2B with two others counts a third (see DjSupport.share).
 */
export function scoreMost(perDjPlays: number[], shares: number[] = []): number {
  return perDjPlays.reduce((sum, plays, i) => sum + (shares[i] ?? 1) * (1 + SUPPORT.repeatWeight * (djContribution(plays) - 1)), 0);
}

/** Half-life of a DJ's support in Playing Now: a third of the window, at least two weeks. */
export function nowHalfLife(windowDays: number): number {
  return Math.max(14, windowDays / 3);
}

/**
 * Playing Now: like Most Played over the window, but each DJ's part fades with the age of
 * their latest play (halving every nowHalfLife days), and a DJ who only started playing
 * it inside the window counts newDjBonus extra.
 */
export function scoreNow(djs: { plays: number; latestAge: number; isNew: boolean; share?: number }[], windowDays: number): number {
  const half = nowHalfLife(windowDays);
  return djs.reduce(
    (sum, d) => sum + (d.share ?? 1) * (1 + SUPPORT.repeatWeight * (djContribution(d.plays) - 1)) * 0.5 ** (d.latestAge / half) * (d.isNew ? 1 + SUPPORT.newDjBonus : 1),
    0,
  );
}

/**
 * Deep Cuts: support from the selected DJs (full repeat contribution: one DJ who keeps
 * coming back to a record is the point), times how rare it is across the whole index,
 * times how much evidence there is:
 *   Σ contribution(selected DJs)  ×  prior / (prior + DJs anywhere who play it)  ×  sets / (sets + 1)
 * Rarity saturates quickly, so past a handful of DJs it's repeat support from the
 * selected DJs that decides, not breadth.
 */
export function scoreDeep(selectedPlays: number[], selectedSets: number, djsAnywhere: number, shares: number[] = []): number {
  const support = selectedPlays.reduce((sum, plays, i) => sum + (shares[i] ?? 1) * djContribution(plays), 0);
  return support * (SUPPORT.deepRarityPrior / (SUPPORT.deepRarityPrior + djsAnywhere)) * (selectedSets / (selectedSets + 1));
}

/** Deep Cuts: the most DJs in the whole catalog that may play a track for it to count as uncommon. */
export function deepCutMaxDjs(catalogDjs: number): number {
  return Math.max(SUPPORT.deepMinDjs, Math.ceil(SUPPORT.deepMaxDjShare * catalogDjs));
}

/**
 * Change in the share of active DJs playing it, this period vs the one before, in %.
 * "new" when nobody played it before but several do now; null when there isn't enough
 * earlier data to say anything (shown as such, never as a made-up percentage).
 */
export function growth(djsNow: number, activeNow: number, djsBefore: number, activeBefore: number): number | "new" | null {
  if (activeNow < SUPPORT.minActiveDjs || activeBefore < SUPPORT.minActiveDjs) return null;
  if (djsBefore === 0) return djsNow >= 3 ? "new" : null;
  if (djsBefore < SUPPORT.minPrevDjs) return null;
  return Math.round(((djsNow / activeNow) / (djsBefore / activeBefore) - 1) * 100);
}

/** Played Alongside: below this many sets with the song, associations are flagged as thin. */
export const ALONGSIDE_MIN_ANCHOR_SETS = 10;
/** Played Alongside: shared DJs needed before an association is fully trusted (dj / (dj + this)). */
export const ALONGSIDE_DJ_PRIOR = 2;

/**
 * Played Alongside, "Goes with it": how strongly two tracks belong together.
 *   shared / √(anchor sets × candidate sets)   (cosine: high only when both mostly appear together)
 *   × sharedDjs / (sharedDjs + 2)               (one DJ's weekly show repeating a pair isn't many DJs agreeing)
 * So 4 of 4 sets (by 4 DJs, with a song in 60 sets) scores 0.17, while 25 of 50 (by 10
 * DJs) scores 0.38: a big, consistent sample beats a tiny perfect one.
 */
export function goesWith(shared: number, anchorSets: number, candidateSets: number, sharedDjs: number): number {
  if (!shared || !anchorSets || !candidateSets) return 0;
  return (shared / Math.sqrt(anchorSets * candidateSets)) * (sharedDjs / (sharedDjs + ALONGSIDE_DJ_PRIOR));
}

// ---------- the data ----------

/** Version types made by someone other than the original artist (their "remixer" is its creator). */
export const VERSION_TYPES = "('remix', 'edit', 'vip', 'bootleg', 'rework', 'mashup')";

/**
 * SQL: is credit `ta` on track `t` a production credit? The creator of a remix, edit,
 * VIP, bootleg, rework or mashup ("remixer"), or a main artist of an original. Not
 * featured vocalists, not the original artist of someone else's version, and not the
 * artists whose songs a mashup uses (samples are never guessed: the source doesn't say).
 */
export const PRODUCTION = (ta: string, t: string) => `(${ta}.role = 'remixer' or (${ta}.role = 'main' and ${t}.version_type not in ${VERSION_TYPES}))`;

/** Artist id -> canonical artist id (itself, unless it's a verified alias). */
export const CANON = `canon as (select a.id, coalesce(al.canonical_id, a.id) cid from artists a left join artist_aliases al on al.artist_id = a.id)`;

/** Sets counted anywhere: dated, not in the future, and not a second copy of a performance. */
export const ELIGIBLE_SET = (s: string, today: string) =>
  `${s}.performed_on is not null and ${s}.performed_on <= ${today} and not exists (select 1 from set_duplicates dup where dup.set_id = ${s}.id)`;

/** A qualifying play: a third-party track in an eligible set, by one of the set's DJs. */
export interface PlayRow extends Play {
  track: number;
  set: number;
  dj: number;
  /** How many DJs performed the set (2 for a back-to-back). */
  djsInSet: number;
}

export interface ScopeSet {
  set: number;
  dj: number;
  age: number;
}

export interface PlaysQuery {
  /** Canonical DJ ids; null for every DJ. */
  djIds: number[] | null;
  genre: string | null;
  /** Only the first or last lines of reasonably complete tracklists (Intros / 90 + 5). */
  moment: "intro" | "closer" | null;
  today: string;
}

/** Intros / 90 + 5: how many lines at the start or end of a set count, and how long a tracklist must be. */
export const MOMENT_LINES = 2;
export const MOMENT_MIN_TRACKS = 10;

/**
 * Every qualifying play by the scope's DJs, all time up to today: one row per
 * (track, set, supporting DJ). A play counts only if none of the set's DJs is credited
 * on the track in any role (aliases folded in): DJs playing their own music isn't
 * support. Unidentified IDs never count.
 */
async function loadPlays(pool: pg.Pool, q: PlaysQuery): Promise<PlayRow[]> {
  const r = await pool.query<PlayRow>(
    `with ${CANON},
     set_dj as (select sd.set_id, c.cid from set_djs sd join canon c on c.id = sd.artist_id),
     eligible as (
       select s.id, s.performed_on, s.set_type, s.series_key from sets s
        where ${ELIGIBLE_SET("s", "$4::date")}
          and ($1::bigint[] is null or exists (select 1 from set_dj d where d.set_id = s.id and d.cid = any($1)))
     ),
     set_len as (select set_id, count(*) n, max(position) last_pos from set_tracks where $3::text is not null group by set_id),
     lines as (
       select distinct st.track_id, e.id set_id
         from eligible e join set_tracks st on st.set_id = e.id join tracks t on t.id = st.track_id
         left join set_len sl on sl.set_id = e.id
        where t.identity_key is not null
          and ($2::text is null or coalesce(st.genre, t.genre) = $2)
          and ($3::text is null or (sl.n >= ${MOMENT_MIN_TRACKS} and (
                ($3 = 'intro' and st.position < ${MOMENT_LINES}) or ($3 = 'closer' and st.position > sl.last_pos - ${MOMENT_LINES}))))
     ),
     own as (
       select distinct l.set_id, l.track_id
         from lines l join set_dj d on d.set_id = l.set_id
         join track_artists ta on ta.track_id = l.track_id join canon c on c.id = ta.artist_id and c.cid = d.cid
     ),
     set_size as (select d.set_id, count(distinct d.cid)::int n from set_dj d join eligible e on e.id = d.set_id group by d.set_id)
     select l.track_id::int track, l.set_id::int set, d.cid::int dj, ($4::date - e.performed_on)::int age, e.set_type type, e.series_key series,
            ss.n "djsInSet"
       from lines l join eligible e on e.id = l.set_id join set_dj d on d.set_id = l.set_id join set_size ss on ss.set_id = l.set_id
       left join own o on o.set_id = l.set_id and o.track_id = l.track_id
      where o.set_id is null and ($1::bigint[] is null or d.cid = any($1))`,
    [q.djIds, q.genre, q.moment, q.today],
  );
  return r.rows;
}

/** The scope's eligible sets with their DJs (for coverage, active DJs per period, and who's new). */
async function loadScopeSets(pool: pg.Pool, djIds: number[] | null, today: string): Promise<ScopeSet[]> {
  const r = await pool.query<ScopeSet>(
    `with ${CANON}
     select s.id::int set, c.cid::int dj, ($2::date - s.performed_on)::int age
       from sets s join set_djs sd on sd.set_id = s.id join canon c on c.id = sd.artist_id
      where ${ELIGIBLE_SET("s", "$2::date")} and ($1::bigint[] is null or c.cid = any($1))`,
    [djIds, today],
  );
  return r.rows;
}

/**
 * Anything that changes rankings: sets saved or refreshed, aliases, duplicates, credits.
 * Cheap to ask, so every request checks it and cached results never go stale.
 */
async function catalogVersion(pool: pg.Pool): Promise<string> {
  const r = await pool.query<{ v: string }>(
    `select concat_ws('|', (select count(*) from sets), (select max(greatest(first_indexed_at, coalesce(last_refreshed_at, first_indexed_at))) from sets),
                     (select count(*) from artist_aliases), (select count(*) from set_duplicates),
                     (select value from app_meta where key = 'credits_version')) v`,
  );
  return r.rows[0]!.v;
}

/** One cache per database pool (tests run several side by side). */
const caches = new WeakMap<pg.Pool, Map<string, Promise<unknown>>>();
const CACHE_SIZE = 40;

/** Remember a result until the catalog changes (or it's one of the oldest of CACHE_SIZE). */
async function cached<T>(pool: pg.Pool, key: string, load: () => Promise<T>): Promise<T> {
  let cache = caches.get(pool);
  if (!cache) caches.set(pool, (cache = new Map()));
  const full = `${await catalogVersion(pool)}#${key}`;
  let hit = cache.get(full) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    cache.set(full, hit);
    hit.catch(() => cache.delete(full));
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  return hit;
}

export async function plays(pool: pg.Pool, q: PlaysQuery): Promise<PlayRow[]> {
  return cached(pool, `plays:${JSON.stringify(q)}`, () => loadPlays(pool, q));
}

export async function scopeSets(pool: pg.Pool, djIds: number[] | null, today: string): Promise<ScopeSet[]> {
  return cached(pool, `scope:${JSON.stringify([djIds, today])}`, () => loadScopeSets(pool, djIds, today));
}

/** Forget everything cached for a database (after changes catalogVersion can't see). */
export function clearSupportCache(pool: pg.Pool): void {
  caches.delete(pool);
}

// ---------- per-track metrics ----------

export interface DjSupport {
  dj: number;
  /** Distinct sets in the window. */
  sets: number;
  /** effectivePlays() of those sets. */
  plays: number;
  latestAge: number;
  /** Their first play of it, ever (in indexed sets). */
  firstAge: number;
  /**
   * 1 if they ever played it in a set of their own; 1/n if only ever in back-to-back
   * sets with n DJs (one selection, shared). Breadth still counts them as one DJ; the
   * scores use this share.
   */
  share: number;
}

export interface TrackSupport {
  track: number;
  /** Breadth: distinct canonical DJs in the window. */
  djs: DjSupport[];
  /** Distinct qualifying sets in the window. */
  sets: number;
  /** Supporting DJs who played it in more than one set in the window. */
  repeatDjs: number;
  latestAge: number;
  /** Distinct DJs in the last SUPPORT.recentDays (whatever the window). */
  recentDjs: number;
  recentSets: number;
  /** DJs in the window, and in the equally long period before it (for growth). */
  prevDjs: number;
}

/**
 * Group plays by track for a window of `windowDays` (null: all time), most supported first
 * isn't decided here: each mode orders them itself.
 */
export function supportByTrack(rows: PlayRow[], windowDays: number | null): Map<number, TrackSupport> {
  const byTrack = new Map<number, { djs: Map<number, { sets: Set<number>; plays: Play[]; latest: number; first: number; share: number }>; sets: Set<number>; latest: number; recentDjs: Set<number>; recentSets: Set<number>; prevDjs: Set<number> }>();
  const inWindow = (age: number) => windowDays === null || age < windowDays;
  for (const p of rows) {
    let t = byTrack.get(p.track);
    if (!t) {
      t = { djs: new Map(), sets: new Set(), latest: Infinity, recentDjs: new Set(), recentSets: new Set(), prevDjs: new Set() };
      byTrack.set(p.track, t);
    }
    if (p.age < SUPPORT.recentDays) {
      t.recentDjs.add(p.dj);
      t.recentSets.add(p.set);
    }
    if (windowDays !== null && p.age >= windowDays && p.age < 2 * windowDays) t.prevDjs.add(p.dj);
    let d = t.djs.get(p.dj);
    if (!d) {
      d = { sets: new Set(), plays: [], latest: Infinity, first: -Infinity, share: 0 };
      t.djs.set(p.dj, d);
    }
    d.first = Math.max(d.first, p.age);
    if (!inWindow(p.age)) continue;
    t.sets.add(p.set);
    t.latest = Math.min(t.latest, p.age);
    if (!d.sets.has(p.set)) {
      d.sets.add(p.set);
      d.plays.push(p);
      d.latest = Math.min(d.latest, p.age);
      d.share = Math.max(d.share, 1 / Math.max(1, p.djsInSet));
    }
  }
  const out = new Map<number, TrackSupport>();
  for (const [track, t] of byTrack) {
    if (!t.sets.size) continue;
    const djs = [...t.djs.entries()]
      .filter(([, d]) => d.sets.size > 0)
      .map(([dj, d]) => ({ dj, sets: d.sets.size, plays: effectivePlays(d.plays), latestAge: d.latest, firstAge: d.first, share: d.share }))
      .sort((a, b) => b.sets - a.sets || a.latestAge - b.latestAge || a.dj - b.dj);
    out.set(track, {
      track,
      djs,
      sets: t.sets.size,
      repeatDjs: djs.filter((d) => d.sets > 1).length,
      latestAge: t.latest,
      recentDjs: t.recentDjs.size,
      recentSets: t.recentSets.size,
      prevDjs: t.prevDjs.size,
    });
  }
  return out;
}

/** Each scope DJ's earliest indexed set (age in days), and how many DJs were active in a period. */
export function scopeFacts(sets: ScopeSet[], windowDays: number | null): { earliest: Map<number, number>; activeNow: number; activeBefore: number; setsInWindow: number; djsInWindow: number; from: number | null; to: number | null } {
  const earliest = new Map<number, number>();
  const now = new Set<number>();
  const before = new Set<number>();
  const windowSets = new Set<number>();
  let from: number | null = null;
  let to: number | null = null;
  for (const s of sets) {
    earliest.set(s.dj, Math.max(earliest.get(s.dj) ?? -Infinity, s.age));
    if (windowDays === null || s.age < windowDays) {
      now.add(s.dj);
      windowSets.add(s.set);
      from = from === null ? s.age : Math.max(from, s.age);
      to = to === null ? s.age : Math.min(to, s.age);
    } else if (s.age < 2 * windowDays) before.add(s.dj);
  }
  return { earliest, activeNow: now.size, activeBefore: before.size, setsInWindow: windowSets.size, djsInWindow: now.size, from, to };
}

/**
 * A DJ is "new" to a track when their first indexed play of it is inside the window and
 * Rabbithole has an earlier set of theirs without it. Without earlier sets we can't tell
 * new from merely newly indexed, so they don't count as new.
 */
export function isNewSupporter(d: DjSupport, windowDays: number, earliestSetAge: number | undefined): boolean {
  return d.firstAge < windowDays && earliestSetAge !== undefined && earliestSetAge >= windowDays;
}

export interface SongSupport {
  /** Breadth: distinct canonical DJs who played it in someone else's set... */
  djs: number;
  /** ...in this many distinct eligible sets (all indexed history). */
  sets: number;
  /** DJs who played it in 2+ sets. */
  repeatDjs: number;
  /** In the last SUPPORT.recentDays: distinct DJs and sets. */
  recentDjs: number;
  recentSets: number;
  /** Of the recent DJs, how many only started playing it then (see isNewSupporter). */
  newDjs: number;
  /** Recent DJs vs the period before, as a share of active DJs; null without enough data. */
  growth: number | "new" | null;
  lastPlayed: string | null;
  /** The days "recent" covers. */
  recentDays: number;
}

/** The three support numbers for one song, over every indexed DJ (song pages). */
export async function songSupport(pool: pg.Pool, trackId: number, today: string): Promise<SongSupport> {
  const [rows, sets] = await Promise.all([plays(pool, { djIds: null, genre: null, moment: null, today }), scopeSets(pool, null, today)]);
  const mine = rows.filter((r) => r.track === trackId);
  const all = supportByTrack(mine, null).get(trackId);
  const recent = supportByTrack(mine, SUPPORT.recentDays).get(trackId);
  const facts = scopeFacts(sets, SUPPORT.recentDays);
  const last = all ? new Date(Date.parse(`${today}T00:00:00Z`) - all.latestAge * 86_400_000).toISOString().slice(0, 10) : null;
  return {
    djs: all?.djs.length ?? 0,
    sets: all?.sets ?? 0,
    repeatDjs: all?.repeatDjs ?? 0,
    recentDjs: recent?.djs.length ?? 0,
    recentSets: recent?.sets ?? 0,
    newDjs: recent ? recent.djs.filter((d) => isNewSupporter(d, SUPPORT.recentDays, facts.earliest.get(d.dj))).length : 0,
    growth: growth(recent?.djs.length ?? 0, facts.activeNow, new Set(mine.filter((r) => r.age >= SUPPORT.recentDays && r.age < 2 * SUPPORT.recentDays).map((r) => r.dj)).size, facts.activeBefore),
    lastPlayed: last,
    recentDays: SUPPORT.recentDays,
  };
}
