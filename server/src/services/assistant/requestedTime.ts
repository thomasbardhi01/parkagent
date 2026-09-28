/**
 * The clock time a message asks for, read before the model sees it, so a
 * requested time is never quietly changed. Nightly 36361125345 asked "at
 * 7 PM" at 8:11 PM: the tools bounced 7 PM today as a window in the past,
 * told the model to recompute from the current time, and the plan came
 * back 8:11–11:11 PM — the user's 7 PM silently replaced with "now".
 *
 * A clock time the user names with no day ("at 7 PM", "7:30pm", "19:00",
 * "7-10 PM", "noon") means today if it's still ahead (or began less than
 * 15 minutes ago), and otherwise its NEXT occurrence — tomorrow. "Tonight"
 * asked between midnight and 5 AM means the coming evening, not now. The
 * loop states the reading on the model's message (requestedTimeLine), the
 * tools refuse a plan or quote that moves it (requestedTimeProblem), the
 * card says what was assumed ("Assuming tomorrow, 7:00–10:00 PM"), and a
 * question about it comes with its two answers (Tomorrow at 7 PM / Now).
 *
 * A message that names a day ("tomorrow at 7", "Friday at 7 PM", "Oct 3")
 * isn't read here: the model computes the date, and the tools' past-window
 * guard still catches a wrong one.
 */

import { easternIso, nycStartOfDay, parseEasternTime } from "../hours.js";
import type { Suggestion } from "./tools.js";

/** A clock time the user asked for, with no day named. */
export interface RequestedClockTime {
  kind: "clock";
  /** Tidied from the user's words: "7 PM", "7:30 PM", "noon". */
  label: string;
  hour: number;
  minute: number;
  /** later_today: still ahead today (or began within the grace);
   * passed: over 15 minutes ago today, so it means tomorrow. */
  status: "later_today" | "passed";
  /** When the clock next reads it (ET): today, or tomorrow when passed. */
  next: Date;
}

/** "Tonight" (or "this evening") asked between midnight and 5 AM. */
export interface TonightAfterMidnight {
  kind: "tonight";
  /** 7 PM this coming evening (ET) — the sensible start if none is given. */
  evening: Date;
  /** The earliest start that still reads as "this evening". */
  eveningFrom: Date;
}

export type TimeRequest = RequestedClockTime | TonightAfterMidnight;

/** A requested time that began this recently still means today. */
const GRACE_MS = 15 * 60_000;
/** How far a plan's start may sit from the requested time. */
const TOLERANCE_MS = 30 * 60_000;

const DAY_NAMED = new RegExp(
  [
    String.raw`\b(tomorrow|tmrw|tmr|yesterday|weekend|next week)\b`,
    String.raw`\b(mon|tues?|wed(nes)?|thu(rs?)?|fri|satur|sun)day\b`,
    String.raw`\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri)\b\.?`,
    String.raw`\b\d{1,2}/\d{1,2}\b`,
    String.raw`\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b`,
    String.raw`\bthe\s+\d{1,2}(st|nd|rd|th)\b`,
    String.raw`\bin\s+\d+\s+(days?|weeks?)\b`,
  ].join("|"),
  "i",
);
const TONIGHT = /\b(tonight|this evening)\b/i;
/** "7-10 PM", "7 to 10pm": the start takes the end's meridiem. */
const RANGE =
  /\b(\d{1,2})(?::([0-5]\d))?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/i;
const MERIDIEM = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/i;
/** 24-hour "19:00": only hours 13–23 (a bare "7:30" could be either). */
const TWENTY_FOUR = /\b(1[3-9]|2[0-3]):([0-5]\d)\b/;
const NOON_MIDNIGHT = /\b(noon|midday|midnight)\b/i;

const etDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const etHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});
const etDayLong = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const etClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const two = (n: number) => String(n).padStart(2, "0");

/** hh:mm ET on the calendar day `daysAhead` after `now`'s (DST-safe). */
function easternAt(now: Date, daysAhead: number, hour: number, minute: number): Date {
  // Start of today + 12 h + whole days lands mid-day on the right date
  // whatever the DST shift in between.
  const midday = new Date(nycStartOfDay(now).getTime() + (12 + 24 * daysAhead) * 3_600_000);
  return parseEasternTime(`${etDate.format(midday)}T${two(hour)}:${two(minute)}:00`)!;
}

