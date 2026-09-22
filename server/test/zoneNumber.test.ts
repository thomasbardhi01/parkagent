/**
 * User-sourced zone numbers: the unknown → reported → verified progression.
 * Boston's open data has no ParkBoston numbers and the app has no map
 * (2026-09-21 recording), so /parked flags the gap (needs_zone_number),
 * POST /zones/:zoneId/provider-number stores what the driver read off the
 * meter, and subsequent parks are automatic.
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { API_KEY, BOYLSTON_BOS, MONDAY_2PM, makeTestApp, parkedBody } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };

const BOYLSTON_ZONE: ZoneTermsRow = {
  zoneId: BOYLSTON_BOS.zoneId,
  city: "bos",
  street: "BOYLSTON ST",
  providerZoneNumber: "",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 120,
  hoursJson: BOYLSTON_BOS.hours,
};

const BOSTON_FIX = { lat: 42.3495, lng: -71.0798, ts: MONDAY_2PM };

function makeApp() {
  return makeTestApp({
    candidates: [{ ...BOYLSTON_BOS, providerZoneNumber: "" }],
    zones: [{ ...BOYLSTON_ZONE }],
  });
}

function report(
  app: ReturnType<typeof makeTestApp>["app"],
  body: unknown,
  apiKey: string = API_KEY,
) {
  return app.inject({
    method: "POST",
    url: `/zones/${BOYLSTON_ZONE.zoneId}/provider-number`,
    headers: { "x-api-key": apiKey },
    payload: body as object,
  });
}

test("an unknown Boston zone number turns pay into confirm with needsZoneNumber", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody(BOSTON_FIX),
  });
  expect(res.statusCode).toBe(200);
  const json = res.json();
  expect(json).toMatchObject({
    action: "confirm",
    rule: "needs_zone_number",
    needsZoneNumber: true,
  });
  // The candidate still rides along so the app can quote and collect.
  expect(json.candidates).toHaveLength(1);
  expect(json.candidates[0].providerZoneNumber).toBe("");
});

test("once the number is stored, /parked is automatic again", async () => {
  // The candidate fetcher reads the zones table in production, so a stored
  // number shows up on the candidate; mirror that here.
  const t = makeTestApp({
    candidates: [{ ...BOYLSTON_BOS, providerZoneNumber: "81234" }],
    zones: [{ ...BOYLSTON_ZONE, providerZoneNumber: "81234" }],
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody(BOSTON_FIX),
  });
  const json = res.json();
  expect(json.needsZoneNumber).toBe(false);
  expect(json.action).toBe("pay");
  expect(json.candidates[0].providerZoneNumber).toBe("81234");
});

test("reporting stores the number on the zone, unverified with one voice", async () => {
  const { app, state } = makeApp();

  const res = await report(app, { number: "81234" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    ok: true,
    number: "81234",
    verified: false,
    confirmations: 1,
  });

  const zone = state.zones[0]!;
  expect(zone.providerZoneNumber).toBe("81234");
  expect(zone.providerZoneNumberVerified).toBe(false);
  // Audited like everything that changes what the executor will type.
  const decision = state.decisions.find((d) => d.kind === "zone_number_report")!;
  expect(decision.outcome).toMatchObject({ number: "81234", confirmations: 1 });
});

test("a second user agreeing marks the number verified", async () => {
  const { app, state } = makeApp();
  state.zoneNumberReports.push({
    id: "znr-other",
    zoneId: BOYLSTON_ZONE.zoneId,
    userId: "u2",
    number: "81234",
    source: "user",
    createdAt: new Date(MONDAY_2PM),
  });

  const res = await report(app, { number: "81234" });
  expect(res.json()).toMatchObject({ verified: true, confirmations: 2 });
  expect(state.zones[0]!.providerZoneNumberVerified).toBe(true);
});

test("a conflicting report replaces the number and drops verified", async () => {
  const { app, state } = makeApp();
  state.zones[0]!.providerZoneNumber = "81234";
  state.zones[0]!.providerZoneNumberVerified = true;
  state.zoneNumberReports.push({
    id: "znr-other",
    zoneId: BOYLSTON_ZONE.zoneId,
    userId: "u2",
    number: "81234",
    source: "user",
    createdAt: new Date(MONDAY_2PM),
  });

  const res = await report(app, { number: "99999" });
  expect(res.json()).toMatchObject({ number: "99999", verified: false, confirmations: 1 });
  expect(state.zones[0]!.providerZoneNumber).toBe("99999");
  expect(state.zones[0]!.providerZoneNumberVerified).toBe(false);
});

test("re-reporting by the same user updates their row, not a second voice", async () => {
  const { app, state } = makeApp();
  await report(app, { number: "81234" });
  const res = await report(app, { number: "81234" });
  expect(res.json()).toMatchObject({ verified: false, confirmations: 1 });
  expect(state.zoneNumberReports).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Precedence against imported numbers (zone_number_imports, from the
// ParkBoston Find Parking feed): a verified user report beats an import;
// an import beats a single unverified report.

function seedImport(state: ReturnType<typeof makeTestApp>["state"], number: string) {
  state.zoneNumberImports.push({
    zoneId: BOYLSTON_ZONE.zoneId,
    number,
    confidence: 0.9,
    method: "rule",
    sourceName: "North Boylston between Dartmouth and Clarendon",
    importedAt: new Date(MONDAY_2PM),
  });
}

test("an import outranks a single unverified report", async () => {
  const { app, state } = makeApp();
  seedImport(state, "55555");
  state.zones[0]!.providerZoneNumber = "55555";

  const res = await report(app, { number: "81234" });
  expect(res.json()).toMatchObject({
    number: "55555",
    appliedSource: "import",
    verified: false,
    confirmations: 1,
  });
  // The zone keeps the imported number; the report is stored for later.
  expect(state.zones[0]!.providerZoneNumber).toBe("55555");
  expect(state.zoneNumberReports).toHaveLength(1);
  const decision = state.decisions.find((d) => d.kind === "zone_number_report")!;
  expect(decision.rule).toBe("import_precedence");
});

test("two users agreeing outranks a conflicting import", async () => {
  const { app, state } = makeApp();
  seedImport(state, "55555");
  state.zones[0]!.providerZoneNumber = "55555";
  state.zoneNumberReports.push({
    id: "znr-other",
    zoneId: BOYLSTON_ZONE.zoneId,
    userId: "u2",
    number: "81234",
    source: "user",
    createdAt: new Date(MONDAY_2PM),
  });

  const res = await report(app, { number: "81234" });
  expect(res.json()).toMatchObject({
    number: "81234",
    appliedSource: "report",
    verified: true,
    confirmations: 2,
  });
  expect(state.zones[0]!.providerZoneNumber).toBe("81234");
  expect(state.zones[0]!.providerZoneNumberVerified).toBe(true);
});

test("a report agreeing with the import applies it, still unverified", async () => {
  const { app, state } = makeApp();
  seedImport(state, "81234");
  state.zones[0]!.providerZoneNumber = "81234";

  const res = await report(app, { number: "81234" });
  expect(res.json()).toMatchObject({
    number: "81234",
    appliedSource: "report",
    verified: false,
    confirmations: 1,
  });
  expect(state.zones[0]!.providerZoneNumber).toBe("81234");
});

test("rejects a malformed number and an unknown zone", async () => {
  const { app } = makeApp();
  expect((await report(app, { number: "abc" })).statusCode).toBe(400);
  expect((await report(app, { number: "" })).statusCode).toBe(400);
  // Short numbers are real: the Find Parking sweep has zones "1" and "12".
  expect((await report(app, { number: "12" })).statusCode).toBe(200);
  const missing = await app.inject({
    method: "POST",
    url: "/zones/bos-nowhere/provider-number",
    headers: HEADERS,
    payload: { number: "81234" },
  });
  expect(missing.statusCode).toBe(404);
});
