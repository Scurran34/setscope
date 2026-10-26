// Background collecting: while your own queue is quiet, slowly cache the sets on the
// 1001Tracklists front page (new and featured sets), so reports and trending have more
// to work with. It's a switch you turn on, and it stays well inside the site's limits:
//
//   - only when your queue isn't fetching or paused (your requests come first)
//   - the front page at most once an hour, then one set every 90 seconds
//   - at most 100 sets a day
//   - any sign of a block pauses it for 24 hours (no retries, no workarounds)
//   - the same fetcher as everything else: honest User-Agent, 8s minimum gap

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BlockedError } from "./fetcher.ts";
import { dateFromUrl, extractTracklistUrls, parseTracklist, tracklistId } from "./parse.ts";
import type { FetchQueue } from "./queue.ts";
import type { Catalog } from "../catalog/catalog.ts";

export type BackgroundState = "off" | "collecting" | "waiting-for-queue" | "resting" | "daily-limit" | "paused";

export interface BackgroundStatus {
  enabled: boolean;
  state: BackgroundState;
  /** Sets cached by the collector today. */
  today: number;
  dailyCap: number;
  /** Front-page sets still to fetch. */
  pending: number;
  /** ISO time the collector may run again after a block. */
  pausedUntil?: string;
  lastError?: string;
}

export interface CollectorSource {
  fetchFrontPage(): Promise<string>;
  fetchHtml(url: string): Promise<string>;
}

export interface CollectorOptions {
  saveFile?: string;
  now?: () => number;
  /** Cutoff for which sets are worth caching. */
  since: () => string;
  frontPageEveryMs?: number;
  gapMs?: number;
  dailyCap?: number;
  pauseMs?: number;
}

interface Saved {
  enabled: boolean;
  day: string;
  today: number;
  pending: string[];
  lastChecked: number;
  lastRequestAt: number;
  pausedUntil: number;
  lastError?: string;
}

export class BackgroundCollector {
  private readonly store: Catalog;
  private readonly queue: FetchQueue;
  private readonly source: CollectorSource;
  private readonly saveFile: string | undefined;
  private readonly now: () => number;
  private readonly since: () => string;
  private readonly frontPageEveryMs: number;
  private readonly gapMs: number;
  private readonly dailyCap: number;
  private readonly pauseMs: number;
  private busy = false;
  private s: Saved = { enabled: false, day: "", today: 0, pending: [], lastChecked: 0, lastRequestAt: 0, pausedUntil: 0 };

  constructor(store: Catalog, queue: FetchQueue, source: CollectorSource, options: CollectorOptions) {
    this.store = store;
    this.queue = queue;
    this.source = source;
    this.saveFile = options.saveFile;
    this.now = options.now ?? Date.now;
    this.since = options.since;
    this.frontPageEveryMs = options.frontPageEveryMs ?? 60 * 60_000;
    this.gapMs = options.gapMs ?? 90_000;
    this.dailyCap = options.dailyCap ?? 100;
    this.pauseMs = options.pauseMs ?? 24 * 60 * 60_000;
    if (this.saveFile && existsSync(this.saveFile)) {
      this.s = { ...this.s, ...(JSON.parse(readFileSync(this.saveFile, "utf8")) as Partial<Saved>) };
    }
  }

  setEnabled(enabled: boolean): void {
    this.s.enabled = enabled;
    this.save();
  }

  status(): BackgroundStatus {
    this.rollDay();
    const status: BackgroundStatus = {
      enabled: this.s.enabled,
      state: this.state(),
      today: this.s.today,
      dailyCap: this.dailyCap,
      pending: this.s.pending.length,
    };
    if (this.s.pausedUntil > this.now()) status.pausedUntil = new Date(this.s.pausedUntil).toISOString();
    if (this.s.lastError) status.lastError = this.s.lastError;
    return status;
  }

  /** Called every few seconds by a timer. Makes at most one request. */
  async tick(): Promise<void> {
    if (this.busy || this.state() !== "collecting") return;
    this.busy = true;
    try {
      await this.step();
    } finally {
      this.busy = false;
    }
  }

  private state(): BackgroundState {
    if (!this.s.enabled) return "off";
    if (this.s.pausedUntil > this.now()) return "paused";
    this.rollDay();
    if (this.s.today >= this.dailyCap) return "daily-limit";
    const q = this.queue.status().state;
    if (q !== "idle") return "waiting-for-queue";
    if (this.now() - this.s.lastRequestAt < this.gapMs) return "resting";
    if (this.s.pending.length === 0 && this.now() - this.s.lastChecked < this.frontPageEveryMs) return "resting";
    return "collecting";
  }

  private async step(): Promise<void> {
    let url: string | undefined;
    try {
      if (this.s.pending.length === 0) {
        this.s.lastRequestAt = this.s.lastChecked = this.now();
        const since = this.since();
        const fresh: string[] = [];
        for (const link of extractTracklistUrls(await this.source.fetchFrontPage())) {
          if ((dateFromUrl(link) ?? since) >= since && !(await this.store.has(tracklistId(link) ?? ""))) fresh.push(link);
        }
        this.s.pending = fresh.sort((a, b) => (dateFromUrl(b) ?? "").localeCompare(dateFromUrl(a) ?? ""));
        return;
      }
      url = this.s.pending.shift()!;
      if (await this.store.has(tracklistId(url) ?? "")) return; // cached meanwhile (e.g. by your queue)
      this.s.lastRequestAt = this.now();
      const html = await this.source.fetchHtml(url);
      await this.store.save(parseTracklist(html, url), html);
      this.s.today++;
      delete this.s.lastError;
    } catch (error) {
      this.s.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof BlockedError) {
        this.s.pausedUntil = this.now() + this.pauseMs;
        if (url) this.s.pending.unshift(url); // try it again after the pause
      }
    } finally {
      this.save();
    }
  }

  private rollDay(): void {
    const day = new Date(this.now()).toDateString();
    if (day !== this.s.day) {
      this.s.day = day;
      this.s.today = 0;
    }
  }

  private save(): void {
    if (this.saveFile) writeFileSync(this.saveFile, JSON.stringify(this.s, null, 2));
  }
}
