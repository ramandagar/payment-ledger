import { initSchema, closePool } from "./client.js";

const main = async () => {
  console.log("Applying schema…");
  await initSchema();
  console.log("Schema applied. ✓");
  await closePool();
};

main().catch((err) => {
  console.error("init failed:", err);
  process.exit(1);
});
