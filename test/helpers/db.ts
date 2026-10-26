// A throwaway Postgres schema per test file, in the setscope_test database, so test
// files can run in parallel without touching each other or your real data.
// If the local database isn't running, database tests are skipped (and say so).

import pg from "pg";
import { migrate } from "../../src/db/migrate.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://setscope@127.0.0.1:54329/setscope_test";

export async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: TEST_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    return true;
  } catch {
    console.warn(`Database tests skipped: no Postgres at ${TEST_URL} (run: npm run db:start)`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** A fresh, migrated schema named after the test file. */
export async function freshSchema(name: string): Promise<pg.Pool> {
  const schema = `test_${name.replace(/\W/g, "_")}`;
  const admin = new pg.Client({ connectionString: TEST_URL });
  await admin.connect();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: TEST_URL, options: `-c search_path=${schema}` });
  await migrate(pool);
  return pool;
}
