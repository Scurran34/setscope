import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { PgJobQueue } from "../src/collect/jobs.ts";
import { BlockedError, type HtmlSource } from "../src/source/fetcher.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";

const pageHtml = readFileSync(join(import.meta.dirname, "fixtures/tracklist-page.html"), "utf8");
const url = (id: string, date = "2026-09-10") => `https://www.1001tracklists.com/tracklist/${id}/set-${date}.html`;

/** A fake site: answers with the fixture page, or with whatever a test scripts. */
function fakeSite() {
  const requested: string[] = [];
  const script: (() => string)[] = [];
  const source: HtmlSource = {
    async fetchHtml(u) {
      requested.push(u);
      const next = script.shift();
      return next ? next() : pageHtml;
    },
  };
  const fail = (error: Error) => script.push(() => {
    throw error;
  });
  return { source, requested, script, fail };
}

const available = await databaseAvailable();

describe.skipIf(!available)("PgJobQueue", () => {
  let pool: pg.Pool;
  let catalog: PgCatalog;
  let site: ReturnType<typeof fakeSite>;
  let queue: PgJobQueue;
  let retries: { ms: number; run: () => void }[];

  beforeEach(async () => {
    pool = await freshSchema("jobs");
    catalog = new PgCatalog(pool);
    site = fakeSite();
    retries = [];
    queue = new PgJobQueue(pool, catalog, site.source, { schedule: (ms, run) => retries.push({ ms, run }) });
  });
  afterEach(async () => {
    await queue.settled(); // a worker still running would use the pool after it closes
    await pool.end();
  });

  const jobs = async () =>
    (await pool.query("select kind, target, status, attempts, last_error from collection_jobs order by id")).rows;

  it("fetches each new set once, newest first, and skips sets already in the catalog", async () => {
    await catalog.save({ id: "have1", url: url("have1"), title: "t", djs: [], date: "2026-09-01", tracks: [] }, "");
    const result = await queue.enqueue([url("old1", "2026-01-01"), url("new1", "2026-09-20"), url("new1", "2026-09-20"), url("have1")], "2025-01-01");
    expect(result).toEqual({ queued: 2, fetchingNow: 2, alreadyCached: 1, skippedOld: 0 });
    await queue.settled();
    expect(site.requested).toEqual([url("new1", "2026-09-20"), url("old1", "2026-01-01")]);
    expect(await queue.status()).toMatchObject({ state: "idle", done: 2, total: 2, waiting: [] });

    // Asking again, from another page or another person, does nothing.
    expect(await queue.enqueue([url("new1", "2026-09-20")], "2025-01-01")).toMatchObject({ queued: 0, alreadyCached: 1 });
    await queue.settled();
    expect(site.requested).toHaveLength(2);
  });

  it("holds sets older than the window until someone includes them", async () => {
    expect(await queue.enqueue([url("o1", "2023-01-01")], "2025-01-01")).toMatchObject({ queued: 0, skippedOld: 1 });
    await queue.settled();
    expect(site.requested).toEqual([]);
    expect(await queue.status()).toMatchObject({ state: "idle", older: 1 });
    expect(await queue.includeOlder()).toBe(1);
    await queue.settled();
    expect(site.requested).toEqual([url("o1", "2023-01-01")]);
  });

  it("retries passing failures after 30s, 2m and 8m, then gives up and keeps the error", async () => {
    for (let i = 0; i < 4; i++) site.fail(new Error("Network failure: ECONNRESET"));
    await queue.enqueue([url("f1")], "2025-01-01");
    await queue.settled();
    for (const expected of [30_000, 120_000, 480_000]) {
      expect(retries.at(-1)!.ms).toBeGreaterThan(expected - 2_000);
      expect(retries.at(-1)!.ms).toBeLessThanOrEqual(expected + 100);
      await pool.query("update collection_jobs set next_attempt_at = now()"); // time passes
      retries.at(-1)!.run();
      await queue.settled();
    }
    expect(await jobs()).toEqual([{ kind: "fetch_set", target: url("f1"), status: "failed", attempts: 4, last_error: "Network failure: ECONNRESET" }]);
    expect(await queue.status()).toMatchObject({ state: "idle", failed: 1 });
    expect(await catalog.has("f1")).toBe(false);

    expect(await queue.retryFailed()).toBe(1);
    await queue.settled();
    expect(await catalog.has("f1")).toBe(true);
  });

  it("pauses everything when the site says slow down, never treating it as 'no more sets'", async () => {
    site.fail(new BlockedError("HTTP 429 from site", 429));
    await queue.enqueue([url("b1", "2026-09-02"), url("b2", "2026-09-01")], "2025-01-01");
    await queue.settled();
    expect(site.requested).toEqual([url("b1", "2026-09-02")]); // stopped after the block
    expect(await queue.status()).toMatchObject({ state: "blocked", pauseReason: "site", blocked: "HTTP 429 from site", waiting: [url("b1", "2026-09-02"), url("b2", "2026-09-01")] });

    // New requests while paused wait too.
    await queue.enqueue([url("b3")], "2025-01-01");
    await queue.settled();
    expect(site.requested).toHaveLength(1);

    await queue.resume();
    await queue.settled();
    expect(await queue.status()).toMatchObject({ state: "idle", done: 3 });
  });

  it("after a restart, puts interrupted jobs back in line and comes back paused", async () => {
    await pool.query(`insert into collection_jobs (kind, target, status) values ('fetch_set', $1, 'running'), ('fetch_set', $2, 'queued')`, [url("r1"), url("r2")]);
    const restarted = new PgJobQueue(pool, catalog, site.source, { schedule: (ms, run) => retries.push({ ms, run }) });
    await restarted.recover();
    expect(await restarted.status()).toMatchObject({ state: "blocked", pauseReason: "restart", total: 2 });
    restarted.kick();
    await restarted.settled();
    expect(site.requested).toEqual([]); // nothing until someone says so
    await restarted.resume();
    await restarted.settled();
    expect(site.requested).toHaveLength(2);
  });

  it("takes a set someone opened in their browser off the line, and unpauses when the line empties", async () => {
    site.fail(new BlockedError("HTTP 401", 401));
    await queue.enqueue([url("zz9fix1")], "2025-01-01");
    await queue.settled();
    expect(await queue.status()).toMatchObject({ state: "blocked" });
    const set = await queue.importPage(pageHtml, "https://www.1001tracklists.com/tracklist/zz9fix1/x.html");
    expect(set.tracks).toHaveLength(6);
    expect(await queue.status()).toMatchObject({ state: "idle", waiting: [] });
    await expect(queue.importPage("<h1 id=pageTitle>x 2026-01-01</h1>", url("e1"))).rejects.toThrow(/No tracks/);
  });

  it("clears everything waiting or held, and unpauses", async () => {
    site.fail(new BlockedError("HTTP 401", 401));
    await queue.enqueue([url("c1"), url("c2"), url("old", "2020-01-01")], "2025-01-01");
    await queue.settled();
    expect(await queue.clearQueue()).toEqual({ waiting: 3, found: 0 });
    expect(await queue.status()).toMatchObject({ state: "idle", waiting: [], older: 0 });
  });

  it("lets two workers share the line without fetching a set twice", async () => {
    const other = new PgJobQueue(pool, catalog, site.source, { schedule: (ms, run) => retries.push({ ms, run }) });
    await queue.enqueue(Array.from({ length: 6 }, (_, i) => url(`w${i}`)), "2025-01-01");
    other.kick();
    await Promise.all([queue.settled(), other.settled()]);
    expect(site.requested).toHaveLength(6);
    expect(new Set(site.requested).size).toBe(6);
  });

  it("refreshes a set, records what changed, and keeps the stored version when the site can't be reached", async () => {
    await queue.enqueue([url("zz9fix1")], "2025-01-01");
    await queue.settled();
    // The site now says the second line (an ID) is a real song.
    site.script.push(() => pageHtml.replace('<span class="trackValue notranslate blueTxt">ID - ID</span>', '<span class="trackValue">Fisher - Losing It</span>'));
    expect(await queue.enqueueRefresh([url("zz9fix1")])).toBe(1);
    await queue.settled();
    site.fail(new BlockedError("HTTP 403", 403));
    await queue.enqueueRefresh([url("zz9fix1")]);
    await queue.settled();
    const history = (await pool.query("select result, changes from source_refresh_history order by id")).rows;
    expect(history).toEqual([
      { result: "updated", changes: 1 },
      { result: "blocked", changes: 0 },
    ]);
    const [set] = await catalog.all();
    expect(set!.tracks[1]).toMatchObject({ artist: "Fisher", title: "Losing It" }); // kept after the failed refresh
  });

  it("schedules refreshes only for recent sets with unidentified IDs not checked lately", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await catalog.save({ id: "id1", url: url("id1", today), title: "t", djs: [], date: today, tracks: [{ artist: "ID", title: "ID" }] }, "");
    await catalog.save({ id: "named", url: url("named", today), title: "t", djs: [], date: today, tracks: [{ artist: "A", title: "B" }] }, "");
    await catalog.save({ id: "old", url: url("old", "2020-01-01"), title: "t", djs: [], date: "2020-01-01", tracks: [{ artist: "ID", title: "ID" }] }, "");
    await pool.query("update sets set last_refreshed_at = now() - interval '30 days'");
    expect(await queue.scheduleRefreshes(10)).toBe(1);
    expect((await jobs()).map((j) => [j.kind, j.target])).toEqual([["refresh_set", url("id1", today)]]);
    expect(await queue.scheduleRefreshes(10)).toBe(0); // already queued
    await queue.settled();
  });
});
