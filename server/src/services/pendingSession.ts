/**
 * "Does this user have a session awaiting payment right now?" — the
 * question the issuing webhook asks before approving an authorization.
 * True when the user has a pending or active session that started (or,
 * while still pending, was created) within the last 10 minutes — the
 * window in which the executor's ParkNYC charge should arrive.
 */

import type { AppDb, PendingParkRow } from "../db.js";
import { cityForZone, providerForCity, providerStatusUsable } from "../providers/registry.js";
import { easternWallClock } from "./hours.js";
import { policyFor } from "./limits.js";
import type { Policy } from "./policy.js";
import type { Quote, ZoneTerms } from "./quote.js";
import { quoteZone } from "./quote.js";
import { spentToday } from "./sessions.js";

export type PendingSessionCheck = (userId: string, at: Date) => Promise<boolean>;

export const PENDING_SESSION_WINDOW_MINUTES = 10;

export function makePendingSessionCheck(db: AppDb): PendingSessionCheck {
  return async (userId, at) => {
    const cutoff = new Date(at.getTime() - PENDING_SESSION_WINDOW_MINUTES * 60_000);
    const rows = await db.session.findMany({
      where: { userId, status: { in: ["pending", "active"] } },
    });
    return rows.some((s) => (s.startedAt ?? s.createdAt) >= cutoff);
  };
}

/** Conservative fallback when no check is wired: nothing is ever pending. */
export const noPendingSessions: PendingSessionCheck = async () => false;

// ---------------------------------------------------------------------------
// The street session lifecycle (FR-55)
// ---------------------------------------------------------------------------
//
// A street session is active from the moment the phone leaves the car until
// it comes back. A detected park waits (`pending_parks`, status at_car):
// nothing is asked, paid, or extended while the phone is at the car. The
// phone's fixes (POST /location) show it leaving, and that is when the
// driver is asked — one tap on the amount the server quoted. Coming back
// ends it. Everything below is the rule set; routes/parked.ts and
// routes/location.ts apply it.

/** States in which a park is still waiting on the phone or the driver. */
export const PARK_OPEN = ["at_car", "confirmed", "prompted", "starting"];
/** …and those a newer park takes the place of. */
export const PARK_SUPERSEDABLE = [...PARK_OPEN, "declined"];

/** Within this of the car's fix the phone is at the car. */
export const AT_CAR_RADIUS_M = 30;
/** Back at the car for this long is a return. */
export const RETURN_DWELL_MS = 60_000;
/** The app's own "back at the car" counts within this of the car. */
export const RETURN_EVENT_RADIUS_M = 75;
/** A fix blurrier than this says nothing about where the phone is. */
export const FIX_USABLE_ACCURACY_M = 65;
/** Leaving takes two fixes clear of the car at least this far apart: one
 * fix a hundred metres off is what GPS does between tall buildings. */
export const LEAVE_CONFIRM_MS = 10_000;
/** The app's "left the car" is refused only by a sharp fix this close. */
export const DOOR_RADIUS_M = 10;
export const DOOR_ACCURACY_M = 20;
/** A fix older than this describes where the phone was. */
export const LIFECYCLE_FIX_MAX_AGE_MS = 5 * 60_000;
/** A park nobody walked away from in this long is not asked about. */
export const PARK_TTL_MS = 60 * 60_000;
/** A start that never came back (a crash mid-start) stops blocking. */
export const STARTING_STALE_MS = 10 * 60_000;

/** What the app itself saw: on foot after the park, or the car's audio
 * reconnecting / driving again. */
export type PhoneEvent = "left_car" | "returned_to_car";

export interface WalkState {
  /** When the phone was first known to have left the car. */
  leftCarAt: Date | null;
  /** Before leaving: the first of the two fixes that show it. After: when
   * a fix first put the phone clear of the car (a return needs one). */
  farAt: Date | null;
  /** Since when every usable fix has been at the car. */
  nearSince: Date | null;
}

export interface WalkFix {
  distanceM: number;
  accuracyM: number;
  at: Date;
  event?: PhoneEvent | undefined;
}

