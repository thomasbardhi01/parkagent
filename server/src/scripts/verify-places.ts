/**
 * The device-test phrases through the REAL place search and street
 * search — no model: each place goes through geocode_place exactly as the
 * assistant calls it (the Apple Maps → Nominatim chain, the phone's city
 * bias, the found / closest / ambiguous classification), from a phone in
 * Braintree — just outside the Boston box, where the 2026-09-25 test was
 * sent. Where the real place is known, prints how far the answer landed
 * from it. With DATABASE_URL set, each found place then goes through
 * quote_street (the walking-radius zone search) for the stay, default next
 * Saturday 7–10 PM, and prints the street options in the card's words.
 *
 *   pnpm -C server verify:places
 *   pnpm -C server verify:places --places "Lola 42 Seaport,TD Garden"
 *   pnpm -C server verify:places --from 42.3505,-71.0495
 *   pnpm -C server verify:places --when 2026-09-28T14:00:00 --minutes 120
 *
 * Reads APPLE_MAPS_* and DATABASE_URL from the repo-root .env (without the
 * Apple keys it's the Nominatim fallback alone — which is the point of
 * running it both ways). Read-only, low volume, spaced out for Nominatim's
 * courtesy limit. Nothing is written: the tools' audit rows go nowhere.
 */

import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { AppleMapsGeocoder } from "../services/assistant/appleMaps.js";
import {
  FallbackGeocoder,
  metersBetween,
  NominatimGeocoder,
} from "../services/assistant/geocoder.js";
import type { GeocoderProvider } from "../services/assistant/geocoder.js";
import { AssistantTools } from "../services/assistant/tools.js";
import type { AppDb } from "../db.js";
import { asAppDb, createPrisma } from "../db.js";
import { easternWallClock, nycWeekdayAndMinute, parseEasternTime } from "../services/hours.js";
import { PolicyService } from "../services/policy.js";
import type { StreetOption } from "../services/assistant/streetOptions.js";
import { makeCandidateFetcher, makeNearbyZoneFetcher } from "../services/zoneLookup.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

/** The places, and where they really are (for the distance check). */
const DEFAULT_PLACES: { query: string; real?: { lat: number; lng: number; what: string } }[] = [
  { query: "Lola 42 Seaport", real: { lat: 42.35458, lng: -71.04526, what: "22 Liberty Dr" } },
  { query: "Lola 42", real: { lat: 42.35458, lng: -71.04526, what: "22 Liberty Dr" } },
  {
    query: "Moo steakhouse Seaport Boston",
    real: { lat: 42.34945, lng: -71.05034, what: "49 Melcher St" },
  },
  { query: "Moo steakhouse" },
  { query: "Seaport" },
  { query: "TD Garden", real: { lat: 42.36621, lng: -71.06216, what: "100 Legends Way" } },
];

const BRAINTREE = { lat: 42.2206, lng: -71.0041 };
const COURTESY_DELAY_MS = 1200;

