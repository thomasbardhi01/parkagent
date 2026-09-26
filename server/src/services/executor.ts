/**
 * The executor protocol: the only seam through which sessions touch
 * ParkNYC. The server computes what to buy and for how much; the executor
 * reports what actually happened (the real one may come back with a
 * different expiry or amount than we asked for, and callers must store the
 * executor's numbers, not their own).
 *
 * Two implementations exist: DryRunExecutor here (logs, moves no money,
 * returns fake ids) and the real ParkNYC bridge in parknycExecutor.ts,
 * which loads the Playwright package in executor/ — per the repo rule,
 * that bridge is the package's only importer.
 */

export interface StartSessionArgs {
  /** Zone number as entered on the meter/app, e.g. "110436". Always
   * required now: Boston numbers come from user reports at the meter
   * (POST /zones/:zoneId/provider-number) — the ParkBoston web app has no
   * map to resolve them from, and /session/start refuses earlier
   * (needs_zone_number) when the zone's number is still unknown. */
  zoneNumber: string;
  minutes: number;
  /** What the server priced the buy at; the executor verifies/echoes it. */
  amountUsd: number;
  feeUsd: number;
  plate?: string;
  /** The session's vehicle from the vehicles table. Passport's Vehicles
   * chooser lists saved vehicles as "<PLATE> (<STATE>)" buttons; the
   * executor clicks the matching one and answers vehicle_missing when
   * none does (it never clicks Add Vehicle). */
  vehicle?: { plate: string; state: string };
  /** The car's fix: feeds ParkNYC's NON-FATAL map cross-check only. */
  carLat?: number;
  carLng?: number;
  /** Street our zone data carries; cross-check evidence only. */
  expectedStreet?: string;
}

export interface ExtendSessionArgs {
  providerSessionId: string;
  minutes: number;
  /** The expiry we believe the session has now; the extension adds to it. */
  currentExpiresAt: Date;
  amountUsd: number;
  feeUsd: number;
}

export interface StopSessionArgs {
  providerSessionId: string;
}

export type ExecutorErrorCode =
  | "auth_expired" // provider storage state no longer signs us in
  | "zone_not_found" // the provider rejected the zone number
  | "payment_declined" // the provider's payment step refused
  | "ui_changed" // an expected screen/element never appeared
  | "network" // couldn't reach the provider at all
  | "browser_crashed" // Chromium died mid-call; the executor retried once first
  | "payment_method_missing" // the account has no saved payment method to charge
  | "free_period" // the provider says this zone isn't charging now (after hours)
  | "vehicle_missing" // the provider account has no saved vehicle matching the plate
  | "parking_denied" // the operator blocked re-parking (repark/zone lockout); NOT a charge
  | "timeout" // a hard budget ran out before the provider answered (linking)
  | "provider_unavailable" // the provider's circuit breaker is open: failing fast, nothing ran
  | "busy" // no browser slot freed up in time: nothing ran
  | "unknown"; // none of the above matched

/** How one real executor call went, for decisions and /admin/summary. Set
 * by the bridge (parknycExecutor.ts), never by the Playwright package. */
export interface ExecutorCallMeta {
  /** Waiting for a browser slot (ExecutorGate). */
  queueMs: number;
  /** In the browser. */
  runMs: number;
  /** Navigations retried once on a transient failure, before paying. */
  retries: number;
  /** How many calls were ahead when this one queued. */
  queuedBehind: number;
}

/** Evidence from an unexpected screen; the caller attaches it to decisions. */
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
 * What ParkNYC's own map said about where the car is — the NON-FATAL
 * cross-check against the stored zone number; both sides land on the
 * decision. (Passport has no map: ParkBoston numbers come from user
 * reports, see POST /zones/:zoneId/provider-number.)
 */
export interface ZoneResolution {
  mapZoneNumber: string;
  mapStreet: string;
  storedZoneNumber: string;
  expectedStreet: string | null;
  /** Map number vs stored number; null when uncheckable. */
  matched: boolean | null;
}

export interface ExecutorOk {
  ok: true;
  providerSessionId: string;
  /** When the paid session now ends (for stop: when it was cut off). */
  expiresAt: Date;
  /** Dollars this call actually moved (meter + fee). */
  amountUsd: number;
  /** The provider's receipt broken out (meter / fee / total), when the
   * confirm or session screen listed it — ParkBoston does. The server
   * records these ACTUALS on the decision so the audit matches the card,
   * which differs from the pre-charge estimate because ParkBoston sells in
   * per-zone duration increments (see the acceptance report, Job 2). */
  receipt?: { meterUsd: number; feeUsd: number; totalUsd: number };
  /** Present when the flow resolved the zone from the provider's map. */
  zoneResolution?: ZoneResolution;
  /** Zone terms the provider's own UI displayed mid-flow (Passport's
   * Vehicles chooser); logged on the decision and fed to
   * zone_terms_observed. */
  providerTerms?: ProviderZoneTerms;
  retries?: number;
  meta?: ExecutorCallMeta;
}

