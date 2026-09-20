/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * `pnpm -C executor run record -- --flow start --zone 110436 --minutes 15`
 *
 * Recording harness: drives one flow against the REAL ParkNYC site with
 * tracing on, saving to executor/fixtures/<flow>-<stamp>/ (gitignored):
 *   - har.har            every request/response
 *   - trace.zip          Playwright trace (screenshots + DOM snapshots)
 *   - NN-<step>.html/.png  page snapshot at each named step
 *
 * ⚠ `--flow start` and `--flow extend` PAY A REAL METER with the signed-in
 * account's payment method. Use a cheap zone and the minimum duration.
 * Sanitize any HTML you copy into test/fixtures/pages/ (account details,
 * plate, cookies) before committing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ParkNycClient } from "./parknyc/client.js";

const { values: flags } = parseArgs({
  options: {
    flow: { type: "string" }, // start | extend | stop
    zone: { type: "string" },
    plate: { type: "string" },
    minutes: { type: "string", default: "15" },
    session: { type: "string" }, // providerSessionId for extend/stop
    yes: { type: "boolean", default: false },
  },
});

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C executor run record -- --flow start --zone <zoneNumber> [--plate <plate>] [--minutes 15]",
      "  pnpm -C executor run record -- --flow extend --session <providerSessionId> [--minutes 15]",
      "  pnpm -C executor run record -- --flow stop --session <providerSessionId>",
    ].join("\n"),
  );
  process.exit(1);
}

const flow = flags.flow;
if (flow !== "start" && flow !== "extend" && flow !== "stop") usage();
if (flow === "start" && !flags.zone) usage();
if ((flow === "extend" || flow === "stop") && !flags.session) usage();
const minutes = Number(flags.minutes);

if (!flags.yes && flow !== "stop") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This drives the real ParkNYC site and WILL charge your payment method (${flow}, ${minutes} min). Type "pay" to continue: `,
  );
  rl.close();
  if (answer.trim() !== "pay") {
    console.log("Aborted; nothing was driven.");
    process.exit(0);
  }
}

const statePath = resolve(
  process.env["PARKNYC_STATE_PATH"] ??
    fileURLToPath(new URL("../storageState.json", import.meta.url)),
);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = fileURLToPath(new URL(`../fixtures/${flow}-${stamp}/`, import.meta.url));
mkdirSync(outDir, { recursive: true });

let stepIndex = 0;
const client = new ParkNycClient({
  statePath,
  headless: false, // watch it work; this is a debugging tool
  captureDir: outDir,
  recordHarPath: join(outDir, "har.har"),
  tracePath: join(outDir, "trace.zip"),
  onStep: async (name, page) => {
    stepIndex += 1;
    const prefix = join(outDir, `${String(stepIndex).padStart(2, "0")}-${name}`);
    writeFileSync(`${prefix}.html`, await page.content());
    await page.screenshot({ path: `${prefix}.png`, fullPage: true });
  },
});

try {
  const result =
    flow === "start"
      ? await client.startSession(flags.zone!, flags.plate, minutes)
      : flow === "extend"
        ? await client.extendSession(flags.session!, minutes)
        : await client.stopSession(flags.session!);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nRecording saved to ${outDir}`);
  console.log("Copy sanitized page HTML into test/fixtures/pages/ to grow the unit tests.");
  process.exitCode = result.ok ? 0 : 2;
} finally {
  await client.close();
}
