/**
 * A circuit breaker per provider. When ParkBoston's site is down or
 * crawling, every user's call would otherwise open a browser, wait out its
 * timeouts, and fail — one after another, each holding a slot on a small
 * machine. After `threshold` consecutive provider-side failures the breaker
 * opens: calls fail at once with "provider_unavailable" (nothing ran, so
 * nothing was paid) and an honest message. After a cooldown one trial call
 * goes through; its success closes the breaker, its failure reopens it
 * with a longer cooldown.
 *
 * Only failures that say something about the PROVIDER count: a network
 * error, a timeout, a page that didn't look right. One user's problem (a
 * dead sign-in, a declined card, a zone number, a lockout) neither counts
 * nor resets the run.
 */

export type BreakerState = "closed" | "open" | "half_open";

export type BreakerVerdict = "success" | "provider_failure" | "neutral";

/** What a result code says about the provider's health. */
export function verdictFor(ok: boolean, code?: string): BreakerVerdict {
  if (ok) return "success";
  switch (code) {
    case "network":
    case "timeout":
    case "ui_changed":
    case "unknown":
      return "provider_failure";
    default:
      return "neutral";
  }
}

export interface BreakerTransition {
  provider: string;
  from: BreakerState;
  to: BreakerState;
  consecutiveFailures: number;
  lastCode: string | null;
  cooldownMs: number;
}

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  /** Every state change — the caller writes it to the decisions table. */
  onTransition?: (transition: BreakerTransition) => void;
}

interface ProviderCircuit {
  state: BreakerState;
  failures: number;
  lastCode: string | null;
  openedAt: number;
  cooldownMs: number;
  trialInFlight: boolean;
  trips: number;
}

export type Admission = { ok: true; trial: boolean } | { ok: false; retryInMs: number };

export class CircuitBreaker {
  private readonly circuits = new Map<string, ProviderCircuit>();
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.baseCooldownMs = options.cooldownMs ?? 60_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 10 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  private circuit(provider: string): ProviderCircuit {
    let circuit = this.circuits.get(provider);
    if (!circuit) {
      circuit = {
        state: "closed",
        failures: 0,
        lastCode: null,
        openedAt: 0,
        cooldownMs: this.baseCooldownMs,
        trialInFlight: false,
        trips: 0,
      };
      this.circuits.set(provider, circuit);
    }
    return circuit;
  }

  state(provider: string): BreakerState {
    return this.circuit(provider).state;
  }

  /** Trips since boot, for /admin/summary. */
  trips(provider: string): number {
    return this.circuit(provider).trips;
  }

  /** May a call run now? In half-open, only one trial at a time. */
  admit(provider: string): Admission {
    const circuit = this.circuit(provider);
    if (circuit.state === "closed") return { ok: true, trial: false };
    if (circuit.state === "open") {
      const waited = this.now() - circuit.openedAt;
      if (waited < circuit.cooldownMs) return { ok: false, retryInMs: circuit.cooldownMs - waited };
      this.move(provider, circuit, "half_open");
    }
    if (circuit.trialInFlight) return { ok: false, retryInMs: 5_000 };
    circuit.trialInFlight = true;
    return { ok: true, trial: true };
  }

  /**
   * A call's outcome. `trial` is what `admit` said for that call: only the
   * trial's outcome decides a half-open breaker — a slow call admitted
   * before the breaker opened can't end the trial or double the cooldown.
   */
  record(
    provider: string,
    verdict: BreakerVerdict,
    code: string | null = null,
    trial = false,
  ): void {
    const circuit = this.circuit(provider);
    const wasTrial = trial && circuit.state === "half_open";
    if (wasTrial) circuit.trialInFlight = false;
    if (verdict === "neutral") return;
    if (verdict === "success") {
      circuit.failures = 0;
      circuit.lastCode = null;
      if (circuit.state !== "closed") {
        circuit.cooldownMs = this.baseCooldownMs;
        this.move(provider, circuit, "closed");
      }
      return;
    }
    circuit.failures += 1;
    circuit.lastCode = code;
    if (wasTrial) {
      // The trial failed: back open, and wait longer this time.
      circuit.cooldownMs = Math.min(circuit.cooldownMs * 2, this.maxCooldownMs);
      this.open(provider, circuit);
    } else if (circuit.state === "closed" && circuit.failures >= this.threshold) {
      this.open(provider, circuit);
    }
  }

  private open(provider: string, circuit: ProviderCircuit): void {
    circuit.openedAt = this.now();
    circuit.trips += 1;
    this.move(provider, circuit, "open");
  }

  private move(provider: string, circuit: ProviderCircuit, to: BreakerState): void {
    const from = circuit.state;
    if (from === to) return;
    circuit.state = to;
    this.options.onTransition?.({
      provider,
      from,
      to,
      consecutiveFailures: circuit.failures,
      lastCode: circuit.lastCode,
      cooldownMs: circuit.cooldownMs,
    });
  }
}
