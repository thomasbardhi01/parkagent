/**
 * The sign reader's live eval (Issue N): runs the golden set's sign texts
 * (test/fixtures/signs-golden.json) through the real model (Claude Sonnet
 * 5.5, structured output), grounds and compares each reading exactly as
 * POST /parked/:id/signs does, and prints one line per sample against the
 * expected verdict. CI runs the same grounding and comparison on recorded
 * outputs (test/signReader.test.ts); this is the manual check that the
 * model still answers that way. Exits 1 on any miss.
 *
 *     ANTHROPIC_API_KEY=… pnpm -C server sign:eval
 */

import { readFileSync } from "node:fs";

import { makeAnthropicModelClient } from "../services/assistant/anthropicClient.js";
import { estimateCostUsd } from "../services/assistant/loop.js";
import { SIGN_READER_MODEL } from "../services/assistant/modelClient.js";
import { interpretSigns } from "../services/capabilities/readSigns.js";
import type { HoursInterval } from "../services/hours.js";
import { compareWithZone, groundRules } from "../services/signs/signRules.js";

interface Sample {
  name: string;
  text: string;
  zoneMaxStayMinutes: number | null;
  at: string;
  expected: { verdict: string; offerMaxStayMinutes: number | null };
}

const key = process.env["ANTHROPIC_API_KEY"];
if (!key) {
  console.error("sign:eval needs ANTHROPIC_API_KEY");
  process.exit(2);
}
const golden = JSON.parse(
  readFileSync(new URL("../../test/fixtures/signs-golden.json", import.meta.url), "utf8"),
) as { zoneHours: HoursInterval[]; samples: Sample[] };
const model = makeAnthropicModelClient(key, SIGN_READER_MODEL);

let misses = 0;
let costUsd = 0;
for (const sample of golden.samples) {
  const zone = {
    zoneId: "golden",
    maxStayMinutes: sample.zoneMaxStayMinutes,
    hours: golden.zoneHours,
  };
  const read = await interpretSigns(model, sample.text);
  costUsd += estimateCostUsd(read.model, read.usage.inputTokens, read.usage.outputTokens);
  const lowConfidence = read.reading !== null && read.reading.confidence < 0.4;
  const grounded = read.reading
    ? groundRules(read.reading.rules, {
        text: sample.text,
        zoneMaxStayMinutes: zone.maxStayMinutes,
        zoneHours: zone.hours,
      })
    : { rules: [], dropped: [] };
  const unreadable = read.reading === null || read.reading.unreadable || lowConfidence;
  const got = compareWithZone(
    { rules: unreadable ? [] : grounded.rules, unreadable },
    zone,
    new Date(sample.at),
    zone.maxStayMinutes ?? 120,
  );
  const ok =
    got.verdict === sample.expected.verdict &&
    got.offerMaxStayMinutes === sample.expected.offerMaxStayMinutes;
  if (!ok) misses++;
  console.log(
    `${ok ? "ok  " : "MISS"} ${sample.name}: ${got.verdict}` +
      (got.offerMaxStayMinutes !== null ? ` (offer ${got.offerMaxStayMinutes} min)` : "") +
      (ok ? "" : `, expected ${sample.expected.verdict}`) +
      (read.fallback ? ` [${read.fallback}]` : "") +
      (grounded.dropped.length > 0
        ? ` dropped ${grounded.dropped.map((d) => d.why).join(",")}`
        : ""),
  );
}
console.log(
  `${golden.samples.length - misses}/${golden.samples.length} as expected, ~$${costUsd.toFixed(4)}`,
);
process.exit(misses === 0 ? 0 : 1);
