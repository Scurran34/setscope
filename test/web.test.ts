import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockedError, type HtmlSource } from "../src/source/fetcher.ts";
import { FetchQueue } from "../src/source/queue.ts";
import { TracklistStore } from "../src/source/store.ts";
import { createApp } from "../src/server.ts";

const pageHtml = readFileSync(join(import.meta.dirname, "fixtures/tracklist-page.html"), "utf8");
const url = (id: string, date = "2026-09-10") => `https://www.1001tracklists.com/tracklist/${id}/set-${date}.html`;

/** Serves the fixture for every URL; can be told to block, or to wait until released. */
function fakeSource() {
  const requested: string[] = [];
  let blockNext = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const source: HtmlSource = {
    async fetchHtml(u) {
      requested.push(u);
      if (gate) await gate;
      if (blockNext) {
        blockNext = false;
        throw new BlockedError("bot check", 401);
      }
      return pageHtml;
    },
  };
  return {
    source,
    requested,
    blockOnce: () => (blockNext = true),
    hold: () => (gate = new Promise((r) => (release = r))),
    letGo: () => {
      gate = undefined;
      release?.();
    },
  };
}

let dir: string;
let store: TracklistStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setscope-web-"));
  store = new TracklistStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FetchQueue", () => {
  it("fetches in the background, skipping cached, old and duplicate URLs", async () => {
    const fake = fakeSource();
    const queue = new FetchQueue(store, fake.source);
    const first = queue.enqueue([url("a1"), url("a1"), url("old", "2019-01-01")], "2025-01-01");
    expect(first).toEqual({ queued: 1, fetchingNow: 1, alreadyCached: 0, skippedOld: 1 });
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 1, total: 1 });

    const second = queue.enqueue([url("a1"), url("a2")], "2025-01-01");
    expect(second).toEqual({ queued: 1, fetchingNow: 1, alreadyCached: 1, skippedOld: 0 });
    await queue.settled();
    expect(fake.requested).toEqual([url("a1"), url("a2")]);
  });

  it("accepts new URLs while running and reports progress", async () => {
    const fake = fakeSource();
    fake.hold();
    const queue = new FetchQueue(store, fake.source, { delayMs: 8_000 });
    queue.enqueue([url("a1"), url("a2")], "2025-01-01");
    queue.enqueue([url("a2"), url("a3")], "2025-01-01"); // a2 already waiting
    expect(queue.status()).toMatchObject({ state: "running", done: 0, total: 3, etaSeconds: 24 });
    fake.letGo();
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 3, total: 3 });
  });

  it("pauses on a block, keeps the URL, and finishes on resume", async () => {
    const fake = fakeSource();
    fake.blockOnce();
    const queue = new FetchQueue(store, fake.source);
    queue.enqueue([url("a1"), url("a2")], "2025-01-01");
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "blocked", done: 0, total: 2, blocked: "bot check" });

    queue.resume();
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 2 });
    expect(fake.requested).toEqual([url("a1"), url("a1"), url("a2")]);
  });
});

