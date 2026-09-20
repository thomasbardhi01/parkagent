/**
 * PERSONAL-USE PROTOTYPE — this package drives a parking provider's own web
 * app with the owner's account, for the owner's own parking only. It is not
 * a shipping integration: automating a consumer app sits outside its
 * intended use and likely its Terms of Service, acceptable only as a
 * personal experiment. Issue #37 tracks moving this package to a private
 * repo; it must move before any customer uses it.
 *
 * `pnpm -C executor run record -- --flow start --zone 110436 --minutes 15`
 * `pnpm -C executor run record -- --provider passport --flow resolve --lat 42.3495 --lng -71.0798`
 *
 * Recording harness: drives one flow against the REAL provider site with
 * tracing on, saving to executor/fixtures/<provider>-<flow>-<stamp>/
 * (gitignored): har.har, trace.zip, and NN-<step>.html/.png per screen.
 *
 * Flows: start | extend | stop | resolve. `resolve` (Passport, and ParkNYC's
 * cross-check) drives ONLY the map-based zone resolution — it never reaches
 * a payment screen, so it is the safe first recording to make in Boston.
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
import { PassportClient } from "./passport/client.js";

const { values: flags } = parseArgs({
  options: {
    provider: { type: "string", default: "parknyc" }, // parknyc | passport
    flow: { type: "string" }, // start | extend | stop | resolve
    zone: { type: "string" },
    plate: { type: "string" },
    minutes: { type: "string", default: "15" },
    session: { type: "string" }, // providerSessionId for extend/stop
    lat: { type: "string" }, // resolve / map-resolved start
    lng: { type: "string" },
    street: { type: "string" }, // expected street for the mismatch guard
    yes: { type: "boolean", default: false },
  },
});

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C executor run record -- [--provider parknyc|passport] --flow start --zone <zoneNumber> [--plate <plate>] [--minutes 15] [--lat .. --lng .. [--street ..]]",
      "  pnpm -C executor run record -- [--provider ..] --flow extend --session <providerSessionId> [--minutes 15]",
      "  pnpm -C executor run record -- [--provider ..] --flow stop --session <providerSessionId>",
      "  pnpm -C executor run record -- [--provider ..] --flow resolve --lat <lat> --lng <lng>   # map only, pays nothing",
    ].join("\n"),
  );
  process.exit(1);
}

const provider = flags.provider;
if (provider !== "parknyc" && provider !== "passport") usage();
const flow = flags.flow;
if (flow !== "start" && flow !== "extend" && flow !== "stop" && flow !== "resolve") usage();
const hasCoords = flags.lat !== undefined && flags.lng !== undefined;
if (flow === "start" && !flags.zone && !(provider === "passport" && hasCoords)) usage();
if ((flow === "extend" || flow === "stop") && !flags.session) usage();
if (flow === "resolve" && !hasCoords) usage();
const minutes = Number(flags.minutes);

if (!flags.yes && (flow === "start" || flow === "extend")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This drives the real ${provider} site and WILL charge your payment method (${flow}, ${minutes} min). Type "pay" to continue: `,
  );
  rl.close();
  if (answer.trim() !== "pay") {
    console.log("Aborted; nothing was driven.");
    process.exit(0);
  }
}

const stateDefaults = {
  parknyc: { envVar: "PARKNYC_STATE_PATH", file: "../storageState.json" },
  passport: { envVar: "PASSPORT_STATE_PATH", file: "../storageState.passport.json" },
} as const;
const statePath = resolve(
  process.env[stateDefaults[provider].envVar] ??
    fileURLToPath(new URL(stateDefaults[provider].file, import.meta.url)),
);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = fileURLToPath(new URL(`../fixtures/${provider}-${flow}-${stamp}/`, import.meta.url));
mkdirSync(outDir, { recursive: true });

let stepIndex = 0;
const clientOptions = {
  statePath,
  headless: false, // watch it work; this is a debugging tool
  captureDir: outDir,
  recordHarPath: join(outDir, "har.har"),
  tracePath: join(outDir, "trace.zip"),
  onStep: async (name: string, page: import("playwright").Page) => {
    stepIndex += 1;
    const prefix = join(outDir, `${String(stepIndex).padStart(2, "0")}-${name}`);
    writeFileSync(`${prefix}.html`, await page.content());
    await page.screenshot({ path: `${prefix}.png`, fullPage: true });
  },
};
const client =
  provider === "passport" ? new PassportClient(clientOptions) : new ParkNycClient(clientOptions);

const resolveArgs = hasCoords
  ? {
      carLat: Number(flags.lat),
      carLng: Number(flags.lng),
      ...(flags.street ? { expectedStreet: flags.street } : {}),
    }
  : undefined;

try {
  let result: unknown;
  if (flow === "resolve") {
    result =
      client instanceof PassportClient
        ? await client.resolveZoneFromMap(resolveArgs!)
        : // ParkNYC's resolver is private (non-fatal cross-check); record it
          // through a start that stops at the map by omitting the zone: not
          // supported — use the passport resolve flow, or run start with
          // --lat/--lng and read the zoneResolution off the result.
          "resolve is a passport flow; for parknyc run --flow start with --lat/--lng";
  } else if (flow === "start") {
    result =
      client instanceof PassportClient
        ? await client.startSession(flags.zone ?? "", flags.plate, minutes, resolveArgs)
        : await client.startSession(
            flags.zone!,
            flags.plate,
            minutes,
            resolveArgs ? { carLat: resolveArgs.carLat, carLng: resolveArgs.carLng } : undefined,
          );
  } else if (flow === "extend") {
    result = await client.extendSession(flags.session!, minutes);
  } else {
    result = await client.stopSession(flags.session!);
  }
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nRecording saved to ${outDir}`);
  console.log("Copy sanitized page HTML into test/fixtures/pages/ to grow the unit tests.");
  const failed =
    typeof result === "object" && result !== null && (result as { ok?: boolean }).ok === false;
  process.exitCode = failed ? 2 : 0;
} finally {
  await client.close();
}
