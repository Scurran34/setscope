// The Unreleased Vault: IDs someone saved, each as the exact line it was heard on (a
// set and a position). Lines are never merged: two "ID - ID" lines are two IDs.
//
// What an ID is *now* is read from that line every time, so when setscope re-reads a
// set and 1001Tracklists has identified the track, the Vault shows it without anyone
// doing anything; track_metadata_history says when it changed.

import type pg from "pg";
import { UserDataError } from "./user-data.ts";

export interface VaultItem {
  setId: string;
  setTitle: string;
  setUrl: string;
  date: string | null;
  position: number;
  /** The line when it was saved. */
  savedText: string;
  /** The line now. */
  text: string;
  /** "identified": the line now names a known track. */
  status: "unidentified" | "identified";
  /** The song page name, once identified. */
  song: string | null;
  /** When the line changed to what it is now (from re-reading the set), if it did. */
  changedAt: string | null;
  /** When the set was last re-read from 1001Tracklists. */
  lastChecked: string | null;
  soundcloud: string | null;
  savedAt: string;
}

export class Vault {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Save (or remove) the ID heard at `position` in a set (by its 1001Tracklists id). */
  async setSaved(userId: number, setSourceId: string, position: number, on: boolean): Promise<void> {
    const line = await this.pool.query<{ set_id: number; raw_artist: string; raw_title: string; is_id: boolean }>(
      `select s.id set_id, st.raw_artist, st.raw_title, t.identity_key is null is_id
         from sets s join set_tracks st on st.set_id = s.id join tracks t on t.id = st.track_id
        where s.source_id = $1 and st.position = $2`,
      [setSourceId, position],
    );
    const row = line.rows[0];
    if (!row) throw new UserDataError("That line isn't in an indexed set.");
    if (!on) {
      await this.pool.query("delete from vault_items where user_id = $1 and set_id = $2 and position = $3", [userId, row.set_id, position]);
      return;
    }
    if (!row.is_id) throw new UserDataError("That track is already identified: like it or add it to a playlist instead.");
    await this.pool.query(
      `insert into vault_items (user_id, set_id, position, saved_text) values ($1, $2, $3, $4) on conflict do nothing`,
      [userId, row.set_id, position, `${row.raw_artist} - ${row.raw_title}`],
    );
  }

  /** Your saved IDs: newly identified ones first, then the rest by when the set was played. */
  async list(userId: number): Promise<VaultItem[]> {
    const r = await this.pool.query<{
      source_id: string; title: string; url: string; performed_on: string | null; position: number; saved_text: string;
      raw_artist: string | null; raw_title: string | null; identified: boolean; artist_text: string | null; track_title: string | null;
      changed_at: Date | null; last_refreshed_at: Date | null; soundcloud: string | null; created_at: Date;
    }>(
      `select s.source_id, s.title, s.url, s.performed_on::text, v.position, v.saved_text, st.raw_artist, st.raw_title,
              coalesce(t.identity_key is not null, false) identified, t.artist_text, t.title track_title,
              (select max(h.changed_at) from track_metadata_history h where h.set_id = s.id and h.position = v.position) changed_at,
              s.last_refreshed_at,
              (select l.url from external_track_links l where l.track_id = t.id order by (l.added_by is null and l.provenance = 'search_match'), l.confidence desc limit 1) soundcloud,
              v.created_at
         from vault_items v join sets s on s.id = v.set_id
         left join set_tracks st on st.set_id = v.set_id and st.position = v.position
         left join tracks t on t.id = st.track_id
        where v.user_id = $1`,
      [userId],
    );
    const items: VaultItem[] = r.rows.map((x) => ({
      setId: x.source_id,
      setTitle: x.title,
      setUrl: x.url,
      date: x.performed_on,
      position: x.position,
      savedText: x.saved_text,
      text: x.raw_artist !== null ? `${x.raw_artist} - ${x.raw_title}` : x.saved_text,
      status: x.identified ? "identified" : "unidentified",
      song: x.identified ? `${x.artist_text} - ${x.track_title}` : null,
      changedAt: x.changed_at?.toISOString() ?? null,
      lastChecked: x.last_refreshed_at?.toISOString() ?? null,
      soundcloud: x.identified ? x.soundcloud : null,
      savedAt: x.created_at.toISOString(),
    }));
    return items.sort(
      (a, b) =>
        Number(b.status === "identified") - Number(a.status === "identified") ||
        (b.changedAt ?? "").localeCompare(a.changedAt ?? "") ||
        (b.date ?? "").localeCompare(a.date ?? "") ||
        a.position - b.position,
    );
  }
}
