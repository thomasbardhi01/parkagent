/**
 * The ParkAgent card's money path, end to end over the fakes: a hold on
 * the user's own card before the provider is asked to charge ours, the
 * Issuing webhook approving only against that hold, capture of exactly what
 * the card paid, release of the rest — plus decline, extension, free
 * period, executor failure, the late-authorization sweep, webhook replay,
 * dry run, and the caps across all three sources.
 *
 * The provider is simulated by an executor that, mid-flow, sends our own
 * webhook the issuing_authorization.request Stripe would — so the approval
 * a leg captures is the one the real route recorded.
 */

import type Stripe from "stripe";
import { describe, expect, test } from "vitest";

import type { FastifyInstance } from "fastify";

import type { ZoneTermsRow } from "../src/db.js";
import type { Executor, ExecutorResult } from "../src/services/executor.js";
import type { StripeGateway } from "../src/services/stripeGateway.js";
import {
  claimHoldForAuthorization,
  holdAmountFor,
  settleHold,
  sweepHolds,
} from "../src/services/wallet/holds.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import {
  API_KEY,
  MONDAY_2PM,
  makeFakeGateway,
  makeTestApp,
  seedFundingMethod,
  seedHold,
  seedProviderAccount,
  seedSession,
  setFakeRowClock,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);
const CARD_ID = "ic_u1";
const HOURS_BOS = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];
const BOYLSTON: ZoneTermsRow = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  street: "BOYLSTON ST",
  providerZoneNumber: "456",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 300,
  hoursJson: HOURS_BOS,
};
// 90 min at $3.75/h = $5.63 meter + $0.35 fee.
const START = { parkedEventId: "pe1", zoneId: BOYLSTON.zoneId, minutes: 90 };
const QUOTE_USD = 5.98;

interface GatewayCalls {
  holds: { amountUsd: number; idempotencyKey: string }[];
  captures: { paymentIntentId: string; amountUsd: number }[];
  cancels: string[];
}

/** A gateway that records every hold move, verifies webhook "signatures"
 * by parsing the body, and declines holds when told to. */
function spyGateway(options: { declineWith?: string } = {}) {
  const calls: GatewayCalls = { holds: [], captures: [], cancels: [] };
  const gateway: StripeGateway = makeFakeGateway({
    verifyEvent: (payload) => JSON.parse(payload.toString()) as Stripe.Event,
    createHold: async ({ amountUsd, idempotencyKey }) => {
      calls.holds.push({ amountUsd, idempotencyKey });
      if (options.declineWith) {
        return {
          ok: false,
          paymentIntentId: "pi_declined",
          declineCode: options.declineWith,
          message: "Your card has insufficient funds.",
        };
      }
      return { ok: true, paymentIntentId: `pi_${calls.holds.length}` };
    },
    captureHold: async (paymentIntentId, amountUsd) => {
      calls.captures.push({ paymentIntentId, amountUsd });
      return { status: "succeeded" };
    },
    cancelHold: async (paymentIntentId) => {
      calls.cancels.push(paymentIntentId);
      return { status: "canceled" };
    },
  });
  return { gateway, calls };
}

function authRequest(id: string, amountUsd: number) {
  return {
    id: `evt_${id}`,
    type: "issuing_authorization.request",
    api_version: "2026-08-26.dahlia",
    data: {
      object: {
        id,
        object: "issuing.authorization",
        amount: 0,
        currency: "usd",
        approved: false,
        status: "pending",
        pending_request: { amount: Math.round(amountUsd * 100), currency: "usd" },
        card: { id: CARD_ID },
        merchant_data: {
          category: "parking_lots_garages",
          category_code: "7523",
          name: "PARKBOSTON",
        },
      },
    },
  };
}

async function postWebhook(app: FastifyInstance, event: unknown) {
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": "sig" },
    payload: JSON.stringify(event),
  });
  return res.json() as { approved: boolean; metadata: { reason: string } };
}

type ProviderStep =
  /** The provider charges our card this much, then the flow succeeds. */
  | { kind: "charge"; usd: number }
  /** Succeeds without any charge reaching the webhook (yet). */
  | { kind: "silent" }
  | { kind: "free_period" }
  | { kind: "fail"; code: "ui_changed" | "network" };

