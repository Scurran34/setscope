// The shared catalog in Postgres. Saving a set writes its artists, tracks (with their
// identities), DJs and ordered tracklist; re-saving it after a refresh records what
// changed line by line in track_metadata_history.
//
// all() rebuilds the sets in the shape the analysis functions use, and keeps them in
// memory until the next save, so reports don't re-read the database on every request.

import type pg from "pg";
import type { DjProfile, Track, Tracklist } from "../model.ts";
import { displayName, normalizeName } from "../normalize.ts";
import { transaction, type Db } from "../db/pool.ts";
import type { Catalog } from "./catalog.ts";
import { PARSER_VERSION, parseTracklist } from "../source/parse.ts";
import { identify } from "./identity.ts";

const SOURCE = "1001tracklists";

export class PgCatalog implements Catalog {
  private readonly pool: pg.Pool;
  private cache: Tracklist[] | undefined;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async has(sourceId: string): Promise<boolean> {
    const r = await this.pool.query("select 1 from sets where source = $1 and source_id = $2", [SOURCE, sourceId]);
    return r.rowCount! > 0;
  }

  async count(): Promise<number> {
    const r = await this.pool.query<{ n: number }>("select count(*)::int as n from sets");
    return r.rows[0]!.n;
  }

  async save(set: Tracklist, html: string): Promise<void> {
    await transaction(this.pool, (client) => saveSet(client, set, html));
    this.cache = undefined;
  }

  async all(): Promise<Tracklist[]> {
    this.cache ??= await loadSets(this.pool);
    return this.cache;
  }

  /**
   * Re-read the saved page of every set indexed by an older parser, so new parser
   * features (genre, DJ cards...) reach old sets without refetching. Returns how many.
   */
  async reparseOutdated(): Promise<number> {
    const r = await this.pool.query<{ url: string; html: string }>(
      `select s.url, p.html from sets s join set_pages p on p.set_id = s.id
        where coalesce(s.parser_version, 0) < $1 and p.html <> ''`,
      [PARSER_VERSION],
    );
    for (const row of r.rows) await this.save(parseTracklist(row.html, row.url), row.html);
    return r.rows.length;
  }

  /** Re-read every saved page with the current parser (`setscope reparse`). */
  async reparseAll(): Promise<number> {
    const r = await this.pool.query<{ url: string; html: string }>(
      `select s.url, p.html from sets s join set_pages p on p.set_id = s.id where p.html <> ''`,
    );
    for (const row of r.rows) await this.save(parseTracklist(row.html, row.url), row.html);
    return r.rows.length;
  }

  /** Forget the in-memory copy (after changes made outside this object, e.g. an import). */
  invalidate(): void {
    this.cache = undefined;
  }
}

// ---------- saving ----------

async function saveSet(db: Db, set: Tracklist, html: string): Promise<void> {
  const setId = await upsertSet(db, set);

  // DJs: their card on the page (country, picture, links) improves the artist row.
  const cards = new Map((set.djProfiles ?? []).map((p) => [normalizeName(p.name), p]));
  await db.query("delete from set_djs where set_id = $1", [setId]);
  for (const [i, dj] of set.djs.entries()) {
    const artistId = await upsertArtist(db, dj, set.djPages?.[dj], cards.get(normalizeName(dj)));
    await db.query("insert into set_djs (set_id, artist_id, position) values ($1, $2, $3) on conflict do nothing", [setId, artistId, i]);
  }

  // Tracklist: resolve each line to a track, compare with what was there before.
  const before = new Map(
    (
      await db.query<{ position: number; track_id: number; raw_artist: string; raw_title: string }>(
        "select position, track_id, raw_artist, raw_title from set_tracks where set_id = $1",
        [setId],
      )
    ).rows.map((r) => [r.position, r]),
  );
  await db.query("delete from set_tracks where set_id = $1", [setId]);
  for (const [position, track] of set.tracks.entries()) {
    const previous = before.get(position);
    const unchangedPlaceholder =
      previous && previous.raw_artist === track.artist && previous.raw_title === track.title && !track.trackId;
    const trackId = unchangedPlaceholder ? previous.track_id : await resolveTrack(db, track);
    await db.query(
      "insert into set_tracks (set_id, position, track_id, raw_artist, raw_title, genre) values ($1, $2, $3, $4, $5, $6)",
      [setId, position, trackId, track.artist, track.title, track.genre ?? null],
    );
    if (previous && (previous.raw_artist !== track.artist || previous.raw_title !== track.title)) {
      await db.query(
        `insert into track_metadata_history (set_id, position, old_track_id, new_track_id, old_text, new_text)
         values ($1, $2, $3, $4, $5, $6)`,
        [setId, position, previous.track_id, trackId, `${previous.raw_artist} - ${previous.raw_title}`, displayName(track)],
      );
    }
  }

  await db.query(
    `insert into set_pages (set_id, html, fetched_at) values ($1, $2, now())
     on conflict (set_id) do update set html = excluded.html, fetched_at = now()`,
    [setId, html],
  );
  // Link versions to their originals, in both directions: a remix in this set whose
  // original is already known, and earlier remixes whose original just arrived.
  await db.query(
    `update tracks t set parent_track_id = o.id
       from tracks o
      where t.original_key = o.identity_key and t.parent_track_id is null
        and (t.id in (select track_id from set_tracks where set_id = $1)
          or o.id in (select track_id from set_tracks where set_id = $1))`,
    [setId],
  );
}

