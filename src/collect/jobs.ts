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
import { BlockedError, isFetchAllowed, MIN_DELAY_MS, type HtmlSource } from "../source/fetcher.ts";
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
}

export interface EnqueueResult {
  /** New sets put in line. */
  queued: number;
  fetchingNow: number;
  alreadyCached: number;
  /** Sets older than the window, held. */
  skippedOld: number;
}

/** Waits before retrying a job that failed for a passing reason: 30s, 2m, 8m. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

interface JobRow {
  id: number;
  kind: JobKind;
  target: string;
  attempts: number;
}

export interface JobQueueOptions {
  /** Only used for the time estimate; the fetcher enforces the real delay. */
  delayMs?: number;
  /** For tests: how a retry is scheduled (default: a timer). */
  schedule?: (ms: number, run: () => void) => void;
}

export class PgJobQueue {
  private readonly pool: pg.Pool;
  private readonly catalog: PgCatalog;
  private readonly source: HtmlSource;
  private readonly delayMs: number;
  private readonly schedule: (ms: number, run: () => void) => void;
  private running: Promise<void> | undefined;
  private current: string | undefined;

  constructor(pool: pg.Pool, catalog: PgCatalog, source: HtmlSource, options: JobQueueOptions = {}) {
    this.pool = pool;
    this.catalog = catalog;
    this.source = source;
    this.delayMs = options.delayMs ?? MIN_DELAY_MS;
    this.schedule = options.schedule ?? ((ms, run) => setTimeout(run, ms).unref());
  }

  /**
   * After a (re)start: jobs left "running" by a crash go back in line, and if anything
   * is waiting, collecting comes back paused until someone presses Try again.
   */
  async recover(): Promise<void> {
    await this.pool.query("update collection_jobs set status = 'queued', updated_at = now() where status = 'running'");
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
  async enqueue(urls: string[], since: string, options: { requestedBy?: number; priority?: number; start?: boolean } = {}): Promise<EnqueueResult> {
    const unique = [...new Set(urls.filter(isFetchAllowed))];
    if ((await this.count("status in ('queued', 'running', 'blocked')")) === 0) await this.startBatch();
    let queued = 0;
    let alreadyCached = 0;
    let skippedOld = 0;
    for (const url of unique) {
      const id = tracklistId(url);
      if (!id) continue;
      if (await this.catalog.has(id)) {
        alreadyCached++;
        continue;
      }
      const date = dateFromUrl(url);
      const held = date !== undefined && date < since;
      const r = await this.pool.query(
        `insert into collection_jobs (kind, target, status, priority, performed_on, requested_by)
         values ('fetch_set', $1, $2, $3, $4, $5) on conflict do nothing`,
        [url, held ? "held" : "queued", options.priority ?? 0, date ?? null, options.requestedBy ?? null],
      );
      if (r.rowCount === 0) continue; // already waiting
      if (held) skippedOld++;
      else queued++;
    }
    if (options.start !== false) this.kick();
    return { queued, fetchingNow: queued, alreadyCached, skippedOld };
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

  /** After a pause: try again with everything waiting. */
  async resume(): Promise<void> {
    await this.pool.query("update collection_jobs set status = 'queued', next_attempt_at = now(), updated_at = now() where status = 'blocked'");
    await this.unpause();
    this.kick();
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
    const waiting = (
      await this.pool.query<{ target: string }>(
        `select target from collection_jobs where status in ('queued', 'running', 'blocked')
          order by (status = 'running') desc, priority desc, performed_on desc nulls last, id limit 300`,
      )
    ).rows.map((r) => r.target);
    const remaining = n("queued") + n("running") + n("blocked");
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
      const job = await this.claim();
      if (!job) {
        await this.scheduleNextRetry();
        return;
      }
      this.current = job.target;
      try {
        await this.process(job);
      } finally {
        this.current = undefined;
      }
    }
  }

  /** Take the next job that's due, marking it running, without racing other workers. */
  private async claim(): Promise<JobRow | undefined> {
    const r = await this.pool.query<JobRow>(
      `update collection_jobs set status = 'running', attempts = attempts + 1, updated_at = now()
        where id = (select id from collection_jobs where status = 'queued' and next_attempt_at <= now()
                     order by priority desc, performed_on desc nulls last, id
                     for update skip locked limit 1)
        returning id, kind, target, attempts`,
    );
    return r.rows[0];
  }

  private async process(job: JobRow): Promise<void> {
    const sourceId = tracklistId(job.target) ?? "";
    if (job.kind === "fetch_set" && (await this.catalog.has(sourceId))) return this.finish(job.id, "done");

    let html: string;
    try {
      html = await this.source.fetchHtml(job.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BlockedError) {
        await this.finish(job.id, "blocked", message);
        if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "blocked", 0, message);
        await this.pause("site", message);
        return;
      }
      // A passing problem: try again later, a few times.
      const delay = RETRY_DELAYS_MS[job.attempts - 1];
      if (delay !== undefined) {
        await this.pool.query(
          `update collection_jobs set status = 'queued', next_attempt_at = now() + make_interval(secs => $2), last_error = $3, updated_at = now() where id = $1`,
          [job.id, delay / 1000, message],
        );
      } else {
        await this.finish(job.id, "failed", message);
        if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "failed", 0, message);
      }
      return;
    }

    // Reading and saving the page: a failure here won't fix itself by retrying.
    try {
      const changed = await this.catalog.save(parseTracklist(html, job.target), html);
      if (job.kind === "refresh_set") await this.recordRefresh(sourceId, changed > 0 ? "updated" : "unchanged", changed);
      await this.finish(job.id, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(job.id, "failed", message);
      if (job.kind === "refresh_set") await this.recordRefresh(sourceId, "failed", 0, message);
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

  /** If a job is waiting to retry, wake up when it's due. */
  private async scheduleNextRetry(): Promise<void> {
    const r = await this.pool.query<{ ms: number }>(
      `select greatest(0, extract(epoch from min(next_attempt_at) - now()) * 1000)::int as ms
         from collection_jobs where status = 'queued'`,
    );
    const ms = r.rows[0]?.ms;
    if (ms !== null && ms !== undefined) this.schedule(ms + 50, () => this.kick());
  }

  // ---------- shared state ----------

  private async state(): Promise<{ paused_reason: PauseReason | null; paused_detail: string | null; batch_started_at: Date }> {
    const r = await this.pool.query("select paused_reason, paused_detail, batch_started_at from collector_state where id = 1");
    return r.rows[0];
  }

  private async pause(reason: PauseReason, detail: string): Promise<void> {
    await this.pool.query("update collector_state set paused_reason = $1, paused_detail = $2, paused_at = now() where id = 1", [reason, detail]);
  }

  private async unpause(): Promise<void> {
    await this.pool.query("update collector_state set paused_reason = null, paused_detail = null, paused_at = null where id = 1");
  }

  private async startBatch(): Promise<void> {
    await this.pool.query("update collector_state set batch_started_at = now() where id = 1");
  }

  private async count(where: string): Promise<number> {
    return (await this.pool.query<{ n: number }>(`select count(*)::int as n from collection_jobs where ${where}`)).rows[0]!.n;
  }
}
