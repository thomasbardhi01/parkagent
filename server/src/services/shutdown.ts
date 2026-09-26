/**
 * Graceful shutdown, in the one order that can't cut a payment off:
 *
 *  1. stop every job's timer (no new work starts);
 *  2. close the HTTP server — Fastify stops accepting, answers 503 to
 *     anything new, and waits for requests in flight (a session start
 *     mid-payment finishes and is answered);
 *  3. wait for job passes in flight (an extension mid-payment, a link);
 *  4. only then close the shared Chromium — before this change it went
 *     first, killing whatever payment was running;
 *  5. disconnect the database; exit 0.
 *
 * All within a deadline (fly.toml's kill_timeout is longer): past it, log
 * what was still running and exit 1 rather than be SIGKILLed mid-write.
 */

export interface ShutdownDeps {
  /** Timers only; synchronous. */
  stopJobs: () => void;
  closeServer: () => Promise<void>;
  /** Job passes still running. */
  drains: (() => Promise<void>)[];
  closeBrowser: () => Promise<void>;
  disconnectDb: () => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  exit: (code: number) => void;
  deadlineMs: number;
}

export function makeShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let started = false;
  return async (signal: string) => {
    if (started) return; // a second signal mid-shutdown changes nothing
    started = true;
    deps.log.info(`${signal}: shutting down`);
    let step = "stopping jobs";
    const deadline = new Promise<"deadline">((resolve) => {
      const timer = setTimeout(() => resolve("deadline"), deps.deadlineMs);
      timer.unref?.();
    });
    const work = (async () => {
      deps.stopJobs();
      step = "draining requests";
      await deps.closeServer();
      step = "draining jobs";
      await Promise.all(deps.drains.map((drain) => drain().catch(() => {})));
      step = "closing the browser";
      await deps.closeBrowser().catch(() => {});
      step = "disconnecting the database";
      await deps.disconnectDb().catch(() => {});
      return "done" as const;
    })();
    const outcome = await Promise.race([work, deadline]);
    if (outcome === "deadline") {
      deps.log.warn(`shutdown deadline (${deps.deadlineMs} ms) passed while ${step}; exiting`);
      deps.exit(1);
      return;
    }
    deps.log.info("shutdown complete");
    deps.exit(0);
  };
}
