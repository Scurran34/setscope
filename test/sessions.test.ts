import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "../src/auth/accounts.ts";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { PgJobQueue } from "../src/collect/jobs.ts";
import { CollectionSessions } from "../src/collect/sessions.ts";
import { BlockedError, CancelledError, type HtmlSource } from "../src/source/fetcher.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";

const pageHtml = readFileSync(join(import.meta.dirname, "fixtures/tracklist-page.html"), "utf8");
const url = (id: string, day: number) => `https://www.1001tracklists.com/tracklist/${id}/set-2026-09-${String(day).padStart(2, "0")}.html`;
const PAGE = "https://www.1001tracklists.com/dj/test-dj/index.html";
/** n set links, newest first. */
const links = (n: number, prefix = "s") => Array.from({ length: n }, (_, i) => url(`${prefix}${i}`, 28 - i));

/** A fake 1001Tracklists: answers with a tracklist page, or as scripted; can hang until a Stop. */
function fakeSite() {
  const requested: string[] = [];
  const script: ((signal?: AbortSignal) => Promise<string> | string)[] = [];
  const source: HtmlSource = {
    async fetchHtml(u, signal) {
      requested.push(u);
      const next = script.shift();
      return next ? next(signal) : pageHtml;
    },
  };
  /** The next request waits until it's cancelled. */
  const hang = () =>
    script.push(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new CancelledError()), { once: true });
        }),
    );
  return { source, requested, script, hang };
}

const available = await databaseAvailable();

