/**
 * The money-moving endpoints. Shapes are pinned by API.md and the iOS
 * client (SessionStartRequest & co in ios/.../APIModels.swift).
 *
 * Caps are HARD here: /parked's "confirm" lets the driver resolve zone
 * ambiguity or approve an above-ceiling rate, but a start or extension
 * that would break session_cap_usd, daily_cap_usd, or the zone's max stay
 * is refused outright (409) — raise the caps via PUT /policy to override.
 * Every outcome, allowed or refused, writes a decisions row.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { SessionRow } from "../db.js";
import { cityForZone, providerForCity, providerStatusUsable } from "../providers/registry.js";
import { freePeriodPush, paymentFailedPush, sessionStartedPush } from "../services/apns.js";
import type { HoursInterval } from "../services/hours.js";
import { priceStay } from "../services/quote.js";
import {
  applyExtension,
  extensionPolicyViolation,
  priceExtension,
  spentToday,
} from "../services/sessions.js";
import { fireShadowAuthorization } from "../services/shadow.js";
import {
  effectiveTerms,
  observedTermsFor,
  providerTermsMismatch,
  recordObservedTerms,
} from "../services/zoneTermsObserved.js";

const startSchema = z.object({
  parkedEventId: z.string().min(1),
  zoneId: z.string().min(1),
  minutes: z.number().int().positive().max(720).optional(),
});

const stopSchema = z.object({
  sessionId: z.string().min(1),
});

const extendSchema = z.object({
  sessionId: z.string().min(1),
  minutes: z.number().int().positive().max(720),
});

export function registerSession(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();

  /** Load the caller's session or reply 404/409; null means already replied. */
  async function activeSession(
    sessionId: string,
    userId: string,
    reply: { code(c: number): { send(b: unknown): unknown } },
  ): Promise<SessionRow | null> {
    const session = await deps.db.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      reply.code(404).send({ error: "session_not_found" });
      return null;
    }
    if (session.status !== "active") {
      reply.code(409).send({ error: "session_not_active", status: session.status });
      return null;
    }
    return session;
  }

  app.post("/session/start", async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const policy = deps.policy.get();
    const at = now();

    const parkedEvent = await deps.db.parkedEvent.findUnique({ where: { id: body.parkedEventId } });
    if (!parkedEvent || parkedEvent.userId !== user.id) {
      return reply.code(404).send({ error: "parked_event_not_found" });
    }
    // A pending row is normally seconds old (created just before the
    // executor runs). One orphaned by a crash mid-start would block the
    // one-open-session-per-user index forever, so sweep stale ones first.
    const pendings = await deps.db.session.findMany({
      where: { userId: user.id, status: "pending" },
    });
    for (const stale of pendings) {
      if (at.getTime() - stale.createdAt.getTime() > 10 * 60_000) {
        await deps.db.session.update({ where: { id: stale.id }, data: { status: "failed" } });
      }
    }
    const existing = await deps.db.session.findFirst({
      where: { userId: user.id, status: "active" },
    });
    if (existing) {
      return reply.code(409).send({ error: "session_already_active", sessionId: existing.id });
    }
    const zone = await deps.db.zone.findUnique({ where: { zoneId: body.zoneId } });
    if (!zone) {
      return reply.code(404).send({ error: "zone_not_found" });
    }

    // The zone's city names its provider; without the user's own linked
    // account there the executor has nothing to pay with — refuse, naming
    // the provider so the app can send them to the link flow.
    const city = cityForZone(zone.zoneId);
    const provider = providerForCity(city);
    if (provider) {
      const account = await deps.db.providerAccount.findUnique({
        where: { userId_provider: { userId: user.id, provider: provider.id } },
      });
      if (!account || !providerStatusUsable(account.status)) {
        const decision = await deps.db.decision.create({
          data: {
            kind: "session_start",
            inputs: {
              body,
              provider: provider.id,
              accountStatus: account?.status ?? "none",
              dryRun: deps.policy.effectiveDryRun(),
              policyHash: deps.policy.hash(),
            },
            rule: "provider_not_linked",
            outcome: { allowed: false },
            userId: user.id,
            parkedEventId: parkedEvent.id,
          },
        });
        return reply.code(409).send({
          error: "provider_not_linked",
          provider: provider.id,
          displayName: provider.displayName,
          decisionId: decision.id,
        });
      }
    }

    // A provider-covered zone without a known pay-by-app number can't be
    // typed into the provider's Enter Zone screen — the app must collect
    // it first (POST /zones/:zoneId/provider-number).
    if (provider && zone.providerZoneNumber === "") {
      const decision = await deps.db.decision.create({
        data: {
          kind: "session_start",
          inputs: {
            body,
            provider: provider.id,
            dryRun: deps.policy.effectiveDryRun(),
            policyHash: deps.policy.hash(),
          },
          rule: "needs_zone_number",
          outcome: { allowed: false },
          userId: user.id,
          parkedEventId: parkedEvent.id,
        },
      });
      return reply.code(409).send({
        error: "needs_zone_number",
        zoneId: zone.zoneId,
        decisionId: decision.id,
      });
    }

    // Terms the provider itself has displayed for this zone number beat
    // the dataset: Boston's data assumed a 2-hour max everywhere, but the
    // Vehicles chooser shows the posted terms (e.g. "Max 5 Hr").
    const observed = await observedTermsFor(deps.db, zone.city ?? "nyc", zone.providerZoneNumber);
    const effective = effectiveTerms(zone, observed);
    const terms = {
      // The zone's city picks the per-city fee (ParkBoston $0.35 vs
      // ParkNYC $0.15) and rides onto the session row below.
      city: zone.city ?? "nyc",
      rateFirstHourUsd: effective.rateFirstHourUsd,
      rateAdditionalHourUsd: effective.rateAdditionalHourUsd,
      hours: zone.hoursJson as HoursInterval[],
    };
    const maxStayMinutes = effective.maxStayMinutes;
    const minutes =
      body.minutes ??
      Math.min(policy.default_stay_minutes, maxStayMinutes ?? policy.default_stay_minutes);
    const price = priceStay(terms, policy, at, minutes);
    const dryRun = deps.policy.effectiveDryRun();
    const spentTodayUsd = await spentToday(deps.db, user.id, at);

    let rule: string | null = null;
    if (maxStayMinutes !== null && minutes > maxStayMinutes) {
      rule = "max_stay_exceeded";
    } else if (price.totalUsd === 0) {
      // A wholly free window: there is nothing to buy, and typing minutes
      // into the provider anyway could charge real money our quote said
      // was $0 (/parked answers "ignore" for the same reason).
      rule = "free_period";
    } else if (price.totalUsd > policy.session_cap_usd) {
      rule = "session_cap_exceeded";
    } else if (!dryRun && spentTodayUsd + price.totalUsd > policy.daily_cap_usd) {
      rule = "daily_cap_exceeded";
    }

    // Which source pays this session: the user's setting, snapshotted at
    // start. provider_card = the card already on their provider account
    // (the executor pays with the account's own default card either way —
    // with issuing_card that default IS our card, put there by setup-card).
    // The caps above apply regardless of source.
    const userRow = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    const paymentSource = userRow?.paymentSource ?? "provider_card";

    const decisionInputs = {
      body,
      minutes,
      price,
      spentTodayUsd,
      dryRun,
      paymentSource,
      policyHash: deps.policy.hash(),
      // Which terms priced this: the observed row's values when one
      // overrode the dataset.
      ...(effective.observed
        ? {
            observedTerms: {
              ratePerHourUsd:
                observed?.ratePerHourUsd == null ? null : Number(observed.ratePerHourUsd),
              maxStayMinutes: observed?.maxStayMinutes ?? null,
            },
          }
        : {}),
    };
    if (rule) {
      const decision = await deps.db.decision.create({
        data: {
          kind: "session_start",
          inputs: decisionInputs,
          rule,
          outcome: { allowed: false },
          userId: user.id,
          parkedEventId: parkedEvent.id,
        },
      });
      return reply.code(409).send({ error: "policy_violation", rule, decisionId: decision.id });
    }

    // The session's vehicle: the caller's saved plate, passed through the
    // executor so the Passport client can pick the matching button on the
    // Vehicles chooser (a missing plate comes back typed vehicle_missing).
    const vehicle = await deps.db.vehicle.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });

    let session;
    try {
      session = await deps.db.session.create({
        data: {
          userId: user.id,
          ...(vehicle ? { vehicleId: vehicle.id } : {}),
          zoneId: zone.zoneId,
          city: terms.city,
          providerZoneNumber: zone.providerZoneNumber,
          status: "pending",
          dryRun,
          paymentSource,
          parkedEventId: parkedEvent.id,
          carLat: parkedEvent.lat,
          carLng: parkedEvent.lng,
          rateFirstHour: terms.rateFirstHourUsd,
          rateAdditionalHour: terms.rateAdditionalHourUsd,
          maxStayMinutes,
          hoursJson: terms.hours,
          amountUsd: 0,
          feeUsd: 0,
        },
      });
    } catch (err) {
      // The one_open_session_per_user partial unique index closes the race
      // two concurrent starts open between the active check above and this
      // insert — the loser must never reach the executor and pay twice.
      if ((err as { code?: string }).code === "P2002") {
        return reply.code(409).send({ error: "session_already_active" });
      }
      throw err;
    }

    const startedAtMs = Date.now();
    const result = await deps.executorFor({ userId: user.id, city, dryRun }).startSession({
      zoneNumber: zone.providerZoneNumber,
      minutes,
      amountUsd: price.meterUsd,
      feeUsd: price.feeUsd,
      // The car's fix feeds ParkNYC's non-fatal map cross-check; the
      // Passport executor ignores it (ParkBoston has no map — its zone
      // numbers come from user reports, checked above).
      carLat: parkedEvent.lat,
      carLng: parkedEvent.lng,
      ...(zone.street ? { expectedStreet: zone.street } : {}),
      ...(vehicle ? { vehicle: { plate: vehicle.plate, state: vehicle.state } } : {}),
    });
    const durationMs = Date.now() - startedAtMs;

    // The provider's own terms line (Passport shows it on the Vehicles
    // chooser), returned on success AND failure: record it keyed by zone
    // number so quoting can prefer it next time, and flag disagreement
    // with our dataset on the decision.
    const providerTerms = result.providerTerms ?? null;
    let zoneTermsMismatch = false;
    if (providerTerms) {
      zoneTermsMismatch = providerTermsMismatch(zone, providerTerms);
      await recordObservedTerms(deps.db, {
        city: terms.city,
        zoneNumber: zone.providerZoneNumber,
        zoneId: zone.zoneId,
        terms: providerTerms,
        at,
      });
    }
    const providerTermsOutcome = providerTerms ? { providerTerms, zoneTermsMismatch } : {};

    if (!result.ok && result.code === "free_period") {
      // The provider says this zone isn't charging now (after hours). Not
      // a failure: mark the session free (no active/paid row), log the
      // provider's hours alongside our zone data so the two can be
      // compared, and tell the user parking is free — no tap-to-pay.
      await deps.db.session.update({ where: { id: session.id }, data: { status: "free_period" } });
      const providerHours = result.freePeriod?.hours ?? null;
      const decision = await deps.db.decision.create({
        data: {
          kind: "session_start",
          inputs: {
            ...decisionInputs,
            providerNotice: result.freePeriod?.rawText ?? result.message,
            providerHours,
            // Our stored terms for this zone, for the comparison (some
            // Boston zones read 8am-6pm in our data; the city says 8-8).
            zoneHours: zone.hoursJson,
          },
          rule: "free_period",
          outcome: { allowed: false, freePeriod: true, providerHours, durationMs },
          userId: user.id,
          parkedEventId: parkedEvent.id,
          sessionId: session.id,
        },
      });
      await deps.sendPush(
        user.id,
        freePeriodPush({ zoneNumber: zone.providerZoneNumber, notice: result.message }),
      );
      return {
        status: "free_period",
        zoneId: zone.zoneId,
        providerHours,
        notice: result.message,
        decisionId: decision.id,
      };
    }

    if (!result.ok) {
      // The session stays unpaid (status "failed"); the push below carries
      // the tap-to-pay deep link with the zone number.
      await deps.db.session.update({ where: { id: session.id }, data: { status: "failed" } });
      await deps.db.sessionEvent.create({
        data: {
          sessionId: session.id,
          kind: "failed",
          at,
          minutes,
          dryRun,
          details: { op: "start", code: result.code, message: result.message, durationMs },
        },
      });
      const decision = await deps.db.decision.create({
        data: {
          kind: "session_start",
          inputs: decisionInputs,
          rule: "executor_failed",
          outcome: {
            allowed: true,
            ok: false,
            code: result.code,
            message: result.message,
            durationMs,
            // ui_changed evidence: screenshot + visible text, straight onto
            // the decision row (non-negotiable: decisions carry the inputs).
            ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
            ...providerTermsOutcome,
          },
          userId: user.id,
          parkedEventId: parkedEvent.id,
          sessionId: session.id,
        },
      });
      await deps.sendPush(
        user.id,
        paymentFailedPush({
          zoneNumber: zone.providerZoneNumber,
          what: "pay",
          code: result.code,
          providerName: provider?.displayName ?? "your parking account",
        }),
      );
      return reply
        .code(502)
        .send({ error: "executor_failed", code: result.code, decisionId: decision.id });
    }

    // Record the ACTUAL charge when the provider returned a receipt
    // (ParkBoston lists meter/fee/total on the confirm + session screens),
    // so the session's stored spend and the daily-cap accounting match the
    // card to the cent. It differs from `price` (the pre-charge estimate)
    // because ParkBoston sells in per-zone duration increments — a 15-min
    // request is billed as 12 min ($0.75). NYC/dry-run return no receipt,
    // so the estimate stands. See the acceptance report, Job 2.
    const chargedMeterUsd = result.receipt?.meterUsd ?? price.meterUsd;
    const chargedFeeUsd = result.receipt?.feeUsd ?? price.feeUsd;
    const chargedTotalUsd = result.receipt?.totalUsd ?? price.totalUsd;
    await deps.db.session.update({
      where: { id: session.id },
      data: {
        status: "active",
        startedAt: at,
        expiresAt: result.expiresAt,
        amountUsd: chargedMeterUsd,
        feeUsd: chargedFeeUsd,
        purchasedMinutes: minutes,
        chargedMinutes: price.chargedMinutes,
        parknycConfirmation: result.providerSessionId,
      },
    });
    await deps.db.sessionEvent.create({
      data: {
        sessionId: session.id,
        kind: "started",
        at,
        minutes,
        amountUsd: chargedMeterUsd,
        feeUsd: chargedFeeUsd,
        expiresAt: result.expiresAt,
        providerSessionId: result.providerSessionId,
        dryRun,
        details: {
          durationMs,
          // Both numbers, for the audit: what we estimated vs what the
          // provider actually charged (present only when it gave a receipt).
          ...(result.receipt ? { estimatedTotalUsd: price.totalUsd, receipt: result.receipt } : {}),
        },
      },
    });
    // Shadow mode: rehearse the Stripe pipeline (webhook → budget checks →
    // ledger) with a test-mode authorization for the SAME amount the card
    // was charged (the provider receipt when there is one, else the
    // estimate), so the rehearsal matches the real spend. Recorded on the
    // decision below; a shadow failure never fails the session.
    const shadow =
      deps.policy.get().shadow_mode === true
        ? await fireShadowAuthorization(deps, user.id, chargedTotalUsd, terms.city)
        : undefined;

    await deps.db.decision.create({
      data: {
        kind: "session_start",
        inputs: decisionInputs,
        rule: "start_ok",
        outcome: {
          allowed: true,
          ok: true,
          sessionId: session.id,
          price,
          durationMs,
          // What the provider actually charged (ParkBoston's receipt), when
          // it differs from `price` (the estimate) — the audit shows both.
          ...(result.receipt ? { providerReceipt: result.receipt } : {}),
          // Both sides of the map-based zone resolution, when the executor
          // ran one (authoritative for Boston, cross-check for NYC).
          ...(result.zoneResolution ? { zoneResolution: result.zoneResolution } : {}),
          ...providerTermsOutcome,
          ...(shadow ? { shadow } : {}),
        },
        userId: user.id,
        parkedEventId: parkedEvent.id,
        sessionId: session.id,
      },
    });
    // The push and the reply carry the ACTUAL total (chargedTotalUsd) when
    // the provider gave a receipt, so the app shows what the card paid.
    await deps.sendPush(
      user.id,
      sessionStartedPush({
        zoneNumber: zone.providerZoneNumber,
        minutes,
        totalUsd: chargedTotalUsd,
        expiresAt: result.expiresAt,
        dryRun,
      }),
    );
    return { sessionId: session.id, expiresAt: result.expiresAt, amountUsd: chargedTotalUsd };
  });

  app.post("/session/extend", async (req, reply) => {
    const parsed = extendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const at = now();

    const session = await activeSession(body.sessionId, user.id, reply);
    if (!session) return;

    const price = priceExtension(session, deps.policy.get(), body.minutes);
    const spentTodayUsd = await spentToday(deps.db, user.id, at);
    const violation = extensionPolicyViolation(
      deps.policy.get(),
      session,
      body.minutes,
      price,
      spentTodayUsd,
    );
    const decisionInputs = {
      body,
      price,
      spentTodayUsd,
      purchasedMinutes: session.purchasedMinutes,
      extendCount: session.extendCount,
      dryRun: deps.policy.effectiveDryRun(),
      policyHash: deps.policy.hash(),
    };
    if (violation) {
      const decision = await deps.db.decision.create({
        data: {
          kind: "session_extend",
          inputs: decisionInputs,
          rule: violation,
          outcome: { allowed: false },
          userId: user.id,
          sessionId: session.id,
        },
      });
      return reply
        .code(409)
        .send({ error: "policy_violation", rule: violation, decisionId: decision.id });
    }

    const outcome = await applyExtension(deps, session, body.minutes, price, "manual");
    const failRule =
      !outcome.ok && outcome.code === "free_period" ? "free_period" : "executor_failed";
    await deps.db.decision.create({
      data: {
        kind: "session_extend",
        inputs: decisionInputs,
        rule: outcome.ok ? "extend_ok" : failRule,
        outcome: outcome.ok
          ? {
              allowed: true,
              ok: true,
              expiresAt: outcome.expiresAt.toISOString(),
              price,
              durationMs: outcome.durationMs,
              ...(outcome.shadow ? { shadow: outcome.shadow } : {}),
            }
          : {
              allowed: true,
              ok: false,
              code: outcome.code,
              message: outcome.message,
              durationMs: outcome.durationMs,
              ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
            },
        userId: user.id,
        sessionId: session.id,
      },
    });
    if (!outcome.ok) {
      if (outcome.code === "free_period") {
        // Not an executor failure: the provider says this zone is free
        // right now, so there is nothing to extend (and nothing charged).
        return reply.code(409).send({ error: "free_period", notice: outcome.message });
      }
      return reply.code(502).send({ error: "executor_failed", code: outcome.code });
    }
    return { sessionId: session.id, expiresAt: outcome.expiresAt, amountUsd: price.totalUsd };
  });

  app.post("/session/stop", async (req, reply) => {
    const parsed = stopSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const at = now();

    const session = await activeSession(parsed.data.sessionId, user.id, reply);
    if (!session) return;

    const dryRun = deps.policy.effectiveDryRun();
    const startedAtMs = Date.now();
    const result = await deps
      .executorFor({ userId: user.id, city: cityForZone(session.zoneId), dryRun })
      .stopSession({
        providerSessionId: session.parknycConfirmation ?? session.id,
      });
    const durationMs = Date.now() - startedAtMs;
    const decisionInputs = {
      body: parsed.data,
      dryRun,
      policyHash: deps.policy.hash(),
    };

    if (!result.ok) {
      await deps.db.sessionEvent.create({
        data: {
          sessionId: session.id,
          kind: "failed",
          at,
          dryRun,
          details: { op: "stop", code: result.code, message: result.message, durationMs },
        },
      });
      const decision = await deps.db.decision.create({
        data: {
          kind: "session_stop",
          inputs: decisionInputs,
          rule: "executor_failed",
          outcome: {
            ok: false,
            code: result.code,
            message: result.message,
            durationMs,
            ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
          },
          userId: user.id,
          sessionId: session.id,
        },
      });
      return reply
        .code(502)
        .send({ error: "executor_failed", code: result.code, decisionId: decision.id });
    }

    await deps.db.session.update({
      where: { id: session.id },
      data: { status: "stopped", stoppedAt: at },
    });
    await deps.db.sessionEvent.create({
      data: { sessionId: session.id, kind: "stopped", at, dryRun, details: { durationMs } },
    });
    await deps.db.decision.create({
      data: {
        kind: "session_stop",
        inputs: decisionInputs,
        rule: "stop_ok",
        outcome: { ok: true, stoppedAt: at.toISOString(), durationMs },
        userId: user.id,
        sessionId: session.id,
      },
    });
    return { sessionId: session.id, stoppedAt: at };
  });
}
