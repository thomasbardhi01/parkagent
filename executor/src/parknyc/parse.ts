/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * Result mapping: pure functions from a confirmation screen's visible text
 * to the executor's success shape (provider session id, expiry, amount).
 * Pure so they are unit-testable against recorded fixture HTML.
 *
 * Patterns were drafted from the obvious receipt wording and MUST be tuned
 * against a real recorded confirmation page before first live use.
 */

export interface ParsedConfirmation {
  providerSessionId: string;
  expiresAt: Date;
  amountUsd: number;
}

// "Confirmation #ABC123", "Session number: 987654", "Receipt no. X-42".
const SESSION_ID =
  /(?:confirmation|session|receipt)\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i;

// "Expires at 5:30 PM", "Valid until 17:05", "Ends 11:59 PM".
const EXPIRY_TIME =
  /(?:expires?(?:\s+at)?|valid\s+(?:until|through)|ends?(?:\s+at)?)\s*:?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i;

// Prefer the labeled total; fall back to the last dollar amount on the page.
const LABELED_TOTAL = /total[^$\n]{0,40}\$\s*(\d+(?:\.\d{2})?)/i;
const ANY_AMOUNT = /\$\s*(\d+(?:\.\d{2})?)/g;

/**
 * ParkNYC shows wall-clock times in the meter's timezone (NYC). Convert a
 * NYC wall time to an instant, regardless of the machine's own TZ, using
 * the toLocaleString round-trip trick (minute precision, fine here).
 */
export function nycWallTime(base: Date, hours: number, minutes: number): Date {
  // The NYC calendar date at `base` (which can differ from the UTC date).
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(base);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const guess = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), hours, minutes));
  // How far NYC sits behind UTC at that instant; both renderings are parsed
  // in the machine's local TZ, so the machine's own offset cancels out.
  const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const asNyc = new Date(guess.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return new Date(guess.getTime() + (asUtc.getTime() - asNyc.getTime()));
}

/**
 * Pull an expiry instant out of confirmation text. Times without a date are
 * read as the next occurrence of that NYC wall time at or after `now`
 * (a session never expires in the past).
 */
export function parseExpiresAt(text: string, now: Date): Date | null {
  const m = EXPIRY_TIME.exec(text);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  let at = nycWallTime(now, hours, minutes);
  // Tolerate small clock skew before rolling to tomorrow.
  if (at.getTime() < now.getTime() - 5 * 60_000) {
    at = new Date(at.getTime() + 86_400_000);
  }
  return at;
}

export function parseAmountUsd(text: string): number | null {
  const labeled = LABELED_TOTAL.exec(text);
  if (labeled) return Number(labeled[1]);
  let last: string | null = null;
  for (const m of text.matchAll(ANY_AMOUNT)) last = m[1] ?? null;
  return last === null ? null : Number(last);
}

export function parseSessionId(text: string): string | null {
  const m = SESSION_ID.exec(text);
  return m?.[1] ?? null;
}

/**
 * The whole confirmation screen → success shape, or null when any of the
 * three pieces is missing (the caller then reports ui_changed with the
 * page attached, rather than inventing numbers).
 */
export function parseConfirmation(text: string, now: Date): ParsedConfirmation | null {
  const providerSessionId = parseSessionId(text);
  const expiresAt = parseExpiresAt(text, now);
  const amountUsd = parseAmountUsd(text);
  if (providerSessionId === null || expiresAt === null || amountUsd === null) return null;
  return { providerSessionId, expiresAt, amountUsd };
}