async function upsertSet(db: Db, set: Tracklist): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into sets (source, source_id, url, title, performed_on, soundcloud_url, parser_version, last_refreshed_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (source, source_id) do update set
       url = excluded.url, title = excluded.title, performed_on = excluded.performed_on,
       soundcloud_url = coalesce(excluded.soundcloud_url, sets.soundcloud_url),
       parser_version = excluded.parser_version, last_refreshed_at = now()
     returning id`,
    [SOURCE, set.id, set.url, set.title, set.date || null, set.soundcloud ?? null, set.parserVersion ?? null],
  );
  return r.rows[0]!.id;
}

/** Find or create an artist by normalized name, filling in anything we learned. */
async function upsertArtist(db: Db, name: string, page?: string, card?: DjProfile): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into artists (name, name_key, tl_page, country, image_url, links)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (name_key) do update set
       -- A DJ's set-list page (/tracklists.html) beats a track-credit page (/tracks.html).
       tl_page = case
         when excluded.tl_page is null then artists.tl_page
         when artists.tl_page is null or excluded.tl_page like '%/tracklists.html' then excluded.tl_page
         else artists.tl_page end,
       country = coalesce(excluded.country, artists.country),
       image_url = coalesce(excluded.image_url, artists.image_url),
       links = case when jsonb_array_length(excluded.links) > 0 then excluded.links else artists.links end,
       updated_at = now()
     returning id`,
    [name, normalizeName(name), card?.page ?? page ?? null, card?.country ?? null, card?.image ?? null, JSON.stringify(card?.links ?? [])],
  );
  return r.rows[0]!.id;
}

/**
 * The track a tracklist line refers to:
 *   1. 1001Tracklists' own track id, when the page gives one;
 *   2. otherwise, for identified tracks, the normalized identity;
 *   3. otherwise (an unidentified ID) a new placeholder, never matched by name.
 */
