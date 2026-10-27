// The SoundCloud endpoints, with a fake SoundCloud. Every upload and profile here is
// made up for the tests (TEST FIXTURE, not real SoundCloud data).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "../src/auth/accounts.ts";
import { RateLimiter } from "../src/auth/rate-limit.ts";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { PgJobQueue } from "../src/collect/jobs.ts";
import { PgUserData } from "../src/personal/user-data.ts";
import { createApp } from "../src/server.ts";
import { SoundCloudClient } from "../src/soundcloud/client.ts";
import { parseTracklist } from "../src/source/parse.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";

const pageHtml = readFileSync(join(import.meta.dirname, "fixtures/tracklist-page.html"), "utf8");
const setUrl = "https://www.1001tracklists.com/tracklist/sc1/set-2026-09-10.html";

const upload = (id: number, title: string, uploader: string, genre = "House") => ({
  kind: "track",
  urn: `soundcloud:tracks:${id}`,
  title,
  user: { username: uploader, permalink_url: `https://soundcloud.com/${uploader.toLowerCase().replace(/\W/g, "")}` },
  permalink_url: `https://soundcloud.com/test/track-${id}`,
  genre,
  duration: 200_000,
  playback_count: id * 100,
  access: "playable",
  embeddable_by: "all",
});

const UPLOADS = [
  { ...upload(1, "Nova - Pulse", "Label"), bpm: 127.9, key_signature: "Gb:min" },
  upload(2, "Nova - Pulse (Reed Remix)", "Reed", "Techno"),
  upload(3, "Pulse (Mara Edit)", "Mara", ""),
  upload(4, "Something Else", "Nobody"),
];

function fakeSoundCloud() {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "secure.soundcloud.com") return json({ access_token: "t", expires_in: 3600 });
    if (url.pathname === "/tracks") return json({ collection: UPLOADS, next_href: "https://api.soundcloud.com/tracks?page=2" });
    if (url.pathname === "/resolve") {
      const target = url.searchParams.get("url")!;
      if (target === "https://soundcloud.com/test-curator") return json({ kind: "user", urn: "soundcloud:users:5", username: "Test Curator", permalink_url: target });
      const found = UPLOADS.find((u) => u.permalink_url === target);
      return found ? json(found) : json({}, 404);
    }
    if (url.pathname.endsWith("/likes/tracks")) return json({ collection: [UPLOADS[1]], next_href: null });
    if (url.pathname.startsWith("/tracks/")) {
      const found = UPLOADS.find((u) => u.urn === decodeURIComponent(url.pathname.slice("/tracks/".length)));
      return found ? json(found) : json({}, 404);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, requests };
}

const available = await databaseAvailable();

