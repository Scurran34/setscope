import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockedError, CancelledError, EmptyTracklistError, FRONT_PAGE, LayoutError, MIN_DELAY_MS, PoliteFetcher, retryAfterSeconds, USER_AGENT, type HtmlSource } from "../src/source/fetcher.ts";
import { importSavedTracklist, ingestUrls } from "../src/source/ingest.ts";
import {
  canonicalUrl,
  dateFromUrl,
  extractTracklistUrls,
  isChallengePage,
  PARSER_VERSION,
  parseTracklist,
} from "../src/source/parse.ts";
import { TracklistStore } from "../src/source/store.ts";

const pageHtml = readFileSync(join(import.meta.dirname, "fixtures/tracklist-page.html"), "utf8");
const pageUrl = "https://www.1001tracklists.com/tracklist/zz9fix1/dj-alpha-dj-beta-fixture-radio-101-2026-09-10.html";

describe("parseTracklist", () => {
  const set = parseTracklist(pageHtml, pageUrl);

  it("reads id, DJs and the date the set was played (not the date it was posted)", () => {
    expect(set.id).toBe("zz9fix1");
    expect(set.djs).toEqual(["DJ Alpha", "DJ Beta"]);
    expect(set.date).toBe("2026-09-10");
    expect(set.title).toBe("DJ Alpha & DJ Beta - Fixture Radio 101 2026-09-10");
    expect(set.soundcloud).toBe("https://api.soundcloud.com/tracks/2423741796");
    expect(set.parserVersion).toBe(PARSER_VERSION);
    expect(set.djProfiles).toEqual([
      {
        name: "DJ Alpha",
        page: "https://www.1001tracklists.com/artist/dj-alpha/tracklists.html",
        country: "Netherlands",
        image: "https://i1.sndcdn.com/avatars-alpha.jpg",
        links: [
          { label: "SoundCloud", url: "https://soundcloud.com/djalpha" },
          { label: "Instagram", url: "https://www.instagram.com/djalpha/" },
        ],
      },
    ]);
    expect(set.djPages).toEqual({
      "DJ Alpha": "https://www.1001tracklists.com/artist/dj-alpha/tracklists.html",
      "DJ Beta": "https://www.1001tracklists.com/artist/dj-beta/tracklists.html",
    });
  });

  it("reads every row, including IDs and rows with only metadata", () => {
    expect(set.tracks).toEqual([
      {
        artist: "Nova",
        title: "Pulse",
        label: "FIXTURE",
        trackId: "nova111",
        genre: "Tech House",
        artistPages: { Nova: "https://www.1001tracklists.com/artist/nova/tracks.html" },
      },
      { artist: "ID", title: "ID" },
      { artist: "Roland Clark & Amy Alexander", title: "Feel It" },
      { artist: "Kite", title: "ID", trackId: "kiteid9" },
      { artist: "Glovibes ft. Lana Parrilla", title: "It's Over Now (Lello Russo & Alex Rai Remix)" },
      { artist: "ID", title: "ID" },
    ]);
  });
});

describe("link helpers", () => {
  it("pulls tracklist URLs out of HTML or plain text, deduplicated and absolute", () => {
    const text = `
      <a href="/tracklist/aaa111/x-2026-01-02.html">a</a>
      <a href="/tracklist/aaa111/x-2026-01-02.html">a again</a>
      https://1001tracklists.com/tracklist/bbb222/y-2025-03-04.html
      /dj/someone/index.html`;
    expect(extractTracklistUrls(text)).toEqual([
      "https://www.1001tracklists.com/tracklist/aaa111/x-2026-01-02.html",
      "https://www.1001tracklists.com/tracklist/bbb222/y-2025-03-04.html",
    ]);
  });

  it("reads the set date from the URL slug", () => {
    expect(dateFromUrl(pageUrl)).toBe("2026-09-10");
    expect(dateFromUrl("https://www.1001tracklists.com/tracklist/abc/no-date.html")).toBeUndefined();
  });

  it("finds the canonical URL and spots challenge pages", () => {
    expect(canonicalUrl(pageHtml)).toBe(pageUrl);
    expect(isChallengePage(pageHtml)).toBe(false);
    expect(isChallengePage("<p>We need to validate your are real human!</p>")).toBe(true);
  });
});

