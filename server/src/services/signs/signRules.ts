/**
 * What a parking sign says, as data (Issue N): the shape the model must
 * answer in, the check that every number it gives is on the sign (or in
 * the zone data), and the comparison with the zone data at the car.
 *
 * Pure: no model, no database. The reading is advisory. It can warn, or
 * offer a SHORTER max stay for this park; it never loosens a limit,
 * changes a price, or starts or stops anything (services/capabilities/
 * readSigns.ts says so to the caller; routes/signs.ts applies a shorter
 * stay only on the driver's own accept).
 */

import { z } from "zod";

import { scrubUngroundedAmounts } from "../assistant/replyText.js";
import type { HoursInterval } from "../hours.js";
import { isEnforcedAt, nycWeekdayAndMinute } from "../hours.js";

export const SIGN_RULE_KINDS = [
  "time_limit",
  "meter",
  "no_parking",
  "no_stopping",
  "street_cleaning",
  "permit_only",
  "tow_zone",
] as const;
export type SignRuleKind = (typeof SIGN_RULE_KINDS)[number];

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The kinds that say a car may not be left here at all (or not without
 * a permit): the zone data's paid parking is then in doubt. */
const PROHIBITIVE: ReadonlySet<SignRuleKind> = new Set([
  "no_parking",
  "no_stopping",
  "street_cleaning",
  "permit_only",
  "tow_zone",
]);

export const signRuleSchema = z.strictObject({
  kind: z.enum(SIGN_RULE_KINDS),
  /** Empty: every day. */
  days: z.array(z.enum(DAYS)).max(7),
  /** 24-hour "HH:MM"; null on both: all day. */
  start: z.string().regex(CLOCK).nullable(),
  end: z.string().regex(CLOCK).nullable(),
  limitMinutes: z.number().int().min(1).max(1440).nullable(),
  permitZone: z.string().max(40).nullable(),
  exceptions: z.array(z.string().max(160)).max(6),
});

export const signRulesSchema = z.strictObject({
  rules: z.array(signRuleSchema).max(12),
  confidence: z.number().min(0).max(1),
  unreadable: z.boolean(),
});

export type SignRule = z.infer<typeof signRuleSchema>;
export type SignRules = z.infer<typeof signRulesSchema>;

/** The same shape as the JSON Schema the model's structured output is
 * held to (`output_config.format`): every field required, nothing extra.
 * Bounds and the clock format are checked again on the way in. */
export const SIGN_RULES_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rules", "confidence", "unreadable"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "days", "start", "end", "limitMinutes", "permitZone", "exceptions"],
        properties: {
          kind: { type: "string", enum: [...SIGN_RULE_KINDS] },
          days: {
            type: "array",
            items: { type: "string", enum: [...DAYS] },
            description: "The days the rule applies; empty for every day",
          },
          start: {
            type: ["string", "null"],
            description: "24-hour HH:MM; null with end for all day",
          },
          end: { type: ["string", "null"], description: "24-hour HH:MM" },
          limitMinutes: {
            type: ["integer", "null"],
            description: "A posted time limit in minutes (2 HOUR PARKING is 120)",
          },
          permitZone: { type: ["string", "null"], description: "The permit zone, as written" },
          exceptions: {
            type: "array",
            items: { type: "string" },
            description: "Exceptions as written, e.g. EXCEPT SUNDAYS",
          },
        },
      },
    },
    confidence: { type: "number", description: "0 to 1: how sure the reading is" },
    unreadable: { type: "boolean", description: "True when the signs can't be read" },
  },
} as const;

// ------------------------------------------------------------- grounding

/** What a number may be checked against: the sign's own text, and the
 * zone data at the car. */
export interface GroundingSource {
  text: string;
  zoneMaxStayMinutes: number | null;
  zoneHours: HoursInterval[];
}

export interface Grounded {
  rules: SignRule[];
  /** Each rule dropped, by its index in the model's answer, and why. */
  dropped: { index: number; why: string }[];
}

/** Durations the text shows, in minutes: "2 HOUR", "2HR", "30 MIN". */
function durationsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d{1,2}(?:\.5)?)\s*-?\s*(hours?|hrs?|h)\b/gi)) {
    out.add(Math.round(Number(m[1]) * 60));
  }
  for (const m of text.matchAll(/(\d{1,3})\s*-?\s*(minutes?|mins?|min)\b/gi)) out.add(Number(m[1]));
  return out;
}

