/**
 * The unified Activity ledger (GET /wallet/activity, and the Wallet's
 * "Activity" section): every way money moved or was asked to, newest
 * first, one shape per kind —
 *
 *  - session       a street meter session: place, duration, meter + fee,
 *                  status, what paid it, the explanation line, its receipt
 *                  (provider confirmation, ParkAgent-card holds), and the
 *                  timeline for the detail screen;
 *  - garage        a garage confirmed through the assistant and handed off
 *                  to the garage's own checkout, with its Link approval
 *                  state when Link paid it;
 *  - link_payment  a Link spend request not already shown on a garage row;
 *  - plan          a plan made in the assistant that isn't a garage row: a
 *                  street spot confirmed there (it pays when the car parks)
 *                  or a signed-off day.
 *
 * Garage and plan rows made in the assistant carry the conversation they
 * came from (`conversationId`, while that conversation is still saved), so
 * the app can open it.
 *
 * Pages are cursored by row creation time (opaque to clients, echoed back
 * as nextCursor), merged across the three sources, `limit` rows each.
 */

import type {
  AppDb,
  AssistantPlanRow,
  GarageBookingRow,
  ItineraryRow,
  LinkSpendRequestRow,
  SessionRow,
} from "../../db.js";
import type { ItineraryPlan, SingleSpotPlan } from "../assistant/plans.js";
import { providerForCity } from "../../providers/registry.js";
import { garageProviderInfo } from "../garage/garageProvider.js";

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

export type ActivityItem = SessionActivity | GarageActivity | LinkPaymentActivity | PlanActivity;

interface ActivityBase {
  /** Unique across kinds: "<kind>:<row id>". */
  id: string;
  kind: "session" | "garage" | "link_payment" | "plan";
  /** When it happened (a session's start; a booking's or request's creation). */
  at: string;
  /** The row's creation time — the page cursor's key. */
  createdAt: string;
}

export interface TimelineEntry {
  /** started | extended | stopped | expired | failed | free_period |
   * hold_placed | hold_captured | hold_released | hold_declined */
  kind: string;
  at: string;
  minutes: number | null;
  amountUsd: number | null;
  /** Executor or decline code on a failure. */
  code: string | null;
}

export interface SessionActivity extends ActivityBase {
  kind: "session";
  sessionId: string;
  city: string;
  cityDisplayName: string | null;
  providerDisplayName: string | null;
  zoneNumber: string;
  /** The zone's street as our data names it; null when unknown. */
  street: string | null;
  durationMinutes: number;
  meterUsd: number;
  feeUsd: number;
  totalUsd: number;
  /** pending | active | stopped | expired | failed | free_period */
  status: string;
  dryRun: boolean;
  /** provider_card | parkagent_card — what paid the meter. */
  paymentSource: string;
  /** One plain sentence: what happened and what paid for it. */
  explanation: string;
  startedAt: string | null;
  expiresAt: string | null;
  stoppedAt: string | null;
  lat: number | null;
  lng: number | null;
  receipt: {
    /** The provider's own session/confirmation id. */
    providerConfirmation: string | null;
    /** The session_start decision behind it (explain_decision). */
    decisionId: string | null;
    /** The ParkAgent card's holds, one per paid leg. */
    holds: {
      leg: string;
      heldUsd: number;
      capturedUsd: number | null;
      status: string;
      paymentIntentId: string | null;
    }[];
  };
  timeline: TimelineEntry[];
}

export interface GarageActivity extends ActivityBase {
  kind: "garage";
  bookingId: string;
  label: string;
  /** spothero | parkwhiz */
  provider: string | null;
  providerDisplayName: string | null;
  priceUsd: number;
  startsAt: string | null;
  endsAt: string | null;
  /** handed_off | planned */
  status: string;
  paymentSource: string;
  deepLink: string | null;
  /** Present when Link pays it: the approval state in Link's words
   * (pending_approval | approved | denied | expired | …). */
  link: { spendRequestId: string; status: string; approvalUrl: string | null } | null;
  receipt: { optionId: string; planId: string | null };
  /** The assistant conversation it was made in, while that is still saved. */
  conversationId: string | null;
}

