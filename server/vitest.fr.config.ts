import { defineConfig } from "vitest/config";

// FR_REPORT_JSON=<path> adds vitest's JSON reporter for fr/report.mjs.
// Set by env, not CLI flags: `pnpm test:fr -- --reporter=json` hands
// vitest a literal `--` and it drops every flag after it, while without
// the `--` pnpm claims `--reporter` as its own option.
const reportJson = process.env["FR_REPORT_JSON"];

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
    ...(reportJson ? { reporters: ["default", "json"], outputFile: { json: reportJson } } : {}),
  },
});
