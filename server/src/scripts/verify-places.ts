/**
 * The device-test phrases through the REAL place search and street
 * search — no model: each place goes through geocode_place exactly as the
 * assistant calls it (the Apple Maps → Nominatim chain, the phone's city
 * bias, the found / closest / ambiguous / none classification with its
 * confidence, and which source answered — search, autocomplete, or
 * Nominatim), from a phone in Braintree — just outside the Boston box,
 * where the 2026-09-25 test was sent. Where the real place is known,
 * prints how far the answer landed from it. With DATABASE_URL set, each
 * found place then goes through quote_street (the walking-radius zone
 * search, which reads the place and the window from the request) for the
 * stay, default next Saturday 7–10 PM, and prints the street options in
 * the card's words — with Apple's walking time where it has one ("~" marks
 * a straight-line estimate).
 *
 * Each default place says what it should come to (`expect`), and the run
 * ends with how many came out otherwise — and, with Apple configured, how
 * many street options on view kept an estimate. Exit status 1 when any
 * did. Places only Apple can find are judged only when its key is set.
 *
 * Two kinds of control keep the name rule honest in both directions. The
 * negative control is a name no place has ("Blorptastic Noodle House"): it
 * must come back not found, or as the closest thing only and under the
 * line a place is taken at. The positive controls are a real bar said by
 * its own words ("XYZ bar", "W XYZ"): they must be W XYZ Bar, taken as the
 * place at or above that line.
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
import type { SearchResult } from "../services/assistant/search.js";
import {
  NEGATIVE_CONTROL,
  POSITIVE_CONTROLS,
  meetsExpectation,
} from "../services/assistant/placeControls.js";
import type { Expectation } from "../services/assistant/placeControls.js";
import { carriesTheName } from "../services/assistant/placeMatch.js";
import { AssistantTools } from "../services/assistant/tools.js";
import type { ToolContext } from "../services/assistant/tools.js";
import type { AppDb } from "../db.js";
import { asAppDb, createPrisma } from "../db.js";
import { easternWallClock, nycWeekdayAndMinute, parseEasternTime } from "../services/hours.js";
import { PolicyService } from "../services/policy.js";
import { makeCandidateFetcher, makeNearbyZoneFetcher } from "../services/zoneLookup.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

/** The places, what they should come to, and where they really are (for
 * the distance check). `apple`: only Apple's search can find it, so it is
 * judged only when the key is set. `named`: words the answer's name must
 * hold — the place, not merely a place. What each `expect` means is
 * placeControls.ts. */
