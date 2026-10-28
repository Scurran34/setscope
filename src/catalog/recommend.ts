// Recommended sets: the sets most likely to turn up music you'll care about, not the
// DJs with the most sets indexed. Each recent set (last year by performance date) is
// scored on what's in it, with saturating terms so no single signal runs away:
//
//   3   × sat(your liked songs it plays, 2)
//   2   × sat(tracks in it that DJs you follow also play elsewhere, 6)
//   1.5 × sat(tracks with limited broader support: played by 2–3 DJs anywhere, 4)
//   1   × sat(distinct identified tracks by other artists, 20)
//   1   × share of its lines in the genre you picked (or the genres of your likes)
//
// where sat(x, k) = x / (x + k), then × 0.5^(age / 90 days), and × 0.85 for radio and
// podcast episodes (a weekly show's episodes overlap a lot). Then a diversity pass
// fills the list: one set per DJ and per recurring show, and no near-copy (80%+ of the
// same tracks) of a set already chosen; the rest follow afterwards in score order.
// Every reason shown comes from these counts.

import type pg from "pg";
import { setCardsByIds, type SetCard } from "./browse.ts";
import { CANON, ELIGIBLE_SET, plays } from "./support.ts";

export const RECOMMEND = {
  /** Only sets performed in the last this-many days. */
  windowDays: 365,
  halfLifeDays: 90,
  radioWeight: 0.85,
  /** "Limited broader support": played by 2 to this many DJs anywhere in the index. */
  uncommonMaxDjs: 3,
  /** Sets per DJ, and per recurring show, before others get a turn. */
  perDj: 1,
  perSeries: 1,
  /** Two sets sharing at least this share of identified tracks are near-copies. */
  nearCopy: 0.8,
} as const;

const sat = (x: number, k: number) => x / (x + k);

export interface RecommendInput {
  likedTrackIds: number[];
  /** Canonical ids of DJs the person follows. */
  followed: number[];
  genre?: string | null;
  today: string;
  limit: number;
}

export interface RecommendedSet extends SetCard {
  /** Their liked songs it plays (names). */
  liked: string[];
  /** Why it's here, from real counts. */
  reasons: string[];
  score: number;
}

interface Candidate {
  id: number;
  sourceId: string;
  age: number;
  type: string;
  series: string | null;
  djs: number[];
  tracks: Set<number>;
  genres: Map<string, number>;
  lines: number;
}

