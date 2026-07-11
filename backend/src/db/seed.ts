import { ensureSeed } from "./seed-runner.js";
import { pool, closePool } from "./client.js";

const main = async () => {
  await ensureSeed();
  const { rows } = await pool.query("SELECT code, name FROM accounts ORDER BY code");
  console.log("Seeded accounts:");
  for (const r of rows) console.log(`  ${r.code}  ${r.name}`);
  await closePool();
};

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
