# setscope

A personal command-line tool that analyzes DJ sets from [1001Tracklists](https://www.1001tracklists.com).
Work in progress: a project I'm building for fun, not a finished product.

**Song mode.** Give it a song, and it looks at recent sets containing that song:
- the DJs who play it most
- unreleased **ID** tracks that keep showing up in those same sets
- the songs most often played alongside it

**Artist mode.** Give it an artist, and it reports:
- whether other DJs are playing them more or less: recent window vs. earlier window, plus a month-by-month view
- their most-played tracks recently (collabs and remixes count)
- the artists whose tracks *they* play most in their own sets

Sets older than the cutoff (default **18 months**) are ignored.

## Setup

Needs Node 22.18 or newer. Node runs the TypeScript directly, so there's no build step.

```bash
npm install
npm test
```

## Usage

```bash
npm run setscope -- help
```

### 1. Collect sets

1001Tracklists puts DJ pages and track pages behind a "verify you're human" check, so setscope
never fetches those. You open them in your browser (where you pass the check yourself) and save them:

1. Open a **track page** (for song mode) or a **DJ page** (for artist mode) in your browser.
2. Save it with **Cmd+S** ("Webpage, HTML only" is fine).
3. Give the saved file to setscope. It finds every tracklist link on the page and fetches those sets:

```bash
npm run setscope -- add ~/Downloads/"Fisher - Losing It.html"
npm run setscope -- add ~/Downloads/fisher-dj-page.html --limit 50
```

`add` also accepts tracklist URLs directly, a `.txt` file of tracklist URLs, or a saved
tracklist page (imported with no network request at all).

Fetching is slow on purpose: one request every 8 seconds, so 50 sets take about 7 minutes.
Every set is cached in `data/`, so it's only ever fetched once. If a run stops (`--limit`, a block,
Ctrl+C), run the same command again and it picks up where it left off.

### 2. Analyze

```bash
npm run setscope -- song "Fisher - Losing It"
npm run setscope -- song "https://www.1001tracklists.com/track/abc123/fisher-losing-it/index.html"
npm run setscope -- artist "Fisher"
npm run setscope -- artist "Fisher" --months 12 --recent-months 3 --top 20
npm run setscope -- stats
```

| Option | Meaning |
|---|---|
| `--since YYYY-MM-DD` / `--months N` | freshness cutoff (default: last 18 months) |
| `--recent-months N` | artist mode: size of the "recent" window (default 6) |
| `--top N` | rows per list (default 10) |
| `--limit N` | `add`: stop after N requests |
| `--json` | print the raw report as JSON |

Set `SETSCOPE_DATA=/some/dir` to keep the cache somewhere other than `./data`.

## Data access

Checked on 2026-10-25:

- **robots.txt** allows general crawling of `/` with `Crawl-delay: 8` (it blocks a list of named bots,
  none of which is this tool).
- **No public terms of service page** and **no public API**.
- **Bot protection:** track and DJ pages return a human-verification challenge to scripts.
  Tracklist pages load normally.

So setscope:
- uses an honest User-Agent (`setscope/0.1 (personal non-commercial project; respects robots.txt)`) and never pretends to be a browser
- waits at least 8 seconds between requests, even across separate runs
- only fetches `/tracklist/` pages automatically
- **stops the whole run** at the first sign of a bot check (401/403/429/503 or a "please wait" page), with no retries and no workarounds
- caches everything locally, so repeated lookups make no requests

This is for personal, non-commercial use at small scale.

## How it's built

```
src/
  model.ts            Track, Tracklist, Ranked: the types everything shares
  normalize.ts        name matching: case/accents/"feat.", ID detection, splitting collaborators
  analysis/           pure functions, no network or disk
    song.ts           song mode
    artist.ts         artist mode
    common.ts         date filters, Counter
  source/             data access: everything that touches the network or disk
    parse.ts          1001Tracklists HTML -> Tracklist
    fetcher.ts        polite HTTP fetcher (HtmlSource interface)
    store.ts          local cache in data/
    ingest.ts         URLs -> fetch -> parse -> cache
  format.ts           report -> terminal text
  cli.ts              argument parsing and wiring
test/                 Vitest tests, fixture tracklists in test/fixtures/
```

The analysis only ever sees `Tracklist[]`. It doesn't know whether a set came from the network, a
saved page, or a test fixture, so another data source could be added by writing a new `source/`
module, without touching `analysis/`.

### Decisions worth knowing

- **Songs are matched by normalized name**, not by 1001Tracklists' track id, because some rows have
  no id. Matching ignores case, accents, extra spaces and "feat." vs "ft.".
- **Counts are "number of sets"**: a track played twice in one set counts once.
- **Recurring IDs:** an ID row is grouped (1) by the site's track id when it has one, (2) by name for
  partial IDs like "Fisher - ID", otherwise (3) by *the track played right before it*. The third is a
  heuristic, and the output labels it as one.
- **Artist trend compares share of sets, not raw counts.** Raw counts mostly reflect how many sets you
  happened to cache. Share means sets with the artist ÷ sets cached in that window. It says
  "not enough data" below 5 sets per window, and "up"/"down" at a ±25% change in share.
- **Usage counts other DJs only**, since a DJ playing their own tracks says little about demand.

### Known limitations

- **B2B sets:** every DJ on a set gets credit for every track. (The page marks "X played:" sections,
  which a later version could parse.)
- **Artist names containing "&"** (e.g. "Butch & Santos") get split into two artists.
- **Saved DJ/track pages can include unrelated sidebar links**, which then get fetched too. They don't
  affect song mode (those sets don't contain the song), but they do add to the denominator in
  artist trends.
- Results only reflect the sets you've added. This is a sample, not all of 1001Tracklists.

## Reading this code as a Java developer

| You'll see | Java equivalent |
|---|---|
| `interface Track { artist: string; label?: string }` | a record/POJO; `?` means the field may be absent (like a nullable field you don't have to set) |
| `import type { Track }` | an import used only for type checking. It disappears at runtime |
| `Map<string, number>`, `Set<string>` | `HashMap`, `HashSet`, but `Set` of arrays compares by reference (like default `equals`) |
| `x ?? y` | `x != null ? x : y` |
| `x?.y` | `x == null ? null : x.y` |
| `arr[0]!` | "trust me, not undefined". With `noUncheckedIndexedAccess`, indexing returns `T \| undefined` |
| `(t): t is Track => t !== undefined` | a type guard: after `.filter(...)` the compiler knows the list is `Track[]` |
| `async`/`await`, `Promise<T>` | `CompletableFuture<T>`, but written like blocking code |
| `"up" \| "down" \| "flat"` | a lightweight enum: a string that can only hold those values |
| constructor assigns fields explicitly | TypeScript's `constructor(private x: T)` shorthand isn't allowed here (`erasableSyntaxOnly`), because Node strips types without compiling |
