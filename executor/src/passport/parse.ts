import type { ParsedProviderHours, ProviderZoneTerms } from "../types.js";
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
    const number =
      r["number"] === undefined || r["number"] === null ? "" : String(r["number"]).trim();
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
  const chips = [...m[1]!.matchAll(/<button[^>]*>\s*([^<]+?)\s*<\/button>/g)].map((c) =>
    c[1]!.trim(),
  );
  return { present: true, visible: !hidden && chips.length > 0, chips };
}

/** True when the HTML shows the optional "Review Signage" interstitial —
 * a popup/dialog with signage/meter-hours/restrictions text AND both a
 * Continue and a Cancel action. Structure + keyword (the banner text is
 * operator-configured), so it won't fire on the inline zoneWarningMessage
 * label. Pure, for the fixture test. */
export function isSignageModal(html: string): boolean {
  // Whole-document combination (a page can hold several popups): a popup
  // container, signage/meter-hours/restrictions wording, and both a
  // Continue and a Cancel action. The structural + both-buttons
  // requirement keeps it from firing on the inline zoneWarningMessage.
  const isPopupish = /data-role="popup"|ui-popup|role="dialog"/i.test(html);
  const mentionsSignage = /signage|meter hours|parking restrictions/i.test(html);
  const hasContinue = /(continue|i understand|got it)</i.test(html);
  const hasCancel = /(cancel|not now|go back)</i.test(html);
  return isPopupish && mentionsSignage && hasContinue && hasCancel;
}

/** True when the HTML shows a settled jQuery Mobile page: a .ui-page-active
 * exists and no .ui-page carries a transition token (in/out/slide/…). The
 * runtime stableClick waits for this AND a stable bounding box; this pure
 * mirror lets the settle condition be unit-tested. */
export function activePageSettled(html: string): boolean {
  const TOKENS = ["in", "out", "slide", "slideup", "slidedown", "fade", "pop", "flip", "turn"];
  const pages = [...html.matchAll(/<div[^>]*class="([^"]*\bui-page\b[^"]*)"[^>]*>/g)].map((m) =>
    m[1]!.split(/\s+/),
  );
  if (!pages.some((cls) => cls.includes("ui-page-active"))) return false;
  return !pages.some((cls) => cls.some((c) => TOKENS.includes(c)));
}

/** True when the HTML shows the "No Meter Parking" free-period notice —
 * a popup with the after-hours wording and an Ok button. Pure. */
export function isFreePeriodModal(html: string): boolean {
  const isPopupish = /data-role="popup"|ui-popup|role="dialog"/i.test(html);
  const mentions = /no meter parking|paid parking is between/i.test(html);
  const hasOk = /(>\s*ok\s*<|>\s*okay\s*<)/i.test(html);
  return isPopupish && mentions && hasOk;
}

/**
 * True when the HTML shows ParkBoston's "Parking Denied" lockout popup —
 * the operator's repark/zone lockout (Passport strings csa_sp_repark_error
 * / csa_zone_repark_error, title csa_sp_repark_error_title "Parking
 * Denied"): "The parking operator has setup a lockout period. You are
 * within this period and are not allowed to park at this time in this
 * zone/space." Observed live 2026-09-23 after the confirm-Yes click — the
 * card was NOT charged (the operator refused before authorizing). Distinct
 * from a payment decline: the fix is to wait/move, not to add a card.
 */
export function isParkingDeniedModal(html: string): boolean {
  const isPopupish = /data-role="popup"|ui-popup|role="dialog"/i.test(html);
  const mentions = /parking denied|lockout period|not allowed to park at this time/i.test(html);
  const hasOk = /(>\s*ok\s*<|>\s*okay\s*<)/i.test(html);
  return isPopupish && mentions && hasOk;
}

export interface PassportReceipt {
  /** "Parking Fee" — the meter portion, in dollars. */
  meterUsd: number;
  /** "Convenience Fee" — ParkBoston's flat per-transaction fee. */
  feeUsd: number;
  /** "Total Fee" — what the card is charged. */
  totalUsd: number;
}

/**
 * Parse the ParkBoston receipt amounts off the "Please Confirm" dialog or
 * the active-session screen. The layout lists each fee as a label then its
 * amount (often across a line break):
 *   Parking Fee: $0.75 / Convenience Fee: $0.35 / Total Fee: $1.10
 * (ground truth: the parking-history rows for transactions 831908580 and
 * 831291617, both zone 456, and the confirm dialog captured on the
 * 2026-09-23 acceptance run). Returns the real charged amounts so the
 * server records what the card actually paid, not the pre-charge estimate.
 * Null when the Parking-Fee and Total-Fee lines aren't both present.
 */
