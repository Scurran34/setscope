// Settings shared by the CLI and the web server.

import { join } from "node:path";
import { monthsBefore, today } from "./analysis/common.ts";

/** Default freshness cutoff: sets older than this many months are ignored. */
export const DEFAULT_MONTHS = 18;

/** Where the cache lives. Override with SETSCOPE_DATA. */
export function dataDir(): string {
  return process.env.SETSCOPE_DATA ?? join(import.meta.dirname, "..", "data");
}

/** "YYYY-MM-DD" cutoff for "the last N months". */
export function sinceMonths(months: number = DEFAULT_MONTHS): string {
  return monthsBefore(today(), months);
}
