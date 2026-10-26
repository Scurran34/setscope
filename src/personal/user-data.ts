// One person's likes and categories, in the database. Likes and categories point at
// shared tracks; they're never copied per user, and never shown to anyone else.
//
// get() returns the same shape the old data/user.json had (keys from songKey), so the
// suggestion functions in analysis/personal.ts work unchanged.

import { existsSync, readFileSync } from "node:fs";
import type pg from "pg";
import { baseTitle, normalizeName, songKey, trackFromName } from "../normalize.ts";
import type { UserData } from "../user.ts";

/** Thrown for things the person can fix (a song we don't know, a bad category name). */
export class UserDataError extends Error {}

/** The shared track a song name refers to ("Artist - Title"), if we have it. */
export async function findTrackId(pool: pg.Pool, song: string): Promise<number> {
  if (!song.includes(" - ")) throw new UserDataError(`Song must look like "Artist - Title" (got "${song}")`);
  const track = trackFromName(song);
  const key = `${normalizeName(track.artist)} - ${baseTitle(track.title)}`;
  const r = await pool.query<{ id: number }>("select id from tracks where identity_key = $1", [key]);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new UserDataError(`"${song}" isn't in the catalog yet.`);
  return id;
}

export class PgUserData {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  private trackId(song: string): Promise<number> {
    return findTrackId(this.pool, song);
  }

  async get(userId: number): Promise<UserData> {
    const likes = await this.pool.query<{ artist_text: string; title: string }>(
      `select t.artist_text, t.title from user_likes l join tracks t on t.id = l.track_id where l.user_id = $1 order by l.created_at`,
      [userId],
    );
    const members = await this.pool.query<{ name: string; name_key: string; artist_text: string | null; title: string | null }>(
      `select c.name, c.name_key, t.artist_text, t.title
         from collections c left join collection_tracks ct on ct.collection_id = c.id left join tracks t on t.id = ct.track_id
        where c.user_id = $1 order by c.created_at, ct.added_at`,
      [userId],
    );
    const data: UserData = { likes: {}, categories: {} };
    for (const t of likes.rows) data.likes[songKey({ artist: t.artist_text, title: t.title })] = `${t.artist_text} - ${t.title}`;
    for (const m of members.rows) {
      const category = (data.categories[m.name_key] ??= { name: m.name, songs: {} });
      if (m.artist_text !== null && m.title !== null) {
        category.songs[songKey({ artist: m.artist_text, title: m.title })] = `${m.artist_text} - ${m.title}`;
      }
    }
    return data;
  }

  async setLiked(userId: number, song: string, liked: boolean): Promise<void> {
    const trackId = await this.trackId(song);
    if (liked) await this.pool.query("insert into user_likes (user_id, track_id) values ($1, $2) on conflict do nothing", [userId, trackId]);
    else await this.pool.query("delete from user_likes where user_id = $1 and track_id = $2", [userId, trackId]);
  }

  /** Add or remove a song from a category; a category with no songs left disappears. */
  async setLabel(userId: number, song: string, category: string, on: boolean): Promise<void> {
    const name = category.trim();
    if (!name || name.length > 40) throw new UserDataError("Category names are 1 to 40 characters.");
    const trackId = await this.trackId(song);
    const key = normalizeName(name);
    if (on) {
      const c = await this.pool.query<{ id: number }>(
        `insert into collections (user_id, name, name_key) values ($1, $2, $3)
         on conflict (user_id, name_key) do update set name = collections.name returning id`,
        [userId, name, key],
      );
      await this.pool.query("insert into collection_tracks (collection_id, track_id) values ($1, $2) on conflict do nothing", [c.rows[0]!.id, trackId]);
    } else {
      await this.pool.query(
        `delete from collection_tracks where track_id = $3
           and collection_id = (select id from collections where user_id = $1 and name_key = $2)`,
        [userId, key, trackId],
      );
      await this.pool.query(
        `delete from collections c where c.user_id = $1 and c.name_key = $2
           and not exists (select 1 from collection_tracks ct where ct.collection_id = c.id)
           and not exists (select 1 from collection_links cl where cl.collection_id = c.id)`,
        [userId, key],
      );
    }
  }

  /**
   * Bring likes and categories from the old single-user file (data/user.json) into an
   * account. Songs not in the catalog are skipped and counted.
   */
  async importLegacy(userId: number, file: string): Promise<{ imported: number; skipped: number }> {
    if (!existsSync(file)) return { imported: 0, skipped: 0 };
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<UserData>;
    let imported = 0;
    let skipped = 0;
    const attempt = async (work: () => Promise<void>) => {
      try {
        await work();
        imported++;
      } catch (error) {
        if (!(error instanceof UserDataError)) throw error;
        skipped++;
      }
    };
    for (const song of Object.values(saved.likes ?? {})) await attempt(() => this.setLiked(userId, song, true));
    for (const category of Object.values(saved.categories ?? {})) {
      for (const song of Object.values(category.songs)) await attempt(() => this.setLabel(userId, song, category.name, true));
    }
    return { imported, skipped };
  }
}
