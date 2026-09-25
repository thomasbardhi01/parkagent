/**
 * ParkWhiz (Arrive) as a second garage source, behind the same
 * GarageProvider interface as SpotHero — a READ-ONLY public reader, the
 * spike's finding (verified live 2026-09-23):
 *
 *   GET https://api.parkwhiz.com/v4/quotes/
 *       ?q=coordinates:LAT,LNG distance:MILES&start_time=ISO&end_time=ISO
 *
 * serves unauthenticated JSON at low volume with plain honest headers —
 * the same endpoint their own site reads (the partner docs describe an
 * OAuth surface, but public quote reads answer 200 without it). Each
 * quote row carries purchase_options[] (price {"USD": "33.93"}, dollars
 * as a string, fees included) and _embedded["pw:location"] (name,
 * address1, entrances[0].coordinates); distance is
 * distance.straight_line.meters. The checkout deep link comes from the
 * API itself: purchase_options[0]._links["site:purchase"].href resolved
 * against https://www.parkwhiz.com — a facility page with the window
 * prefilled (verified: it renders the right facility and times).
 *
 * Like SpotHero: we never automate their login or checkout, errors are
 * typed ("the search broke" ≠ "no garages"), never cached, and if they
 * ever start blocking (401/403/429) the right behavior is the `blocked`
 * error, not evasion.
 */

import { garageOptionId, newestCachedOption } from "./garageProvider.js";
import type {
  GarageBooking,
  GarageOption,
  GarageProvider,
  GarageSearchQuery,
} from "./garageProvider.js";

const SEARCH_BASE = "https://api.parkwhiz.com/v4/quotes/";
const SITE_BASE = "https://www.parkwhiz.com";
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESULTS = 8;
const WALK_M_PER_MIN = 80;
const SEARCH_RADIUS_MILES = 0.5;
const METERS_PER_MILE = 1609.34;

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

export interface ParkWhizOptions {
  fetcher?: Fetcher;
  baseUrl?: string;
  now?: () => number;
}

/** One live quote row, defensively read: a row that doesn't carry enough
 * drops to null, never throws. */
export function parseParkWhizQuote(
  raw: unknown,
  window: { startsAt: string; endsAt: string },
): GarageOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const q = raw as Record<string, unknown>;
  const embedded = q["_embedded"] as Record<string, unknown> | undefined;
  const location = embedded?.["pw:location"] as Record<string, unknown> | undefined;
  const purchaseOptions = q["purchase_options"];
  const first =
    Array.isArray(purchaseOptions) && purchaseOptions.length > 0
      ? (purchaseOptions[0] as Record<string, unknown>)
      : undefined;
  if (!location || !first) return null;

  const priceUsd = extractUsd(first["price"]) ?? extractUsd(first["base_price"]);
  const id =
    q["location_id"] !== undefined && q["location_id"] !== null
      ? String(q["location_id"])
      : location["id"] !== undefined
        ? String(location["id"])
        : null;
  const name = typeof location["name"] === "string" ? location["name"] : null;
  if (priceUsd === null || id === null || name === null) return null;

  const distanceM = extractDistanceM(q, location);
  const coords = extractCoords(location);
  const address = [location["address1"], location["city"]]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");
  return {
    id,
    provider: "parkwhiz",
    name,
    address,
    ...(coords ?? {}),
    priceUsd,
    distanceM: distanceM ?? 0,
    walkMinutes:
      distanceM !== null && distanceM > 0 ? Math.max(1, Math.round(distanceM / WALK_M_PER_MIN)) : 0,
    // Quote rows don't state a redemption type the way SpotHero does.
    entryType: "unknown",
    deepLink: extractPurchaseLink(first) ?? fallbackDeepLink(id, window),
  };
}

