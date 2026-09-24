import { defineConfig } from "vitest/config";

// The live functional-requirements suite (docs/functional-requirements.md).
// Runs against a deployed API in dry run: `pnpm -C server test:fr`.
// Sequential on purpose — the tests share one dedicated FR user, and the
// abuse rate limits (/parked 30/min, assistant 20/min) are per user.
export default defineConfig({
  test: {
    include: ["fr/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Assistant turns are real model calls; give them room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    retry: 0,
  },
});
