// The SoundCloud client against a fake fetch. Every track and user below is made up for
// the tests (TEST FIXTURE, not real SoundCloud data).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScError, ScRateLimited, SoundCloudClient } from "../src/soundcloud/client.ts";

const fakeTrack = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  kind: "track",
  urn: `soundcloud:tracks:${id}`,
  title,
  user: { username: "Test Uploader", permalink_url: "https://soundcloud.com/test-uploader" },
  permalink_url: `https://soundcloud.com/test-uploader/track-${id}`,
  genre: "House",
  tag_list: 'remix "tech house"',
  duration: 200_000,
  playback_count: 1234,
  favoritings_count: 56,
  access: "playable",
  embeddable_by: "all",
  ...extra,
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const tokenResponse = (n = 1) => json({ access_token: `token-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 });

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "setscope-sc-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SoundCloudClient", () => {
  it("says it isn't connected without credentials, and makes no requests", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const client = new SoundCloudClient({ fetchFn: fn });
    expect(client.configured()).toBe(false);
    await expect(client.searchTracks({ q: "x" })).rejects.toThrow(/isn't connected/);
    expect(calls).toHaveLength(0);
  });

  it("gets one token, reuses it, and sends it as an OAuth header", async () => {
    let tokens = 0;
    const { fn, calls } = fakeFetch((url) => {
      if (url.hostname === "secure.soundcloud.com") return tokenResponse(++tokens);
      return json({ collection: [fakeTrack(1, "Song (Someone Remix)")], next_href: null });
    });
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "secret", fetchFn: fn });
    await client.searchTracks({ q: "song remix" });
    await client.searchTracks({ q: "another" });
    expect(tokens).toBe(1);
    const tokenCall = calls[0]!;
    expect(new Headers(tokenCall.init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(String(tokenCall.init?.body)).toBe("grant_type=client_credentials");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("OAuth token-1");
  });

  it("builds the search request and maps tracks", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.hostname === "secure.soundcloud.com"
        ? tokenResponse()
        : json({ collection: [fakeTrack(7, "Song (Test Remix)", { genre: "", access: "preview" })], next_href: "https://api.soundcloud.com/tracks?q=song&offset=50" }),
    );
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn });
    const page = await client.searchTracks({ q: "song remix", genres: ["House", "Techno"], limit: 20 });
    const search = new URL(calls[1]!.url);
    expect(search.pathname).toBe("/tracks");
    expect(search.searchParams.get("q")).toBe("song remix");
    expect(search.searchParams.get("genres")).toBe("House,Techno");
    expect(search.searchParams.get("limit")).toBe("20");
    expect(page.next).toContain("offset=50");
    expect(page.items[0]).toMatchObject({
      urn: "soundcloud:tracks:7",
      title: "Song (Test Remix)",
      uploader: "Test Uploader",
      access: "preview",
      embeddable: true,
      plays: 1234,
      tags: ["remix", "tech house"],
    });
    expect(page.items[0]!.genre).toBeUndefined();
  });

  it("only follows next-page links on api.soundcloud.com", async () => {
    const { fn, calls } = fakeFetch((url) => (url.hostname === "secure.soundcloud.com" ? tokenResponse() : json({ collection: [] })));
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn });
    await expect(client.searchTracks({ q: "", cursor: "https://evil.example/tracks" })).rejects.toThrow(ScError);
    await expect(client.searchTracks({ q: "", cursor: "http://api.soundcloud.com/tracks" })).rejects.toThrow(ScError);
    await expect(client.searchTracks({ q: "", cursor: "not a url" })).rejects.toThrow(ScError);
    expect(calls).toHaveLength(0);
    await client.searchTracks({ q: "", cursor: "https://api.soundcloud.com/tracks?q=a&offset=50" });
    expect(calls.at(-1)!.url).toBe("https://api.soundcloud.com/tracks?q=a&offset=50");
  });

  it("caches answers briefly", async () => {
    let now = 0;
    let searches = 0;
    const { fn } = fakeFetch((url) => {
      if (url.hostname === "secure.soundcloud.com") return json({ access_token: "t", expires_in: 999_999 });
      searches++;
      return json({ collection: [] });
    });
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn, now: () => now });
    await client.searchTracks({ q: "a" });
    await client.searchTracks({ q: "a" });
    expect(searches).toBe(1);
    now += 11 * 60_000;
    await client.searchTracks({ q: "a" });
    expect(searches).toBe(2);
  });

  it("refreshes an expired token with the refresh token, and keeps it in the token file", async () => {
    let now = 0;
    const bodies: string[] = [];
    const { fn } = fakeFetch((url, init) => {
      if (url.hostname === "secure.soundcloud.com") {
        bodies.push(String(init?.body));
        return tokenResponse(bodies.length);
      }
      return json({ collection: [] });
    });
    const tokenFile = join(dir, "sc-token.json");
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn, now: () => now, tokenFile });
    await client.searchTracks({ q: "a" });
    now += 2 * 3600_000;
    await client.searchTracks({ q: "b" });
    expect(bodies).toEqual(["grant_type=client_credentials", "grant_type=refresh_token&refresh_token=refresh-1"]);
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).accessToken).toBe("token-2");

    // A restart reads the saved token instead of asking for a new one.
    const again = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn, now: () => now, tokenFile });
    await again.searchTracks({ q: "c" });
    expect(bodies).toHaveLength(2);
  });

  it("gets a new token once when SoundCloud says the token is no good", async () => {
    let tokens = 0;
    let searches = 0;
    const { fn } = fakeFetch((url) => {
      if (url.hostname === "secure.soundcloud.com") return tokenResponse(++tokens);
      searches++;
      return searches === 1 ? json({}, 401) : json({ collection: [] });
    });
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn });
    await expect(client.searchTracks({ q: "a" })).resolves.toEqual({ items: [] });
    expect(tokens).toBe(2);
  });

  it("reports rate limits with SoundCloud's wait time", async () => {
    const { fn } = fakeFetch((url) => (url.hostname === "secure.soundcloud.com" ? tokenResponse() : json({}, 429, { "retry-after": "120" })));
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn });
    const error = await client.searchTracks({ q: "a" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScRateLimited);
    expect((error as ScRateLimited).retryAfterSeconds).toBe(120);
  });

  it("says when the credentials are rejected", async () => {
    const { fn } = fakeFetch(() => json({ error: "invalid_client" }, 401));
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "wrong", fetchFn: fn });
    await expect(client.searchTracks({ q: "a" })).rejects.toThrow(/rejected the app's credentials/);
  });

  it("resolves profile links and reads public likes", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.hostname === "secure.soundcloud.com") return tokenResponse();
      if (url.pathname === "/resolve") return json({ kind: "user", urn: "soundcloud:users:42", username: "Test Curator", permalink_url: "https://soundcloud.com/test-curator", public_favorites_count: 300 });
      return json({ collection: [fakeTrack(9, "Liked Song")], next_href: null });
    });
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn });
    const user = await client.user("test-curator");
    expect(user).toMatchObject({ urn: "soundcloud:users:42", username: "Test Curator", likesCount: 300 });
    expect(new URL(calls[1]!.url).searchParams.get("url")).toBe("https://soundcloud.com/test-curator");
    const likes = await client.userLikes(user.urn);
    expect(new URL(calls[2]!.url).pathname).toBe("/users/soundcloud%3Ausers%3A42/likes/tracks");
    expect(likes.items.map((t) => t.title)).toEqual(["Liked Song"]);
    await expect(client.userLikes("../../oauth")).rejects.toThrow(ScError);
  });

  it("refuses links that aren't soundcloud.com", async () => {
    const { fn, calls } = fakeFetch(() => tokenResponse());
    const client = new SoundCloudClient({ clientId: "id", clientSecret: "s", fetchFn: fn });
    await expect(client.resolve("https://soundcloud.com.evil.example/x")).rejects.toThrow(/isn't a soundcloud.com link/);
    await expect(client.resolve("http://soundcloud.com/x")).rejects.toThrow(ScError);
    expect(calls).toHaveLength(0);
  });
});
