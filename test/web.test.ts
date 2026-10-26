import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockedError, type HtmlSource } from "../src/source/fetcher.ts";
import { RateLimiter } from "../src/auth/rate-limit.ts";
import { PgJobQueue } from "../src/collect/jobs.ts";
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

const available = await databaseAvailable();

describe.skipIf(!available)("server", () => {
  let server: Server;
  let base: string;
  let queue: PgJobQueue;
  let pool: pg.Pool;
  let store: PgCatalog;
  let filesDir: string;

  beforeEach(async () => {
    pool = await freshSchema("web_server");
    store = new PgCatalog(pool);
    queue = new PgJobQueue(pool, store, fakeSource().source, { schedule: () => {} });
    filesDir = mkdtempSync(join(tmpdir(), "setscope-server-"));
    writeFileSync(join(filesDir, "user.json"), JSON.stringify({ likes: { "nova - pulse": "Nova - Pulse" }, categories: {} }));
    server = createApp({ pool, catalog: store, queue, accounts: new Accounts(pool, "invite"), userData: new PgUserData(pool) }, {
      captureLimit: new RateLimiter(12, 60_000),
      keyFile: join(filesDir, "key"),
      legacyUserFile: join(filesDir, "user.json"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await queue.settled();
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
    const player = await fetch(`${base}/player.ts`);
    expect(player.headers.get("content-type")).toMatch(/javascript/);
    const playerJs = await player.text();
    expect(playerJs).toContain("class PlayerCore");
    expect(playerJs).not.toMatch(/^\s*interface /m);
  });

  it("serves charts, sets, set pages and search for the browse pages", async () => {
    await capture([url("c1")]);
    await queue.settled();
    const songs = await (await fetch(`${base}/api/charts/songs?period=all`)).json();
    expect(songs).toMatchObject({ page: 1, pages: 1 });
    expect(songs.items[0]).toMatchObject({ rank: 1, sets: 1 });
    expect((await fetch(`${base}/api/charts/songs?period=decade`)).status).toBe(400);
    expect((await fetch(`${base}/api/charts/songs?page=0`)).status).toBe(400);
    const artists = await (await fetch(`${base}/api/charts/artists?period=all&size=2`)).json();
    expect(artists).toMatchObject({ pageSize: 2 });
    const sets = await (await fetch(`${base}/api/sets`)).json();
    expect(sets.items).toEqual([expect.objectContaining({ id: "c1", event: "Fixture Radio 101", djs: [{ name: "DJ Alpha", image: "https://i1.sndcdn.com/avatars-alpha.jpg" }, { name: "DJ Beta", image: null }], tracks: 6, ids: 3 })]);
    const set = await (await fetch(`${base}/api/set?id=c1`)).json();
    expect(set.lines[0]).toMatchObject({ position: 0, song: "Nova - Pulse", isId: false });
    expect((await fetch(`${base}/api/set?id=nope`)).status).toBe(404);
    const found = await (await fetch(`${base}/api/search?q=nova&months=24`)).json();
    expect(found.songs[0]).toMatchObject({ name: "Nova - Pulse" });
    expect(found.artists[0]).toMatchObject({ name: "Nova" });
    expect(await (await fetch(`${base}/api/vault-preview`)).json()).toEqual({ lines: expect.any(Number), sets: expect.any(Number) });
  });

  it("signs up the owner (importing old likes), keeps them signed in, and signs out", async () => {
    await capture([url("c1")]);
    await queue.settled();
    expect(await (await fetch(`${base}/api/auth/me`)).json()).toEqual({ user: null, signup: "open", soundcloud: false, extensionVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
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
    expect(await res.json()).toMatchObject({ found: 1, queued: 1, fetchingNow: 1, alreadyCached: 0, skippedOld: 0, discovery: { setsSeen: 1 } });
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
    expect(await queue.status()).toMatchObject({ state: "idle", done: 7, found: [], waiting: [] });
  });

  it("adds pasted links for signed-in users only", async () => {
    expect((await postJson("/api/add-links", { text: url("p1") })).status).toBe(401);
    const cookie = await signUp();
    const pasted = await postAs(cookie, "/api/add-links", { text: `see ${url("p1")} and junk /dj/x/index.html` });
    expect(await pasted.json()).toMatchObject({ found: 1, queued: 1, fetchingNow: 1 });
    expect((await postAs(cookie, "/api/add-links", { text: "no links here" })).status).toBe(400);
    expect((await postJson("/api/clear-queue", {}, { cookie })).status).toBe(400); // missing header
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
    expect(await queue.status()).toMatchObject({ waiting: [], found: [] });
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

  it("remembers how far gathering got on a DJ page, and shows it on the artist", async () => {
    await capture([url("c1")]); // DJ Alpha's set, so the artist and their page exist
    await queue.settled();
    const res = await fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setscope": "1" },
      body: JSON.stringify({
        pageUrl: "https://www.1001tracklists.com/artist/dj-alpha/tracklists.html#more",
        urls: [url("c1"), url("c2", "2026-09-20"), url("c3", "2023-01-01")],
        complete: true,
      }),
    });
    // A page you opened yourself: older sets are queued too, not set aside.
    expect(await res.json()).toMatchObject({
      found: 3,
      queued: 2,
      alreadyCached: 1,
      skippedOld: 0,
      discovery: { pageUrl: "https://www.1001tracklists.com/artist/dj-alpha/tracklists.html", setsSeen: 3, setsIndexed: 1, setsNew: 2, setsOlder: 0, complete: true },
    });
    await queue.settled();
    const artist = await (await fetch(`${base}/api/artist?name=dj%20alpha&months=24`)).json();
    expect(artist.discovery).toMatchObject({ setsSeen: 3, complete: true });
  });

  it("never limits pages you open yourself, but slows down floods of pasted links", async () => {
    for (let i = 0; i < 20; i++) expect((await capture([])).status).toBe(200);
    const owner = await signUp();
    for (let i = 0; i < 12; i++) expect((await postAs(owner, "/api/add-links", { text: url(`f${i}`) })).status).toBe(200);
    const res = await postAs(owner, "/api/add-links", { text: url("f99") });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Wait a few minutes/);
  });

  it("retries failed sets and refreshes a set on request", async () => {
    const owner = await signUp();
    expect(await (await postAs(owner, "/api/retry-failed", {})).json()).toEqual({ retried: 0 });
    expect((await postAs(owner, "/api/refresh-set", { url: "https://evil.example/x" })).status).toBe(400);
    expect(await (await postAs(owner, "/api/refresh-set", { url: url("c1") })).json()).toEqual({ queued: 1 });
    expect((await postJson("/api/refresh-set", { url: url("c1") })).status).toBe(401);
  });

  it("reports cache size and queue progress", async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status).toMatchObject({ sets: 0, queue: { state: "idle", done: 0, total: 0 } });
  });
});
