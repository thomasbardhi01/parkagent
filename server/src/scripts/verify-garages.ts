/**
 * The live grounding sweep behind docs/assistant-verification.md:
 * named places → the real geocoder → the real garage providers, checking
 * that every option is within 600 m of the resolved point and printing
 * the deep links so they can be opened and checked.
 *
 *   pnpm -C server verify:garages
 *   pnpm -C server verify:garages -- --places "Fenway,TD Garden"
 *
 * Hits production endpoints (Nominatim, SpotHero, ParkWhiz) read-only at
 * low volume — one geocode + one search per provider per place, spaced
 * out for Nominatim's courtesy limit. Nothing here books or spends.
 */

import { metersBetween, NominatimGeocoder } from "../services/assistant/geocoder.js";
import type { MetroCity } from "../services/assistant/geocoder.js";
import { makeMultiGarageProvider } from "../services/garage/multiProvider.js";
import { makeParkWhizProvider } from "../services/garage/parkwhiz.js";
import { makeSpotHeroProvider } from "../services/garage/spotheroDeepLink.js";

/** The places the doc reports on: five in Boston, two in NYC. */
const DEFAULT_PLACES: { query: string; city: MetroCity }[] = [
  { query: "Newbury Street", city: "bos" },
  { query: "India Street", city: "bos" },
  { query: "South Boston", city: "bos" },
  { query: "Fenway", city: "bos" },
  { query: "TD Garden", city: "bos" },
  { query: "Times Square", city: "nyc" },
  { query: "Lincoln Center", city: "nyc" },
];

/** The named-area walkability bound the assistant enforces. */
const WITHIN_M = 600;
const COURTESY_DELAY_MS = 1500;

function parseArgs(argv: string[]): {
  places: typeof DEFAULT_PLACES;
  startsAt: string;
  endsAt: string;
} {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const only = flag("places");
  const places = only
    ? DEFAULT_PLACES.filter((p) =>
        only.split(",").some((q) => q.trim().toLowerCase() === p.query.toLowerCase()),
      )
    : DEFAULT_PLACES;
  // Default window: tomorrow evening, 6–10, so it is never in the past.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
  const day = tomorrow.toISOString().slice(0, 10);
  return {
    places,
    startsAt: flag("starts") ?? `${day}T18:00:00`,
    endsAt: flag("ends") ?? `${day}T22:00:00`,
  };
}

async function main(): Promise<void> {
  const { places, startsAt, endsAt } = parseArgs(process.argv.slice(2));
  if (places.length === 0) {
    console.error("No matching places. Known:", DEFAULT_PLACES.map((p) => p.query).join(", "));
    process.exit(1);
  }
  const geocoder = new NominatimGeocoder();
  const garage = makeMultiGarageProvider([makeSpotHeroProvider(), makeParkWhizProvider()]);
  console.log(`Window ${startsAt} → ${endsAt}; ${WITHIN_M} m bound; provider ${garage.id}\n`);

  let failures = 0;
  for (const place of places) {
    const geo = await geocoder.geocode({ query: place.query, city: place.city }, 3);
    if (!geo.ok || geo.results.length === 0) {
      console.log(
        `${place.query}: GEOCODE FAILED —`,
        geo.ok ? "no results in either metro" : geo.reason,
      );
      failures += 1;
      continue;
    }
    const at = geo.results[0]!;
    const search = await garage.search({ lat: at.lat, lng: at.lng, startsAt, endsAt });
    if (!search.ok) {
      console.log(`${place.query}: SEARCH FAILED — ${search.error} (${search.detail})`);
      failures += 1;
      continue;
    }
    // Recompute from each facility's own coordinates, exactly as the
    // named-area guard does — a provider's own distance can be stale.
    const measured = search.options.map((o) => ({
      option: o,
      distanceM:
        typeof o.lat === "number" && typeof o.lng === "number"
          ? Math.round(metersBetween(at.lat, at.lng, o.lat, o.lng))
          : o.distanceM,
    }));
    const beyond = measured.filter((m) => m.distanceM > WITHIN_M);
    console.log(
      `${place.query}: ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)} (${at.displayName}) — ` +
        `${measured.length} options, ${measured.length - beyond.length} within ${WITHIN_M} m` +
        (search.degraded?.length
          ? ` [degraded: ${search.degraded.map((d) => d.provider).join(", ")}]`
          : ""),
    );
    for (const { option, distanceM } of measured) {
      console.log(
        `   ${option.provider.padEnd(9)} $${String(option.priceUsd).padEnd(7)} ${String(distanceM).padStart(5)} m  ` +
          `${option.name.slice(0, 44)}\n      ${option.deepLink}`,
      );
    }
    if (beyond.length > 0) {
      // Not a failure by itself — the tool drops these and reports the
      // nearest distance — but worth seeing in the sweep.
      console.log(
        `   (${beyond.length} beyond ${WITHIN_M} m; nearest of those ${Math.min(...beyond.map((b) => b.distanceM))} m)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, COURTESY_DELAY_MS));
  }
  console.log(
    failures === 0 ? "\nAll places resolved and searched." : `\n${failures} place(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
