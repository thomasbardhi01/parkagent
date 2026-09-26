/**
 * The device-test phrases through the REAL place search — no model:
 * each place goes through geocode_place exactly as the assistant calls it
 * (the Apple Maps → Nominatim chain, the phone's city bias, the
 * found / closest / ambiguous classification), from a phone in Braintree
 * — just outside the Boston box, where the 2026-09-25 test was sent.
 * Where the real place is known, prints how far the answer landed from it.
 *
 *   pnpm -C server verify:places
 *   pnpm -C server verify:places --places "Lola 42 Seaport,TD Garden"
 *   pnpm -C server verify:places --from 42.3505,-71.0495
 *
 * Reads APPLE_MAPS_* from the repo-root .env (without them it's the
 * Nominatim fallback alone — which is the point of running it both ways).
 * Read-only, low volume, spaced out for Nominatim's courtesy limit.
 * Nothing is written: the tools' audit rows go nowhere.
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
import { PolicyService } from "../services/policy.js";

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

  // Only the audit is ever written; it goes nowhere.
  const db = { decision: { create: async () => ({ id: "verify" }) } } as unknown as AppDb;
  const tools = new AssistantTools({
    db,
    policy: new PolicyService(
      fileURLToPath(new URL("../../../policy.json", import.meta.url)),
      true,
    ),
    findCandidates: async () => [],
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
  }
}

await main();