describe("FetchQueue batches", () => {
  it("fetches only the newest N, keeps the rest as found, and fetches more on request", async () => {
    const fake = fakeSource();
    const queue = new FetchQueue(store, fake.source);
    const urls = [url("b1", "2026-01-01"), url("b2", "2026-03-01"), url("b3", "2026-02-01")];
    expect(queue.enqueue(urls, "2025-01-01", 2)).toMatchObject({ queued: 3, fetchingNow: 2 });
    await queue.settled();
    expect(fake.requested).toEqual([url("b2", "2026-03-01"), url("b3", "2026-02-01")]);
    expect(queue.status()).toMatchObject({ state: "idle", found: [url("b1", "2026-01-01")] });

    expect(queue.more(5)).toBe(1);
    await queue.settled();
    expect(queue.status()).toMatchObject({ found: [], done: 1 });
  });

  it("clears found sets without touching ones already fetching", async () => {
    const fake = fakeSource();
    fake.hold();
    const queue = new FetchQueue(store, fake.source);
    queue.enqueue([url("c1", "2026-03-01"), url("c2", "2026-02-01"), url("c3", "2026-01-01")], "2025-01-01", 1);
    expect(queue.clearFound()).toBe(2);
    fake.letGo();
    await queue.settled();
    expect(queue.status()).toMatchObject({ found: [], done: 1 });
    expect(fake.requested).toEqual([url("c1", "2026-03-01")]);
  });

  it("does not re-add sets that are already found or fetching", () => {
    const fake = fakeSource();
    fake.hold();
    const queue = new FetchQueue(store, fake.source);
    queue.enqueue([url("d1", "2026-03-01"), url("d2", "2026-02-01")], "2025-01-01", 1);
    expect(queue.enqueue([url("d1", "2026-03-01"), url("d2", "2026-02-01")], "2025-01-01", 1)).toMatchObject({ queued: 0 });
    fake.letGo();
  });
});

describe("FetchQueue clearing and pause reasons", () => {
  it("says why it paused, and clearing the queue unpauses it", async () => {
    const fake = fakeSource();
    fake.blockOnce();
    const queue = new FetchQueue(store, fake.source);
    queue.enqueue([url("q1", "2026-03-01"), url("q2", "2026-02-01"), url("q3", "2026-01-01")], "2025-01-01", 2);
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "blocked", pauseReason: "site", found: [url("q3", "2026-01-01")] });

    expect(queue.clearQueue()).toEqual({ waiting: 2, found: 1 });
    expect(queue.status()).toMatchObject({ state: "idle", waiting: [], found: [] });
    expect(queue.status().pauseReason).toBeUndefined();
  });
});

describe("FetchQueue older sets", () => {
  it("sets aside sets older than the cutoff, then includes them on request", async () => {
    const saveFile = join(dir, "queue.json");
    const fake = fakeSource();
    const queue = new FetchQueue(store, fake.source, { saveFile });
    const result = queue.enqueue([url("n1", "2026-05-01"), url("o1", "2023-01-01"), url("o2", "2022-01-01")], "2025-01-01", 0);
    expect(result).toMatchObject({ queued: 1, skippedOld: 2, fetchingNow: 0 });
    expect(queue.status()).toMatchObject({ older: 2, found: [url("n1", "2026-05-01")] });
    expect(new FetchQueue(store, fake.source, { saveFile }).status().older).toBe(2); // saved

    expect(queue.includeOlder()).toBe(2);
    expect(queue.status()).toMatchObject({ older: 0, found: [url("n1", "2026-05-01"), url("o1", "2023-01-01"), url("o2", "2022-01-01")] });
    queue.more(Number.POSITIVE_INFINITY);
    await queue.settled();
    expect(fake.requested).toHaveLength(3); // older sets fetch fine once included
  });
});

describe("FetchQueue failures", () => {
  it("pauses on an ordinary failure and keeps the set, then retries it on resume", async () => {
    let failNext = true;
    const requested: string[] = [];
    const source: HtmlSource = {
      async fetchHtml(u) {
        requested.push(u);
        if (failNext) {
          failNext = false;
          throw new Error("socket hang up");
        }
        return pageHtml;
      },
    };
    const queue = new FetchQueue(store, source);
    queue.enqueue([url("f1"), url("f2")], "2025-01-01");
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "blocked", pauseReason: "failure", failed: 1, pendingFailures: 1, waiting: [url("f1"), url("f2")] });
    expect(queue.status().blocked).toMatch(/not a site block.*socket hang up/);

    queue.resume();
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 2, pendingFailures: 0 });
    expect(requested).toEqual([url("f1"), url("f1"), url("f2")]);
  });

  it("rejects a corrupt saved queue and drops entries that aren't tracklist URLs", () => {
    const saveFile = join(dir, "queue.json");
    writeFileSync(saveFile, JSON.stringify({ not: "a list" }));
    expect(() => new FetchQueue(store, fakeSource().source, { saveFile })).toThrow(/Invalid saved queue/);

    // Older saves were a plain list; they come back waiting (newest first), paused until you say so.
    writeFileSync(saveFile, JSON.stringify([url("ok1", "2026-01-01"), url("ok1", "2026-01-01"), 42, "https://evil.example/tracklist/x/y.html", url("ok2", "2026-05-05")]));
    const status = new FetchQueue(store, fakeSource().source, { saveFile }).status();
    expect(status).toMatchObject({ state: "blocked", pauseReason: "restart", waiting: [url("ok2", "2026-05-05"), url("ok1", "2026-01-01")], found: [] });
  });
});

