import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockedError, type HtmlSource } from "../src/source/fetcher.ts";
import { FetchQueue } from "../src/source/queue.ts";
import { TracklistStore } from "../src/source/store.ts";
import type pg from "pg";
import { Accounts } from "../src/auth/accounts.ts";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { PgUserData } from "../src/personal/user-data.ts";
import { createApp } from "../src/server.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";

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
    const first = await queue.enqueue([url("a1"), url("a1"), url("old", "2019-01-01")], "2025-01-01");
    expect(first).toEqual({ queued: 1, fetchingNow: 1, alreadyCached: 0, skippedOld: 1 });
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 1, total: 1 });

    const second = await queue.enqueue([url("a1"), url("a2")], "2025-01-01");
    expect(second).toEqual({ queued: 1, fetchingNow: 1, alreadyCached: 1, skippedOld: 0 });
    await queue.settled();
    expect(fake.requested).toEqual([url("a1"), url("a2")]);
  });

  it("accepts new URLs while running and reports progress", async () => {
    const fake = fakeSource();
    fake.hold();
    const queue = new FetchQueue(store, fake.source, { delayMs: 8_000 });
    await queue.enqueue([url("a1"), url("a2")], "2025-01-01");
    await queue.enqueue([url("a2"), url("a3")], "2025-01-01"); // a2 already waiting
    expect(queue.status()).toMatchObject({ state: "running", done: 0, total: 3, etaSeconds: 24 });
    fake.letGo();
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 3, total: 3 });
  });

  it("pauses on a block, keeps the URL, and finishes on resume", async () => {
    const fake = fakeSource();
    fake.blockOnce();
    const queue = new FetchQueue(store, fake.source);
    await queue.enqueue([url("a1"), url("a2")], "2025-01-01");
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
    expect(await queue.enqueue(urls, "2025-01-01", 2)).toMatchObject({ queued: 3, fetchingNow: 2 });
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
    await queue.enqueue([url("c1", "2026-03-01"), url("c2", "2026-02-01"), url("c3", "2026-01-01")], "2025-01-01", 1);
    expect(queue.clearFound()).toBe(2);
    fake.letGo();
    await queue.settled();
    expect(queue.status()).toMatchObject({ found: [], done: 1 });
    expect(fake.requested).toEqual([url("c1", "2026-03-01")]);
  });

  it("does not re-add sets that are already found or fetching", async () => {
    const fake = fakeSource();
    fake.hold();
    const queue = new FetchQueue(store, fake.source);
    await queue.enqueue([url("d1", "2026-03-01"), url("d2", "2026-02-01")], "2025-01-01", 1);
    expect(await queue.enqueue([url("d1", "2026-03-01"), url("d2", "2026-02-01")], "2025-01-01", 1)).toMatchObject({ queued: 0 });
    fake.letGo();
  });
});

