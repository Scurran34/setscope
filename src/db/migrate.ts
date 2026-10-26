// Applies db/migrations/*.sql in order, each exactly once, each in its own
// transaction. Safe to run any number of times: `npm run db:migrate`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { createPool, transaction } from "./pool.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "db", "migrations");

export async function migrate(pool: pg.Pool, log: (line: string) => void = () => {}): Promise<string[]> {
  await pool.query(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await pool.query<{ version: string }>("select version from schema_migrations")).rows.map((r) => r.version));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await transaction(pool, async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [file]);
    });
    log(`applied ${file}`);
    applied.push(file);
  }
  return applied;
}

if (import.meta.main) {
  const pool = createPool();
  try {
    const applied = await migrate(pool, (line) => console.log(line));
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : "Already up to date.");
  } finally {
    await pool.end();
  }
}
