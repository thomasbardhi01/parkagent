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

/** How a ParkNYC call failed. The server stores this on decisions rows. */
export type ExecutorErrorCode =
  | "auth_expired" // storage state no longer signs us in
  | "zone_not_found" // ParkNYC rejected the zone number
  | "payment_declined" // ParkNYC's payment step refused
  | "ui_changed" // an expected screen/element never appeared
  | "network" // couldn't reach ParkNYC at all
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

export interface ExecutorOk {
  ok: true;
  providerSessionId: string;
  /** When the paid session now ends (for stop: when it was cut off). */
  expiresAt: Date;
  /** Dollars this call actually moved (meter + fee), as ParkNYC showed. */
  amountUsd: number;
}

export interface ExecutorError {
  ok: false;
  code: ExecutorErrorCode;
  message: string;
  diagnostics?: ExecutorDiagnostics;
}

export type ExecutorResult = ExecutorOk | ExecutorError;

// Argument shapes, mirroring the server protocol.

export interface StartSessionArgs {
  /** ParkNYC zone number as entered on the meter/app, e.g. "110436". */
  zoneNumber: string;
  minutes: number;
  /** What the server priced the buy at; ParkNYC's own total is returned. */
  amountUsd: number;
  feeUsd: number;
  plate?: string;
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

export interface AccountOps {
  /** Is this storage state a signed-in session? Reads, never writes. */
  verifyAccount(): Promise<VerifyAccountResult>;
  /** Make our Issuing card the account's payment method (replacing any). */
  setupCard(card: CardFormDetails): Promise<ProviderOpResult>;
  /** Best-effort removal of our card (matched by last4) from the account. */
  removeCard(last4: string): Promise<ProviderOpResult>;
  /** Top up the provider wallet from the card on file. */
  topupWallet(amountUsd: number): Promise<TopupWalletResult>;
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