/**
 * A parkagent_card user outside dry run: saved card, active ParkAgent card
 * already on their ParkBoston account, and an executor that plays the
 * provider — charging our card through the real webhook route.
 */
function cardApp(
  options: {
    steps?: ProviderStep[];
    declineWith?: string;
    dryRun?: boolean;
    policy?: Record<string, unknown>;
    cardOnProvider?: boolean;
    paymentSource?: string;
  } = {},
) {
  const { gateway, calls } = spyGateway(
    options.declineWith ? { declineWith: options.declineWith } : {},
  );
  const steps = [...(options.steps ?? [{ kind: "charge", usd: QUOTE_USD }])];
  const executorCalls: string[] = [];
  const webhookAnswers: { approved: boolean; reason: string }[] = [];
  let appRef: FastifyInstance | null = null;
  const play = async (
    op: string,
    expiresAt: Date,
    fallbackUsd: number,
  ): Promise<ExecutorResult> => {
    executorCalls.push(op);
    const step = steps.shift() ?? { kind: "charge", usd: fallbackUsd };
    if (step.kind === "free_period") {
      return { ok: false, code: "free_period", message: "No Meter Parking until 8:00 AM" };
    }
    if (step.kind === "fail") return { ok: false, code: step.code, message: "provider flow broke" };
    if (step.kind === "charge") {
      const answer = await postWebhook(
        appRef!,
        authRequest(`iauth_${op}_${executorCalls.length}`, step.usd),
      );
      webhookAnswers.push({ approved: answer.approved, reason: answer.metadata.reason });
      if (!answer.approved) {
        return { ok: false, code: "payment_declined", message: "card declined at the provider" };
      }
    }
    const usd = step.kind === "charge" ? step.usd : fallbackUsd;
    return {
      ok: true,
      providerSessionId: `prov-${op}`,
      expiresAt,
      amountUsd: usd,
    };
  };
  const executor: Executor = {
    startSession: (args) =>
      play("start", new Date(NOW.getTime() + args.minutes * 60_000), args.amountUsd + args.feeUsd),
    extendSession: (args) =>
      play(
        "extend",
        new Date(args.currentExpiresAt.getTime() + args.minutes * 60_000),
        args.amountUsd + args.feeUsd,
      ),
    stopSession: async (args) => ({
      ok: true,
      providerSessionId: args.providerSessionId,
      expiresAt: NOW,
      amountUsd: 0,
    }),
  };
  const live = options.dryRun !== true;
  const t = makeTestApp({
    zones: [BOYLSTON],
    now: () => NOW,
    seedLinkedProvider: false,
    paymentSource: options.paymentSource ?? "parkagent_card",
    issuingLive: true,
    envDryRun: !live,
    policy: { dry_run: !live, ...(options.policy ?? {}) },
    executor,
    stripe: gateway,
  });
  appRef = t.app;
  seedProviderAccount(t.state, { provider: "passport", cardAdded: options.cardOnProvider ?? true });
  seedFundingMethod(t.state);
  t.state.issuingCards.push({ stripeCardId: CARD_ID, userId: "u1", status: "active" });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 42.3495,
    lng: -71.0798,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  return { ...t, calls, executorCalls, webhookAnswers };
}

function start(t: ReturnType<typeof cardApp>, body: object = START) {
  return t.app.inject({ method: "POST", url: "/session/start", headers: HEADERS, payload: body });
}

describe("the hold amount", () => {
  test("is the quote plus 20%, never less than $2 over", () => {
    expect(holdAmountFor(5.98)).toBe(7.98); // the $2 floor
    expect(holdAmountFor(20)).toBe(24); // 20%
    expect(holdAmountFor(10)).toBe(12); // the crossover
  });
});