function clockLabel(hour: number, minute: number): string {
  if (minute === 0 && hour === 12) return "noon";
  if (minute === 0 && hour === 0) return "midnight";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "AM" : "PM";
  return minute === 0 ? `${h12} ${suffix}` : `${h12}:${two(minute)} ${suffix}`;
}

function to24(hour12: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === "p";
  if (hour12 === 12) return pm ? 12 : 0;
  return pm ? hour12 + 12 : hour12;
}

interface ClockToken {
  index: number;
  end: number;
  hour: number;
  minute: number;
}

/** Every clock time in the text that names its own half of the day. */
function clockTokens(text: string): ClockToken[] {
  const found: ClockToken[] = [];
  const scan = (
    pattern: RegExp,
    read: (m: RegExpExecArray) => { hour: number; minute: number } | null,
  ) => {
    for (const m of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      const time = read(m as RegExpExecArray);
      if (time) found.push({ index: m.index!, end: m.index! + m[0].length, ...time });
    }
  };
  scan(MERIDIEM, (m) => {
    const hour12 = Number(m[1]);
    return hour12 >= 1 && hour12 <= 12
      ? { hour: to24(hour12, m[3]!), minute: Number(m[2] ?? 0) }
      : null;
  });
  scan(TWENTY_FOUR, (m) => ({ hour: Number(m[1]), minute: Number(m[2]) }));
  scan(NOON_MIDNIGHT, (m) => ({ hour: m[1]!.toLowerCase() === "midnight" ? 0 : 12, minute: 0 }));
  return found.sort((a, b) => a.index - b.index);
}

/**
 * The one clock time the text asks for: a single time, or the start of a
 * window ("7-10 PM", "7 PM to 10 PM"). Several unrelated times ("lunch at
 * noon, dinner at 7 PM") are a day's plan, read by the model — null.
 */
function firstClock(text: string): { hour: number; minute: number } | null {
  const range = RANGE.exec(text);
  if (range) {
    const [, sh, sm, eh, , mer] = range;
    const start = Number(sh);
    const end = Number(eh);
    if (start >= 1 && start <= 12 && end >= 1 && end <= 12) {
      // "11-1 PM" starts in the morning; "7-10 PM" in the evening.
      let meridiem = mer!;
      if (start > end && end !== 12) meridiem = meridiem.toLowerCase() === "p" ? "a" : "p";
      return { hour: to24(start, meridiem), minute: Number(sm ?? 0) };
    }
  }
  const tokens = clockTokens(text);
  if (tokens.length === 1) return tokens[0]!;
  if (
    tokens.length === 2 &&
    /^\s*(?:-|–|—|to|until|till|through)\s*$/i.test(text.slice(tokens[0]!.end, tokens[1]!.index))
  ) {
    return tokens[0]!;
  }
  return null;
}

/** What time the message asks for, or null when it names none (or names
 * a day, which the model reads itself). */
export function requestedTimeIn(text: string, now: Date): TimeRequest | null {
  if (DAY_NAMED.test(text)) return null;
  const clock = firstClock(text);
  if (clock) {
    const today = easternAt(now, 0, clock.hour, clock.minute);
    const passed = now.getTime() - today.getTime() > GRACE_MS;
    return {
      kind: "clock",
      label: clockLabel(clock.hour, clock.minute),
      hour: clock.hour,
      minute: clock.minute,
      status: passed ? "passed" : "later_today",
      next: passed ? easternAt(now, 1, clock.hour, clock.minute) : today,
    };
  }
  if (TONIGHT.test(text) && Number(etHour.format(now)) < 5) {
    return {
      kind: "tonight",
      evening: easternAt(now, 0, 19, 0),
      eveningFrom: easternAt(now, 0, 16, 0),
    };
  }
  return null;
}

function clockOf(at: Date): string {
  return etClock.format(at).replace(/\u202f/g, " ");
}

