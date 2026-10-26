// The database connection. DATABASE_URL picks the database; by default it's the
// project-local one that scripts/db.sh runs.

import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://setscope@127.0.0.1:54329/setscope";

// Return dates ("YYYY-MM-DD") and bigints as strings instead of JS Dates / precision-losing numbers.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Db = pg.Pool | pg.PoolClient;

export function createPool(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Run `work` in a transaction: all of it happens, or none of it does. */
export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
