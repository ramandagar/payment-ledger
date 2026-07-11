import { pool, initSchema } from "../src/db/client.js";
import { ensureSeed } from "../src/db/seed-runner.js";

export async function setupDb() {
  await initSchema();
  await ensureSeed();
}

/** Reset to a pristine seeded state before every test (accounts included). */
export async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, ledger_entries, transactions, payments, invoice_line_items, invoices RESTART IDENTITY CASCADE`
  );
  await ensureSeed();
}

export async function closeDb() {
  await pool.end();
}