/** Zone terms as the provider displayed them (mirrors executor/types.ts). */
export interface ProviderZoneTerms {
  /** The terms line exactly as shown, e.g. "$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm". */
  rawText: string;
  ratePerHourUsd: number | null;
  maxStayMinutes: number | null;
  hours: ParsedProviderHours | null;
  /** Zone number/name echoed in the provider's screen header. */
  zoneNumber: string | null;
  zoneName: string | null;
}

/** Enforcement hours parsed from a provider free-period notice. */
export interface ParsedProviderHours {
  startLabel: string;
  endLabel: string;
  startMinutes: number;
  endMinutes: number;
  days: string[];
  tz: string | null;
}

export interface ExecutorError {
  ok: false;
  code: ExecutorErrorCode;
  message: string;
  diagnostics?: ExecutorDiagnostics;
  /** Set on code "free_period": provider notice text + parsed hours. */
  freePeriod?: { rawText: string; hours: ParsedProviderHours | null };
  /** Terms the provider displayed before the flow failed — kept so a run
   * that died after the Vehicles chooser still feeds zone_terms_observed. */
  providerTerms?: ProviderZoneTerms;
  /** The flow reached the pay click: whether it charged is unknown, and
   * nothing retried it. */
  afterPayClick?: boolean;
  retries?: number;
  meta?: ExecutorCallMeta;
}

export type ExecutorResult = ExecutorOk | ExecutorError;

/** The call's timings and retries for its decisions row (and
 * /admin/summary's per-stage p50/p95). Empty for dry-run calls. */
export function executorOutcome(result: ExecutorResult): Record<string, unknown> {
  const afterPayClick = !result.ok && result.afterPayClick === true;
  if (!result.meta && !afterPayClick) return {};
  return {
    executor: { ...(result.meta ?? {}), ...(afterPayClick ? { afterPayClick: true } : {}) },
  };
}

export interface Executor {
  startSession(args: StartSessionArgs): Promise<ExecutorResult>;
  extendSession(args: ExtendSessionArgs): Promise<ExecutorResult>;
  stopSession(args: StopSessionArgs): Promise<ExecutorResult>;
}

/** Who is parking and where — the executor now runs on that user's linked
 * provider account (services/parknycExecutor.ts). */
export interface ExecutorContext {
  userId: string;
  /** City key from the zone id ("nyc-…" → "nyc"); null when unparseable. */
  city: string | null;
  /** Effective dry run for this call (env || policy, re-read every call). */
  dryRun: boolean;
}

/** Picks the executor per call so a PUT /policy flip of dry_run takes effect. */
export type ExecutorProvider = (ctx: ExecutorContext) => Executor;

/**
 * Moves no money: logs what would have been bought and answers with fake
 * provider ids and exactly the requested expiry/amount.
 */
export class DryRunExecutor implements Executor {
  private counter = 0;

  constructor(
    private readonly log: (msg: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private fakeId(): string {
    this.counter += 1;
    return `dry-${this.now().getTime().toString(36)}-${this.counter}`;
  }

  async startSession(args: StartSessionArgs): Promise<ExecutorResult> {
    const providerSessionId = this.fakeId();
    const expiresAt = new Date(this.now().getTime() + args.minutes * 60_000);
    this.log(
      `[dry-run executor] would start zone ${args.zoneNumber} for ${args.minutes} min ` +
        `($${(args.amountUsd + args.feeUsd).toFixed(2)}) -> ${providerSessionId}`,
    );
    return { ok: true, providerSessionId, expiresAt, amountUsd: args.amountUsd + args.feeUsd };
  }

  async extendSession(args: ExtendSessionArgs): Promise<ExecutorResult> {
    const expiresAt = new Date(args.currentExpiresAt.getTime() + args.minutes * 60_000);
    this.log(
      `[dry-run executor] would extend ${args.providerSessionId} by ${args.minutes} min ` +
        `($${(args.amountUsd + args.feeUsd).toFixed(2)})`,
    );
    return {
      ok: true,
      providerSessionId: args.providerSessionId,
      expiresAt,
      amountUsd: args.amountUsd + args.feeUsd,
    };
  }

  async stopSession(args: StopSessionArgs): Promise<ExecutorResult> {
    this.log(`[dry-run executor] would stop ${args.providerSessionId}`);
    return {
      ok: true,
      providerSessionId: args.providerSessionId,
      expiresAt: this.now(),
      amountUsd: 0,
    };
  }
}
