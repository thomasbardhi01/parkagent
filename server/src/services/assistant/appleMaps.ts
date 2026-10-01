/**
 * Point-of-interest search for the assistant over the Apple Maps Server
 * API (maps-api.apple.com). People name restaurants, venues, and shops
 * ("near Lola 42", "Moo steakhouse in Seaport"), and Nominatim — street
 * and landmark data from OpenStreetMap — knows few of them: on the
 * 2026-09-25 device test both names came back empty and the assistant
 * fell back to a neighborhood centroid. Apple's search is the same one
 * the Maps app runs, with fuzzy names and location bias.
 *
 * Auth (developer.apple.com, "Creating and using tokens with Maps Server
 * API"): an ES256 JWT signed with a Maps private key — header {alg, kid,
 * typ}, claims {iss: team id, iat, exp, scope: "server_api"} — is traded
 * at GET /v1/token for a 30-minute access token, which authorizes every
 * other call. The access token is cached until a minute before it
 * expires and refreshed once on a 401.
 *
 * Three endpoints (FR-44):
 *  - GET /v1/search — the place search;
 *  - GET /v1/searchAutocomplete — asked only when the search came back
 *    weak (placeScore.ts `searchIsWeak`): it completes what the search
 *    reads literally ("lola42" is LoLa 42). Each completion is one more
 *    GET of its `completionUrl`, at most three;
 *  - GET /v1/etas — walking time from a destination to up to ten option
 *    pins per call.
 *
 * Results outside the covered metros' boxes are dropped (a parking answer
 * in another state is never useful), and a biased search that finds
 * nothing in its metro retries around the other metros — the bias orders
 * the search, it never blinds it (the same rule as NominatimGeocoder).
 * Never throws: failures come back as { ok: false } so the chain can fall
 * back to Nominatim, and a 429 — the team's daily quota, shared by every
 * Maps endpoint — is the typed reason "quota".
 */

import { createPrivateKey, sign } from "node:crypto";

import type {
  GeocodeFailure,
  GeocodeOutcome,
  GeocodeQuery,
  GeocodeResult,
  GeocoderProvider,
  MetroCity,
  WalkingEta,
} from "./geocoder.js";
import {
  METRO_BBOX,
  biasPointFor,
  coveredMetros,
  metersBetween,
  metroForPoint,
} from "./geocoder.js";
import { scoreCandidates, searchIsWeak } from "./placeScore.js";

export interface AppleMapsConfig {
  /** 10-character Apple Developer team id (the JWT's iss). */
  teamId: string;
  /** 10-character id of the Maps key (the JWT's kid). */
  keyId: string;
  /** The .p8 key's contents (literal newlines or "\n" escapes). */
  privateKey: string;
}

export interface AppleMapsGeocoderOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  now?: () => Date;
}

/** One raw /v1/search result, the fields we read. */
interface ApplePlace {
  name?: string;
  coordinate?: { latitude?: number; longitude?: number };
  formattedAddressLines?: string[];
  poiCategory?: string;
  structuredAddress?: {
    locality?: string;
    subLocality?: string;
    fullThoroughfare?: string;
    dependentLocalities?: string[];
    areasOfInterest?: string[];
  };
}

/** One /v1/searchAutocomplete result, the fields we read. */
interface AppleCompletion {
  /** Relative: "/v1/search?q=…&metadata=…". */
  completionUrl?: string;
  location?: { latitude?: number; longitude?: number };
}

/** One /v1/etas entry. */
interface AppleEta {
  destination?: { latitude?: number; longitude?: number };
  distanceMeters?: number;
  expectedTravelTimeSeconds?: number;
  staticTravelTimeSeconds?: number;
}

const TIMEOUT_MS = 6_000;
/** A walking time is a refinement: a slow answer isn't worth the wait. */
const ETA_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
/** Completions resolved per autocomplete call: one more request each. */
export const MAX_COMPLETIONS = 3;
/** Apple's limit on /v1/etas destinations. */
export const MAX_ETA_DESTINATIONS = 10;
/** An echoed destination this close to the one asked about is that one. */
const SAME_POINT_M = 30;

/** Apple refused for the daily service-call quota (HTTP 429). */
class QuotaError extends Error {
  constructor() {
    super("quota");
  }
}

const reasonOf = (err: unknown): string =>
  err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);

/** The Maps auth token: what /v1/token trades for an access token. */
export function makeMapsAuthToken(config: AppleMapsConfig, nowMs: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const iat = Math.floor(nowMs / 1000);
  const unsigned =
    b64({ alg: "ES256", kid: config.keyId, typ: "JWT" }) +
    "." +
    b64({ iss: config.teamId, iat, exp: iat + 30 * 60, scope: "server_api" });
  const key = createPrivateKey(config.privateKey.replace(/\\n/g, "\n"));
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return unsigned + "." + signature.toString("base64url");
}

