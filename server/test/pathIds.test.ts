/**
 * Path ids (#281): every route with an `:id` / `:…Id` param parses it
 * before its handler (routes/ids.ts), so a NUL byte, which Postgres refuses
 * as invalid UTF-8 (22021), answers 400 and never reaches the database. A
 * well-formed id that isn't the caller's answers as a missing one does.
 * The error handler maps a 22021 that reaches a query anyway to 400.
 */

import { describe, expect, test, vi } from "vitest";

import { buildApp, createFastify } from "../src/app.js";
import type { Db } from "../src/db.js";
import { NOT_IDS, idShapeFor, pathParams } from "../src/routes/ids.js";
import type { GeocoderProvider } from "../src/services/assistant/geocoder.js";
import { API_KEY, BOYLSTON_BOS, MONDAY_2PM, NONADMIN_API_KEY, makeTestApp } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
/** A cuid as Prisma mints them: no row has it. */
const MISSING = "cm2x7k9qa0000abcd1234efgh";
const REQUEST = { place: "Newbury Street", durationMinutes: 60, kinds: ["street"] };
const geocoder: GeocoderProvider = {
  async geocode() {
    return {
      ok: true,
      results: [{ lat: 42.3503, lng: -71.0811, displayName: "Newbury Street", city: "bos" }],
    };
  },
};

/** Postgres refusing a NUL in text, as Prisma 7 throws it (P2039). */
const nulError = () =>
  Object.assign(new Error("Database error. Code: `22021`. Message: `invalid byte sequence`"), {
    code: "P2039",
    meta: {
      driverAdapterError: { cause: { kind: "postgres", originalCode: "22021" } },
    },
  });

async function agentKey(t: ReturnType<typeof makeTestApp>, apiKey: string) {
  const headers = { "x-api-key": apiKey };
  const minted = await t.app.inject({
    method: "POST",
    url: "/me/agent-keys",
    headers,
    payload: { label: "Agent", scopes: ["read", "confirm"] },
  });
  await t.app.inject({
    method: "PATCH",
    url: "/me/settings",
    headers,
    payload: { agentsMayAct: true },
  });
  const key = minted.json().key as string;
  return (method: "GET" | "POST", url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
      ...(payload ? { payload } : {}),
    });
}

/** Every database call, by model and operation. */
function counted(db: Db, calls: string[]): Db {
  return new Proxy(db, {
    get(target, model) {
      const value = Reflect.get(target, model) as unknown;
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          calls.push(String(model));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (!value || typeof value !== "object") return value;
      return new Proxy(value, {
        get(ops, op) {
          const fn = Reflect.get(ops, op) as unknown;
          if (typeof fn !== "function") return fn;
          return (...args: unknown[]) => {
            calls.push(`${String(model)}.${String(op)}`);
            return (fn as (...a: unknown[]) => unknown).apply(ops, args);
          };
        },
      });
    },
  });
}