export function parsePassportReceipt(text: string): PassportReceipt | null {
  const t = text.replace(/\s+/g, " ");
  const dollars = (label: RegExp): number | null => {
    const m = label.exec(t);
    return m ? Number(m[1]) : null;
  };
  const meterUsd = dollars(/parking fee:?\s*\$\s*(\d+\.\d{2})/i);
  const totalUsd = dollars(/total fee:?\s*\$\s*(\d+\.\d{2})/i);
  if (meterUsd === null || totalUsd === null) return null;
  // Convenience Fee may be absent on a $0 free window; default 0.
  const feeUsd = dollars(/convenience fee:?\s*\$\s*(\d+\.\d{2})/i) ?? 0;
  return { meterUsd, feeUsd, totalUsd };
}

const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Parse a provider free-period notice like "Paid parking is between
 * 8am-8pm EST Mon-Sat." into structured hours, so we can compare them
 * against our zone data. Null when the "between …-…" clause is absent. */
export function parseProviderHours(text: string): ParsedProviderHours | null {
  const t = text.replace(/\s+/g, " ");
  const m = /between\s*(\d{1,2})\s*(am|pm)\s*[-–—]\s*(\d{1,2})\s*(am|pm)/i.exec(t);
  if (!m) return null;
  const to24 = (h: number, ap: string) => {
    const hour = h % 12;
    return (ap.toLowerCase() === "pm" ? hour + 12 : hour) * 60;
  };
  const startMinutes = to24(Number(m[1]), m[2]!);
  const endMinutes = to24(Number(m[3]), m[4]!);
  const tzMatch = /\b([A-Z]{2,4}T)\b/.exec(t); // EST/EDT/etc.
  const days = parseDays(t);
  return {
    startLabel: `${m[1]}${m[2]!.toLowerCase()}`,
    endLabel: `${m[3]}${m[4]!.toLowerCase()}`,
    startMinutes,
    endMinutes,
    days,
    tz: tzMatch ? tzMatch[1]! : null,
  };
}

// ---------------------------------------------------------------------------
// The Vehicles chooser (#vehicleManagement) — the screen after Review
// Signage on the live 2026-09-22 walk (fixture passport-start-
// 2026-09-22T15-45-19-408Z): a "Please choose the vehicle you would like to
// park in Zone 456 (North Boylston between Dartmouth and Clarendon)" label,
// one button.selectVehicle per saved vehicle ("<PLATE> (<STATE>)"), an
// #addVehicleButton we never click, and a Zone Information line
// "$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm". The page div is in the DOM from boot
// (jQuery Mobile shell) with the label display:none and the list empty, so
// detection keys on the label being visible AND populated.

/** One saved-vehicle button on the Vehicles chooser. */
export interface VehicleOption {
  /** Button text exactly as shown, e.g. "ABC123 (MA)". */
  description: string;
  plate: string;
  /** Two-letter state from the trailing parenthetical; null when absent. */
  state: string | null;
}

export interface VehicleChooserScreen {
  /** Zone number from the header label ("… park in Zone 456 (…)"). */
  zoneNumber: string | null;
  /** Block/zone name from the header parenthetical. */
  zoneName: string | null;
  vehicles: VehicleOption[];
  hasAddVehicle: boolean;
  /** The Zone Information line, parsed; null when the line is absent. */
  terms: ProviderZoneTerms | null;
}

/**
 * Parse the "$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm" Zone Information line. Total
 * function: any segment that doesn't parse becomes null, never a throw —
 * the line is operator-configured and the flow must not die on wording.
 */
export function parseZoneInfoTerms(rawText: string): ProviderZoneTerms {
  const text = rawText.replace(/\s+/g, " ").trim();
  const rate = /\$\s*(\d+(?:\.\d+)?)\s*(?:\/\s*|per\s*)?h(?:ou)?r\b/i.exec(text);
  const max =
    /max(?:imum)?\.?\s*(?:stay\s*)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|min(?:ute)?s?)/i.exec(text);
  const maxStayMinutes =
    max === null
      ? null
      : Math.round(Number(max[1]) * (max[2]!.toLowerCase().startsWith("h") ? 60 : 1));

  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(
    text,
  );
  let hours: ParsedProviderHours | null = null;
  if (clock) {
    const to24 = (h: number, minutes: number, ap: string) =>
      ((ap.toLowerCase() === "pm" ? (h % 12) + 12 : h % 12) * 60 + minutes) % (24 * 60);
    const tzMatch = /\b([A-Z]{2,4}T)\b/.exec(text);
    hours = {
      startLabel: `${clock[1]}${clock[2] ? `:${clock[2]}` : ""}${clock[3]!.toLowerCase()}`,
      endLabel: `${clock[4]}${clock[5] ? `:${clock[5]}` : ""}${clock[6]!.toLowerCase()}`,
      startMinutes: to24(Number(clock[1]), Number(clock[2] ?? 0), clock[3]!),
      endMinutes: to24(Number(clock[4]), Number(clock[5] ?? 0), clock[6]!),
      days: parseDays(text),
      tz: tzMatch ? tzMatch[1]! : null,
    };
  }

  return {
    rawText: text,
    ratePerHourUsd: rate === null ? null : Number(rate[1]),
    maxStayMinutes,
    hours,
    zoneNumber: null,
    zoneName: null,
  };
}

