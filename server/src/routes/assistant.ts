/**
 * The conversational assistant surface.
 *
 * POST /assistant/message   one turn of the tool-use loop (SSE when the
 *                           client sends Accept: text/event-stream)
 * POST /assistant/confirm   the user's tap on a plan card: mints the
 *                           single-use confirmation token and executes
 *                           the confirmed option THROUGH the token-gated
 *                           tools — the same enforcement the model faces
 * POST /assistant/plans/:planId/price   re-price an itinerary card's edited
 *                           stops on the server before sign-off
 * GET  /assistant/itineraries          today's / recent signed-off days
 * PATCH /assistant/itineraries/:id     edit or reorder stops (re-priced on
 *                           the server, cap re-checked)
 * GET  /assistant/conversations        saved conversations, newest first
 * GET  /assistant/conversations/:id    one, to read or resume
 * DELETE /assistant/conversations[/:id]  delete one, or all
 *
 * Every tool call and every confirmation writes a decisions row.
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { assistantSpendTodayUsd, runAssistantTurn } from "../services/assistant/loop.js";
import type { AssistantResult } from "../services/assistant/loop.js";
import {
  DEFAULT_RETENTION_DAYS,
  conversationOutcome,
  displayFromTurns,
  titleFromTurns,
} from "../services/assistant/history.js";
import type { DisplayEntry } from "../services/assistant/history.js";
import { CONFIRMATION_TTL_MS } from "../services/assistant/tools.js";
import type { PreviousStop, PricedStop, RepriceResult } from "../services/assistant/tools.js";
import {
  editedItineraryStopSchema,
  itineraryTotalUsd,
  orderStopsByArrival,
} from "../services/assistant/plans.js";
import type { ItineraryPlan, SingleSpotPlan } from "../services/assistant/plans.js";
import { garageHandoffNote, garageProviderInfo } from "../services/garage/garageProvider.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import { nycStartOfDay, parseEasternTime } from "../services/hours.js";
import { LINK_PENDING_STATUSES, linkSpentSince } from "../services/link/linkSpend.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import { spentToday } from "../services/sessions.js";
import { normalizeSource } from "../services/wallet/summary.js";

/** A plan time (offset honored, offset-less read as ET wall clock). */
function parseStart(value: string): Date | null {
  return parseEasternTime(value);
}

function endOf(start: Date | null, minutes: number): Date | null {
  return start ? new Date(start.getTime() + minutes * 60_000) : null;
}

const messageSchema = z
  .object({
    text: z.string().min(1).max(2000).optional(),
    transcript: z.string().min(1).max(2000).optional(),
    conversation_id: z.string().max(64).optional(),
    location: z
      .object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) })
      .optional(),
  })
  .refine((b) => b.text !== undefined || b.transcript !== undefined, {
    message: "text or transcript is required",
  });

const editedStopsSchema = z.array(editedItineraryStopSchema).min(1).max(12);

const confirmSchema = z.object({
  planId: z.string().min(1),
  /** Single-spot plans confirm one option; itineraries sign off whole. */
  optionId: z.string().optional(),
  /** Itineraries: the stops as the user left them on the card. Re-priced
   * on the server (their costs are never read) and signed off in arrival
   * order; absent → the plan's own stops. */
  stops: editedStopsSchema.optional(),
});

const patchItinerarySchema = z.object({
  stops: editedStopsSchema,
});

const priceSchema = z.object({
  stops: editedStopsSchema,
});

const conversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** The previous page's nextCursor (an updatedAt, opaque to clients). */
  cursor: z.string().max(64).optional(),
});

type EditedStops = z.infer<typeof editedStopsSchema>;

/** A plan's or a stored day's stops, by id — the server's own versions. */
function stopsById(stops: unknown): Map<string, PreviousStop> {
  return new Map(
    ((stops ?? []) as PreviousStop[])
      .filter((s) => typeof s.id === "string")
      .map((s) => [s.id!, s]),
  );
}

/** Edited stops the server can't take: an id the plan doesn't have, or a
 * time that doesn't read (it would silently order as "no set time"). */
