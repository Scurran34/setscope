# setscope

A private, invite-only web app (plus a command-line version) that analyzes DJ sets from
[1001Tracklists](https://www.1001tracklists.com), with a shared catalog that everyone signed in benefits from.
Work in progress: a project I'm building for fun, not a finished product.

> **Before any public launch:** the shared catalog republishes 1001Tracklists' tracklist data. Ask
> 1001Tracklists for permission first. Until then setscope is meant for you and people you invite.

**Streams can be bought. Genuine DJ support is harder to manufacture.** setscope shows which tracks
DJs actually play in their sets, made by *other* artists, so you can find what the DJs you trust are
supporting instead of relying only on streaming popularity. The evidence is plain: track appearances
across indexed DJ sets, by the date each set was performed. It doesn't claim to know whether support is
organic, paid or independent; it shows what was played and how often.

- **Discover** (the landing page): **Playing Now**, **Most Played** and **Deep Cuts**, plus the set moments
  **Intros** (what DJs open with) and **90 + 5** (the closers they finish on), for all DJs, the DJs you follow,
  or DJs you pick, filtered by genre and time.
- **DJs**: search DJs, follow them, and open a DJ's page to see what they play (other artists' tracks first),
  their own productions, the IDs they've played, and their sets.
- **Library**: liked tracks, playlists, and the **Unreleased Vault** (saved IDs that update themselves when a
  tracklist names them).

Song pages, set pages, remixes, playback and the collector are all still there, reached from where they
make sense rather than from the main menu.

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

The app has real pages, each with its own address (filters and page numbers included), so links,
Back and Forward work. The top bar has **Discover · DJs · Library**, a search box (artists, songs and sets),
**Queue** (collecting sets) and your account; on a phone it becomes a tab bar at the bottom. Artist photos
come from 1001Tracklists; songs have no cover art, so a plain tile with initials stands in, never a fake cover.

- **Discover** (`#/?mode=now|most|deep&scope=all|followed|custom&djs=&genre=&period=&page=`): the three modes
  as big tabs, then which DJs (**All DJs**, **DJs I follow**, or **Choose DJs** with a picker), the time period and
  genre. 15 tracks per page. Each row shows the track (its title opens its page), its artists, a few of the
  DJs who played it, the counts (qualifying sets and supporting DJs, always separately), and ♡ Like, ＋ Playlist
  and ▶ Play buttons that don't navigate. Signed in and following DJs, Discover starts with them. When the
  data is thin (fewer than 5 sets in the scope, or too small a catalog for Deep Cuts) the page says so above
  the results. "How this is ranked" and a coverage line (how many sets, DJs and dates the numbers cover)
  sit under every list.
- **DJs** (`#/djs`): DJs you follow, then every DJ with indexed sets (search, 24 per page, Follow buttons).
  Only people who *performed* indexed sets are listed, so singers whose vocals producers use (Rihanna) or
  bands whose songs get remixed (The Temper Trap) never show up as DJs.
- **A DJ's page** (`#/artist/<name>`): photo, other names they're listed under (with the evidence), Follow, and
  then, in order:
  1. **What they play**: other artists' tracks in their sets, with the same three modes, period and genre
     filters, 15 per page (in the address, so paging keeps the filters).
  2. **Their sets** (signed in): **Gather** *their last 10 / 20 / 30 / 40 sets* (the newest that many on their 1001Tracklists page;
     ones already here are skipped, not swapped for older ones; the same menu is on every Gather button and
     remembers your choice), how many of
     their sets are still waiting to be read, and **Stop gathering**, which cancels this DJ's sets that haven't been
     fetched yet (the one being read finishes).
  3. **Own productions**: tracks they made, featured on or remixed, most supported by *other* DJs first. A mashup
     that merely uses one of their songs isn't theirs and isn't listed.
  4. **IDs they've played**: each unidentified line on its own (two "ID - ID" lines are never assumed to be the same
     track), with **Save to Vault**.
  5. **Recent sets**, linking to each set's full tracklist.
  The older statistics view (trend chart, who they play) is at `#/artist/<name>/stats`.
- **Library**: a recommended set, playlists (covers built from artist photos, **Play all**), liked tracks, and the
  **Unreleased Vault**: every saved ID with where it was heard; identified ones come first, showing what the line
  says now and when it changed.
