/**
 * Clarifying questions and stated assumptions.
 *
 * A question the user has to answer by typing is a question they have to
 * answer twice (think, then type). ask_user carries tappable answers; when
 * the model asks in prose anyway — "How long will you stay?" — the loop
 * recognizes the three questions a parking request actually needs (which
 * city, what time, how long) and attaches the usual answers, so the reply
 * is still one tap.
 *
 * And every plan says what it assumed — "Sat 7:00–10:00 PM, near LoLa 42,
 * Seaport" — computed from the plan itself (the window its options were
 * priced for, the place it was searched at), so it's true even when the
 * model's words drift.
 */

import { coveredCities } from "../../providers/registry.js";
import { parseEasternTime } from "../hours.js";
import type { AssistantPlanBody } from "./plans.js";
import { assumedDay, type TimeRequest } from "./requestedTime.js";
import type { Suggestion } from "./tools.js";

/** The usual answers to the three questions a parking request needs. */
export function suggestionsForQuestion(reply: string): Suggestion[] | null {
  const text = reply.trim();
  if (!text.endsWith("?")) return null;
  const cities = coveredCities().map((c) => c.cityDisplayName);
  const namesTwoCities = cities.filter((c) => text.includes(c)).length >= 2;
  if (/\b(which|what) city\b/i.test(text) || namesTwoCities) {
    return cities.map((city) => ({ label: city, reply: `In ${city}` }));
  }
  if (/\bhow long\b|\bhow many (hours|minutes)\b|\bduration\b|\bstay(ing)? for\b/i.test(text)) {
    return [
      { label: "1 hour", reply: "For 1 hour" },
      { label: "2 hours", reply: "For 2 hours" },
      { label: "3 hours", reply: "For 3 hours" },
    ];
  }
  if (/\bwhat time\b|\bwhen (will|do|would|are|should|can) you\b|\barriv(e|ing|al)\b/i.test(text)) {
    return [
      { label: "Now", reply: "Now" },
      { label: "In 30 minutes", reply: "In 30 minutes" },
      { label: "Tonight at 7", reply: "Tonight at 7 PM" },
    ];
  }
  return null;
}

const etDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const etWeekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});
const etMonthDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
});
const etClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "7:00 PM" → ["7:00", "PM"]. */
function clockParts(at: Date): [string, string] {
  const [time = "", meridiem = ""] = etClock
    .format(at)
    .replace(/\u202f/g, " ")
    .split(" ");
  return [time, meridiem];
}

/** "7:00–10:00 PM", "11:30 AM–1:00 PM". */
export function windowText(start: Date, end: Date): string {
  const [s, sm] = clockParts(start);
  const [e, em] = clockParts(end);
  return sm === em ? `${s}–${e} ${em}` : `${s} ${sm}–${e} ${em}`;
}

/** "" for today, "Tomorrow ", "Sat ", or "Oct 3 " a week or more out. */
function dayPrefix(at: Date, now: Date): string {
  const day = etDay.format(at);
  if (day === etDay.format(now)) return "";
  if (day === etDay.format(new Date(now.getTime() + 24 * 60 * 60_000))) return "Tomorrow ";
  const days = (at.getTime() - now.getTime()) / (24 * 60 * 60_000);
  return days < 6.5 ? `${etWeekday.format(at)} ` : `${etMonthDay.format(at)} `;
}

/**
 * A window and a place in one line: "Sat 7:00–10:00 PM, near LoLa 42,
 * Seaport", "Now–3:30 PM". A day the user didn't say is said out loud: a
 * 7 PM that had passed today reads "Assuming tomorrow, 7:00–10:00 PM", and
 * "tonight" asked after midnight "Assuming this evening, …"
 * (requestedTime.ts). `start` null is a stay that starts now.
 */
export function windowAssumption(
  window: { start: Date | null; minutes: number },
  place: string | null | undefined,
  now: Date,
  request?: TimeRequest,
): string {
  const start = window.start ?? now;
  const end = new Date(start.getTime() + window.minutes * 60_000);
  const assumed = window.start ? assumedDay(request, start) : null;
  const text = !window.start
    ? `Now–${clockParts(end).join(" ")}`
    : assumed
      ? `${assumed}, ${windowText(start, end)}`
      : `${dayPrefix(start, now)}${windowText(start, end)}`;
  return place ? `${text}, near ${place}` : text;
}

/**
 * What the plan assumed, in one line: the window and the place.
 * Single spot: the start its options carry — now when none is set — for
 * the recommended option's stay, and its destination (tools.ts builds the
 * same line straight from the search, `windowAssumption`). Itinerary:
 * "Mon 3 stops, 10:00 AM–4:30 PM". A "no" card keeps the line it was
 * built with.
 */
export function assumptionsFor(
  plan: AssistantPlanBody,
  now: Date,
  request?: TimeRequest,
): string | null {
  if (plan.kind === "none_meets" || plan.kind === "no_data") return plan.assumptions ?? null;
  if (plan.kind === "itinerary") {
    const arrivals = plan.stops
      .map((s) => ({ at: parseEasternTime(s.arrival), minutes: s.durationMinutes }))
      .filter((s): s is { at: Date; minutes: number } => s.at !== null)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = arrivals[0];
    const last = arrivals[arrivals.length - 1];
    if (!first || !last) return null;
    const end = new Date(last.at.getTime() + last.minutes * 60_000);
    const stops = `${plan.stops.length} ${plan.stops.length === 1 ? "stop" : "stops"}`;
    return `${dayPrefix(first.at, now)}${stops}, ${windowText(first.at, end)}`.trim();
  }
  const rec = plan.options.find((o) => o.recommended) ?? plan.options[0];
  if (!rec) return null;
  const startsAt = plan.options.map((o) => o.startsAt).find((s): s is string => !!s);
  return windowAssumption(
    { start: startsAt ? parseEasternTime(startsAt) : null, minutes: rec.durationMinutes },
    plan.destination?.label,
    now,
    request,
  );
}
