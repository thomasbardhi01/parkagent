/**
 * How many browser calls run at once on this machine. Every real provider
 * call (paying, extending, stopping, linking, reading a card, the daily
 * health check) opens a Chromium context, and the 1 GB Fly machine runs
 * out of memory well before the provider does. Calls past the limit wait
 * in arrival order; each waiter can hear its place in line (the link job
 * shows it: "2 ahead of you"), and a wait can be bounded, so a queued call
 * fails typed ("busy", nothing ran) instead of hanging.
 */

export interface GateTicket {
  /** How long this call waited for its slot. */
  queueMs: number;
  /** How many calls were ahead of it when it arrived. */
  queuedBehind: number;
  release(): void;
}

export interface AcquireOptions {
  /** Give up after waiting this long (GateWaitError "busy"). */
  maxWaitMs?: number;
  /** Stop waiting when this aborts (GateWaitError "aborted"). */
  signal?: AbortSignal;
  /** Called with the number of calls ahead, on arrival and whenever it changes. */
  onPosition?: (ahead: number) => void;
}

export class GateWaitError extends Error {
  constructor(readonly reason: "busy" | "aborted") {
    super(
      reason === "busy"
        ? "no browser slot freed up in time"
        : "stopped while waiting for a browser slot",
    );
    this.name = "GateWaitError";
  }
}

interface Waiter {
  grant: () => void;
  onPosition?: (ahead: number) => void;
}

export class ExecutorGate {
  private running = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    readonly capacity: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (capacity < 1) throw new Error("ExecutorGate capacity must be at least 1");
  }

  get inUse(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  acquire(options: AcquireOptions = {}): Promise<GateTicket> {
    const arrived = this.now();
    const queuedBehind = this.waiting.length + Math.max(0, this.running - this.capacity + 1);
    if (this.running < this.capacity && this.waiting.length === 0) {
      this.running += 1;
      options.onPosition?.(0);
      return Promise.resolve(this.ticket(arrived, 0));
    }
    if (options.signal?.aborted) return Promise.reject(new GateWaitError("aborted"));

    return new Promise<GateTicket>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const leave = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.announcePositions();
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          this.running += 1;
          // Its turn: nobody ahead any more.
          options.onPosition?.(0);
          resolve(this.ticket(arrived, queuedBehind));
        },
        ...(options.onPosition ? { onPosition: options.onPosition } : {}),
      };
      const onAbort = () => {
        leave();
        reject(new GateWaitError("aborted"));
      };
      if (options.maxWaitMs !== undefined) {
        timer = setTimeout(() => {
          leave();
          reject(new GateWaitError("busy"));
        }, options.maxWaitMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      options.onPosition?.(this.waiting.length - 1 + (this.running >= this.capacity ? 1 : 0));
    });
  }

  /** Acquire, run, release — however `fn` ends. */
  async run<T>(
    fn: () => Promise<T>,
    options: AcquireOptions = {},
  ): Promise<{ value: T; ticket: GateTicket }> {
    const ticket = await this.acquire(options);
    try {
      return { value: await fn(), ticket };
    } finally {
      ticket.release();
    }
  }

  private ticket(arrived: number, queuedBehind: number): GateTicket {
    let released = false;
    return {
      queueMs: this.now() - arrived,
      queuedBehind,
      release: () => {
        if (released) return;
        released = true;
        this.running -= 1;
        this.waiting[0]?.grant();
      },
    };
  }

  /** Everyone still waiting hears their new place. */
  private announcePositions(): void {
    this.waiting.forEach((waiter, index) => waiter.onPosition?.(index + 1));
  }
}
