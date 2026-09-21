import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import type { Quote } from "../services/quote.js";
import { spentToday } from "../services/sessions.js";
import { quoteZone } from "../services/quote.js";
import type { Candidate } from "../services/zoneLookup.js";
import { lookupRadiusM, resolveCandidates } from "../services/zoneLookup.js";

const bodySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().nonnegative().lte(10_000),
  ts: z.iso.datetime({ offset: true }).optional(),
  signals: z.array(z.string()).max(32).default([]),
});

type Action = "pay" | "confirm" | "ignore" | "unknown_zone";

function candidatePayload(candidate: Candidate, quote: Quote) {
  return {
    zoneId: candidate.zoneId,
    city: candidate.city,
    providerZoneNumber: candidate.providerZoneNumber,
    distanceM: Math.round(candidate.distanceM * 10) / 10,
    containsPoint: candidate.containsPoint,
    rateFirstHourUsd: candidate.rateFirstHourUsd,
    rateAdditionalHourUsd: candidate.rateAdditionalHourUsd,
    maxStayMinutes: candidate.maxStayMinutes,
    hours: candidate.hours,
    quote,
  };
}

export function registerParked(app: FastifyInstance, deps: AppDeps): void {
  app.post("/parked", { preHandler: deps.authenticate }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const policy = deps.policy.get();
    // Price at the phone's detection time when it sent one; a missing or
    // delayed ts falls back to server time. A ts too far off the server
    // clock (a phone with a wrong clock, a replayed request) would price
    // the wrong enforcement window, so it is clamped to server time — the
    // decision records which source won.
    const serverNow = deps.now?.() ?? new Date();
    const requestTs = body.ts ? new Date(body.ts) : null;
    const MAX_TS_PAST_MS = 24 * 60 * 60_000;
    const MAX_TS_FUTURE_MS = 10 * 60_000;
    const tsUsable =
      requestTs !== null &&
      serverNow.getTime() - requestTs.getTime() <= MAX_TS_PAST_MS &&
      requestTs.getTime() - serverNow.getTime() <= MAX_TS_FUTURE_MS;
    const at = tsUsable ? requestTs : serverNow;
    const pricedAtSource = tsUsable
      ? "request_ts"
      : requestTs !== null
        ? "request_ts_clamped"
        : "server_time";
    const radiusM = lookupRadiusM(body.accuracy);

    const found = await deps.findCandidates({
      lat: body.lat,
      lng: body.lng,
      radiusM,
    });
    const resolution = resolveCandidates(found, at, policy.respect_enforcement_hours);

    let action: Action;
    let rule: string;
    let candidates: ReturnType<typeof candidatePayload>[] = [];
    let quote: Quote | null = null;

    if (resolution.kind === "unknown") {
      action = "unknown_zone";
      rule = "unknown_zone";
    } else if (resolution.kind === "disagree") {
      // Both plausible sides differ in what they'd charge or allow — the
      // driver has to say which curb the car is on.
      action = "confirm";
      rule = "candidates_disagree";
      quote = quoteZone(resolution.nearest, policy, at);
      candidates = [
        candidatePayload(resolution.nearest, quote),
        candidatePayload(resolution.alternative, quoteZone(resolution.alternative, policy, at)),
      ];
    } else {
      quote = quoteZone(resolution.nearest, policy, at);
      candidates = [candidatePayload(resolution.nearest, quote)];
      const ladderMax = Math.max(
        resolution.nearest.rateFirstHourUsd,
        resolution.nearest.rateAdditionalHourUsd,
      );
      if (quote.totalUsd === 0) {
        action = "ignore";
        rule = "free_period";
      } else if (ladderMax > policy.auto_pay_max_rate_per_hour) {
        action = "confirm";
        rule = "rate_above_ceiling";
      } else if (quote.totalUsd > policy.session_cap_usd) {
        action = "confirm";
        rule = "session_cap_exceeded";
      } else {
        const spentTodayUsd = await spentToday(deps.db, user.id, at);
        if (spentTodayUsd + quote.totalUsd > policy.daily_cap_usd) {
          action = "confirm";
          rule = "daily_cap_exceeded";
        } else {
          action = "pay";
          rule = "auto_pay_ok";
        }
      }
    }

    // A provider-covered zone whose pay-by-app number we don't know yet
    // (Boston: user reports fill them in) can't be paid silently — the app
    // asks the driver to read the number off the meter first. A free
    // period still needs no payment, so "ignore" stands.
    const needsZoneNumber =
      resolution.kind !== "unknown" &&
      action !== "ignore" &&
      resolution.nearest.providerZoneNumber === "" &&
      providerForCity(cityForZone(resolution.nearest.zoneId)) !== null;
    if (needsZoneNumber && action === "pay") {
      action = "confirm";
      rule = "needs_zone_number";
    }

    const dryRun = deps.policy.effectiveDryRun();
    const parkedEvent = await deps.db.parkedEvent.create({
      data: {
        userId: user.id,
        lat: body.lat,
        lng: body.lng,
        accuracyM: body.accuracy,
        ts: at,
        signals: body.signals,
      },
    });
    const decision = await deps.db.decision.create({
      data: {
        kind: "parked_quote",
        inputs: {
          body,
          pricedAt: at.toISOString(),
          pricedAtSource,
          radiusM,
          candidateZoneIds: found.map((c) => c.zoneId),
          dryRun,
          policyHash: deps.policy.hash(),
        },
        rule,
        outcome: { action, quote, candidates, needsZoneNumber },
        userId: user.id,
        parkedEventId: parkedEvent.id,
      },
    });

    // Which provider runs this city's meters, and whether the caller has
    // linked an account there — the app routes an unlinked user into the
    // link flow before offering to pay.
    const city = resolution.kind === "unknown" ? null : cityForZone(resolution.nearest.zoneId);
    const providerInfo = providerForCity(city);
    let provider = null;
    if (providerInfo) {
      const account = await deps.db.providerAccount.findUnique({
        where: { userId_provider: { userId: user.id, provider: providerInfo.id } },
      });
      provider = {
        id: providerInfo.id,
        city: providerInfo.city,
        displayName: providerInfo.displayName,
        loginUrl: providerInfo.loginUrl,
        status: account?.status ?? "unlinked",
        linked: account?.status === "linked",
      };
    }

    return {
      action,
      candidates,
      quote,
      rule,
      dryRun,
      // True → the app collects the posted zone number
      // (POST /zones/:zoneId/provider-number) before offering to pay.
      needsZoneNumber,
      provider,
      parkedEventId: parkedEvent.id,
      decisionId: decision.id,
    };
  });
}
