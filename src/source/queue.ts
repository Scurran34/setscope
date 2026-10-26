// Background fetching for the web app. Unlike ingestUrls (one fixed list, then done),
// this keeps running and accepts new URLs while it works, so the page can show
// progress and update the report as sets arrive.
//
// Two lists:
//   found    sets we know about but haven't asked for yet, newest first
//   waiting  sets being fetched now (pulled from `found` in batches, e.g. 5 at a time)

import { BlockedError, isFetchAllowed, MIN_DELAY_MS, type HtmlSource } from "./fetcher.ts";
import { triage } from "./ingest.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Tracklist } from "../model.ts";
import { canonicalUrl, dateFromUrl, parseTracklist, tracklistId } from "./parse.ts";
import type { TracklistStore } from "./store.ts";

export type QueueState = "idle" | "running" | "blocked";

export interface QueueStatus {
  state: QueueState;
  /** Sets fetched since the queue was last empty. */
  done: number;
  /** done + still waiting. */
  total: number;
  failed: number;
  /** Failures still sitting in the queue (it pauses on them rather than dropping the set). */
  pendingFailures: number;
  current?: string;
  blocked?: string;
  etaSeconds: number;
  /** URLs not fetched yet, so the page can offer to open them by hand when blocked. */
  waiting: string[];
  /** Sets found but not requested yet, newest first (fetch them with "more"). */
  found: string[];
}

export interface EnqueueResult {
  /** New sets added to the found list. */
  queued: number;
  /** Of those, how many started fetching right away. */
  fetchingNow: number;
  alreadyCached: number;
  skippedOld: number;
}

export interface QueueOptions {
  /** Only used for the time estimate; the fetcher enforces the real delay. */
  delayMs?: number;
  /** File that keeps the waiting list across restarts. */
  saveFile?: string;
}

export class FetchQueue {
  private readonly store: TracklistStore;
  private readonly source: HtmlSource;
  private readonly delayMs: number;
  private readonly saveFile: string | undefined;
  private readonly waiting: string[] = [];
  private readonly found: string[] = [];
  private state: QueueState = "idle";
  private done = 0;
  private failed = 0;
  private pendingFailures = 0;
  private current: string | undefined;
  private blocked: string | undefined;
  private running: Promise<void> | undefined;

  constructor(store: TracklistStore, source: HtmlSource, options: QueueOptions = {}) {
    this.store = store;
    this.source = source;
    this.delayMs = options.delayMs ?? MIN_DELAY_MS;
    this.saveFile = options.saveFile;
    // Sets left over from last time come back paused: nothing is requested until you say so.
    if (this.saveFile && existsSync(this.saveFile)) {
      const saved: unknown = JSON.parse(readFileSync(this.saveFile, "utf8"));
      // Older saves were one plain list: treat it all as found, to fetch in batches.
      const { waiting, found } = Array.isArray(saved) ? { waiting: [], found: saved } : (saved as Record<string, unknown>);
      if (!Array.isArray(waiting) || !Array.isArray(found)) throw new Error(`Invalid saved queue file: ${this.saveFile}`);
      const usable = (list: unknown[]) =>
        list.filter((url): url is string => typeof url === "string" && isFetchAllowed(url) && !this.store.has(tracklistId(url) ?? ""));
      this.waiting.push(...new Set(usable(waiting)));
      this.found.push(...new Set(usable(found).filter((url) => !this.waiting.includes(url))));
      sortNewestFirst(this.found);
      if (this.waiting.length > 0) {
        this.state = "blocked";
        this.blocked = `${this.waiting.length} sets were still waiting when setscope last stopped.`;
      }
    }
  }

  private save(): void {
    if (!this.saveFile) return;
    const waiting = this.current ? [this.current, ...this.waiting] : this.waiting;
    writeFileSync(this.saveFile, JSON.stringify({ waiting, found: this.found }));
  }

