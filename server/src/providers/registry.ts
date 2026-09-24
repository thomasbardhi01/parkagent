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

/** A field the app may prefill into the provider's own sign-up page —
 * value typed by us, submitted by the USER on the provider's page. The app
 * only ever sets text inputs: verification codes, terms checkboxes, and
 * captchas are the user's, always. */
export interface SignupPrefillField {
  /** Which profile value goes in. */
  field: "emailOrPhone" | "email" | "phone" | "firstName" | "lastName" | "zip" | "plate";
  /** CSS selector of the input on the provider's page. */
  selector: string;
}

/** Link-or-create metadata: how the app helps a user who has NO provider
 * account yet open one on the provider's own page, typing nothing twice.
 * Accounts are never created without the user present, passwords are never
 * stored, and nothing beyond text prefill is automated. */
export interface ProviderSignupInfo {
  /** Where "create an account" starts in the app's web view. */
  url: string;
  /** "passwordless" (Passport: code + PIN, no password ever) | "form". */
  mode: "passwordless" | "form";
  /** One sentence the app shows above the web view. */
  note: string;
  prefill: SignupPrefillField[];
}

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
  signup: ProviderSignupInfo;
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
    signup: {
      // The SPA's registration panel sits next to the login panel.
      // Selectors DRAFTED from the recorded login-panel markup's naming
      // convention (TODO-verify against a live registration recording —
      // mirrored in test/fixtures/signup/parknyc-registration.html so the
      // registry and the fixture can't drift apart silently).
      url: "https://my.nyc.flowbirdapp.com/#/Parking?panel=register",
      mode: "form",
      note: "Create your ParkNYC account on ParkNYC's own page — we never see your password.",
      prefill: [
        { field: "firstName", selector: "input[name='firstName']" },
        { field: "lastName", selector: "input[name='lastName']" },
        { field: "email", selector: "input[name='email']" },
        { field: "phone", selector: "input[name='phoneNumber']" },
        { field: "zip", selector: "input[name='zipCode']" },
        { field: "plate", selector: "input[name='licensePlate']" },
      ],
    },
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
    signup: {
      // Passport is passwordless: sign-in and sign-up are the SAME entry
      // screen — T&C accept, then the e-mail/phone field (#regEmail,
      // VERIFIED live 2026-09-20 — see executor/src/passport/selectors.ts),
      // a mailed/texted code, then a 4-digit PIN the user picks. Prefill
      // types the address; the code, PIN, and T&C tap stay the user's.
      url: "https://bostonma.ppprk.com/park/",
      mode: "passwordless",
      note: "Sign in or sign up on ParkBoston's own page — we never see a password; there isn't one.",
      prefill: [{ field: "emailOrPhone", selector: "#regEmail" }],
    },
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

/**
 * Covered cities in a stable, unbiased order: alphabetical by display name.
 * The array order above is historical (NYC came first), and nothing
 * user-facing should imply a home city.
 */
export function coveredCities(): ProviderInfo[] {
  return [...PROVIDERS].sort((a, b) => a.cityDisplayName.localeCompare(b.cityDisplayName));
}

/**
 * "Boston and New York City" — the one place user-facing copy (assistant
 * prompt, tool descriptions, explanations) gets the city list, so adding a
 * city never leaves a stale sentence behind.
 */
export function coveredCitiesSentence(): string {
  const names = coveredCities().map((p) => p.cityDisplayName);
  if (names.length === 0) return "the cities we cover";
  if (names.length === 1) return names[0] as string;
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/**
 * Account statuses that still pay: "linked", and "expiring" — the health
 * job saw the session cookies dying soon and nudged a re-link, but the
 * session still works today. "expired"/"unlinked" refuse.
 */
export function providerStatusUsable(status: string | null | undefined): boolean {
  return status === "linked" || status === "expiring";
}

/** Does this cookie belong to one of the provider's session domains? */
export function cookieDomainAllowed(provider: ProviderInfo, domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  return provider.cookieDomains.some((allowed) => bare === allowed || bare.endsWith("." + allowed));
}
