/**
 * The app over a real, migrated Postgres, for the races the fake DB can't
 * prove: compare-and-set writes and unique indexes decided by Postgres
 * itself. Everything outside the database is faked as in test/helpers.ts
 * (zone lookup, executor, pushes), and the database is wired exactly as
 * index.ts wires it: `withDecisionLogging(asAppDb(createPrisma(url)))`.
 *
 * A test can hold a database call at a barrier (`hold`): the first `n`
 * calls that match wait until all `n` have arrived, then run together. Two
 * racing requests then both reach their write having read the same row,
 * and Postgres decides which one wins.
 *
 * Every app gets its own user, so nothing is truncated and nothing one
 * test writes is seen by another. The clock is the real one, moved only
 * forward (`tick`): Postgres stamps `created_at` with its own `now()`.
 */

import { randomBytes } from "node:crypto";

import type { AppDeps } from "../../src/app.js";
import { buildApp, makeAuthenticate } from "../../src/app.js";
import type { AppDb } from "../../src/db.js";
import { asAppDb, createPrisma } from "../../src/db.js";
import { hashApiKey } from "../../src/services/apiKeys.js";
import { AssistantTools } from "../../src/services/assistant/tools.js";
import { withDecisionLogging } from "../../src/services/decisionLog.js";
import type { Executor } from "../../src/services/executor.js";
import { DryRunExecutor } from "../../src/services/executor.js";
import type { GarageProvider } from "../../src/services/garage/garageProvider.js";
import { LinkWallet } from "../../src/services/link/linkWallet.js";
import { makePendingSessionCheck } from "../../src/services/pendingSession.js";
import type { Policy } from "../../src/services/policy.js";
import type { Candidate } from "../../src/services/zoneLookup.js";
import {
  STEINWAY_A,
  TEST_JWT_SECRET,
  TEST_PEPPER,
  makePolicyService,
  testStateCrypto,
} from "../helpers.js";

/** Metered every minute of every day, so a run at any hour has a quote. */
export const ALWAYS = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], start: "00:00", end: "24:00" },
];
export const STEINWAY: Candidate = { ...STEINWAY_A, hours: ALWAYS };
export const CAR = { lat: 40.7784, lng: -73.9819 };

const url = process.env["TEST_PG_DATABASE_URL"];
if (!url) {
  throw new Error(
    "TEST_PG_DATABASE_URL is not set: these tests need a migrated, throwaway Postgres (the CI job server-pg)",
  );
}
// Writes go to the users and lifecycle tables: never to a database not
// named as a test one.
const dbName = new URL(url).pathname.slice(1);
if (!dbName.endsWith("_test")) {
  throw new Error(`TEST_PG_DATABASE_URL names database "${dbName}"; it must end in _test`);
}

export const prisma = createPrisma(url);
const base = withDecisionLogging(asAppDb(prisma), { info() {} });