describe("every route's path ids", () => {
  test("an id that couldn't be one is a 400 naming it, with no database call", async () => {
    const t = makeTestApp({ now: () => NOW, garages: [] });
    const key = (
      await t.app.inject({
        method: "POST",
        url: "/me/agent-keys",
        headers: { "x-api-key": NONADMIN_API_KEY },
        payload: { label: "Sweep", scopes: ["read", "confirm"] },
      })
    ).json().key as string;

    // The same app, its routes listed and its queries counted. Auth reads
    // through t.deps.authenticate, over the uncounted fake.
    const routes: { method: string; url: string }[] = [];
    const calls: string[] = [];
    const app = createFastify();
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (method !== "HEAD") routes.push({ method, url: route.url });
      }
    });
    buildApp({ ...t.deps, db: counted(t.deps.db, calls) }, app);
    await app.ready();

    const swept: string[] = [];
    const notIds = new Set<string>();
    for (const { method, url } of routes) {
      // Every param, whatever it's called, unless it's one NOT_IDS names.
      const names = pathParams(url).filter((n) => {
        if (!NOT_IDS.includes(n)) return true;
        notIds.add(n);
        return false;
      });
      for (const name of names) {
        swept.push(`${method} ${url} ${name}`);
        // Over-long only for our rows' ids (64); a zone's or a garage's
        // runs to Fastify's own 100, past which Fastify answers 414.
        const max = idShapeFor(url)?.[name]?.maxLength ?? 64;
        const bads = ["%00", "a%20b", "d1%3B", ...(max === 64 ? ["a".repeat(65)] : [])];
        for (const bad of bads) {
          const path = url.replace(/:([A-Za-z0-9_]+)/g, (_, n: string) =>
            n === name ? bad : "x1",
          );
          const agentRoute = url.startsWith("/agent/");
          calls.length = 0;
          const res = await app.inject({
            method: method as "GET",
            url: path,
            headers: {
              ...(agentRoute ? { authorization: `Bearer ${key}` } : { "x-api-key": API_KEY }),
              // As the app sends every unsafe request (LiveAPI.send): the
              // idempotency hook, which runs before any route's own, must
              // store nothing for it either.
              ...(method === "GET"
                ? {}
                : { "idempotency-key": `sweep-${calls.length}-${swept.length}` }),
            },
            // A body that passes the agent confirm's own parse, so its id
            // is what's refused.
            ...(method === "GET" || method === "DELETE"
              ? {}
              : { payload: { confirmToken: "t".repeat(20) } }),
          });
          const where = `${method} ${url} ${name}=${bad.slice(0, 8)}`;
          expect(calls, where).toEqual([]);
          if (url === "/garages/:id") {
            // Its own, stricter pattern, refused as no such garage (FR-49).
            expect(res.statusCode, `${where}: ${res.body}`).toBe(404);
            expect(res.json(), where).toEqual({ error: "garage_not_found" });
            continue;
          }
          expect(res.statusCode, `${where}: ${res.body}`).toBe(400);
          expect(res.json().error.properties?.[name], where).toBeDefined();
        }
      }
    }
    // Every id param the app has: a new route's shows up here (and is
    // parsed already, the hook being default-on).
    expect([...swept].sort()).toEqual([
      "DELETE /assistant/conversations/:id id",
      "DELETE /me/agent-keys/:id id",
      "DELETE /me/vehicles/:id id",
      "DELETE /wallet/funding-methods/:id id",
      "GET /admin/parks/:id/trace id",
      "GET /admin/sign-checks/:checkId/photo checkId",
      "GET /agent/decisions/:decisionId/why decisionId",
      "GET /agent/parks/:parkId parkId",
      "GET /agent/plans/:planId planId",
      "GET /assistant/conversations/:id id",
      "GET /garages/:id id",
      "GET /me/decisions/:decisionId/why decisionId",
      "PATCH /assistant/itineraries/:id id",
      "PATCH /me/vehicles/:id id",
      "POST /agent/plans/:planId/confirm planId",
      "POST /assistant/plans/:planId/price planId",
      "POST /link/spend-requests/:id/card id",
      "POST /link/spend-requests/:id/sync id",
      "POST /parked/:id/confirm id",
      "POST /parked/:id/decline id",
      "POST /parked/:id/place id",
      "POST /parked/:id/signs id",
      "POST /parked/:id/signs/:checkId/accept checkId",
      "POST /parked/:id/signs/:checkId/accept id",
      "POST /providers/:provider/link-jobs/:jobId/notify jobId",
      "POST /zones/:zoneId/provider-number zoneId",
      "PUT /wallet/funding-methods/:id/default id",
    ]);
    // And every param that isn't an id: a new kind is a decision (ids.ts).
    expect([...notIds]).toEqual(["provider"]);
    expect(NOT_IDS).toEqual(["provider"]);
  });

  test("a param named any other way is parsed as an id too", () => {
    const shape = idShapeFor("/me/things/:thing_id/parts/:partID")!;
    expect(Object.keys(shape).sort()).toEqual(["partID", "thing_id"]);
    expect(shape["thing_id"]!.safeParse("a\u0000b").success).toBe(false);
    expect(shape["partID"]!.safeParse("cm2x7k9qa0000abcd1234efgh").success).toBe(true);
  });

  test("link-status's job id, a query param, is parsed as one: 400, no job read", async () => {
    const t = makeTestApp({ now: () => NOW });
    const read = vi.spyOn(t.deps.db.linkJob, "findUnique");
    for (const jobId of ["a%00b", "a%20b", "a".repeat(65)]) {
      const res = await t.app.inject({
        method: "GET",
        url: `/providers/parknyc/link-status?jobId=${jobId}`,
        headers: { "x-api-key": API_KEY },
      });
      expect(res.statusCode, jobId).toBe(400);
      expect(res.json().error.properties?.jobId, jobId).toBeDefined();
    }
    expect(read).not.toHaveBeenCalled();
  });

  test("ours are cuids up to 64; a zone's and a garage's are names, up to 100", () => {
    expect(idShapeFor("/parked/:id/confirm")!["id"]!.safeParse(MISSING).success).toBe(true);
    expect(idShapeFor("/parked/:id/confirm")!["id"]!.safeParse("a".repeat(64)).success).toBe(true);
    expect(idShapeFor("/parked/:id/confirm")!["id"]!.safeParse("a".repeat(65)).success).toBe(false);
    const zone = idShapeFor("/zones/:zoneId/provider-number")!["zoneId"]!;
    expect(zone.safeParse(`bos-${"long-street-name-".repeat(4)}a1b2c3`).success).toBe(true);
    expect(zone.safeParse("a".repeat(101)).success).toBe(false);
    // A provider is a registry key, not an id; the agent's are parsed in
    // their handlers, after the key's scope.
    expect(idShapeFor("/providers/:provider/link")).toBeNull();
    expect(idShapeFor("/agent/plans/:planId")).toBeNull();
  });
});

