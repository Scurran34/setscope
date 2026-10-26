import { describe, expect, it } from "vitest";
import { SongInfoService, SongInfoStore } from "../src/source/songinfo.ts";

/** A fake GetSongBPM: answers from a script and records the URLs asked for. */
function fakeApi(replies: { status?: number; body: unknown }[]) {
  const urls: URL[] = [];
  const fetchFn = (async (url: URL) => {
    urls.push(url);
    const reply = replies.shift() ?? { body: { search: { error: "no result" } } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

const hit = (title: string, artist: string, extra: object = {}) => ({
  title,
  uri: "https://getsongbpm.com/song/x/y",
  tempo: "126",
  key_of: "F♯m",
  open_key: "4m",
  artist: { name: artist },
  ...extra,
});

const options = (fetchFn: typeof fetch, now = () => 1_000_000) => ({ apiKey: "k", fetchFn, now, sleep: async () => {} });

describe("SongInfoService", () => {
  it("looks a song up once, picks the result that matches, and caches it", async () => {
    const api = fakeApi([{ body: { search: [hit("Other Song", "Mau P"), hit("Bounce", "Mau P")] } }]);
    const service = new SongInfoService(new SongInfoStore(), options(api.fetchFn));
    const first = await service.info("Mau P & Friend - Bounce (Extended Mix)");
    expect(first).toEqual({
      status: "ok",
      info: { found: true, bpm: 126, key: "F♯m", openKey: "4m", url: "https://getsongbpm.com/song/x/y", fetchedAt: new Date(1_000_000).toISOString() },
    });
    expect(api.urls[0]!.searchParams.get("lookup")).toBe("song:Bounce artist:Mau P");
    expect(api.urls[0]!.searchParams.get("api_key")).toBe("k");

    await service.info("Mau P & Friend - Bounce (Extended Mix)");
    expect(api.urls).toHaveLength(1); // cached
  });

  it("never takes a result for a different song, and remembers not-found for 30 days", async () => {
    const api = fakeApi([{ body: { search: [hit("Bounce", "Someone Else")] } }, { body: { search: [hit("Bounce", "Mau P")] } }]);
    let now = 0;
    const store = new SongInfoStore();
    const service = new SongInfoService(store, options(api.fetchFn, () => now));
    expect((await service.info("Mau P - Bounce")).status).toBe("not-found");
    now = 29 * 86_400_000;
    expect((await service.info("Mau P - Bounce")).status).toBe("not-found");
    expect(api.urls).toHaveLength(1);
    now = 31 * 86_400_000;
    expect((await service.info("Mau P - Bounce")).status).toBe("ok");
  });

  it("asks once when the same song is opened twice at the same time", async () => {
    const api = fakeApi([{ body: { search: [hit("Bounce", "Mau P")] } }]);
    const service = new SongInfoService(new SongInfoStore(), options(api.fetchFn));
    const [a, b] = await Promise.all([service.info("Mau P - Bounce"), service.info("Mau P - Bounce")]);
    expect(a.status).toBe("ok");
    expect(b).toEqual(a);
    expect(api.urls).toHaveLength(1);
  });

  it("says when there's no key, and doesn't cache errors", async () => {
    expect(await new SongInfoService(new SongInfoStore()).info("Mau P - Bounce")).toEqual({ status: "no-key" });

    const api = fakeApi([{ status: 401, body: {} }, { body: { search: [hit("Bounce", "Mau P")] } }]);
    const service = new SongInfoService(new SongInfoStore(), options(api.fetchFn));
    expect(await service.info("Mau P - Bounce")).toMatchObject({ status: "error", message: expect.stringMatching(/rejected the API key/) });
    expect((await service.info("Mau P - Bounce")).status).toBe("ok");
  });

  it("spaces lookups at least 1.5s apart", async () => {
    const api = fakeApi([{ body: { search: [] } }, { body: { search: [] } }]);
    let clock = 10_000;
    const sleeps: number[] = [];
    const service = new SongInfoService(new SongInfoStore(), {
      apiKey: "k",
      fetchFn: api.fetchFn,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await Promise.all([service.info("A - One"), service.info("B - Two")]);
    expect(sleeps).toEqual([1_500]);
  });
});