const hhmm = (h: number, m: number) =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** A 12-hour clock with its meridiem as 24-hour "HH:MM". */
function clock24(h: number, m: number, meridiem: string): string | null {
  if (h < 1 || h > 12 || m > 59) return null;
  const pm = meridiem.toLowerCase().startsWith("p");
  return hhmm((h % 12) + (pm ? 12 : 0), m);
}

/**
 * The clock times the text shows, as exact 24-hour "HH:MM". Only tokens
 * that read as times count: "8AM", "6:30 PM", "14:00", "8:00" (either
 * half of the day), noon and midnight, and the bare first half of a range
 * whose second half carries the meridiem ("8 - 6PM": 8 either way). A
 * bare number is a duration or a day, never a time: the "2" of "2 HOUR
 * PARKING" grounds nothing.
 */
function clocksIn(text: string): Set<string> {
  const out = new Set<string>();
  const MERIDIEM = String.raw`([AP])\.?\s?M\b\.?`;
  for (const m of text.matchAll(
    new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?\s*` + MERIDIEM, "gi"),
  )) {
    const c = clock24(Number(m[1]), Number(m[2] ?? 0), m[3]!);
    if (c) out.add(c);
  }
  for (const m of text.matchAll(
    new RegExp(
      String.raw`\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|TO)\s*\d{1,2}(?::\d{2})?\s*` + MERIDIEM,
      "gi",
    ),
  )) {
    for (const half of ["a", "p"]) {
      const c = clock24(Number(m[1]), Number(m[2] ?? 0), half);
      if (c) out.add(c);
    }
  }
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*[AP]\.?\s?M)/gi)) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    out.add(hhmm(h, min));
    if (h >= 1 && h <= 12) out.add(hhmm((h % 12) + 12, min));
  }
  if (/\bnoon\b/i.test(text)) out.add("12:00");
  if (/\bmidnight\b/i.test(text)) out.add("00:00");
  return out;
}

/** Dollar amounts the text shows, in cents. */
function centsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g))
    out.add(Math.round(Number(m[1]) * 100));
  return out;
}

/**
 * Keep only what the source stands behind. A rule whose time limit or
 * clock hour appears neither in the sign's text nor in the zone data is
 * dropped whole (a number the model supplied is a guess about the curb);
 * a permit zone the text doesn't show is cleared; an exception that names
 * a dollar amount the text doesn't show is dropped.
 */
export function groundRules(rules: SignRule[], source: GroundingSource): Grounded {
  const durations = durationsIn(source.text);
  const textClocks = clocksIn(source.text);
  const zoneClocks = new Set(
    source.zoneHours.flatMap((i) => [i.start, i.end]).map((c) => c.padStart(5, "0")),
  );
  const cents = centsIn(source.text);
  const words = source.text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const kept: SignRule[] = [];
  const dropped: Grounded["dropped"] = [];
  rules.forEach((rule, index) => {
    if (
      rule.limitMinutes !== null &&
      !durations.has(rule.limitMinutes) &&
      rule.limitMinutes !== source.zoneMaxStayMinutes
    ) {
      dropped.push({ index, why: "limit_not_on_sign" });
      return;
    }
    for (const clock of [rule.start, rule.end]) {
      if (clock === null) continue;
      if (!textClocks.has(clock) && !zoneClocks.has(clock)) {
        dropped.push({ index, why: "time_not_on_sign" });
        return;
      }
    }
    const permitZone =
      rule.permitZone !== null &&
      words.includes(
        rule.permitZone
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      )
        ? rule.permitZone
        : null;
    const exceptions = rule.exceptions
      .map((e) => scrubUngroundedAmounts(e, cents).text.trim())
      .filter((e) => e.length > 0);
    kept.push({ ...rule, permitZone, exceptions });
  });
  return { rules: kept, dropped };
}

// ------------------------------------------------------------ comparison

export type Verdict = "agrees" | "stricter" | "conflicts" | "unreadable";

/** The zone data at the car, as the comparison reads it. */
export interface ZoneView {
  zoneId: string;
  maxStayMinutes: number | null;
  hours: HoursInterval[];
}

export interface Comparison {
  verdict: Verdict;
  /** A stricter verdict's shorter max stay; never longer than the zone's. */
  offerMaxStayMinutes: number | null;
  /** Why, as codes: no_parking, time_limit_shorter, time_limit_longer, … */
  reasons: string[];
}

const WEEKDAY: Record<string, (typeof DAYS)[number]> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const toMinute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/** How long before a time-boxed prohibition starts to leave the car. */
export const PROHIBITION_MARGIN_MINUTES = 5;

/** The first minute of [at, at + stay) the rule applies, as minutes from
 * `at`, or null when it never does. Minute by minute, in Eastern time
 * (both cities' signs are). */
function firstMinuteApplying(rule: SignRule, at: Date, stayMinutes: number): number | null {
  for (let offset = 0; offset < Math.max(stayMinutes, 1); offset++) {
    const { weekday, minute } = nycWeekdayAndMinute(new Date(at.getTime() + offset * 60_000));
    const day = WEEKDAY[weekday];
    if (rule.days.length > 0 && (!day || !rule.days.includes(day))) continue;
    if (rule.start === null || rule.end === null) return offset;
    const start = toMinute(rule.start);
    const end = toMinute(rule.end);
    const inside = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
    if (inside) return offset;
  }
  return null;
}

/**
 * The signs against the zone data, for a stay of `stayMinutes` from `at`
 * (the check, right after parking):
 * - a rule that forbids leaving the car (no parking, tow zone, street
 *   cleaning, permit only) already in force at `at` → conflicts;
 * - one that starts later in the stay → stricter, offering the minutes
 *   until it starts less a 5-minute margin (none left → conflicts), so an
 *   accepted offer keeps every extension out of the window;
 * - a posted limit longer than the zone's → conflicts (the shorter one
 *   stands; the reading never loosens a limit);
 * - a meter running where the zone data says free → conflicts;
 * - a posted limit shorter than the zone's (or the zone has none) →
 *   stricter, with that limit offered as this park's max stay;
 * - otherwise agrees. An unreadable reading, or no rule left after
 *   grounding, is unreadable. The shortest offer wins.
 */
export function compareWithZone(
  reading: { rules: SignRule[]; unreadable: boolean },
  zone: ZoneView | null,
  at: Date,
  stayMinutes: number,
): Comparison {
  if (reading.unreadable || reading.rules.length === 0) {
    return { verdict: "unreadable", offerMaxStayMinutes: null, reasons: [] };
  }
  const reasons: string[] = [];
  let conflicts = false;
  let offer: number | null = null;
  const offerAtMost = (minutes: number) => {
    offer = offer === null ? minutes : Math.min(offer, minutes);
  };
  for (const rule of reading.rules) {
    const first = firstMinuteApplying(rule, at, stayMinutes);
    if (first === null) continue;
    if (PROHIBITIVE.has(rule.kind)) {
      const leaveBy = first - PROHIBITION_MARGIN_MINUTES;
      if (first === 0 || leaveBy <= 0) {
        conflicts = true;
        reasons.push(rule.kind);
      } else {
        offerAtMost(leaveBy);
        reasons.push(`${rule.kind}_later`);
      }
      continue;
    }
    if (rule.kind === "meter" && zone && !isEnforcedAt(zone.hours, at)) {
      conflicts = true;
      reasons.push("meter_where_free");
    }
    if (rule.limitMinutes === null) continue;
    const zoneMax = zone?.maxStayMinutes ?? null;
    if (zoneMax !== null && rule.limitMinutes > zoneMax) {
      conflicts = true;
      reasons.push("time_limit_longer");
    } else if (zoneMax === null || rule.limitMinutes < zoneMax) {
      offerAtMost(rule.limitMinutes);
      reasons.push("time_limit_shorter");
    }
  }
  if (conflicts) return { verdict: "conflicts", offerMaxStayMinutes: null, reasons };
  if (offer !== null) return { verdict: "stricter", offerMaxStayMinutes: offer, reasons };
  return { verdict: "agrees", offerMaxStayMinutes: null, reasons };
}

/** A max stay, tightened by an accepted sign offer: never longer. */
export function tightenedMaxStay(zoneMax: number | null, accepted: number | null): number | null {
  if (accepted === null) return zoneMax;
  return zoneMax === null ? accepted : Math.min(zoneMax, accepted);
}