type Call = (args: never) => Promise<unknown>;
type Hook = (args: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>;
/** "model.op" → what runs instead of the call while a test holds it. */
const hooks = new Map<string, Hook>();

/** The database every app here gets: the real one, with the held calls. */
export const db = new Proxy(base, {
  get(target, model, receiver) {
    const delegate = Reflect.get(target, model, receiver) as unknown;
    if (typeof model !== "string" || model.startsWith("$") || typeof delegate !== "object") {
      return typeof delegate === "function" ? (delegate as Call).bind(target) : delegate;
    }
    return new Proxy(delegate as object, {
      get(d, op) {
        const fn = Reflect.get(d, op) as unknown;
        if (typeof fn !== "function") return fn;
        const call = (args: never) => (fn as Call).call(d, args);
        const hook = hooks.get(`${model}.${String(op)}`);
        return hook
          ? (args: Record<string, unknown>) => hook(args, () => call(args as never))
          : call;
      },
    });
  },
}) as AppDb;

/**
 * Hold the first `n` calls of `model.op` that `matches` until all `n` have
 * arrived, then let them run at once. Resolves once they have. Other calls
 * pass straight through. Released after `timeoutMs` regardless, so a race
 * that never happens fails its assertions instead of hanging.
 */
export function hold(
  name: `${string}.${string}`,
  n: number,
  matches: (args: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 5_000,
): { arrived: () => number; done: Promise<void> } {
  let arrived = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const timer = setTimeout(open, timeoutMs);
  hooks.set(name, async (args, next) => {
    if (arrived >= n || !matches(args)) return next();
    arrived += 1;
    if (arrived === n) {
      clearTimeout(timer);
      hooks.delete(name);
      open();
    }
    await gate;
    return next();
  });
  return {
    arrived: () => arrived,
    done: gate.then(() => {
      hooks.delete(name);
    }),
  };
}

/**
 * Hold the first call of `model.op` that `matches` until `release()`: a
 * start stalled mid-flight, for as long as the test needs it there.
 * `reached` resolves once that call has arrived.
 */
export function pause(
  name: `${string}.${string}`,
  matches: (args: Record<string, unknown>) => boolean = () => true,
): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let arrive: () => void = () => {};
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  hooks.set(name, async (args, next) => {
    if (!matches(args)) return next();
    hooks.delete(name);
    arrive();
    await gate;
    return next();
  });
  return { reached, release };
}

/** Wait until `check` holds, polling: for a barrier's first arrival. */
export async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Seed the zones every test parks in, once. */
async function seedZones(): Promise<void> {
  for (const c of [STEINWAY, ...extraZones]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO zones (zone_id, city, provider_zone_number, vehicle_type, passenger,
         rate_first_hour, rate_additional_hour, max_stay_minutes, hours_json, geom, centerline,
         data_version)
       VALUES ($1, $2, $3, 'all', true, $4::numeric, $5::numeric, $6::int, $7::jsonb,
         ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint($9::float8, $8::float8), 4326), 0.0005)),
         ST_Multi(ST_MakeLine(ST_SetSRID(ST_MakePoint($9::float8, $8::float8), 4326),
                              ST_SetSRID(ST_MakePoint($9::float8 + 0.001, $8::float8), 4326))),
         'pg-test')
       ON CONFLICT (zone_id) DO NOTHING`,
      c.zoneId,
      c.city,
      c.providerZoneNumber,
      c.rateFirstHourUsd,
      c.rateAdditionalHourUsd,
      c.maxStayMinutes,
      JSON.stringify(ALWAYS),
      CAR.lat,
      CAR.lng,
    );
  }
}
const extraZones: Candidate[] = [];
let zonesSeeded: Promise<void> | null = null;

/** A user of its own, with a key and a linked provider account. */
async function seedUser(): Promise<{ id: string; apiKey: string }> {
  const id = `pg-${randomBytes(6).toString("hex")}`;
  const apiKey = `pg-key-${randomBytes(12).toString("hex")}`;
  await prisma.user.create({
    data: { id, name: id, apiKeyHash: hashApiKey(TEST_PEPPER, apiKey) },
  });
  await prisma.providerAccount.create({
    data: {
      userId: id,
      provider: "parknyc",
      status: "linked",
      stateEncrypted: testStateCrypto().seal(JSON.stringify({ cookies: [], origins: [] })),
      linkedAt: new Date(),
      lastVerifiedAt: new Date(),
    },
  });
  return { id, apiKey };
}

export async function makePgApp(
  options: { candidates?: Candidate[]; policy?: Partial<Policy>; executor?: Executor } = {},
) {
  // Metered at every hour, as their zone rows are: CI runs at any time.
  const candidates = (options.candidates ?? [STEINWAY]).map((c) => ({ ...c, hours: ALWAYS }));
  for (const c of candidates) {
    if (c.zoneId !== STEINWAY.zoneId && !extraZones.some((z) => z.zoneId === c.zoneId)) {
      extraZones.push(c);
      zonesSeeded = null;
    }
  }
  zonesSeeded ??= seedZones();
  await zonesSeeded;

  const user = await seedUser();
  const clock = { offsetMs: 0 };
  const now = () => new Date(Date.now() + clock.offsetMs);
  const calls = { start: 0, stop: 0, extend: 0 };
  const dry = new DryRunExecutor(() => {}, now);
  const counted: Executor = {
    startSession: (args) => {
      calls.start += 1;
      return (options.executor ?? dry).startSession(args);
    },
    extendSession: (args) => {
      calls.extend += 1;
      return (options.executor ?? dry).extendSession(args);
    },
    stopSession: (args) => {
      calls.stop += 1;
      return (options.executor ?? dry).stopSession(args);
    },
  };
  const policy = makePolicyService(options.policy, true);
  const garage: GarageProvider = {
    id: "fake-garage",
    canReserve: false,
    search: async () => ({ ok: true, options: [], fromCache: false }),
    optionById: () => null,
    book: async () => {
      throw new Error("no garage options in this test");
    },
  };
  const findCandidates = async () => candidates;
  const linkWallet = new LinkWallet({ db, stateCrypto: testStateCrypto(), now });
  const assistantTools = new AssistantTools({
    db,
    policy,
    findCandidates,
    garage,
    linkWallet,
    apiKeyPepper: TEST_PEPPER,
    now,
  });
  const deps: AppDeps = {
    db,
    policy,
    apiKeyPepper: TEST_PEPPER,
    findCandidates,
    findNearbyZones: async () => ({ zones: [], truncated: false }),
    auth: {
      jwtSecret: TEST_JWT_SECRET,
      verifyAppleToken: async () => ({ ok: false, code: "bad_signature" }),
    },
    authenticate: makeAuthenticate(db, TEST_PEPPER, TEST_JWT_SECRET, now),
    executorFor: () => counted,
    sendPush: async () => {},
    hasPendingSession: makePendingSessionCheck(db),
    stateCrypto: testStateCrypto(),
    assistantTools,
    linkWallet,
    now,
  };
  const app = buildApp(deps);
  const headers = { "x-api-key": user.apiKey };
  const post = (path: string, body: object = {}) =>
    app.inject({ method: "POST", url: path, headers, payload: body });
  /** A fix `distanceM` north of the car, stamped now. */
  const fix = (distanceM: number, extra: Record<string, unknown> = {}) => ({
    lat: CAR.lat + distanceM / 111_320,
    lng: CAR.lng,
    accuracy: 8,
    ts: now().toISOString(),
    ...extra,
  });
  const tick = (seconds: number) => {
    clock.offsetMs += seconds * 1000;
  };
  return { app, deps, user, calls, post, fix, tick, now, assistantTools };
}

export type PgApp = Awaited<ReturnType<typeof makePgApp>>;
