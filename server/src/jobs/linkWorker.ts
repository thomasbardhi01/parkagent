/**
 * Runs provider link jobs. POST /providers/:provider/link only records the
 * captured sign-in and answers with a job id; this worker does the slow
 * part in the background and keeps its answer on the job row for the app
 * to poll:
 *
 *   queued → verifying → reading_card → (adding_card) → done
 *                 ↘ retrying (backoff) … → failed (dead-lettered)
 *
 * - **Verify** is the only step the link depends on, and it runs under a
 *   hard budget (LINK_BUDGET_MS, queue wait included): past it the browser
 *   work is stopped and the attempt fails "timeout". The account is linked
 *   the moment verification passes.
 * - **Reading the card** (provider_card users' "Visa ••4242") happens after
 *   linking, best effort, under its own budget. It never fails the link.
 * - **Transient failures** (timeout, network, busy, provider unavailable, a
 *   browser crash, a changed page) retry with backoff; after the last
 *   attempt the job is dead-lettered (`dead_at`, counted in /admin/summary).
 *   A sign-in that isn't a session (auth_expired) fails at once: the app is
 *   still showing the provider's page and resubmits fresher cookies.
 * - **Restarts:** a running attempt holds a lease; one cut off by a deploy
 *   is picked up again when its lease lapses. Due jobs are found by
 *   polling the table, so nothing depends on the process that took the
 *   request.
 * - **Pushes:** only when the user stopped watching (they tapped
 *   "Continue — we'll let you know", or an attempt ran past the budget and
 *   went to background retries): "ParkBoston connected" or what failed.
 *
 * Cookie values never leave the sealed column; decisions carry counts,
 * codes, and timings only.
 */

import type { AppDb, LinkJobRow } from "../db.js";
import { providerById } from "../providers/registry.js";
import type { ProviderInfo } from "../providers/registry.js";
import { providerLinkFailedPush, providerLinkedPush } from "../services/apns.js";
import type { PushSender } from "../services/apns.js";
import type { StateCrypto } from "../services/crypto.js";
import type { GuardedAccountOpOptions } from "../services/parknycExecutor.js";
import type { PolicyService } from "../services/policy.js";
import { LinkJobStore, openState, runSetupCard } from "../services/providerLink.js";
import type { ProviderLinkDeps } from "../services/providerLink.js";
import type { ProviderOpsFactory } from "../services/providerOps.js";
import type { StripeGateway } from "../services/stripeGateway.js";
import { normalizeSource } from "../services/wallet/summary.js";

/** Verification's hard budget per attempt, queue wait included. */
export const LINK_BUDGET_MS = 45_000;
/** The card read's own budget; it never fails the link. */
export const CARD_BUDGET_MS = 25_000;
/** A running attempt's lease: past it, a restart may pick the job up. */
const LEASE_MS = LINK_BUDGET_MS + CARD_BUDGET_MS + 30_000;
/** Waits between attempts: after the 1st failure, after the 2nd, … */
export const LINK_RETRY_BACKOFF_MS = [60_000, 5 * 60_000];
export const LINK_MAX_ATTEMPTS = LINK_RETRY_BACKOFF_MS.length + 1;
const POLL_INTERVAL_MS = 5_000;

/** Worth another try later; anything else is final. */
const TRANSIENT = new Set([
  "timeout",
  "network",
  "busy",
  "provider_unavailable",
  "browser_crashed",
  "ui_changed",
  "unknown",
]);

export interface LinkWorkerDeps {
  db: AppDb;
  policy: PolicyService;
  sendPush: PushSender;
  stateCrypto?: StateCrypto | undefined;
  providerOps?: ProviderOpsFactory | undefined;
  stripe?: StripeGateway | undefined;
  issuingLive?: boolean | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: () => Date;
}

