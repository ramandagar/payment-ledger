import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All DB-backed suites share ONE database, so files MUST run serially —
    // otherwise one file's TRUNCATE wipes another's data mid-test.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ["dotenv/config"],
    testTimeout: 15000,
  },
});
