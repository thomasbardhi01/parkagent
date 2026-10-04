import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { PendingParkRow } from "../db.js";
import type { GarageFootprint } from "../services/garageLookup.js";
import { describeFootprint } from "../services/garageLookup.js";
import { policyFor } from "../services/limits.js";
import type { PlaceHint, ZoneAgreement } from "../services/placeClassification.js";
import {
  classifyPlace,
  cleanPlaceName,
  confirmationRule,
  GARAGE_REACH_M,
  hintGarageId,
  hintIsLocated,
  parseOutcomes,
  parsePlaceHint,
  PLACE_ANSWERS,
  PLACE_NAME_MAX,
  placeOutcome,
} from "../services/placeClassification.js";
import { cityForZone, providerForCity, providerStatusUsable } from "../providers/registry.js";
import {
  PARK_SUPERSEDABLE,
  parkCandidates,
  settlePark,
  startParkSession,
} from "../services/pendingSession.js";
import type { Quote } from "../services/quote.js";
import { spentToday } from "../services/sessions.js";
import { quoteZone } from "../services/quote.js";
import type { Candidate } from "../services/zoneLookup.js";
import { lookupRadiusM, resolveCandidates } from "../services/zoneLookup.js";
import { applyObservedToCandidates } from "../services/zoneTermsObserved.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import type { SessionOps } from "./session.js";

const bodySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().nonnegative().lte(10_000),
  ts: z.iso.datetime({ offset: true }).optional(),
  signals: z.array(z.string()).max(32).default([]),
  // The phone's own read of the place, and which place outcomes the app
  // can show (FR-54). Both are read leniently, further down: a park is
  // never refused over either.
  placeHint: z.unknown().optional(),
  outcomes: z.unknown().optional(),
});

/** What the street lookup alone answers. */
type StreetAction = "pay" | "confirm" | "ignore" | "unknown_zone";

const placeBodySchema = z.object({
  class: z.enum(PLACE_ANSWERS),
  name: z.string().max(PLACE_NAME_MAX).nullish(),
});

/** Pay's body: the side of the street, when the candidates disagree, and
 * the total the phone had on screen when Pay was tapped. */
const confirmBodySchema = z.object({
  zoneId: z.string().min(1).optional(),
  shownTotalUsd: z.number().positive().optional(),
});

/** The outcome a build lists when it waits for the walk-away (FR-55): it
 * shows nothing at the car, reports its fixes, and pays through the tap. */
const WALK_AWAY = "walk_away";

/** How many garages around a fix are weighed; a block holds a handful. */
const GARAGE_LOOKUP_LIMIT = 50;

type GarageLookup = "ok" | "unavailable" | "failed";

/**
 * The garages and lots around a fix, and the one the phone's hint names.
 * Reading them must never fail a park: the pay path worked before there
 * was a garages table, and still does without one.
 */
async function garagesAround(
  deps: AppDeps,
  point: { lat: number; lng: number },
  hint: PlaceHint | null,
  log: { warn: (obj: object, msg: string) => void },
): Promise<{
  garages: GarageFootprint[];
  hintGarage: GarageFootprint | null;
  truncated: boolean;
  lookup: GarageLookup;
}> {
  const store = deps.garageFootprints;
  if (!store) return { garages: [], hintGarage: null, truncated: false, lookup: "unavailable" };
  try {
    const found = await store.near({
      ...point,
      radiusM: GARAGE_REACH_M,
      limit: GARAGE_LOOKUP_LIMIT,
    });
    const id = hintGarageId(hint);
    let hintGarage = id ? (found.garages.find((garage) => garage.id === id) ?? null) : null;
    if (id && !hintGarage) {
      // Not in reach by the server's outlines: the phone's cell may be a
      // week old. A garage somewhere else can't lend this park its name.
      const byId = await store.byId(id);
      if (byId && describeFootprint(point, byId).distanceM <= GARAGE_REACH_M) hintGarage = byId;
    }
    return { garages: found.garages, hintGarage, truncated: found.truncated, lookup: "ok" };
  } catch (err) {
    log.warn({ err }, "parked: garage lookup failed; classifying without footprints");
    return { garages: [], hintGarage: null, truncated: false, lookup: "failed" };
  }
}

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
    // "observed" when zone_terms_observed overrode the dataset's terms.
    ...(candidate.termsSource ? { termsSource: candidate.termsSource } : {}),
    quote,
  };
}

