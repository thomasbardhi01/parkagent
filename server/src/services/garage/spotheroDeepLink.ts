/**
 * SpotHero via deep link: read-only search over the same public JSON
 * endpoint their site uses, low volume and cached; checkout is ALWAYS the
 * user finishing in SpotHero through a prefilled link. We never automate
 * SpotHero login or checkout — that line is a design rule, not a TODO.
 *
 * Endpoint (verified live 2026-09-21, Seaport probe returned 31 results):
 *   GET https://api.spothero.com/v2/search/transient?lat=&lon=&starts=&ends=
 * The old /v2/search with latitude/longitude 404s — that shape change is
 * exactly why search() returns a TYPED outcome now: "the search broke"
 * and "no garages" must never read the same. Errors are never cached;
 * only good results are. SpotHero is not blocking unauthenticated reads
 * at low volume (plain requests succeed) — if that ever changes, the
 * right behavior is the `blocked` error, not evasion.
 */

import { easternWallClock, parseEasternTime } from "../hours.js";
import { garageOptionId, newestCachedOption } from "./garageProvider.js";
import type {
  GarageBooking,
  GarageOption,
  GarageProvider,
  GarageSearchQuery,
} from "./garageProvider.js";

const SEARCH_BASE = "https://api.spothero.com/v2/search/transient";
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESULTS = 8;
const WALK_M_PER_MIN = 80;

export type GarageSearchError = "blocked" | "parse_failed" | "network";

export type GarageSearchOutcome =
  | { ok: true; options: GarageOption[]; fromCache: boolean }
  | { ok: false; error: GarageSearchError; detail: string };

interface Fetcher {
  (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
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

/** The area-level search link — the fallback when no facility id exists. */
export function spotheroDeepLink(query: {
  lat: number;
  lng: number;
  startsAt: string;
  endsAt: string;
}): string {
  const params = new URLSearchParams({
    latitude: String(query.lat),
    longitude: String(query.lng),
    starts: spotheroTime(query.startsAt),
    ends: spotheroTime(query.endsAt),
  });
  return `https://spothero.com/search?${params.toString()}`;
}

/** The FACILITY-level checkout link (verified live 2026-09-23:
 * /checkout/{facility_id}?starts=&ends= renders that facility with the
 * window prefilled — the search link only showed the area). */
export function spotheroFacilityLink(
  facilityId: string,
  window: { startsAt: string; endsAt: string },
): string {
  const params = new URLSearchParams({
    starts: spotheroTime(window.startsAt),
    ends: spotheroTime(window.endsAt),
  });
  return `https://spothero.com/checkout/${encodeURIComponent(facilityId)}?${params.toString()}`;
}

/**
 * SpotHero reads a window as WALL-CLOCK digits and ignores any offset
 * (verified live 2026-09-24: `starts=2026-09-26T22:00:00.000Z` — 6 PM
 * ET — rendered a 10 PM checkout). So every window goes out as NYC wall
 * time with no offset, the form the checkout verification used; a string
 * we can't read passes through untouched rather than being guessed at.
 */
export function spotheroTime(iso: string): string {
  const at = parseEasternTime(iso);
  return at ? easternWallClock(at) : iso;
}

/**
 * One row of the transient-search response (shape pinned by the fixture,
 * recorded live 2026-09-21): price at rates[0].quote.total_price.value
 * (cents), facility under facility.common (title, addresses, slug),
 * distance at distance.linear_meters, entry type at
 * rates[0].transient.redemption_type. Total function: a row that doesn't
 * carry enough drops to null, never throws.
 */
export function parseSpotHeroResult(
  raw: unknown,
  origin: { lat: number; lng: number },
): Omit<GarageOption, "deepLink" | "provider"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const facility = r["facility"] as Record<string, unknown> | undefined;
  const common = (facility?.["common"] ?? facility ?? r) as Record<string, unknown>;

  const id = firstString(common["id"], r["id"]);
  const name = firstString(common["title"], common["name"]);
  const priceUsd = extractPriceUsd(r);
  if (id === null || name === null || priceUsd === null) return null;

  const distanceM = extractDistanceM(r, common, origin);
  const coords = extractCoords(common);
  return {
    id,
    name,
    address: extractAddress(common) ?? "",
    ...(coords ?? {}),
    priceUsd,
    distanceM: distanceM ?? 0,
    walkMinutes: distanceM !== null ? Math.max(1, Math.round(distanceM / WALK_M_PER_MIN)) : 0,
    entryType: extractEntryType(r, common),
  };
}

/** The facility's own point (addresses[0] in the live shape) — map pins
 * and the recomputed named-area distance guard both want it. */
function extractCoords(common: Record<string, unknown>): { lat: number; lng: number } | null {
  const addresses = common["addresses"];
  const first = Array.isArray(addresses) ? (addresses[0] as Record<string, unknown>) : undefined;
  const lat = first?.["latitude"] ?? common["latitude"];
  const lng = first?.["longitude"] ?? common["longitude"];
  if (typeof lat === "number" && typeof lng === "number") return { lat, lng };
  return null;
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    if (typeof c === "number") return String(c);
  }
  return null;
}

