/**
 * Saved assistant conversations are kept for a retention period (default
 * 90 days, ASSISTANT_CONVERSATION_RETENTION_DAYS) after they were last
 * used, then deleted — transcript and model context both. The money
 * records they led to are not: plans, garage bookings, itineraries, and
 * the decisions ledger keep their own rows (a deleted conversation just
 * stops being linked from Activity). Each sweep that deletes anything
 * writes one decisions row with the cutoff and the count.
 */

import type { AppDb } from "../db.js";

const SWEEP_INTERVAL_MS = 60 * 60_000;

export interface ConversationRetentionDeps {
  db: AppDb;
  retentionDays: number;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: () => Date;
}

export interface ConversationRetention {
  /** One sweep; exposed for tests. Returns how many were deleted. */
  tick(): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeConversationRetention(deps: ConversationRetentionDeps): ConversationRetention {
  const now = () => deps.now?.() ?? new Date();

  async function tick(): Promise<number> {
    const cutoff = new Date(now().getTime() - deps.retentionDays * 24 * 60 * 60_000);
    const { count } = await deps.db.conversation.deleteMany({
      where: { updatedAt: { lt: cutoff } },
    });
    if (count > 0) {
      await deps.db.decision.create({
        data: {
          kind: "assistant_history",
          inputs: { retentionDays: deps.retentionDays, cutoff: cutoff.toISOString() },
          rule: "retention_purge",
          outcome: { deleted: count },
          userId: null,
        },
      });
      deps.log.info(
        `conversation retention deleted ${count} conversation(s) idle since ${cutoff.toISOString()}`,
      );
    }
    return count;
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    tick,
    start(intervalMs = SWEEP_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch((err) => deps.log.warn(`conversation retention failed: ${String(err)}`));
      }, intervalMs);
      deps.log.info(
        `conversation retention started (${deps.retentionDays} days, every ${intervalMs / 1000}s)`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
