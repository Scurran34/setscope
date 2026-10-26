// Small helpers shared by song mode and artist mode.

import type { Ranked, Tracklist } from "../model.ts";

/** Keep sets played on or after `since` ("YYYY-MM-DD"). ISO dates sort as strings. */
export function filterSince(sets: Tracklist[], since: string): Tracklist[] {
  return sets.filter((s) => s.date >= since);
}

/** Keep sets played in [from, to). */
export function filterBetween(sets: Tracklist[], from: string, to: string): Tracklist[] {
  return sets.filter((s) => s.date >= from && s.date < to);
}

/** "YYYY-MM-DD" shifted back by whole months (day clamped, so Mar 31 - 1 month = Feb 28). */
export function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const totalMonths = y * 12 + (m - 1) - months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Today as "YYYY-MM-DD" in local time (UTC would flip to tomorrow in the evening in the US). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Counts how many times each key was added. `display` remembers a readable name
 * for each key: the first spelling seen wins.
 */
export class Counter {
  private counts = new Map<string, number>();
  private display = new Map<string, string>();
  private urls = new Map<string, string>();

  /** `url` is optional; the first one seen for a key is kept. */
  add(key: string, displayName: string = key, url?: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (!this.display.has(key)) this.display.set(key, displayName);
    if (url && !this.urls.has(key)) this.urls.set(key, url);
  }

  /** Highest counts first, ties broken alphabetically so output is stable. */
  top(n: number, minCount = 1): Ranked[] {
    return [...this.counts.entries()]
      .filter(([, count]) => count >= minCount)
      .map(([key, count]) => {
        const ranked: Ranked = { name: this.display.get(key) ?? key, count };
        const url = this.urls.get(key);
        if (url) ranked.url = url;
        return ranked;
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, n);
  }
}