describe("hold → pay → capture", () => {
  test("a start holds before the provider, captures what our card paid, releases the rest", async () => {
    // ParkBoston bills in increments: the receipt lands a little under the quote.
    const t = cardApp({ steps: [{ kind: "charge", usd: 5.6 }] });
    const res = await start(t);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: "s1" });

    // Held before the executor ran: quote + the $2 floor, one per leg.
    expect(t.calls.holds).toEqual([{ amountUsd: 7.98, idempotencyKey: "hold:s1:start" }]);
    // The webhook approved our card against that hold…
    expect(t.webhookAnswers).toEqual([{ approved: true, reason: "approved" }]);
    expect(t.state.issuingAuthorizations[0]).toMatchObject({
      approved: true,
      holdId: "hold1",
      sessionId: "s1",
    });
    // …and the hold captured exactly that, not the quote or the hold.
    expect(t.calls.captures).toEqual([{ paymentIntentId: "pi_1", amountUsd: 5.6 }]);
    expect(t.calls.cancels).toEqual([]);
    expect(t.state.sessionHolds[0]).toMatchObject({ status: "captured", capturedUsd: 5.6 });

    const rules = t.state.decisions.filter((d) => d.kind === "wallet_hold").map((d) => d.rule);
    expect(rules).toEqual(["hold_placed", "hold_captured"]);
    const startOk = t.state.decisions.find((d) => d.rule === "start_ok")!;
    expect(startOk.inputs).toMatchObject({ paymentSource: "parkagent_card" });
    expect(startOk.outcome["hold"]).toMatchObject({
      heldUsd: 7.98,
      status: "captured",
      capturedUsd: 5.6,
    });
    expect(t.state.sessions[0]!.paymentSource).toBe("parkagent_card");
  });

  test("a declined hold pays nothing and says so: no executor, failed session, Wallet push", async () => {
    const t = cardApp({ declineWith: "insufficient_funds" });
    const res = await start(t);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "card_declined" });
    // The provider was never asked to charge anything.
    expect(t.executorCalls).toEqual([]);
    expect(t.state.issuingAuthorizations).toEqual([]);
    expect(t.calls.captures).toEqual([]);
    expect(t.state.sessions[0]!.status).toBe("failed");
    expect(t.state.sessionHolds[0]).toMatchObject({
      status: "declined",
      declineCode: "insufficient_funds",
    });
    expect(t.state.decisions.find((d) => d.kind === "session_start")!.rule).toBe("hold_declined");
    expect(t.pushes.at(-1)!.push).toMatchObject({ type: "card_declined" });
    expect(t.pushes.at(-1)!.push.body).toContain("Your card was declined — update it in Wallet");
  });

  test("an extension places its own hold and captures its own charge", async () => {
    const t = cardApp({
      steps: [
        { kind: "charge", usd: QUOTE_USD },
        { kind: "charge", usd: 3.1 },
      ],
    });
    expect((await start(t)).statusCode).toBe(200);
    const res = await t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: HEADERS,
      payload: { sessionId: "s1", minutes: 45 },
    });
    expect(res.statusCode).toBe(200);
    expect(t.calls.holds.map((h) => h.idempotencyKey)).toEqual([
      "hold:s1:start",
      "hold:s1:extend-1",
    ]);
    // 45 more minutes at $3.75/h = $2.81 + $0.35 fee → a $5.16 hold.
    expect(t.calls.holds[1]!.amountUsd).toBe(5.16);
    expect(t.calls.captures.map((c) => c.amountUsd)).toEqual([QUOTE_USD, 3.1]);
    expect(t.state.sessionHolds.map((h) => [h.leg, h.status])).toEqual([
      ["start", "captured"],
      ["extend-1", "captured"],
    ]);
    expect(
      t.state.decisions.find((d) => d.kind === "session_extend")!.outcome["hold"],
    ).toMatchObject({ status: "captured", capturedUsd: 3.1 });
  });

  test("a free period releases the hold at once", async () => {
    const t = cardApp({ steps: [{ kind: "free_period" }] });
    const res = await start(t);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "free_period" });
    expect(t.calls.cancels).toEqual(["pi_1"]);
    expect(t.calls.captures).toEqual([]);
    expect(t.state.sessionHolds[0]!.status).toBe("released");
  });

  test("an executor failure before any charge releases the hold in full", async () => {
    const t = cardApp({ steps: [{ kind: "fail", code: "ui_changed" }] });
    const res = await start(t);
    expect(res.statusCode).toBe(502);
    expect(t.calls.cancels).toEqual(["pi_1"]);
    expect(t.state.sessionHolds[0]!.status).toBe("released");
  });

  test("a paid leg with no authorization yet is deferred, then the sweep settles it", async () => {
    // Late charge: the executor succeeds before the webhook ever hears of it.
    const t = cardApp({ steps: [{ kind: "silent" }] });
    expect((await start(t)).statusCode).toBe(200);
    expect(t.state.sessionHolds[0]!.status).toBe("held"); // not released under a charge in flight
    expect(t.state.decisions.filter((d) => d.kind === "wallet_hold").map((d) => d.rule)).toContain(
      "capture_deferred",
    );

    // The provider's charge lands a minute later and is approved against it.
    const answer = await postWebhook(t.app, authRequest("iauth_late", 6.1));
    expect(answer).toMatchObject({ approved: true });

    const deps = { db: t.deps.db, policy: t.deps.policy, stripe: t.deps.stripe };
    // Inside the grace period the sweep leaves it alone…
    expect(await sweepHolds({ ...deps, now: () => new Date(NOW.getTime() + 5 * 60_000) })).toEqual(
      [],
    );
    // …past it, it captures what was authorized.
    const settled = await sweepHolds({ ...deps, now: () => new Date(NOW.getTime() + 20 * 60_000) });
    expect(settled).toMatchObject([{ status: "captured", capturedUsd: 6.1 }]);
    expect(t.calls.captures).toEqual([{ paymentIntentId: "pi_1", amountUsd: 6.1 }]);
  });

  test("a leg nobody charged is released by the sweep", async () => {
    const t = cardApp({ steps: [{ kind: "silent" }] });
    await start(t);
    await sweepHolds({
      db: t.deps.db,
      policy: t.deps.policy,
      stripe: t.deps.stripe,
      now: () => new Date(NOW.getTime() + 20 * 60_000),
    });
    expect(t.calls.cancels).toEqual(["pi_1"]);
    expect(t.state.sessionHolds[0]!.status).toBe("released");
  });

  test("two settlers racing on one hold capture once", async () => {
    const t = cardApp();
    const hold = seedHold(t.state, {
      sessionId: "s9",
      authorizedUsd: 4,
      paymentIntentId: "pi_race",
    });
    // Force the race the fake would otherwise serialize: both settlers READ
    // the hold (as copies, like rows off the wire) before either writes.
    const db = t.deps.db;
    let waiting: (() => void)[] = [];
    let reads = 0;
    const racingDb = {
      ...db,
      sessionHold: {
        ...db.sessionHold,
        findUnique: async (args: Parameters<typeof db.sessionHold.findUnique>[0]) => {
          const row = await db.sessionHold.findUnique(args);
          reads += 1;
          if (reads <= 2) {
            await new Promise<void>((resolve) => {
              waiting.push(resolve);
              if (waiting.length === 2) {
                waiting.forEach((r) => r());
                waiting = [];
              }
            });
          }
          return row ? structuredClone(row) : row;
        },
      },
    } as typeof db;
    const deps = { db: racingDb, policy: t.deps.policy, stripe: t.deps.stripe, now: () => NOW };
    const [a, b] = await Promise.all([
      settleHold(deps, hold.id, "leg_paid"),
      settleHold(deps, hold.id, "sweep"),
    ]);
    expect([a.status, b.status].sort()).toEqual(["already_settled", "captured"]);
    expect(t.calls.captures).toEqual([{ paymentIntentId: "pi_race", amountUsd: 4 }]);
  });
});

