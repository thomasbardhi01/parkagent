import { expect, test } from "vitest";

import { API_KEY, makeTestApp, parkedBody, STEINWAY_A, STEINWAY_B } from "./helpers.js";

/**
 * FR-53: the app sends its on-device place classification as `placeHint`
 * in the /parked body. From an app that doesn't list the place outcomes
 * (`outcomes`, FR-54: every build before #179), a hint changes nothing the
 * app acts on: the action, rule, quote, and candidates are what they would
 * be without one, whatever the hint's shape. So a build that only sends
 * hints can't change what a park pays. What the hint does change is the
 * record: the response's `place` and the decision's `inputs.place`.
 * (What a hint does for an app that lists the outcomes: parkedPlace.test.ts.)
 */

const HEADERS = { "x-api-key": API_KEY };

const HINT = {
  class: "garage",
  confidence: 0.95,
  runnerUp: { class: "nopay", confidence: 0.3 },
  garageId: "fixture-garage",
  entryFix: { lat: 40.7785, lng: -73.982, accuracy: 9, ts: "2026-09-21T14:13:20Z" },
  inputs: {
    located: true,
    memoryHit: false,
    footprintId: "fixture-garage",
    containsPoint: true,
    nearestEntranceM: 8,
    gpsLoss: true,
    baroDeltaM: 6.5,
    crawl: true,
  },
};

function post(app: ReturnType<typeof makeTestApp>["app"], body: unknown) {
  return app.inject({ method: "POST", url: "/parked", headers: HEADERS, payload: body as object });
}

/** Everything the app acts on: not the row ids, which differ per call,
 * nor `place`, which is where a hint is allowed to show. */
function answer(res: Awaited<ReturnType<typeof post>>) {
  const body = res.json() as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => key !== "parkedEventId" && key !== "decisionId" && key !== "place",
    ),
  );
}

test("FR-53 a placeHint answers exactly as no hint does (street pay stays pay)", async () => {
  const plain = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
  const hinted = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
  const without = await post(plain.app, parkedBody());
  const withHint = await post(hinted.app, { ...parkedBody(), placeHint: HINT });
  expect(withHint.statusCode).toBe(200);
  expect(answer(withHint)).toEqual(answer(without));
  expect(answer(withHint)).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
  expect(Object.keys(answer(withHint)).sort()).toEqual(
    ["action", "candidates", "dryRun", "needsZoneNumber", "provider", "quote", "rule"].sort(),
  );
  // The hint is on the record, under `place`, and the request body the
  // decision stores is what it always was.
  expect(hinted.state.decisions).toHaveLength(1);
  expect(hinted.state.decisions[0]!.inputs).toMatchObject({
    body: { signals: parkedBody().signals },
    place: { understood: [], hint: { class: "garage", confidence: 0.95 } },
  });
  const stored = (hinted.state.decisions[0]!.inputs as { body: object }).body;
  expect(stored).not.toHaveProperty("placeHint");
  expect(stored).not.toHaveProperty("outcomes");
  expect(hinted.state.decisions[0]!.rule).toBe("auto_pay_ok");
});

test("FR-53 a nopay hint can't silence a metered park", async () => {
  const { app } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
  const res = await post(app, {
    ...parkedBody(),
    placeHint: {
      ...HINT,
      class: "nopay",
      garageId: null,
      inputs: { ...HINT.inputs, memoryHit: true },
    },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
});

test.each([
  ["a string", "garage"],
  ["a number", 42],
  ["null", null],
  ["an array", [1, 2]],
])("FR-53 a malformed placeHint (%s) can't break /parked", async (_label, placeHint) => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
  const res = await post(app, { ...parkedBody(), placeHint });
  expect(res.statusCode).toBe(200);
  expect(state.decisions).toHaveLength(1);
});