/** Next Saturday 7 PM ET (today's, if it's Saturday before 7). */
function nextSaturdayEvening(now: Date): string {
  for (let d = 0; d < 8; d += 1) {
    const t = new Date(now.getTime() + d * 24 * 60 * 60_000);
    const { weekday, minute } = nycWeekdayAndMinute(t);
    if (weekday === "Sat" && (d > 0 || minute < 19 * 60)) {
      return `${easternWallClock(t).slice(0, 10)}T19:00:00`;
    }
  }
  return `${easternWallClock(now).slice(0, 10)}T19:00:00`;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  // pnpm 12 forwards a literal "--"; drop it.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const only = flag(argv, "places");
  const places = only
    ? only
        .split(",")
        .map((q) => DEFAULT_PLACES.find((p) => p.query === q.trim()) ?? { query: q.trim() })
    : DEFAULT_PLACES;
  const fromArg = flag(argv, "from");
  const from = fromArg
    ? { lat: Number(fromArg.split(",")[0]), lng: Number(fromArg.split(",")[1]) }
    : BRAINTREE;

  const env = process.env;
  const chain: GeocoderProvider[] = [];
  if (env["APPLE_MAPS_KEY"] && env["APPLE_MAPS_KEY_ID"] && env["APPLE_MAPS_TEAM_ID"]) {
    chain.push(
      new AppleMapsGeocoder({
        privateKey: env["APPLE_MAPS_KEY"],
        keyId: env["APPLE_MAPS_KEY_ID"],
        teamId: env["APPLE_MAPS_TEAM_ID"],
      }),
    );
  }
  chain.push(new NominatimGeocoder());
  console.log(
    `place search: ${chain.length > 1 ? "Apple Maps → Nominatim" : "Nominatim only (APPLE_MAPS_* not set)"}`,
  );
  console.log(`phone at ${from.lat}, ${from.lng}\n`);

  const when = flag(argv, "when") ?? nextSaturdayEvening(new Date());
  const minutes = Number(flag(argv, "minutes") ?? 180);
  const prisma = env["DATABASE_URL"] ? createPrisma(env["DATABASE_URL"]) : null;
  if (prisma) {
    console.log(`street search: ${minutes} min from ${when} ET\n`);
  } else {
    console.log("street search: skipped (no DATABASE_URL)\n");
  }
  // Reads go to the zone tables; the audit is the only write, and it goes
  // nowhere.
  const noAudit = { create: async () => ({ id: "verify" }) };
  const db = prisma
    ? (new Proxy(asAppDb(prisma), {
        get: (target, prop) =>
          prop === "decision"
            ? noAudit
            : (target as unknown as Record<string | symbol, unknown>)[prop],
      }) as AppDb)
    : ({ decision: noAudit } as unknown as AppDb);
  const tools = new AssistantTools({
    db,
    policy: new PolicyService(
      fileURLToPath(new URL("../../../policy.json", import.meta.url)),
      true,
    ),
    findCandidates: prisma ? makeCandidateFetcher(prisma) : async () => [],
    ...(prisma ? { findNearbyZones: makeNearbyZoneFetcher(prisma) } : {}),
    garage: {
      id: "none",
      canReserve: false,
      search: async () => ({ ok: true, options: [], fromCache: false }),
      optionById: () => null,
      book: async () => {
        throw new Error("verify-places never books");
      },
    },
    geocoder: new FallbackGeocoder(chain),
  });

  for (const [index, place] of places.entries()) {
    if (index > 0) await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    const ctx = { userId: "verify", conversationId: "verify", location: from };
    const out = await tools.execute(ctx, "geocode_place", { query: place.query });
    const r = out.result as Record<string, unknown>;
    let line: string;
    if (r["ambiguous"] === true) {
      const choices = r["choices"] as { label: string }[];
      line = `AMBIGUOUS → ${choices.map((c) => c.label).join(" | ")}`;
    } else if (r["found"] === true) {
      const p = r["place"] as {
        displayName: string;
        lat: number;
        lng: number;
        kind: string | null;
      };
      const off = place.real
        ? Math.round(metersBetween(p.lat, p.lng, place.real.lat, place.real.lng))
        : null;
      line =
        `${r["match"] === "exact" ? "FOUND" : "CLOSEST ONLY"} ${p.displayName} (${p.kind ?? "?"}) ` +
        `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` +
        (off !== null ? ` — ${off} m from ${place.real!.what}${off <= 300 ? " ✓" : " ✗"}` : "");
    } else {
      line = `NOT FOUND (${String(r["error"] ?? r["instruction"] ?? "")})`.slice(0, 160);
    }
    console.log(`${place.query.padEnd(32)} ${line}`);
    if (prisma && r["found"] === true && r["ambiguous"] !== true) {
      const p = r["place"] as { lat: number; lng: number };
      const street = await tools.execute(ctx, "quote_street", {
        lat: p.lat,
        lng: p.lng,
        duration_minutes: minutes,
        when: parseEasternTime(when) ? when : `${when}:00`,
      });
      const s = street.result as { found: boolean; reason?: string; options?: StreetOption[] };
      if (!s.found) console.log(`${"".padEnd(32)}   street: ${s.reason ?? "none"}`);
      for (const o of s.options ?? []) {
        console.log(`${"".padEnd(32)}   street: ${o.summary} · $${o.costUsd.toFixed(2)}`);
      }
    }
  }
  await prisma?.$disconnect();
}

await main();