describe("the agent's plans and parks", () => {
  test("a plan: its id reads it; another person's answers as a missing one", async () => {
    const t = makeTestApp({ candidates: [BOYLSTON_BOS], geocoder, now: () => NOW });
    const mine = await agentKey(t, NONADMIN_API_KEY);
    const theirs = await agentKey(t, API_KEY);
    const proposed = await mine("POST", "/agent/plans", { request: REQUEST });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const planId = proposed.json().planId as string;

    expect((await mine("GET", `/agent/plans/${planId}`)).statusCode).toBe(200);
    const other = await theirs("GET", `/agent/plans/${planId}`);
    const missing = await theirs("GET", `/agent/plans/${MISSING}`);
    expect(other.statusCode).toBe(404);
    expect({ status: other.statusCode, body: other.json() }).toEqual({
      status: missing.statusCode,
      body: missing.json(),
    });
    // 64 characters is still an id (a 404), 65 isn't (a 400).
    expect((await mine("GET", `/agent/plans/${"a".repeat(64)}`)).statusCode).toBe(404);
    expect((await mine("GET", `/agent/plans/${"a".repeat(65)}`)).statusCode).toBe(400);
  });

  test("a confirm with a NUL plan id: 400, nothing read, nothing on the ledger", async () => {
    const t = makeTestApp({ candidates: [BOYLSTON_BOS], now: () => NOW });
    const mine = await agentKey(t, NONADMIN_API_KEY);
    const decisions = t.state.decisions.length;
    const res = await mine("POST", "/agent/plans/a%00b/confirm", {
      confirmToken: "t".repeat(20),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.properties.planId).toBeDefined();
    expect(t.state.decisions.length).toBe(decisions);
  });

  test("a park: another person's answers as a missing one", async () => {
    const t = makeTestApp({ now: () => NOW });
    const mine = await agentKey(t, NONADMIN_API_KEY);
    const park = await t.deps.db.pendingPark.create({
      data: { userId: "u1", status: "at_car", carLat: 42.35, carLng: -71.08, parkedAt: NOW },
    });
    const other = await mine("GET", `/agent/parks/${park.id}`);
    const missing = await mine("GET", `/agent/parks/${MISSING}`);
    expect(other.statusCode).toBe(404);
    expect({ status: other.statusCode, body: other.json() }).toEqual({
      status: missing.statusCode,
      body: missing.json(),
    });
  });
});

describe("the error handler's backstop", () => {
  const appThrowing = (err: unknown) => {
    const app = buildApp(undefined, createFastify());
    app.get("/boom", async () => {
      throw err;
    });
    return app;
  };

  test("Postgres refusing a NUL that reached a query answers 400", async () => {
    const app = appThrowing(nulError());
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request" });
  });

  test("any other database error is still a 500, its text never echoed", async () => {
    const err = Object.assign(new Error("Database error. Code: `57014`. canceling statement"), {
      code: "P2039",
      meta: { driverAdapterError: { cause: { kind: "postgres", originalCode: "57014" } } },
    });
    const res = await appThrowing(err).inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });
});
