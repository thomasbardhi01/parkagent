/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * Error classification: pure functions from an exception + the page's
 * visible text to one of the typed executor error codes. Pure so they are
 * unit-testable against recorded fixture HTML — no browser, no ParkNYC.
 */

import type { ExecutorErrorCode } from "../types.js";

// Patterns are drafted from the obvious wording and tuned against recorded
// fixtures (see README). Keep them tight enough not to misfire on words that
// appear on every page (e.g. a "Log out" header link must not read as a
// sign-in screen).
// A bot-check wall. Checked BEFORE the auth patterns: captcha pages often
// also say "please sign in", and reading one as auth_expired would wrongly
// flip the provider account to expired and push a relink — a captcha is a
// screen we can't drive, i.e. ui_changed, with the capture as evidence.
const CAPTCHA_TEXT =
  /(captcha|recaptcha|hcaptcha|verify (you are|you're|that you are) (not a robot|human)|prove you are (not a robot|human)|unusual traffic|security check to continue)/i;
const AUTH_TEXT =
  /(sign in to|log in to|session (has )?expired|please (sign|log) ?in|forgot (your )?password|invalid (email|credentials))/i;
const ZONE_TEXT =
  /(zone.{0,40}(not.{0,10}(found|recognized|valid)|invalid|unavailable)|invalid zone|check the zone number)/i;
const PAYMENT_TEXT =
  /((payment|card).{0,40}(declined|failed|unsuccessful|expired|could not be processed)|declined.{0,30}(payment|card)|insufficient funds)/i;

// The shared Chromium (or this call's context/page) died under us — not a
// provider failure at all. The executor retries once on a fresh context
// (see retry.ts) before surfacing this.
const BROWSER_CRASH_ERROR =
  /(Target (page, context or browser|closed)|browser has been (closed|disconnected)|Browser closed|Context closed|Connection closed|browserContext\.newPage: .*closed)/i;
const NETWORK_ERROR =
  /(net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|socket hang up|Navigation timeout|page\.goto)/i;
const TIMEOUT_ERROR = /Timeout \d+m?s exceeded/i;

/**
 * What the page's visible text says went wrong, independent of any thrown
 * error. Null when the text carries no recognizable failure marker.
 */
export function classifyPageText(
  text: string,
): Extract<ExecutorErrorCode, "auth_expired" | "zone_not_found" | "payment_declined"> | null {
  if (CAPTCHA_TEXT.test(text)) return null; // see CAPTCHA_TEXT: never auth_expired
  if (AUTH_TEXT.test(text)) return "auth_expired";
  if (ZONE_TEXT.test(text)) return "zone_not_found";
  if (PAYMENT_TEXT.test(text)) return "payment_declined";
  return null;
}

/**
 * Map a thrown error (usually a Playwright timeout) plus whatever the page
 * showed at that moment onto a typed code. Order matters: transport errors
 * are network regardless of page text; otherwise the page text is the best
 * witness; a bare selector timeout means the screen we expected never
 * appeared — ui_changed.
 */
export function classifyFailure(err: unknown, pageText: string | null): ExecutorErrorCode {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (BROWSER_CRASH_ERROR.test(message)) return "browser_crashed";
  if (NETWORK_ERROR.test(message)) return "network";
  if (pageText && CAPTCHA_TEXT.test(pageText)) return "ui_changed";
  if (pageText) {
    const fromText = classifyPageText(pageText);
    if (fromText) return fromText;
  }
  if (TIMEOUT_ERROR.test(message) || (err instanceof Error && err.name === "TimeoutError")) {
    return "ui_changed";
  }
  return "unknown";
}

/**
 * Crude visible-text extraction from raw HTML — for feeding recorded fixture
 * pages into classifyPageText in unit tests. At runtime the real page text
 * comes from Playwright's innerText, not from this.
 */
/** Is this thrown error the browser dying (vs a provider-side failure)? */
export function isBrowserCrash(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return BROWSER_CRASH_ERROR.test(message);
}

export function visibleTextFromHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}
