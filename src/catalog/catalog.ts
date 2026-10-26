// Where cached sets live. The web app uses the shared Postgres catalog (PgCatalog);
// the older file store (data/sets/*.json) implements the same interface for the
// command line and tests that don't need a database.

import type { Tracklist } from "../model.ts";

export interface Catalog {
  /** Is the set with this 1001Tracklists id already indexed? */
  has(sourceId: string): Promise<boolean>;
  /**
   * Index a set (or re-index it after a refresh) along with the page it was read from.
   * Returns how many tracklist lines changed compared with the stored version.
   */
  save(set: Tracklist, html: string): Promise<number>;
  /** Every indexed set, shaped for the analysis functions. */
  all(): Promise<Tracklist[]>;
  /** Number of indexed sets. */
  count(): Promise<number>;
}
