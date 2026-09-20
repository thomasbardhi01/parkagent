/**
 * PERSONAL-USE PROTOTYPE — see ../types.ts header and issue #37.
 *
 * Pure functions for the Passport map-based zone resolution: reading the
 * zone info panel (zone number + street) and deciding whether the panel's
 * street matches the street our zone data carries. Pure so they are
 * unit-testable against fixture HTML — no browser, no provider.
 *
 * Receipt parsing (confirmation number, expiry, amount) is shared with the
 * ParkNYC client (../parknyc/parse.js): Boston is also America/New_York
 * wall-clock, and the receipt patterns are generic. Tune both against real
 * recordings.
 */

import { visibleTextFromHtml } from "../parknyc/classify.js";

/** What the provider's zone panel said about one zone. */
export interface ZonePanel {
  zoneNumber: string;
  /** The zone's name — for street parking this is the street/block. */
  street: string;
}

// "Zone Number: 81234", "Zone # 81234", "Zone 81234". The exact label
// wording comes from the app's Strings table — TODO-verify on a recording.
const ZONE_NUMBER = /zone\s*(?:number|no\.?|#|id)?\s*[:#]?\s*(\d{3,10})/i;

export function parseZoneNumberText(text: string): string | null {
  const m = ZONE_NUMBER.exec(text);
  return m?.[1] ?? null;
}

/**
 * Extract the zone panel from raw page HTML via the app's stable element
 * ids (#zi_zoneno / #zi_zoneName, from zone-info.js). Used by the fixture
 * tests and as the client's fallback when reading elements one by one.
 */
export function parseZoneInfoHtml(html: string): ZonePanel | null {
  const field = (id: string): string | null => {
    const m = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)</`, "i").exec(html);
    return m?.[1] === undefined ? null : visibleTextFromHtml(m[1]);
  };
  const zoneNoText = field("zi_zoneno");
  const street = field("zi_zoneName");
  if (zoneNoText === null || street === null || street.length === 0) return null;
  const zoneNumber = parseZoneNumberText(zoneNoText);
  if (zoneNumber === null) return null;
  return { zoneNumber, street };
}

// Suffixes canonicalized so "BOYLSTON STREET" matches our data's
// "BOYLSTON ST" (Analyze Boston abbreviates; Passport may not).
const SUFFIXES: Record<string, string> = {
  STREET: "ST",
  AVENUE: "AV",
  AVE: "AV",
  BOULEVARD: "BLVD",
  ROAD: "RD",
  DRIVE: "DR",
  PLACE: "PL",
  SQUARE: "SQ",
  COURT: "CT",
  TERRACE: "TER",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  LANE: "LN",
  CIRCLE: "CIR",
};

/**
 * Uppercase, drop parentheticals ("(North Side)"), strip punctuation,
 * canonicalize suffix words, collapse whitespace.
 */
export function normalizeStreet(street: string): string {
  return street
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => SUFFIXES[token] ?? token)
    .join(" ");
}

/**
 * Does the provider panel's street agree with the street our zone data
 * carries? Containment either way, so "BOYLSTON ST" matches Passport's
 * "Boylston Street (Copley Square)" and vice versa. Empty on either side
 * is never a match — the caller decides whether "uncheckable" blocks.
 */
export function streetsMatch(expectedStreet: string, panelStreet: string): boolean {
  const a = normalizeStreet(expectedStreet);
  const b = normalizeStreet(panelStreet);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
}
