/**
 * Enforcement-hours arithmetic. Zone hours come from data/build_zones.py as
 * [{days: ["Mon", ...], start: "HH:MM", end: "HH:MM"}] in NYC wall-clock
 * time; end may be "24:00". An empty array means the city posts no hours for
 * the face, which we treat as always enforced (the conservative reading for
 * quoting).
 */

export interface HoursInterval {
  days: string[];
  start: string; // "HH:MM"
  end: string; // "HH:MM", up to "24:00"
}

const NYC_TZ = "America/New_York";

// Reused across per-minute loops; constructing Intl formatters is the
// expensive part, formatToParts is cheap.
const nycClock = new Intl.DateTimeFormat("en-US", {
  timeZone: NYC_TZ,
  weekday: "short", // "Mon" ... "Sun", same tokens the dataset uses
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nycWeekdayAndMinute(at: Date): { weekday: string; minute: number } {
  let weekday = "";
  let hour = 0;
  let minute = 0;
  for (const part of nycClock.formatToParts(at)) {
    if (part.type === "weekday") weekday = part.value;
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { weekday, minute: hour * 60 + minute };
}

function toMinute(clock: string): number {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return h * 60 + m;
}

/** Is the meter enforced at this instant? Empty hours = always enforced. */
export function isEnforcedAt(hours: HoursInterval[], at: Date): boolean {
  if (hours.length === 0) return true;
  const { weekday, minute } = nycWeekdayAndMinute(at);
  return hours.some(
    (interval) =>
      interval.days.includes(weekday) &&
      minute >= toMinute(interval.start) &&
      minute < toMinute(interval.end),
  );
}

/**
 * Minute-by-minute enforcement over [from, from + minutes). Index i covers
 * the minute starting at from + i minutes. (Per-minute sampling is O(stay)
 * with stays of at most a few hundred minutes — not worth interval algebra.)
 */
export function enforcementProfile(hours: HoursInterval[], from: Date, minutes: number): boolean[] {
  const profile: boolean[] = [];
  for (let i = 0; i < minutes; i++) {
    profile.push(isEnforcedAt(hours, new Date(from.getTime() + i * 60_000)));
  }
  return profile;
}

/**
 * The posted intervals that apply on the local day containing `at`, as
 * plain "HH:MM"-"HH:MM" pairs — what the map card shows for "today".
 * Empty hours (nothing posted) yields one all-day interval, matching how
 * isEnforcedAt reads them.
 */
export function todaysIntervals(
  hours: HoursInterval[],
  at: Date,
): { start: string; end: string }[] {
  if (hours.length === 0) return [{ start: "00:00", end: "24:00" }];
  const { weekday } = nycWeekdayAndMinute(at);
  return hours
    .filter((interval) => interval.days.includes(weekday))
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => toMinute(a.start) - toMinute(b.start));
}

/**
 * Start of the NYC calendar day containing `at`, as a UTC instant — the
 * window for daily-cap accounting. Derived by subtracting the local
 * wall-clock time; off by an hour on the two DST-transition days, which is
 * fine for a spending cap.
 */
export function nycStartOfDay(at: Date): Date {
  const { minute } = nycWeekdayAndMinute(at);
  const seconds = at.getUTCSeconds() + at.getUTCMilliseconds() / 1000;
  return new Date(at.getTime() - minute * 60_000 - seconds * 1000);
}

const nycDayOfMonth = new Intl.DateTimeFormat("en-US", {
  timeZone: NYC_TZ,
  day: "numeric",
});

/**
 * Start of the NYC calendar month containing `at`, as a UTC instant — the
 * window for month-to-date card spend. Same DST caveat as nycStartOfDay:
 * a month spanning a transition is off by an hour, fine for a display sum.
 */
export function nycStartOfMonth(at: Date): Date {
  const dayOfMonth = Number(nycDayOfMonth.format(at));
  return new Date(nycStartOfDay(at).getTime() - (dayOfMonth - 1) * 24 * 60 * 60_000);
}

const nycWallClock = new Intl.DateTimeFormat("en-US", {
  timeZone: NYC_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function nycParts(at: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of nycWallClock.formatToParts(at)) parts[part.type] = part.value;
  return parts;
}

/** Minutes east of UTC in NYC at `at` (-240 in summer, -300 in winter). */
function nycOffsetMinutes(at: Date): number {
  const p = nycParts(at);
  const asUtc = Date.UTC(
    Number(p["year"]),
    Number(p["month"]) - 1,
    Number(p["day"]),
    Number(p["hour"]),
    Number(p["minute"]),
    Number(p["second"]),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

const EXPLICIT_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * A model- or client-supplied timestamp as an instant. An explicit offset
 * or "Z" is honored as written. An offset-less "YYYY-MM-DDTHH:mm[:ss]" is
 * NYC wall-clock time — both cities are Eastern and the model is handed
 * the current time in ET — never the host's own zone: `new Date()` on an
 * offset-less string reads it as UTC on Fly and as ET on a dev Mac, so the
 * same string meant two instants four hours apart and only prod was wrong.
 * Anything else unreadable → null.
 */
export function parseEasternTime(value: string): Date | null {
  const text = value.trim();
  if (EXPLICIT_ZONE.test(text)) {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const m = WALL_CLOCK.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC rolls month 13 into next year; a field out of range is a
  // garbled time, not a date to guess at.
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  // Guess with the offset at that wall time read as UTC, then re-check at
  // the result (the two differ only across a DST transition).
  let at = asUtc - nycOffsetMinutes(new Date(asUtc)) * 60_000;
  at = asUtc - nycOffsetMinutes(new Date(at)) * 60_000;
  return new Date(at);
}

/** NYC wall-clock "YYYY-MM-DDTHH:mm:ss" (no offset) for an instant. */
export function easternWallClock(at: Date): string {
  const p = nycParts(at);
  return `${p["year"]}-${p["month"]}-${p["day"]}T${p["hour"]}:${p["minute"]}:${p["second"]}`;
}

/** ISO 8601 with NYC's own offset ("2026-09-26T18:00:00-04:00") — the one
 * canonical form model-supplied times are stored and forwarded in. */
export function easternIso(at: Date): string {
  const offset = nycOffsetMinutes(at);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${easternWallClock(at)}${sign}${hh}:${mm}`;
}