export type WalkReason =
  "fix_away" | "left_car_event" | "near_for_60s" | "returned_event" | "drove_off";

export interface WalkStep {
  state: WalkState;
  /** This fix is the one that showed the phone leaving the car. */
  left: boolean;
  /** …or back at it, after having left. */
  returned: boolean;
  /** Driving again without the phone ever having left. */
  droveOff: boolean;
  why: WalkReason | null;
}

/**
 * One fix against where the phone stood. Pure.
 *
 * Leaving: two fixes clear of the car even allowing for their own error,
 * or the app's own report (on foot) unless a sharp fix has it at the door.
 * Returning: the app's report beside the car, or a minute within reach of
 * it — and that only after a fix put the phone clear of the car, so a
 * driver whose errand is right beside the car isn't "back" the whole time.
 */
export function advanceWalk(before: WalkState, fix: WalkFix): WalkStep {
  const state = { ...before };
  const usable = fix.accuracyM <= FIX_USABLE_ACCURACY_M;
  const near = usable && fix.distanceM <= AT_CAR_RADIUS_M;
  const clear = usable && fix.distanceM - fix.accuracyM > AT_CAR_RADIUS_M;
  const step = (extra: Partial<WalkStep>): WalkStep => ({
    state,
    left: false,
    returned: false,
    droveOff: false,
    why: null,
    ...extra,
  });

  if (state.leftCarAt === null) {
    if (fix.event === "returned_to_car") return step({ droveOff: true, why: "drove_off" });
    if (clear) {
      if (state.farAt !== null && fix.at.getTime() - state.farAt.getTime() >= LEAVE_CONFIRM_MS) {
        state.leftCarAt = fix.at;
        state.nearSince = null;
        return step({ left: true, why: "fix_away" });
      }
      state.farAt ??= fix.at;
    } else if (usable) {
      state.farAt = null;
    }
    const atTheDoor = usable && fix.accuracyM <= DOOR_ACCURACY_M && fix.distanceM <= DOOR_RADIUS_M;
    if (fix.event === "left_car" && !atTheDoor) {
      state.leftCarAt = fix.at;
      // On foot, not necessarily far: a return by distance waits for a fix
      // that is clear of the car.
      state.farAt = clear ? fix.at : null;
      state.nearSince = null;
      return step({ left: true, why: "left_car_event" });
    }
    return step({});
  }

  if (clear) state.farAt ??= fix.at;
  if (fix.event === "returned_to_car" && usable && fix.distanceM <= RETURN_EVENT_RADIUS_M) {
    return step({ returned: true, why: "returned_event" });
  }
  if (near) {
    state.nearSince ??= fix.at;
    if (state.farAt !== null && fix.at.getTime() - state.nearSince.getTime() >= RETURN_DWELL_MS) {
      return step({ returned: true, why: "near_for_60s" });
    }
  } else if (usable) {
    state.nearSince = null;
  }
  return step({});
}

/** Whether a fix may be read at all for this park: taken after the car
 * stopped, and recent. Anything else describes another moment. */
export function fixCountsFor(parkedAt: Date, fixAt: Date, now: Date): boolean {
  return (
    fixAt.getTime() >= parkedAt.getTime() &&
    now.getTime() - fixAt.getTime() <= LIFECYCLE_FIX_MAX_AGE_MS
  );
}

// ------------------------------------------------------------ the prompt

/** A street candidate as /parked answered it, kept on the park. */
export interface ParkCandidate extends ZoneTerms {
  quote: Quote;
}

export function parkCandidates(park: Pick<PendingParkRow, "candidates">): ParkCandidate[] {
  return Array.isArray(park.candidates) ? (park.candidates as ParkCandidate[]) : [];
}

export type ParkPromptReason =
  "needs_zone_number" | "provider_not_linked" | "session_cap_exceeded" | "daily_cap_exceeded";

/**
 * What the phone shows at walk-away, word for word. `confirm` carries the
 * amount a tap pays; `side` asks which candidate; `attention` says what is
 * in the way of paying here (its amount is what it would cost; nothing
 * pays it by a tap). The phone never composes a number of its own.
 */
