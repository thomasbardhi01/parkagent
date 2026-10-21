// Tests for scripts/check-feature-map.mjs:
//   node --test scripts/check-feature-map.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkFeatureMap, extractEndpoints, extractPaths } from "./check-feature-map.mjs";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "feature-map-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const ROUTE = 'app.get("/card", h);\napp.post<{ Body: X }>("/card/freeze", h);\n';
const JOB = "export function tick() {}\n";

test("paths: extensions, directories and lines; endpoints and prose are not paths", () => {
  const got = extractPaths(
    "`a/b.ts:12` `c/d/` `policy.json` `POST /parked` `/health` `DRY_RUN` `x.y` `pnpm -C server test`",
  );
  assert.deepEqual(
    got.map((p) => [p.path, p.line]),
    [
      ["a/b.ts", 12],
      ["c/d/", undefined],
      ["policy.json", undefined],
    ],
  );
});

test("endpoints: generic type arguments and every method", () => {
  assert.deepEqual(extractEndpoints(ROUTE), ["GET /card", "POST /card/freeze"]);
  assert.deepEqual(extractEndpoints('scope.delete("/x/:id", h)'), ["DELETE /x/:id"]);
});

test("a complete map passes", () => {
  const root = repo({
    "server/src/routes/card.ts": ROUTE,
    "server/src/jobs/tick.ts": JOB,
    "docs/feature-map.md":
      "| `server/src/routes/card.ts:2` | `GET /card`, `POST /card/freeze` | `server/src/jobs/tick.ts` | `server/src/` |\n",
  });
  assert.deepEqual(checkFeatureMap(root), []);
});

test("a missing path, a line past the end, an unplaced job and endpoint all fail", () => {
  const root = repo({
    "server/src/routes/card.ts": ROUTE,
    "server/src/jobs/tick.ts": JOB,
    "docs/feature-map.md":
      "`server/src/routes/card.ts:99` `gone/file.ts` `GET /card/freeze` `POST /card/freeze`\n",
  });
  assert.deepEqual(checkFeatureMap(root), [
    "`server/src/routes/card.ts:99`: server/src/routes/card.ts has 3 lines",
    "`gone/file.ts`: no such path",
    // `GET /card/freeze` must not count as `GET /card`.
    "server/src/routes/card.ts: `GET /card` not in any row",
    "server/src/jobs/tick.ts: not in any row",
  ]);
});

test("the real map is clean", () => {
  assert.deepEqual(checkFeatureMap(), []);
});