/** A fake fetch that replies from a script and records what was asked. */
function fakeFetch(replies: { status: number; body: string }[]) {
  const calls: { url: string; userAgent: string }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, userAgent: headers["User-Agent"] ?? "" });
    const reply = replies.shift() ?? { status: 200, body: pageHtml };
    return new Response(reply.body, { status: reply.status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("PoliteFetcher", () => {
  it("sends an honest User-Agent and waits at least 8s between requests", async () => {
    const { fn, calls } = fakeFetch([]);
    let clock = 0;
    const sleeps: number[] = [];
    const fetcher = new PoliteFetcher({
      fetchFn: fn,
      delayMs: 1, // too small: should be raised to the minimum
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await fetcher.fetchHtml(pageUrl);
    clock += 3_000; // 3s pass before the next request
    await fetcher.fetchHtml(pageUrl);

    expect(calls.map((c) => c.userAgent)).toEqual([USER_AGENT, USER_AGENT]);
    expect(sleeps).toEqual([MIN_DELAY_MS - 3_000]);
  });

  it("remembers the last request across runs via the state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setscope-state-"));
    const stateFile = join(dir, "last-request");
    let clock = 100_000;
    const sleeps: number[] = [];
    const options = {
      stateFile,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    await new PoliteFetcher({ ...options, fetchFn: fakeFetch([]).fn }).fetchHtml(pageUrl);
    clock += 1_000;
    // A brand-new fetcher, like a second `setscope add` started right after the first.
    await new PoliteFetcher({ ...options, fetchFn: fakeFetch([]).fn }).fetchHtml(pageUrl);
    rmSync(dir, { recursive: true, force: true });
    expect(sleeps).toEqual([MIN_DELAY_MS - 1_000]);
  });

  it("counts a failed connection toward the delay, and says it was a network failure", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    let first = true;
    const fetcher = new PoliteFetcher({
      fetchFn: (async () => {
        if (first) {
          first = false;
          throw new Error("ECONNRESET");
        }
        return new Response(pageHtml);
      }) as typeof fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await expect(fetcher.fetchHtml(pageUrl)).rejects.toThrow(/Network failure.*ECONNRESET/);
    await fetcher.fetchHtml(pageUrl);
    expect(sleeps).toEqual([MIN_DELAY_MS]);
  });

  it("includes Retry-After in the block message when the site sends it", async () => {
    const fn = (async () => new Response("slow down", { status: 429, headers: { "Retry-After": "600" } })) as typeof fetch;
    const fetcher = new PoliteFetcher({ fetchFn: fn, sleep: async () => {} });
    await expect(fetcher.fetchHtml(pageUrl)).rejects.toThrow(/Retry-After: 600/);
  });

  it("sends one request at a time, even when two callers ask at once", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fetcher = new PoliteFetcher({
      fetchFn: fakeFetch([]).fn,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await Promise.all([fetcher.fetchHtml(pageUrl), fetcher.fetchHtml(pageUrl)]);
    expect(sleeps).toEqual([MIN_DELAY_MS]);
  });

  it("fetches the front page, and treats one with no set links as a block", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: '<a href="/tracklist/abc/x-2026-10-01.html">x</a>' },
      { status: 200, body: "Please wait, you will be forwarded" },
    ]);
    const fetcher = new PoliteFetcher({ fetchFn: fn, sleep: async () => {} });
    expect(await fetcher.fetchFrontPage()).toContain("/tracklist/abc/");
    expect(calls[0]!.url).toBe(FRONT_PAGE);
    await expect(fetcher.fetchFrontPage()).rejects.toBeInstanceOf(BlockedError);
  });

  it("refuses track and DJ pages", async () => {
    const fetcher = new PoliteFetcher({ fetchFn: fakeFetch([]).fn, sleep: async () => {} });
    await expect(fetcher.fetchHtml("https://www.1001tracklists.com/track/abc/x/index.html")).rejects.toThrow(/Refusing/);
    await expect(fetcher.fetchHtml("https://www.1001tracklists.com/dj/x/index.html")).rejects.toThrow(/Refusing/);
  });

  it("says how the site refused: login, rate limit, refusal, unavailable, or a verification page", async () => {
    const { fn } = fakeFetch([
      { status: 401, body: "We need to validate your are real human!" },
      { status: 200, body: "Please wait, you will be forwarded" },
      { status: 429, body: "slow down" },
      { status: 403, body: "no" },
      { status: 503, body: "busy" },
    ]);
    const fetcher = new PoliteFetcher({ fetchFn: fn, sleep: async () => {} });
    const kinds = [];
    for (let i = 0; i < 5; i++) kinds.push(await fetcher.fetchHtml(pageUrl).catch((e: BlockedError) => e.kind));
    expect(kinds).toEqual(["auth", "challenge", "rate_limit", "forbidden", "unavailable"]);
  });

  it("keeps the site's Retry-After, as seconds or a date", async () => {
    const fn = (async () => new Response("slow down", { status: 429, headers: { "Retry-After": "600" } })) as typeof fetch;
    const error = await new PoliteFetcher({ fetchFn: fn, sleep: async () => {} }).fetchHtml(pageUrl).catch((e: BlockedError) => e);
    expect(error).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 600 });
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:18:00 GMT"))).toBe(600);
    expect(retryAfterSeconds(null)).toBeUndefined();
  });

  it("tells an empty tracklist and an unrecognized page apart from a block", async () => {
    const { fn } = fakeFetch([
      { status: 200, body: '<html><head><link rel="canonical" href="https://www.1001tracklists.com/tracklist/abc/x.html"></head><body>No tracks yet</body></html>' },
      { status: 200, body: "<html><body>Something completely different</body></html>" },
    ]);
    const fetcher = new PoliteFetcher({ fetchFn: fn, sleep: async () => {} });
    await expect(fetcher.fetchHtml(pageUrl)).rejects.toBeInstanceOf(EmptyTracklistError);
    await expect(fetcher.fetchHtml(pageUrl)).rejects.toBeInstanceOf(LayoutError);
  });

  it("lets Stop cancel a request that's waiting its turn, without sending it", async () => {
    const { fn, calls } = fakeFetch([]);
    let release: () => void = () => {};
    const fetcher = new PoliteFetcher({ fetchFn: fn, sleep: () => new Promise((r) => (release = r)), now: () => 0 });
    await fetcher.fetchHtml(pageUrl, undefined).catch(() => {}); // first request: no wait
    const stop = new AbortController();
    const waiting = fetcher.fetchHtml(pageUrl, stop.signal);
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
    release();
    expect(calls).toHaveLength(1);
  });
});