describe("the Issuing webhook only pays against a hold", () => {
  test("no live hold → declined_no_hold; more than the hold → declined_over_hold", async () => {
    const t = cardApp();
    // A pending session exists (so it isn't declined for that), but no hold.
    seedSession(t.state, { status: "pending", createdAt: NOW });
    expect(await postWebhook(t.app, authRequest("iauth_a", 5))).toMatchObject({
      approved: false,
      metadata: { reason: "declined_no_hold" },
    });

    seedHold(t.state, { amountUsd: 7.98, createdAt: NOW });
    expect(await postWebhook(t.app, authRequest("iauth_b", 9))).toMatchObject({
      approved: false,
      metadata: { reason: "declined_over_hold" },
    });
    // Two charges can't together exceed it either.
    expect(await postWebhook(t.app, authRequest("iauth_c", 5))).toMatchObject({ approved: true });
    expect(await postWebhook(t.app, authRequest("iauth_d", 5))).toMatchObject({
      approved: false,
      metadata: { reason: "declined_over_hold" },
    });
    expect(t.state.sessionHolds.at(-1)!.authorizedUsd).toBe(5);
  });

  test("two charges racing for one hold's room can't both fit", async () => {
    const t = cardApp();
    seedHold(t.state, { amountUsd: 10, createdAt: NOW });
    // Both claimants list the live holds (as copies) before either claims.
    const db = t.deps.db;
    let waiting: (() => void)[] = [];
    const racingDb = {
      ...db,
      sessionHold: {
        ...db.sessionHold,
        findMany: async (args: Parameters<typeof db.sessionHold.findMany>[0]) => {
          const rows = await db.sessionHold.findMany(args);
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) {
              waiting.forEach((r) => r());
              waiting = [];
            }
          });
          return structuredClone(rows);
        },
      },
    } as typeof db;
    const results = await Promise.all([
      claimHoldForAuthorization(racingDb, "u1", 6, NOW),
      claimHoldForAuthorization(racingDb, "u1", 6, NOW),
    ]);
    expect(results.map((r) => r.claimed).sort()).toEqual([false, true]);
    expect(t.state.sessionHolds[0]!.authorizedUsd).toBe(6);
  });

  test("a stale hold (a finished leg) is never matched", async () => {
    const t = cardApp();
    seedSession(t.state, { status: "pending", createdAt: NOW });
    seedHold(t.state, { amountUsd: 10, createdAt: new Date(NOW.getTime() - 30 * 60_000) });
    expect(await postWebhook(t.app, authRequest("iauth_old", 5))).toMatchObject({
      approved: false,
      metadata: { reason: "declined_no_hold" },
    });
  });

  test("a reversed authorization gives its room back; replaying it doesn't give twice", async () => {
    const t = cardApp();
    seedSession(t.state, { status: "pending", createdAt: NOW });
    const hold = seedHold(t.state, { amountUsd: 10, createdAt: NOW });
    await postWebhook(t.app, authRequest("iauth_r", 6));
    expect(hold.authorizedUsd).toBe(6);
    const reversed = {
      id: "evt_rev",
      type: "issuing_authorization.updated",
      data: {
        object: {
          ...authRequest("iauth_r", 6).data.object,
          amount: 0,
          approved: true,
          status: "reversed",
        },
      },
    };
    await postWebhook(t.app, reversed);
    await postWebhook(t.app, reversed);
    expect(hold.authorizedUsd).toBe(0);
  });

  test("a Stripe-side cancel (7-day expiry) closes the hold; a replay changes nothing", async () => {
    const t = cardApp();
    const hold = seedHold(t.state, { paymentIntentId: "pi_exp" });
    const canceled = {
      id: "evt_pi",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_exp",
          object: "payment_intent",
          status: "canceled",
          amount: 798,
          metadata: { parkagent: "session_hold" },
        },
      },
    };
    await postWebhook(t.app, canceled);
    expect(hold.status).toBe("released");
    await postWebhook(t.app, canceled);
    const rules = t.state.decisions.filter((d) => d.kind === "wallet_hold").map((d) => d.rule);
    expect(rules).toEqual(["reconciled_released", "replayed"]);
  });
});

