/**
 * The Wallet's housekeeping, every minute:
 *
 *  - settle ParkAgent-card holds still `held` past their grace period (a
 *    paid leg whose Issuing authorization arrived after the executor
 *    returned is captured for what was authorized; a leg nobody charged is
 *    released) — see services/wallet/holds.ts sweepHolds;
 *  - expire Link spend requests nobody approved inside Link's 10-minute
 *    window, so a garage stop never waits on an approval that can no
 *    longer come. Nothing was charged for those: an unapproved request
 *    never produced a card.
 *
 * Every settle writes its own wallet_hold decision; every expiry writes a
 * link_wallet decision here.
 */

import type { AppDb } from "../db.js";
import type { LinkWallet } from "../services/link/linkWallet.js";
import type { HoldDeps } from "../services/wallet/holds.js";
import { sweepHolds } from "../services/wallet/holds.js";

const INTERVAL_MS = 60_000;

export interface WalletTickDeps extends HoldDeps {
  db: AppDb;
  linkWallet?: LinkWallet | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface WalletTick {
  /** One pass; exposed for tests. */
  tick(): Promise<{ holdsSettled: number; approvalsExpired: number }>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeWalletTick(deps: WalletTickDeps): WalletTick {
  let running = false;

  async function tick(): Promise<{ holdsSettled: number; approvalsExpired: number }> {
    if (running) return { holdsSettled: 0, approvalsExpired: 0 };
    running = true;
    try {
      const settled = await sweepHolds(deps);
      const expired = deps.linkWallet ? await deps.linkWallet.expireStaleApprovals() : [];
      for (const row of expired) {
        await deps.db.decision.create({
          data: {
            kind: "link_wallet",
            inputs: { spendRequestId: row.id, amountUsd: row.amountUsd },
            rule: "approval_expired",
            outcome: { charged: false },
            userId: row.userId,
          },
        });
      }
      return {
        holdsSettled: settled.filter((r) => r.status === "captured" || r.status === "released")
          .length,
        approvalsExpired: expired.length,
      };
    } finally {
      running = false;
    }
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    tick,
    start(intervalMs = INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch((err) => deps.log.warn(`wallet tick failed: ${String(err)}`));
      }, intervalMs);
      deps.log.info(`wallet tick started (every ${intervalMs / 1000}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
