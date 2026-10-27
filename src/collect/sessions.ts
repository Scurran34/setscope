// Collection sessions: "collect 25 new sets from Fisher", with checkpoints, Auto-Collect,
// Stop and Resume. The sets themselves are ordinary queue jobs (jobs.ts) that point at their
// session; the worker only takes a session's jobs while the session is running.
//
// How a session moves (every change is saved, so a restart picks up where it was):
//
//   running ──every N saved sets──> checkpoint ──after ~10 s──> running   (Auto-Collect on)
//                                              └──────────────> paused    (Auto-Collect off: press Continue)
//   running ──Auto-Collect switched off──> paused ──switched on again──> running
//   running ──the site refuses or asks for verification──> access_required ──Try again works──> running
//   any open state ──Stop──> stopping (a set mid-fetch is cancelled) ──> stopped
//   running ──target reached, or no sets left──> completed
//
// Stopped sessions only start again when someone presses Resume: never after a restart,
// a refresh, or Auto-Collect being switched back on. A set counts as collected only after
// it's saved, and a set that was already indexed never counts toward the target.

import type pg from "pg";
import { transaction } from "../db/pool.ts";

export type SessionState = "queued" | "running" | "checkpoint" | "paused" | "access_required" | "stopping" | "stopped" | "completed" | "failed";
export type PauseReason = "checkpoint" | "auto_off" | "restart";
/** What happened to one of a session's sets. */
export type JobOutcome = "saved" | "cached" | "empty" | "failed" | "cancelled";

export const OPEN_STATES: SessionState[] = ["queued", "running", "checkpoint", "paused", "access_required", "stopping"];
export const TARGETS = [10, 25, 50, 100];
export const DEFAULT_TARGET = 25;
export const CHECKPOINT_EVERY = [5, 10] as const;
export const CHECKPOINT_MS = 10_000;

export interface CollectPrefs {
  autoCollect: boolean;
  checkpointEvery: 5 | 10;
  defaultTarget: number;
}

export interface SessionView {
  id: number;
  label: string;
  sourcePage: string | null;
  state: SessionState;
  pauseReason: PauseReason | null;
  target: number;
  collected: number;
  cached: number;
  pagesScanned: number;
  /** Sets of this session still to fetch. */
  remaining: number;
  checkpointEvery: number;
  /** Set during a checkpoint: when it ends. */
  checkpointEndsAt: string | null;
  /** After how many collected sets the next checkpoint comes. */
  nextCheckpointAt: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  requestedBy: number | null;
  updatedAt: string;
}

interface Row {
  id: number;
  label: string;
  source_page: string | null;
  state: SessionState;
  pause_reason: PauseReason | null;
  target: number;
  collected: number;
  cached: number;
  pages_scanned: number;
  checkpoint_every: number;
  checkpoint_until: Date | null;
  stop_requested: boolean;
  last_success_at: Date | null;
  last_error: string | null;
  requested_by: number | null;
  updated_at: Date;
  remaining: number;
}

const LIVE_JOB = "status in ('queued', 'running', 'blocked', 'held')";

export class CollectionSessions {
  private readonly pool: pg.Pool;
  private readonly checkpointMs: number;

  constructor(pool: pg.Pool, options: { checkpointMs?: number } = {}) {
    this.pool = pool;
    this.checkpointMs = options.checkpointMs ?? CHECKPOINT_MS;
  }

  // ---------- preferences ----------

  async prefs(userId: number | null | undefined): Promise<CollectPrefs> {
    if (!userId) return { autoCollect: false, checkpointEvery: 5, defaultTarget: DEFAULT_TARGET };
    const r = await this.pool.query<{ auto_collect: boolean; checkpoint_every: 5 | 10; default_target: number }>(
      "select auto_collect, checkpoint_every, default_target from collect_prefs where user_id = $1",
      [userId],
    );
    const row = r.rows[0];
    return row ? { autoCollect: row.auto_collect, checkpointEvery: row.checkpoint_every, defaultTarget: row.default_target } : { autoCollect: false, checkpointEvery: 5, defaultTarget: DEFAULT_TARGET };
  }

  /**
   * Change someone's preferences. Auto-Collect off pauses their running sessions after the
   * set in hand; back on, it continues the ones that were waiting on it or on a checkpoint
   * (never stopped ones).
   */
  async setPrefs(userId: number, changes: Partial<CollectPrefs>): Promise<CollectPrefs> {
    const next = { ...(await this.prefs(userId)), ...changes };
    if (!CHECKPOINT_EVERY.includes(next.checkpointEvery)) throw new Error("Checkpoints are every 5 or 10 sets.");
    if (!Number.isInteger(next.defaultTarget) || next.defaultTarget < 1 || next.defaultTarget > 1000) throw new Error("A target is 1 to 1000 sets.");
    await this.pool.query(
      `insert into collect_prefs (user_id, auto_collect, checkpoint_every, default_target, updated_at) values ($1, $2, $3, $4, now())
       on conflict (user_id) do update set auto_collect = $2, checkpoint_every = $3, default_target = $4, updated_at = now()`,
      [userId, next.autoCollect, next.checkpointEvery, next.defaultTarget],
    );
    await this.pool.query("update collection_sessions set checkpoint_every = $2, updated_at = now() where requested_by = $1 and state = any($3)", [userId, next.checkpointEvery, OPEN_STATES]);
    if (changes.autoCollect === false) {
      await this.pool.query(
        "update collection_sessions set state = 'paused', pause_reason = 'auto_off', updated_at = now() where requested_by = $1 and state = 'running'",
        [userId],
      );
    } else if (changes.autoCollect === true) {
      await this.pool.query(
        `update collection_sessions set state = 'running', pause_reason = null, checkpoint_until = null, updated_at = now()
          where requested_by = $1 and state in ('paused', 'checkpoint') and pause_reason is distinct from 'restart' and not stop_requested`,
        [userId],
      );
    }
    return next;
  }

