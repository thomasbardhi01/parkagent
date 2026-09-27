import { defineConfig } from "vitest/config";

// FR_REPORT_JSON=<path> adds vitest's JSON reporter for fr/report.mjs.
// Set by env, not CLI flags: `pnpm test:fr -- --reporter=json` hands
// vitest a literal `--` and it drops every flag after it, while without
// the `--` pnpm claims `--reporter` as its own option.
const reportJson = process.env["FR_REPORT_JSON"];

// Every run is shuffled — files and the tests inside them — so no test
// can lean on another having run first: each file runs as its own
// throwaway user (fr/client.ts `ownUser`). FR_SEED replays an order; the
// seed is printed, and the nightly's report carries it.
const seed = Number(process.env["FR_SEED"] ?? Math.floor(Math.random() * 2 ** 31));
if (!Number.isSafeInteger(seed))
  throw new Error(`FR_SEED must be an integer, not ${process.env["FR_SEED"]}`);
console.log(`FR suite shuffled with seed ${seed} (replay: FR_SEED=${seed} pnpm -C server test:fr)`);

// The live functional-requirements suite (docs/functional-requirements.md).
// Runs against a deployed API in dry run: `pnpm -C server test:fr`.
// One file at a time on purpose: the token endpoints' abuse limit
// (30/min) is per address, and a seed replays a run's order exactly only
// when nothing runs side by side.
export default defineConfig({
  test: {
    include: ["fr/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: { files: true, tests: true }, seed },
    // Assistant turns are real model calls; give them room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    retry: 0,
    ...(reportJson ? { reporters: ["default", "json"], outputFile: { json: reportJson } } : {}),
  },
});
