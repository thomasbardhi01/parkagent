/**
 * The executor protocol: the only seam through which sessions touch
 * ParkNYC. The server computes what to buy and for how much; the executor
 * reports what actually happened (the real one may come back with a
 * different expiry or amount than we asked for, and callers must store the
 * executor's numbers, not their own).
 *
 * Two implementations live here: DryRunExecutor (logs, moves no money,
 * returns fake ids) and the ParkNYC stub in parknycExecutor.ts (interface
 * only; Phase 5 replaces it with a bridge to the Playwright package in
 * executor/ — nothing else may import that package).
 */

export interface StartSessionArgs {
  /** ParkNYC zone number as entered on the meter/app, e.g. "110436". */
  zoneNumber: string;
  minutes: number;
  /** What the server priced the buy at; the executor verifies/echoes it. */
  amountUsd: number;
  feeUsd: number;
  plate?: string;
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
  | "not_implemented"
  | "login_failed"
  | "zone_not_found"
  | "payment_declined"
  | "unexpected_screen"
  | "timeout";

export interface ExecutorOk {
  ok: true;
  providerSessionId: string;
  /** When the paid session now ends (for stop: when it was cut off). */
  expiresAt: Date;
  /** Dollars this call actually moved (meter + fee). */
  amountUsd: number;
}

export interface ExecutorError {
  ok: false;
  code: ExecutorErrorCode;
  message: string;
}

export type ExecutorResult = ExecutorOk | ExecutorError;

export interface Executor {
  startSession(args: StartSessionArgs): Promise<ExecutorResult>;
  extendSession(args: ExtendSessionArgs): Promise<ExecutorResult>;
  stopSession(args: StopSessionArgs): Promise<ExecutorResult>;
}

/** Picks the executor per call so a PUT /policy flip of dry_run takes effect. */
export type ExecutorProvider = (dryRun: boolean) => Executor;

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