export class AppleMapsGeocoder implements GeocoderProvider {
  readonly id = "apple_maps";
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private accessToken: { value: string; expiresAtMs: number } | null = null;
  private readonly cache = new Map<string, { at: number; results: GeocodeResult[] }>();

  constructor(
    private readonly config: AppleMapsConfig,
    opts: AppleMapsGeocoderOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://maps-api.apple.com";
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * The search, then — only when the search is weak — autocomplete. Each
   * result says which of the two found it (`source`: "apple_search" or
   * "apple_autocomplete"); merged, the stronger come first. Autocomplete
   * failing never fails a search that answered: it is named in `failures`
   * and the search's results stand.
   */
  async geocode(q: GeocodeQuery, limit = 5): Promise<GeocodeOutcome> {
    const key = this.cacheKey("search", q);
    const cached = this.cached(key);
    if (cached) return { ok: true, results: cached.slice(0, limit) };
    let results: GeocodeResult[];
    try {
      results = await this.passes(q, (city, near) => this.search(q, city, near));
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
    const failures: GeocodeFailure[] = [];
    const bias = biasPointFor(q);
    if (searchIsWeak(q.query, results, bias)) {
      const completed = await this.autocomplete(q);
      if (!completed.ok) {
        failures.push({ provider: "apple_autocomplete", reason: completed.reason });
      } else if (completed.results.length > 0) {
        const merged = distinctResults([...completed.results, ...results]);
        // Best first, so the cut to `limit` drops the weakest. Each result
        // keeps its own rank, so the order here changes no score.
        const score = new Map(
          scoreCandidates(q.query, merged, bias).map((s) => [s.result, s.score]),
        );
        results = merged.sort((a, b) => score.get(b)! - score.get(a)!);
      }
    }
    // A search whose autocomplete step failed isn't cached: the next one
    // should try it again.
    if (failures.length === 0) this.remember(key, results);
    return {
      ok: true,
      results: results.slice(0, limit),
      ...(failures.length > 0 ? { failures } : {}),
    };
  }

  /**
   * What autocomplete makes of the query: GET /v1/searchAutocomplete with
   * the search's own bias, then GET each completion's `completionUrl` —
   * the first `limit` (at most MAX_COMPLETIONS) that sit in a covered
   * metro — for the place itself. Cached like a search.
   */
  async autocomplete(q: GeocodeQuery, limit = MAX_COMPLETIONS): Promise<GeocodeOutcome> {
    const key = this.cacheKey("autocomplete", q);
    const cached = this.cached(key);
    if (cached) return { ok: true, results: cached.slice(0, limit) };
    const take = Math.max(0, Math.min(limit, MAX_COMPLETIONS));
    let results: GeocodeResult[];
    try {
      results = await this.passes(q, (city, near) => this.complete(q, city, near, take));
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
    this.remember(key, results);
    return { ok: true, results: results.slice(0, limit) };
  }

  /**
   * Walking time and route distance from `origin` to each destination:
   * GET /v1/etas, transportType Walking, ten destinations a call. One
   * entry per destination, in order — null where Apple gave no route.
   * Never throws: null when any call fails (a 429 included), so the
   * caller keeps its straight-line estimates.
   */
  async walkingEtas(
    origin: { lat: number; lng: number },
    destinations: readonly { lat: number; lng: number }[],
  ): Promise<(WalkingEta | null)[] | null> {
    const out: (WalkingEta | null)[] = [];
    try {
      for (let at = 0; at < destinations.length; at += MAX_ETA_DESTINATIONS) {
        const chunk = destinations.slice(at, at + MAX_ETA_DESTINATIONS);
        const params = new URLSearchParams({
          origin: coordinatePair(origin),
          destinations: chunk.map(coordinatePair).join("|"),
          transportType: "Walking",
        });
        const res = await this.authorizedGet(`/v1/etas?${params.toString()}`, ETA_TIMEOUT_MS);
        const body = (await res.json()) as { etas?: AppleEta[] };
        const etas = Array.isArray(body.etas) ? body.etas : [];
        out.push(...chunk.map((destination, index) => etaFor(destination, index, etas)));
      }
    } catch {
      return null;
    }
    return out;
  }

  private cacheKey(kind: "search" | "autocomplete", q: GeocodeQuery): string {
    const near = q.near ? `${q.near.lat.toFixed(3)},${q.near.lng.toFixed(3)}` : "-";
    return `${kind}::${q.city ?? "any"}::${near}::${q.query.trim().toLowerCase()}`;
  }

  private cached(key: string): GeocodeResult[] | null {
    const hit = this.cache.get(key);
    return hit && this.now().getTime() - hit.at < CACHE_TTL_MS ? hit.results : null;
  }

  /** Cache a search; expired entries go, and the cache stays bounded. */
  private remember(key: string, results: GeocodeResult[]): void {
    const nowMs = this.now().getTime();
    for (const [k, v] of this.cache) {
      if (nowMs - v.at >= CACHE_TTL_MS) this.cache.delete(k);
    }
    while (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { at: nowMs, results });
  }

  /** The biased metro first, around the given point (the phone) or
   * within its box; the other metros only when that found nothing.
   * Unbiased: every covered metro. */
  private async passes(
    q: GeocodeQuery,
    run: (
      city: MetroCity,
      near: { lat: number; lng: number } | undefined,
    ) => Promise<GeocodeResult[]>,
  ): Promise<GeocodeResult[]> {
    const cities: MetroCity[] = q.city
      ? [q.city, ...coveredMetros().filter((c) => c !== q.city)]
      : coveredMetros();
    let results: GeocodeResult[] = [];
    for (const [index, city] of cities.entries()) {
      results = [...results, ...(await run(city, index === 0 ? q.near : undefined))];
      if (q.city && results.length > 0) break;
    }
    return results;
  }

  /** The bias every place request carries. ONE of `searchLocation` (the
   * given point) or `searchRegion` (the metro's box): Apple answers 400
   * "Cannot specify both searchRegion and searchLocation", and every
   * search failed that way until #152. */
  private biasParams(
    q: GeocodeQuery,
    city: MetroCity,
    near: { lat: number; lng: number } | undefined,
  ): URLSearchParams {
    const box = METRO_BBOX[city];
    const params = new URLSearchParams({
      q: q.query,
      limitToCountries: "US",
      lang: "en-US",
      resultTypeFilter: "Poi,Address",
    });
    if (near) {
      params.set("searchLocation", `${near.lat},${near.lng}`);
    } else {
      // north-latitude,east-longitude,south-latitude,west-longitude
      params.set("searchRegion", `${box[3]},${box[2]},${box[1]},${box[0]}`);
    }
    if (q.userLocation) {
      params.set("userLocation", `${q.userLocation.lat},${q.userLocation.lng}`);
    }
    return params;
  }

  /** One /v1/search around a metro, keeping only in-box results. */
  private async search(
    q: GeocodeQuery,
    city: MetroCity,
    near: { lat: number; lng: number } | undefined,
  ): Promise<GeocodeResult[]> {
    const params = this.biasParams(q, city, near);
    const res = await this.authorizedGet(`/v1/search?${params.toString()}`);
    const body = (await res.json()) as { results?: ApplePlace[] };
    return parsePlaces(body.results, q.query, "apple_search");
  }

  /** One /v1/searchAutocomplete around a metro, and the place behind each
   * of its first `take` in-box completions. */
  private async complete(
    q: GeocodeQuery,
    city: MetroCity,
    near: { lat: number; lng: number } | undefined,
    take: number,
  ): Promise<GeocodeResult[]> {
    const params = this.biasParams(q, city, near);
    const res = await this.authorizedGet(`/v1/searchAutocomplete?${params.toString()}`);
    const body = (await res.json()) as { results?: AppleCompletion[] };
    const urls: string[] = [];
    for (const completion of Array.isArray(body.results) ? body.results : []) {
      const url = completionPath(completion.completionUrl);
      if (!url) continue;
      // A completion that says where it is, and is outside every covered
      // metro, isn't worth its request.
      const lat = completion.location?.latitude;
      const lng = completion.location?.longitude;
      if (typeof lat === "number" && typeof lng === "number" && !metroForPoint(lat, lng)) continue;
      urls.push(url);
      if (urls.length >= take) break;
    }
    // Together, not in turn: each is its own request with its own deadline.
    const places = await Promise.all(
      urls.map(async (url) => {
        const place = await this.authorizedGet(url);
        const found = (await place.json()) as { results?: ApplePlace[] };
        // A completion is one place: its search's first in-box result.
        return parsePlaces(found.results, q.query, "apple_autocomplete")[0] ?? null;
      }),
    );
    return places
      .filter((place): place is GeocodeResult => place !== null)
      .map((place, rank) => ({ ...place, rank }));
  }

  private async authorizedGet(path: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.token(attempt > 0);
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // An access token can die before its stated expiry (key revoked,
      // clock skew): refresh once, then give up.
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 429) throw new QuotaError();
      if (!res.ok) throw new Error(`apple maps ${res.status}`);
      return res;
    }
    throw new Error("apple maps 401");
  }

  private async token(forceRefresh: boolean): Promise<string> {
    const nowMs = this.now().getTime();
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAtMs - 60_000 > nowMs) {
      return this.accessToken.value;
    }
    const res = await this.fetchFn(`${this.baseUrl}/v1/token`, {
      headers: { Authorization: `Bearer ${makeMapsAuthToken(this.config, nowMs)}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) throw new QuotaError();
    if (!res.ok) throw new Error(`apple maps token ${res.status}`);
    const body = (await res.json()) as { accessToken?: string; expiresInSeconds?: number };
    if (!body.accessToken) throw new Error("apple maps token: no accessToken");
    this.accessToken = {
      value: body.accessToken,
      expiresAtMs: nowMs + (body.expiresInSeconds ?? 1800) * 1000,
    };
    return body.accessToken;
  }
}

/** /v1/search rows as results: in-box only, ranked in the order kept. */
function parsePlaces(
  rows: ApplePlace[] | undefined,
  query: string,
  source: "apple_search" | "apple_autocomplete",
): GeocodeResult[] {
  const out: GeocodeResult[] = [];
  for (const place of Array.isArray(rows) ? rows : []) {
    const lat = place.coordinate?.latitude;
    const lng = place.coordinate?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const metro = metroForPoint(lat, lng);
    if (!metro) continue;
    const address = place.structuredAddress?.fullThoroughfare ?? place.formattedAddressLines?.[0];
    const area =
      place.structuredAddress?.subLocality ??
      place.structuredAddress?.dependentLocalities?.[0] ??
      place.structuredAddress?.locality;
    const name = place.name ?? address ?? query;
    out.push({
      lat,
      lng,
      displayName: [name, address && address !== name ? address : null, area]
        .filter((part): part is string => !!part)
        .join(", "),
      city: metro,
      name,
      ...(address ? { address } : {}),
      ...(area ? { area } : {}),
      areaNames: [
        place.structuredAddress?.locality,
        place.structuredAddress?.subLocality,
        ...(place.structuredAddress?.dependentLocalities ?? []),
        ...(place.structuredAddress?.areasOfInterest ?? []),
      ].filter((part): part is string => !!part),
      // A POI category means a business/venue/landmark; without one the
      // result is an address or an area (a street, a neighborhood).
      kind: place.poiCategory ? "poi" : address && address !== name ? "address" : "area",
      ...(place.poiCategory ? { category: place.poiCategory } : {}),
      source,
      rank: out.length,
    });
  }
  return out;
}

/**
 * A completion's URL as a path this client will fetch: only Apple's own
 * relative /v1/search — the request carries the access token, so nothing
 * in a response gets to name another host or endpoint. The language is
 * the caller's to add (Apple's reference says so).
 */
function completionPath(completionUrl: string | undefined): string | null {
  if (typeof completionUrl !== "string" || !completionUrl.startsWith("/v1/search?")) return null;
  return /[?&]lang=/.test(completionUrl) ? completionUrl : `${completionUrl}&lang=en-US`;
}

/** The same place found twice (by the search and by a completion) is one
 * result: the earlier one. */
function distinctResults(results: GeocodeResult[]): GeocodeResult[] {
  const kept: GeocodeResult[] = [];
  for (const r of results) {
    const dup = kept.some(
      (k) => k.name === r.name && metersBetween(k.lat, k.lng, r.lat, r.lng) < SAME_POINT_M,
    );
    if (!dup) kept.push(r);
  }
  return kept;
}

/** "lat,lng" to six decimals (a tenth of a metre): a pin computed from a
 * curb line is a long float, and the request doesn't need its noise. */
function coordinatePair(point: { lat: number; lng: number }): string {
  return `${Number(point.lat.toFixed(6))},${Number(point.lng.toFixed(6))}`;
}

/** The ETA for one destination: the entry at its own index when that
 * entry echoes it (or echoes nothing), else whichever entry does. */
function etaFor(
  destination: { lat: number; lng: number },
  index: number,
  etas: AppleEta[],
): WalkingEta | null {
  const isFor = (eta: AppleEta | undefined): boolean => {
    const lat = eta?.destination?.latitude;
    const lng = eta?.destination?.longitude;
    return (
      typeof lat === "number" &&
      typeof lng === "number" &&
      metersBetween(lat, lng, destination.lat, destination.lng) < SAME_POINT_M
    );
  };
  const atIndex = etas[index];
  const eta = isFor(atIndex) || (atIndex && !atIndex.destination) ? atIndex : etas.find(isFor);
  const seconds = eta?.expectedTravelTimeSeconds ?? eta?.staticTravelTimeSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const meters = eta?.distanceMeters;
  return {
    seconds,
    meters: typeof meters === "number" && Number.isFinite(meters) && meters >= 0 ? meters : 0,
  };
}
