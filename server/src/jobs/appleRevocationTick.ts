/**
 * Retries Sign in with Apple revocations that DELETE /me couldn't finish.
 *
 * Deleting an account never waits on Apple: when the revoke fails (Apple
 * down, a network blip) or couldn't run yet (the APPLE_SIGNIN_* key wasn't
 * configured at the time), the sealed refresh token stays on the tombstoned
 * row. The state lives on that row, so it survives any restart. Each due
 * token is retried with backoff (1 h, 2 h, 4 h, … up to a day); after the
 * last attempt the row is dead-lettered — kept, flagged, and counted in
 * /admin/summary for a person to look at — instead of retried forever.
 * Every attempt writes a decisions row.
 */

import type { AppDb } from "../db.js";
import type { AppleTokenClient } from "../services/appleTokens.js";
import type { StateCrypto } from "../services/crypto.js";
import { revokeAppleToken } from "../services/accountDeletion.js";

const HOUR_MS = 60 * 60_000;
/** Plenty for a prototype; the rest waits an hour. */
const BATCH = 50;
/** After this many failed attempts the revoke is dead-lettered. */
export const APPLE_REVOKE_MAX_ATTEMPTS = 8;

/** Wait before attempt n+1 (n = failures so far): 1 h doubling, capped at a day. */
export function appleRevokeBackoffMs(failures: number): number {
  return Math.min(HOUR_MS * 2 ** Math.max(0, failures - 1), 24 * HOUR_MS);
}

export interface AppleRevocationDeps {
  db: AppDb;
  appleTokens?: AppleTokenClient | undefined;
  stateCrypto?: StateCrypto | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: () => Date;
}

export interface AppleRevocationJob {
  /** One sweep; exposed for tests. */
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeAppleRevocationJob(deps: AppleRevocationDeps): AppleRevocationJob {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick() {
    if (!deps.appleTokens || !deps.stateCrypto) return;
    const at = deps.now?.() ?? new Date();
    const pending = await deps.db.user.findMany({
      where: {
        deletedAt: { not: null },
        appleRefreshTokenSealed: { not: null },
        appleRevokeDeadAt: null,
        OR: [{ appleRevokeNextAt: null }, { appleRevokeNextAt: { lte: at } }],
      },
      select: { id: true, appleRefreshTokenSealed: true, appleRevokeAttempts: true },
      take: BATCH,
    });
    for (const row of pending) {
      const revoked = await revokeAppleToken(deps, row.appleRefreshTokenSealed);
      const failures = row.appleRevokeAttempts + 1;
      let rule: string;
      if (revoked === true) {
        rule = "apple_token_revoked";
        await deps.db.user.update({
          where: { id: row.id },
          data: {
            appleRefreshTokenSealed: null,
            appleRevokeNextAt: null,
            appleRevokeLastError: null,
          },
        });
      } else if (revoked === null || failures >= APPLE_REVOKE_MAX_ATTEMPTS) {
        // null: the sealed token can't be opened (the key changed), which
        // no retry will fix. Either way a person has to look now.
        rule = "apple_token_revoke_dead_letter";
        const reason = revoked === null ? "token_unreadable" : "revoke_failed";
        deps.log.warn(
          `apple revoke for ${row.id} dead-lettered (${reason}) after ${failures} attempts`,
        );
        await deps.db.user.update({
          where: { id: row.id },
          data: {
            appleRevokeAttempts: failures,
            appleRevokeDeadAt: at,
            appleRevokeNextAt: null,
            appleRevokeLastError: reason,
          },
        });
      } else {
        rule = "apple_token_revoke_failed";
        const nextAt = new Date(at.getTime() + appleRevokeBackoffMs(failures));
        deps.log.warn(`apple revoke retry failed for ${row.id}; next ${nextAt.toISOString()}`);
        await deps.db.user.update({
          where: { id: row.id },
          data: {
            appleRevokeAttempts: failures,
            appleRevokeNextAt: nextAt,
            appleRevokeLastError: "revoke_failed",
          },
        });
      }
      await deps.db.decision.create({
        data: {
          kind: "account_delete",
          inputs: { step: "apple_token_revoke", retry: true, attempt: failures },
          rule,
          outcome: { ok: revoked === true },
          userId: row.id,
        },
      });
    }
  }

  return {
    tick,
    start(intervalMs = HOUR_MS) {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      deps.log.info(
        `apple revocation retries started (every ${Math.round(intervalMs / 60_000)} min)`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
