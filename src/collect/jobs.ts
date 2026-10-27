// The collection queue, in the database (collection_jobs), shared by everyone and
// kept across restarts.
//
//   - One live job per set: asking for the same set twice (two people, two pages) doesn't
//     fetch it twice. Sets already in the catalog are never fetched again.
//   - Newest sets first. Sets older than the window are "held" until someone includes them.
//   - A worker claims one job at a time with `for update skip locked`, so more than one
//     worker (or server) can run without fetching the same set twice.
//   - Brief failures (a dropped connection, a 5xx) retry after 30s, 2m and 8m, then give up
//     and keep the error. Anything that looks like the site saying "slow down" (401/403/429/
//     a challenge page) pauses all collecting and is never treated as "no more sets".
//   - After a restart, a job that was mid-fetch goes back in line, and the queue comes back
//     paused so nothing is requested until someone says so.
//   - refresh_set jobs re-read a set already in the catalog, record what changed in
//     source_refresh_history, and keep the stored version if the site can't be reached.

import type pg from "pg";
import type { PgCatalog } from "../catalog/pg-catalog.ts";
import type { Tracklist } from "../model.ts";
import { BlockedError, CancelledError, EmptyTracklistError, isFetchAllowed, LayoutError, MIN_DELAY_MS, type BlockKind, type HtmlSource } from "../source/fetcher.ts";
import { CollectionSessions, type JobOutcome, type SessionView } from "./sessions.ts";
import { canonicalUrl, dateFromUrl, parseTracklist, tracklistId } from "../source/parse.ts";

export type JobKind = "fetch_set" | "refresh_set";

export type QueueState = "idle" | "running" | "blocked";

/** Why collecting is paused, so the page can explain it in plain words. */
export type PauseReason = "site" | "failure" | "restart";

/** What the page shows about collecting. */
export interface QueueStatus {
  state: QueueState;
  /** Sets fetched in this batch (since the queue was last empty). */
  done: number;
  /** done + still waiting. */
  total: number;
  /** Jobs in this batch that gave up after retrying. */
  failed: number;
  pendingFailures: number;
  /** The set being fetched right now. */
  current?: string;
  /** Technical details of a pause. */
  blocked?: string;
  pauseReason?: PauseReason;
  etaSeconds: number;
  /** Sets still to fetch, next first. */
  waiting: string[];
  /** Kept for the page; always empty now that everything found is fetched. */
  found: string[];
  /** Sets older than the window, held until someone includes them. */
  older: number;
  /** When the site asked us to come back (Retry-After), while paused by it. */
  pausedUntil?: string;
  /** How the site said no, while paused by it. */
  blockKind?: BlockKind;
}

export interface EnqueueResult {
  /** New sets put in line. */
  queued: number;
  fetchingNow: number;
  alreadyCached: number;
  /** Sets older than the window, held. */
  skippedOld: number;
  /** Sets on the page older than the requested "last N" (left for another time). */
  overLimit: number;
}

/** Waits before retrying a job that failed for a passing reason: 30s, 2m, 8m. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

interface JobRow {
  id: number;
  kind: JobKind;
  target: string;
  attempts: number;
  session_id: number | null;
}

/** Jobs the worker may take: on their own, or in a session that's collecting right now. */
const CLAIMABLE = `(j.session_id is null or exists (select 1 from collection_sessions cs where cs.id = j.session_id and cs.state = 'running'))`;

export interface JobQueueOptions {
  /** Only used for the time estimate; the fetcher enforces the real delay. */
  delayMs?: number;
  /** For tests: how a retry is scheduled (default: a timer). */
  schedule?: (ms: number, run: () => void) => void;
  /** How long a checkpoint pauses a session (default 10 s). */
  checkpointMs?: number;
}

export class PgJobQueue {
  private readonly pool: pg.Pool;
  private readonly catalog: PgCatalog;
  private readonly source: HtmlSource;
  private readonly delayMs: number;
  private readonly schedule: (ms: number, run: () => void) => void;
  private running: Promise<void> | undefined;
  private current: string | undefined;
  /** The session whose set is being fetched right now, and how to cancel that fetch. */
  private currentSession: number | null = null;
  private abort: AbortController | undefined;
  readonly sessions: CollectionSessions;