describe("readiness and the dry-run guard", () => {
  test("dry run: no hold is placed and no Stripe call is made; the decision says what would be", async () => {
    // (The dry-run executor never reaches a provider, so nothing charges.)
    const t = cardApp({ dryRun: true, cardOnProvider: false, steps: [{ kind: "silent" }] });
    const res = await start(t);
    expect(res.statusCode).toBe(200);
    expect(t.calls.holds).toEqual([]);
    expect(t.calls.captures).toEqual([]);
    expect(t.state.sessionHolds).toEqual([]);
    const dry = t.state.decisions.find((d) => d.kind === "wallet_hold")!;
    expect(dry).toMatchObject({ rule: "dry_run", outcome: { placed: false, wouldHold: 7.98 } });
  });

  test("no saved card, a frozen card, or our card missing from the account → refused before anything", async () => {
    const noFunding = cardApp();
    noFunding.state.fundingMethods = [];
    expect((await start(noFunding)).json()).toMatchObject({
      error: "wallet_not_ready",
      reason: "no_funding_method",
    });

    const frozen = cardApp();
    frozen.state.issuingCards[0]!.status = "inactive";
    expect((await start(frozen)).json()).toMatchObject({ reason: "parkagent_card_frozen" });

    // The account still carries the user's own card: charging it while we
    // hold and capture on ours would double-charge. Refuse.
    const notOn = cardApp({ cardOnProvider: false });
    expect((await start(notOn)).json()).toMatchObject({
      reason: "parkagent_card_not_on_provider",
    });

    for (const t of [noFunding, frozen, notOn]) {
      expect(t.state.sessions).toEqual([]);
      expect(t.calls.holds).toEqual([]);
      expect(t.executorCalls).toEqual([]);
    }
  });
});

