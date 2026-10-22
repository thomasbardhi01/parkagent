import { defineConfig } from "vitest/config";

// The real-Postgres suite: `pnpm -C server test:pg`, against a migrated,
// throwaway database named by TEST_PG_DATABASE_URL (CI's server-pg job).
// Its files end in .pg.ts so the default fake-DB suite (vitest.config.ts,
// test/**/*.test.ts) never picks them up. One file at a time: they share
// one database.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["**/*.pg.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
