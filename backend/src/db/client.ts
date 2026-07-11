import pg from "pg";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://ledger:ledger@localhost:5432/ledger",
});

export type DbClient = pg.PoolClient;

/** Run fn inside a single DB transaction. Rolls back on any throw. */
export async function withTransaction<T>(
  fn: (client: DbClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Apply schema.sql (idempotent — uses IF NOT EXISTS). Safe to call on every boot. */
export async function initSchema(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