async function resolveTrack(db: Db, track: Track): Promise<number> {
  const id = identify(track);
  let trackId: number | undefined;

  if (track.trackId) {
    const r = await db.query<{ id: number }>("select id from tracks where tl_track_id = $1", [track.trackId]);
    trackId = r.rows[0]?.id;
  }
  if (trackId === undefined && id.identityKey) {
    const r = await db.query<{ id: number; tl_track_id: string | null }>("select id, tl_track_id from tracks where identity_key = $1", [id.identityKey]);
    const found = r.rows[0];
    if (found) {
      trackId = found.id;
      if (track.trackId && !found.tl_track_id) {
        await db.query("update tracks set tl_track_id = $1, updated_at = now() where id = $2", [track.trackId, found.id]);
      }
    }
  }

  if (trackId === undefined) {
    // An identity already used by another tl id can't be reused: keep the source's id as truth.
    const keyTaken = id.identityKey
      ? (await db.query("select 1 from tracks where identity_key = $1", [id.identityKey])).rowCount! > 0
      : false;
    const r = await db.query<{ id: number }>(
      `insert into tracks (artist_text, title, identity_key, tl_track_id, version_type, version_artists, original_key, label, genre, id_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        track.artist,
        track.title,
        keyTaken ? null : id.identityKey,
        track.trackId ?? null,
        id.versionType,
        id.versionArtists ?? null,
        id.originalKey ?? null,
        track.label ?? null,
        track.genre ?? null,
        id.idStatus,
      ],
    );
    trackId = r.rows[0]!.id;
  } else {
    await db.query(
      `update tracks set label = coalesce($2, label), genre = coalesce($3, genre), updated_at = now() where id = $1`,
      [trackId, track.label ?? null, track.genre ?? null],
    );
  }

  // Credits: main artists and remixers, with their 1001Tracklists pages when known.
  for (const [role, names] of [["main", id.mainArtists], ["remixer", id.remixers]] as const) {
    for (const [i, name] of names.entries()) {
      const artistId = await upsertArtist(db, name, track.artistPages?.[name]);
      await db.query(
        "insert into track_artists (track_id, artist_id, role, position) values ($1, $2, $3, $4) on conflict do nothing",
        [trackId, artistId, role, i],
      );
    }
  }
  return trackId;
}

// ---------- loading ----------

interface SetRow {
  id: number;
  source_id: string;
  url: string;
  title: string;
  performed_on: string | null;
  soundcloud_url: string | null;
  parser_version: number | null;
}

/** Every set, rebuilt in the shape the analysis functions use. */
async function loadSets(db: Db): Promise<Tracklist[]> {
  const sets = (await db.query<SetRow>("select id, source_id, url, title, performed_on, soundcloud_url, parser_version from sets")).rows;
  const djs = (
    await db.query<{ set_id: number; name: string; tl_page: string | null; country: string | null; image_url: string | null; links: { label: string; url: string }[] }>(
      `select d.set_id, a.name, a.tl_page, a.country, a.image_url, a.links
         from set_djs d join artists a on a.id = d.artist_id order by d.set_id, d.position`,
    )
  ).rows;
  const lines = (
    await db.query<{ set_id: number; track_id: number; raw_artist: string; raw_title: string; tl_track_id: string | null; genre: string | null; label: string | null }>(
      `select st.set_id, st.track_id, st.raw_artist, st.raw_title, t.tl_track_id, coalesce(st.genre, t.genre) as genre, t.label
         from set_tracks st join tracks t on t.id = st.track_id order by st.set_id, st.position`,
    )
  ).rows;
  const pages = new Map<number, Record<string, string>>();
  for (const row of (
    await db.query<{ track_id: number; name: string; tl_page: string }>(
      `select ta.track_id, a.name, a.tl_page from track_artists ta join artists a on a.id = ta.artist_id where a.tl_page is not null`,
    )
  ).rows) {
    const forTrack = pages.get(row.track_id) ?? {};
    forTrack[row.name] = row.tl_page;
    pages.set(row.track_id, forTrack);
  }

  const byId = new Map<number, Tracklist>();
  for (const row of sets) {
    const set: Tracklist = { id: row.source_id, url: row.url, title: row.title, djs: [], djPages: {}, date: row.performed_on ?? "", tracks: [] };
    if (row.soundcloud_url) set.soundcloud = row.soundcloud_url;
    if (row.parser_version !== null) set.parserVersion = row.parser_version;
    byId.set(row.id, set);
  }
  for (const dj of djs) {
    const set = byId.get(dj.set_id)!;
    set.djs.push(dj.name);
    if (dj.tl_page) set.djPages![dj.name] = dj.tl_page;
    if (dj.country || dj.image_url || dj.links.length) {
      const profile: DjProfile = { name: dj.name, links: dj.links.map((l) => ({ label: l.label, url: l.url })) };
      if (dj.tl_page) profile.page = dj.tl_page;
      if (dj.country) profile.country = dj.country;
      if (dj.image_url) profile.image = dj.image_url;
      (set.djProfiles ??= []).push(profile);
    }
  }
  for (const line of lines) {
    const track: Track = { artist: line.raw_artist, title: line.raw_title };
    if (line.tl_track_id) track.trackId = line.tl_track_id;
    if (line.genre) track.genre = line.genre;
    if (line.label) track.label = line.label;
    const artistPages = pages.get(line.track_id);
    if (artistPages) track.artistPages = artistPages;
    byId.get(line.set_id)!.tracks.push(track);
  }
  return [...byId.values()];
}