describe.skipIf(!available)("SoundCloud endpoints", () => {
  let server: Server;
  let base: string;
  let pool: pg.Pool;
  let queue: PgJobQueue;
  let dir: string;
  let sc: ReturnType<typeof fakeSoundCloud>;

  beforeEach(async () => {
    pool = await freshSchema("web_soundcloud");
    const catalog = new PgCatalog(pool);
    queue = new PgJobQueue(pool, catalog, { fetchHtml: async () => pageHtml }, { schedule: () => {} });
    await catalog.save(parseTracklist(pageHtml, setUrl), pageHtml);
    dir = mkdtempSync(join(tmpdir(), "setscope-sc-web-"));
    sc = fakeSoundCloud();
    server = createApp({ pool, catalog, queue, accounts: new Accounts(pool, "invite"), userData: new PgUserData(pool) }, {
      soundcloud: new SoundCloudClient({ fetchFn: sc.fetchFn }),
      soundcloudFile: join(dir, "soundcloud.json"),
      likesLimit: new RateLimiter(2, 60_000),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await queue.settled();
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (cookie: string | undefined, path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Setscope": "1", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const get = (cookie: string | undefined, path: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  const signUp = async (email: string, inviteCode?: string) => {
    const res = await post(undefined, "/api/auth/register", { email, password: "a long password", displayName: email.split("@")[0], inviteCode });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  const connect = async (cookie: string) => expect((await post(cookie, "/api/account/soundcloud", { clientId: "test-client-id", clientSecret: "test-client-secret" })).status).toBe(200);
  const song = encodeURIComponent("Nova - Pulse");

  it("is off until the owner adds credentials, and only the owner can", async () => {
    const owner = await signUp("owner@example.com");
    const friend = await signUp("friend@example.com", "invite");
    expect(await (await get(owner, "/api/account")).json()).toMatchObject({ soundcloud: false });
    expect((await get(owner, `/api/soundcloud/candidates?song=${song}`)).status).toBe(400);
    expect(sc.requests).toEqual([]);
    expect((await post(friend, "/api/account/soundcloud", { clientId: "test-client-id", clientSecret: "test-client-secret" })).status).toBe(403);
    expect((await post(owner, "/api/account/soundcloud", { clientId: "test-client-id", clientSecret: "" })).status).toBe(400);
    await connect(owner);
    const account = await (await get(owner, "/api/account")).text();
    expect(JSON.parse(account)).toMatchObject({ soundcloud: true });
    expect(account).not.toContain("test-client-secret");
    expect(JSON.parse(readFileSync(join(dir, "soundcloud.json"), "utf8"))).toEqual({ clientId: "test-client-id", clientSecret: "test-client-secret" });
  });

  it("finds candidates for a song, and a confirmed one becomes the song's link", async () => {
    const owner = await signUp("owner@example.com");
    await connect(owner);
    expect((await get(undefined, `/api/soundcloud/candidates?song=${song}`)).status).toBe(401);
    const { candidates } = await (await get(owner, `/api/soundcloud/candidates?song=${song}`)).json();
    expect(candidates.map((c: { title: string; kind: string }) => [c.title, c.kind])).toEqual([
      ["Nova - Pulse", "this"],
      ["Nova - Pulse (Reed Remix)", "version"],
      ["Pulse (Mara Edit)", "version"],
    ]);

    expect(await (await get(undefined, `/api/song-links?song=${song}`)).json()).toEqual({ links: [], soundcloud: true });
    const res = await post(owner, "/api/song-links", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-1", from: "search" });
    expect(res.status).toBe(200);
    const { links } = await (await get(undefined, `/api/song-links?song=${song}`)).json();
    expect(links).toEqual([expect.objectContaining({ url: "https://soundcloud.com/test/track-1", externalId: "soundcloud:tracks:1", provenance: "search_match", confidence: expect.closeTo(0.9, 5), addedBy: "owner" })]);

    // Not SoundCloud, or a link SoundCloud doesn't know: refused.
    expect((await post(owner, "/api/song-links", { song: "Nova - Pulse", url: "https://example.com/a/b", from: "pasted" })).status).toBe(400);
    expect((await post(owner, "/api/song-links", { song: "Nova - Pulse", url: "https://soundcloud.com/test/missing", from: "pasted" })).status).toBe(400);
  });

  it("plays any song: its link, or its best SoundCloud match, remembered as automatic", async () => {
    const owner = await signUp("owner@example.com");
    expect(await (await get(undefined, `/api/play?song=${song}`)).json()).toEqual({ error: expect.stringMatching(/Connect SoundCloud/) });
    await connect(owner);
    const searches = () => sc.requests.filter((p) => p === "/tracks").length;
    expect(await (await get(undefined, `/api/play?song=${song}`)).json()).toEqual({ url: "https://soundcloud.com/test/track-1", auto: true, confidence: 0.9, preview: false });
    expect(await (await get(undefined, `/api/play?song=${song}`)).json()).toMatchObject({ url: "https://soundcloud.com/test/track-1", auto: true });
    expect(searches()).toBe(1); // the match is remembered, not searched again
    const { links } = await (await get(owner, `/api/song-links?song=${song}`)).json();
    expect(links).toEqual([expect.objectContaining({ url: "https://soundcloud.com/test/track-1", auto: true, addedBy: null, removable: true })]);

    // A confirmed link wins over the automatic match.
    await post(owner, "/api/song-links", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-2", from: "pasted" });
    expect(await (await get(undefined, `/api/play?song=${song}`)).json()).toMatchObject({ url: "https://soundcloud.com/test/track-2", auto: false });

    // Anyone signed in can throw out a wrong automatic match.
    const friend = await signUp("friend@example.com", "invite");
    expect((await post(friend, "/api/song-links/remove", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-1" })).status).toBe(200);
    expect((await post(friend, "/api/song-links/remove", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-2" })).status).toBe(403);
  });

  it("says when there's nothing to play, and doesn't keep searching for it", async () => {
    const owner = await signUp("owner@example.com");
    await connect(owner);
    const other = encodeURIComponent("Roland Clark & Amy Alexander - Feel It");
    const first = await get(undefined, `/api/play?song=${other}`);
    expect(first.status).toBe(404);
    expect((await first.json()).error).toMatch(/Couldn't find a playable upload/);
    const before = sc.requests.length;
    expect((await get(undefined, `/api/play?song=${other}`)).status).toBe(404);
    expect(sc.requests.length).toBe(before);
    expect((await get(undefined, "/api/play?song=Nobody%20-%20Nothing")).status).toBe(400);
  });

  it("gets key and BPM from the song's SoundCloud upload", async () => {
    const owner = await signUp("owner@example.com");
    expect(await (await get(undefined, `/api/song-info?song=${song}`)).json()).toEqual({ status: "no-key" }); // not connected, no GetSongBPM key
    await connect(owner);
    expect(await (await get(undefined, `/api/song-info?song=${song}`)).json()).toEqual({
      status: "ok",
      info: { found: true, source: "soundcloud", url: "https://soundcloud.com/test/track-1", bpm: 128, key: "F#m", openKey: "11A", fetchedAt: expect.any(String) },
    });
    // A song whose upload lists neither: said plainly, no request for a GetSongBPM key.
    const other = encodeURIComponent("Roland Clark & Amy Alexander - Feel It");
    expect(await (await get(undefined, `/api/song-info?song=${other}`)).json()).toMatchObject({ status: "not-found", info: { source: "soundcloud" } });
  });

  it("lets only whoever added a link, or the owner, remove it", async () => {
    const owner = await signUp("owner@example.com");
    const friend = await signUp("friend@example.com", "invite");
    const other = await signUp("other@example.com", "invite");
    await connect(owner);
    await post(friend, "/api/song-links", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-1", from: "pasted" });
    expect((await (await get(friend, `/api/song-links?song=${song}`)).json()).links[0]).toMatchObject({ removable: true, provenance: "user", confidence: 1 });
    expect((await (await get(other, `/api/song-links?song=${song}`)).json()).links[0]).toMatchObject({ removable: false });
    expect((await post(other, "/api/song-links/remove", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-1" })).status).toBe(403);
    expect((await post(owner, "/api/song-links/remove", { song: "Nova - Pulse", url: "https://soundcloud.com/test/track-1" })).status).toBe(200);
    expect((await (await get(undefined, `/api/song-links?song=${song}`)).json()).links).toEqual([]);
  });

  it("searches remixes with genre and remixer filters, and pages on", async () => {
    const owner = await signUp("owner@example.com");
    await connect(owner);
    const all = await (await get(owner, `/api/soundcloud/remixes?song=${song}`)).json();
    expect(all.remixes.map((r: { versionArtists: string }) => r.versionArtists)).toEqual(["Reed", "Mara"]);
    expect(all.next).toBe("https://api.soundcloud.com/tracks?page=2");
    const unknown = await (await get(owner, `/api/soundcloud/remixes?song=${song}&genres=Unknown`)).json();
    expect(unknown.remixes.map((r: { versionArtists: string }) => r.versionArtists)).toEqual(["Mara"]);
    const byReed = await (await get(owner, `/api/soundcloud/remixes?song=${song}&remixer=reed`)).json();
    expect(byReed.remixes).toHaveLength(1);
    expect((await get(owner, `/api/soundcloud/remixes?song=${song}&cursor=${encodeURIComponent("https://evil.example/x")}`)).status).toBe(400);
  });

  it("shows a curator's public likes, within the daily allowance", async () => {
    const owner = await signUp("owner@example.com");
    await connect(owner);
    const res = await (await get(owner, "/api/soundcloud/likes?profile=test-curator")).json();
    expect(res).toMatchObject({ user: { username: "Test Curator" }, tracks: [{ title: "Nova - Pulse (Reed Remix)" }], next: null });
    await get(owner, "/api/soundcloud/likes?profile=test-curator");
    expect((await get(owner, "/api/soundcloud/likes?profile=test-curator")).status).toBe(429);
  });

  it("saves SoundCloud uploads into categories, with SoundCloud's own title", async () => {
    const owner = await signUp("owner@example.com");
    await connect(owner);
    expect((await post(owner, "/api/saved-link", { category: "Party", url: "https://soundcloud.com/test/track-2", on: true })).status).toBe(200);
    expect(await (await get(owner, "/api/me")).json()).toMatchObject({ categories: [{ name: "Party", songs: [] }] });
    const party = await (await get(owner, "/api/category?name=party")).json();
    expect(party.links).toEqual([expect.objectContaining({ url: "https://soundcloud.com/test/track-2", title: "Nova - Pulse (Reed Remix)", artist: "Reed" })]);
    expect((await post(owner, "/api/saved-link", { category: "Party", url: "https://soundcloud.com/test/track-2", on: false })).status).toBe(200);
    expect((await (await get(owner, "/api/playlist?name=party")).json()).links).toEqual([]);
  });
});