export function registerParked(app: FastifyInstance, deps: AppDeps, sessions: SessionOps): void {
  const now = () => deps.now?.() ?? new Date();
  // A phone parks a handful of times a day; a runaway detector loop (or a
  // stolen key probing the zone map) should not hammer PostGIS.
  const limit = makeRateLimiter({ max: 30, windowMs: 60_000 });
  app.post("/parked", { preHandler: limit }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const { placeHint: rawHint, outcomes: rawOutcomes, ...body } = parsed.data;
    const hint = parsePlaceHint(rawHint);
    const understood = parseOutcomes(rawOutcomes);
    const user = req.authedUser!;
    // The caller's caps and default stay (policy.json caps are ceilings).
    const policy = await policyFor(deps, user.id);
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

    const fetched = await deps.findCandidates({
      lat: body.lat,
      lng: body.lng,
      radiusM,
    });
    // Terms the provider itself displayed (zone_terms_observed) beat the
    // dataset before anything is quoted — the Boston data's assumed 2-hour
    // max understates e.g. zone 456's posted 5 hours.
    const found = await applyObservedToCandidates(deps.db, fetched);
    const resolution = resolveCandidates(found, at, policy.respect_enforcement_hours);

    let action: StreetAction;
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

    // The place (FR-54): what the street lookup said, weighed against the
    // phone's hint and the garage outlines around the fix.
    const street = { action, rule, charges: candidates.some((c) => c.quote.totalUsd > 0) };
    const zones: ZoneAgreement =
      resolution.kind === "unknown"
        ? "none"
        : resolution.kind === "disagree"
          ? "disagree"
          : "agree";
    const point = { lat: body.lat, lng: body.lng };
    const around = await garagesAround(deps, point, hint, req.log);
    const classified = classifyPlace({
      point,
      accuracyM: body.accuracy,
      hint,
      zones,
      garages: around.garages,
      hintGarage: around.hintGarage,
    });
    const answer = placeOutcome(street, classified, understood);
    const located = hintIsLocated(hint);
    // No fix at the spot: lat/lng are where GPS last saw the car driving
    // in, and the meters there are not where the car is. Nothing is quoted.
    if (!located) {
      candidates = [];
      quote = null;
    }
    const answeredNeedsZoneNumber = located && needsZoneNumber;

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
          place: {
            understood,
            located,
            hint,
            memory: classified.memory,
            zones,
            street: { action: street.action, rule: street.rule, charges: street.charges },
            footprint: classified.footprint,
            scores: classified.scores,
            garagesInReach: around.garages.length,
            garagesTruncated: around.truncated,
            garageLookup: around.lookup,
          },
        },
        rule: answer.rule,
        outcome: {
          action: answer.action,
          quote,
          candidates,
          needsZoneNumber: answeredNeedsZoneNumber,
          place: classified.place,
        },
        userId: user.id,
        parkedEventId: parkedEvent.id,
      },
    });

    // A street park with something to pay, from a build that waits for the
    // walk-away (FR-55): recorded, and nothing more. No prompt and no
    // payment while the phone is at the car; POST /location sees it leave.
    const awaitsWalkAway =
      Array.isArray(rawOutcomes) &&
      rawOutcomes.includes(WALK_AWAY) &&
      located &&
      (answer.action === "pay" || answer.action === "confirm") &&
      candidates.some((c) => c.quote.totalUsd > 0);
    if (awaitsWalkAway) {
      // The car is here now: whatever waited at an earlier spot is over,
      // its confirmation with it.
      await deps.db.pendingPark.updateMany({
        where: { userId: user.id, status: { in: PARK_SUPERSEDABLE } },
        data: { status: "superseded", closedAt: serverNow },
      });
      await deps.db.pendingPark.create({
        data: {
          userId: user.id,
          parkedEventId: parkedEvent.id,
          status: "at_car",
          candidates,
          quote,
          carLat: body.lat,
          carLng: body.lng,
          parkedAt: at,
        },
      });
      await deps.db.decision.create({
        data: {
          kind: "street_pending",
          inputs: {
            parkedDecisionId: decision.id,
            candidateZoneIds: candidates.map((c) => c.zoneId),
            car: { lat: body.lat, lng: body.lng, accuracyM: body.accuracy },
            parkedAt: at.toISOString(),
            dryRun,
            policyHash: deps.policy.hash(),
          },
          rule: answer.rule,
          outcome: { status: "at_car", action: answer.action, quote, candidates },
          userId: user.id,
          parkedEventId: parkedEvent.id,
        },
      });
    }

    // Which provider runs this city's meters, and whether the caller has
    // linked an account there — the app routes an unlinked user into the
    // link flow before offering to pay.
    const city =
      resolution.kind === "unknown" || !located ? null : cityForZone(resolution.nearest.zoneId);
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
        linked: providerStatusUsable(account?.status),
      };
    }

    return {
      action: answer.action,
      candidates,
      quote,
      rule: answer.rule,
      dryRun,
      // True → the app collects the posted zone number
      // (POST /zones/:zoneId/provider-number) before offering to pay.
      needsZoneNumber: answeredNeedsZoneNumber,
      provider,
      // What kind of place this is, and where that came from (FR-54).
      place: classified.place,
      // True → nothing is shown at the car; the prompt comes at walk-away.
      ...(awaitsWalkAway ? { awaitsWalkAway: true } : {}),
      parkedEventId: parkedEvent.id,
      decisionId: decision.id,
    };
  });

  /** The caller's own waiting park, or the reply that says why not. */
  async function ownPark(
    userId: string,
    parkedEventId: string,
    reply: { code(c: number): { send(b: unknown): unknown } },
  ): Promise<PendingParkRow | null> {
    const parkedEvent = await deps.db.parkedEvent.findUnique({ where: { id: parkedEventId } });
    if (!parkedEvent || parkedEvent.userId !== userId) {
      reply.code(404).send({ error: "parked_event_not_found" });
      return null;
    }
    const park = await deps.db.pendingPark.findUnique({ where: { parkedEventId } });
    if (!park || park.userId !== userId) {
      reply.code(409).send({ error: "no_pending_park" });
      return null;
    }
    return settlePark(deps, park, now());
  }

  // The one tap (FR-55): Pay on the walk-away prompt, or in the app. It
  // starts the session through POST /session/start's own path, for the
  // amount the driver was shown, at most once per park. Tapped before the
  // phone has left the car it only records the confirmation; the start
  // waits for the walk-away.
  app.post("/parked/:id/confirm", { preHandler: limit }, async (req, reply) => {
    const parsed = confirmBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const park = await ownPark(user.id, id, reply);
    if (!park) return;
    const at = now();

    if (park.status === "started") {
      // A retried tap: the same session, not a second one.
      const session = park.sessionId
        ? await deps.db.session.findUnique({ where: { id: park.sessionId } })
        : null;
      return {
        status: "started",
        sessionId: park.sessionId,
        expiresAt: session?.expiresAt ?? null,
        amountUsd:
          Math.round((Number(session?.amountUsd ?? 0) + Number(session?.feeUsd ?? 0)) * 100) / 100,
      };
    }
    if (park.status === "starting") {
      return reply.code(409).send({ error: "confirm_in_progress" });
    }

    const candidates = parkCandidates(park);
    const zoneId =
      parsed.data.zoneId ?? park.zoneId ?? (candidates.length === 1 ? candidates[0]!.zoneId : null);
    const waiting = ["at_car", "confirmed", "prompted", "declined"].includes(park.status);
    if (waiting && zoneId === null) {
      return reply.code(409).send({ error: "side_required" });
    }
    const candidate = candidates.find((c) => c.zoneId === zoneId);
    if (waiting && !candidate) {
      return reply.code(409).send({ error: "zone_not_offered" });
    }
    if (!waiting || !candidate) {
      // Cancelled, superseded, expired, free, failed, ended: a park that
      // is over is never paid from again.
      return reply.code(409).send({ error: "park_closed", status: park.status });
    }
    // What the driver was shown for this side: the walk-away prompt's
    // quote, or /parked's when they chose the side in the app.
    const prompted = park.quote as Quote | null;
    const quoted = prompted && prompted.zoneId === candidate.zoneId ? prompted : candidate.quote;
    // …and never more than the phone itself had on screen at the tap.
    const shown = {
      ...quoted,
      totalUsd: Math.min(quoted.totalUsd, parsed.data.shownTotalUsd ?? quoted.totalUsd),
    };
    const dryRun = deps.policy.effectiveDryRun();
    const confirmedRow = (early: boolean) =>
      deps.db.decision.create({
        data: {
          kind: "street_confirmed",
          inputs: {
            parkedEventId: id,
            zoneId: candidate.zoneId,
            mode: "tap",
            early,
            shown,
            quotedTotalUsd: quoted.totalUsd,
            parkStatus: park.status,
            leftCarAt: park.leftCarAt?.toISOString() ?? null,
            nearCarSince: park.nearSince?.toISOString() ?? null,
            dryRun,
            policyHash: deps.policy.hash(),
          },
          rule: early ? "confirmed_at_car" : "confirmed",
          outcome: { starts: early ? "walk_away" : "now" },
          userId: user.id,
          parkedEventId: id,
        },
      });

    // At the car: it never left, or it went away and its fixes have it
    // back within reach of the car right now.
    const backAtCar = park.leftCarAt !== null && park.farAt !== null && park.nearSince !== null;
    if (park.leftCarAt === null || backAtCar) {
      // The confirmation is kept and nothing is paid: the start waits for
      // the phone to leave (again).
      const early = {
        status: "confirmed",
        startsAt: "walk_away",
        zoneId: candidate.zoneId,
        quote: shown,
      };
      if (park.status === "confirmed" && park.zoneId === candidate.zoneId) return early;
      const moved = await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: park.status },
        data: {
          status: "confirmed",
          zoneId: candidate.zoneId,
          quote: shown,
          confirmedAt: at,
          ...(backAtCar ? { leftCarAt: null, farAt: null, nearSince: null } : {}),
        },
      });
      if (moved.count === 0) return reply.code(409).send({ error: "confirm_in_progress" });
      await confirmedRow(true);
      return early;
    }

    // Away from the car: this tap is the start. Only one request gets
    // past this line for a park, whatever is retried or raced.
    const won = await deps.db.pendingPark.updateMany({
      where: { id: park.id, status: park.status },
      data: {
        status: "starting",
        startingAt: at,
        zoneId: candidate.zoneId,
        quote: shown,
        confirmedAt: at,
      },
    });
    if (won.count === 0) return reply.code(409).send({ error: "confirm_in_progress" });
    await confirmedRow(false);
    const starting = (await deps.db.pendingPark.findUnique({ where: { id: park.id } }))!;
    const outcome = await startParkSession(deps, sessions.start, starting, {
      at,
      mode: "tap",
      trigger: "confirm",
    });
    switch (outcome.kind) {
      case "started":
        return { status: "started", ...outcome.body };
      case "free":
        return outcome.body;
      case "quote_changed":
        return reply.code(409).send({ error: "quote_changed", prompt: outcome.prompt });
      case "refused":
      case "failed":
        return reply.code(outcome.status).send(outcome.body);
    }
  });

  // "Not now": nothing is paid, and the park stops waiting.
  app.post("/parked/:id/decline", { preHandler: limit }, async (req, reply) => {
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const park = await ownPark(user.id, id, reply);
    if (!park) return;
    if (park.status === "declined") return { status: "declined" };
    if (park.status === "starting") return reply.code(409).send({ error: "confirm_in_progress" });
    if (!["at_car", "confirmed", "prompted"].includes(park.status)) {
      return reply.code(409).send({ error: "park_closed", status: park.status });
    }
    const moved = await deps.db.pendingPark.updateMany({
      where: { id: park.id, status: park.status },
      data: { status: "declined" },
    });
    if (moved.count === 0) return reply.code(409).send({ error: "confirm_in_progress" });
    const decision = await deps.db.decision.create({
      data: {
        kind: "street_declined",
        inputs: {
          parkedEventId: id,
          parkStatus: park.status,
          shown: park.quote,
          dryRun: deps.policy.effectiveDryRun(),
        },
        rule: "not_now",
        outcome: { status: "declined" },
        userId: user.id,
        parkedEventId: id,
      },
    });
    return { status: "declined", decisionId: decision.id };
  });

  // The driver's own answer for a park: what the place is (or that they
  // aren't parked there). It decides nothing and moves nothing; it is the
  // record the classifier is scored against, and the app writes its place
  // memory only once this has answered.
  app.post("/parked/:id/place", { preHandler: limit }, async (req, reply) => {
    const parsed = placeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const parkedEvent = await deps.db.parkedEvent.findUnique({ where: { id } });
    if (!parkedEvent || parkedEvent.userId !== user.id) {
      return reply.code(404).send({ error: "parked_event_not_found" });
    }
    const answer = parsed.data.class;
    const name = cleanPlaceName(parsed.data.name);

    const rows = (await deps.db.decision.findMany({ where: { parkedEventId: id } }))
      .filter((row) => row.userId === user.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const quoted = rows.find((row) => row.kind === "parked_quote");
    const classified = (quoted?.outcome as { place?: Record<string, unknown> } | undefined)?.place;
    const was =
      classified && typeof classified["class"] === "string"
        ? {
            class: classified["class"],
            confidence: classified["confidence"] ?? null,
            source: classified["source"] ?? null,
            garageId: classified["garageId"] ?? null,
            garageName: classified["garageName"] ?? null,
          }
        : null;
    const changed = answer !== was?.class;
    const respond = (decisionId: string) => ({
      ok: true,
      parkedEventId: id,
      class: answer,
      name,
      was,
      changed,
      decisionId,
    });

    // The same answer again (a retry, a second tap) is the same decision.
    const last = rows.filter((row) => row.kind === "place_confirmation").at(-1);
    const lastOutcome = last?.outcome as { class?: unknown; name?: unknown } | undefined;
    if (last && lastOutcome?.class === answer && (lastOutcome.name ?? null) === name) {
      return respond(last.id);
    }

    const decision = await deps.db.decision.create({
      data: {
        kind: "place_confirmation",
        inputs: {
          parkedEventId: id,
          class: answer,
          name,
          parkedDecisionId: quoted?.id ?? null,
          // What the classifier said and what it saw: with the driver's
          // answer beside it, this row is what the classifier is scored on.
          classified: classified ?? null,
          classification: (quoted?.inputs as { place?: unknown } | undefined)?.place ?? null,
          dryRun: deps.policy.effectiveDryRun(),
        },
        rule: confirmationRule(answer, was?.class ?? null),
        outcome: { class: answer, name, was: was?.class ?? null, changed },
        userId: user.id,
        parkedEventId: id,
      },
    });
    return respond(decision.id);
  });
}
