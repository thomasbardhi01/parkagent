/**
 * SpotHero via deep link: read-only search over the same public JSON
 * endpoint their site uses, low volume and cached; checkout is ALWAYS the
 * user finishing in SpotHero through a prefilled link. We never automate
 * SpotHero login or checkout — that line is a design rule, not a TODO.
 *
 * The public endpoint is unofficial: the parser is a total function over
 * whatever comes back (bad shapes yield [] and a decisions-visible
 * message, never a throw), and fixtures pin the shape we saw. When the
 * Partner API key arrives this file is replaced behind the same
 * GarageProvider interface (see API.md "Assistant > SpotHero").
 */

import type { GarageBooking, GarageOption, GarageProvider, GarageSearchQuery } from "./garageProvider.js";

const SEARCH_BASE = "https://api.spothero.com/v2/search";
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESULTS = 8;
const WALK_M_PER_MIN = 80;

interface Fetcher {
  (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface SpotHeroOptions {
  fetcher?: Fetcher;
  now?: () => number;
}

/** Round a coordinate to ~100 m so nearby queries share a cache entry. */
function cacheKey(query: GarageSearchQuery): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return `${r(query.lat)},${r(query.lng)}|${query.startsAt}|${query.endsAt}`;
}

export function spotheroDeepLink(query: {
  lat: number;
  lng: number;
  startsAt: string;
  endsAt: string;
}): string {
  const params = new URLSearchParams({
    latitude: String(query.lat),
    longitude: String(query.lng),
    starts: query.startsAt,
    ends: query.endsAt,
  });
  return `https://spothero.com/search?${params.toString()}`;
}

/**
 * Defensive extraction of the fields we surface from one search result.
 * Returns null when the entry doesn't carry enough to be an option.
 */
export function parseSpotHeroResult(raw: unknown, origin: { lat: number; lng: number }): Omit<GarageOption, "deepLink" | "provider"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const facility = (r["facility"] ?? r) as Record<string, unknown>;

  const id = firstString(r["id"], facility["id"], facility["parking_spot_id"]);
  const name = firstString(facility["title"], facility["name"]);
  const address = extractAddress(facility);
  const priceUsd = extractPriceUsd(r);
  const distanceM = extractDistanceM(r, facility, origin);
  if (id === null || name === null || priceUsd === null) return null;

  return {
    id,
    name,
    address: address ?? "",
    priceUsd,
    distanceM: distanceM ?? 0,
    walkMinutes: distanceM !== null ? Math.max(1, Math.round(distanceM / WALK_M_PER_MIN)) : 0,
    entryType: extractEntryType(facility),
  };
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    if (typeof c === "number") return String(c);
  }
  return null;
}

function extractAddress(facility: Record<string, unknown>): string | null {
  const direct = firstString(facility["street_address"], facility["address"]);
  if (direct) return direct;
  const addresses = facility["addresses"];
  if (Array.isArray(addresses) && addresses.length > 0) {
    const a = addresses[0] as Record<string, unknown>;
    return firstString(a["street_address"], a["address_line_1"]);
  }
  return null;
}

function extractPriceUsd(r: Record<string, unknown>): number | null {
  // Shapes seen: {price: 1200} cents; {rates:[{price: 1200}]};
  // {rates:[{quote:{total_price:{value:1200}}}]}.
  const cents = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) / 100 : null;
  const direct = cents(r["price"]);
  if (direct !== null) return direct;
  const rates = r["rates"];
  if (Array.isArray(rates) && rates.length > 0) {
    const rate = rates[0] as Record<string, unknown>;
    const flat = cents(rate["price"]);
    if (flat !== null) return flat;
    const quote = rate["quote"] as Record<string, unknown> | undefined;
    const total = quote?.["total_price"] as Record<string, unknown> | undefined;
    const nested = cents(total?.["value"]);
    if (nested !== null) return nested;
  }
  return null;
}

function extractDistanceM(
  r: Record<string, unknown>,
  facility: Record<string, unknown>,
  origin: { lat: number; lng: number },
): number | null {
  const direct = r["distance"] ?? facility["distance"];
  if (typeof direct === "number" && Number.isFinite(direct)) return Math.round(direct);
  const lat = facility["latitude"];
  const lng = facility["longitude"];
  if (typeof lat === "number" && typeof lng === "number") {
    return Math.round(haversineM(origin.lat, origin.lng, lat, lng));
  }
  return null;
}

function extractEntryType(facility: Record<string, unknown>): string {
  const raw = firstString(
    facility["parking_type"],
    (facility["operator_display_name"] as Record<string, unknown> | undefined)?.["entry_type"],
  );
  if (raw === null) return "unknown";
  const lower = raw.toLowerCase();
  if (lower.includes("valet")) return "valet";
  if (lower.includes("self")) return "self";
  return lower;
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Pull the results array out of whatever envelope the endpoint used. */
export function extractResults(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    for (const key of ["results", "data", "spots", "facilities"]) {
      if (Array.isArray(b[key])) return b[key] as unknown[];
    }
  }
  return [];
}

export function makeSpotHeroProvider(options: SpotHeroOptions = {}): GarageProvider {
  const fetcher: Fetcher = options.fetcher ?? ((url) => fetch(url));
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; options: GarageOption[] }>();

  async function search(query: GarageSearchQuery): Promise<GarageOption[]> {
    const key = cacheKey(query);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      return filterBudget(hit.options, query.budgetUsd);
    }

    const params = new URLSearchParams({
      latitude: String(query.lat),
      longitude: String(query.lng),
      starts: query.startsAt,
      ends: query.endsAt,
    });
    let parsed: GarageOption[] = [];
    try {
      const res = await fetcher(`${SEARCH_BASE}?${params.toString()}`);
      if (res.ok) {
        const body = await res.json();
        const link = spotheroDeepLink(query);
        parsed = extractResults(body)
          .map((raw) => parseSpotHeroResult(raw, query))
          .filter((o): o is NonNullable<typeof o> => o !== null)
          .slice(0, MAX_RESULTS)
          .map((o) => ({ ...o, provider: "spothero", deepLink: link }));
      }
    } catch {
      // Unreachable or reshaped endpoint: the assistant says "no garage
      // results" rather than crashing the turn.
      parsed = [];
    }
    cache.set(key, { at: now(), options: parsed });
    return filterBudget(parsed, query.budgetUsd);
  }

  return {
    id: "spothero",
    canReserve: false,
    search,
    async book(optionId: string): Promise<GarageBooking> {
      for (const entry of cache.values()) {
        const option = entry.options.find((o) => o.id === optionId);
        if (option) {
          return { kind: "deeplink_handoff", option, deepLink: option.deepLink };
        }
      }
      throw new Error(`unknown garage option ${optionId} (search first — options expire with the cache)`);
    },
  };
}

function filterBudget(options: GarageOption[], budgetUsd?: number): GarageOption[] {
  if (budgetUsd === undefined) return options;
  return options.filter((o) => o.priceUsd <= budgetUsd);
}
