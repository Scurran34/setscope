# setscope

A private, invite-only web app (plus a command-line version) that analyzes DJ sets from
[1001Tracklists](https://www.1001tracklists.com), with a shared catalog that everyone signed in benefits from.
Work in progress: a project I'm building for fun, not a finished product.

> **Before any public launch:** the shared catalog republishes 1001Tracklists' tracklist data. Ask
> 1001Tracklists for permission first. Until then setscope is meant for you and people you invite.

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

Needs Node 22.18 or newer (Node runs the TypeScript directly, so there's no build step) and
PostgreSQL 17.

```bash
brew install postgresql@17   # once
npm install
npm run db:init              # creates a database inside this project (.postgres/), port 54329, local only
npm run db:migrate           # creates the tables (safe to run any time)
npm run db:import            # copies an existing file cache (data/) in; repeatable, files are kept
npm test                     # unit tests; database tests run against setscope_test
npm run web                  # http://127.0.0.1:7331
```

After a restart, run `npm run db:start` before `npm run web` (and `npm run db:stop` when you're done).
`npm run db:psql` opens a SQL prompt. `DATABASE_URL` points everything at another database (for example
a hosted Postgres) instead of the local one.

**Accounts.** The first account created on the site is the owner, and gets any likes and categories
from before accounts existed. After that, sign-up needs the invite code in `SETSCOPE_INVITE_CODE` (with
no code set, sign-up is closed). Anyone who can reach the site can browse reports; liking, categories
and queue controls need an account; site-wide settings (GetSongBPM key, background collecting) are the
owner's. Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly, SameSite=Lax cookie,
and the database only stores their SHA-256. Set `SETSCOPE_SECURE_COOKIES=1` when serving over HTTPS.

**Backups and rollback.** Back up with
`/opt/homebrew/opt/postgresql@17/bin/pg_dump -h 127.0.0.1 -p 54329 -U setscope setscope > backup.sql`
and restore into an empty database with `psql ... < backup.sql`. The file cache in `data/` is never
deleted by the import, so rolling back to the file version is just checking out the previous commit.

### Data model

| Shared catalog (everyone sees the same rows) | Personal (one account's rows, never shown to others) |
|---|---|
| `artists`: name, 1001Tracklists page, country, picture, links | `users`, `sessions` |
| `tracks`: one row per recording, see identity rules below | `user_likes` |
| `track_artists`: main artists and remixers | `collections`, `collection_tracks` (your categories) |
| `sets`, `set_djs`, `set_tracks` (ordered, exactly as the source wrote each line, with its genre tag) | `followed_artists`, `vault_entries` (used in later stages) |
| `set_pages`: the page each set was read from, for re-parsing | |
| `track_metadata_history`: what changed when a set was re-read | |
| `external_track_links`: links to recordings elsewhere (SoundCloud), with confidence and provenance | |
| `collection_jobs`, `discovery_progress`, `source_refresh_history` (used by the collection system) | |

**Track identity.** A tracklist line is matched to a track by 1001Tracklists' own track id when the
page gives one, otherwise by the normalized "artists - title" (case, accents, periods and apostrophes
ignored; "(Extended Mix)", "(Radio Edit)" and the like count as the same recording). Remixes, edits, VIPs,
bootlegs, mashups and reworks are separate tracks linked to their original. Unidentified "ID - ID" lines
without a 1001Tracklists id are never merged by name: each is its own placeholder, so two different
unreleased songs can't be counted as one. Re-reading a set records any line that changed (an ID that got
identified, a corrected title) in `track_metadata_history`.

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

The app has real pages, each with its own address, so links, Back and Forward work. The top bar
(Home · Trending · Account, plus the search box) is on every page.

- **Home**: sets with the most of your liked songs, songs you might like, a trending preview, and
  your categories.
- **Trending**: songs and artists whose share of your cached sets rose after a date you pick (last 2
  weeks, month, or 3 months), with the percent change or **NEW**, plus the most played songs and
  artists in that window. Based on the sets you've collected, not all of 1001Tracklists.
- **Artist pages** (`#/artist/<name>`): their picture, country, links (SoundCloud, Spotify, Instagram,
  Beatport...) and 1001Tracklists page, all read from the DJ cards on cached set pages. Also how many of
  their sets you have, how many other DJs' sets play them, genres, labels, and a trend chart. Below that
  are **their songs**: click one to open its numbers (DJs who play it, songs played alongside, IDs, key/BPM)
  right there, without leaving the artist page. Their own sets and who they play are at the bottom.
- **Song pages** live under their artist (`#/artist/<name>/song/<song>`): who plays it, recurring IDs, what
  it's played alongside, every set with a **▶ Listen** link to the set's SoundCloud recording, genre,
  key and BPM, ♡ Like, and your categories with **Maybe part of "Party"** hints. Every song and artist name
  anywhere is a link to its page.
- **Account**: liked songs, your categories (each has a page of songs that **might fit**), collecting
  controls, background collecting, adding sets by link, your GetSongBPM key, and cache stats. Everything
  is stored on this computer; there's no login yet.

**Searching:** type a title alone or `Artist - Title`. The box suggests cached songs and artists as
you type. Matching ignores case, accents, periods and apostrophes, and tolerates typos. If a search
finds nothing but one cached name is clearly what you meant, you get that page with "Showing results
for CHRIS STASSY · Search for “chris stussy” instead".

**Collecting sets:** on a song or artist page, **Gather more sets** opens 1001Tracklists' own search
in a popup. The extension opens the matching result (or you click it; if the site asks you to verify
you're human, you do that yourself), scrolls the page the way you would until every set is listed (the
page loads 20 at a time, up to 300), sends the links to setscope, and closes the popup. setscope then
fetches **all** of them on its own, newest first, one every 8 seconds. A slim strip under the top bar
shows progress on every page, and the full queue (up next, with **Show the rest / Hide the rest**) is on
Account. Home and Trending update as sets arrive; artist, song and category pages offer **Refresh**
instead, so they don't change under you. "Get sets" next to a DJ collects that DJ's sets the same way.

**Older sets aren't dropped.** Sets older than your window (default 18 months) are set aside, and
Account offers **Include them**. The window goes up to **last 3 years** and **all time**.

**If 1001Tracklists starts refusing the app** (a 401/403 after a run of requests), collecting
**pauses** with a one-line explanation and next steps (technical details are folded away). You can wait
and click **Try again**, **Clear queue**, or **Open** any waiting set yourself (the one it stopped on
is marked): it opens in a popup, the extension saves its tracks, and the popup closes. Opening a set
saves that set; it does not restart automated fetching. The queue is saved in `data/queue.json`, so it
survives restarts (and comes back paused).

### Why an extension?

A web page can't read another site's tab, and 1001Tracklists' track and DJ pages put scripts through a
human check. The extension reads the page *you* opened in your own browser (the same thing as saving it)
and passes the set links to the local app. It only acts in tabs setscope opened, never in your normal
browsing, and it never fills in or skips the human check.

### Background collecting

A switch on the home page. When it's on, setscope slowly caches the sets on the 1001Tracklists front
page (new and featured sets), so reports and trending have more to work with, within strict limits:

- only while your own queue isn't fetching or paused (your requests come first)
- the front page at most once an hour, then one set every 90 seconds, through the same fetcher
  (honest User-Agent, one request at a time, 8 s minimum gap)
- at most 100 sets a day
- any sign of a block pauses it for 24 hours. It never retries early or works around it.

Its state (on/off, today's count, the sets still to fetch) is saved in `data/background.json`.

### Key and BPM (GetSongBPM)

Song pages get key and BPM from [GetSongBPM](https://getsongbpm.com)'s free API:

1. Register at getsongbpm.com/api for a free API key.
2. Save it where setscope looks for it (the `data/` folder is never committed):
   ```bash
   echo "YOUR_KEY" > ~/Documents/setscope/data/getsongbpm-key
   ```
   (or set `SETSCOPE_GETSONGBPM_KEY`), then restart `npm run web`.

How it stays cheap: a song is looked up **once**, the first time you open its page, and the answer is
cached in `data/songinfo.json` for good ("not found" is retried after 30 days; errors are never cached).
Lookups run one at a time, 1.5 s apart, far under the API's 3,000/hour limit. Only a result whose title
and artist match is used, never just the first hit. GetSongBPM's terms require a visible link back to
them, so song pages show "data: GetSongBPM.com" next to the key and BPM.

Their API docs were behind a bot check when this was written, so the address and field names
(`tempo`, `key_of`, `open_key`) come from their published examples. If lookups fail, set
`SETSCOPE_GETSONGBPM_URL` (default `https://api.getsong.co`) to the address in their current docs.

Why not Beatport: Beatport's pages put scripts through a bot check (HTTP 403), and its API is for
approved partners only.

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
    trending.ts       songs and artists rising in share of sets
    personal.ts       sets for you, songs you might like, "maybe part of" category hints
    profile.ts        artist profile pages (DJ card info, their songs, sets, labels)
  catalog/            the shared catalog
    catalog.ts        the Catalog interface (has / save / all / count)
    pg-catalog.ts     Catalog on Postgres: saving sets, artists, tracks; history on refresh
    identity.ts       which tracklist lines are the same recording; versions; IDs
  db/                 database plumbing
    pool.ts           connection (DATABASE_URL)
    migrate.ts        applies db/migrations/*.sql once each, in order
    import-legacy.ts  copies the old file cache into the catalog
  auth/accounts.ts    sign-up (owner first, then invite-only), passwords, sessions
  personal/user-data.ts   one account's likes and categories
  source/             data access: everything that touches the network or disk
    parse.ts          1001Tracklists HTML -> Tracklist
    fetcher.ts        polite HTTP fetcher (HtmlSource interface)
    store.ts          the old file cache in data/ (tests, and the import source)
    ingest.ts         URLs -> fetch -> parse -> cache
    queue.ts          background fetching for the web app (found list, batches, older sets, pause on block)
    background.ts     background collecting of front-page sets (switch, slow, daily cap)
    songinfo.ts       key/BPM from GetSongBPM, looked up once per song and cached
  format.ts           report -> terminal text
  cli.ts              command line
  server.ts           local web server (node:http, no framework) + JSON API
  config.ts           defaults shared by both
  user.ts             the old single-user likes file format (imported into the first account)
web/
  index.html          the page
  app.ts              browser code, served with types stripped by Node (no bundler)
extension/            Chrome extension (plain JS: Chrome can't run TypeScript)
  capture.js          on 1001Tracklists: collect set links, auto-open an exact search match
  background.js       decides which tabs are setscope's, posts links to the server, closes the tab
  app-bridge.js       on the setscope page: tells the extension a search popup is opening
db/migrations/        SQL migrations (001_catalog.sql, ...)
scripts/db.sh         start/stop the project-local Postgres
test/                 Vitest tests, fixture tracklists in test/fixtures/; database tests use a
                      throwaway schema per file in setscope_test, and skip (saying so) if Postgres isn't running
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
