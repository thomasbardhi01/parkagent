/**
 * Retries Sign in with Apple revocations that DELETE /me couldn't finish.
 *
 * Deleting an account never waits on Apple: when the revoke fails (Apple
 * down, a network blip) or couldn't run yet (the APPLE_SIGNIN_* key wasn't
 * configured at the time), the sealed refresh token stays on the tombstoned
 * row. Hourly, each such token is revoked and cleared; one that still fails
 * stays for the next hour. Every attempt writes a decisions row.
 */

import type { AppDb } from "../db.js";
import type { AppleTokenClient } from "../services/appleTokens.js";
import type { StateCrypto } from "../services/crypto.js";
import { revokeAppleToken } from "../services/accountDeletion.js";

const HOUR_MS = 60 * 60_000;
/** Plenty for a prototype; the rest waits an hour. */
const BATCH = 50;

export interface AppleRevocationDeps {
  db: AppDb;
  appleTokens?: AppleTokenClient | undefined;
  stateCrypto?: StateCrypto | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
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
    const pending = await deps.db.user.findMany({
      where: { deletedAt: { not: null }, appleRefreshTokenSealed: { not: null } },
      select: { id: true, appleRefreshTokenSealed: true },
      take: BATCH,
    });
    for (const row of pending) {
      const revoked = await revokeAppleToken(deps, row.appleRefreshTokenSealed);
      if (revoked === true) {
        await deps.db.user.update({
          where: { id: row.id },
          data: { appleRefreshTokenSealed: null },
        });
      } else {
        deps.log.warn(`apple revoke retry failed for ${row.id}; next hour`);
      }
      await deps.db.decision.create({
        data: {
          kind: "account_delete",
          inputs: { step: "apple_token_revoke", retry: true },
          rule: revoked === true ? "apple_token_revoked" : "apple_token_revoke_failed",
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
