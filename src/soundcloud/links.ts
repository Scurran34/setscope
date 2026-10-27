// What people have confirmed or saved from SoundCloud, in the database:
//
//   - Song links: "this tracklist song is this SoundCloud upload", shared by everyone
//     (external_track_links). Only a reference is kept: the link, SoundCloud's id for it,
//     how sure the match was, and who confirmed it. Pressing play on a song with no link
//     saves its best match automatically (no one confirmed it, so added_by is empty);
//     anyone signed in can remove a wrong one.
//   - Saved tracks: a SoundCloud upload someone put in one of their categories
//     (collection_links): a bookmark with the title and uploader as shown, personal.

import type pg from "pg";
import { normalizeName } from "../normalize.ts";
import { findTrackId, UserDataError } from "../personal/user-data.ts";

export interface SongLink {
  url: string;
  externalId: string | null;
  confidence: number;
  /** "user": pasted by someone; "search_match": picked from search results (or matched automatically); "source_page": from 1001Tracklists. */
  provenance: "source_page" | "user" | "search_match";
  /** Matched automatically when someone pressed play; no one has confirmed it. */
  auto: boolean;
  addedBy: string | null;
  addedAt: string;
  /** Can the person asking remove it (they added it, or they own the site)? */
  removable?: boolean;
}

export interface SavedLink {
  url: string;
  title: string;
  artist: string;
  addedAt: string;
}

/** Only real SoundCloud track pages: https://soundcloud.com/<user>/<track>. */
export function isTrackLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "soundcloud.com" || u.hostname === "www.soundcloud.com") && /^\/[^/]+\/[^/]+\/?$/.test(u.pathname) && !u.pathname.startsWith("/you/");
  } catch {
    return false;
  }
}

export class LinkStore {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async forSong(song: string, viewer?: { id: number; owner: boolean }): Promise<SongLink[]> {
    let trackId: number;
    try {
      trackId = await findTrackId(this.pool, song);
    } catch (error) {
      if (error instanceof UserDataError) return [];
      throw error;
    }
    const r = await this.pool.query<{ url: string; external_id: string | null; confidence: number; provenance: SongLink["provenance"]; added_by: number | null; display_name: string | null; created_at: Date }>(
      `select l.url, l.external_id, l.confidence, l.provenance, l.added_by, u.display_name, l.created_at
         from external_track_links l left join users u on u.id = l.added_by
        where l.track_id = $1 and l.provider = 'soundcloud'
        order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc, l.created_at`,
      [trackId],
    );
    return r.rows.map((row) => {
      const link: SongLink = {
        url: row.url,
        externalId: row.external_id,
        confidence: row.confidence,
        provenance: row.provenance,
        auto: row.provenance === "search_match" && row.added_by === null,
        addedBy: row.display_name,
        addedAt: row.created_at.toISOString(),
      };
      if (viewer) link.removable = viewer.owner || row.added_by === viewer.id || link.auto;
      return link;
    });
  }

  async addSongLink(userId: number, song: string, link: { url: string; externalId: string; confidence: number; provenance: "user" | "search_match" }): Promise<void> {
    if (!isTrackLink(link.url)) throw new UserDataError("That isn't a SoundCloud track link.");
    const trackId = await findTrackId(this.pool, song);
    await this.pool.query(
      `insert into external_track_links (track_id, provider, url, external_id, confidence, provenance, added_by)
       values ($1, 'soundcloud', $2, $3, $4, $5, $6)
       on conflict (track_id, provider, url) do nothing`,
      [trackId, link.url, link.externalId, link.confidence, link.provenance, userId],
    );
  }

  /** The link to play for a track: a confirmed one first, then an automatic match. */
  async playable(trackId: number): Promise<{ url: string; auto: boolean; confidence: number; externalId: string | null } | undefined> {
    const r = await this.pool.query<{ url: string; auto: boolean; confidence: number; externalId: string | null }>(
      `select url, (added_by is null and provenance = 'search_match') auto, confidence, external_id "externalId" from external_track_links
        where track_id = $1 and provider = 'soundcloud'
        order by (added_by is null and provenance = 'search_match'), confidence desc, created_at limit 1`,
      [trackId],
    );
    return r.rows[0];
  }

  /** Save the best search match for a song nobody has linked yet (no one confirmed it). */
  async saveAutoMatch(trackId: number, link: { url: string; externalId: string; confidence: number }): Promise<void> {
    if (!isTrackLink(link.url)) return;
    await this.pool.query(
      `insert into external_track_links (track_id, provider, url, external_id, confidence, provenance, added_by)
       values ($1, 'soundcloud', $2, $3, $4, 'search_match', null)
       on conflict (track_id, provider, url) do nothing`,
      [trackId, link.url, link.externalId, link.confidence],
    );
  }

  /** Remove a link: whoever added it, the owner, or anyone signed in for an automatic match. */
  async removeSongLink(user: { id: number; owner: boolean }, song: string, url: string): Promise<boolean> {
    const trackId = await findTrackId(this.pool, song);
    const r = await this.pool.query(
      `delete from external_track_links where track_id = $1 and provider = 'soundcloud' and url = $2
         and ($3 or added_by = $4 or (added_by is null and provenance = 'search_match'))`,
      [trackId, url, user.owner, user.id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Save (or unsave) a SoundCloud upload in one of your categories. */
  async setSaved(userId: number, category: string, link: { url: string; title: string; artist: string }, on: boolean): Promise<void> {
    const name = category.trim();
    if (!name || name.length > 40) throw new UserDataError("Playlist names are 1 to 40 characters.");
    if (!isTrackLink(link.url)) throw new UserDataError("That isn't a SoundCloud track link.");
    const key = normalizeName(name);
    if (on) {
      const c = await this.pool.query<{ id: number }>(
        `insert into collections (user_id, name, name_key) values ($1, $2, $3)
         on conflict (user_id, name_key) do update set name = collections.name returning id`,
        [userId, name, key],
      );
      await this.pool.query(
        `insert into collection_links (collection_id, provider, url, title, artist_text) values ($1, 'soundcloud', $2, $3, $4)
         on conflict (collection_id, url) do update set title = excluded.title, artist_text = excluded.artist_text`,
        [c.rows[0]!.id, link.url, link.title.slice(0, 300), link.artist.slice(0, 200)],
      );
    } else {
      await this.pool.query(
        `delete from collection_links where url = $3
           and collection_id = (select id from collections where user_id = $1 and name_key = $2)`,
        [userId, key, link.url],
      );
    }
  }

  /** Your saved uploads, by category name key. */
  async saved(userId: number): Promise<Record<string, { name: string; links: SavedLink[] }>> {
    const r = await this.pool.query<{ name: string; name_key: string; url: string; title: string; artist_text: string; added_at: Date }>(
      `select c.name, c.name_key, cl.url, cl.title, cl.artist_text, cl.added_at
         from collections c join collection_links cl on cl.collection_id = c.id
        where c.user_id = $1 order by cl.added_at`,
      [userId],
    );
    const out: Record<string, { name: string; links: SavedLink[] }> = {};
    for (const row of r.rows) {
      (out[row.name_key] ??= { name: row.name, links: [] }).links.push({ url: row.url, title: row.title, artist: row.artist_text, addedAt: row.added_at.toISOString() });
    }
    return out;
  }
}