describe("ingest + store", () => {
  let dir: string;
  let store: TracklistStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "setscope-test-"));
    store = new TracklistStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Serves the fixture page for any URL, but with that URL's id, and counts requests. */
  function fixtureSource(blockAfter = Infinity) {
    let requests = 0;
    const source: HtmlSource = {
      async fetchHtml(url) {
        requests++;
        if (requests > blockAfter) throw new BlockedError("bot check", 401);
        return pageHtml;
      },
    };
    return { source, count: () => requests };
  }

  const url = (id: string, date: string) => `https://www.1001tracklists.com/tracklist/${id}/set-${date}.html`;

  it("fetches new sets, skips cached and old ones without a request", async () => {
    const { source, count } = fixtureSource();
    const first = await ingestUrls([url("a1", "2026-09-10"), url("old1", "2020-01-01")], store, source, {
      since: "2025-04-25",
    });
    expect(first).toMatchObject({ fetched: 1, skippedOld: 1, alreadyCached: 0 });

    const second = await ingestUrls([url("a1", "2026-09-10")], store, source, { since: "2025-04-25" });
    expect(second).toMatchObject({ fetched: 0, alreadyCached: 1 });
    expect(count()).toBe(1);
    expect((await store.all()).map((s) => s.id)).toEqual(["a1"]);
  });

  it("stops the whole run at the first bot check and reports what's left", async () => {
    const { source, count } = fixtureSource(1);
    const urls = [url("a1", "2026-09-01"), url("a2", "2026-09-02"), url("a3", "2026-09-03")];
    const result = await ingestUrls(urls, store, source, { since: "2025-01-01" });
    expect(result.fetched).toBe(1);
    expect(result.blocked).toMatch(/bot check/);
    expect(result.remaining).toEqual(urls.slice(1));
    expect(count()).toBe(2); // never tried a3
  });

  it("respects --limit", async () => {
    const { source } = fixtureSource();
    const urls = [url("a1", "2026-09-01"), url("a2", "2026-09-02")];
    const result = await ingestUrls(urls, store, source, { since: "2025-01-01", limit: 1 });
    expect(result.fetched).toBe(1);
    expect(result.remaining).toEqual([urls[1]]);
  });

  it("imports a page saved from the browser and can re-parse the cache", async () => {
    expect(await importSavedTracklist(pageHtml, store)).toBe("zz9fix1");
    expect(await store.has("zz9fix1")).toBe(true);
    expect(store.reparseAll()).toBe(1);
    expect((await store.all())[0]?.tracks).toHaveLength(6);
  });
});
