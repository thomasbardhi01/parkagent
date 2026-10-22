/**
 * The nightly audit's invariants (L): rules production behavior must
 * keep, checked over one window of the decisions, sessions, pending_parks
 * and park_fixes tables. Each is a named function over the window's data
 * that returns the parks or sessions breaking it; nothing here writes or
 * changes anything. GET /admin/audit runs them (routes/admin.ts) and the
 * nightly workflow files the findings as a GitHub issue.
 */

import type { AppDb, ParkFixRow, PendingParkRow, SessionRow } from "../../db.js";
import { START_DEADLINE_MS } from "../pendingSession.js";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  invariant: string;
  severity: Severity;
  description: string;
  count: number;
  /** Up to five park (parkedEventId) or session ids, for the trace. */
  examples: string[];
}

export interface AuditWindow {
  from: Date;
  to: Date;
  /** When the audit runs: a session still active is judged up to here. */
  now: Date;
}

type DecisionRow = Awaited<ReturnType<AppDb["decision"]["findMany"]>>[number];

export interface AuditData {
  decisions: DecisionRow[];
  sessions: SessionRow[];
  parks: PendingParkRow[];
  /** park_fixes by pending_parks id. */
  parkFixes: Map<string, ParkFixRow[]>;
  /** location_fixes times by session id. */
  sessionFixes: Map<string, Date[]>;
}

/** An active session with no fix for this long has lost its phone. */
export const FIX_GAP_MS = 30 * 60_000;
/** More prompts than this for one park is the walk-away misreading. */
export const MAX_PROMPTS = 2;
const EXAMPLES = 5;

/** The window's rows, read once. */
export async function loadAuditData(db: AppDb, window: AuditWindow): Promise<AuditData> {
  const range = { gte: window.from, lt: window.to };
  const [decisions, sessions, parks] = await Promise.all([
    db.decision.findMany({ where: { createdAt: range } }),
    db.session.findMany({ where: { createdAt: range } }),
    db.pendingPark.findMany({ where: { createdAt: range } }),
  ]);
  const parkFixes = new Map<string, ParkFixRow[]>();
  for (const park of parks) {
    parkFixes.set(
      park.id,
      await db.parkFix.findMany({
        where: { pendingParkId: park.id },
        orderBy: { receivedAt: "asc" },
      }),
    );
  }
  const sessionFixes = new Map<string, Date[]>();
  for (const session of sessions) {
    const fixes = await db.locationFix.findMany({
      where: { sessionId: session.id },
      orderBy: { ts: "desc" },
      take: 5_000,
    });
    sessionFixes.set(
      session.id,
      fixes.map((f) => f.ts).sort((a, b) => a.getTime() - b.getTime()),
    );
  }
  return { decisions, sessions, parks, parkFixes, sessionFixes };
}

const rec = (value: unknown) => (value ?? {}) as Record<string, unknown>;
const unique = (ids: (string | null | undefined)[]) => [
  ...new Set(ids.filter((id): id is string => typeof id === "string")),
];

/** The worker bought time for a phone it didn't read as away (at the car,
 * back at it, returned, or unknown). */
export function extendedAtCar(data: AuditData): string[] {
  return unique(
    data.decisions
      .filter((d) => d.kind === "extend_tick" && d.rule === "extend")
      .filter((d) => rec(d.outcome)["action"] === "extend" && rec(d.outcome)["ok"] !== false)
      .filter((d) => rec(d.inputs)["position"] !== "away")
      .map((d) => d.sessionId),
  );
}

/** A Pay tapped at the car started at the walk-away with no on-foot
 * report from the app: neither the fix that started it nor any fix the
 * park kept before it carried `left_car`. Distance alone never starts it. */
export function confirmedStartedWithoutLeftCar(data: AuditData): string[] {
  const parkOf = new Map(data.parks.map((p) => [p.parkedEventId, p]));
  return unique(
    data.decisions
      .filter((d) => d.kind === "session_start_walkaway" && d.rule === "started")
      .filter((d) => rec(d.inputs)["trigger"] === "walk_away")
      .filter((d) => {
        if (rec(rec(d.inputs)["fix"])["event"] === "left_car") return false;
        const park = parkOf.get(d.parkedEventId);
        const kept = park ? (data.parkFixes.get(park.id) ?? []) : [];
        return !kept.some(
          (f) =>
            f.event === "left_car" &&
            // Read, or said at the car's door and taken by a later fix off
            // the car (pendingSession `walkSaidAt`, #264).
            (f.rejected === null || f.rejected === "may_be_at_door") &&
            f.receivedAt.getTime() <= d.createdAt.getTime(),
        );
      })
      .map((d) => d.parkedEventId),
  );
}

/** A start that took longer than its deadline: timed out, swept, adopted
 * late, or still `starting` past it. */
export function startingTooLong(data: AuditData, window: AuditWindow): string[] {
  const slow = data.decisions
    .filter(
      (d) =>
        (d.kind === "session_start_walkaway" &&
          (d.rule === "start_timeout" || d.rule === "late_success")) ||
        (d.kind === "park_lifecycle" && d.rule === "start_stale"),
    )
    .map((d) => d.parkedEventId);
  const end = Math.min(window.now.getTime(), window.to.getTime());
  const stuck = data.parks
    .filter(
      (p) =>
        p.status === "starting" &&
        p.startingAt !== null &&
        end - p.startingAt.getTime() > START_DEADLINE_MS,
    )
    .map((p) => p.parkedEventId ?? p.id);
  return unique([...slow, ...stuck]);
}

