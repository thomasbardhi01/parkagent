import { expect, test } from "vitest";

import { API_KEY, makeTestApp, parkedBody } from "./helpers.js";
import {
  BROADWAY_A,
  BROADWAY_B,
  MONDAY_8PM,
  MOTT_A,
  MOTT_B,
  STEINWAY_A,
  STEINWAY_B,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };

function post(app: ReturnType<typeof makeTestApp>["app"], body: unknown) {
  return app.inject({ method: "POST", url: "/parked", headers: HEADERS, payload: body as object });
}

test("requires a valid api key", async () => {
  const { app } = makeTestApp({ candidates: [STEINWAY_A] });
  const noKey = await app.inject({ method: "POST", url: "/parked", payload: parkedBody() });
  expect(noKey.statusCode).toBe(401);
  const badKey = await app.inject({
    method: "POST",
    url: "/parked",
    headers: { "x-api-key": "wrong" },
    payload: parkedBody(),
  });
  expect(badKey.statusCode).toBe(401);
});

test("rejects a malformed body with 400 and writes no decision", async () => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
  const res = await post(app, { lat: 40.7, lng: -73.9, accuracy: -1, ts: "yesterday" });
  expect(res.statusCode).toBe(400);
  expect(state.decisions).toHaveLength(0);
});

test("no candidates → unknown_zone, and the decision is still recorded", async () => {
  const { app, state } = makeTestApp({ candidates: [] });
  const res = await post(app, parkedBody());
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    action: "unknown_zone",
    rule: "unknown_zone",
    candidates: [],
    quote: null,
  });
  expect(state.decisions).toHaveLength(1);
  expect(state.decisions[0]).toMatchObject({
    kind: "parked_quote",
    rule: "unknown_zone",
    userId: "u1",
    parkedEventId: "pe1",
  });
  expect(state.decisions[0]!.inputs).toMatchObject({
    radiusM: 25,
    dryRun: true,
    candidateZoneIds: [],
  });
});

test("Steinway (agreeing, cheap): pay, one candidate, correct quote", async () => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
  const res = await post(app, parkedBody());
  const body = res.json();
  expect(body.action).toBe("pay");
  expect(body.rule).toBe("auto_pay_ok");
  expect(body.dryRun).toBe(true);
  expect(body.candidates).toHaveLength(1);
  expect(body.candidates[0].zoneId).toBe("nyc-417371");
  expect(body.quote).toMatchObject({
    stayMinutes: 90,
    chargedMinutes: 90,
    meterUsd: 3.5,
    feeUsd: 0.15,
    totalUsd: 3.65,
  });
  expect(state.parkedEvents).toHaveLength(1);
  expect(state.decisions).toHaveLength(1);
  expect(state.decisions[0]!.outcome).toMatchObject({ action: "pay" });
});

test("Mott & Canal (disagreeing max stay): confirm with both sides quoted", async () => {
  const { app, state } = makeTestApp({ candidates: [MOTT_A, MOTT_B] });
  const res = await post(app, parkedBody({ lat: 40.718, lng: -73.9975 }));
  const body = res.json();
  expect(body.action).toBe("confirm");
  expect(body.rule).toBe("candidates_disagree");
  expect(body.candidates.map((c: { zoneId: string }) => c.zoneId)).toEqual([
    "nyc-107114",
    "nyc-101369",
  ]);
  // 300-min side still quotes only the 90-min default stay.
  expect(body.candidates[1].quote.stayMinutes).toBe(90);
  expect(body.quote.zoneId).toBe("nyc-107114");
  expect(state.decisions).toHaveLength(1);
  expect(state.decisions[0]!.rule).toBe("candidates_disagree");
});

test("Broadway ($8.25 second hour) is over the $8 ceiling: confirm", async () => {
  const { app } = makeTestApp({ candidates: [BROADWAY_A, BROADWAY_B] });
  const res = await post(app, parkedBody());
  const body = res.json();
  expect(body.action).toBe("confirm");
  expect(body.rule).toBe("rate_above_ceiling");
  expect(body.quote.totalUsd).toBe(9.28);
});

test("free period: parked after enforcement ends → ignore, $0 quote", async () => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
  const res = await post(app, parkedBody({ ts: MONDAY_8PM }));
  const body = res.json();
  expect(body.action).toBe("ignore");
  expect(body.rule).toBe("free_period");
  expect(body.quote.totalUsd).toBe(0);
  expect(state.decisions).toHaveLength(1);
});

test("quote above the session cap: confirm", async () => {
  const { app } = makeTestApp({
    candidates: [STEINWAY_A],
    policy: { session_cap_usd: 3, auto_pay_max_rate_per_hour: 10 },
  });
  const res = await post(app, parkedBody());
  expect(res.json().rule).toBe("session_cap_exceeded");
  expect(res.json().action).toBe("confirm");
});

test("today's spend plus the quote above the daily cap: confirm", async () => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
  state.sessionRows.push({ amountUsd: "57.50", feeUsd: "0.45" });
  const res = await post(app, parkedBody());
  expect(res.json().rule).toBe("daily_cap_exceeded");
  expect(res.json().action).toBe("confirm");
});

test("today's spend under the daily cap still pays", async () => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
  state.sessionRows.push({ amountUsd: "50.00", feeUsd: "0.30" });
  const res = await post(app, parkedBody());
  expect(res.json().rule).toBe("auto_pay_ok");
});

test("Tuesday afternoon at Mott & Canal prices nonzero from the request ts", async () => {
  const { app, state } = makeTestApp({ candidates: [MOTT_A, MOTT_B] });
  // Tuesday 2026-01-06 14:00 EST — enforcement (Mon-Sat 08:30-19:00) is on.
  const res = await post(app, parkedBody({ ts: "2026-01-06T14:00:00-05:00" }));
  const body = res.json();
  expect(body.rule).toBe("candidates_disagree");
  expect(body.quote.totalUsd).toBe(9.28); // $5 + 30 min at $8.25/h + $0.15 fee
  expect(body.quote.chargedMinutes).toBe(90);
  expect(state.decisions[0]!.inputs).toMatchObject({
    pricedAt: new Date("2026-01-06T14:00:00-05:00").toISOString(),
    pricedAtSource: "request_ts",
  });
});

test("a missing ts prices at server time and the decision says so", async () => {
  const serverNow = new Date("2026-01-06T15:00:00-05:00"); // Tuesday 3pm EST
  const { app, state } = makeTestApp({
    candidates: [STEINWAY_A],
    now: () => serverNow,
  });
  const res = await post(app, parkedBody({ ts: undefined }));
  const body = res.json();
  expect(res.statusCode).toBe(200);
  expect(body.rule).toBe("auto_pay_ok");
  expect(body.quote.totalUsd).toBe(3.65);
  expect(state.decisions[0]!.inputs).toMatchObject({
    pricedAt: serverNow.toISOString(),
    pricedAtSource: "server_time",
  });
});

test("session and location endpoints are stubbed at 501", async () => {
  const { app } = makeTestApp({});
  for (const url of [
    "/session/start",
    "/session/stop",
    "/session/extend",
    "/location",
    "/device",
  ]) {
    const res = await app.inject({ method: "POST", url, headers: HEADERS, payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "not_implemented" });
  }
});
