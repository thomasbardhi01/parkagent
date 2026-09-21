/**
 * PERSONAL-USE PROTOTYPE — see ../types.ts header and issue #37.
 *
 * Pure functions over Passport screens: recognizing the Enter Zone screen
 * (the app's only zone entry — there is no map, per the 2026-09-21
 * recording), and reading the zone info panel (zone number + street) the
 * app may show after a zone is submitted. Pure so they are unit-testable
 * against fixture HTML — no browser, no provider.
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

/** The Enter Zone screen, as the client's selectors see it. */
export interface ZoneEntryScreen {
  /** The zone-number input's id is present (#zoneNumber). */
  hasZoneNumberInput: boolean;
  /** The Continue button's id is present (#zoneNext). */
  hasContinueButton: boolean;
  /** The instruction label ("Enter the zone number posted…"). */
  label: string | null;
}

/**
 * Recognize the Enter Zone screen in raw page HTML — the exact ids the
 * client types into (#zoneNumber) and clicks (#zoneNext). Null when
 * neither id is present (not this screen). Verified against the
 * 2026-09-21 recording (test/fixtures/pages/passport/zone-entry.html).
 */
export function parseZoneEntryHtml(html: string): ZoneEntryScreen | null {
  const hasZoneNumberInput = /<input[^>]*id=["']zoneNumber["']/i.test(html);
  const hasContinueButton = /<button[^>]*id=["']zoneNext["']/i.test(html);
  if (!hasZoneNumberInput && !hasContinueButton) return null;
  const label = /for=["']zoneNumber["'][^>]*>([\s\S]*?)<\//i.exec(html)?.[1];
  return {
    hasZoneNumberInput,
    hasContinueButton,
    label: label === undefined ? null : visibleTextFromHtml(label),
  };
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


/** One zone from the Find Parking map feed (getnearzoneswithoccupancy). */
export interface NearbyZone {
  /** The pay-by-app zone number a driver enters — what our dataset lacks. */
  number: string;
  /** Block description, e.g. "North Boylston between Dartmouth and Clarendon". */
  name: string;
  /** Coarse in this feed (~1 km grid) — match by name, not by point. */
  latitude: number | null;
  longitude: number | null;
  distanceFeet: number | null;
}

/** Extract usable (number, name) rows from a getnearzoneswithoccupancy
 * response body. Total function: a row without a number/name is skipped. */
export function parseNearbyZones(body: unknown): NearbyZone[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: NearbyZone[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const number = r["number"] === undefined || r["number"] === null ? "" : String(r["number"]).trim();
    const name = typeof r["name"] === "string" ? r["name"].trim() : "";
    if (number === "" || name === "") continue;
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      number,
      name,
      latitude: num(r["latitude"]),
      longitude: num(r["longitude"]),
      distanceFeet: num(r["distanceinfeet"]),
    });
  }
  return out;
}


/** True when the given page HTML is the "Add Payment Details" screen —
 * the card-entry form the start flow lands on when the account has no
 * saved payment method (header #updateCardWindowHeader + the #cardNumber
 * / #saveCard form). Pure so it's testable against the recorded fixture. */
export function isAddPaymentScreen(html: string): boolean {
  const hasHeader = /id="updateCardWindowHeader"[^>]*>\s*Add Payment Details/i.test(html);
  const hasForm = /id="cardNumber"/.test(html) && /id="saveCard"/.test(html);
  return hasHeader && hasForm;
}


/** State of the Enter Zone recent-zones panel in a page's HTML — the
 * element that pops on input focus and, when visible with chips, can
 * overlay the Continue button (the 2026-09-21 regression). Pure, so the
 * flow's dismiss logic and the fixture test share one reading. */
export function recentZonesState(html: string): {
  present: boolean;
  visible: boolean;
  chips: string[];
} {
  const m = /<div id="recentZones"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (!m) return { present: false, visible: false, chips: [] };
  const openTag = /<div id="recentZones"[^>]*>/.exec(html)?.[0] ?? "";
  const hidden = /style="[^"]*display:\s*none/i.test(openTag);
  const chips = [...m[1]!.matchAll(/<button[^>]*>\s*([^<]+?)\s*<\/button>/g)].map((c) => c[1]!.trim());
  return { present: true, visible: !hidden && chips.length > 0, chips };
}


/** True when the HTML shows the optional "Review Signage" interstitial —
 * a popup/dialog with signage/meter-hours/restrictions text AND both a
 * Continue and a Cancel action. Structure + keyword (the banner text is
 * operator-configured), so it won't fire on the inline zoneWarningMessage
 * label. Pure, for the fixture test. */
export function isSignageModal(html: string): boolean {
  const popup = /<[^>]*(?:data-role="popup"|class="[^"]*ui-popup|role="dialog")[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  const scope = popup ? popup[0] : html;
  const isPopupish = /data-role="popup"|ui-popup|role="dialog"/i.test(scope);
  const mentionsSignage = /signage|meter hours|parking restrictions/i.test(scope);
  const hasContinue = /(continue|i understand|got it)</i.test(scope);
  const hasCancel = /(cancel|not now|go back)</i.test(scope);
  return isPopupish && mentionsSignage && hasContinue && hasCancel;
}


/** True when the HTML shows a settled jQuery Mobile page: a .ui-page-active
 * exists and no .ui-page carries a transition token (in/out/slide/…). The
 * runtime stableClick waits for this AND a stable bounding box; this pure
 * mirror lets the settle condition be unit-tested. */
export function activePageSettled(html: string): boolean {
  const TOKENS = ["in", "out", "slide", "slideup", "slidedown", "fade", "pop", "flip", "turn"];
  const pages = [...html.matchAll(/<div[^>]*class="([^"]*\bui-page\b[^"]*)"[^>]*>/g)].map(
    (m) => m[1]!.split(/\s+/),
  );
  if (!pages.some((cls) => cls.includes("ui-page-active"))) return false;
  return !pages.some((cls) => cls.some((c) => TOKENS.includes(c)));
}