  constructor(pool: pg.Pool, catalog: PgCatalog, source: HtmlSource, options: JobQueueOptions = {}) {
    this.pool = pool;
    this.catalog = catalog;
    this.source = source;
    this.delayMs = options.delayMs ?? MIN_DELAY_MS;
    this.schedule = options.schedule ?? ((ms, run) => setTimeout(run, ms).unref());
    this.sessions = new CollectionSessions(pool, options.checkpointMs === undefined ? {} : { checkpointMs: options.checkpointMs });
  }

  /**
   * After a (re)start: jobs left "running" by a crash go back in line, and if anything
   * is waiting, collecting comes back paused until someone presses Try again.
   */
  async recover(): Promise<void> {
    await this.pool.query("update collection_jobs set status = 'queued', updated_at = now() where status = 'running'");
    await this.sessions.recover();
    const waiting = await this.count("status in ('queued', 'blocked')");
    const state = await this.state();
    if (waiting > 0 && !state.paused_reason) {
      await this.pause("restart", `${waiting} sets were waiting when setscope last stopped.`);
    }
  }

  /**
   * Add set URLs: duplicates, sets already cached, and sets already queued are skipped;
   * sets older than `since` are held. Starts fetching unless collecting is paused.
   */
  async enqueue(
    urls: string[],
    since: string,
    options: { requestedBy?: number; priority?: number; start?: boolean; page?: string; limit?: number; sessionId?: number; newLimit?: number } = {},
  ): Promise<EnqueueResult> {
    // Newest first. A limit means "their last N sets": the newest N on the page, whether or
    // not some of them are already here (those are skipped, not swapped for older ones).
    const newestFirst = [...new Set(urls.filter(isFetchAllowed))].sort((a, b) => (dateFromUrl(b) ?? "").localeCompare(dateFromUrl(a) ?? ""));
    const unique = options.limit !== undefined ? newestFirst.slice(0, options.limit) : newestFirst;
    const overLimit = newestFirst.length - unique.length;
    if ((await this.count("status in ('queued', 'running', 'blocked')")) === 0) await this.startBatch();
    let queued = 0;
    let alreadyCached = 0;
    let skippedOld = 0;
    let newOnes = 0;
    for (const url of unique) {
      const id = tracklistId(url);
      if (!id) continue;
      if (await this.catalog.has(id)) {
        alreadyCached++;
        continue;
      }
      // A session asks for N *new* sets: indexed ones don't count, older ones fill in.
      if (options.newLimit !== undefined && newOnes >= options.newLimit) continue;
      newOnes++;
      const date = dateFromUrl(url);
      const held = date !== undefined && date < since;
      const r = await this.pool.query(
        `insert into collection_jobs (kind, target, status, priority, performed_on, requested_by, discovery_page, session_id)
         values ('fetch_set', $1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
        [url, held ? "held" : "queued", options.priority ?? 0, date ?? null, options.requestedBy ?? null, options.page ?? null, options.sessionId ?? null],
      );
      if (r.rowCount === 0) {
        // Already in line (someone else asked for it): this session counts it too, once.
        if (options.sessionId) {
          const joined = await this.pool.query(
            `update collection_jobs set session_id = $2 where kind = 'fetch_set' and target = $1 and session_id is null and status in ('queued', 'blocked', 'held')`,
            [url, options.sessionId],
          );
          if (joined.rowCount) queued++;
        }
        continue;
      }
      if (held) skippedOld++;
      else queued++;
    }
    if (options.start !== false) this.kick();
    return { queued, fetchingNow: queued, alreadyCached, skippedOld, overLimit };
  }

  /** Stop a session: nothing more starts, a fetch in flight for it is cancelled, saved sets stay. */
  async stopSession(id: number): Promise<SessionView | undefined> {
    const busy = this.currentSession === id;
    const view = await this.sessions.stop(id, busy);
    if (busy) this.abort?.abort();
    return view;
  }

  /** Continue a session (after a checkpoint, a pause, or a Stop). Someone has to press it. */
  async resumeSession(id: number): Promise<SessionView | undefined> {
    const view = await this.sessions.resume(id);
    this.kick();
    return view;
  }

  /** "Stop gathering": cancel the not-yet-fetched sets that came from these pages. Returns how many. */
  async stopGathering(pages: string[], requestedBy?: number): Promise<number> {
    if (!pages.length) return 0;
    const r = await this.pool.query(
      `delete from collection_jobs where kind = 'fetch_set' and status in ('queued', 'held', 'blocked') and discovery_page = any($1)
          and ($2::bigint is null or requested_by = $2)`,
      [pages, requestedBy ?? null],
    );
    return r.rowCount ?? 0;
  }

  /** Sets from these pages still waiting to be fetched. */
  async waitingFrom(pages: string[]): Promise<number> {
    if (!pages.length) return 0;
    const r = await this.pool.query<{ n: number }>(
      `select count(*)::int n from collection_jobs where kind = 'fetch_set' and status in ('queued', 'running', 'held', 'blocked') and discovery_page = any($1)`,
      [pages],
    );
    return r.rows[0]!.n;
  }

  /** Re-read sets already in the catalog (to catch IDs getting identified). */
  async enqueueRefresh(urls: string[], options: { requestedBy?: number; priority?: number } = {}): Promise<number> {
    let added = 0;
    for (const url of new Set(urls.filter(isFetchAllowed))) {
      const r = await this.pool.query(
        `insert into collection_jobs (kind, target, status, priority, performed_on, requested_by)
         values ('refresh_set', $1, 'queued', $2, $3, $4) on conflict do nothing`,
        [url, options.priority ?? -10, dateFromUrl(url) ?? null, options.requestedBy ?? null],
      );
      added += r.rowCount ?? 0;
    }
    this.kick();
    return added;
  }

  /**
   * Queue refreshes for recent sets that still have unidentified IDs and haven't been
   * re-read in two weeks, most IDs first. Returns how many were queued.
   */
  async scheduleRefreshes(limit: number): Promise<number> {
    const r = await this.pool.query<{ url: string }>(
      `select s.url from sets s
        where s.performed_on >= current_date - 180
          and (s.last_refreshed_at is null or s.last_refreshed_at < now() - interval '14 days')
          and exists (select 1 from set_tracks st join tracks t on t.id = st.track_id
                       where st.set_id = s.id and t.id_status = 'unidentified')
          and not exists (select 1 from collection_jobs j where j.target = s.url and j.kind = 'refresh_set'
                           and j.status in ('queued', 'running', 'blocked'))
        order by (select count(*) from set_tracks st join tracks t on t.id = st.track_id
                   where st.set_id = s.id and t.id_status = 'unidentified') desc, s.performed_on desc
        limit $1`,
      [limit],
    );
    return this.enqueueRefresh(r.rows.map((row) => row.url));
  }

  /** A tracklist page someone opened in their browser (via the extension). */
  async importPage(html: string, pageUrl: string): Promise<Tracklist> {
    const set = parseTracklist(html, canonicalUrl(html) ?? pageUrl);
    if (set.tracks.length === 0) throw new Error("No tracks found on that page.");
    await this.catalog.save(set, html);
    await this.pool.query(
      `update collection_jobs set status = 'done', updated_at = now()
        where kind = 'fetch_set' and status in ('queued', 'blocked', 'held') and target like $1`,
      [`%/tracklist/${set.id}/%`],
    );
    if ((await this.count("status in ('queued', 'blocked')")) === 0) await this.unpause();
    return set;
  }

  /** Move held (older) sets into the line. */
  async includeOlder(): Promise<number> {
    const r = await this.pool.query("update collection_jobs set status = 'queued', updated_at = now() where status = 'held'");
    this.kick();
    return r.rowCount ?? 0;
  }

  /** Forget everything waiting or held. A fetch already in flight finishes. */
  async clearQueue(): Promise<{ waiting: number; found: number }> {
    const r = await this.pool.query("delete from collection_jobs where status in ('queued', 'blocked', 'held')");
    await this.unpause();
    return { waiting: r.rowCount ?? 0, found: 0 };
  }

  /**
   * After a pause: try again with everything waiting. Not before the time the site gave
   * (Retry-After): then it says when, and nothing is requested.
   */
  async resume(): Promise<{ resumed: boolean; waitUntil?: string }> {
    const state = await this.state();
    if (state.paused_until && state.paused_until.getTime() > Date.now()) return { resumed: false, waitUntil: state.paused_until.toISOString() };
    await this.pool.query("update collection_jobs set status = 'queued', next_attempt_at = now(), updated_at = now() where status = 'blocked'");
    await this.unpause();
    await this.sessions.accessRestored();
    this.kick();
    return { resumed: true };
  }

  /** Put this batch's failed jobs back in line. */
  async retryFailed(): Promise<number> {
    const r = await this.pool.query(
      `update collection_jobs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, updated_at = now()
        where status = 'failed' and updated_at >= (select batch_started_at from collector_state)`,
    );
    this.kick();
    return r.rowCount ?? 0;
  }

  async status(): Promise<QueueStatus> {
    const state = await this.state();
    const counts = (
      await this.pool.query<{ status: string; n: number }>(
        `select status, count(*)::int as n from collection_jobs
          where status in ('queued', 'running', 'blocked', 'held')
             or (status in ('done', 'failed') and updated_at >= $1)
          group by status`,
        [state.batch_started_at],
      )
    ).rows;
    const n = (status: string) => counts.find((c) => c.status === status)?.n ?? 0;
    // Sets of a paused or stopped session aren't "waiting": they go only when it continues.
    const waiting = (
      await this.pool.query<{ target: string }>(
        `select target from collection_jobs j where (status = 'running' or (status in ('queued', 'blocked') and ${CLAIMABLE}))
          order by (status = 'running') desc, priority desc, performed_on desc nulls last, id limit 300`,
      )
    ).rows.map((r) => r.target);
    const onHold = (await this.pool.query<{ n: number }>(`select count(*)::int n from collection_jobs j where status in ('queued', 'blocked') and not ${CLAIMABLE}`)).rows[0]!.n;
    const remaining = n("queued") + n("running") + n("blocked") - onHold;
    const status: QueueStatus = {
      state: state.paused_reason ? "blocked" : remaining > 0 ? "running" : "idle",
      done: n("done"),
      total: n("done") + remaining,
      failed: n("failed"),
      pendingFailures: n("failed"),
      etaSeconds: Math.round((remaining * this.delayMs) / 1000),
      waiting,
      found: [],
      older: n("held"),
    };
    if (this.current) status.current = this.current;
    if (state.paused_reason) {
      status.pauseReason = state.paused_reason;
      if (state.paused_detail) status.blocked = state.paused_detail;
      if (state.paused_until && state.paused_until.getTime() > Date.now()) status.pausedUntil = state.paused_until.toISOString();
      if (state.block_kind) status.blockKind = state.block_kind;
    }
    return status;
  }

  /** Is collecting busy or paused (so background work should wait)? */
  async busy(): Promise<boolean> {
    return (await this.status()).state !== "idle";
  }

  /** Resolves when the worker has nothing left it can do right now. Used by tests. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Start the worker if it isn't running. */
  kick(): void {
    if (this.running) return;
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
  }

  // ---------- the worker ----------

  private async work(): Promise<void> {
    for (;;) {
      if ((await this.state()).paused_reason) return;
      const nextCheckpoint = await this.sessions.advanceCheckpoints();
      const job = await this.claim();
      if (!job) {
        await this.scheduleNextRetry(nextCheckpoint);
        return;
      }
      this.current = job.target;
      this.currentSession = job.session_id;
      this.abort = new AbortController();
      let outcome: JobOutcome | undefined;
      let error: string | undefined;
      try {
        [outcome, error] = await this.process(job, this.abort.signal);
      } finally {
        this.current = undefined;
        this.currentSession = null;
        this.abort = undefined;
      }
      if (job.session_id && outcome) await this.sessions.afterJob(job.session_id, outcome, error);
    }
  }

  /** Take the next job that's due, marking it running, without racing other workers. */
  private async claim(): Promise<JobRow | undefined> {
    const r = await this.pool.query<JobRow>(
      `update collection_jobs set status = 'running', attempts = attempts + 1, updated_at = now()
        where id = (select j.id from collection_jobs j where j.status = 'queued' and j.next_attempt_at <= now() and ${CLAIMABLE}
                     order by j.priority desc, j.performed_on desc nulls last, j.id
                     for update skip locked limit 1)
        returning id, kind, target, attempts, session_id`,
    );
    return r.rows[0];
  }

  /** Fetch and save one set. Says what happened, for its session (if it has one). */
  private async process(job: JobRow, signal: AbortSignal): Promise<[JobOutcome, string?]> {
    const sourceId = tracklistId(job.target) ?? "";
    if (job.kind === "fetch_set" && (await this.catalog.has(sourceId))) {
      await this.finish(job.id, "done");
      return ["cached"];
    }

    let html: string;
    try {
      html = await this.source.fetchHtml(job.target, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CancelledError) {
        // Stopped by the person: the set goes back in line for a later Resume, not "failed".
        await this.pool.query("update collection_jobs set status = 'queued', attempts = greatest(attempts - 1, 0), updated_at = now() where id = $1", [job.id]);
        return ["cancelled"];
      }
      if (error instanceof BlockedError) {
        await this.finish(job.id, "blocked", message);
        if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "blocked", 0, message);
        await this.pause("site", message, error.kind, error.retryAfterSeconds);
        await this.sessions.accessRequired(message);
        return ["failed", message];
      }
      if (error instanceof EmptyTracklistError) {
        // A real answer: nothing listed yet. Not saved, not counted, not a failure.
        await this.finish(job.id, "done", message);
        if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "unchanged", 0);
        return ["empty", message];
      }
      if (error instanceof LayoutError) {
        await this.finish(job.id, "failed", message);
        if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "failed", 0, message);
        return ["failed", message];
      }
      // A passing problem: try again later, a few times.
      const delay = RETRY_DELAYS_MS[job.attempts - 1];
      if (delay !== undefined) {
        await this.pool.query(
          `update collection_jobs set status = 'queued', next_attempt_at = now() + make_interval(secs => $2), last_error = $3, updated_at = now() where id = $1`,
          [job.id, delay / 1000, message],
        );
        return ["failed", message]; // trying again later: not counted yet
      } else {
        await this.finish(job.id, "failed", message);
        if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "failed", 0, message);
      }
      return ["failed", message];
    }

    // Reading and saving the page (one transaction): a failure here won't fix itself by retrying.
    try {
      const changed = await this.catalog.save(parseTracklist(html, job.target), html);
      if (job.kind === "refresh_set") await this.recordRefresh(sourceId, changed > 0 ? "updated" : "unchanged", changed);
      await this.finish(job.id, "done");
      return [job.kind === "fetch_set" ? "saved" : "cached"];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(job.id, "failed", message);
      if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "failed", 0, message);
      return ["failed", message];
    }
  }

  private async finish(id: number, status: "done" | "failed" | "blocked", error?: string): Promise<void> {
    await this.pool.query("update collection_jobs set status = $2, last_error = coalesce($3, last_error), updated_at = now() where id = $1", [id, status, error ?? null]);
  }

  private async recordRefresh(sourceId: string, result: "unchanged" | "updated" | "failed" | "blocked", changes: number, error?: string): Promise<void> {
    await this.pool.query(
      `insert into source_refresh_history (set_id, result, changes, error)
       select id, $2, $3, $4 from sets where source_id = $1`,
      [sourceId, result, changes, error ?? null],
    );
  }

  /** Wake up when a job is due to retry, or a checkpoint's countdown ends. */
  private async scheduleNextRetry(nextCheckpoint?: Date): Promise<void> {
    const r = await this.pool.query<{ ms: number }>(
      `select greatest(0, extract(epoch from min(next_attempt_at) - now()) * 1000)::int as ms
         from collection_jobs j where status = 'queued' and next_attempt_at > now() and ${CLAIMABLE}`,
    );
    const retry = r.rows[0]?.ms;
    const checkpoint = nextCheckpoint ? Math.max(0, nextCheckpoint.getTime() - Date.now()) : undefined;
    const ms = [retry, checkpoint].filter((x): x is number => x !== null && x !== undefined);
    if (ms.length) this.schedule(Math.min(...ms) + 50, () => this.kick());
  }

  // ---------- shared state ----------

  private async state(): Promise<{ paused_reason: PauseReason | null; paused_detail: string | null; batch_started_at: Date; paused_until: Date | null; block_kind: BlockKind | null }> {
    const r = await this.pool.query("select paused_reason, paused_detail, batch_started_at, paused_until, block_kind from collector_state where id = 1");
    return r.rows[0];
  }

  private async pause(reason: PauseReason, detail: string, kind?: BlockKind, retryAfterSeconds?: number): Promise<void> {
    await this.pool.query(
      `update collector_state set paused_reason = $1, paused_detail = $2, paused_at = now(), block_kind = $3,
              paused_until = case when $4::int is null then null else now() + make_interval(secs => $4::int) end
        where id = 1`,
      [reason, detail, kind ?? null, retryAfterSeconds ?? null],
    );
  }

  private async unpause(): Promise<void> {
    await this.pool.query("update collector_state set paused_reason = null, paused_detail = null, paused_at = null, paused_until = null, block_kind = null where id = 1");
  }

  private async startBatch(): Promise<void> {
    await this.pool.query("update collector_state set batch_started_at = now() where id = 1");
  }

  private async count(where: string): Promise<number> {
    return (await this.pool.query<{ n: number }>(`select count(*)::int as n from collection_jobs where ${where}`)).rows[0]!.n;
  }
}