function editedStopsProblem(
  stops: EditedStops,
  known: ReadonlyMap<string, PreviousStop> | null,
): { error: string; stopId: string; value?: unknown } | null {
  if (known) {
    const unknown = stops.find((s) => !known.has(s.id));
    if (unknown) return { error: "unknown_stop", stopId: unknown.id };
  }
  const unreadable = stops.find((s) => s.arrival && !parseEasternTime(s.arrival));
  if (unreadable) {
    return { error: "unreadable_time", stopId: unreadable.id, value: unreadable.arrival };
  }
  return null;
}

/** What a re-price did, for the decision row. */
function repriceAudit(result: RepriceResult) {
  return {
    repriced: result.repriced,
    estimates: result.estimates,
    costs: Object.fromEntries(result.stops.map((s) => [s.id, s.costUsd])),
  };
}

/**
 * Who a Link spend request says the user is paying: the garage's own site
 * for a garage (the one its offer came from — a merged search means it
 * isn't always SpotHero), the city's meter app for a street spot. The
 * approval screen shows this to the user, so it must name the real payee.
 */
function merchantFor(stop: {
  type: "street" | "garage";
  zoneId?: string | undefined;
  provider?: string | undefined;
  deepLink?: string | undefined;
}): { merchantName: string; merchantUrl: string } {
  if (stop.type === "garage") {
    const garage = garageProviderInfo(stop.provider, stop.deepLink);
    return {
      merchantName: garage?.name ?? "Garage parking",
      merchantUrl: stop.deepLink ?? garage?.url ?? "https://www.parkagent.app",
    };
  }
  const meters = stop.zoneId ? providerForCity(cityForZone(stop.zoneId)) : null;
  return {
    merchantName: meters?.displayName ?? "City parking meters",
    merchantUrl: meters ? new URL(meters.loginUrl).origin : "https://www.parkagent.app",
  };
}