/** The line the loop adds to the model's copy of the message. */
export function requestedTimeLine(request: TimeRequest, now: Date): string {
  if (request.kind === "tonight") {
    return (
      `[requested time: "tonight", asked at ${clockOf(now)} — that means this coming evening, ` +
      `${etDayLong.format(request.evening)} (e.g. 7:00 PM = ${easternIso(request.evening)}), not now. ` +
      `Plan for this evening — the card will say "Assuming this evening" — or ask with ask_user ` +
      `("This evening" / "Now"). Don't plan for now.]`
    );
  }
  const iso = easternIso(request.next);
  if (request.status === "later_today") {
    return `[requested time: ${request.label} — later today, ${etDayLong.format(request.next)} (${iso}). Plan for exactly that time.]`;
  }
  return (
    `[requested time: ${request.label} — it's ${clockOf(now)}, so ${request.label} today has already passed; ` +
    `its next occurrence is tomorrow, ${etDayLong.format(request.next)} ${clockOf(request.next)} (${iso}). ` +
    `Plan for that — the card will say "Assuming tomorrow" — or ask with ask_user ` +
    `("Tomorrow at ${request.label}" / "Now"). Never move it to now.]`
  );
}

/**
 * Why a window starting at `start` doesn't honor the request — the
 * instruction the tool hands back — or null when it does. A plan or quote
 * for "now" when the user named a time is refused: the user decides that,
 * by answering the question. `earlierOnly` is the quote tools' check: a
 * later window can be another stop of a day, so only a start before the
 * request is refused there; a single-spot plan must start at it.
 */
export function requestedTimeProblem(
  request: TimeRequest | undefined,
  start: Date,
  now: Date,
  options: { earlierOnly?: boolean } = {},
): string | null {
  if (!request) return null;
  if (request.kind === "tonight") {
    const endOfDay = easternAt(now, 1, 0, 0);
    const early = start.getTime() < request.eveningFrom.getTime();
    const late = !options.earlierOnly && start.getTime() >= endOfDay.getTime();
    if (!early && !late) return null;
    return (
      `The user asked for "tonight" at ${clockOf(now)}: that's this coming evening, ` +
      `${etDayLong.format(request.evening)} (e.g. ${easternIso(request.evening)}), and this window starts ` +
      `${easternIso(start)}. Quote and propose for this evening, or ask with ask_user ("This evening" / "Now"). ` +
      "Don't plan for now unless they say so."
    );
  }
  const offBy = start.getTime() - request.next.getTime();
  if (offBy >= -TOLERANCE_MS && (options.earlierOnly || offBy <= TOLERANCE_MS)) return null;
  if (request.status === "later_today") {
    return (
      `The user asked for ${request.label} today (${easternIso(request.next)}), and this window starts ` +
      `${easternIso(start)}. Quote and propose for ${request.label} — don't move the time they asked for.`
    );
  }
  return (
    `The user asked for ${request.label}. It's ${clockOf(now)}, so ${request.label} today has passed; its next ` +
    `occurrence is tomorrow, ${easternIso(request.next)}, and this window starts ${easternIso(start)}. ` +
    `Quote and propose for tomorrow at ${request.label} — the card will say "Assuming tomorrow" — or ask with ` +
    `ask_user ("Tomorrow at ${request.label}" / "Now"). Never move a requested time to now.`
  );
}

/** How the card states a reading the user didn't spell out, or null. */
export function assumedDay(request: TimeRequest | undefined, start: Date): string | null {
  if (!request) return null;
  if (request.kind === "tonight") return "Assuming this evening";
  if (request.status === "passed" && etDate.format(start) === etDate.format(request.next)) {
    return "Assuming tomorrow";
  }
  return null;
}

/** The two answers to "tomorrow, or now?" when the model asks in prose. */
export function requestedTimeChoices(request: TimeRequest | undefined): Suggestion[] | null {
  if (!request) return null;
  if (request.kind === "tonight") {
    return [
      { label: "This evening", reply: "This evening" },
      { label: "Now", reply: "Now" },
    ];
  }
  if (request.status !== "passed") return null;
  return [
    { label: `Tomorrow at ${request.label}`, reply: `Tomorrow at ${request.label}` },
    { label: "Now", reply: "Now" },
  ];
}