- Still reachable in context: song pages (`#/artist/<a>/song/<s>`: who plays it, **Played alongside it** with every
  song that shared 2+ sets, 15 a page, ranked by *Goes with it* (of the sets that play the other song, how many also
  play this one: shared ÷ (its sets + 3)) or *Most shared sets*, playlists, SoundCloud links and remixes), set pages (`#/set/<id>`), the song/artist/set charts (`#/songs`, `#/artists`, `#/sets`), search results
  (`#/find/<text>`), and SoundCloud curator likes (`#/discover/<profile>`).

### How the discovery rankings work

All three use `src/catalog/discover.ts`, computed in Postgres for the selected DJs and period:

- **A qualifying appearance** is one indexed set (performed in the period, by at least one selected DJ) that
  played the track. A track played twice in one set counts once. It counts only if **none of that set's DJs is
  credited on the recording** in any role (artist, featured artist, remixer, or mashup source), with verified
  aliases applied. So Chris Lorenzo playing his own track, or a mashup built on it, never counts as a pick,
  while another DJ playing it does. Unidentified IDs never enter these rankings.
- **Playing Now**: the sum over qualifying appearances of `0.5 ^ (days since the set / 14)`: a set from today counts
  1, from two weeks ago 0.5, from a month ago about 0.23. Ties: more sets, then more DJs. Default period: this month.
- **Most Played**: the number of distinct qualifying sets. Ties: more supporting DJs, then most recently played.
  Default period: last 3 months.
- **Deep Cuts**: tracks played by **at least 2 of the selected DJs** (or in **2+ sets** when one DJ is selected) that
  appear in **no more than 2%** of all indexed sets (at least 3), any DJ, any date. Ranked by supporting DJs, then by
  the share of the track's indexed appearances that come from the selected DJs, then by how rare it is overall.
  With fewer than 50 sets indexed in total the page warns that "rare" can't be judged yet. Default period: 12 months.
- **Intros** and **90 + 5**: tracks in the first (or last) 2 lines of sets with at least 10 tracks listed. A track needs
  2+ such sets (by **2+ DJs** when several are selected), and at least **20%** of its plays by these DJs must be at
  that moment, so a hit that happens to open or end one set doesn't count. Ranked by DJs, then sets, then that share.
  Default period: 12 months. Discover shows the top 5 of each under the main list.
- **Supporting DJs** counts distinct selected DJs (aliases merged) who played it in a qualifying set; in a B2B set
  each selected DJ on it counts. The names shown are the ones who played it most.
- Original songs, remixes, edits and mashups are separate tracks (see Track identity), so a remix's support never
  inflates the original's.

### Who made a track (attribution)

Credits come from how 1001Tracklists writes each line (`credits()` in `src/catalog/identity.ts`):