describe.skipIf(!available)("collection sessions", () => {
  let pool: pg.Pool;
  let catalog: PgCatalog;
  let site: ReturnType<typeof fakeSite>;
  let queue: PgJobQueue;
  let userId: number;
  let wakeups: { ms: number; run: () => void }[];

  const makeQueue = () => new PgJobQueue(pool, catalog, site.source, { schedule: (ms, run) => wakeups.push({ ms, run }), checkpointMs: 60_000 });
  const session = async (id: number) => (await queue.sessions.get(id))!;
  /** Start a session the way a capture does. */
  const gather = async (urls: string[], target: number, page: string | null = PAGE) => {
    const id = await queue.sessions.open({ userId, label: "Test DJ", sourcePage: page, target, pagesScanned: urls.length });
    const r = await queue.enqueue(urls, "0001-01-01", { sessionId: id, newLimit: target, requestedBy: userId });
    await queue.sessions.addCached(id, r.alreadyCached);
    await queue.sessions.settleIfEmpty(id);
    return { id, result: r };
  };
  /** End a checkpoint's countdown now and let the worker look again. */
  const endCheckpoint = async () => {
    await pool.query("update collection_sessions set checkpoint_until = now() - interval '1 second' where state = 'checkpoint'");
    queue.kick();
    await queue.settled();
  };

  beforeEach(async () => {
    pool = await freshSchema("sessions");
    catalog = new PgCatalog(pool);
    site = fakeSite();
    wakeups = [];
    queue = makeQueue();
    userId = (await new Accounts(pool).register({ email: "dj@example.test", password: "a long password", displayName: "DJ" })).id;
  });
  afterEach(async () => {
    await queue.settled();
    await pool.end();
  });

  it("keeps Auto-Collect off for new people, and remembers the setting across restarts", async () => {
    expect(await queue.sessions.prefs(userId)).toEqual({ autoCollect: false, checkpointEvery: 5, defaultTarget: 25 });
    await queue.sessions.setPrefs(userId, { autoCollect: true, checkpointEvery: 10 });
    expect(await new CollectionSessions(pool).prefs(userId)).toEqual({ autoCollect: true, checkpointEvery: 10, defaultTarget: 25 });
    await expect(queue.sessions.setPrefs(userId, { checkpointEvery: 7 as 5 })).rejects.toThrow(/5 or 10/);
  });

  it("with Auto-Collect off, stops at the first checkpoint and waits for Continue", async () => {
    const { id } = await gather(links(12), 12);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 5, remaining: 7 });
    await endCheckpoint();
    expect(await session(id)).toMatchObject({ state: "paused", pauseReason: "checkpoint", collected: 5 });
    expect(site.requested).toHaveLength(5); // nothing more was fetched
    await queue.resumeSession(id);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 10 });
  });

  it("with Auto-Collect on, goes on after each checkpoint until the target, counting only new sets", async () => {
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    // Two of the newest are already indexed: they're skipped, and older sets fill in.
    await catalog.save({ id: "s0", url: url("s0", 28), title: "t", djs: [], date: "2026-09-28", tracks: [] }, "");
    await catalog.save({ id: "s1", url: url("s1", 27), title: "t", djs: [], date: "2026-09-27", tracks: [] }, "");
    const { id, result } = await gather(links(15), 10);
    expect(result).toMatchObject({ queued: 10, alreadyCached: 2 });
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 5, cached: 2 });
    await endCheckpoint();
    expect(await session(id)).toMatchObject({ state: "completed", collected: 10, cached: 2, remaining: 0 });
    expect(site.requested).toHaveLength(10);
    expect(site.requested).not.toContain(url("s0", 28)); // never refetched
    expect(await catalog.count()).toBe(12); // 10 new + the 2 already there, no duplicates
  });

  it("checkpoints every 10 when set to", async () => {
    await queue.sessions.setPrefs(userId, { checkpointEvery: 10 });
    const { id } = await gather(links(12), 12);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 10, checkpointEvery: 10 });
  });

  it("switching Auto-Collect off during a checkpoint means it waits instead of going on", async () => {
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    const { id } = await gather(links(8), 8);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 5 });
    await queue.sessions.setPrefs(userId, { autoCollect: false });
    await endCheckpoint();
    expect(await session(id)).toMatchObject({ state: "paused", collected: 5 });
    // And back on: it continues by itself.
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    queue.kick();
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "completed", collected: 8 });
  });

  it("Stop cancels the set in flight, keeps what was saved, and stays stopped", async () => {
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    // Two sets save, then the third hangs mid-fetch until Stop.
    site.script.push(() => pageHtml, () => pageHtml);
    site.hang();
    const { id } = await gather(links(6), 6);
    await new Promise((r) => setTimeout(r, 300));
    expect(await session(id)).toMatchObject({ state: "running", collected: 2 });
    await queue.stopSession(id);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "stopped", collected: 2, remaining: 4 });
    expect(await catalog.count()).toBe(2);
    const jobs = await pool.query("select status, count(*)::int n from collection_jobs group by status order by status");
    expect(jobs.rows).toEqual([
      { status: "done", n: 2 },
      { status: "queued", n: 4 }, // kept for Resume, not marked failed
    ]);
    // Not restarted by switching Auto-Collect on, by a restart, or by the worker waking up.
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    const restarted = makeQueue();
    await restarted.recover();
    await restarted.resume();
    await restarted.settled();
    expect(await session(id)).toMatchObject({ state: "stopped", collected: 2 });
    expect(site.requested).toHaveLength(3);
    // Resume is what continues it (with its checkpoint at 5, then on to the target).
    queue = restarted;
    await restarted.resumeSession(id);
    await restarted.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 5 });
    await endCheckpoint();
    expect(await session(id)).toMatchObject({ state: "completed", collected: 6 });
  });

  it("a Stop that's mid-fetch when the server stops is finished after the restart", async () => {
    const { id } = await gather(links(3), 3);
    await queue.settled();
    await pool.query("update collection_sessions set state = 'stopping', stop_requested = true where id = $1", [id]);
    const restarted = makeQueue();
    await restarted.recover();
    expect((await restarted.sessions.get(id))!.state).toBe("stopped");
    queue = restarted;
  });

  it("pauses everything when the site refuses, honours Retry-After, and makes no more requests", async () => {
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    site.script.push(() => pageHtml, () => {
      throw new BlockedError("HTTP 429 from site", 429, "rate_limit", 3600);
    });
    const { id } = await gather(links(6), 6);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "access_required", collected: 1 });
    const status = await queue.status();
    expect(status).toMatchObject({ state: "blocked", pauseReason: "site", blockKind: "rate_limit" });
    expect(Date.parse(status.pausedUntil!)).toBeGreaterThan(Date.now() + 3500_000);
    expect(await queue.resume()).toMatchObject({ resumed: false }); // not before the site's time
    queue.kick();
    await queue.settled();
    expect(site.requested).toHaveLength(2);
    // Once the time has passed, Try again continues the session.
    await pool.query("update collector_state set paused_until = now() - interval '1 second'");
    expect(await queue.resume()).toEqual({ resumed: true });
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "checkpoint", collected: 5 });
  });

  it("asks an open session for more instead of starting a second one, and never queues a set twice", async () => {
    const first = await gather(links(3), 2);
    const again = await gather(links(6), 2);
    expect(again.id).toBe(first.id);
    expect(await session(first.id)).toMatchObject({ target: 2 }); // collected (0) + 2 more
    const jobs = await pool.query<{ n: number }>("select count(*)::int n from collection_jobs");
    expect(jobs.rows[0]!.n).toBe(2); // the same two newest sets, once each
    // A different page's session can share a set already in line without fetching it twice.
    const other = await gather([links(1)[0]!], 1, "https://www.1001tracklists.com/dj/another/index.html");
    expect((await pool.query<{ n: number }>("select count(*)::int n from collection_jobs")).rows[0]!.n).toBe(2);
    expect(other.result.queued).toBe(0);
  });

  it("a gather with nothing new is complete straight away", async () => {
    await catalog.save({ id: "s0", url: url("s0", 28), title: "t", djs: [], date: "2026-09-28", tracks: [] }, "");
    const { id } = await gather(links(1), 5);
    expect(await session(id)).toMatchObject({ state: "completed", collected: 0, cached: 1 });
  });

  it("doesn't count an empty tracklist or an unrecognized page as collected", async () => {
    await queue.sessions.setPrefs(userId, { autoCollect: true });
    const { EmptyTracklistError, LayoutError } = await import("../src/source/fetcher.ts");
    site.script.push(() => {
      throw new EmptyTracklistError("x");
    }, () => {
      throw new LayoutError("y");
    });
    const { id } = await gather(links(4), 4);
    await queue.settled();
    expect(await session(id)).toMatchObject({ state: "completed", collected: 2, remaining: 0 });
    expect((await queue.status()).state).toBe("idle"); // neither paused collecting
  });
});
