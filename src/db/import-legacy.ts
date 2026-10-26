// Copies the file cache (data/sets/*.json + data/html/*.html) into the shared catalog.
// Repeatable: re-running it re-saves the same sets and changes nothing. The files
// are left in place as a backup. `npm run db:import`
//
// Personal data (data/user.json: likes and categories) is imported into the first
// account created on the site, see src/auth/accounts.ts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PgCatalog } from "../catalog/pg-catalog.ts";
import { dataDir } from "../config.ts";
import type { Tracklist } from "../model.ts";
import { parseTracklist } from "../source/parse.ts";
import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";

export async function importLegacySets(catalog: PgCatalog, dir: string, log: (line: string) => void = () => {}) {
  const setsDir = join(dir, "sets");
  if (!existsSync(setsDir)) return { imported: 0, failed: 0 };
  const files = readdirSync(setsDir).filter((f) => f.endsWith(".json"));
  let imported = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const saved = JSON.parse(readFileSync(join(setsDir, file), "utf8")) as Tracklist;
      const htmlPath = join(dir, "html", `${saved.id}.html`);
      const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : "";
      // Re-read the saved page with the current parser when we have it: it knows the most.
      const set = html ? parseTracklist(html, saved.url) : saved;
      await catalog.save(set, html);
      imported++;
      if (imported % 50 === 0) log(`  ${imported}/${files.length}`);
    } catch (error) {
      failed++;
      log(`  skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, failed };
}

if (import.meta.main) {
  const pool = createPool();
  try {
    await migrate(pool);
    const catalog = new PgCatalog(pool);
    const started = Date.now();
    console.log(`Importing ${dataDir()} into the database…`);
    const { imported, failed } = await importLegacySets(catalog, dataDir(), (line) => console.log(line));
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${imported} sets imported, ${failed} skipped. ${await catalog.count()} sets in the catalog.`);
  } finally {
    await pool.end();
  }
}