| Line | Credited as |
|---|---|
| `A & B - Title` | A, B: **main** (the track's artists) |
| `A ft. B - Title` | B: **featured** (1001Tracklists writes vocalists this way too) |
| `A - Title (C Remix)`, `(C Edit)`, `(C VIP)`, `(C Bootleg)` | C: **remixer** (made this version) |
| `A vs. B - X vs. Y (C Edit)` | A, B: **mashup component** (their songs are in it); C: remixer |
| `A vs. B - Title` | a collaboration: A, B main (a mashup has "vs." in the title too) |

`&`, `,`, `x`, `vs.`, `ft.`, ` / ` and `pres.` separate names, except names that have their own 1001Tracklists page
(Cause & Affect, Lucas & Steve…), which stay whole. **Samples aren't marked in tracklists and vocalists only
when written "ft.", so setscope never guesses those.** Performing DJs come from the set page, separately from
track credits. Credits are re-derived for every stored track once whenever the rules change.

**Aliases.** `artist_aliases` maps an alternate name to the canonical artist, with the evidence, and everything
(rankings, the DJ list, a DJ's sets and profile, following, the third-party check, gathering) treats them as one.
Only pairs with evidence go in. The first is **Lorenzo → Chris Lorenzo**: 1001Tracklists' own URLs for "Lorenzo @ …"
sets use the slug `chris-lorenzo`, and Chris Lorenzo's profile links to Beatport and Traxsource pages named
"Lorenzo". Names that merely look alike (Lorenzo De Blanck) are left apart.

**Searching:** the top-bar box suggests artists, songs and sets as you type; Enter shows all
results. For a song, a title alone or `Artist - Title` works. Matching ignores case, accents, periods and apostrophes, and tolerates typos. If a search
finds nothing but one cached name is clearly what you meant, you get that page with "Showing results
for CHRIS STASSY · Search for “chris stussy” instead".

**Collecting sets:** on a song or artist page, **Gather more sets** opens 1001Tracklists' own search
in a popup. The extension opens the matching result (or you click it; if the site asks you to verify
you're human, you do that yourself), scrolls the page the way you would until every set is listed (the
page loads about 10 at a time; there is no cap, so a big DJ can take a few minutes), sends the links to setscope, and closes the popup. setscope then
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

### Playback

Sets with a SoundCloud recording (1001Tracklists embeds it on the set page) have a **▶ Play** button
wherever they're listed: song pages, artist pages, and "For you". Playing a set opens the **player bar**
at the bottom of every page: artwork, title, play/pause, a seek bar with time, volume, and a close
button (which pauses). It's one player for the whole app and lives outside the page area, so moving
between pages keeps it playing and never starts a second one. Nothing plays until you press play.

How it works: SoundCloud's own embedded player (through its official Widget API) does the streaming.
setscope only sends it play/pause/seek/volume commands, and never downloads or proxies audio. Its slim
strip stays visible under the bar, and the bar credits the uploader and SoundCloud with links to the
track, as SoundCloud's terms ask for custom players. If a recording can't be embedded (private, removed,
or the uploader disallows it), the bar says so and links to the set page. If playback stalls at 0:00 for
12 seconds, it offers to open the track on SoundCloud. Songs play the same way once they have a
SoundCloud link (next section).

The player has three layers in `web/player.ts`: `PlayerCore` (state, no page code, unit tested), a
`PlaybackProvider` per service (`SoundCloudProvider` today), and the bar. Adding another service means
writing another provider.

### Collecting sets: sessions, Auto-Collect, checkpoints, Stop

**Start:** on a DJ (or song) page, **Collect [25 new sets ▾]** (10 / 25 / 50 / 100; default 25). "New" means sets
Rabbithole doesn't have yet: indexed ones are skipped and don't count, and the extension keeps scrolling the DJ's
1001Tracklists page (asking Rabbithole which sets it already has) until it has found that many new ones or the page
ends. You open that one page and pass any check yourself; the extension never opens pages on its own.

**Then the server collects** them on its own, one tracklist every 8 seconds, as a **session**: you can browse
anywhere in Rabbithole (or close it) and it carries on. Gathering the same DJ while their session is open asks it
for more instead of starting a second one, and a set already in line for someone else is never fetched twice.

**The header pill** shows the session in a few words (*Collecting · 18/25*, *Checkpoint · 8s*, *Paused · 20/25*,
*Verification Required*, *Stopping…*, *Stopped · 18 collected*, *Done · 25 new*). Click it for the panel: artist, status,
progress, sets already here, next checkpoint, **Stop gathering**, **Continue** / **Resume**, **Collect more**,
**View queue**, and your settings. The page checks every 3 s while something is collecting, every 10 s otherwise.

- **Checkpoints** (every 5 or every 10 saved sets; default 5): the set in hand is saved, then the session pauses for
  about 10 seconds. It goes on only if **Auto-Collect** is on and nothing stopped or blocked it; otherwise it waits for
  **Continue**. Checkpoints are for your control, not a way around the site's limits: those are separate and win.
- **Auto-Collect** (off for new accounts, saved with your account): on, sessions carry on through checkpoints by
  themselves. Off, they pause after the set in hand (not a failure; Continue picks up). Switching it back on continues
  paused sessions, but never stopped ones.
- **Stop gathering** ends the session: nothing more starts, a fetch in flight is cancelled (its set goes back in line,
  not marked failed), everything saved stays, and the panel shows how many were collected. A stopped session only
  starts again when someone presses **Resume**: not after a refresh, a restart, or Auto-Collect switching on.
- **Counting:** a set counts once it's saved. An empty tracklist ("no tracks yet") or an unrecognized page doesn't
  count and doesn't pause anything; a set already indexed counts as "already here".
- Sessions, their jobs and your preferences live in Postgres (`collection_sessions`, `collection_jobs.session_id`,
  `collect_prefs`, migration 006), so they survive restarts; a Stop that was mid-fetch when the server stopped is
  finished on startup.

**When 1001Tracklists says no**, the fetcher says how: rate limit (429), login required (401), refused (403),
unavailable (503), or a verification page. Any of them pauses *all* collecting, marks sessions "Verification Required",
and keeps the site's **Retry-After**: **Try again** won't send a request before that time. The pill and panel show the
warning with **Open 1001Tracklists** (for you to look, or pass a check in your browser) and Stop. Passing a check in
your browser doesn't unblock the server's own requests, and Rabbithole never solves checks, rotates addresses or
disguises itself; it only resumes when a real request is allowed again.

**Not automated, on purpose:** opening set pages in browser tabs to read them. The server fetches tracklists with
its own honest, rate-limited requests; when the site refuses those, a browser loop doing the same work would be
routing around that refusal.

### How collecting works

Every set to fetch is a job in the database (`collection_jobs`), shared by everyone and kept across
restarts:

- **One live job per set.** Asking for the same set twice (two people, or the same DJ page gathered
  again) never fetches it twice, and sets already in the catalog are never fetched again.
- **Newest first.** Sets older than your window are *held* rather than dropped; "Include them" puts them in line.
- **Retries:** a passing problem (a dropped connection, a server error) is retried after 30 s, 2 min and
  8 min, then the job is marked failed with its error, and Account offers "Retry them".
- **"Slow down" pauses everything.** A 401/403/429/503 or a challenge page pauses all collecting (the
  reason is stored, so it survives restarts) and is never treated as "no more sets". If the site says how
  long to wait (`Retry-After`), the page tells you. Nothing is retried until someone presses Try again.
- **Restarts:** a job that was mid-fetch goes back in line, and the queue comes back paused.
- **Several workers can run safely:** each claims a job with `for update skip locked`.
- **Discovery progress.** Each DJ/track page you gather from records how many sets it listed, how many
  were already here, how many were new or older, and whether the extension reached the end of the page.
  Artist pages show it as "Last gathered…". Gathering again picks up anything new, and cached sets never
  count against what's fetched.
- **Refreshes.** With background collecting on, every 6 hours up to 5 recent sets that still contain
  unidentified IDs are re-read (counting toward the 100-a-day limit). What changed is recorded in
  `track_metadata_history`, and each attempt in `source_refresh_history` (unchanged / updated / failed /
  blocked). A failed refresh keeps the stored set. Signed-in users can also ask for a refresh of a set.
- **Limits:** at most 30 captures, pasted lists or refresh requests per 10 minutes per account (or per
  address for the extension).

Finding an artist's or a song's sets still happens in your browser through the extension, because
1001Tracklists' DJ and track pages put scripts through a human check. setscope doesn't try to get around that.

### Background collecting

A switch on the home page. When it's on, setscope slowly caches the sets on the 1001Tracklists front
page (new and featured sets), so reports and trending have more to work with, within strict limits:

- only while your own queue isn't fetching or paused (your requests come first)
- the front page at most once an hour, then one set every 90 seconds, through the same fetcher
  (honest User-Agent, one request at a time, 8 s minimum gap)
- at most 100 sets a day
- any sign of a block pauses it for 24 hours. It never retries early or works around it.

Its state (on/off, today's count, the sets still to fetch) is saved in `data/background.json`.

### SoundCloud: song links, remixes, Discover

With a SoundCloud app connected (below), signed-in people get:

- **Song links.** A song page's "On SoundCloud" card has **Find on SoundCloud**, which searches
  SoundCloud and sorts what comes back into **This song**, **Another version** (a remix, edit,
  bootleg...) and **Related upload** (same title, someone else), each with a match percentage and the
  reason ("same title, artist and version"). Matches are guesses from titles and uploaders, so nothing
  is linked until someone picks **Use as this song's link** or pastes a soundcloud.com link. Links
  are shared: everyone sees them, with who confirmed them; only that person (or the owner) can remove
  one. setscope looks every link up on SoundCloud before saving it and stores only the link,
  SoundCloud's id for it, how it was matched, and who confirmed it.
- **Remix search.** "Remixes & edits on SoundCloud" lists versions of the song (of its original, if the
  song is itself a remix), with filters for genre (the uploader's own tag; "Unknown" means none) and
  remixer, sorting by SoundCloud's relevance or by SoundCloud plays, and **Load more**.
- **Discover.** Type a SoundCloud profile (a DJ, a label, a friend) to see their public likes.
- **Save.** Any SoundCloud upload can be saved into one of your categories; the category page lists
  and plays it.

Search results and likes come live from SoundCloud and are not stored (SoundCloud's terms allow
keeping references, not their catalog). SoundCloud plays and likes are always labelled as SoundCloud's
numbers, separate from setscope's counts of DJ-set plays. Uploads that are preview-only say so; ones
that can't be streamed here only get an "Open on SoundCloud" link.

**Connecting it** (owner): create an app at [soundcloud.com/you/apps](https://soundcloud.com/you/apps)
(needs an Artist Pro plan), then paste its client ID and secret into **Account → SoundCloud app**. They're
saved in `data/soundcloud.json` (readable only by you, never committed, and the secret is never sent
back to the page). Or set `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` before `npm run web`.

Staying inside SoundCloud's limits (`src/soundcloud/client.ts`):

- One access token is reused until it expires, then refreshed, and kept in `data/soundcloud-token.json`
  so restarts don't ask for another (SoundCloud allows an app 50 new tokens per 12 hours).
- Answers are kept in memory for 10 minutes, so reopening a page doesn't search again.
- Each account can make 120 SoundCloud requests per 10 minutes, and the whole site 400 likes lookups a
  day (SoundCloud allows 500). When SoundCloud says to slow down (HTTP 429), the page says how long.
- "Load more" only follows paging links that point at `api.soundcloud.com`.

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

## Testing with friends

For a test run from your Mac (it only works while your Mac is on and the tunnel runs):

```bash
brew install cloudflared                                   # once
cd ~/Documents/setscope && SETSCOPE_INVITE_CODE=pick-a-code SETSCOPE_SECURE_COOKIES=1 npm run web
cloudflared tunnel --url http://127.0.0.1:7331            # in a second tab: prints https://….trycloudflare.com
caffeinate -dims                                            # in a third tab: keeps the Mac awake
```

Send friends the trycloudflare link and the invite code; they create accounts under **Sign in**. Everyone
browses, follows, likes and plays through that link (you too, while testing).

**Friends adding sets:**
- **Paste links:** Queue → **Add sets by link** works for any signed-in account.
- **Gather a DJ's sets:** they need the Chrome extension too. Zip the `extension/` folder, send it, and have them
  load it unpacked (`chrome://extensions` → Developer mode → Load unpacked). It works on `*.trycloudflare.com`
  links as well as your own Mac.
- Through the link, every capture needs the sender's **capture key**: the page fetches one when you're signed
  in (valid 12 hours) and hands it to the extension, so their sets are queued under their account. Without
  one, the capture is refused. Captures straight from your Mac work as before, with no key and no cap.
- A friend's gather queues at most **200** sets (the newest), and is rate-limited like other requests. The
  queue still fetches one set every 8 seconds from your Mac's connection, so friends gathering a lot makes
  1001Tracklists' slow-downs more likely.
- **Clear queue** (everyone's sets) is yours alone; a friend's **Stop gathering** only cancels sets they queued.
- Keep the link among friends: ask 1001Tracklists for permission before anything public.

## Deploying

setscope isn't deployed anywhere. When you want to, follow [docs/DEPLOY.md](docs/DEPLOY.md): one always-on
Node process plus Postgres behind HTTPS (the collector and refresh schedule run inside that process, so
serverless hosting won't work), with every environment variable, the service file, backups and logs.

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
    browse.ts         song/artist charts by performance date, set list and set pages, paged in SQL
    discover.ts       Playing Now / Most Played / Deep Cuts, DJ list, profiles, own tracks, ID lines
    identity.ts       which tracklist lines are the same recording; versions; IDs
  db/                 database plumbing
    pool.ts           connection (DATABASE_URL)
    migrate.ts        applies db/migrations/*.sql once each, in order
    import-legacy.ts  copies the old file cache into the catalog
  auth/accounts.ts    sign-up (owner first, then invite-only), passwords, sessions
  personal/user-data.ts   one account's likes and playlists
  personal/vault.ts       the Unreleased Vault (IDs saved by the set line they were heard on)
  soundcloud/
    client.ts         SoundCloud API: token reuse/refresh, search, resolve, likes, 429s
    match.ts          is an upload this song, another version, or just related?
    links.ts          confirmed song links and uploads saved into categories
  collect/            the collection system
    jobs.ts           the job queue in Postgres: dedupe, newest first, retries, pause, recovery, refreshes
    discovery.ts      what each DJ/track page gathering found ("Last gathered")
  auth/rate-limit.ts  per-account limits on captures and refresh requests
  source/             data access: everything that touches the network or disk
    parse.ts          1001Tracklists HTML -> Tracklist
    fetcher.ts        polite HTTP fetcher (HtmlSource interface)
    store.ts          the old file cache in data/ (tests, and the import source)
    ingest.ts         URLs -> fetch -> parse -> cache
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
  player.ts           the player: core, SoundCloud provider (official Widget API), and the bar
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
- **Artist names containing "&"** stay whole only when 1001Tracklists gives that name its own page; a duo
  that has never had a page of its own in the indexed data still gets split.
- **Samples and uncredited vocalists** aren't in tracklists, so they're never credited.
- **Aliases** are added by hand with evidence (one so far). Other alternate names stay separate until verified.
- **Deep Cuts depend on coverage**: "rare" means rare among the sets indexed here, so a small or lopsided
  collection makes some popular tracks look rare. The page warns below 50 indexed sets.
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