describe("caps bind every source", () => {
  test("session cap: refused before a hold (ParkAgent card) or a charge (the others)", async () => {
    for (const paymentSource of ["parkagent_card", "provider_card", "link_wallet"]) {
      const t = cardApp({ paymentSource, policy: { session_cap_usd: 5 } });
      const res = await start(t);
      expect(res.statusCode, paymentSource).toBe(409);
      expect(res.json()).toMatchObject({ error: "policy_violation", rule: "session_cap_exceeded" });
      expect(t.calls.holds).toEqual([]);
      expect(t.executorCalls).toEqual([]);
    }
  });

  test("daily cap: today's real spend counts whatever paid it", async () => {
    for (const paymentSource of ["parkagent_card", "provider_card", "link_wallet"]) {
      const t = cardApp({ paymentSource, policy: { daily_cap_usd: 60 } });
      seedSession(t.state, {
        status: "stopped",
        dryRun: false,
        paymentSource: "provider_card",
        amountUsd: 58,
        feeUsd: 0,
        createdAt: NOW,
      });
      const res = await start(t);
      expect(res.json(), paymentSource).toMatchObject({ rule: "daily_cap_exceeded" });
      expect(t.calls.holds).toEqual([]);
    }
  });

  test("a Link user's street meter pays with the card on the provider account", async () => {
    // The provider charges the user's own saved card — nothing reaches our
    // Issuing webhook.
    const t = cardApp({ paymentSource: "link_wallet", steps: [{ kind: "silent" }] });
    const res = await start(t);
    expect(res.statusCode).toBe(200);
    expect(t.state.sessions[0]!.paymentSource).toBe("provider_card");
    expect(t.state.decisions.find((d) => d.rule === "start_ok")!.inputs).toMatchObject({
      paymentSource: "provider_card",
      requestedSource: "link_wallet",
    });
    expect(t.calls.holds).toEqual([]);
  });
});

describe("the auto-extend worker", () => {
  test("a declined extension hold is an extend_failed with the decline, and a Wallet push", async () => {
    const t = cardApp({ declineWith: "expired_card" });
    setFakeRowClock(() => NOW);
    seedSession(t.state, {
      id: "s-auto",
      status: "active",
      dryRun: false,
      paymentSource: "parkagent_card",
      zoneId: BOYLSTON.zoneId,
      city: "bos",
      providerZoneNumber: "456",
      startedAt: new Date(NOW.getTime() - 80 * 60_000),
      expiresAt: new Date(NOW.getTime() + 8 * 60_000),
      rateFirstHour: 3.75,
      rateAdditionalHour: 3.75,
      maxStayMinutes: 300,
      hoursJson: HOURS_BOS,
      purchasedMinutes: 90,
      chargedMinutes: 90,
      carLat: 42.3495,
      carLng: -71.0798,
      parknycConfirmation: "prov-1",
    });
    // Far from the car and walking away: ticket risk wins → extend.
    t.state.locationFixes.push(
      ...[0, 1, 2].map((i) => ({
        id: `f${i}`,
        sessionId: "s-auto",
        userId: "u1",
        lat: 42.36 + i * 0.002,
        lng: -71.06,
        accuracyM: 10,
        ts: new Date(NOW.getTime() - (2 - i) * 60_000),
      })),
    );
    const extender = makeExtender({
      db: t.deps.db,
      policy: t.deps.policy,
      executorFor: t.deps.executorFor,
      sendPush: t.deps.sendPush,
      stripe: t.deps.stripe,
      now: () => NOW,
      log: { info: () => {}, warn: () => {} },
    });
    await extender.tick();
    const tick = t.state.decisions.find((d) => d.kind === "extend_tick")!;
    expect(tick.rule).toBe("extend_failed");
    expect(tick.outcome).toMatchObject({ code: "card_declined" });
    expect(t.executorCalls).toEqual([]); // the provider was never asked
    expect(t.pushes.at(-1)!.push.type).toBe("card_declined");
  });
});
