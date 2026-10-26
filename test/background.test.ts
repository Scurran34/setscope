import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundCollector, type CollectorSource } from "../src/source/background.ts";
import { BlockedError } from "../src/source/fetcher.ts";
import { FetchQueue } from "../src/source/queue.ts";
import { TracklistStore } from "../src/source/store.ts";

const pageHtml = readFileSync(join(import.meta.dirname, "fixtures/tracklist-page.html"), "utf8");
const url = (id: string, date: string) => `https://www.1001tracklists.com/tracklist/${id}/set-${date}.html`;
const frontPage = (...urls: string[]) => urls.map((u) => `<a href="${u.replace("https://www.1001tracklists.com", "")}">x</a>`).join("");

let dir: string;
let store: TracklistStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setscope-bg-"));
  store = new TracklistStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(front: string, options: { blockSets?: boolean } = {}) {
  const calls: string[] = [];
  const source: CollectorSource = {
    async fetchFrontPage() {
      calls.push("front");
      return front;
    },
    async fetchHtml(u) {
      calls.push(u);
      if (options.blockSets) throw new BlockedError("bot check", 401);
      return pageHtml;
    },
  };
  let clock = Date.parse("2026-10-26T12:00:00");
  const queue = new FetchQueue(store, { fetchHtml: source.fetchHtml });
  const collector = new BackgroundCollector(store, queue, source, {
    now: () => clock,
    since: () => "2025-01-01",
    gapMs: 90_000,
    frontPageEveryMs: 3_600_000,
    dailyCap: 2,
    saveFile: join(dir, "background.json"),
  });
  return { collector, queue, calls, advance: (ms: number) => (clock += ms) };
}

describe("BackgroundCollector", () => {
  it("does nothing until you turn it on", async () => {
    const { collector, calls } = setup(frontPage(url("a1", "2026-10-01")));
    await collector.tick();
    expect(calls).toEqual([]);
    expect(collector.status().state).toBe("off");
  });

  it("reads the front page, then fetches its new sets newest first, 90s apart, skipping old and cached", async () => {
    const { collector, calls, advance } = setup(
      frontPage(url("a1", "2026-10-01"), url("a2", "2026-10-20"), url("old", "2019-01-01")),
    );
    collector.setEnabled(true);
    await collector.tick(); // front page
    expect(collector.status()).toMatchObject({ pending: 2, state: "resting" });
    await collector.tick(); // too soon
    advance(90_000);
    await collector.tick();
    advance(90_000);
    await collector.tick();
    expect(calls).toEqual(["front", url("a2", "2026-10-20"), url("a1", "2026-10-01")]);
    expect(collector.status()).toMatchObject({ today: 2, pending: 0 });
  });

  it("stops at the daily limit and starts again the next day", async () => {
    const { collector, calls, advance } = setup(frontPage(url("b1", "2026-10-03"), url("b2", "2026-10-02"), url("b3", "2026-10-01")));
    collector.setEnabled(true);
    for (let i = 0; i < 6; i++) {
      await collector.tick();
      advance(90_000);
    }
    expect(collector.status()).toMatchObject({ state: "daily-limit", today: 2, pending: 1 });
    advance(24 * 3_600_000);
    await collector.tick();
    expect(calls.at(-1)).toBe(url("b3", "2026-10-01"));
  });

  it("waits while your queue is fetching", async () => {
    const { collector, queue, calls } = setup(frontPage(url("c1", "2026-10-01")));
    collector.setEnabled(true);
    queue.enqueue([url("q1", "2026-10-05")], "2025-01-01"); // starts running
    expect(collector.status().state).toBe("waiting-for-queue");
    await collector.tick();
    expect(calls).toEqual([url("q1", "2026-10-05")]); // only the queue's request
    await queue.settled();
  });

  it("pauses for 24 hours on a block, keeps the set, and remembers it across restarts", async () => {
    const { collector, calls, advance } = setup(frontPage(url("d1", "2026-10-01")), { blockSets: true });
    collector.setEnabled(true);
    await collector.tick();
    advance(90_000);
    await collector.tick(); // blocked
    expect(collector.status()).toMatchObject({ state: "paused", pending: 1, lastError: "bot check" });
    advance(12 * 3_600_000);
    await collector.tick();
    expect(calls).toHaveLength(2); // nothing while paused

    const saved = JSON.parse(readFileSync(join(dir, "background.json"), "utf8"));
    expect(saved).toMatchObject({ enabled: true, pending: [url("d1", "2026-10-01")] });
  });
});