/** Price objects are {"USD": "33.93"} — dollars as a string. */
function extractUsd(price: unknown): number | null {
  if (typeof price !== "object" || price === null) return null;
  const usd = (price as Record<string, unknown>)["USD"];
  const value = typeof usd === "string" ? Number(usd) : typeof usd === "number" ? usd : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

/** Live shape: distance.straight_line.meters; docs shape (fallback):
 * location.distance in miles. */
function extractDistanceM(
  q: Record<string, unknown>,
  location: Record<string, unknown>,
): number | null {
  const distance = q["distance"];
  if (typeof distance === "object" && distance !== null) {
    const straight = (distance as Record<string, unknown>)["straight_line"];
    if (typeof straight === "object" && straight !== null) {
      const meters = (straight as Record<string, unknown>)["meters"];
      if (typeof meters === "number" && Number.isFinite(meters)) return Math.round(meters);
    }
  }
  const miles = location["distance"];
  if (typeof miles === "number" && Number.isFinite(miles)) {
    return Math.round(miles * METERS_PER_MILE);
  }
  return null;
}

/** Live shape: entrances[0].coordinates [lat, lng]; docs fallback:
 * location.coordinates. */
function extractCoords(location: Record<string, unknown>): { lat: number; lng: number } | null {
  const fromPair = (pair: unknown): { lat: number; lng: number } | null =>
    Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number"
      ? { lat: pair[0], lng: pair[1] }
      : null;
  const entrances = location["entrances"];
  if (Array.isArray(entrances) && entrances.length > 0) {
    const entrance = entrances[0] as Record<string, unknown>;
    const coords = fromPair(entrance["coordinates"]);
    if (coords) return coords;
  }
  return fromPair(location["coordinates"]);
}

/** The API's own checkout link: _links["site:purchase"].href, relative to
 * the site curie (https://www.parkwhiz.com). */
function extractPurchaseLink(purchaseOption: Record<string, unknown>): string | null {
  const links = purchaseOption["_links"];
  if (typeof links !== "object" || links === null) return null;
  const purchase = (links as Record<string, unknown>)["site:purchase"];
  if (typeof purchase !== "object" || purchase === null) return null;
  const href = (purchase as Record<string, unknown>)["href"];
  if (typeof href !== "string" || href.length === 0) return null;
  return href.startsWith("http") ? href : `${SITE_BASE}${href}`;
}

/** Same URL the API links to, built by hand when a row lacks _links
 * (verified live: renders the facility with the window prefilled). */
export function fallbackDeepLink(
  locationId: string,
  window: { startsAt: string; endsAt: string },
): string {
  const params = new URLSearchParams({
    location_id: locationId,
    start_time: window.startsAt,
    end_time: window.endsAt,
  });
  return `${SITE_BASE}/find_and_book/?${params.toString()}`;
}

function cacheKey(query: GarageSearchQuery): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return `${r(query.lat)},${r(query.lng)}|${query.startsAt}|${query.endsAt}`;
}

export function makeParkWhizProvider(options: ParkWhizOptions = {}): GarageProvider {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const base = options.baseUrl ?? SEARCH_BASE;
  const cache = new Map<string, { at: number; options: GarageOption[] }>();

  async function search(query: GarageSearchQuery) {
    const key = cacheKey(query);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      return {
        ok: true as const,
        options: filterBudget(hit.options, query.budgetUsd),
        fromCache: true,
      };
    }

    const params = new URLSearchParams({
      q: `coordinates:${query.lat},${query.lng} distance:${SEARCH_RADIUS_MILES}`,
      start_time: query.startsAt,
      end_time: query.endsAt,
    });
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await fetcher(`${base}?${params.toString()}`, {
        // Plain, honest headers — the endpoint serves unauthenticated
        // JSON at low volume; nothing here evades anything.
        headers: { Accept: "application/json", "User-Agent": "parkagent-prototype/1.0" },
      });
    } catch (err) {
      return {
        ok: false as const,
        error: "network" as const,
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
      };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return { ok: false as const, error: "blocked" as const, detail: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return {
        ok: false as const,
        error: "parse_failed" as const,
        detail: `HTTP ${response.status}`,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false as const,
        error: "parse_failed" as const,
        detail: "response was not JSON",
      };
    }
    if (!Array.isArray(body)) {
      return {
        ok: false as const,
        error: "parse_failed" as const,
        detail: "expected a quotes array",
      };
    }
    const parsed = body
      .map((raw) => parseParkWhizQuote(raw, query))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .slice(0, MAX_RESULTS)
      .map((o) => ({ ...o, id: garageOptionId("parkwhiz", o.id, query) }));
    if (body.length > 0 && parsed.length === 0) {
      return {
        ok: false as const,
        error: "parse_failed" as const,
        detail: `0 of ${body.length} quotes parseable`,
      };
    }
    cache.set(key, { at: now(), options: parsed });
    return { ok: true as const, options: filterBudget(parsed, query.budgetUsd), fromCache: false };
  }

  function optionById(optionId: string): GarageOption | null {
    return newestCachedOption(cache, optionId);
  }

  return {
    id: "parkwhiz",
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
