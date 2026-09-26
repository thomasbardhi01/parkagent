/**
 * Named-place geocoding for the assistant. "find me a garage on Newbury
 * Street", "near India Street" name a PLACE, not the phone's dot — so the
 * assistant must resolve that place to coordinates and search there, never
 * silently fall back to the current location. This is the tool that does
 * it, biased hard to the cities ParkAgent covers so a street name lands in
 * one of them, not one of the dozen same-named streets elsewhere in the
 * country. The user-facing city list comes from the provider registry
 * (coveredCitiesSentence); the boxes below are this file's own data.
 *
 * Two implementations sit behind one interface, chained by
 * FallbackGeocoder: the Apple Maps Server API (appleMaps.ts — businesses,
 * venues, and landmarks by the names people use) when its key is
 * configured, then Nominatim (OpenStreetMap: streets, neighborhoods,
 * landmarks; the same free geocoder the Boston zone-number importer uses).
 * Both take an injectable HTTP fetch so tests run offline against
 * fixtures. Results outside both metros' bounding boxes are dropped — a
 * parking answer 500 miles away is never useful — and what remains is
 * ranked by the search's own relevance with a nudge toward the biasing
 * city.
 */

import { coveredCities } from "../../providers/registry.js";

/** WGS84 bounding boxes for the metros we cover: [minLng, minLat, maxLng, maxLat]. */
export const METRO_BBOX = {
  // NYC + close-in (roughly Yonkers down to the harbor, Newark to eastern Queens).
  nyc: [-74.3, 40.49, -73.68, 40.93] as const,
  // Boston + close-in (Brookline/Cambridge/Somerville through Dorchester/Southie).
  bos: [-71.19, 42.29, -70.98, 42.43] as const,
};

/** Center of each metro, for the bias nudge. */
export const METRO_CENTER = {
  nyc: { lat: 40.7549, lng: -73.984 },
  bos: { lat: 42.3555, lng: -71.0655 },
};

export type MetroCity = "nyc" | "bos";

/**
 * Which metros an unbiased search tries, alphabetical by city display name
 * via the registry — the order only affects tie-breaking, and hardcoding it
 * would quietly favour one city.
 */
const SEARCH_ORDER: MetroCity[] = coveredCities()
  .map((p) => p.city)
  .filter((city): city is MetroCity => city === "nyc" || city === "bos");

/** The covered metros, in the registry's unbiased order. */
export function coveredMetros(): MetroCity[] {
  return [...SEARCH_ORDER];
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** The provider's display name, trimmed to something a card can show. */
  displayName: string;
  /** Which metro's box this point fell inside. */
  city: MetroCity;
  /** The place's own name ("LoLa 42", "Seaport"), when the source has one. */
  name?: string | undefined;
  /** Its street address line ("22 Liberty Dr"). */
  address?: string | undefined;
  /** The neighborhood it sits in ("Seaport") — for the assumptions line. */
  area?: string | undefined;
  /** Every locality / neighborhood / area-of-interest name the source gave
   * — how "Moo steakhouse in Seaport" prefers the Seaport location. */
  areaNames?: string[] | undefined;
  /** "poi": a business, venue, or landmark; "address"; "area": a street
   * or neighborhood. */
  kind?: "poi" | "address" | "area" | undefined;
  /** The source's category for a POI ("Restaurant"). */
  category?: string | undefined;
  /** Which search produced it ("apple_maps" | "nominatim"). */
  source?: string | undefined;
}

export interface GeocodeQuery {
  query: string;
  /** Bias toward this metro when the caller knows it (e.g. the phone's
   * city). Absent → both metros are searched and whichever matches wins. */
  city?: MetroCity | undefined;
  /** Search around this point first (the phone, when it's in the biased
   * metro); absent → the metro's center. */
  near?: { lat: number; lng: number } | undefined;
  /** Where the phone is, as a secondary hint. */
  userLocation?: { lat: number; lng: number } | undefined;
}

export interface GeocoderProvider {
  /** Up to `limit` matches inside a covered metro, best first; empty when
   * the place couldn't be resolved to either city. Never throws — a
   * transport failure returns `{ ok: false }` so the tool can tell the
   * model "couldn't locate that" rather than crash the turn. */
  geocode(
    q: GeocodeQuery,
    limit?: number,
  ): Promise<{ ok: true; results: GeocodeResult[] } | { ok: false; reason: string }>;
}

