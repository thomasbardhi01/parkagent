/**
 * Daily provider-session health check: verify each linked account's sealed
 * cookies headlessly, and get the "Reconnect ParkBoston" push out BEFORE
 * the next park needs the session — a re-link on the couch beats a broken
 * pay at the curb.
 *
 * Per linked account, once a day:
 *  - state unreadable or verification says auth_expired → status "expired"
 *    + provider_relink push (deep link into the app's link flow);
 *  - verification ok but the session cookies expire within the warning
 *    window → status "expiring" (still usable — the executor keeps paying)
 *    + the same push;
 *  - verification ok and not near expiry → refresh lastVerifiedAt (and an
 *    "expiring" account that recovered goes back to "linked").
 *
 * Every outcome writes a decisions row (kind "provider_health") — the
 * check decides whether to nag a human, and nags must be auditable.
 * Transient failures (network, ui_changed, …) change nothing: the account
 * keeps its status and tomorrow's run retries.
 */

import type { AppDb } from "../db.js";
import { providerById } from "../providers/registry.js";
import { providerRelinkPush } from "../services/apns.js";
import type { PushSender } from "../services/apns.js";
import type { StateCrypto } from "../services/crypto.js";
import { openState } from "../services/providerLink.js";
import type { ProviderOpsFactory, ProviderStorageState } from "../services/providerOps.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Push the reconnect nudge when the session dies within this window. */
export const EXPIRY_WARNING_MS = 5 * DAY_MS;

/** A pass skips accounts verified more recently than this. The job runs
 * daily AND 30 s after every boot, and a day of deploys must not re-verify
 * every session headlessly (real traffic to the provider's site) or send
 * the same "Reconnect" push once per restart. Just under a day, so the
 * daily pass still reaches every account. */
export const RECHECK_AFTER_MS = 20 * 60 * 60 * 1000;

export interface ProviderHealthDeps {
  db: AppDb;
  sendPush: PushSender;
  stateCrypto?: StateCrypto | undefined;
  providerOps?: ProviderOpsFactory | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: () => Date;
  intervalMs?: number;
}

/** Earliest expiry among cookies that carry one; null when none do
 * (session cookies without an expiry die with the browser, not the clock). */
export function earliestCookieExpiry(state: ProviderStorageState): Date | null {
  let earliest: number | null = null;
  for (const cookie of state.cookies) {
    if (typeof cookie.expires === "number" && cookie.expires > 0) {
      earliest = earliest === null ? cookie.expires : Math.min(earliest, cookie.expires);
    }
  }
  return earliest === null ? null : new Date(earliest * 1000);
}

export function makeProviderHealth(deps: ProviderHealthDeps) {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function checkAccount(account: {
    userId: string;
    provider: string;
    status: string;
    stateEncrypted: string | null;
  }): Promise<void> {
    const provider = providerById(account.provider);
    if (!provider) return;

    const decide = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: {
          kind: "provider_health",
          inputs: { provider: provider.id, statusBefore: account.status },
          rule,
          outcome,
          userId: account.userId,
        },
      });

    const expire = async (reason: string) => {
      await deps.db.providerAccount.update({
        where: { userId_provider: { userId: account.userId, provider: provider.id } },
        data: { status: "expired" },
      });
      await deps.sendPush(
        account.userId,
        providerRelinkPush({ provider: provider.id, displayName: provider.displayName }),
      );
      await decide("expired", { ok: false, reason, pushed: true });
    };

    if (!deps.stateCrypto || !deps.providerOps) return;
    if (!account.stateEncrypted) {
      await expire("no_state");
      return;
    }
    const state = openState(deps.stateCrypto, account.stateEncrypted);
    if (!state) {
      await expire("state_unreadable");
      return;
    }

    let verify;
    try {
      verify = await deps.providerOps(provider.id, state).verifyAccount();
    } catch (err) {
      deps.log.warn(`provider health: ${provider.id} verify crashed: ${String(err)}`);
      await decide("check_failed", { ok: false, code: "unknown" });
      return;
    }

    if (!verify.ok) {
      if (verify.code === "auth_expired") {
        await expire("auth_expired");
      } else {
        // Transient (network, ui_changed): not evidence the session died.
        await decide("check_failed", { ok: false, code: verify.code });
      }
      return;
    }

    const at = now();
    const expiry = earliestCookieExpiry(state);
    const expiring = expiry !== null && expiry.getTime() - at.getTime() < EXPIRY_WARNING_MS;
    await deps.db.providerAccount.update({
      where: { userId_provider: { userId: account.userId, provider: provider.id } },
      data: { lastVerifiedAt: at, status: expiring ? "expiring" : "linked" },
    });
    if (expiring) {
      await deps.sendPush(
        account.userId,
        providerRelinkPush({ provider: provider.id, displayName: provider.displayName }),
      );
      await decide("expiring", {
        ok: true,
        cookieExpiry: expiry?.toISOString() ?? null,
        pushed: true,
      });
    } else {
      await decide("verified", { ok: true, cookieExpiry: expiry?.toISOString() ?? null });
    }
  }

  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // "expiring" accounts are still usable and re-checked daily; a fresh
      // re-link flips them back to "linked" here or at link time.
      const accounts = await deps.db.providerAccount.findMany({
        where: { status: { in: ["linked", "expiring"] } },
      });
      const at = now().getTime();
      const due = accounts.filter(
        (a) => !a.lastVerifiedAt || at - a.lastVerifiedAt.getTime() >= RECHECK_AFTER_MS,
      );
      for (const account of due) {
        try {
          await checkAccount(account);
        } catch (err) {
          deps.log.warn(
            `provider health: ${account.provider}/${account.userId} check crashed: ${String(err)}`,
          );
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start(): void {
      if (timer) return;
      const interval = deps.intervalMs ?? DAY_MS;
      timer = setInterval(() => void runOnce(), interval);
      timer.unref?.();
      // First pass shortly after boot, off the request path.
      setTimeout(() => void runOnce(), 30_000).unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
