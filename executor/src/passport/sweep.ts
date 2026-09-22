/**
 * PERSONAL-USE PROTOTYPE — see ../types.ts header and issue #37.
 *
 * READ-ONLY zone-number sweep over the Passport Find Parking feed.
 *
 * `pnpm -C executor run sweep -- --points <points.json> --out <zones.json>`
 *
 * For each probe point the sweep sets the browser's geolocation and loads
 * the Find Parking screen with the saved signed-in session
 * (storageState.passport.json); the map's "near me" load fires the
 * getnearzoneswithoccupancy API and the JSON responses are captured
 * (PR #87: the request params are AES-encrypted so the search radius is
 * whatever the app asks for, but the RESPONSE is readable). Zones are
 * deduped across probes by their pay-by-app number. Nothing here touches
 * the zone/duration/pay path — it pays for NOTHING.
 *
 * Politeness: probes run strictly sequentially with a delay between them
 * (--delay ms, default 4000) on one browser; a probe that returns zero
 * NEW zones still counts, and the dedupe makes overlapping probe circles
 * harmless. Keep the point grid coarse — the feed reaches kilometres.
 *
 * points.json: [{"lat": 42.3495, "lng": -71.0798}, ...]
 * out: {"swept_at", "probes": [...], "zones": [{"number","name","raw"}]}
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { closeWarmBrowser } from "../browser.js";
import { PassportClient } from "./client.js";
import { parseNearbyZones } from "./parse.js";

const { values: flags } = parseArgs({
  // pnpm can forward a literal "--" ahead of the flags; when it does, node
  // treats everything after it as positionals — re-parse those as flags.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    points: { type: "string" },
    out: { type: "string" },
    delay: { type: "string", default: "4000" },
    headed: { type: "boolean", default: false },
    "base-url": { type: "string" },
  },
});

if (!flags.points || !flags.out) {
  console.error(
    "Usage: pnpm -C executor run sweep -- --points <points.json> --out <zones.json> [--delay 4000] [--headed]",
  );
  process.exit(1);
}

interface ProbePoint {
  lat: number;
  lng: number;
}

const pointsRaw = JSON.parse(readFileSync(resolve(flags.points), "utf-8")) as unknown;
const points: ProbePoint[] = (Array.isArray(pointsRaw) ? pointsRaw : []).filter(
  (p): p is ProbePoint =>
    typeof p === "object" &&
    p !== null &&
    Number.isFinite((p as ProbePoint).lat) &&
    Number.isFinite((p as ProbePoint).lng),
);
if (points.length === 0) {
  console.error(`${flags.points}: no usable {lat, lng} points.`);
  process.exit(1);
}

const delayMs = Math.max(1000, Number(flags.delay) || 4000);
const statePath = resolve(
  process.env["PASSPORT_STATE_PATH"] ??
    fileURLToPath(new URL("../../storageState.passport.json", import.meta.url)),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** number -> {number, name, raw}; first sighting wins, raw kept verbatim. */
const zonesByNumber = new Map<string, { number: string; name: string; raw: unknown }>();
const probes: { lat: number; lng: number; responses: number; rows: number; newZones: number }[] =
  [];

try {
  for (const [index, point] of points.entries()) {
    // A fresh context per probe (same warm Chromium process): the app's
    // "near me" load only fires on the first Find Parking entry, and a
    // fresh context re-reads the (new) geolocation cleanly.
    const client = new PassportClient({
      statePath,
      sharedBrowser: true,
      headless: !flags.headed,
      ...(flags["base-url"] ? { baseUrl: flags["base-url"] } : {}),
    });
    let added = 0;
    let rows = 0;
    let responses = 0;
    try {
      const result = await client.findParking(undefined, point);
      if (!result.ok) {
        console.error(
          `probe ${index + 1}/${points.length} (${point.lat}, ${point.lng}): ${result.code} — ${result.message}`,
        );
        if (result.code === "auth_expired") process.exit(2); // every later probe would fail the same way
        probes.push({ ...point, responses: 0, rows: 0, newZones: 0 });
        continue;
      }
      responses = result.nearbyResponses.length;
      for (const body of result.nearbyResponses) {
        const data = (body as { data?: unknown }).data;
        if (!Array.isArray(data)) continue;
        for (const raw of data) {
          // parseNearbyZones is the pinned validity check; run it per row
          // so each parsed zone keeps its own raw feed row alongside.
          const parsed = parseNearbyZones({ data: [raw] });
          if (parsed.length !== 1) continue;
          rows += 1;
          const zone = parsed[0]!;
          if (!zonesByNumber.has(zone.number)) {
            zonesByNumber.set(zone.number, { number: zone.number, name: zone.name, raw });
            added += 1;
          }
        }
      }
      probes.push({ ...point, responses, rows, newZones: added });
      console.log(
        `probe ${index + 1}/${points.length} (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}): ` +
          `${responses} responses, ${rows} rows, +${added} new (total ${zonesByNumber.size})`,
      );
    } finally {
      await client.close();
    }
    if (index < points.length - 1) await sleep(delayMs);
  }
} finally {
  await closeWarmBrowser();
}

const out = {
  swept_at: new Date().toISOString(),
  source: "passport getnearzoneswithoccupancy (Find Parking feed)",
  probe_count: probes.length,
  probes,
  zones: [...zonesByNumber.values()].sort((a, b) => Number(a.number) - Number(b.number)),
};
writeFileSync(resolve(flags.out), JSON.stringify(out, null, 1));
console.log(`\nWrote ${zonesByNumber.size} distinct zones -> ${flags.out}`);
