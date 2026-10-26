// Command-line entry point. Wires the data-access layer (source/) to the analysis
// (analysis/) and prints the result. Uses the same database as the web app
// (DATABASE_URL). Run `npm run setscope -- help` for usage.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { analyzeArtist } from "./analysis/artist.ts";
import { today } from "./analysis/common.ts";
import { analyzeSong } from "./analysis/song.ts";
import { DEFAULT_MONTHS, dataDir as defaultDataDir, sinceMonths } from "./config.ts";
import { formatArtistReport, formatSongReport } from "./format.ts";
import { parseSongQuery } from "./normalize.ts";
import { PoliteFetcher } from "./source/fetcher.ts";
import { importSavedTracklist, ingestUrls } from "./source/ingest.ts";
import { extractTracklistUrls, isChallengePage, isTracklistPage, tracklistId } from "./source/parse.ts";
import { PgCatalog } from "./catalog/pg-catalog.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";

const USAGE = `setscope: analyze DJ sets from 1001Tracklists

Commands:
  add <file-or-url>...      Add sets to the local cache. Each argument can be:
                              - a tracklist URL (fetched politely, 8s apart)
                              - a page saved from your browser (Cmd+S): a DJ page or
                                track page (its tracklist links are fetched), or a
                                tracklist page (imported directly, no request)
                              - a .txt file with one tracklist URL per line
  song "<Artist - Title>"   Who plays it, recurring IDs, what it's played with.
                            Also accepts a 1001Tracklists track URL.
  artist "<Name>"           Trend, most-played tracks, who they play.
  stats                     What's in the cache.
  reparse                   Re-read cached HTML after a parser change (no network).

Options:
  --since YYYY-MM-DD        Ignore sets before this date (default: ${DEFAULT_MONTHS} months ago)
  --months N                Same, as "the last N months"
  --recent-months N         Artist mode: size of the "recent" window (default 6)
  --top N                   Rows per list (default 10)
  --limit N                 add: stop after N requests (re-run to continue)
  --json                    Print the raw report as JSON
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      months: { type: "string" },
      "recent-months": { type: "string" },
      top: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || command === "help") {
    console.log(USAGE);
    return;
  }

  const now = today();
  const since = values.since ?? sinceMonths(values.months ? toInt(values.months, "--months") : DEFAULT_MONTHS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new UsageError(`--since must be YYYY-MM-DD (got "${since}")`);
  const top = values.top ? toInt(values.top, "--top") : 10;
  const dataDir = defaultDataDir();
  const pool = createPool();
  try {
    await migrate(pool);
    await run(command, args, values, new PgCatalog(pool), dataDir, since, top, now);
  } finally {
    await pool.end();
  }
}

async function run(
  command: string,
  args: string[],
  values: { json?: boolean; limit?: string; "recent-months"?: string },
  store: PgCatalog,
  dataDir: string,
  since: string,
  top: number,
  now: string,
): Promise<void> {
  const print = (report: object, text: string) => console.log(values.json ? JSON.stringify(report, null, 2) : text);

  switch (command) {
    case "add":
      return add(args, store, dataDir, since, values.limit ? toInt(values.limit, "--limit") : undefined);
    case "song": {
      const report = analyzeSong(await store.all(), parseSongQuery(requireArg(args, "song")), { since, top });
      return print(report, formatSongReport(report));
    }
    case "artist": {
      const recentMonths = values["recent-months"] ? toInt(values["recent-months"], "--recent-months") : 6;
      const report = analyzeArtist(await store.all(), requireArg(args, "artist"), { since, today: now, recentMonths, top });
      return print(report, formatArtistReport(report));
    }
    case "stats":
      return stats(store, since);
    case "reparse":
      console.log(`Re-parsed ${await store.reparseAll()} cached sets.`);
      return;
    default:
      throw new UsageError(`Unknown command "${command}". Try: setscope help`);
  }
}

async function add(inputs: string[], store: PgCatalog, dataDir: string, since: string, limit?: number): Promise<void> {
  if (inputs.length === 0) throw new UsageError("add needs at least one file or URL.");
  const queue: string[] = [];

  for (const input of inputs) {
    if (/^https?:\/\//.test(input)) {
      if (!tracklistId(input)) {
        throw new UsageError(
          `${input} isn't a tracklist URL. DJ and track pages need a human check, so open it in ` +
            `your browser, save it (Cmd+S), and pass the saved file instead.`,
        );
      }
      queue.push(input);
      continue;
    }
    if (!existsSync(input)) throw new UsageError(`No such file: ${input}`);
    const text = readFileSync(input, "utf8");
    if (isTracklistPage(text)) {
      console.log(`Imported saved tracklist ${await importSavedTracklist(text, store)} from ${input}`);
    } else if (isChallengePage(text)) {
      console.log(`${input} is the "are you human" page, not the real one. Pass the check in your browser, then save again.`);
    } else {
      const urls = extractTracklistUrls(text);
      console.log(`${input}: found ${urls.length} tracklist links.`);
      queue.push(...urls);
    }
  }
  if (queue.length === 0) return;

  const fetcher = new PoliteFetcher({ stateFile: join(dataDir, "last-request") });
  const result = await ingestUrls(queue, store, fetcher, { since, limit, log: (l) => console.log(l) });
  console.log(
    `\nFetched ${result.fetched}, already cached ${result.alreadyCached}, ` +
      `skipped ${result.skippedOld} older than ${since}, failed ${result.failed.length}.`,
  );
  for (const f of result.failed) console.log(`  failed: ${f.url}: ${f.error}`);
  if (result.blocked) {
    console.log(
      `\nStopped: ${result.blocked}\nsetscope won't try to get around this. Wait a while and run the same ` +
        `command again (cached sets are skipped), or save the remaining tracklist pages from your browser and add those files.`,
    );
  }
  if (result.remaining.length > 0) console.log(`${result.remaining.length} sets left to fetch. Re-run to continue.`);
}

async function stats(store: PgCatalog, since: string): Promise<void> {
  const sets = await store.all();
  const recent = sets.filter((s) => s.date >= since);
  const dates = sets.map((s) => s.date).sort();
  console.log(`${sets.length} sets cached (${recent.length} since ${since}).`);
  if (dates.length > 0) console.log(`Oldest ${dates[0]}, newest ${dates[dates.length - 1]}.`);
}

class UsageError extends Error {}

function requireArg(args: string[], command: string): string {
  const value = args.join(" ").trim();
  if (!value) throw new UsageError(`${command} needs an argument. Try: setscope help`);
  return value;
}

function toInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive whole number (got "${value}")`);
  return n;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
}
