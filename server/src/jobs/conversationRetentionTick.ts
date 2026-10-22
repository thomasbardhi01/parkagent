/**
 * Saved assistant conversations are kept for a retention period (default
 * 90 days, ASSISTANT_CONVERSATION_RETENTION_DAYS) after they were last
 * used, then deleted — transcript and model context both. The money
 * records they led to are not: plans, garage bookings, itineraries, and
 * the decisions ledger keep their own rows (a deleted conversation just
 * stops being linked from Activity). Each sweep that deletes anything
 * writes one decisions row with the cutoff and the count.
 *
 * The same sweep deletes park_fixes (a park's trace, services/parkTrace.ts)
 * received more than PARK_FIX_RETENTION_DAYS (30) ago, on a decisions row
 * of its own.
 */

import type { AppDb } from "../db.js";
import { PARK_FIX_RETENTION_DAYS } from "../services/parkTrace.js";

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
          // No user to act for: the one job that says its actor itself.
          actor: "job",
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
    await purgeParkFixes();
    await purgeSignChecks();
    return count;
  }

  /** Park traces' fixes past their retention: the driver's raw positions
   * are not kept for longer than debugging a park needs. */
  async function purgeParkFixes(): Promise<void> {
    const cutoff = new Date(now().getTime() - PARK_FIX_RETENTION_DAYS * 24 * 60 * 60_000);
    const { count } = await deps.db.parkFix.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    if (count === 0) return;
    await deps.db.decision.create({
      data: {
        // No user to act for, as with the conversations above.
        actor: "job",
        kind: "park_trace",
        inputs: { retentionDays: PARK_FIX_RETENTION_DAYS, cutoff: cutoff.toISOString() },
        rule: "retention_purge",
        outcome: { deleted: count },
        userId: null,
      },
    });
    deps.log.info(
      `park trace retention deleted ${count} fix(es) received before ${cutoff.toISOString()}`,
    );
  }

  /** Parking-sign checks (Issue N): their OCR text, and a photo a driver
   * chose to keep for the review queue, go after 30 days (a sign photo can
   * show a plate or a face). The parsed reading stays: it holds neither. */
  async function purgeSignChecks(): Promise<void> {
    const at = now();
    const texts = await deps.db.signCheck.updateMany({
      where: { textExpiresAt: { lt: at }, ocrText: { not: null } },
      data: { ocrText: null },
    });
    const photos = await deps.db.signCheck.updateMany({
      where: { photoExpiresAt: { lt: at } },
      data: { photo: null, photoMediaType: null, photoExpiresAt: null },
    });
    if (texts.count + photos.count === 0) return;
    await deps.db.decision.create({
      data: {
        actor: "job",
        kind: "sign_check",
        inputs: { at: at.toISOString() },
        rule: "retention_purge",
        outcome: { texts: texts.count, photos: photos.count },
        userId: null,
      },
    });
    deps.log.info(
      `sign check retention cleared ${texts.count} text(s) and ${photos.count} photo(s)`,
    );
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
