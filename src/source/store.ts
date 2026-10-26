// The file cache (used by tests, and the source for `npm run db:import`). The web app
// and CLI use the shared Postgres catalog instead; both implement Catalog.
// Each set is stored twice:
//   data/html/<id>.html  the raw page, so a parser fix can re-read it without refetching
//   data/sets/<id>.json  the parsed Tracklist, which the analysis reads
// Once a set is here it is never fetched again.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog } from "../catalog/catalog.ts";
import type { Tracklist } from "../model.ts";
import { parseTracklist } from "./parse.ts";

export class TracklistStore implements Catalog {
  private readonly htmlDir: string;
  private readonly setsDir: string;

  constructor(dataDir: string) {
    this.htmlDir = join(dataDir, "html");
    this.setsDir = join(dataDir, "sets");
    mkdirSync(this.htmlDir, { recursive: true });
    mkdirSync(this.setsDir, { recursive: true });
  }

  async has(id: string): Promise<boolean> {
    return existsSync(this.setPath(id));
  }

  /** The file cache doesn't track line changes, so this always reports 0. */
  async save(set: Tracklist, html: string): Promise<number> {
    writeFileSync(join(this.htmlDir, `${set.id}.html`), html);
    writeFileSync(this.setPath(set.id), JSON.stringify(set, null, 2));
    return 0;
  }

  async all(): Promise<Tracklist[]> {
    return this.allSync();
  }

  async count(): Promise<number> {
    return this.allSync().length;
  }

  allSync(): Tracklist[] {
    return readdirSync(this.setsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.setsDir, f), "utf8")) as Tracklist);
  }

  /** Re-parse every cached HTML page (after a parser change). No network. */
  reparseAll(): number {
    let count = 0;
    for (const set of this.allSync()) {
      const htmlPath = join(this.htmlDir, `${set.id}.html`);
      if (!existsSync(htmlPath)) continue;
      const reparsed = parseTracklist(readFileSync(htmlPath, "utf8"), set.url);
      writeFileSync(this.setPath(set.id), JSON.stringify(reparsed, null, 2));
      count++;
    }
    return count;
  }

  private setPath(id: string): string {
    return join(this.setsDir, `${id}.json`);
  }
}
