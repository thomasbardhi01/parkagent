/**
 * The provider registry: which parking operator runs each city's meters,
 * and everything the server and app need to link a user's account there —
 * display name, the login URL the app's web view opens, and the cookie
 * domains that constitute a signed-in session (POST /providers/:provider/link
 * filters captured cookies against them; anything else is dropped).
 *
 * The multi-city foundation: zone ids are "<city>-<zone number>"
 * (data/build_zones.py), so the city — and from it the provider — falls out
 * of any zoneId. NYC (ParkNYC/Flowbird) and Boston (ParkBoston/Passport)
 * both have executors now; an unknown city simply has no provider (no
 * linking, no executor, sessions refuse).
 */

export type ProviderId = "parknyc" | "passport";

export interface ProviderInfo {
  id: ProviderId;
  /** City key, the zoneId prefix ("nyc-…"). */
  city: string;
  /** What the app calls the city ("New York City"). */
  cityDisplayName: string;
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
    cityDisplayName: "New York City",
    displayName: "ParkNYC",
    // Flowbird's SPA — parknyc.org is only the marketing site (see
    // executor/src/parknyc/selectors.ts).
    loginUrl: "https://my.nyc.flowbirdapp.com/#/Parking?panel=login",
    cookieDomains: ["nyc.flowbirdapp.com", "flowbirdapp.com"],
  },
  {
    id: "passport",
    city: "bos",
    cityDisplayName: "Boston",
    displayName: "ParkBoston",
    // Passport's white-label web app, ParkBoston instance (verified
    // headlessly 2026-09-20: renders Sign In / Register / Continue as
    // Guest; sign-in is passwordless — T&C accept, then an e-mail/phone
    // code, then a 4-digit PIN). park.boston.gov is only the marketing
    // page, and the bare ppprk.com is the unbranded multi-city entry.
    loginUrl: "https://bostonma.ppprk.com/park/",
    // The signed-in session lives on bostonma.ppprk.com (ppprk.com suffix
    // covers it); "Continue as Guest" hops to parkboston.paywithpassport.com,
    // whose cookies are accepted too in case the app's web view captures
    // them alongside.
    cookieDomains: ["ppprk.com", "paywithpassport.com"],
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