export interface PlanActivity extends ActivityBase {
  kind: "plan";
  planId: string;
  /** street: a street spot confirmed in the assistant; itinerary: a day. */
  planKind: "street" | "itinerary";
  label: string;
  /** What the plan was priced at — NOT a charge: a street spot pays at the
   * curb (its session row carries the real amount), a day's garages are
   * their own rows. Never shown as money moved. */
  plannedUsd: number;
  /** One plain sentence about what happens next. */
  explanation: string;
  conversationId: string | null;
}

export interface LinkPaymentActivity extends ActivityBase {
  kind: "link_payment";
  spendRequestId: string;
  amountUsd: number;
  merchantName: string | null;
  /** Link's approval state. */
  status: string;
}

const round2 = (usd: number) => Math.round(usd * 100) / 100;

/** The one-line "why" a session row shows. Facts only — from the row, its
 * events, its holds, and the provider registry. */
export function sessionExplanation(args: {
  session: SessionRow;
  providerDisplayName: string | null;
  failureCode: string | null;
  holds: { status: string; capturedUsd: number | null; heldUsd: number }[];
  cardLast4: string | null;
}): string {
  const { session } = args;
  const provider = args.providerDisplayName ?? "your parking account";
  const extended =
    session.extendCount > 0
      ? ` Extended ${session.extendCount === 1 ? "once" : `${session.extendCount} times`}.`
      : "";
  switch (session.status) {
    case "free_period":
      return "Parking was free then — nothing to pay.";
    case "failed":
      if (args.failureCode === "card_declined") {
        return "Your card was declined — nothing was paid.";
      }
      if (args.failureCode === "wallet_not_ready" || args.failureCode === "hold_failed") {
        return "The ParkAgent card couldn't be funded — nothing was paid.";
      }
      return `Couldn't pay at ${provider}${failureReason(args.failureCode, provider)} — the meter was unpaid.`;
    case "pending":
      return `Paying at ${provider}…`;
  }
  if (session.dryRun) return `Dry run — nothing was charged.${extended}`;
  if (session.paymentSource === "parkagent_card") {
    const captured = round2(
      args.holds.reduce((sum, h) => sum + (h.status === "captured" ? (h.capturedUsd ?? 0) : 0), 0),
    );
    return captured > 0
      ? `Paid with the ParkAgent card — ${money(captured)} taken from your card, the rest of the hold released.${extended}`
      : `Paid with the ParkAgent card.${extended}`;
  }
  const card = args.cardLast4 ? ` ••${args.cardLast4}` : "";
  return `Paid with your card on ${provider}${card}.${extended}`;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** An executor failure in words (never the raw code): ": the card was
 * declined", or nothing when the code says nothing a person can use. */
function failureReason(code: string | null, provider: string): string {
  switch (code) {
    case "payment_declined":
      return `: the card saved there was declined`;
    case "payment_method_missing":
      return `: no card is saved on your ${provider} account`;
    case "auth_expired":
      return `: your ${provider} sign-in expired`;
    case "vehicle_missing":
      return `: your plate isn't on your ${provider} account`;
    case "zone_not_found":
      return `: it didn't recognize the zone`;
    case "parking_denied":
      return `: it's blocking re-parking there right now`;
    case "network":
      return `: it couldn't be reached`;
    default:
      return "";
  }
}

/** Same-instant entries in causal order: the hold comes before the leg it
 * funds, and settles after it. */
function timelineRank(kind: string): number {
  if (kind === "hold_placed" || kind === "hold_declined") return 0;
  if (kind === "hold_captured" || kind === "hold_released") return 2;
  return 1;
}

function parseCursor(cursor: string | undefined): Date | undefined {
  if (!cursor) return undefined;
  const at = new Date(cursor);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

export async function activityPage(
  db: AppDb,
  userId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<ActivityPage> {
  const before = parseCursor(options.cursor);
  const take = options.limit + 1;

  const [sessions, allBookings, linkRows, accounts, confirmedPlans] = await Promise.all([
    db.session.findMany({
      where: { userId, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    }),
    // Every booking (a person's handful): the page is cut from these, and
    // a Link request shown on ANY garage row is never listed on its own.
    db.garageBooking.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 1000 }),
    db.linkSpendRequest.findMany({ where: { userId } }),
    db.providerAccount.findMany({ where: { userId } }),
    db.assistantPlan.findMany({ where: { userId, confirmedAt: { not: null } } }),
  ]);
  // Plans that aren't garage rows already: a street spot — until the car
  // parks there and its session row takes over — or a day.
  const signedDays = new Map(
    (await db.itinerary.findMany({ where: { userId } }))
      .filter((i) => i.planId)
      .map((i) => [i.planId!, i]),
  );
  const planCandidates = confirmedPlans
    .filter((p) => p.confirmedAt && (p.kind === "itinerary" || confirmedStreet(p) !== null))
    .filter((p) => !before || p.confirmedAt! < before)
    .sort((a, b) => b.confirmedAt!.getTime() - a.confirmedAt!.getTime());
  const planRows: AssistantPlanRow[] = [];
  for (const plan of planCandidates) {
    if (planRows.length >= take) break;
    const street = confirmedStreet(plan);
    if (street?.zoneId) {
      const parked = await db.session.findMany({
        where: { userId, zoneId: street.zoneId, createdAt: { gte: plan.confirmedAt! } },
        take: 1,
      });
      if (parked.length > 0) continue;
    }
    planRows.push(plan);
  }
  const bookings = allBookings.filter((b) => !before || b.createdAt < before).slice(0, take);
  const onGarage = new Set(allBookings.map((b) => b.linkSpendRequestId).filter(Boolean));
  const standaloneLink = linkRows
    .filter((r) => !onGarage.has(r.id))
    .filter((r) => !before || r.createdAt < before)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, take);

  type Entry =
    | { createdAt: Date; kind: "session"; row: SessionRow }
    | { createdAt: Date; kind: "garage"; row: GarageBookingRow }
    | { createdAt: Date; kind: "link_payment"; row: LinkSpendRequestRow }
    | { createdAt: Date; kind: "plan"; row: AssistantPlanRow };
  const merged: Entry[] = [
    ...sessions.map((row) => ({ createdAt: row.createdAt, kind: "session" as const, row })),
    ...bookings.map((row) => ({ createdAt: row.createdAt, kind: "garage" as const, row })),
    ...standaloneLink.map((row) => ({
      createdAt: row.createdAt,
      kind: "link_payment" as const,
      row,
    })),
    ...planRows.map((row) => ({ createdAt: row.confirmedAt!, kind: "plan" as const, row })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const page = merged.slice(0, options.limit);
  const nextCursor =
    merged.length > options.limit ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null;

  // Everything the session rows need, batched for the page.
  const pageSessions = page.flatMap((e) => (e.kind === "session" ? [e.row] : []));
  const sessionIds = pageSessions.map((s) => s.id);
  const [events, holds, decisions] =
    sessionIds.length > 0
      ? await Promise.all([
          db.sessionEvent.findMany({
            where: { sessionId: { in: sessionIds } },
            orderBy: { at: "asc" },
          }),
          db.sessionHold.findMany({ where: { sessionId: { in: sessionIds } } }),
          db.decision.findMany({ where: { sessionId: { in: sessionIds } } }),
        ])
      : [[], [], []];
  const zoneStreets = new Map<string, string | null>();
  for (const s of pageSessions) {
    if (zoneStreets.has(s.zoneId)) continue;
    const zone = await db.zone.findUnique({ where: { zoneId: s.zoneId } });
    zoneStreets.set(s.zoneId, zone?.street ?? null);
  }
  const linkById = new Map(linkRows.map((r) => [r.id, r]));
  // The conversation each assistant row came from — linked only while it
  // is still saved (deleted, or past retention, it isn't).
  const planById = new Map(confirmedPlans.map((p) => [p.id, p]));
  const garagePlanIds = page.flatMap((e) =>
    e.kind === "garage" && e.row.planId ? [e.row.planId] : [],
  );
  const missingPlanIds = garagePlanIds.filter((id) => !planById.has(id));
  for (const id of missingPlanIds) {
    const plan = await db.assistantPlan.findUnique({ where: { id } });
    if (plan && plan.userId === userId) planById.set(id, plan);
  }
  const wantedConversations = [
    ...new Set(
      page.flatMap((e) => {
        const planId = e.kind === "garage" ? e.row.planId : e.kind === "plan" ? e.row.id : null;
        const conversationId = planId ? planById.get(planId)?.conversationId : undefined;
        return conversationId ? [conversationId] : [];
      }),
    ),
  ];
  const savedConversations = new Set(
    wantedConversations.length > 0
      ? (
          await db.conversation.findMany({
            where: { userId, id: { in: wantedConversations } },
          })
        ).map((c) => c.id)
      : [],
  );
  const conversationOf = (planId: string | null): string | null => {
    const id = planId ? planById.get(planId)?.conversationId : undefined;
    return id && savedConversations.has(id) ? id : null;
  };

  const items: ActivityItem[] = page.map((entry) => {
    if (entry.kind === "garage") {
      const b = entry.row;
      const link = b.linkSpendRequestId ? linkById.get(b.linkSpendRequestId) : undefined;
      return {
        id: `garage:${b.id}`,
        kind: "garage",
        at: b.createdAt.toISOString(),
        createdAt: b.createdAt.toISOString(),
        bookingId: b.id,
        label: b.label,
        provider: b.provider,
        providerDisplayName:
          garageProviderInfo(b.provider ?? undefined, b.deepLink ?? undefined)?.name ?? null,
        priceUsd: Number(b.priceUsd),
        startsAt: b.startsAt?.toISOString() ?? null,
        endsAt: b.endsAt?.toISOString() ?? null,
        status: b.status,
        paymentSource: b.paymentSource,
        deepLink: b.deepLink,
        link: b.linkSpendRequestId
          ? {
              spendRequestId: b.linkSpendRequestId,
              status: link?.status ?? "unknown",
              approvalUrl: link?.approvalUrl ?? null,
            }
          : null,
        receipt: { optionId: b.optionId, planId: b.planId },
        conversationId: conversationOf(b.planId),
      };
    }
    if (entry.kind === "plan") {
      return planActivity(entry.row, conversationOf(entry.row.id), signedDays.get(entry.row.id));
    }
    if (entry.kind === "link_payment") {
      const r = entry.row;
      return {
        id: `link:${r.id}`,
        kind: "link_payment",
        at: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        spendRequestId: r.id,
        amountUsd: Number(r.amountUsd),
        merchantName: r.merchantName ?? null,
        status: r.status,
      };
    }
    const s = entry.row;
    const provider = providerForCity(s.city);
    const account = provider ? accounts.find((a) => a.provider === provider.id) : undefined;
    const sEvents = events.filter((e) => e.sessionId === s.id);
    const sHolds = holds
      .filter((h) => h.sessionId === s.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const failure = [...sEvents].reverse().find((e) => e.kind === "failed");
    const failureCode =
      ((failure?.details as { code?: string } | null)?.code as string | undefined) ?? null;
    const startDecision = decisions
      .filter((d) => d.sessionId === s.id && d.kind === "session_start")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const meterUsd = round2(Number(s.amountUsd ?? 0));
    const feeUsd = round2(Number(s.feeUsd ?? 0));
    const timeline: TimelineEntry[] = [
      ...sEvents.map((e) => ({
        kind: e.kind,
        at: e.at.toISOString(),
        minutes: e.minutes ?? null,
        amountUsd:
          e.amountUsd === null || e.amountUsd === undefined
            ? null
            : round2(Number(e.amountUsd) + Number(e.feeUsd ?? 0)),
        code: ((e.details as { code?: string } | null)?.code as string | undefined) ?? null,
      })),
      ...sHolds.flatMap((h): TimelineEntry[] => {
        const placed: TimelineEntry = {
          kind: h.status === "declined" ? "hold_declined" : "hold_placed",
          at: h.createdAt.toISOString(),
          minutes: null,
          amountUsd: Number(h.amountUsd),
          code: h.declineCode,
        };
        if (h.status !== "captured" && h.status !== "released") return [placed];
        return [
          placed,
          {
            kind: h.status === "captured" ? "hold_captured" : "hold_released",
            at: (h.settledAt ?? h.createdAt).toISOString(),
            minutes: null,
            amountUsd: h.status === "captured" ? Number(h.capturedUsd ?? 0) : Number(h.amountUsd),
            code: null,
          },
        ];
      }),
    ].sort((a, b) => a.at.localeCompare(b.at) || timelineRank(a.kind) - timelineRank(b.kind));

    return {
      id: `session:${s.id}`,
      kind: "session",
      at: (s.startedAt ?? s.createdAt).toISOString(),
      createdAt: s.createdAt.toISOString(),
      sessionId: s.id,
      city: s.city,
      cityDisplayName: provider?.cityDisplayName ?? null,
      providerDisplayName: provider?.displayName ?? null,
      zoneNumber: s.providerZoneNumber,
      street: zoneStreets.get(s.zoneId) ?? null,
      durationMinutes: s.purchasedMinutes,
      meterUsd,
      feeUsd,
      totalUsd: round2(meterUsd + feeUsd),
      status: s.status,
      dryRun: s.dryRun,
      paymentSource: s.paymentSource ?? "provider_card",
      explanation: sessionExplanation({
        session: s,
        providerDisplayName: provider?.displayName ?? null,
        failureCode,
        holds: sHolds.map((h) => ({
          status: h.status,
          capturedUsd: h.capturedUsd === null ? null : Number(h.capturedUsd),
          heldUsd: Number(h.amountUsd),
        })),
        cardLast4: account?.cardLast4 ?? null,
      }),
      startedAt: s.startedAt?.toISOString() ?? null,
      expiresAt: s.expiresAt?.toISOString() ?? null,
      stoppedAt: s.stoppedAt?.toISOString() ?? null,
      lat: s.carLat,
      lng: s.carLng,
      receipt: {
        providerConfirmation: s.parknycConfirmation,
        decisionId: startDecision?.id ?? null,
        holds: sHolds.map((h) => ({
          leg: h.leg,
          heldUsd: Number(h.amountUsd),
          capturedUsd: h.capturedUsd === null ? null : Number(h.capturedUsd),
          status: h.status,
          paymentIntentId: h.paymentIntentId,
        })),
      },
      timeline,
    };
  });

  return { items, nextCursor };
}

/** A single-spot plan's confirmed option, when it is a street spot. */
function confirmedStreet(plan: AssistantPlanRow): { zoneId?: string | undefined } | null {
  if (plan.kind !== "single_spot") return null;
  const option = (plan.plan as SingleSpotPlan).options.find((o) => o.id === plan.confirmedOptionId);
  return option?.type === "street" ? option : null;
}

function planActivity(
  plan: AssistantPlanRow,
  conversationId: string | null,
  signed: ItineraryRow | undefined,
): PlanActivity {
  const at = plan.confirmedAt!.toISOString();
  if (plan.kind === "itinerary") {
    // What was signed off (the card's edits, re-priced), not what was
    // proposed; the proposal only when the day row is missing.
    const day = plan.plan as ItineraryPlan;
    const stops = signed ? (signed.stops as unknown[]).length : day.stops.length;
    return {
      id: `plan:${plan.id}`,
      kind: "plan",
      at,
      createdAt: at,
      planId: plan.id,
      planKind: "itinerary",
      label: `Day plan — ${stops} ${stops === 1 ? "stop" : "stops"}`,
      plannedUsd: round2(signed ? Number(signed.totalUsd) : day.totalUsd),
      explanation:
        "Signed off in the assistant. Street stops pay when you park; garage links arrive before each stop.",
      conversationId,
    };
  }
  const option = (plan.plan as SingleSpotPlan).options.find(
    (o) => o.id === plan.confirmedOptionId,
  )!;
  return {
    id: `plan:${plan.id}`,
    kind: "plan",
    at,
    createdAt: at,
    planId: plan.id,
    planKind: "street",
    label: option.street ?? option.label,
    plannedUsd: round2(option.priceUsd),
    explanation: "Chosen in the assistant — it pays when you park there.",
    conversationId,
  };
}
