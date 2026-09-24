import { defineConfig } from "vitest/config";

// The default suite: fast, hermetic unit tests over the fake DB. The live
// functional-requirements suite lives in fr/ and runs only via
// `pnpm -C server test:fr` (vitest.fr.config.ts) — it needs a reachable
// API and an FR_API_KEY, so it must never ride along with `pnpm -r test`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
