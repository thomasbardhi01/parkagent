/**
 * PERSONAL-USE PROTOTYPE — this package drives a parking provider's own web
 * app with the owner's account, for the owner's own parking only. It is not
 * a shipping integration: automating a consumer app sits outside its
 * intended use and likely its Terms of Service, acceptable only as a
 * personal experiment. Issue #37 tracks moving this package to a private
 * repo; it must move before any customer uses it.
 *
 * `pnpm -C executor run record -- --flow start --zone 110436 --minutes 15`
 *
 * Recording harness: drives one flow against the REAL provider site with
 * tracing on, saving to executor/fixtures/<provider>-<flow>-<stamp>/
 * (gitignored): har.har, trace.zip, and NN-<step>.html/.png per screen.
 *
 * Flows: start | extend | stop. (`resolve` is retired: the 2026-09-21
 * recording showed ParkBoston has no map — asking for it just prints an
 * explanation. ParkNYC's map cross-check records inside --flow start when
 * --lat/--lng are given.)
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
    ].join("\n"),
  );
  process.exit(1);
}

const provider = flags.provider;
if (provider !== "parknyc" && provider !== "passport") usage();
const flow = flags.flow;
if (flow !== "start" && flow !== "extend" && flow !== "stop" && flow !== "resolve") usage();
const hasCoords = flags.lat !== undefined && flags.lng !== undefined;
// Every start types a zone number now — Passport included (no map).
if (flow === "start" && !flags.zone) usage();
if ((flow === "extend" || flow === "stop") && !flags.session) usage();
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
    // The 2026-09-21 recording settled it: the ParkBoston web app has no
    // map — signed-in navigation lands on Enter Zone. Zone numbers come
    // from users (POST /zones/:zoneId/provider-number); ParkNYC's map runs
    // only as the non-fatal cross-check inside --flow start.
    result =
      "resolve is gone: ParkBoston has no map (2026-09-21 recording). " +
      "Record --flow start with --zone; for parknyc add --lat/--lng and read zoneResolution.";
  } else if (flow === "start") {
    result =
      client instanceof PassportClient
        ? await client.startSession(flags.zone ?? "", flags.plate, minutes)
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
  // Never dump diagnostics raw: pageText is 20 KB of a signed-in account
  // page and screenshotBase64 is half a megabyte of JPEG — both are already
  // on disk in outDir for anyone who needs them.
  console.log(
    JSON.stringify(
      result,
      (key, value: unknown) => {
        if (key === "screenshotBase64" && typeof value === "string") {
          return `<${value.length} chars omitted — see ${outDir}>`;
        }
        if (key === "pageText" && typeof value === "string" && value.length > 400) {
          return `${value.slice(0, 400)}… <truncated — see ${outDir}>`;
        }
        return value;
      },
      2,
    ),
  );
  console.log(`\nRecording saved to ${outDir}`);
  console.log("Copy sanitized page HTML into test/fixtures/pages/ to grow the unit tests.");
  const failed =
    typeof result === "object" && result !== null && (result as { ok?: boolean }).ok === false;
  process.exitCode = failed ? 2 : 0;
} finally {
  await client.close();
}