function inBox(lat: number, lng: number, box: readonly [number, number, number, number]): boolean {
  return lng >= box[0] && lat >= box[1] && lng <= box[2] && lat <= box[3];
}

/** Which metro a point sits in, or null if neither. */
export function metroForPoint(lat: number, lng: number): MetroCity | null {
  if (inBox(lat, lng, METRO_BBOX.bos)) return "bos";
  if (inBox(lat, lng, METRO_BBOX.nyc)) return "nyc";
  return null;
}

/** A phone this close to a metro's center is in that city as far as a
 * driver is concerned — Braintree, Quincy, and Newton sit outside the
 * box but mean the same city (the 2026-09-25 device test was sent from
 * Braintree and got asked which city). The two metros are ~300 km apart,
 * so the radii never overlap. */
export const NEAR_METRO_KM = 60;

/** The metro a phone is in or near (see NEAR_METRO_KM), or null. */
export function homeMetroForPoint(lat: number, lng: number): MetroCity | null {
  const inside = metroForPoint(lat, lng);
  if (inside) return inside;
  let best: { city: MetroCity; d: number } | null = null;
  for (const city of SEARCH_ORDER) {
    const c = METRO_CENTER[city];
    const d = metersBetween(lat, lng, c.lat, c.lng);
    if (d <= NEAR_METRO_KM * 1000 && (best === null || d < best.d)) best = { city, d };
  }
  return best?.city ?? null;
}

/** Haversine metres — shared with the proximity guard. */
export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** One raw Nominatim row we care about. */
interface NominatimRow {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  category?: string;
  importance?: number;
  /** addressdetails=1: the structured address. */
  address?: {
    house_number?: string;
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
  };
}

/** OSM categories that name an area, a street, or a landmark-like stop
 * rather than a business or venue. */
const NOMINATIM_AREA_CATEGORIES = new Set([
  "place",
  "boundary",
  "highway",
  "landuse",
  "railway",
  "public_transport",
  "natural",
  "waterway",
]);

export interface NominatimGeocoderOptions {
  /** Injectable for tests; defaults to global fetch against the public API. */
  fetchFn?: typeof fetch;
  /** Identify the client per Nominatim's usage policy. */
  userAgent?: string;
  baseUrl?: string;
  now?: () => Date;
}

/**
 * Nominatim-backed geocoder. Queries each candidate metro's viewbox
 * (bounded), keeps only points inside a covered box, and ranks by the
 * provider's importance with a small bias to the requested city. A
 * 10-minute in-memory cache keeps repeated "Newbury Street" lookups off
 * the network (and inside the 1 req/s courtesy limit).
 */
