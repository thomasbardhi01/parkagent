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
