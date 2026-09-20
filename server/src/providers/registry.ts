/**
 * The provider registry: which parking operator runs each city's meters,
 * and everything the server and app need to link a user's account there —
 * display name, the login URL the app's web view opens, and the cookie
 * domains that constitute a signed-in session (POST /providers/:provider/link
 * filters captured cookies against them; anything else is dropped).
 *
 * The multi-city foundation: zone ids are "<city>-<zone number>"
 * (data/build_zones.py), so the city — and from it the provider — falls out
 * of any zoneId. Today only NYC is real; Boston is a placeholder proving
 * the shape, and an unknown city simply has no provider (no linking, no
 * executor, sessions refuse).
 */

export type ProviderId = "parknyc" | "passport";

export interface ProviderInfo {
  id: ProviderId;
  /** City key, the zoneId prefix ("nyc-…"). */
  city: string;
  displayName: string;
  /** Where the app's link web view starts the user. */
  loginUrl: string;
  /**
   * Cookie domains (suffix match, leading dot ignored) that carry the
   * provider session. Only these survive the link filter.
   */
  cookieDomains: string[];
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "parknyc",
    city: "nyc",
    displayName: "ParkNYC",
    // Flowbird's SPA — parknyc.org is only the marketing site (see
    // executor/src/parknyc/selectors.ts).
    loginUrl: "https://my.nyc.flowbirdapp.com/#/Parking?panel=login",
    cookieDomains: ["nyc.flowbirdapp.com", "flowbirdapp.com"],
  },
  {
    // Placeholder: proves the registry shape for city #2. No executor
    // exists for it yet — linking verifies nothing and sessions refuse.
    id: "passport",
    city: "bos",
    displayName: "Passport Parking (Boston)",
    loginUrl: "https://ppprk.com/park/",
    cookieDomains: ["ppprk.com"],
  },
];

/** "nyc-110436" → "nyc". Null when the id has no city prefix. */
export function cityForZone(zoneId: string): string | null {
  const dash = zoneId.indexOf("-");
  return dash > 0 ? zoneId.slice(0, dash) : null;
}

export function providerForCity(city: string | null): ProviderInfo | null {
  if (city === null) return null;
  return PROVIDERS.find((p) => p.city === city) ?? null;
}

export function providerById(id: string): ProviderInfo | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export function allProviders(): ProviderInfo[] {
  return [...PROVIDERS];
}

/** Does this cookie belong to one of the provider's session domains? */
export function cookieDomainAllowed(provider: ProviderInfo, domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  return provider.cookieDomains.some((allowed) => bare === allowed || bare.endsWith("." + allowed));
}