export async function recommendSets(pool: pg.Pool, input: RecommendInput): Promise<RecommendedSet[]> {
  const r = await pool.query<{ id: number; source_id: string; age: number; set_type: string; series_key: string | null; djs: number[]; genres: Record<string, number> | null; lines: number }>(
    `with ${CANON}
     select s.id::int, s.source_id, ($1::date - s.performed_on)::int age, s.set_type, s.series_key,
            (select array_agg(distinct c.cid)::int[] from set_djs sd join canon c on c.id = sd.artist_id where sd.set_id = s.id) djs,
            (select json_object_agg(g, n) from (select coalesce(st.genre, t.genre) g, count(*) n from set_tracks st join tracks t on t.id = st.track_id
                                                  where st.set_id = s.id and coalesce(st.genre, t.genre) is not null group by 1) x) genres,
            (select count(*)::int from set_tracks st where st.set_id = s.id) lines
       from sets s where ${ELIGIBLE_SET("s", "$1::date")} and s.performed_on > $1::date - $2::int`,
    [input.today, RECOMMEND.windowDays],
  );
  const sets = new Map<number, Candidate>(
    r.rows.map((row) => [
      row.id,
      { id: row.id, sourceId: row.source_id, age: row.age, type: row.set_type, series: row.series_key, djs: row.djs ?? [], tracks: new Set<number>(), genres: new Map(Object.entries(row.genres ?? {})), lines: row.lines },
    ]),
  );

  // Who plays each track, anywhere in the index (third-party plays, all time). The same
  // rows give each candidate set its tracks by other artists (IDs and the DJs' own music left out).
  const playedBy = new Map<number, Map<number, Set<number>>>(); // track -> dj -> sets
  for (const p of await plays(pool, { djIds: null, genre: null, moment: null, today: input.today })) {
    sets.get(p.set)?.tracks.add(p.track);
    let djs = playedBy.get(p.track);
    if (!djs) playedBy.set(p.track, (djs = new Map()));
    let s = djs.get(p.dj);
    if (!s) djs.set(p.dj, (s = new Set()));
    s.add(p.set);
  }
  const liked = new Set(input.likedTrackIds);
  const followed = new Set(input.followed);
  // Genres to match: the one asked for, else the genres of the person's likes.
  let wanted = new Set<string>(input.genre ? [input.genre.toLowerCase()] : []);
  if (!wanted.size && liked.size) {
    const g = await pool.query<{ genre: string }>(
      `select coalesce(st.genre, t.genre) genre from set_tracks st join tracks t on t.id = st.track_id
        where st.track_id = any($1) and coalesce(st.genre, t.genre) is not null group by 1 order by count(*) desc limit 3`,
      [[...liked]],
    );
    wanted = new Set(g.rows.map((x) => x.genre.toLowerCase()));
  }

  const scored = [...sets.values()].map((c) => {
    const likedHere = [...c.tracks].filter((t) => liked.has(t));
    const followedDjs = new Set<number>();
    let followedTracks = 0;
    let uncommon = 0;
    for (const t of c.tracks) {
      const djs = playedBy.get(t);
      let byFollowed = false;
      for (const [dj, setsOf] of djs ?? []) {
        // A followed DJ's support counts when it's in another set (not this one).
        if (followed.has(dj) && [...setsOf].some((s) => s !== c.id)) {
          followedDjs.add(dj);
          byFollowed = true;
        }
      }
      if (byFollowed) followedTracks++;
      // Some support, but not much breadth: 2 or 3 DJs anywhere.
      const breadth = djs?.size ?? 0;
      if (breadth >= 2 && breadth <= RECOMMEND.uncommonMaxDjs) uncommon++;
    }
    const genreLines = [...c.genres].filter(([g]) => wanted.has(g.toLowerCase())).reduce((n, [, k]) => n + k, 0);
    const genreShare = wanted.size && c.lines ? genreLines / c.lines : 0;
    const score =
      (3 * sat(likedHere.length, 2) + 2 * sat(followedTracks, 6) + 1.5 * sat(uncommon, 4) + sat(c.tracks.size, 20) + genreShare) *
      0.5 ** (c.age / RECOMMEND.halfLifeDays) *
      (c.type === "radio" || c.type === "podcast" ? RECOMMEND.radioWeight : 1);
    const reasons: string[] = [];
    if (likedHere.length) reasons.push(`Plays ${likedHere.length} of your liked songs`);
    if (followedDjs.size >= 2) reasons.push(`Contains tracks played by ${followedDjs.size} DJs you follow`);
    else if (followedDjs.size === 1 && followedTracks >= 2) reasons.push(`${followedTracks} tracks a DJ you follow also plays`);
    if (uncommon >= 2) reasons.push(`Includes ${uncommon} tracks with limited broader DJ support`);
    if (genreShare >= 0.5) reasons.push(input.genre ? `Mostly ${input.genre}` : "Mostly the genres you like");
    return { c, score, likedHere, reasons };
  });
  scored.sort((a, b) => b.score - a.score || a.c.age - b.c.age || a.c.id - b.c.id);

  // Diversity: one per DJ and per show, and no near-copies, before anything repeats.
  const chosen: typeof scored = [];
  const later: typeof scored = [];
  const perDj = new Map<number, number>();
  const perSeries = new Map<string, number>();
  const similar = (a: Set<number>, b: Set<number>) => {
    if (!a.size || !b.size) return false;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.max(a.size, b.size) >= RECOMMEND.nearCopy;
  };
  for (const s of scored) {
    if (chosen.length >= input.limit) break;
    const crowded =
      s.c.djs.some((dj) => (perDj.get(dj) ?? 0) >= RECOMMEND.perDj) ||
      (s.c.series !== null && (s.c.type === "radio" || s.c.type === "podcast") && (perSeries.get(s.c.series) ?? 0) >= RECOMMEND.perSeries) ||
      chosen.some((x) => similar(x.c.tracks, s.c.tracks));
    if (crowded) {
      later.push(s);
      continue;
    }
    chosen.push(s);
    for (const dj of s.c.djs) perDj.set(dj, (perDj.get(dj) ?? 0) + 1);
    if (s.c.series) perSeries.set(s.c.series, (perSeries.get(s.c.series) ?? 0) + 1);
  }
  const top = [...chosen, ...later].slice(0, input.limit);
  const [cards, names] = await Promise.all([
    setCardsByIds(pool, top.map((s) => s.c.sourceId)),
    pool.query<{ id: number; name: string }>("select id::int, artist_text || ' - ' || title name from tracks where id = any($1)", [top.flatMap((s) => s.likedHere)]),
  ]);
  const nameOf = new Map(names.rows.map((x) => [x.id, x.name]));
  return top.flatMap((s) => {
    const card = cards.get(s.c.sourceId);
    return card ? [{ ...card, liked: s.likedHere.map((t) => nameOf.get(t) ?? "").filter(Boolean), reasons: s.reasons, score: Math.round(s.score * 1000) / 1000 }] : [];
  });
}
