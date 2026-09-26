/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * These types structurally mirror the server's executor protocol
 * (server/src/services/executor.ts). They are duplicated on purpose: the
 * executor must not import server code, and the server imports only this
 * package's public surface through its parknycExecutor.ts bridge.
 */

/** How a provider call failed. The server stores this on decisions rows. */
export type ExecutorErrorCode =
  | "auth_expired" // storage state no longer signs us in
  | "zone_not_found" // the provider rejected the zone number
  | "payment_declined" // the provider's payment step refused
  | "ui_changed" // an expected screen/element never appeared
  | "network" // couldn't reach the provider at all
  | "browser_crashed" // the shared Chromium died mid-call (retried once first)
  | "payment_method_missing" // the account has no saved payment method to charge
  | "free_period" // the provider says this zone isn't charging now (after hours)
  | "vehicle_missing" // the provider account has no saved vehicle matching the plate
  | "parking_denied" // the operator blocked re-parking (repark/zone lockout); NOT a charge
  | "timeout" // the caller's hard budget ran out (account ops: linking)
  | "unknown"; // none of the above matched

/** Evidence captured from an unexpected screen; attached to decisions. */
export interface ExecutorDiagnostics {
  /** JPEG screenshot of the page when the flow derailed. */
  screenshotBase64?: string;
  /** The page's visible text (truncated). */
  pageText?: string;
  /** Local file copies, when a capture directory is configured. */
  screenshotPath?: string;
  textPath?: string;
}

/**
 * What the provider's own map said about where the car is: the zone whose
 * pin sits nearest the car coordinates, as shown in the zone panel. For
 * Boston this is the authoritative zone number (our data has none); for NYC
 * it is a cross-check against the stored number. Both sides are recorded on
 * the decisions row.
 */
export interface ZoneResolution {
  /** Zone number read off the provider's map panel. */
  mapZoneNumber: string;
  /** Street/zone name shown on the map panel. */
  mapStreet: string;
  /** The zone number the server asked us to pay ("" for Boston zones). */
  storedZoneNumber: string;
  /** Street our zone data carries; null when unknown. */
  expectedStreet: string | null;
  /** Did the two agree (number for NYC, street for Boston)? Null when the
   * comparison had nothing to compare against. */
  matched: boolean | null;
}

export interface ExecutorOk {
  ok: true;
  providerSessionId: string;
  /** When the paid session now ends (for stop: when it was cut off). */
  expiresAt: Date;
  /** Dollars this call actually moved (meter + fee), as the provider showed. */
  amountUsd: number;
  /** The provider's receipt broken out (meter / fee / total), when the
   * confirm or session screen listed it — ParkBoston does. Lets the server
   * record what the card actually paid instead of its pre-charge estimate,
   * which differs because ParkBoston sells in per-zone duration increments. */
  receipt?: { meterUsd: number; feeUsd: number; totalUsd: number };
  /** stopSession only: the provider offers no early stop for this zone
   * (ParkBoston zone 456 — meter time is non-refundable), so the local
   * session is marked stopped but nothing was cancelled or refunded. */
  stopNotSupported?: boolean;
  /** Present when the flow resolved the zone from the provider's map. */
  zoneResolution?: ZoneResolution;
  /** The zone terms the provider itself displayed mid-flow (Passport's
   * Vehicles chooser shows a Zone Information line); the server logs them
   * and compares against our zone record. */
  providerTerms?: ProviderZoneTerms;
  /** Navigations retried once on a transient failure, before the pay click. */
  retries?: number;
}

/**
 * Zone terms as the provider's own UI displayed them — Passport's Vehicles
 * chooser carries a "Zone Information" line ("$3.75 Hr|Max 5 Hr|M-Sat
 * 8am-8pm") plus the zone number and name in its header. Evidence for the
 * server's zone_terms_observed table; null fields mean "not shown or not
 * parsed", never a claim of absence.
 */
export interface ProviderZoneTerms {
  /** The Zone Information line exactly as shown. */
  rawText: string;
  ratePerHourUsd: number | null;
  maxStayMinutes: number | null;
  hours: ParsedProviderHours | null;
  /** Zone number echoed in the chooser header ("… park in Zone 456 (…)"). */
  zoneNumber: string | null;
  /** Zone/block name from the same header parenthetical. */
  zoneName: string | null;
}

/** Enforcement hours parsed from a provider's free-period notice, so we
 * can compare them against our zone data. */
export interface ParsedProviderHours {
  /** As written, e.g. "8am"/"8pm". */
  startLabel: string;
  endLabel: string;
  /** Minutes past midnight (local), e.g. 480 / 1200. */
  startMinutes: number;
  endMinutes: number;
  /** Enforced days, e.g. ["Mon","Tue","Wed","Thu","Fri","Sat"]. */
  days: string[];
  /** Timezone label if stated, e.g. "EST". */
  tz: string | null;
}