function sseWrite(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerAssistant(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();
  // Each turn is a paid model call; a runaway client shouldn't buy 500.
  const limitMessages = makeRateLimiter({ max: 20, windowMs: 60_000 });
  const limitOther = makeRateLimiter({ max: 60, windowMs: 60_000 });

  app.post("/assistant/message", { preHandler: limitMessages }, async (req, reply) => {
    if (!deps.assistantModel || !deps.assistantTools) {
      return reply.code(503).send({ error: "assistant_not_configured" });
    }
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const conversationId = body.conversation_id ?? `conv_${randomUUID()}`;
    const text = (body.text ?? body.transcript)!;

    // Someone else's conversation id: the turn would be saved over their
    // transcript (the upsert keys on id alone), and that transcript is
    // what the next turn's grounding is read from. Refuse before any
    // paid call.
    if (body.conversation_id !== undefined) {
      const existing = await deps.db.conversation.findUnique({ where: { id: conversationId } });
      if (existing && existing.userId !== user.id) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
    }

    // Per-user daily model-spend cap (estimated from logged token usage).
    // Checked before the paid call, refused with the numbers on record.
    if (deps.assistantDailySpendCapUsd !== undefined) {
      const spentUsd = await assistantSpendTodayUsd(deps.db, user.id, now());
      if (spentUsd >= deps.assistantDailySpendCapUsd) {
        await deps.db.decision.create({
          data: {
            kind: "assistant_turn",
            inputs: { conversationId },
            rule: "daily_spend_cap",
            outcome: {
              refused: true,
              spentUsd: Math.round(spentUsd * 10_000) / 10_000,
              capUsd: deps.assistantDailySpendCapUsd,
              estimatedCostUsd: 0,
            },
            userId: user.id,
          },
        });
        return reply.code(429).send({
          error: "assistant_budget_exhausted",
          spentUsd: Math.round(spentUsd * 100) / 100,
          capUsd: deps.assistantDailySpendCapUsd,
        });
      }
    }

    const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
    let result: AssistantResult;
    if (wantsStream) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      try {
        result = await runAssistantTurn({
          db: deps.db,
          model: deps.assistantModel,
          tools: deps.assistantTools,
          userId: user.id,
          conversationId,
          text,
          location: body.location,
          onText: (delta) => sseWrite(reply, "text", { delta }),
          // The plan gets its own event the moment propose_plan lands, so
          // the card renders before the reply text settles.
          onPlan: (plan) => sseWrite(reply, "plan", plan),
          now: deps.now,
        });
        sseWrite(reply, "done", {
          conversationId: result.conversationId,
          reply: result.reply,
          plan: result.plan,
          suggestions: result.suggestions,
        });
      } catch (err) {
        req.log.error(
          { assistantError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
          "assistant turn failed",
        );
        sseWrite(reply, "error", { error: "assistant_failed" });
      }
      reply.raw.end();
      return reply;
    }

    result = await runAssistantTurn({
      db: deps.db,
      model: deps.assistantModel,
      tools: deps.assistantTools,
      userId: user.id,
      conversationId,
      text,
      location: body.location,
      now: deps.now,
    });
    return {
      conversationId: result.conversationId,
      reply: result.reply,
      plan: result.plan,
      suggestions: result.suggestions,
    };
  });

  app.post("/assistant/confirm", { preHandler: limitOther }, async (req, reply) => {
    if (!deps.assistantTools) {
      return reply.code(503).send({ error: "assistant_not_configured" });
    }
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const at = now();
    const planRow = await deps.db.assistantPlan.findUnique({ where: { id: parsed.data.planId } });
    if (!planRow || planRow.userId !== user.id) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    // Itinerary edits made on the card come with the sign-off. They are
    // priced here, on the server — never at the prices the phone sends —
    // before anything is minted.
    let edited: RepriceResult | null = null;
    if (planRow.kind === "itinerary" && parsed.data.stops) {
      const proposed = stopsById((planRow.plan as ItineraryPlan).stops);
      const problem = editedStopsProblem(parsed.data.stops, proposed);
      if (problem) return reply.code(400).send(problem);
      edited = await deps.assistantTools.repriceStops(parsed.data.stops, proposed);
    }

    // A future street option has nothing to confirm — the detector pays
    // when the car parks there. Refuse BEFORE minting anything.
    if (planRow.kind === "single_spot" && parsed.data.optionId !== undefined) {
      const plan = planRow.plan as SingleSpotPlan;
      const option = plan.options.find((o) => o.id === parsed.data.optionId);
      if (option?.type === "street" && option.payOnArrival === true) {
        await deps.db.decision.create({
          data: {
            kind: "assistant_confirm",
            inputs: { planId: planRow.id, optionId: option.id },
            rule: "street_pay_on_arrival",
            outcome: { allowed: false },
            userId: user.id,
          },
        });
        return reply.code(409).send({ error: "street_pay_on_arrival" });
      }
    }

    // The tap IS the authorization: mint the single-use token here and
    // nowhere else, then run the consequential tool through the same
    // gate the model faces.
    const token = randomBytes(24).toString("base64url");
    await deps.db.assistantConfirmation.create({
      data: {
        token,
        userId: user.id,
        planId: planRow.id,
        optionId: parsed.data.optionId ?? null,
        expiresAt: new Date(at.getTime() + CONFIRMATION_TTL_MS),
      },
    });
    // What the cap checks below saw, filled in once measured.
    const spendInputs: Record<string, number> = {};
    const decide = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: {
          kind: "assistant_confirm",
          inputs: {
            planId: planRow.id,
            optionId: parsed.data.optionId ?? null,
            kind: planRow.kind,
            ...spendInputs,
          },
          rule,
          outcome,
          userId: user.id,
        },
      });
    const ctx = { userId: user.id, conversationId: planRow.conversationId };
    // What the tap did, on the plan: the history list and Activity show
    // the booking or plan a conversation came to.
    const markConfirmed = (planId: string, optionId: string | null) =>
      deps.db.assistantPlan.update({
        where: { id: planId },
        data: { confirmedAt: at, confirmedOptionId: optionId },
      });

    // How this confirm pays. The user's Wallet source decides:
    //  - street meters: the card on their provider account, or the
    //    ParkAgent card (paid at the curb through /session/start). Link
    //    never pays a street meter — see linkWallet.ts.
    //  - garages: Link when it's the active source (one spend request per
    //    paid garage stop, approved in Link, used at the garage's own
    //    checkout); otherwise the user pays at that checkout themselves.
    const userRow = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    const activeSource = normalizeSource(userRow?.paymentSource);
    const streetSource = activeSource === "parkagent_card" ? "parkagent_card" : "provider_card";
    const policy = deps.policy.get();
    const dryRun = deps.policy.effectiveDryRun();
    const linkActive =
      activeSource === "link_wallet" &&
      deps.linkWallet?.configured === true &&
      policy.link_wallet_for_plans !== false &&
      (await deps.linkWallet.status(user.id)).connected;
    // A spend request becomes a spendable card once approved, so it is a
    // money path: never under dry run unless Link itself is in test mode
    // (test requests carry test:true and can't charge).
    const linkBlockedByDryRun = linkActive && dryRun && deps.linkWallet?.testMode !== true;
    // Today's spend, whatever paid (approved Link garages included).
    const spentTodayUsd = await spentToday(deps.db, user.id, at);
    // Requests still awaiting approval become spend the moment the user
    // approves them, so they hold their room too: two confirms can't each
    // fit the cap and together pass it.
    const linkPendingTodayUsd = linkActive
      ? await linkSpentSince(deps.db, user.id, nycStartOfDay(at), LINK_PENDING_STATUSES)
      : 0;
    Object.assign(spendInputs, {
      spentTodayUsd,
      ...(linkActive ? { linkPendingTodayUsd } : {}),
    });

    /**
     * Whether Link may be asked for one spend request per amount in
     * `stopsUsd` right now, and why not. Each request is one purchase, so
     * each is held to the per-session cap on its own; the plan as a whole
     * (`planTotalUsd`, every stop whatever pays it) has to fit what is left
     * of today's cap. The sum is never held to the per-session cap — two
     * $30 garages are two purchases, not one $60 one.
     */
    const linkGate = (stopsUsd: number[], planTotalUsd: number): string | null => {
      if (!linkActive) return "link_not_active";
      if (!stopsUsd.some((usd) => usd > 0)) return "free";
      if (linkBlockedByDryRun) return "dry_run";
      if (stopsUsd.some((usd) => usd > policy.session_cap_usd)) return "session_cap_exceeded";
      if (spentTodayUsd + linkPendingTodayUsd + planTotalUsd > policy.daily_cap_usd) {
        return "daily_cap_exceeded";
      }
      return null;
    };

    if (planRow.kind === "single_spot") {
      const plan = planRow.plan as SingleSpotPlan;
      const option = plan.options.find((o) => o.id === parsed.data.optionId);
      if (!option) {
        await decide("unknown_option", { allowed: false });
        return reply.code(400).send({ error: "unknown_option" });
      }

      if (option.type === "garage") {
        // Link leg: one spend request for this garage, approved by the user
        // at the returned URL. A refusal (dry run, a cap) or a failure to
        // create one never blocks the handoff — the user can still pay at
        // the garage's checkout — and the response says why.
        let linkApproval: { spendRequestId: string; approvalUrl: string | null } | null = null;
        let linkSkipped: string | null =
          activeSource === "link_wallet" ? linkGate([option.priceUsd], option.priceUsd) : null;
        if (activeSource === "link_wallet" && linkSkipped === null) {
          try {
            const created = await deps.linkWallet!.createSpendRequestsForStops(user.id, {
              planId: planRow.id,
              stops: [
                {
                  stopId: option.id,
                  label: option.label,
                  amountUsd: option.priceUsd,
                  ...merchantFor(option),
                },
              ],
            });
            linkApproval = created[0]
              ? { spendRequestId: created[0].spendRequestId, approvalUrl: created[0].approvalUrl }
              : null;
          } catch (err) {
            linkSkipped = "link_failed";
            req.log.warn(
              { linkError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
              "link spend request failed; the garage's own checkout still works",
            );
          }
        }
        const paymentSource = linkApproval ? "link_wallet" : "garage_checkout";

        const outcome = await deps.assistantTools.execute(ctx, "book_garage", {
          option_id: option.garageOptionId ?? option.id,
          confirmation_token: token,
        });
        const booked = outcome.result as { deepLink?: string | null; error?: string };
        const cacheExpired =
          booked.error !== undefined && booked.error !== "needs_confirmation" && !!option.deepLink;
        if (booked.error && !cacheExpired) {
          await decide("book_failed", { allowed: true, error: booked.error });
          return reply.code(409).send({ error: "book_failed", detail: booked.error });
        }
        // The provider's search cache expires (10 min, per process); the
        // stored plan's own deepLink still hands the user off.
        const deepLink = cacheExpired
          ? option.deepLink!
          : (booked.deepLink ?? option.deepLink ?? null);
        const booking = await deps.db.garageBooking.create({
          data: {
            userId: user.id,
            planId: planRow.id,
            optionId: option.id,
            provider: option.provider ?? null,
            label: option.label,
            priceUsd: option.priceUsd,
            startsAt: option.startsAt ? parseStart(option.startsAt) : null,
            endsAt: option.startsAt
              ? endOf(parseStart(option.startsAt), option.durationMinutes)
              : null,
            deepLink,
            paymentSource: activeSource,
            linkSpendRequestId: linkApproval?.spendRequestId ?? null,
            status: "handed_off",
          },
        });
        await markConfirmed(planRow.id, option.id);
        await decide("garage_confirmed", {
          allowed: true,
          optionId: option.id,
          paymentSource,
          activeSource,
          ...(cacheExpired ? { cacheExpired: true } : {}),
          bookingId: booking.id,
          linkSpendRequestId: linkApproval?.spendRequestId ?? null,
          ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
        });
        return {
          kind: "garage_handoff",
          deepLink,
          paymentSource,
          linkApproval,
          ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
          bookingId: booking.id,
          note: garageHandoffNote(option.provider, option.deepLink),
        };
      }

      const outcome = await deps.assistantTools.execute(ctx, "start_session", {
        zone: option.zoneId ?? "",
        duration_minutes: option.durationMinutes,
        confirmation_token: token,
      });
      const confirmed = outcome.result as { error?: string; zoneId?: string };
      if (confirmed.error) {
        await decide("start_failed", { allowed: true, error: confirmed.error });
        return reply.code(409).send({ error: "start_failed", detail: confirmed.error });
      }
      await markConfirmed(planRow.id, option.id);
      await decide("street_confirmed", {
        allowed: true,
        optionId: option.id,
        zoneId: option.zoneId,
        paymentSource: streetSource,
        activeSource,
      });
      // The pay-by-app number, so the client can show something the user
      // can verify against the posted sign — zoneId is an internal slug
      // and must never surface in chat copy.
      const zoneRow = option.zoneId
        ? await deps.db.zone.findUnique({ where: { zoneId: option.zoneId } })
        : null;
      return {
        kind: "street_confirmed",
        zoneId: option.zoneId,
        providerZoneNumber: zoneRow?.providerZoneNumber || null,
        durationMinutes: option.durationMinutes,
        paymentSource: streetSource,
        linkApproval: null,
      };
    }

    // Itinerary sign-off: the whole day at once. Re-check the cap at the
    // moment of truth — spend may have moved since the proposal, and the
    // card's edits were just re-priced — with the SERVER's totals.
    const plan = planRow.plan as ItineraryPlan;
    const signedStops: (ItineraryPlan["stops"][number] | PricedStop)[] = edited
      ? orderStopsByArrival(edited.stops)
      : plan.stops;
    const totalUsd = itineraryTotalUsd(signedStops);
    if (spentTodayUsd + totalUsd > policy.daily_cap_usd) {
      await decide("over_daily_cap", {
        allowed: false,
        totalUsd,
        spentTodayUsd,
        ...(edited ? repriceAudit(edited) : {}),
      });
      return reply.code(409).send({
        error: "over_daily_cap",
        totalUsd,
        spentTodayUsd,
        capUsd: policy.daily_cap_usd,
      });
    }
    const itineraryId = randomUUID();
    // Link approves each paid GARAGE stop (no batch approval exists);
    // street stops pay at the curb with the street source.
    let approvals: { stopId: string; spendRequestId: string; approvalUrl: string | null }[] = [];
    let linkSkipped: string | null = null;
    if (activeSource === "link_wallet") {
      const paidGarages = signedStops.filter((s) => s.choice === "garage" && s.costUsd > 0);
      linkSkipped =
        paidGarages.length === 0
          ? null
          : linkGate(
              paidGarages.map((s) => s.costUsd),
              totalUsd,
            );
      if (linkSkipped === "free") linkSkipped = null;
      if (linkSkipped === null && paidGarages.length > 0) {
        try {
          approvals = await deps.linkWallet!.createSpendRequestsForStops(user.id, {
            planId: planRow.id,
            itineraryId,
            stops: paidGarages.map((s) => ({
              stopId: s.id,
              label: s.label,
              amountUsd: s.costUsd,
              ...merchantFor({
                type: s.choice,
                zoneId: s.zoneId,
                ...(s.deepLink ? { deepLink: s.deepLink } : {}),
              }),
            })),
          });
        } catch (err) {
          linkSkipped = "link_failed";
          req.log.warn(
            { linkError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
            "link spend requests failed; garage stops fall back to their own checkout",
          );
          approvals = [];
        }
      }
    }
    const stopSource = (s: { id: string; choice: "street" | "garage" }) =>
      s.choice === "street"
        ? streetSource
        : approvals.some((a) => a.stopId === s.id)
          ? "link_wallet"
          : "garage_checkout";
    await deps.db.itinerary.create({
      data: {
        id: itineraryId,
        userId: user.id,
        planId: planRow.id,
        status: "signed_off",
        date: new Date(plan.date),
        stops: signedStops.map((s) => ({
          ...s,
          sessionId: null,
          garageLinkPushedAt: null,
          paymentSource: stopSource(s),
        })),
        totalUsd,
      },
    });
    for (const s of signedStops.filter((stop) => stop.choice === "garage")) {
      const arrival = s.arrival ? parseStart(s.arrival) : null;
      await deps.db.garageBooking.create({
        data: {
          userId: user.id,
          planId: planRow.id,
          itineraryId,
          optionId: s.id,
          provider: garageProviderInfo(undefined, s.deepLink)?.id ?? null,
          label: s.label,
          priceUsd: s.costUsd,
          startsAt: arrival,
          endsAt: arrival ? endOf(arrival, s.durationMinutes) : null,
          deepLink: s.deepLink ?? null,
          paymentSource: activeSource,
          linkSpendRequestId: approvals.find((a) => a.stopId === s.id)?.spendRequestId ?? null,
          status: "planned",
        },
      });
    }
    await markConfirmed(planRow.id, null);
    await decide("itinerary_signed_off", {
      allowed: true,
      itineraryId,
      totalUsd,
      stops: signedStops.length,
      ...(edited ? repriceAudit(edited) : {}),
      activeSource,
      linkApprovals: approvals.length,
      ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
    });
    return {
      kind: "itinerary_signed_off",
      itineraryId,
      totalUsd,
      capUsd: policy.daily_cap_usd,
      stops: signedStops,
      paymentSource: activeSource,
      linkApprovals: approvals,
      ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
    };
  });

  // The card's live price: every edit (a new time, a longer stay, street
  // vs garage, a cleared time) is priced here, on the server, the way
  // build_itinerary priced the plan — so the day total and the cap check
  // the user sees before signing off are the server's, not the phone's.
  app.post("/assistant/plans/:planId/price", { preHandler: limitOther }, async (req, reply) => {
    if (!deps.assistantTools) {
      return reply.code(503).send({ error: "assistant_not_configured" });
    }
    const parsed = priceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const { planId } = req.params as { planId: string };
    const planRow = await deps.db.assistantPlan.findUnique({ where: { id: planId } });
    if (!planRow || planRow.userId !== user.id) {
      return reply.code(404).send({ error: "plan_not_found" });
    }
    if (planRow.kind !== "itinerary") {
      return reply.code(400).send({ error: "not_an_itinerary" });
    }
    const proposed = stopsById((planRow.plan as ItineraryPlan).stops);
    const problem = editedStopsProblem(parsed.data.stops, proposed);
    if (problem) return reply.code(400).send(problem);

    const result = await deps.assistantTools.repriceStops(parsed.data.stops, proposed);
    const stops = orderStopsByArrival(result.stops);
    const totalUsd = itineraryTotalUsd(stops);
    const spentTodayUsd = await spentToday(deps.db, user.id, now());
    const capUsd = deps.policy.get().daily_cap_usd;
    const fitsCap = spentTodayUsd + totalUsd <= capUsd;
    await deps.db.decision.create({
      data: {
        kind: "assistant_confirm",
        inputs: { planId, stops: stops.length, spentTodayUsd },
        rule: "itinerary_repriced",
        outcome: { totalUsd, capUsd, fitsCap, ...repriceAudit(result) },
        userId: user.id,
      },
    });
    return {
      planId,
      stops,
      totalUsd,
      capUsd,
      spentTodayUsd,
      remainingUsd: Math.max(0, Math.round((capUsd - spentTodayUsd) * 100) / 100),
      fitsCap,
    };
  });

  app.get("/assistant/itineraries", { preHandler: limitOther }, async (req) => {
    const user = req.authedUser!;
    const rows = await deps.db.itinerary.findMany({ where: { userId: user.id } });
    return {
      itineraries: rows
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 10)
        .map((r) => ({
          id: r.id,
          status: r.status,
          date: r.date.toISOString(),
          // Arrival order (untimed stops where the user put them), even
          // for a day stored before the rule existed.
          stops: orderStopsByArrival(r.stops as { arrival?: string | null }[]),
          totalUsd: Number(r.totalUsd),
        })),
    };
  });

  app.patch("/assistant/itineraries/:id", { preHandler: limitOther }, async (req, reply) => {
    const parsed = patchItinerarySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const row = await deps.db.itinerary.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) {
      return reply.code(404).send({ error: "itinerary_not_found" });
    }
    if (row.status !== "signed_off") {
      return reply.code(409).send({ error: "itinerary_not_editable", status: row.status });
    }
    // A time is either cleared (null — "no set time") or readable: an
    // unreadable one would silently order as untimed and never trigger
    // the worker's garage push. (A stop new to the day is allowed.)
    const problem = editedStopsProblem(parsed.data.stops, null);
    if (problem) return reply.code(400).send(problem);
    // Priced against the STORED day: an unchanged stop keeps its stored
    // price, a changed one is re-quoted; the phone's costs are never read.
    const storedById = stopsById(row.stops);
    const priced = await deps.assistantTools!.repriceStops(parsed.data.stops, storedById);
    const totalUsd = itineraryTotalUsd(priced.stops);
    const spentTodayUsd = await spentToday(deps.db, user.id, now());
    const policy = deps.policy.get();
    if (spentTodayUsd + totalUsd > policy.daily_cap_usd) {
      await deps.db.decision.create({
        data: {
          kind: "assistant_confirm",
          inputs: { itineraryId: id, edit: true, spentTodayUsd },
          rule: "over_daily_cap",
          outcome: {
            allowed: false,
            totalUsd,
            capUsd: policy.daily_cap_usd,
            ...repriceAudit(priced),
          },
          userId: user.id,
        },
      });
      return reply.code(409).send({
        error: "over_daily_cap",
        totalUsd,
        spentTodayUsd,
        capUsd: policy.daily_cap_usd,
      });
    }
    // Preserve per-stop linkage (sessions, pushes, payment source) for
    // stops that survive the edit, keyed by stop id.
    const previous = new Map(
      (row.stops as Record<string, unknown>[]).map((s) => [String(s["id"]), s]),
    );
    // A stop new to the day pays like a fresh one: street with the user's
    // street source, a garage at its own checkout (no Link request exists
    // for it).
    const userRow = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    const streetSource =
      normalizeSource(userRow?.paymentSource) === "parkagent_card"
        ? "parkagent_card"
        : "provider_card";
    // Stored in the one canonical form sign-off uses (ET with its offset,
    // repriceStops returns it so), and in arrival order — the same rule
    // the app displays with, so a client can't store a later stop above an
    // earlier one. A re-priced garage stop has a new window (and maybe a
    // new link), so its link is pushed again before the new arrival.
    const stops = orderStopsByArrival(priced.stops).map((s) => ({
      ...s,
      sessionId: previous.get(s.id)?.["sessionId"] ?? null,
      garageLinkPushedAt:
        s.choice === "garage" && priced.repriced.includes(s.id)
          ? null
          : (previous.get(s.id)?.["garageLinkPushedAt"] ?? null),
      paymentSource:
        previous.get(s.id)?.["paymentSource"] ??
        (s.choice === "street" ? streetSource : "garage_checkout"),
    }));
    await deps.db.itinerary.update({ where: { id }, data: { stops, totalUsd } });
    await deps.db.decision.create({
      data: {
        kind: "assistant_confirm",
        inputs: {
          itineraryId: id,
          edit: true,
          stops: stops.length,
          untimedStops: stops.filter((s) => s.arrival === null).length,
        },
        rule: "itinerary_edited",
        outcome: { totalUsd, ...repriceAudit(priced) },
        userId: user.id,
      },
    });
    return { id, stops, totalUsd, capUsd: policy.daily_cap_usd };
  });

  // Saved conversations (services/assistant/history.ts). Newest first,
  // titled by the first request, with what each came to; open one to read
  // it or keep going (POST /assistant/message with its id), delete one or
  // all. Kept for deps.conversationRetentionDays (90 by default), then the
  // retention job deletes them.
  app.get("/assistant/conversations", { preHandler: limitOther }, async (req, reply) => {
    const parsed = conversationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const before = parsed.data.cursor ? new Date(parsed.data.cursor) : null;
    const rows = await deps.db.conversation.findMany({
      where: {
        userId: user.id,
        ...(before && !Number.isNaN(before.getTime()) ? { updatedAt: { lt: before } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: parsed.data.limit + 1,
    });
    const page = rows.slice(0, parsed.data.limit);
    const plans =
      page.length > 0
        ? await deps.db.assistantPlan.findMany({
            where: { userId: user.id, conversationId: { in: page.map((r) => r.id) } },
          })
        : [];
    return {
      conversations: page.map((row) => {
        const display = displayOf(row);
        return {
          id: row.id,
          title: row.title ?? titleFromTurns(row.turns) ?? "Conversation",
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          messageCount: display.length,
          outcome: conversationOutcome(plans.filter((p) => p.conversationId === row.id)),
        };
      }),
      nextCursor:
        rows.length > parsed.data.limit
          ? (page[page.length - 1]?.updatedAt.toISOString() ?? null)
          : null,
      retentionDays: deps.conversationRetentionDays ?? DEFAULT_RETENTION_DAYS,
    };
  });

  app.get("/assistant/conversations/:id", { preHandler: limitOther }, async (req, reply) => {
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const row = await deps.db.conversation.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) {
      return reply.code(404).send({ error: "conversation_not_found" });
    }
    const plans = await deps.db.assistantPlan.findMany({
      where: { userId: user.id, conversationId: { in: [row.id] } },
    });
    return {
      id: row.id,
      title: row.title ?? titleFromTurns(row.turns) ?? "Conversation",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messages: displayOf(row),
      plans: plans
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((p) => ({
          planId: p.id,
          plan: p.plan,
          confirmedAt: p.confirmedAt?.toISOString() ?? null,
          confirmedOptionId: p.confirmedOptionId,
        })),
      outcome: conversationOutcome(plans),
    };
  });

  app.delete("/assistant/conversations/:id", { preHandler: limitOther }, async (req, reply) => {
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const { count } = await deps.db.conversation.deleteMany({ where: { id, userId: user.id } });
    if (count === 0) return reply.code(404).send({ error: "conversation_not_found" });
    await deps.db.decision.create({
      data: {
        kind: "assistant_history",
        inputs: { conversationId: id },
        rule: "conversation_deleted",
        outcome: { deleted: count },
        userId: user.id,
      },
    });
    return { deleted: count };
  });

  app.delete("/assistant/conversations", { preHandler: limitOther }, async (req) => {
    const user = req.authedUser!;
    const { count } = await deps.db.conversation.deleteMany({ where: { userId: user.id } });
    await deps.db.decision.create({
      data: {
        kind: "assistant_history",
        inputs: { all: true },
        rule: "conversations_deleted",
        outcome: { deleted: count },
        userId: user.id,
      },
    });
    return { deleted: count };
  });
}

/** A conversation's readable transcript: its own, or — saved before the
 * transcript existed — rebuilt from what its model context still holds. */
function displayOf(row: { display: unknown; turns: unknown }): DisplayEntry[] {
  return Array.isArray(row.display) && row.display.length > 0
    ? (row.display as DisplayEntry[])
    : displayFromTurns(row.turns);
}
