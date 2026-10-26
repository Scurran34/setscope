# setscope

A personal web app (plus a command-line version) that analyzes DJ sets from [1001Tracklists](https://www.1001tracklists.com).
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

## Web app

```bash
npm run web
```

Open http://127.0.0.1:7331. The first time, add the Chrome extension (the page shows these steps
until it's installed):

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this project's `extension/` folder.
3. Reload the setscope page.

Then:

1. Type a song (`Artist - Title`) or an artist and click **Analyze**. Anything already cached shows up at once.
2. Click **Find sets on 1001Tracklists**. A popup opens 1001Tracklists' own search. If exactly one
   result matches what you typed, the extension opens it; otherwise you click the right one. If the
   site asks you to verify you're human, you do that yourself.
3. On the track or DJ page, the extension sends the set links to setscope and **closes the popup**.
4. setscope fetches those sets in the background (8 seconds apart) and the report **updates as they
   arrive**. A progress bar shows how many are left.
5. **Batches of 5.** Of the sets found, the 5 newest are fetched right away. The rest wait under
   "N more sets found" with **Fetch 5 more**, **Fetch all** and **Clear** buttons, so a lookup never sends
   dozens of requests unless you ask for them.
6. **More data around a song:** in "DJs who play it most", **Get sets** opens that DJ's page and the
   extension adds their sets to the found list. You can also paste set links under **Add sets by link**.
7. **The search box suggests songs and artists already in your cache** as you type (most-played
   first), and a search that finds nothing shows **Did you mean**. Matching ignores case, accents,
   periods and apostrophes, so "lp rhythm - how ya feelin" finds "L.P. Rhythm - How Ya Feelin'".
8. If 1001Tracklists starts refusing the app (a 401 after a run of requests), fetching **pauses**. You
   can wait and click **Try again**, or click **Open** next to any waiting set (the one it stopped on is
   marked). That opens the set in a popup, the extension saves its tracks, and the popup closes. Opening
   a set saves that set; it does not restart automated fetching. The waiting and found lists are saved
   to `data/queue.json`, so they survive restarts (waiting sets come back paused).

### Why an extension?

A web page can't read another site's tab, and 1001Tracklists' track and DJ pages put scripts through a
human check. The extension reads the page *you* opened in your own browser (the same thing as saving it)
and passes the set links to the local app. It only acts in tabs setscope opened, never in your normal
browsing, and it never fills in or skips the human check.

## Command line

Everything the web app does is also available from the terminal:

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
- counts a failed connection toward the 8-second gap too, and shows the site's `Retry-After` when it sends one
- pauses (instead of dropping the set) when a fetch fails for any other reason, such as a network or parse error. The set stays in `data/queue.json` until you click **Try again** or **Open**

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
    catalog.ts        loose text search over the cache (search dropdown, "Did you mean")
  source/             data access: everything that touches the network or disk
    parse.ts          1001Tracklists HTML -> Tracklist
    fetcher.ts        polite HTTP fetcher (HtmlSource interface)
    store.ts          local cache in data/
    ingest.ts         URLs -> fetch -> parse -> cache
    queue.ts          background fetching for the web app (found list, batches, pause on block)
  format.ts           report -> terminal text
  cli.ts              command line
  server.ts           local web server (node:http, no framework) + JSON API
  config.ts           defaults shared by both
web/
  index.html          the page
  app.ts              browser code, served with types stripped by Node (no bundler)
extension/            Chrome extension (plain JS: Chrome can't run TypeScript)
  capture.js          on 1001Tracklists: collect set links, auto-open an exact search match
  background.js       decides which tabs are setscope's, posts links to the server, closes the tab
  app-bridge.js       on the setscope page: tells the extension a search popup is opening
test/                 Vitest tests, fixture tracklists in test/fixtures/
```

`web/app.ts` imports the report types from `src/analysis/` with `import type`. Those lines are erased
before the browser sees the file, so the page and the server share one definition of each report
without a bundler.

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
- **The extension hasn't been run in Chrome yet.** The server, page, queue and capture endpoint are
  tested, and the search-match logic was checked against a real results page, but the full
  popup → capture → auto-close loop needs a first real run.
- **Track and DJ pages may only list some of their sets** (if 1001Tracklists paginates them, only the
  first page is captured).
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
