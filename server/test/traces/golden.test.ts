/**
 * The golden park traces: every fixture in this directory, replayed
 * through the lifecycle, ends as it says it does. A field-test park
 * becomes one with `trace:export` and an `expected` written from what the
 * park should have done (docs/park-traces.md).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { TraceFixture } from "../../src/services/parkTrace.js";
import { replayFixture } from "./replay.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
const fixtures = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as TraceFixture);

test("the golden set has its seeds", () => {
  expect(fixtures.map((f) => f.name).sort()).toEqual(
    expect.arrayContaining([
      "get-in-and-drive",
      "heartbeat-resend",
      "normal-walk-away",
      "red-light",
    ]),
  );
  for (const fixture of fixtures) expect(fixture.expected, fixture.name).toBeDefined();
});

for (const fixture of fixtures) {
  test(`trace ${fixture.name}: ${fixture.note ?? "replays as expected"}`, async () => {
    const { outcome } = await replayFixture(fixture);
    expect(outcome).toEqual(fixture.expected);
  });
}
