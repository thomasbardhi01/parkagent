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
import { cityForZone, providerForCity } from "../providers/registry.js";
import { paymentFailedPush, sessionStartedPush } from "../services/apns.js";
import type { HoursInterval } from "../services/hours.js";
import { priceStay } from "../services/quote.js";
import {
  applyExtension,
  extensionPolicyViolation,
  priceExtension,
  spentToday,
} from "../services/sessions.js";

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

  app.post("/session/start", { preHandler: deps.authenticate }, async (req, reply) => {
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
      if (!account || account.status !== "linked") {
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

    const terms = {
      rateFirstHourUsd: Number(zone.rateFirstHour),
      rateAdditionalHourUsd: Number(zone.rateAdditionalHour),
      hours: zone.hoursJson as HoursInterval[],
    };
    const minutes =
      body.minutes ??
      Math.min(policy.default_stay_minutes, zone.maxStayMinutes ?? policy.default_stay_minutes);
    const price = priceStay(terms, policy, at, minutes);
    const dryRun = deps.policy.effectiveDryRun();
    const spentTodayUsd = await spentToday(deps.db, user.id, at);

    let rule: string | null = null;
    if (zone.maxStayMinutes !== null && minutes > zone.maxStayMinutes) {
      rule = "max_stay_exceeded";
    } else if (price.totalUsd > policy.session_cap_usd) {
      rule = "session_cap_exceeded";
    } else if (!dryRun && spentTodayUsd + price.totalUsd > policy.daily_cap_usd) {
      rule = "daily_cap_exceeded";
    }

    const decisionInputs = {
      body,
      minutes,
      price,
      spentTodayUsd,
      dryRun,
      policyHash: deps.policy.hash(),
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

    const session = await deps.db.session.create({
      data: {
        userId: user.id,
        zoneId: zone.zoneId,
        parknycZoneNumber: zone.parknycZoneNumber,
        status: "pending",
        dryRun,
        parkedEventId: parkedEvent.id,
        carLat: parkedEvent.lat,
        carLng: parkedEvent.lng,
        rateFirstHour: terms.rateFirstHourUsd,
        rateAdditionalHour: terms.rateAdditionalHourUsd,
        maxStayMinutes: zone.maxStayMinutes,
        hoursJson: terms.hours,
        amountUsd: 0,
        feeUsd: 0,
      },
    });

    const startedAtMs = Date.now();
    const result = await deps.executorFor({ userId: user.id, city, dryRun }).startSession({
      zoneNumber: zone.parknycZoneNumber,
      minutes,
      amountUsd: price.meterUsd,
      feeUsd: price.feeUsd,
    });
    const durationMs = Date.now() - startedAtMs;

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
          },
          userId: user.id,
          parkedEventId: parkedEvent.id,
          sessionId: session.id,
        },
      });
      await deps.sendPush(
        user.id,
        paymentFailedPush({ zoneNumber: zone.parknycZoneNumber, what: "pay", code: result.code }),
      );
      return reply
        .code(502)
        .send({ error: "executor_failed", code: result.code, decisionId: decision.id });
    }

    await deps.db.session.update({
      where: { id: session.id },
      data: {
        status: "active",
        startedAt: at,
        expiresAt: result.expiresAt,
        amountUsd: price.meterUsd,
        feeUsd: price.feeUsd,
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
        amountUsd: price.meterUsd,
        feeUsd: price.feeUsd,
        expiresAt: result.expiresAt,
        providerSessionId: result.providerSessionId,
        dryRun,
        details: { durationMs },
      },
    });
    await deps.db.decision.create({
      data: {
        kind: "session_start",
        inputs: decisionInputs,
        rule: "start_ok",
        outcome: { allowed: true, ok: true, sessionId: session.id, price, durationMs },
        userId: user.id,
        parkedEventId: parkedEvent.id,
        sessionId: session.id,
      },
    });
    await deps.sendPush(
      user.id,
      sessionStartedPush({
        zoneNumber: zone.parknycZoneNumber,
        minutes,
        totalUsd: price.totalUsd,
        expiresAt: result.expiresAt,
        dryRun,
      }),
    );
    return { sessionId: session.id, expiresAt: result.expiresAt, amountUsd: price.totalUsd };
  });

  app.post("/session/extend", { preHandler: deps.authenticate }, async (req, reply) => {
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
    await deps.db.decision.create({
      data: {
        kind: "session_extend",
        inputs: decisionInputs,
        rule: outcome.ok ? "extend_ok" : "executor_failed",
        outcome: outcome.ok
          ? {
              allowed: true,
              ok: true,
              expiresAt: outcome.expiresAt.toISOString(),
              price,
              durationMs: outcome.durationMs,
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
      return reply.code(502).send({ error: "executor_failed", code: outcome.code });
    }
    return { sessionId: session.id, expiresAt: outcome.expiresAt, amountUsd: price.totalUsd };
  });

  app.post("/session/stop", { preHandler: deps.authenticate }, async (req, reply) => {
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