export interface ParkPrompt {
  kind: "confirm" | "side" | "attention";
  parkedEventId: string;
  title: string;
  body: string;
  zoneId?: string;
  zoneNumber?: string;
  amountUsd?: number;
  minutes?: number;
  endsAt?: string;
  /** The quote behind the amount, for the app's own sheet to show. */
  quote?: Quote;
  reason?: ParkPromptReason;
  dryRun: boolean;
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/** "1 h 05 m", "45 m", "2 h". */
export function stayLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")} m`;
}

/** "3:05 PM", on the meters' own clock. */
export function clockLabel(at: Date): string {
  const [hour = 0, minute = 0] = easternWallClock(at).slice(11, 16).split(":").map(Number);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

interface PromptDeps {
  db: AppDb;
  policy: { get(): Policy; effectiveDryRun(): boolean };
}

export type BuiltPrompt =
  | { kind: "prompt"; prompt: ParkPrompt; quote: Quote | null }
  /** Nothing to pay any more (the meters stopped charging meanwhile). */
  | { kind: "free" }
  | { kind: "none" };

/**
 * The prompt for a park as things stand at `at`: quoted now, for the stay
 * the session would buy now, and refused in words when the start path
 * would refuse it. `zoneId` is the driver's choice of side, when made.
 */
export async function buildParkPrompt(
  deps: PromptDeps,
  park: PendingParkRow,
  at: Date,
): Promise<BuiltPrompt> {
  const candidates = parkCandidates(park);
  if (candidates.length === 0 || park.parkedEventId === null) return { kind: "none" };
  const policy = await policyFor(deps, park.userId);
  const dryRun = deps.policy.effectiveDryRun();
  const base = { parkedEventId: park.parkedEventId, dryRun };
  const note = dryRun ? " Dry run — nothing will be charged." : "";

  const chosen =
    park.zoneId !== null
      ? candidates.find((c) => c.zoneId === park.zoneId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  if (!chosen) {
    const totals = candidates.map((c) => usd(quoteZone(c, policy, at).totalUsd));
    return {
      kind: "prompt",
      quote: null,
      prompt: {
        ...base,
        kind: "side",
        title: "Which side of the street?",
        body: `The two sides here have different rules (${totals.join(" or ")}). Open ParkAgent and pick yours to pay.${note}`,
      },
    };
  }

  // The number may have been reported since the car stopped.
  const zone = await deps.db.zone.findUnique({ where: { zoneId: chosen.zoneId } });
  const zoneNumber = zone?.providerZoneNumber ?? chosen.providerZoneNumber;
  const quote = quoteZone({ ...chosen, providerZoneNumber: zoneNumber }, policy, at);
  if (quote.totalUsd === 0) return { kind: "free" };

  const provider = providerForCity(cityForZone(chosen.zoneId));
  const account = provider
    ? await deps.db.providerAccount.findUnique({
        where: { userId_provider: { userId: park.userId, provider: provider.id } },
      })
    : null;
  // The start path's own refusals, in its order: said now, in words,
  // rather than offered as a Pay button that would be refused.
  let reason: ParkPromptReason | null = null;
  if (provider && !providerStatusUsable(account?.status)) reason = "provider_not_linked";
  else if (provider && zoneNumber === "") reason = "needs_zone_number";
  else if (quote.totalUsd > policy.session_cap_usd) reason = "session_cap_exceeded";
  else if (
    !dryRun &&
    (await spentToday(deps.db, park.userId, at)) + quote.totalUsd > policy.daily_cap_usd
  ) {
    reason = "daily_cap_exceeded";
  }

  const parkedIn = zoneNumber === "" ? "Parked at a meter" : `Parked in zone ${zoneNumber}`;
  if (reason !== null) {
    const attention = {
      provider_not_linked: {
        title: parkedIn,
        body: `Connect ${provider?.displayName ?? "your parking account"} in ParkAgent to pay here, or pay at the meter.`,
      },
      needs_zone_number: {
        title: "Parked — zone number needed",
        body: "Open ParkAgent and type the zone number from the meter to pay.",
      },
      session_cap_exceeded: {
        title: parkedIn,
        body: `${usd(quote.totalUsd)} is more than ParkAgent pays for one stop, so it won't pay this one. Pay at the meter or in your parking app.`,
      },
      daily_cap_exceeded: {
        title: parkedIn,
        body: `${usd(quote.totalUsd)} is over today's limit, so ParkAgent won't pay it. Pay at the meter or in your parking app.`,
      },
    }[reason];
    return {
      kind: "prompt",
      quote,
      prompt: {
        ...base,
        kind: "attention",
        reason,
        title: attention.title,
        body: attention.body + note,
        zoneId: chosen.zoneId,
        ...(zoneNumber === "" ? {} : { zoneNumber }),
        // What it would cost, for the app to show. No tap pays it.
        amountUsd: quote.totalUsd,
        minutes: quote.stayMinutes,
        quote,
      },
    };
  }

  const endsAt = new Date(at.getTime() + quote.stayMinutes * 60_000);
  const where = zone?.street ? ` on ${zone.street}` : "";
  return {
    kind: "prompt",
    quote,
    prompt: {
      ...base,
      kind: "confirm",
      title: `Pay ${usd(quote.totalUsd)} for zone ${zoneNumber}?`,
      body: `${stayLabel(quote.stayMinutes)}${where} · ends ${clockLabel(endsAt)}${dryRun ? " · Dry run, nothing is charged" : ""}`,
      zoneId: chosen.zoneId,
      zoneNumber,
      amountUsd: quote.totalUsd,
      minutes: quote.stayMinutes,
      endsAt: endsAt.toISOString(),
      quote,
    },
  };
}

// ------------------------------------------------------------ transitions

interface LifecycleDeps extends PromptDeps {
  policy: { get(): Policy; hash(): string; effectiveDryRun(): boolean };
}

export const walkStateOf = (park: PendingParkRow): WalkState => ({
  leftCarAt: park.leftCarAt,
  farAt: park.farAt,
  nearSince: park.nearSince,
});

/** A fix as a decisions row records it. */
export interface FixRecord {
  lat: number;
  lng: number;
  accuracyM: number;
  ts: string;
  distanceM: number;
  event?: PhoneEvent;
}

/**
 * Close what time has closed, and answer with the row as it now stands: a
 * park nobody walked away from (or answered) within the hour is not asked
 * about, and a start that never came back stops blocking the park — as a
 * failed one, since whether it charged is unknown.
 */
export async function settlePark(
  deps: Pick<LifecycleDeps, "db">,
  park: PendingParkRow,
  at: Date,
): Promise<PendingParkRow> {
  const since = (from: Date | null) => at.getTime() - (from ?? park.createdAt).getTime();
  let closed: string | null = null;
  if (park.status === "at_car" || park.status === "confirmed") {
    // From when the server heard of it, not from the phone's own clock.
    if (since(park.createdAt) > PARK_TTL_MS) closed = "expired";
  } else if (park.status === "prompted" || park.status === "declined") {
    if (since(park.promptedAt ?? park.parkedAt) > PARK_TTL_MS) closed = "expired";
  } else if (park.status === "starting") {
    if (since(park.startingAt) > STARTING_STALE_MS) closed = "start_failed";
  }
  if (closed === null) return park;
  await deps.db.pendingPark.updateMany({
    where: { id: park.id, status: park.status },
    data: { status: closed, closedAt: at },
  });
  return (await deps.db.pendingPark.findUnique({ where: { id: park.id } })) ?? park;
}

/** The start path, as the lifecycle calls it (routes/session.ts SessionOps). */
export type ParkStarter = (
  user: { id: string },
  body: { parkedEventId: string; zoneId: string; minutes?: number },
  opts?: { maxTotalUsd?: number },
) => Promise<{ status: number; body: Record<string, unknown>; reachedProvider: boolean }>;

export type ParkStartOutcome =
  | { kind: "started"; body: Record<string, unknown> }
  | { kind: "free"; body: Record<string, unknown> }
  /** The amount agreed to no longer buys the stay: asked again, at the new one. */
  | { kind: "quote_changed"; prompt: ParkPrompt | null }
  /** Refused before the provider was asked: the park can still be paid. */
  | { kind: "refused"; status: number; body: Record<string, unknown>; prompt: ParkPrompt | null }
  /** The provider was asked and it failed: this park is not paid from again. */
  | { kind: "failed"; status: number; body: Record<string, unknown> };

/**
 * Run the one start a park gets. The caller has already moved the park to
 * `starting` with a compare-and-set, which is what makes this run once
 * however many taps and fixes race for it; `park` is that row, with the
 * confirmed zone and the quote the driver was shown.
 */
export async function startParkSession(
  deps: LifecycleDeps,
  start: ParkStarter,
  park: PendingParkRow,
  args: { at: Date; mode: "tap"; trigger: "confirm" | "walk_away"; fix?: FixRecord },
): Promise<ParkStartOutcome> {
  const shown = park.quote as Quote;
  const parkedEventId = park.parkedEventId as string;
  const reply = await start(
    { id: park.userId },
    { parkedEventId, zoneId: park.zoneId as string, minutes: shown.stayMinutes },
    { maxTotalUsd: shown.totalUsd },
  );

  let outcome: ParkStartOutcome;
  let next: {
    status: string;
    closedAt?: Date;
    sessionId?: string;
    quote?: unknown;
    prompt?: unknown;
    promptedAt?: Date;
  };
  const sessionId = typeof reply.body["sessionId"] === "string" ? reply.body["sessionId"] : null;
  if (reply.status === 200 && sessionId !== null) {
    outcome = { kind: "started", body: reply.body };
    next = { status: "started", sessionId };
  } else if (reply.status === 200) {
    // The provider says the zone isn't charging: nothing to pay here.
    outcome = { kind: "free", body: reply.body };
    next = { status: "free", closedAt: args.at };
  } else if (reply.reachedProvider) {
    outcome = { kind: "failed", status: reply.status, body: reply.body };
    next = { status: "start_failed", closedAt: args.at };
  } else {
    // Nothing reached the provider: the park goes back to waiting for a
    // tap, with a prompt that says where it stands now.
    const built = await buildParkPrompt(deps, park, args.at);
    const prompt = built.kind === "prompt" ? built.prompt : null;
    outcome =
      reply.body["rule"] === "quote_changed"
        ? { kind: "quote_changed", prompt }
        : { kind: "refused", status: reply.status, body: reply.body, prompt };
    next =
      built.kind === "free"
        ? { status: "free", closedAt: args.at }
        : {
            status: "prompted",
            promptedAt: park.promptedAt ?? args.at,
            ...(built.kind === "prompt"
              ? { prompt: built.prompt, quote: built.quote ?? shown }
              : {}),
          };
  }
  await deps.db.pendingPark.updateMany({
    where: { id: park.id, status: "starting" },
    data: next,
  });

  await deps.db.decision.create({
    data: {
      kind: "session_start_walkaway",
      inputs: {
        parkedEventId,
        zoneId: park.zoneId,
        mode: args.mode,
        trigger: args.trigger,
        // The walk-away this start waited for, and the fix that showed it
        // when the start ran on that very fix.
        leftCar: { at: park.leftCarAt?.toISOString() ?? null },
        ...(args.fix ? { fix: args.fix } : {}),
        shown,
        dryRun: deps.policy.effectiveDryRun(),
        policyHash: deps.policy.hash(),
      },
      rule: outcome.kind,
      outcome: {
        status: reply.status,
        reachedProvider: reply.reachedProvider,
        parkStatus: next.status,
        ...(sessionId !== null ? { sessionId } : {}),
        ...(reply.status === 200 ? {} : { error: reply.body["error"], rule: reply.body["rule"] }),
      },
      userId: park.userId,
      parkedEventId,
      ...(sessionId !== null ? { sessionId } : {}),
    },
  });
  return outcome;
}