/** A park asked about more than twice: the walk-away read again and again. */
export function promptedMoreThanTwice(data: AuditData): string[] {
  const prompts = new Map<string, number>();
  for (const d of data.decisions) {
    if (d.kind !== "street_prompt" || d.parkedEventId === null) continue;
    prompts.set(d.parkedEventId, (prompts.get(d.parkedEventId) ?? 0) + 1);
  }
  return [...prompts].filter(([, n]) => n > MAX_PROMPTS).map(([id]) => id);
}

/** A session that ran 30 minutes or more with no fix from the phone: the
 * extension worker and the return were both blind for that long. */
export function activeSessionWithoutFix(data: AuditData, window: AuditWindow): string[] {
  const cutoff = Math.min(window.now.getTime(), window.to.getTime());
  return data.sessions
    .filter((s) => s.startedAt !== null)
    .filter((s) => {
      const start = s.startedAt!.getTime();
      const ended = (s.stoppedAt ?? s.expiresAt)?.getTime() ?? cutoff;
      const end = Math.min(ended, cutoff);
      if (end - start < FIX_GAP_MS) return false;
      const times = (data.sessionFixes.get(s.id) ?? [])
        .map((t) => t.getTime())
        .filter((t) => t >= start && t <= end);
      const points = [start, ...times, end];
      return points.some((t, i) => i > 0 && t - points[i - 1]! >= FIX_GAP_MS);
    })
    .map((s) => s.id);
}

/** A start whose dry run wasn't what the driver was told at the prompt. */
export function dryRunMismatch(data: AuditData): string[] {
  return unique(
    data.decisions
      .filter((d) => d.kind === "session_start_walkaway" && d.rule === "started")
      .filter((d) => {
        const shown = rec(d.inputs)["shownDryRun"];
        return typeof shown === "boolean" && shown !== rec(d.inputs)["dryRun"];
      })
      .map((d) => d.parkedEventId),
  );
}

/** A paid park whose decisions skip a step of the lifecycle: held
 * (street_pending), tapped (street_confirmed), started
 * (session_start_walkaway started or late_success). Parks made for a
 * session started outside the lifecycle have no candidates and are not
 * held, so they aren't checked. */
export function transitionSkipped(data: AuditData): string[] {
  const kinds = new Map<string, Set<string>>();
  for (const d of data.decisions) {
    if (d.parkedEventId === null) continue;
    const tag =
      d.kind === "session_start_walkaway" && (d.rule === "started" || d.rule === "late_success")
        ? "started"
        : d.kind;
    kinds.set(d.parkedEventId, (kinds.get(d.parkedEventId) ?? new Set()).add(tag));
  }
  const parkOf = new Map(data.parks.map((p) => [p.parkedEventId, p]));
  return data.sessions
    .filter((s) => {
      const park = s.parkedEventId ? parkOf.get(s.parkedEventId) : undefined;
      if (!park || park.candidates === null || park.candidates === undefined) return false;
      if (park.status !== "started" && park.status !== "ended") return false;
      const seen = kinds.get(s.parkedEventId!) ?? new Set();
      return !["street_pending", "street_confirmed", "started"].every((k) => seen.has(k));
    })
    .map((s) => s.id);
}

/** Every invariant, in the order the report lists them. */
export const INVARIANTS: {
  name: string;
  severity: Severity;
  description: string;
  check: (data: AuditData, window: AuditWindow) => string[];
}[] = [
  {
    name: "extended_at_car",
    severity: "high",
    description: "the worker extended a session whose phone it didn't read as away",
    check: extendedAtCar,
  },
  {
    name: "confirmed_started_without_left_car",
    severity: "high",
    description: "a Pay tapped at the car started without the app's left_car",
    check: confirmedStartedWithoutLeftCar,
  },
  {
    name: "dry_run_mismatch",
    severity: "high",
    description: "a start's dry run differed from what the prompt told the driver",
    check: dryRunMismatch,
  },
  {
    name: "starting_too_long",
    severity: "medium",
    description: "a start took longer than its 3-minute deadline",
    check: startingTooLong,
  },
  {
    name: "transition_skipped",
    severity: "medium",
    description: "a paid park's decisions skip a lifecycle step (held, tapped, started)",
    check: transitionSkipped,
  },
  {
    name: "session_without_fix_30min",
    severity: "medium",
    description: "an active session went 30 minutes or more without a fix",
    check: activeSessionWithoutFix,
  },
  {
    name: "prompted_more_than_twice",
    severity: "low",
    description: "a park was asked about more than twice",
    check: promptedMoreThanTwice,
  },
];

/** Every invariant over the window, as findings (count 0 included, so the
 * report says what was checked). */
export async function runAudit(db: AppDb, window: AuditWindow): Promise<Finding[]> {
  const data = await loadAuditData(db, window);
  return INVARIANTS.map((inv) => {
    const ids = inv.check(data, window);
    return {
      invariant: inv.name,
      severity: inv.severity,
      description: inv.description,
      count: ids.length,
      examples: ids.slice(0, EXAMPLES),
    };
  });
}
