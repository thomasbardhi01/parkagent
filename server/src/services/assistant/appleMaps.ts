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
 * at GET /v1/token for a 30-minute access token, which authorizes
 * GET /v1/search. The access token is cached until a minute before it
 * expires and refreshed once on a 401.
 *
 * Results outside the covered metros' boxes are dropped (a parking answer
 * in another state is never useful), and a biased search that finds
 * nothing in its metro retries around the other metros — the bias orders
 * the search, it never blinds it (the same rule as NominatimGeocoder).
 * Never throws: failures come back as { ok: false } so the chain can fall
 * back to Nominatim.
 */

import { createPrivateKey, sign } from "node:crypto";

import type { GeocodeQuery, GeocodeResult, GeocoderProvider, MetroCity } from "./geocoder.js";
import { METRO_BBOX, METRO_CENTER, coveredMetros, metroForPoint } from "./geocoder.js";

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

const TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;

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

  async geocode(
    q: GeocodeQuery,
    limit = 5,
  ): Promise<{ ok: true; results: GeocodeResult[] } | { ok: false; reason: string }> {
    const near = q.near ? `${q.near.lat.toFixed(3)},${q.near.lng.toFixed(3)}` : "-";
    const key = `${q.city ?? "any"}::${near}::${q.query.trim().toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && this.now().getTime() - cached.at < CACHE_TTL_MS) {
      return { ok: true, results: cached.results.slice(0, limit) };
    }
    // The biased metro first, around the given point (the phone) or its
    // center; the other metros only when that found nothing in a box.
    const passes: MetroCity[] = q.city
      ? [q.city, ...coveredMetros().filter((c) => c !== q.city)]
      : coveredMetros();
    let results: GeocodeResult[] = [];
    try {
      for (const [index, city] of passes.entries()) {
        const anchor = index === 0 && q.near ? q.near : METRO_CENTER[city];
        const rows = await this.search(q, city, anchor);
        results = [...results, ...rows];
        if (q.city && results.length > 0) break;
      }
    } catch (err) {
      const reason =
        err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
      return { ok: false, reason };
    }
    this.remember(key, results);
    return { ok: true, results: results.slice(0, limit) };
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

  /** One /v1/search around a metro, keeping only in-box results. */
  private async search(
    q: GeocodeQuery,
    city: MetroCity,
    anchor: { lat: number; lng: number },
  ): Promise<GeocodeResult[]> {
    const box = METRO_BBOX[city];
    const params = new URLSearchParams({
      q: q.query,
      limitToCountries: "US",
      lang: "en-US",
      resultTypeFilter: "Poi,Address",
      searchLocation: `${anchor.lat},${anchor.lng}`,
      // north-latitude,east-longitude,south-latitude,west-longitude
      searchRegion: `${box[3]},${box[2]},${box[1]},${box[0]}`,
    });
    if (q.userLocation) {
      params.set("userLocation", `${q.userLocation.lat},${q.userLocation.lng}`);
    }
    const res = await this.authorizedGet(`/v1/search?${params.toString()}`);
    const body = (await res.json()) as { results?: ApplePlace[] };
    const out: GeocodeResult[] = [];
    for (const place of body.results ?? []) {
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
      const name = place.name ?? address ?? q.query;
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
        source: this.id,
      });
    }
    return out;
  }

  private async authorizedGet(path: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.token(attempt > 0);
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // An access token can die before its stated expiry (key revoked,
      // clock skew): refresh once, then give up.
      if (res.status === 401 && attempt === 0) continue;
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