export interface LinkWorker {
  /** A new job was recorded: start on it now instead of at the next poll. */
  kick(): void;
  /** One pass over due jobs; resolves when they've all run (tests). */
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeLinkWorker(deps: LinkWorkerDeps): LinkWorker {
  const now = () => deps.now?.() ?? new Date();
  const store = new LinkJobStore(deps.db);
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<void> | null = null;

  async function due(): Promise<LinkJobRow[]> {
    return deps.db.linkJob.findMany({
      where: { finishedAt: null, deadAt: null, nextAttemptAt: { lte: now() } },
      orderBy: { nextAttemptAt: "asc" },
      take: 10,
    });
  }

  /** Compare-and-set: the attempt is ours only if nobody holds a live lease. */
  async function claim(job: LinkJobRow): Promise<boolean> {
    const at = now();
    const { count } = await deps.db.linkJob.updateMany({
      where: {
        id: job.id,
        attempts: job.attempts,
        finishedAt: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: at } }],
      },
      data: {
        attempts: job.attempts + 1,
        lockedUntil: new Date(at.getTime() + LEASE_MS),
        ...(job.startedAt ? {} : { startedAt: at }),
      },
    });
    return count === 1;
  }

  async function tickOnce(): Promise<void> {
    const jobs = (await due()).filter((job) => !running.has(job.id));
    await Promise.all(
      jobs.map(async (job) => {
        if (!(await claim(job))) return;
        running.add(job.id);
        const claimed = { ...job, attempts: job.attempts + 1 };
        try {
          await attempt(claimed);
        } catch (err) {
          deps.log.warn(`link job ${job.id} crashed: ${String(err).split("\n")[0]}`);
          await settleFailure(claimed, "unknown", `crashed: ${String(err).split("\n")[0]}`);
        } finally {
          running.delete(job.id);
        }
      }),
    );
  }

  async function tick(): Promise<void> {
    // One pass at a time; a kick during a pass runs another after it.
    const previous = ticking;
    const next = (async () => {
      await previous;
      await tickOnce();
    })();
    ticking = next;
    await next;
    if (ticking === next) ticking = null;
  }

  async function decide(job: LinkJobRow, rule: string, outcome: Record<string, unknown>) {
    await deps.db.decision.create({
      data: {
        kind: "provider_link",
        inputs: {
          provider: job.provider,
          jobId: job.id,
          attempt: job.attempts,
          setUpCard: job.setUpCard,
        },
        rule,
        outcome,
        userId: job.userId,
      },
    });
  }

  /** One attempt at the job, from wherever it stands. */
  async function attempt(job: LinkJobRow): Promise<void> {
    const provider = providerById(job.provider);
    if (!provider || !deps.providerOps || !deps.stateCrypto) {
      await finish(job, { failed: "provider_linking_not_configured" });
      return;
    }
    const state = job.stateSealed ? openState(deps.stateCrypto, job.stateSealed) : null;
    if (!state) {
      await finish(job, { failed: "state_unreadable" });
      return;
    }
    const stages = { ...((job.stages ?? {}) as Record<string, number>) };
    const ops = deps.providerOps(provider.id, state);

    // 1. Verify, under the hard budget (queue wait included). Queue
    //    positions arrive as callbacks; their writes are chained so a late
    //    one can never land on top of a later phase.
    await store.update(job.id, { phase: "queued", queuePosition: null });
    let queueWrites: Promise<void> = Promise.resolve();
    const verifyOptions: GuardedAccountOpOptions = {
      budgetMs: LINK_BUDGET_MS,
      onQueued: (ahead) => {
        queueWrites = queueWrites
          .then(() =>
            store.update(job.id, {
              queuePosition: ahead,
              ...(ahead === 0 ? { phase: "verifying" } : {}),
            }),
          )
          .catch(() => {});
      },
    };
    const verify = await ops.verifyAccount(verifyOptions);
    await queueWrites;
    const verifyMeta = (verify as { meta?: { queueMs: number; runMs: number } }).meta;
    if (verifyMeta) {
      stages.queueMs = verifyMeta.queueMs;
      stages.verifyMs = verifyMeta.runMs;
    }
    await store.update(job.id, { phase: "verifying", queuePosition: null, stages });

    if (!verify.ok) {
      await decide(job, "verification_failed", { ok: false, code: verify.code, stages });
      if (verify.code === "auth_expired" || !TRANSIENT.has(verify.code)) {
        await finish(job, { failed: verify.code, retrySafe: false, stages });
      } else {
        await settleFailure(job, verify.code, verify.message, stages);
      }
      return;
    }

    // 2. Linked: seal the state onto the account right away.
    const at = now();
    await deps.db.providerAccount.upsert({
      where: { userId_provider: { userId: job.userId, provider: provider.id } },
      create: {
        userId: job.userId,
        provider: provider.id,
        status: "linked",
        stateEncrypted: job.stateSealed!,
        linkedAt: at,
        lastVerifiedAt: at,
        walletBalanceCents: verify.walletBalanceCents,
      },
      update: {
        status: "linked",
        stateEncrypted: job.stateSealed!,
        linkedAt: at,
        lastVerifiedAt: at,
        walletBalanceCents: verify.walletBalanceCents,
      },
    });

    // 3. The card saved there, for display (not for ParkAgent-card users,
    //    whose account is getting ours). Best effort, own budget.
    const userRow = await deps.db.user.findUnique({
      where: { id: job.userId },
      select: { paymentSource: true },
    });
    const paymentSource = normalizeSource(userRow?.paymentSource);
    let cardLabel: string | null = null;
    if (paymentSource !== "parkagent_card") {
      await store.update(job.id, { phase: "reading_card", stages });
      const started = Date.now();
      const saved = await ops.readSavedCard({ budgetMs: CARD_BUDGET_MS });
      stages.cardMs = Date.now() - started;
      // What the screen showed, or nulls: a failed read must not leave a
      // previous link's card claiming to be the one on file.
      const brand = saved.ok ? saved.brand : null;
      const last4 = saved.ok ? saved.last4 : null;
      if (last4) cardLabel = `${brand ?? "card"} ••${last4}`;
      await deps.db.providerAccount.update({
        where: { userId_provider: { userId: job.userId, provider: provider.id } },
        data: { cardBrand: brand, cardLast4: last4 },
      });
    }
    await decide(job, "link_ok", {
      ok: true,
      walletBalanceCents: verify.walletBalanceCents,
      // Presence only — the decision never needs the digits.
      savedCardSeen: cardLabel !== null,
      stages,
    });

    // 4. The ParkAgent card goes on (consented at link time).
    if (job.setUpCard) {
      await store.update(job.id, { phase: "adding_card", stages });
      const started = Date.now();
      const outcome = await runSetupCard(linkDeps(), job.userId, provider);
      stages.setupMs = Date.now() - started;
      if (!outcome.ok) {
        await finish(job, {
          failed: outcome.code,
          retrySafe: outcome.retrySafe,
          stages,
          linked: true,
        });
        return;
      }
      await finish(job, { done: true, dryRun: outcome.dryRun, stages, provider, cardLabel });
      return;
    }
    await finish(job, { done: true, stages, provider, cardLabel });
  }

  function linkDeps(): ProviderLinkDeps {
    return {
      db: deps.db,
      policy: deps.policy,
      sendPush: deps.sendPush,
      stripe: deps.stripe,
      stateCrypto: deps.stateCrypto,
      providerOps: deps.providerOps,
      issuingLive: deps.issuingLive,
      now: deps.now,
    };
  }

  /** A transient failure: back off and retry, or dead-letter after the last. */
  async function settleFailure(
    job: LinkJobRow,
    code: string,
    message: string,
    stages?: Record<string, number>,
  ): Promise<void> {
    const backoff = LINK_RETRY_BACKOFF_MS[job.attempts - 1];
    if (backoff !== undefined && job.attempts < job.maxAttempts) {
      await store.update(job.id, {
        phase: "retrying",
        reason: code,
        lastError: message.slice(0, 300),
        lockedUntil: null,
        nextAttemptAt: new Date(now().getTime() + backoff),
        queuePosition: null,
        // Past the budget the app has told the user "we'll let you know".
        notify: true,
        ...(stages ? { stages } : {}),
      });
      return;
    }
    await finish(job, {
      failed: code,
      retrySafe: true,
      dead: true,
      message,
      ...(stages ? { stages } : {}),
    });
  }

  async function finish(
    job: LinkJobRow,
    end: {
      done?: boolean;
      failed?: string;
      retrySafe?: boolean;
      dryRun?: boolean;
      dead?: boolean;
      message?: string;
      stages?: Record<string, number>;
      linked?: boolean;
      provider?: ProviderInfo;
      cardLabel?: string | null;
    },
  ): Promise<void> {
    const at = now();
    const stages = end.stages ?? ((job.stages ?? {}) as Record<string, number>);
    stages.totalMs = at.getTime() - job.createdAt.getTime();
    await store.update(job.id, {
      phase: end.done ? "done" : "failed",
      ...(end.failed ? { reason: end.failed } : {}),
      ...(end.retrySafe !== undefined ? { retrySafe: end.retrySafe } : {}),
      ...(end.dryRun !== undefined ? { dryRun: end.dryRun } : {}),
      ...(end.dead ? { deadAt: at } : {}),
      ...(end.message ? { lastError: end.message.slice(0, 300) } : {}),
      finishedAt: at,
      nextAttemptAt: null,
      lockedUntil: null,
      queuePosition: null,
      // The cookies live on the account now (or nowhere): not on the job.
      stateSealed: null,
      stages,
    });
    if (end.dead) {
      await decide(job, "link_dead_letter", {
        ok: false,
        code: end.failed,
        attempts: job.attempts,
        stages,
      });
    }
    // Watching users see the answer in the app; everyone else gets a push.
    const fresh = await deps.db.linkJob.findUnique({ where: { id: job.id } });
    if (!fresh?.notify || fresh.notifiedAt) return;
    const provider = end.provider ?? providerById(job.provider);
    if (!provider) return;
    await deps.sendPush(
      job.userId,
      end.done
        ? providerLinkedPush({
            provider: provider.id,
            displayName: provider.displayName,
            cardLabel: end.cardLabel ?? null,
          })
        : providerLinkFailedPush({
            provider: provider.id,
            displayName: provider.displayName,
            reason: end.failed ?? "unknown",
          }),
    );
    await store.update(job.id, { notifiedAt: at });
  }

  return {
    kick() {
      void tick().catch((err) => deps.log.warn(`link worker failed: ${String(err)}`));
    },
    tick,
    start(intervalMs = POLL_INTERVAL_MS) {
      if (timer) return;
      // Anything a previous process left mid-attempt or due runs now.
      this.kick();
      timer = setInterval(() => this.kick(), intervalMs);
      deps.log.info(`link worker started (polls every ${intervalMs / 1000}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
