/**
 * `pnpm -C server trace:replay <fixture.json>`: replay a park fixture
 * through the lifecycle (replay.ts) and print each step, the park's
 * status after it, and how it ended. When the fixture carries `expected`,
 * it also says whether the replay matched, and exits 1 when it didn't.
 */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { TraceFixture } from "../../src/services/parkTrace.js";
import { replayFixture } from "./replay.js";

const path = process.argv.slice(2).find((arg) => arg !== "--");
if (!path) {
  console.error("usage: pnpm -C server trace:replay <fixture.json>");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(path, "utf8")) as TraceFixture;
const { steps, outcome } = await replayFixture(fixture);

console.log(`${fixture.name} (${fixture.parkedAt.weekday} ${fixture.parkedAt.time} New York)`);
for (const step of steps) {
  console.log(
    `  +${step.atS.toFixed(1).padStart(7)} s  ${step.what.padEnd(44)} ${step.status}  → ${step.park}`,
  );
}
console.log(`outcome: ${JSON.stringify(outcome)}`);
if (fixture.expected) {
  const matched = isDeepStrictEqual(outcome, fixture.expected);
  console.log(matched ? "matches expected" : `EXPECTED ${JSON.stringify(fixture.expected)}`);
  process.exitCode = matched ? 0 : 1;
}