const DEFAULT_PLACES: {
  query: string;
  expect?: Expectation;
  apple?: boolean;
  named?: string;
  real?: { lat: number; lng: number; what: string };
}[] = [
  {
    query: "Lola 42 Seaport",
    expect: "found",
    apple: true,
    real: { lat: 42.35458, lng: -71.04526, what: "22 Liberty Dr" },
  },
  {
    query: "Lola 42",
    expect: "found",
    apple: true,
    real: { lat: 42.35458, lng: -71.04526, what: "22 Liberty Dr" },
  },
  // What the search reads literally and autocomplete completes (FR-44).
  {
    query: "lola42",
    expect: "found",
    apple: true,
    real: { lat: 42.35458, lng: -71.04526, what: "22 Liberty Dr" },
  },
  {
    query: "Moo steakhouse Seaport Boston",
    expect: "found",
    apple: true,
    real: { lat: 42.34945, lng: -71.05034, what: "49 Melcher St" },
  },
  { query: "Moo steakhouse", expect: "ambiguous", apple: true },
  // Neighborhoods: the area, not the Seaport Hotel (prod, 2026-10-02).
  { query: "Seaport", expect: "area" },
  { query: "Back Bay", expect: "area" },
  { query: "Fenway", expect: "area" },
  {
    query: "TD Garden",
    expect: "found",
    real: { lat: 42.36621, lng: -71.06216, what: "100 Legends Way" },
  },
  {
    query: "MFA",
    expect: "found",
    real: { lat: 42.3394, lng: -71.094, what: "465 Huntington Ave" },
  },
  { query: "Boylston and Dartmouth", expect: "found", apple: true },
  // The negative control: a name that exists nowhere. (It was "xyzzy
  // restaurant", which autocomplete answered with W XYZ Bar at 0.80 on
  // prod, 2026-10-02 — but W XYZ Bar is a real bar, in Boston and in New
  // York, so "not W XYZ Bar" was no control for "not found".)
  { query: NEGATIVE_CONTROL, expect: "unsure" },
  // The positive controls: that bar, said by its own words ("XYZ bar",
  // "W XYZ"). A whole word is the word, so each is the place, at full
  // confidence.
  ...POSITIVE_CONTROLS.queries.map((query) => ({
    query,
    expect: "sure" as const,
    apple: true,
    named: POSITIVE_CONTROLS.named,
  })),
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
  // Kept in memory so each lookup's source and confidence can be printed.
  const audits: { rule: string; outcome: Record<string, unknown> }[] = [];
  const noAudit = {
    create: async (args: { data: { rule: string; outcome: Record<string, unknown> } }) => {
      audits.push({ rule: args.data.rule, outcome: args.data.outcome });
      return { id: "verify" };
    },
  };
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
    // The chain as the server wires it (index.ts): the next source is
    // asked when this one's results don't carry the name.
    geocoder: new FallbackGeocoder(chain, carriesTheName),
  });

  const apple = chain.length > 1;
  const misses: string[] = [];
  for (const [index, place] of places.entries()) {
    if (index > 0) await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    // A fresh request per place: geocode_place makes the place the
    // request's, and quote_street then searches the request.
    const ctx: ToolContext = { userId: "verify", conversationId: "verify", location: from };
    const out = await tools.execute(ctx, "geocode_place", { query: place.query });
    const r = out.result as Record<string, unknown>;
    // geocode_place writes one row: the lookup's.
    const audit = audits[audits.length - 1];
    const failures = (audit?.outcome["failures"] as { provider: string; reason: string }[]) ?? [];
    const how =
      ` [${String(audit?.outcome["source"] ?? "no source")}` +
      (typeof r["confidence"] === "number" ? `, confidence ${r["confidence"].toFixed(2)}` : "") +
      failures.map((f) => `, ${f.provider} failed: ${f.reason}`).join("") +
      "]";
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
      if (off !== null && off > 300 && (apple || !place.apple)) {
        misses.push(`${place.query}: ${off} m from ${place.real!.what}`);
      }
    } else {
      line = `NOT FOUND (${String(r["error"] ?? r["instruction"] ?? "")})`.slice(0, 160);
    }
    let verdict = "";
    if (place.expect && (apple || !place.apple)) {
      const ok = meetsExpectation(place.expect, r, place.named);
      verdict = ok ? `  ✓ ${place.expect}` : `  ✗ expected ${place.expect}`;
      if (!ok) misses.push(`${place.query}: expected ${place.expect}`);
    } else if (place.expect) {
      verdict = "  (not judged: needs Apple)";
    }
    console.log(`${place.query.padEnd(32)} ${line}${how}${verdict}`);
    if (prisma && r["found"] === true && r["ambiguous"] !== true) {
      await tools.execute(ctx, "update_request", {
        startsAt: parseEasternTime(when) ? when : `${when}:00`,
        durationMinutes: minutes,
      });
      const street = await tools.execute(ctx, "quote_street", {});
      const s = street.result as Partial<SearchResult> & { error?: string };
      const options = [...(s.satisfying ?? []), ...(s.nearMisses ?? []).map((n) => n.option)];
      if (options.length === 0) {
        const radius = s.street ? `none within ${s.street.radiusM} m` : (s.error ?? "none");
        console.log(`${"".padEnd(32)}   street: ${radius}`);
      }
      for (const o of options) {
        const walk = `${o.walkEstimate === false ? "" : "~"}${o.walkMinutes} min`;
        console.log(
          `${"".padEnd(32)}   street: ${o.summary ?? o.label} · $${o.priceUsd.toFixed(2)} · ${walk}`,
        );
      }
      // With Apple, every option on view is timed (it is what the search
      // asks Apple about first): a "~" here means Apple gave no route.
      const untimed = options.filter((o) => o.walkEstimate !== false);
      if (apple && untimed.length > 0) {
        misses.push(`${place.query}: ${untimed.length} street option(s) kept an estimate`);
      }
    }
  }
  await prisma?.$disconnect();
  console.log(
    misses.length === 0
      ? "\nEvery check passed."
      : `\n${misses.length} check(s) failed:\n${misses.map((m) => `  ✗ ${m}`).join("\n")}`,
  );
  if (misses.length > 0) process.exitCode = 1;
}

await main();