function extractAddress(common: Record<string, unknown>): string | null {
  const direct = firstString(common["street_address"], common["address"]);
  if (direct) return direct;
  const addresses = common["addresses"];
  if (Array.isArray(addresses) && addresses.length > 0) {
    const a = addresses[0] as Record<string, unknown>;
    return firstString(a["street_address"], a["address_line_1"]);
  }
  return null;
}

function extractPriceUsd(r: Record<string, unknown>): number | null {
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
  common: Record<string, unknown>,
  origin: { lat: number; lng: number },
): number | null {
  const distance = r["distance"];
  if (typeof distance === "number" && Number.isFinite(distance)) return Math.round(distance);
  if (typeof distance === "object" && distance !== null) {
    const meters = (distance as Record<string, unknown>)["linear_meters"];
    if (typeof meters === "number" && Number.isFinite(meters)) return Math.round(meters);
  }
  const addresses = common["addresses"];
  const first = Array.isArray(addresses) ? (addresses[0] as Record<string, unknown>) : undefined;
  const lat = first?.["latitude"] ?? common["latitude"];
  const lng = first?.["longitude"] ?? common["longitude"];
  if (typeof lat === "number" && typeof lng === "number") {
    return Math.round(haversineM(origin.lat, origin.lng, lat, lng));
  }
  return null;
}

function extractEntryType(r: Record<string, unknown>, common: Record<string, unknown>): string {
  const rates = r["rates"];
  if (Array.isArray(rates) && rates.length > 0) {
    const transient = (rates[0] as Record<string, unknown>)["transient"] as
      Record<string, unknown> | undefined;
    const redemption = transient?.["redemption_type"];
    if (typeof redemption === "string" && redemption.length > 0) return redemption;
  }
  const raw = firstString(common["parking_type"], common["facility_type"]);
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
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Pull the results array out of whatever envelope the endpoint used;
 * null (vs []) means "no recognizable envelope at all". */
export function extractResults(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    for (const key of ["results", "data", "spots", "facilities"]) {
      if (Array.isArray(b[key])) return b[key] as unknown[];
    }
  }
  return null;
}

export function makeSpotHeroProvider(options: SpotHeroOptions = {}): GarageProvider {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; options: GarageOption[] }>();

  async function search(query: GarageSearchQuery): Promise<GarageSearchOutcome> {
    const key = cacheKey(query);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      return { ok: true, options: filterBudget(hit.options, query.budgetUsd), fromCache: true };
    }

    const params = new URLSearchParams({
      lat: String(query.lat),
      lon: String(query.lng),
      starts: spotheroTime(query.startsAt),
      ends: spotheroTime(query.endsAt),
    });
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await fetcher(`${SEARCH_BASE}?${params.toString()}`, {
        // Plain, honest headers — the endpoint serves unauthenticated
        // JSON at low volume; nothing here evades anything.
        headers: { Accept: "application/json", "User-Agent": "parkagent-prototype/1.0" },
      });
    } catch (err) {
      return {
        ok: false,
        error: "network",
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
      };
    }
    if (response.status === 403 || response.status === 429) {
      return { ok: false, error: "blocked", detail: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      // A 404 here is the endpoint moving again — a site-shape problem,
      // not connectivity.
      return { ok: false, error: "parse_failed", detail: `HTTP ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "parse_failed", detail: "response was not JSON" };
    }
    const rows = extractResults(body);
    if (rows === null) {
      return { ok: false, error: "parse_failed", detail: "no results array in response" };
    }
    const parsed = rows
      .map((raw) => parseSpotHeroResult(raw, query))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .slice(0, MAX_RESULTS)
      .map((o) => ({
        ...o,
        id: garageOptionId("spothero", o.id, query),
        provider: "spothero",
        // Facility checkout, window prefilled — never just the area map.
        deepLink: spotheroFacilityLink(o.id, query),
      }));
    if (rows.length > 0 && parsed.length === 0) {
      // The endpoint answered with rows we can no longer read — say the
      // site changed rather than claiming an empty lot map.
      return { ok: false, error: "parse_failed", detail: `0 of ${rows.length} rows parseable` };
    }
    cache.set(key, { at: now(), options: parsed });
    return { ok: true, options: filterBudget(parsed, query.budgetUsd), fromCache: false };
  }

  function optionById(optionId: string): GarageOption | null {
    return newestCachedOption(cache, optionId);
  }

  return {
    id: "spothero",
    canReserve: false,
    search,
    optionById,
    async book(optionId: string): Promise<GarageBooking> {
      const option = optionById(optionId);
      if (option) {
        return { kind: "deeplink_handoff", option, deepLink: option.deepLink };
      }
      throw new Error(
        `unknown garage option ${optionId} (search first — options expire with the cache)`,
      );
    },
  };
}

function filterBudget(options: GarageOption[], budgetUsd?: number): GarageOption[] {
  if (budgetUsd === undefined) return options;
  return options.filter((o) => o.priceUsd <= budgetUsd);
}