  // ---------- starting and ending ----------

  /**
   * Start collecting (or collect more) from a page. Gathering the same page while its
   * session is still open asks that session for `target` more, rather than starting another.
   */
  async open(options: { userId?: number | null; label: string; artistId?: number | null; sourcePage?: string | null; target: number; pagesScanned?: number }): Promise<number> {
    const prefs = await this.prefs(options.userId);
    return transaction(this.pool, async (db) => {
      if (options.sourcePage) {
        const open = await db.query<{ id: number }>(
          `update collection_sessions set target = collected + $2, state = 'running', pause_reason = null, stop_requested = false,
                  checkpoint_until = null, pages_scanned = greatest(pages_scanned, $3), last_error = null, updated_at = now()
            where source_page = $1 and state = any($4) returning id`,
          [options.sourcePage, options.target, options.pagesScanned ?? 0, OPEN_STATES],
        );
        if (open.rows[0]) return open.rows[0].id;
      }
      const r = await db.query<{ id: number }>(
        `insert into collection_sessions (requested_by, artist_id, label, source_page, target, pages_scanned, checkpoint_every)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [options.userId ?? null, options.artistId ?? null, options.label, options.sourcePage ?? null, options.target, options.pagesScanned ?? 0, prefs.checkpointEvery],
      );
      return r.rows[0]!.id;
    });
  }

  /** Sets that were already indexed when the session's links came in. */
  async addCached(id: number, cached: number): Promise<void> {
    if (cached) await this.pool.query("update collection_sessions set cached = cached + $2, updated_at = now() where id = $1", [id, cached]);
  }

  /** A session that got no work at all (every set already indexed) is complete right away. */
  async settleIfEmpty(id: number): Promise<void> {
    await this.pool.query(
      `update collection_sessions s set state = 'completed', updated_at = now()
        where id = $1 and state = 'running' and not exists (select 1 from collection_jobs j where j.session_id = s.id and j.${LIVE_JOB})`,
      [id],
    );
  }

  /**
   * Stop: no more of its sets will start, the one in flight (if any) is cancelled by the
   * queue, and everything saved stays. `busy` says whether one of its sets is mid-fetch.
   */
  async stop(id: number, busy: boolean): Promise<SessionView | undefined> {
    await this.pool.query(
      `update collection_sessions set stop_requested = true, state = $2, checkpoint_until = null, updated_at = now()
        where id = $1 and state = any($3)`,
      [id, busy ? "stopping" : "stopped", OPEN_STATES],
    );
    return this.get(id);
  }

  /** Continue: after a checkpoint, a pause, or a Stop (only ever by someone pressing it). */
  async resume(id: number): Promise<SessionView | undefined> {
    await this.pool.query(
      `update collection_sessions s set state = 'running', pause_reason = null, stop_requested = false, checkpoint_until = null, last_error = null, updated_at = now()
        where id = $1 and state in ('paused', 'checkpoint', 'stopped', 'access_required')
          and exists (select 1 from collection_jobs j where j.session_id = s.id and j.${LIVE_JOB})`,
      [id],
    );
    return this.get(id);
  }

  // ---------- what the worker reports ----------

  /** After one of a session's sets: count it, then decide whether to go on. */
  async afterJob(id: number, outcome: JobOutcome, error?: string): Promise<void> {
    await transaction(this.pool, async (db) => {
      const r = await db.query<Row>(`select * from collection_sessions where id = $1 for update`, [id]);
      const s = r.rows[0];
      if (!s) return;
      let collected = s.collected;
      let cached = s.cached;
      if (outcome === "saved") collected++;
      if (outcome === "cached") cached++;
      const remaining = (await db.query<{ n: number }>(`select count(*)::int n from collection_jobs where session_id = $1 and ${LIVE_JOB}`, [id])).rows[0]!.n;
      let state: SessionState = s.state;
      let pauseReason = s.pause_reason;
      let checkpointUntil: Date | null = s.checkpoint_until;
      if (outcome === "cancelled" || s.stop_requested) state = "stopped";
      else if (collected >= s.target) state = "completed";
      else if (remaining === 0 && (s.state === "running" || s.state === "checkpoint")) state = "completed";
      else if (outcome === "saved" && s.state === "running" && collected % s.checkpoint_every === 0) {
        state = "checkpoint";
        pauseReason = "checkpoint";
        checkpointUntil = new Date(Date.now() + this.checkpointMs);
      }
      await db.query(
        `update collection_sessions set collected = $2, cached = $3, state = $4, pause_reason = $5, checkpoint_until = $6,
                last_success_at = case when $7 then now() else last_success_at end,
                last_error = coalesce($8, last_error), updated_at = now()
          where id = $1`,
        [id, collected, cached, state, state === "running" || state === "completed" ? null : pauseReason, state === "checkpoint" ? checkpointUntil : null, outcome === "saved", error ?? null],
      );
      // Reached the target: anything left in line for it (retries) isn't needed any more.
      if (state === "completed" && remaining > 0) {
        await db.query(`delete from collection_jobs where session_id = $1 and status in ('queued', 'blocked', 'held')`, [id]);
      }
    });
  }

  /** The site refused or asked for verification: every collecting session waits. */
  async accessRequired(message: string): Promise<void> {
    await this.pool.query(
      `update collection_sessions set state = 'access_required', last_error = $1, checkpoint_until = null, updated_at = now()
        where state in ('running', 'checkpoint')`,
      [message],
    );
  }

  /** Access works again (Try again succeeded): sessions that were waiting on it go on. */
  async accessRestored(): Promise<void> {
    await this.pool.query(
      "update collection_sessions set state = 'running', pause_reason = null, last_error = null, updated_at = now() where state = 'access_required' and not stop_requested",
    );
  }

  /**
   * Checkpoints whose countdown is over: on to the next sets if the person has Auto-Collect
   * on, otherwise wait for them. Returns when the next countdown ends, if one is running.
   */
  async advanceCheckpoints(): Promise<Date | undefined> {
    await this.pool.query(
      `update collection_sessions s set
              state = case when coalesce(p.auto_collect, false) then 'running' else 'paused' end,
              pause_reason = case when coalesce(p.auto_collect, false) then null else 'checkpoint' end,
              checkpoint_until = null, updated_at = now()
         from collection_sessions s2 left join collect_prefs p on p.user_id = s2.requested_by
        where s.id = s2.id and s.state = 'checkpoint' and s.checkpoint_until <= now() and not s.stop_requested`,
    );
    // A running session with nothing left to fetch is done.
    await this.pool.query(
      `update collection_sessions s set state = 'completed', updated_at = now()
        where s.state = 'running' and not exists (select 1 from collection_jobs j where j.session_id = s.id and j.${LIVE_JOB})`,
    );
    const r = await this.pool.query<{ next: Date | null }>("select min(checkpoint_until) next from collection_sessions where state = 'checkpoint'");
    return r.rows[0]?.next ?? undefined;
  }

  /** After a restart: a Stop that was waiting on a fetch is done. Nothing stopped restarts. */
  async recover(): Promise<void> {
    await this.pool.query("update collection_sessions set state = 'stopped', updated_at = now() where state = 'stopping'");
    await this.pool.query("update collection_sessions set state = 'running', pause_reason = null, checkpoint_until = null, updated_at = now() where state = 'checkpoint' and not stop_requested");
  }

  // ---------- reading ----------

  async get(id: number): Promise<SessionView | undefined> {
    const r = await this.pool.query<Row>(
      `select s.*, (select count(*)::int from collection_jobs j where j.session_id = s.id and j.${LIVE_JOB}) remaining from collection_sessions s where s.id = $1`,
      [id],
    );
    return r.rows[0] && view(r.rows[0]);
  }

  /** The sessions someone sees: theirs (the owner also sees ones nobody signed in started). */
  async forUser(userId: number | null, owner: boolean, limit = 6): Promise<SessionView[]> {
    const r = await this.pool.query<Row>(
      `select s.*, (select count(*)::int from collection_jobs j where j.session_id = s.id and j.${LIVE_JOB}) remaining
         from collection_sessions s
        where (s.requested_by = $1 or ($2 and s.requested_by is null))
        order by (s.state = any($3)) desc, s.updated_at desc limit $4`,
      [userId, owner, OPEN_STATES, limit],
    );
    return r.rows.map(view);
  }
}

function view(row: Row): SessionView {
  const next = row.state === "completed" || row.state === "stopped" ? null : (Math.floor(row.collected / row.checkpoint_every) + 1) * row.checkpoint_every;
  return {
    id: row.id,
    label: row.label,
    sourcePage: row.source_page,
    state: row.state,
    pauseReason: row.pause_reason,
    target: row.target,
    collected: row.collected,
    cached: row.cached,
    pagesScanned: row.pages_scanned,
    remaining: row.remaining,
    checkpointEvery: row.checkpoint_every,
    checkpointEndsAt: row.checkpoint_until?.toISOString() ?? null,
    nextCheckpointAt: next !== null && next < row.target ? next : null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastError: row.last_error,
    requestedBy: row.requested_by,
    updatedAt: row.updated_at.toISOString(),
  };
}
