/**
 * GET /admin/summary — the evening (and mid-field-test) read: what
 * happened today, per city, in one authenticated call instead of a psql
 * session. Everything comes from the decisions/parked_events/sessions
 * tables; nothing here decides anything.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { requireAdmin } from "../app.js";
import { cityForZone } from "../providers/registry.js";
import { nycStartOfDay } from "../services/hours.js";
import { PUSH_TEST_TYPES, samplePush } from "../services/apns.js";
import type { PushTestType } from "../services/apns.js";

interface CitySummary {
  parks: number;
  unknownZone: number;
  sessionsStarted: number;
  sessionsFailed: number;
  extensionsAuto: number;
  extensionsManual: number;
  /** /parked confirms + hard 409s + issuing declines, by rule. */
  declines: Record<string, number>;
  /** Executor failure codes seen today (starts, extends, stops). */
  executorErrors: Record<string, number>;
  shadow: { fired: number; approved: number; declined: number; missed: number };
  spendUsd: number;
}

function emptyCity(): CitySummary {
  return {
    parks: 0,
    unknownZone: 0,
    sessionsStarted: 0,
    sessionsFailed: 0,
    extensionsAuto: 0,
    extensionsManual: 0,
    declines: {},
    executorErrors: {},
    shadow: { fired: 0, approved: 0, declined: 0, missed: 0 },
    spendUsd: 0,
  };
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

interface DecisionOutcome {
  action?: string;
  code?: string;
  quote?: { zoneId?: string } | null;
  candidates?: { city?: string }[];
  shadow?: { fired?: boolean; approved?: boolean };
}

export function registerAdmin(app: FastifyInstance, deps: AppDeps): void {
  const pushTestSchema = z.object({
    types: z.array(z.enum(PUSH_TEST_TYPES)).optional(),
  });

  // Send a sample of each push type to the caller's registered devices and
  // report the APNs response per device — the field-test "did notifications
  // arrive?" check. Admin only; writes no decisions (it moves no money).
  app.post("/admin/push-test", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!deps.apnsDelivery) {
      return reply.code(503).send({ error: "apns_not_configured" });
    }
    const parsed = pushTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const at = deps.now?.() ?? new Date();
    const types: PushTestType[] = parsed.data.types ?? [...PUSH_TEST_TYPES];
    const sent = [];
    for (const type of types) {
      const report = await deps.apnsDelivery(user.id, samplePush(type, at));
      sent.push({ type, ...report });
    }
    // Overall: were there devices, and did every delivery return 200?
    const anyDevices = sent.some((s) => s.deviceCount > 0);
    const allAccepted =
      anyDevices &&
      sent.every((s) => s.results.length > 0 && s.results.every((r) => r.status === 200));
    return { configured: true, anyDevices, allAccepted, sent };
  });

  app.get("/admin/summary", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const at = deps.now?.() ?? new Date();
    const since = nycStartOfDay(at);

    const [decisions, parks, sessions] = await Promise.all([
      deps.db.decision.findMany({ where: { createdAt: { gte: since } } }),
      deps.db.parkedEvent.findMany({ where: { ts: { gte: since } } }),
      deps.db.session.findMany({ where: { createdAt: { gte: since } } }),
    ]);

    const cities: Record<string, CitySummary> = {};
    const cityOf = (key: string | null): CitySummary => {
      const name = key ?? "unknown";
      cities[name] ??= emptyCity();
      return cities[name];
    };
    // Session city by id, for decisions that only carry a sessionId.
    const sessionCity = new Map(sessions.map((s) => [s.id, s.city]));

    const decisionCity = (d: { sessionId: string | null; outcome: unknown }): string | null => {
      const outcome = d.outcome as DecisionOutcome;
      if (d.sessionId && sessionCity.has(d.sessionId)) return sessionCity.get(d.sessionId)!;
      const zoneId = outcome.quote?.zoneId;
      if (zoneId) return cityForZone(zoneId);
      return outcome.candidates?.[0]?.city ?? null;
    };

    const detectorSignals: Record<string, number> = {};
    for (const park of parks) {
      for (const signal of Array.isArray(park.signals) ? park.signals : []) {
        if (typeof signal === "string") bump(detectorSignals, signal);
      }
    }

    for (const session of sessions) {
      const city = cityOf(session.city);
      if (session.status === "failed") city.sessionsFailed += 1;
      else city.sessionsStarted += 1;
      city.spendUsd += Number(session.amountUsd ?? 0) + Number(session.feeUsd ?? 0);
      city.extensionsAuto += 0; // counted from extend_tick decisions below
    }

    for (const d of decisions) {
      const outcome = d.outcome as DecisionOutcome;
      const city = cityOf(decisionCity(d));
      switch (d.kind) {
        case "parked_quote":
          city.parks += 1;
          if (d.rule === "unknown_zone") city.unknownZone += 1;
          else if (d.rule !== "auto_pay_ok" && d.rule !== "free_period") {
            bump(city.declines, d.rule);
          }
          break;
        case "session_start":
        case "session_stop":
          if (d.rule === "executor_failed" && outcome.code) {
            bump(city.executorErrors, outcome.code);
          } else if (d.kind === "session_start" && d.rule !== "start_ok") {
            bump(city.declines, d.rule);
          }
          break;
        case "session_extend":
          if (d.rule === "extend_ok") city.extensionsManual += 1;
          else if (d.rule === "executor_failed" && outcome.code) {
            bump(city.executorErrors, outcome.code);
          } else bump(city.declines, d.rule);
          break;
        case "extend_tick":
          if (d.rule === "extend") city.extensionsAuto += 1;
          else if (d.rule === "extend_failed" && outcome.code) {
            bump(city.executorErrors, outcome.code);
          }
          break;
        case "issuing_authorization":
          if (d.rule.startsWith("declined_")) bump(city.declines, d.rule);
          break;
        default:
          break;
      }
      if (outcome.shadow) {
        const shadow = city.shadow;
        if (outcome.shadow.fired) {
          shadow.fired += 1;
          if (outcome.shadow.approved) shadow.approved += 1;
          else shadow.declined += 1;
        } else shadow.missed += 1;
      }
    }

    for (const summary of Object.values(cities)) {
      summary.spendUsd = Math.round(summary.spendUsd * 100) / 100;
    }

    return {
      since: since.toISOString(),
      now: at.toISOString(),
      dryRun: deps.policy.effectiveDryRun(),
      policyHash: deps.policy.hash(),
      cities,
      detectorSignals,
      decisionCount: decisions.length,
    };
  });
}
