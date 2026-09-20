/**
 * Result-mapping unit tests: confirmation text → {providerSessionId,
 * expiresAt, amountUsd}. Pure functions, no browser, ParkNYC never touched.
 */

import { expect, test } from "vitest";

import {
  parseAmountUsd,
  parseConfirmation,
  parseExpiresAt,
  parseSessionId,
} from "../src/parknyc/parse.js";

// A summer Saturday, 18:00 UTC = 14:00 in NYC (EDT).
const NOW = new Date("2026-06-20T18:00:00Z");

/** The parsed instant rendered back as an NYC wall-clock string. */
function inNyc(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

test("a receipt-shaped confirmation parses completely", () => {
  const text = [
    "You're parked!",
    "Confirmation #PNYC-88213",
    "Zone 110436 · ABC1234",
    "Expires at 3:30 PM",
    "Meter $3.50  Fee $0.15",
    "Total $3.65",
  ].join("\n");
  const parsed = parseConfirmation(text, NOW);
  expect(parsed).not.toBeNull();
  expect(parsed!.providerSessionId).toBe("PNYC-88213");
  expect(parsed!.amountUsd).toBe(3.65);
  expect(inNyc(parsed!.expiresAt)).toBe("3:30 PM");
  expect(parsed!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
});

test("expiry times are NYC wall clock and never in the past", () => {
  // 3:30 PM is ahead of the 2:00 PM "now" — same day.
  const sameDay = parseExpiresAt("Expires at 3:30 PM", NOW)!;
  expect(sameDay.getTime() - NOW.getTime()).toBe(90 * 60_000);
  // 9:00 AM already passed today — rolls to tomorrow morning.
  const nextDay = parseExpiresAt("Valid until 9:00 AM", NOW)!;
  expect(nextDay.getTime()).toBeGreaterThan(NOW.getTime());
  expect(inNyc(nextDay)).toBe("9:00 AM");
});

test("24-hour times parse without a meridiem", () => {
  const at = parseExpiresAt("ends 17:05", NOW)!;
  expect(inNyc(at)).toBe("5:05 PM");
});

test("the labeled total wins over other amounts on the page", () => {
  const text = "Meter $3.50\nFee $0.15\nTotal: $3.65\nWallet balance $25.00";
  expect(parseAmountUsd(text)).toBe(3.65);
});

test("without a label, the last dollar amount is used", () => {
  expect(parseAmountUsd("Meter $3.50 plus fee $0.15")).toBe(0.15);
  expect(parseAmountUsd("no dollars here")).toBeNull();
});

test("session ids need a labelled anchor, not any code-looking string", () => {
  expect(parseSessionId("Receipt no. 987654")).toBe("987654");
  expect(parseSessionId("Session ID: AB-12345")).toBe("AB-12345");
  expect(parseSessionId("totally unrelated words")).toBeNull();
});

test("a page missing any piece refuses to parse (caller reports ui_changed)", () => {
  expect(parseConfirmation("Confirmation #X12345 Total $3.65", NOW)).toBeNull(); // no expiry
  expect(parseConfirmation("Expires at 3:30 PM Total $3.65", NOW)).toBeNull(); // no id
  expect(parseConfirmation("Confirmation #X12345 Expires at 3:30 PM", NOW)).toBeNull(); // no amount
});