export interface ExecutorError {
  ok: false;
  code: ExecutorErrorCode;
  message: string;
  diagnostics?: ExecutorDiagnostics;
  /** Set on code "free_period": the provider's after-hours notice text
   * and the hours parsed out of it. */
  freePeriod?: { rawText: string; hours: ParsedProviderHours | null };
  /** Zone terms the provider displayed before the flow ended — kept on
   * failures too, so a run that died after the Vehicles chooser still
   * feeds zone_terms_observed. */
  providerTerms?: ProviderZoneTerms;
  /** The flow got as far as the pay click. Nothing may retry it (not even
   * a browser-crash retry): whether the provider charged is unknown. */
  afterPayClick?: boolean;
  /** Navigations retried once on a transient failure, before the pay click. */
  retries?: number;
}

export type ExecutorResult = ExecutorOk | ExecutorError;

// Argument shapes, mirroring the server protocol.

export interface StartSessionArgs {
  /** Zone number as entered on the meter/app, e.g. "110436". "" for Boston
   * zones — Analyze Boston publishes no ParkBoston numbers, so the Passport
   * client resolves the zone from the provider's own map instead. */
  zoneNumber: string;
  minutes: number;
  /** What the server priced the buy at; the provider's own total is returned. */
  amountUsd: number;
  feeUsd: number;
  plate?: string;
  /** The session's vehicle from the server's vehicles table. Passport's
   * Vehicles chooser lists saved vehicles as "<PLATE> (<STATE>)" buttons;
   * the client clicks the one matching this and returns vehicle_missing
   * when none does. */
  vehicle?: { plate: string; state: string };
  /** Where the car is (the parked event's fix): feeds ParkNYC's non-fatal
   * map cross-check. The Passport client ignores it — ParkBoston has no
   * map (2026-09-21 recording); its zone numbers come from user reports. */
  carLat?: number;
  carLng?: number;
  /** The street our zone data says the car is on; cross-check evidence. */
  expectedStreet?: string;
}

export interface ExtendSessionArgs {
  providerSessionId: string;
  minutes: number;
  currentExpiresAt: Date;
  amountUsd: number;
  feeUsd: number;
}

export interface StopSessionArgs {
  providerSessionId: string;
}

export interface Executor {
  startSession(args: StartSessionArgs): Promise<ExecutorResult>;
  extendSession(args: ExtendSessionArgs): Promise<ExecutorResult>;
  stopSession(args: StopSessionArgs): Promise<ExecutorResult>;
}

// ---------------------------------------------------------------------------
// Provider account operations (linking, card setup, wallet) — the flows a
// linked account needs beyond parking sessions.

/** Account ops can additionally fail on a card brand the form can't take. */
export type ProviderOpErrorCode = ExecutorErrorCode | "unsupported_card_brand";

export interface ProviderOpError {
  ok: false;
  code: ProviderOpErrorCode;
  message: string;
  diagnostics?: ExecutorDiagnostics;
}

export type ProviderOpResult = { ok: true } | ProviderOpError;

export type VerifyAccountResult =
  | {
      ok: true;
      /** Provider wallet balance when visible; null when not shown. */
      walletBalanceCents: number | null;
    }
  | ProviderOpError;

export type TopupWalletResult = { ok: true; walletBalanceCents: number | null } | ProviderOpError;

/** Brand + last4 of the card the provider account already has on file,
 * read from its Your Cards screen for display (provider_card users).
 * Nulls mean no card was listed (or details were hidden) — a success. */
export type ReadSavedCardResult =
  { ok: true; brand: string | null; last4: string | null } | ProviderOpError;

/**
 * The sensitive card fields the payment form needs, fetched by the SERVER
 * from Stripe just before the call and passed straight through. Never log
 * them; setupCard blanks the object after the form is submitted.
 */
export interface CardFormDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  /** Stripe Issuing brand, e.g. "Visa" — drives the form's card-type radio. */
  brand: string;
}

/** How long a read may take, and how the caller stops it early. Linking
 * runs these under a hard budget: when it runs out the call's browser
 * context is closed and the result is code "timeout". */
export interface AccountOpOptions {
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface AccountOps {
  /** Is this storage state a signed-in session? Reads, never writes. The
   * lightest check that proves it: the account page to DOM-ready, images
   * and fonts not fetched, and the signed-in marker. */
  verifyAccount(options?: AccountOpOptions): Promise<VerifyAccountResult>;
  /** Make our Issuing card the account's payment method (replacing any). */
  setupCard(card: CardFormDetails): Promise<ProviderOpResult>;
  /** Best-effort removal of our card (matched by last4) from the account. */
  removeCard(last4: string): Promise<ProviderOpResult>;
  /** Top up the provider wallet from the card on file. */
  topupWallet(amountUsd: number): Promise<TopupWalletResult>;
  /** Read the brand/last4 of the account's own saved card, for display. */
  readSavedCard(options?: AccountOpOptions): Promise<ReadSavedCardResult>;
}

/**
 * A Playwright storage state passed as a value (the server decrypts it per
 * call) instead of a file path. Structurally what context.storageState()
 * returns; only cookies matter for ParkNYC.
 */
export interface StorageStateValue {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }[];
  origins: never[] | { origin: string; localStorage: { name: string; value: string }[] }[];
}