  /**
   * Add URLs to the found list (duplicates, cached and too-old ones are dropped),
   * then start fetching the newest `take` of them.
   */
  enqueue(urls: string[], since: string, take = Number.POSITIVE_INFINITY): EnqueueResult {
    const { todo, alreadyCached, skippedOld } = triage(urls, this.store, since);
    const known = new Set([...this.waiting, ...this.found, this.current]);
    const fresh = [...new Set(todo)].filter((url) => !known.has(url));
    this.found.push(...fresh);
    sortNewestFirst(this.found);
    const fetchingNow = this.more(take);
    this.save();
    return { queued: fresh.length, fetchingNow, alreadyCached, skippedOld };
  }

  /** Move the newest `count` found sets into fetching. Returns how many moved. */
  more(count = Number.POSITIVE_INFINITY): number {
    if (this.state === "idle") {
      this.done = 0;
      this.failed = 0;
      this.pendingFailures = 0;
    }
    const batch = this.found.splice(0, Math.min(count, this.found.length));
    this.waiting.push(...batch);
    this.save();
    if (this.state !== "blocked") this.start();
    return batch.length;
  }

  /** Forget the found-but-not-fetched sets. Sets already fetching are unaffected. */
  clearFound(): number {
    const cleared = this.found.length;
    this.found.length = 0;
    this.save();
    return cleared;
  }

  /** After a block: try again with whatever is still waiting. */
  resume(): void {
    if (this.state !== "blocked") return;
    this.blocked = undefined;
    this.pendingFailures = 0; // they're back in line and about to be retried
    this.state = "idle";
    this.start();
  }

  /**
   * A tracklist page you opened yourself (sent by the extension). Saves it and takes
   * it off the waiting list; when that empties a blocked queue, the queue is done.
   */
  importPage(html: string, pageUrl: string): Tracklist {
    const set = parseTracklist(html, canonicalUrl(html) ?? pageUrl);
    if (set.tracks.length === 0) throw new Error("No tracks found on that page.");
    this.store.save(set, html);
    const index = this.waiting.findIndex((url) => tracklistId(url) === set.id);
    if (index !== -1) {
      this.waiting.splice(index, 1);
      this.done++;
    }
    const foundIndex = this.found.findIndex((url) => tracklistId(url) === set.id);
    if (foundIndex !== -1) this.found.splice(foundIndex, 1);
    this.save();
    if (this.state === "blocked" && this.waiting.length === 0) {
      this.blocked = undefined;
      this.state = "idle";
    }
    return set;
  }

  status(): QueueStatus {
    const remaining = this.waiting.length + (this.current ? 1 : 0);
    const status: QueueStatus = {
      state: this.state,
      done: this.done,
      total: this.done + remaining,
      failed: this.failed,
      pendingFailures: this.pendingFailures,
      etaSeconds: Math.round((remaining * this.delayMs) / 1000),
      waiting: [...this.waiting],
      found: [...this.found],
    };
    if (this.current) status.current = this.current;
    if (this.blocked) status.blocked = this.blocked;
    return status;
  }

  /** Resolves when the queue is empty or blocked. Used by tests. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private start(): void {
    if (this.running || this.waiting.length === 0) return;
    this.state = "running";
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
  }

  private async work(): Promise<void> {
    while (this.waiting.length > 0) {
      const url = this.waiting.shift()!;
      const id = tracklistId(url);
      if (id && this.store.has(id)) continue;
      this.current = url;
      try {
        const html = await this.source.fetchHtml(url);
        this.store.save(parseTracklist(html, url), html);
        this.done++;
      } catch (error) {
        if (error instanceof BlockedError) {
          this.waiting.unshift(url); // try this one again on resume
          this.current = undefined;
          this.blocked = error.message;
          this.state = "blocked";
          this.save();
          return;
        }
        // Keep the set and pause: a network, disk or parsing failure shouldn't silently lose it.
        this.failed++;
        this.pendingFailures++;
        this.waiting.unshift(url);
        this.current = undefined;
        this.blocked = `Paused on a request failure (not a site block): ${error instanceof Error ? error.message : String(error)}. Check the connection, then try again.`;
        this.state = "blocked";
        this.save();
        return;
      }
      this.current = undefined;
      this.save();
    }
    this.state = "idle";
  }
}

/** Newest set first, by the date in its URL; sets without a date go last. Stable. */
function sortNewestFirst(urls: string[]): void {
  urls.sort((a, b) => (dateFromUrl(b) ?? "").localeCompare(dateFromUrl(a) ?? ""));
}