/**
 * Recognize the POPULATED Vehicles chooser in page HTML. Null when the
 * #selectVehicleLabel is missing, hidden (display:none — the shell state on
 * every other screen), or empty. The inline <script class="template"> copy
 * of the vehicle button has an empty description and is skipped.
 */
export function parseVehicleChooser(html: string): VehicleChooserScreen | null {
  const label = /<label[^>]*id=["']selectVehicleLabel["']([^>]*)>([\s\S]*?)<\/label>/i.exec(html);
  if (!label) return null;
  if (/style=["'][^"']*display:\s*none/i.test(label[1]!)) return null;
  const labelText = visibleTextFromHtml(label[2]!);
  if (labelText.length === 0) return null;

  const header = /zone\s*#?\s*(\d{1,10})\s*(?:\(([^)]+)\))?/i.exec(labelText);

  const vehicles: VehicleOption[] = [];
  for (const m of html.matchAll(
    /<span[^>]*class=["'][^"']*vehicleDescription[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
  )) {
    const description = visibleTextFromHtml(m[1]!);
    if (description.length === 0) continue; // the template's empty copy
    const split = /^(.*?)\s*\(([A-Za-z]{2})\)$/.exec(description);
    vehicles.push({
      description,
      plate: (split?.[1] ?? description).trim(),
      state: split?.[2]?.toUpperCase() ?? null,
    });
  }

  const infoLabel = [
    ...html.matchAll(
      /<label[^>]*class=["'][^"']*zoneInfoLabel[^"']*["'][^>]*>([\s\S]*?)<\/label>/gi,
    ),
  ]
    .map((m) => visibleTextFromHtml(m[1]!))
    .find((t) => t.length > 0);

  const zoneNumber = header?.[1] ?? null;
  const zoneName = header?.[2]?.trim() ?? null;
  return {
    zoneNumber,
    zoneName,
    vehicles,
    hasAddVehicle: /id=["']addVehicleButton["']/i.test(html),
    terms:
      infoLabel === undefined ? null : { ...parseZoneInfoTerms(infoLabel), zoneNumber, zoneName },
  };
}

/** Plates as typed vs as the provider shows them: case/spacing/dashes vary. */
function canonicalPlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The chooser button matching the session's vehicle: plate must match
 * (canonicalized); when both sides carry a state it must match too. Null
 * when nothing matches — the caller returns a typed vehicle_missing.
 */
export function findVehicleOption(
  vehicles: VehicleOption[],
  wanted: { plate: string; state?: string },
): VehicleOption | null {
  const plate = canonicalPlate(wanted.plate);
  if (plate.length === 0) return null;
  return (
    vehicles.find(
      (v) =>
        canonicalPlate(v.plate) === plate &&
        (v.state === null || wanted.state === undefined || v.state === wanted.state.toUpperCase()),
    ) ?? null
  );
}

// Day tokens as providers abbreviate them: full names, 3-letter, and the
// signage shorthand Passport's Zone Information line uses ("M-Sat").
// Longest-first so "Sat" wins over "Sa" and "M" never eats "Mon".
const DAY_TOKEN =
  "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|su|sa|tu|th|m|w|f";

function normalizeDayToken(token: string): string | null {
  const t = token.toLowerCase();
  if (t.startsWith("su")) return "Sun";
  if (t.startsWith("sa")) return "Sat";
  if (t.startsWith("tu")) return "Tue";
  if (t.startsWith("th")) return "Thu";
  if (t.startsWith("m")) return "Mon";
  if (t.startsWith("w")) return "Wed";
  if (t.startsWith("f")) return "Fri";
  return null;
}

/** "Mon-Sat" / "M-Sat" → the inclusive run; [] when no day range appears. */
function parseDays(text: string): string[] {
  const range = new RegExp(`\\b(${DAY_TOKEN})\\s*[-–—]\\s*(${DAY_TOKEN})\\b`, "i").exec(text);
  if (range) {
    const a = DAY_ORDER.indexOf(normalizeDayToken(range[1]!) ?? "");
    const b = DAY_ORDER.indexOf(normalizeDayToken(range[2]!) ?? "");
    if (a >= 0 && b >= 0) {
      const out: string[] = [];
      for (let i = a; ; i = (i + 1) % 7) {
        out.push(DAY_ORDER[i]!);
        if (i === b) break;
      }
      return out;
    }
  }
  return [];
}
