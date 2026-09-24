/**
 * ParkWhiz (Arrive) as a second garage source, behind the same
 * GarageProvider interface as SpotHero. Built from the PUBLIC v4 API docs
 * (developer.parkwhiz.com/v4, read 2026-09-23):
 *
 *   POST /v4/oauth/token      grant_type=client_credentials, scope=public
 *   GET  /v4/quotes/?q=coordinates:LAT,LNG distance:MILES
 *        &start_time=ISO&end_time=ISO&option_types=bookable
 *
 * Each quote carries purchase_options[] (price as {"USD": "15.00"}) and
 * _embedded["pw:location"] (name, address1, distance in miles,
 * coordinates [lat, lng]). DISABLED until PARKWHIZ_CLIENT_ID and
 * PARKWHIZ_CLIENT_SECRET exist (index.ts only wires it when both are
 * set) — until then SpotHero is the only garage source and nothing here
 * runs in prod. The consumer-site deep-link format is TODO-VERIFY
 * against a real account; like SpotHero, checkout stays a hand-off (the
 * v4 POST /bookings flow needs partner approval before canReserve can
 * flip true).
 */

import type {
  GarageBooking,
  GarageOption,
  GarageProvider,
  GarageSearchQuery,
} from "./garageProvider.js";

const DEFAULT_BASE = "https://api.parkwhiz.com/v4";
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESULTS = 8;
const WALK_M_PER_MIN = 80;
const SEARCH_RADIUS_MILES = 0.5;
const METERS_PER_MILE = 1609.34;

interface Fetcher {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface ParkWhizOptions {
  clientId: string;
  clientSecret: string;
  fetcher?: Fetcher;
  baseUrl?: string;
  now?: () => number;
}

/** One v4 quote row, defensively read: a row that doesn't carry enough
 * drops to null, never throws. */
export function parseParkWhizQuote(raw: unknown): Omit<GarageOption, "deepLink"> | null {
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
  const id = location["id"] !== undefined ? String(location["id"]) : null;
  const name = typeof location["name"] === "string" ? location["name"] : null;
  if (priceUsd === null || id === null || name === null) return null;

  const distanceMiles = location["distance"];
  const distanceM =
    typeof distanceMiles === "number" && Number.isFinite(distanceMiles)
      ? Math.round(distanceMiles * METERS_PER_MILE)
      : 0;
  const coords = location["coordinates"];
  const [lat, lng] =
    Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number"
      ? [coords[0], coords[1]]
      : [undefined, undefined];
  const address = [location["address1"], location["city"]]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");
  return {
    id,
    provider: "parkwhiz",
    name,
    address,
    ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
    priceUsd,
    distanceM,
    walkMinutes: distanceM > 0 ? Math.max(1, Math.round(distanceM / WALK_M_PER_MIN)) : 0,
    // v4 quotes don't state a redemption type the way SpotHero does.
    entryType: "unknown",
  };
}

/** Price objects are {"USD": "15.00"} — dollars as a string. */
function extractUsd(price: unknown): number | null {
  if (typeof price !== "object" || price === null) return null;
  const usd = (price as Record<string, unknown>)["USD"];
  const value = typeof usd === "string" ? Number(usd) : typeof usd === "number" ? usd : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

/** TODO-VERIFY with a real ParkWhiz account: the consumer-site search URL
 * with the window prefilled. Used only as the hand-off link; the search
 * itself is the authenticated v4 API. */
export function parkwhizDeepLink(query: {
  lat: number;
  lng: number;
  startsAt: string;
  endsAt: string;
}): string {
  const params = new URLSearchParams({
    lat: String(query.lat),
    lng: String(query.lng),
    start: query.startsAt,
    end: query.endsAt,
  });
  return `https://www.parkwhiz.com/search/?${params.toString()}`;
}

function cacheKey(query: GarageSearchQuery): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return `${r(query.lat)},${r(query.lng)}|${query.startsAt}|${query.endsAt}`;
}

export function makeParkWhizProvider(options: ParkWhizOptions): GarageProvider {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const base = options.baseUrl ?? DEFAULT_BASE;
  const cache = new Map<string, { at: number; options: GarageOption[] }>();
  let token: { value: string; expiresAtMs: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && now() < token.expiresAtMs - 60_000) return token.value;
    const res = await fetcher(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options.clientId,
        client_secret: options.clientSecret,
        scope: "public",
      }).toString(),
    });
    if (!res.ok) throw new Error(`parkwhiz oauth ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== "string") throw new Error("parkwhiz oauth: no access_token");
    token = {
      value: body.access_token,
      expiresAtMs: now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
    };
    return token.value;
  }

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

    let bearer: string;
    try {
      bearer = await accessToken();
    } catch (err) {
      return {
        ok: false as const,
        error: "network" as const,
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
      };
    }
    const params = new URLSearchParams({
      q: `coordinates:${query.lat},${query.lng} distance:${SEARCH_RADIUS_MILES}`,
      start_time: query.startsAt,
      end_time: query.endsAt,
      option_types: "bookable",
    });
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await fetcher(`${base}/quotes/?${params.toString()}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      });
    } catch (err) {
      return {
        ok: false as const,
        error: "network" as const,
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
      };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      token = null; // a stale token re-auths on the next call
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
    const link = parkwhizDeepLink(query);
    const parsed = body
      .map((raw) => parseParkWhizQuote(raw))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .slice(0, MAX_RESULTS)
      .map((o) => ({ ...o, deepLink: link }));
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
    for (const entry of cache.values()) {
      const option = entry.options.find((o) => o.id === optionId);
      if (option) return option;
    }
    return null;
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
