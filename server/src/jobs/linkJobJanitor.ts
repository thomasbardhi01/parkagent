/**
 * Times out link_jobs left in progress from before the link worker
 * (jobs/linkWorker.ts) existed: those ran as fire-and-forget promises, and
 * a deploy mid-run left the app polling a "linking"/"adding_card" row
 * forever. Anything older than 15 minutes with no lease and no scheduled
 * attempt is failed with reason "timeout" (retrySafe — POST setup-card
 * again is the fix). Worker-managed jobs always hold a lease or a next
 * attempt while unfinished, so this never touches them; the worker times
 * out, retries, and dead-letters its own.
 */

import type { AppDb } from "../db.js";

const TIMEOUT_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

export interface LinkJobJanitorDeps {
  db: AppDb;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: () => Date;
}

export interface LinkJobJanitor {
  /** One sweep; exposed for tests. Returns how many jobs were timed out. */
  tick(): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeLinkJobJanitor(deps: LinkJobJanitorDeps): LinkJobJanitor {
  const now = () => deps.now?.() ?? new Date();

  async function tick(): Promise<number> {
    const cutoff = new Date(now().getTime() - TIMEOUT_MS);
    const { count } = await deps.db.linkJob.updateMany({
      where: {
        phase: { in: ["linking", "adding_card"] },
        createdAt: { lt: cutoff },
        finishedAt: null,
        lockedUntil: null,
        nextAttemptAt: null,
      },
      data: { phase: "failed", reason: "timeout", retrySafe: true, finishedAt: now() },
    });
    if (count > 0) {
      deps.log.warn(`link-job janitor timed out ${count} stuck job(s)`);
    }
    return count;
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    tick,
    start(intervalMs = SWEEP_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch((err) => deps.log.warn(`link-job janitor failed: ${String(err)}`));
      }, intervalMs);
      deps.log.info(`link-job janitor started (every ${intervalMs / 1000}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