describe("FetchQueue clearing and pause reasons", () => {
  it("says why it paused, and clearing the queue unpauses it", async () => {
    const fake = fakeSource();
    fake.blockOnce();
    const queue = new FetchQueue(store, fake.source);
    await queue.enqueue([url("q1", "2026-03-01"), url("q2", "2026-02-01"), url("q3", "2026-01-01")], "2025-01-01", 2);
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
    const result = await queue.enqueue([url("n1", "2026-05-01"), url("o1", "2023-01-01"), url("o2", "2022-01-01")], "2025-01-01", 0);
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
    await queue.enqueue([url("f1"), url("f2")], "2025-01-01");
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
    await first.enqueue([url("p1"), url("p2")], "2025-01-01");
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
    await queue.enqueue([url("zz9fix1")], "2025-01-01");
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "blocked", waiting: [url("zz9fix1")] });

    const set = await queue.importPage(pageHtml, "https://www.1001tracklists.com/tracklist/zz9fix1/x.html");
    expect(set.tracks).toHaveLength(6);
    expect(await store.has("zz9fix1")).toBe(true);
    expect(queue.status()).toMatchObject({ state: "idle", done: 1, waiting: [] });
  });

  it("rejects a page with no tracks", async () => {
    const queue = new FetchQueue(store, fakeSource().source);
    const empty = '<meta property="og:url" content="https://www.1001tracklists.com/tracklist/e1/x-2026-01-01.html"><h1 id="pageTitle">x 2026-01-01</h1>';
    await expect(queue.importPage(empty, "https://www.1001tracklists.com/tracklist/e1/x.html")).rejects.toThrow(/No tracks/);
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)("server", () => {
  let server: Server;
  let base: string;
  let queue: FetchQueue;
  let pool: pg.Pool;
  let store: PgCatalog;
  let filesDir: string;

  beforeEach(async () => {
    pool = await freshSchema("web_server");
    store = new PgCatalog(pool);
    queue = new FetchQueue(store, fakeSource().source);
    filesDir = mkdtempSync(join(tmpdir(), "setscope-server-"));
    writeFileSync(join(filesDir, "user.json"), JSON.stringify({ likes: { "nova - pulse": "Nova - Pulse" }, categories: {} }));
    server = createApp(store, queue, new Accounts(pool, "invite"), new PgUserData(pool), {
      keyFile: join(filesDir, "key"),
      legacyUserFile: join(filesDir, "user.json"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    rmSync(filesDir, { recursive: true, force: true });
  });

  const capture = (urls: unknown, headers: Record<string, string> = { "X-Setscope": "1" }) =>
    fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ pageUrl: "https://www.1001tracklists.com/track/x/index.html", urls }),
    });
  const postJson = (path: string, body: object, headers: Record<string, string> = { "X-Setscope": "1" }) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  /** POST as a signed-in user. */
  const postAs = (cookie: string, path: string, body: object) => postJson(path, body, { "X-Setscope": "1", cookie });
  const getAs = (cookie: string | undefined, path: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  /** Sign up and return the session cookie. The first account is the owner. */
  const signUp = async (email = "owner@example.com", inviteCode?: string) => {
    const res = await postJson("/api/auth/register", { email, password: "a long password", displayName: email.split("@")[0], inviteCode });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };

  it("serves the page and the browser script with types stripped", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>setscope</title>");
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).not.toMatch(/^import type/m);
    expect(js).toContain("function showRoute");
  });

  it("signs up the owner (importing old likes), keeps them signed in, and signs out", async () => {
    await capture([url("c1")]);
    await queue.settled();
    expect(await (await fetch(`${base}/api/auth/me`)).json()).toEqual({ user: null, signup: "open" });
    const res = await postJson("/api/auth/register", { email: "Owner@Example.com", password: "a long password", displayName: "Owner" });
    expect(await res.json()).toMatchObject({ user: { email: "owner@example.com" }, imported: { imported: 1, skipped: 0 } });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^setscope_session=[\w-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);
    const cookie = setCookie.split(";")[0]!;
    expect(await (await getAs(cookie, "/api/auth/me")).json()).toMatchObject({ user: { displayName: "Owner", owner: true }, signup: "invite" });
    expect(await (await getAs(cookie, "/api/me")).json()).toEqual({ likes: ["Nova - Pulse"], categories: [] });

    const login = await postJson("/api/auth/login", { email: "owner@example.com", password: "wrong password" });
    expect(login.status).toBe(400);
    expect(await login.json()).toEqual({ error: "Wrong email or password." });

    await postAs(cookie, "/api/auth/logout", {});
    expect(await (await getAs(cookie, "/api/auth/me")).json()).toMatchObject({ user: null });
  });

  it("queues captured links from the extension, ignoring anything that isn't a tracklist", async () => {
    const res = await capture([url("c1"), "https://evil.example/tracklist/x/y.html", "/dj/x/index.html", 42]);
    expect(await res.json()).toEqual({ found: 1, queued: 1, fetchingNow: 1, alreadyCached: 0, skippedOld: 0 });
    await queue.settled();
    expect(await store.has("c1")).toBe(true);
  });

  it("rejects captures without the X-Setscope header", async () => {
    const res = await capture([url("c1")], {});
    expect(res.status).toBe(400);
    expect(await store.has("c1")).toBe(false);
  });

  it("answers song reports from the shared catalog to anyone, and 400s on bad input", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const report = await (await fetch(`${base}/api/song?q=${encodeURIComponent("Nova - Pulse")}&months=24`)).json();
    expect(report).toMatchObject({ song: "Nova - Pulse", setsWithSong: 1 });
    expect(report.liked).toBeUndefined(); // signed out: no personal fields

    const byTitle = await (await fetch(`${base}/api/song?q=pulse&months=24`)).json();
    expect(byTitle).toMatchObject({ setsWithSong: 1, matchedAs: [{ name: "Nova - Pulse" }], otherVersions: [] });

    const bad = await fetch(`${base}/api/song?q=%20`);
    expect(bad.status).toBe(400);
  });

  it("imports a whole set page sent by the extension", async () => {
    const ok = await postJson("/api/capture-set", { pageUrl: "https://www.1001tracklists.com/tracklist/zz9fix1/x.html#tr_1", html: pageHtml });
    expect(await ok.json()).toMatchObject({ id: "zz9fix1", tracks: 6 });
    expect(await store.has("zz9fix1")).toBe(true);

    const offSite = await postJson("/api/capture-set", { pageUrl: "https://evil.example/tracklist/zz/x.html", html: pageHtml });
    expect(offSite.status).toBe(400);
  });

  it("fetches every captured set on its own, newest first, with no batches to ask for", async () => {
    const urls = Array.from({ length: 7 }, (_, i) => url(`m${i}`, `2026-0${i + 1}-01`));
    const res = await capture(urls);
    expect(await res.json()).toMatchObject({ found: 7, queued: 7, fetchingNow: 7 });
    await queue.settled();
    expect(queue.status()).toMatchObject({ state: "idle", done: 7, found: [], waiting: [] });
  });

  it("adds pasted links for signed-in users only", async () => {
    expect((await postJson("/api/add-links", { text: url("p1") })).status).toBe(401);
    const cookie = await signUp();
    const pasted = await postAs(cookie, "/api/add-links", { text: `see ${url("p1")} and junk /dj/x/index.html` });
    expect(await pasted.json()).toMatchObject({ found: 1, queued: 1, fetchingNow: 1 });
    expect((await postAs(cookie, "/api/add-links", { text: "no links here" })).status).toBe(400);
    expect((await postJson("/api/more", { count: 1 }, { cookie })).status).toBe(400); // missing header
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

    const cookie = await signUp();
    await capture(Array.from({ length: 7 }, (_, i) => url(`z${i}`)));
    const cleared = await (await postAs(cookie, "/api/clear-queue", {})).json();
    expect(cleared).toEqual({ waiting: expect.any(Number), found: 0 });
    await queue.settled();
    expect(queue.status()).toMatchObject({ waiting: [], found: [] });
  });

  it("keeps likes and categories per account: on song pages, in for-you, and on category pages", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const owner = await signUp();
    const friend = await signUp("friend@example.com", "invite");
    expect((await postJson("/api/like", { song: "Nova - Pulse", liked: true })).status).toBe(401);
    expect((await postAs(friend, "/api/like", { song: "Nova - Pulse", liked: true })).status).toBe(200);
    expect((await postAs(friend, "/api/label", { song: "Nova - Pulse", category: "Party", on: true })).status).toBe(200);
    expect((await postAs(friend, "/api/label", { song: "no dash", category: "Party", on: true })).status).toBe(400);
    expect((await postJson("/api/like", { song: "Nova - Pulse", liked: true }, { cookie: friend })).status).toBe(400); // header

    const song = await (await getAs(friend, `/api/song?q=${encodeURIComponent("Nova - Pulse")}&months=24`)).json();
    expect(song).toMatchObject({ liked: true, categories: ["Party"], genre: "Tech House", sets: [{ id: "c1", soundcloud: "https://api.soundcloud.com/tracks/2423741796" }] });

    expect(await (await getAs(friend, "/api/me")).json()).toEqual({ likes: ["Nova - Pulse"], categories: [{ name: "Party", songs: ["Nova - Pulse"] }] });
    // The owner's likes came from the old file; the friend's Party category isn't theirs.
    expect(await (await getAs(owner, "/api/me")).json()).toEqual({ likes: ["Nova - Pulse"], categories: [] });
    const forYou = await (await getAs(friend, "/api/for-you?months=24")).json();
    expect(forYou).toMatchObject({ likes: ["Nova - Pulse"], sets: [{ id: "c1", liked: ["Nova - Pulse"] }] });
    expect(await (await getAs(friend, "/api/category?name=party&months=24")).json()).toMatchObject({ name: "Party", songs: ["Nova - Pulse"] });
    expect((await getAs(owner, "/api/category?name=party")).status).toBe(404);
  });

  it("reports no GetSongBPM key instead of failing", async () => {
    const info = await (await fetch(`${base}/api/song-info?song=${encodeURIComponent("Nova - Pulse")}`)).json();
    expect(info).toEqual({ status: "no-key" });
    expect((await fetch(`${base}/api/song-info?song=nodash`)).status).toBe(400);
  });

  it("includes older sets; background collecting is the owner's switch", async () => {
    const owner = await signUp();
    const friend = await signUp("friend@example.com", "invite");
    expect(await (await postAs(owner, "/api/include-older", {})).json()).toEqual({ moved: 0 });
    expect((await postAs(friend, "/api/background", { enabled: true })).status).toBe(403);
    // This test app has no collector: the switch says so instead of pretending.
    expect((await postAs(owner, "/api/background", { enabled: true })).status).toBe(400);
    expect((await postAs(owner, "/api/background", { enabled: "yes" })).status).toBe(400);
  });

  it("artist reports carry a profile; only the owner can set the GetSongBPM key", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const artist = await (await fetch(`${base}/api/artist?name=dj%20alpha&months=24`)).json();
    expect(artist.profile).toMatchObject({ name: "DJ Alpha", country: "Netherlands", ownSets: [{ id: "c1" }] });

    expect((await fetch(`${base}/api/account`)).status).toBe(401);
    const owner = await signUp();
    const friend = await signUp("friend@example.com", "invite");
    expect(await (await getAs(owner, "/api/account")).json()).toMatchObject({ sets: 1, getSongBpmKey: false, user: { owner: true } });
    expect((await postAs(friend, "/api/account/getsongbpm-key", { key: "abc123def456" })).status).toBe(403);
    expect((await postAs(owner, "/api/account/getsongbpm-key", { key: "not a key!" })).status).toBe(400);
    expect(await (await postAs(owner, "/api/account/getsongbpm-key", { key: "abc123def456" })).json()).toEqual({ getSongBpmKey: true });
    expect(await (await getAs(friend, "/api/account")).json()).toMatchObject({ getSongBpmKey: true, user: { owner: false } });
    expect(readFileSync(join(filesDir, "key"), "utf8")).toBe("abc123def456\n");
  });

  it("reports cache size and queue progress", async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status).toMatchObject({ sets: 0, queue: { state: "idle", done: 0, total: 0 } });
  });
});