export class NominatimGeocoder implements GeocoderProvider {
  readonly id = "nominatim";
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; results: GeocodeResult[] }>();
  private static readonly TTL_MS = 10 * 60_000;

  constructor(opts: NominatimGeocoderOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.userAgent = opts.userAgent ?? "ParkAgent/1.0 (parking assistant; personal prototype)";
    this.baseUrl = opts.baseUrl ?? "https://nominatim.openstreetmap.org";
    this.now = opts.now ?? (() => new Date());
  }

  async geocode(
    q: GeocodeQuery,
    limit = 3,
  ): Promise<{ ok: true; results: GeocodeResult[] } | { ok: false; reason: string }> {
    const key = `${q.city ?? "both"}::${q.query.trim().toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && this.now().getTime() - cached.at < NominatimGeocoder.TTL_MS) {
      return { ok: true, results: cached.results.slice(0, limit) };
    }
    // Which metros to try: the biased one FIRST and alone if it matches;
    // the other covered metros only as a fallback, so a street name from a
    // phone in one city stays there but a landmark in another still
    // resolves. Unbiased: every covered one.
    const cities: MetroCity[] = q.city
      ? [q.city, ...SEARCH_ORDER.filter((c) => c !== q.city)]
      : SEARCH_ORDER;
    const all: GeocodeResult[] = [];
    try {
      for (const city of cities) {
        // Biased search: stop at the first metro that matched.
        if (q.city && all.length > 0) break;
        const rows = await this.queryCity(q.query, city);
        for (const row of rows) {
          const lat = Number(row.lat);
          const lng = Number(row.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const metro = metroForPoint(lat, lng);
          if (!metro) continue; // outside both boxes — never useful for parking
          const parts = row.display_name.split(",").map((part) => part.trim());
          const a = row.address ?? {};
          const street = [a.house_number, a.road].filter(Boolean).join(" ");
          all.push({
            lat,
            lng,
            displayName: parts.slice(0, 3).join(", "),
            city: metro,
            name: row.name || parts[0],
            ...(street && street !== row.name ? { address: street } : {}),
            area: a.neighbourhood ?? a.suburb ?? a.city ?? a.town ?? parts[1],
            areaNames: [a.neighbourhood, a.suburb, a.city, a.town, ...parts.slice(1, 4)].filter(
              (part): part is string => !!part,
            ),
            kind: NOMINATIM_AREA_CATEGORIES.has(row.category ?? "") ? "area" : "poi",
            source: this.id,
          });
        }
      }
    } catch (err) {
      const reason =
        err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
      return { ok: false, reason };
    }
    // De-dupe near-identical points (the same place from two metro queries)
    // and rank by distance to the biasing city's centre when one was given.
    const deduped = dedupeByProximity(all);
    if (q.city) {
      const c = METRO_CENTER[q.city];
      deduped.sort(
        (a, b) =>
          metersBetween(a.lat, a.lng, c.lat, c.lng) - metersBetween(b.lat, b.lng, c.lat, c.lng),
      );
    }
    this.cache.set(key, { at: this.now().getTime(), results: deduped });
    return { ok: true, results: deduped.slice(0, limit) };
  }

  private async queryCity(query: string, city: MetroCity): Promise<NominatimRow[]> {
    const box = METRO_BBOX[city];
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "5",
      countrycodes: "us",
      // viewbox is minLng,minLat,maxLng,maxLat with bounded=1 to HARD-limit
      // results to the metro — this is the whole point of the city bias.
      viewbox: `${box[0]},${box[1]},${box[2]},${box[3]}`,
      bounded: "1",
    });
    const res = await this.fetchFn(`${this.baseUrl}/search?${params.toString()}`, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const body = (await res.json()) as NominatimRow[];
    return Array.isArray(body) ? body : [];
  }
}

/** Collapse results within ~50 m of an already-kept one (same place from
 * the two metro queries), keeping the first (higher-ranked) occurrence. */
function dedupeByProximity(results: GeocodeResult[]): GeocodeResult[] {
  const kept: GeocodeResult[] = [];
  for (const r of results) {
    if (kept.some((k) => metersBetween(k.lat, k.lng, r.lat, r.lng) < 50)) continue;
    kept.push(r);
  }
  return kept;
}

/**
 * Tries each geocoder in order and returns the first that found anything
 * — Apple Maps (POIs) first when configured, Nominatim after it. A source
 * that FAILS (network, quota, a bad key) falls through to the next rather
 * than failing the lookup; only every source failing is a failure.
 */
export class FallbackGeocoder implements GeocoderProvider {
  /** `carriesName` says whether a source's results include the place the
   * query names; when they don't, the next source is asked too and both
   * sets are returned (the first source's first) — an Apple fuzzy
   * near-miss mustn't hide Nominatim's exact street. Absent: any result
   * is enough. */
  constructor(
    private readonly chain: GeocoderProvider[],
    private readonly carriesName: (query: string, results: GeocodeResult[]) => boolean = () => true,
  ) {}

  async geocode(
    q: GeocodeQuery,
    limit?: number,
  ): Promise<{ ok: true; results: GeocodeResult[] } | { ok: false; reason: string }> {
    let answered = false;
    const failures: string[] = [];
    let found: GeocodeResult[] = [];
    for (const geocoder of this.chain) {
      const outcome = await geocoder.geocode(q, limit);
      if (!outcome.ok) {
        failures.push(outcome.reason);
        continue;
      }
      answered = true;
      found = [...found, ...outcome.results];
      if (found.length > 0 && this.carriesName(q.query, found)) {
        return { ok: true, results: found };
      }
    }
    return answered
      ? { ok: true, results: found }
      : { ok: false, reason: failures.join("; ") || "no geocoder configured" };
  }
}