describe("FetchQueue persistence", () => {
  it("restores waiting sets after a restart, paused until you resume", async () => {
    const saveFile = join(dir, "queue.json");
    const fake = fakeSource();
    fake.blockOnce();
    const first = new FetchQueue(store, fake.source, { saveFile });
    first.enqueue([url("p1"), url("p2")], "2025-01-01");
    await first.settled(); // blocked on p1

    const restarted = new FetchQueue(store, fake.source, { saveFile });
    expect(restarted.status()).toMatchObject({ state: "blocked", pauseReason: "restart", waiting: [url("p1"), url("p2")] });
    expect(fake.requested).toHaveLength(1); // the restart itself sent nothing

    restarted.resume();
    await restarted.settled();
    expect(restarted.status()).toMatchObject({ state: "idle", waiting: [] });
    expect(new FetchQueue(store, fake.source, { saveFile }).status().state).toBe("idle");
  });
});

describe("FetchQueue.importPage", () => {
  it("takes a set you opened yourself off the waiting list, and unblocks when the list empties", async () => {
    const fake = fakeSource();
    fake.blockOnce();
    const queue = new FetchQueue(store, fake.source);
    // The fixture page's own URL (og:url) has id zz9fix1.
    queue.enqueue([url("zz9fix1")], "2025-01-01");
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "blocked", waiting: [url("zz9fix1")] });

    const set = queue.importPage(pageHtml, "https://www.1001tracklists.com/tracklist/zz9fix1/x.html");
    expect(set.tracks).toHaveLength(6);
    expect(store.has("zz9fix1")).toBe(true);
    expect(queue.status()).toMatchObject({ state: "idle", done: 1, waiting: [] });
  });

  it("rejects a page with no tracks", () => {
    const queue = new FetchQueue(store, fakeSource().source);
    const empty = '<meta property="og:url" content="https://www.1001tracklists.com/tracklist/e1/x-2026-01-01.html"><h1 id="pageTitle">x 2026-01-01</h1>';
    expect(() => queue.importPage(empty, "https://www.1001tracklists.com/tracklist/e1/x.html")).toThrow(/No tracks/);
  });
});

describe("server", () => {
  let server: Server;
  let base: string;
  let queue: FetchQueue;

  beforeEach(async () => {
    queue = new FetchQueue(store, fakeSource().source);
    server = createApp(store, queue);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const capture = (urls: unknown, headers: Record<string, string> = { "X-Setscope": "1" }) =>
    fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ pageUrl: "https://www.1001tracklists.com/track/x/index.html", urls }),
    });

  it("serves the page and the browser script with types stripped", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>setscope</title>");
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).not.toMatch(/^import type/m);
    expect(js).toContain("function showRoute");
  });

  it("queues captured links, ignoring anything that isn't a tracklist", async () => {
    const res = await capture([url("c1"), "https://evil.example/tracklist/x/y.html", "/dj/x/index.html", 42]);
    expect(await res.json()).toEqual({ found: 1, queued: 1, fetchingNow: 1, alreadyCached: 0, skippedOld: 0 });
    await queue.settled();
    expect(store.has("c1")).toBe(true);
  });

  it("rejects captures without the X-Setscope header", async () => {
    const res = await capture([url("c1")], {});
    expect(res.status).toBe(400);
    expect(store.has("c1")).toBe(false);
  });

  it("answers song reports from the cache, and 400s on bad input", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const report = await (await fetch(`${base}/api/song?q=${encodeURIComponent("Nova - Pulse")}&months=24`)).json();
    expect(report).toMatchObject({ song: "Nova - Pulse", setsWithSong: 1 });

    const byTitle = await (await fetch(`${base}/api/song?q=pulse&months=24`)).json();
    expect(byTitle).toMatchObject({ setsWithSong: 1, matchedAs: [{ name: "Nova - Pulse" }], otherVersions: [] });

    const bad = await fetch(`${base}/api/song?q=%20`);
    expect(bad.status).toBe(400);
  });

  it("imports a whole set page sent by the extension", async () => {
    const post = (body: object) =>
      fetch(`${base}/api/capture-set`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Setscope": "1" },
        body: JSON.stringify(body),
      });
    const ok = await post({ pageUrl: "https://www.1001tracklists.com/tracklist/zz9fix1/x.html#tr_1", html: pageHtml });
    expect(await ok.json()).toMatchObject({ id: "zz9fix1", tracks: 6 });
    expect(store.has("zz9fix1")).toBe(true);

    const offSite = await post({ pageUrl: "https://evil.example/tracklist/zz/x.html", html: pageHtml });
    expect(offSite.status).toBe(400);
  });

  const postJson = (path: string, body: object, headers: Record<string, string> = { "X-Setscope": "1" }) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("fetches every captured set on its own, newest first, with no batches to ask for", async () => {
    const urls = Array.from({ length: 7 }, (_, i) => url(`m${i}`, `2026-0${i + 1}-01`));
    const res = await capture(urls);
    expect(await res.json()).toMatchObject({ found: 7, queued: 7, fetchingNow: 7 });
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 7, found: [], waiting: [] });
  });

  it("adds pasted links", async () => {
    const pasted = await postJson("/api/add-links", { text: `see ${url("p1")} and junk /dj/x/index.html` });
    expect(await pasted.json()).toMatchObject({ found: 1, queued: 1, fetchingNow: 1 });
    const nothing = await postJson("/api/add-links", { text: "no links here" });
    expect(nothing.status).toBe(400);
    expect((await postJson("/api/more", { count: 1 }, {})).status).toBe(400); // missing header
  });

  it("suggests cached songs and artists for the search dropdown", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const songs = await (await fetch(`${base}/api/suggest?mode=song&q=nova%20pul&months=24`)).json();
    expect(songs).toEqual([{ name: "Nova - Pulse", count: 1 }]);
    const artists = await (await fetch(`${base}/api/suggest?mode=artist&q=dj%20alp&months=24`)).json();
    expect(artists).toEqual([{ name: "DJ Alpha", count: 1 }]);
    expect(await (await fetch(`${base}/api/suggest?q=n`)).json()).toEqual([]);
  });

  it("auto-corrects a misspelled search that finds nothing, unless exact=1", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const fixed = await (await fetch(`${base}/api/song?q=${encodeURIComponent("Nova - Pulze")}&months=24`)).json();
    expect(fixed).toMatchObject({ correctedFrom: "Nova - Pulze", setsWithSong: 1, matchedAs: [{ name: "Nova - Pulse" }] });

    const exact = await (await fetch(`${base}/api/song?q=${encodeURIComponent("Nova - Pulze")}&months=24&exact=1`)).json();
    expect(exact).toMatchObject({ setsWithSong: 0 });
    expect(exact.correctedFrom).toBeUndefined();

    const artist = await (await fetch(`${base}/api/artist?name=${encodeURIComponent("roland clrak")}&months=24`)).json();
    expect(artist).toMatchObject({ artist: "Roland Clark", correctedFrom: "roland clrak" });
  });

  it("serves trending and clears the queue", async () => {
    const report = await (await fetch(`${base}/api/trending?days=14`)).json();
    expect(report).toMatchObject({ enoughData: false, songs: [], artists: [] });

    await capture(Array.from({ length: 7 }, (_, i) => url(`z${i}`)));
    const cleared = await (await postJson("/api/clear-queue", {})).json();
    expect(cleared).toEqual({ waiting: expect.any(Number), found: 0 });
    await queue.settled();
    expect(queue.status()).toMatchObject({ waiting: [], found: [] });
  });

  it("likes and categories show up on song pages, in for-you, and on category pages", async () => {
    await capture([url("c1")]);
    await queue.settled();
    expect((await postJson("/api/like", { song: "Nova - Pulse", liked: true })).status).toBe(200);
    expect((await postJson("/api/label", { song: "Nova - Pulse", category: "Party", on: true })).status).toBe(200);
    expect((await postJson("/api/label", { song: "no dash", category: "Party", on: true })).status).toBe(400);
    expect((await postJson("/api/like", { song: "Nova - Pulse", liked: true }, {})).status).toBe(400); // header

    const song = await (await fetch(`${base}/api/song?q=${encodeURIComponent("Nova - Pulse")}&months=24`)).json();
    expect(song).toMatchObject({ liked: true, categories: ["Party"], genre: "Tech House", sets: [{ id: "c1", soundcloud: "https://api.soundcloud.com/tracks/2423741796" }] });

    expect(await (await fetch(`${base}/api/me`)).json()).toEqual({ likes: ["Nova - Pulse"], categories: [{ name: "Party", songs: ["Nova - Pulse"] }] });
    const forYou = await (await fetch(`${base}/api/for-you?months=24`)).json();
    expect(forYou).toMatchObject({ likes: ["Nova - Pulse"], sets: [{ id: "c1", liked: ["Nova - Pulse"] }] });
    expect(await (await fetch(`${base}/api/category?name=party&months=24`)).json()).toMatchObject({ name: "Party", songs: ["Nova - Pulse"] });
    expect((await fetch(`${base}/api/category?name=nope`)).status).toBe(404);
  });

  it("reports no GetSongBPM key instead of failing", async () => {
    const info = await (await fetch(`${base}/api/song-info?song=${encodeURIComponent("Nova - Pulse")}`)).json();
    expect(info).toEqual({ status: "no-key" });
    expect((await fetch(`${base}/api/song-info?song=nodash`)).status).toBe(400);
  });

  it("includes older sets and controls background collecting", async () => {
    expect(await (await postJson("/api/include-older", {})).json()).toEqual({ moved: 0 });
    // This test app has no collector: the switch says so instead of pretending.
    expect((await postJson("/api/background", { enabled: true })).status).toBe(400);
    expect((await postJson("/api/background", { enabled: "yes" })).status).toBe(400);
  });

  it("artist reports carry a profile; the account page reports and saves the GetSongBPM key", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const artist = await (await fetch(`${base}/api/artist?name=dj%20alpha&months=24`)).json();
    expect(artist.profile).toMatchObject({ name: "DJ Alpha", country: "Netherlands", ownSets: [{ id: "c1" }] });

    expect(await (await fetch(`${base}/api/account`)).json()).toMatchObject({ sets: 1, getSongBpmKey: false });
    expect((await postJson("/api/account/getsongbpm-key", { key: "not a key!" })).status).toBe(400);
    expect(await (await postJson("/api/account/getsongbpm-key", { key: "abc123def456" })).json()).toEqual({ getSongBpmKey: true });
    expect(await (await fetch(`${base}/api/account`)).json()).toMatchObject({ getSongBpmKey: true });
  });

  it("reports cache size and queue progress", async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status).toMatchObject({ sets: 0, queue: { state: "idle", done: 0, total: 0 } });
  });
});
