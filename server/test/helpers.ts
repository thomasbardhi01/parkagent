/**
 * Shared test scaffolding: the default policy, fake AppDb, and NYC fixture
 * candidates taken from the PR #42 verification table (real zones, rates,
 * and max stays; distances representative).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../src/app.js";
import { buildApp, makeAuthenticate } from "../src/app.js";
import type { AppDb } from "../src/db.js";
import type { Policy } from "../src/services/policy.js";
import { PolicyService } from "../src/services/policy.js";
import type { Candidate } from "../src/services/zoneLookup.js";

export const API_KEY = "test-key";

// Monday 2026-01-05, 14:00 EST — mid-afternoon, meters running.
export const MONDAY_2PM = "2026-01-05T14:00:00-05:00";
// Monday 20:00 EST — after the posted 19:00 end of enforcement.
export const MONDAY_8PM = "2026-01-05T20:00:00-05:00";

export const DEFAULT_POLICY: Policy = {
  dry_run: true,
  session_cap_usd: 45,
  daily_cap_usd: 60,
  auto_pay_max_rate_per_hour: 8.0,
  default_stay_minutes: 90,
  parknyc_fee_usd: 0.15,
  auto_extend: {
    enabled: true,
    max_count: 2,
    max_minutes_each: 60,
    no_extend_within_minutes_of_max_stay: 15,
  },
  respect_enforcement_hours: true,
  ticket_cost_usd: 65,
};

export const HOURS_MON_SAT = [
  {
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    start: "08:30",
    end: "19:00",
  },
];

// Broadway & W 72nd: both sides $5.00/$8.25, 120 min — the agreeing pair.
export const BROADWAY_A: Candidate = {
  zoneId: "nyc-110436",
  parknycZoneNumber: "110436",
  rateFirstHourUsd: 5.0,
  rateAdditionalHourUsd: 8.25,
  maxStayMinutes: 120,
  hours: HOURS_MON_SAT,
  distanceM: 9.3,
  containsPoint: true,
};
export const BROADWAY_B: Candidate = {
  ...BROADWAY_A,
  zoneId: "nyc-113828",
  parknycZoneNumber: "113828",
  distanceM: 10.2,
};

// Mott & Canal: same ladder but 120 vs 300 min max stay — the disagreeing pair.
export const MOTT_A: Candidate = {
  zoneId: "nyc-107114",
  parknycZoneNumber: "107114",
  rateFirstHourUsd: 5.0,
  rateAdditionalHourUsd: 8.25,
  maxStayMinutes: 120,
  hours: HOURS_MON_SAT,
  distanceM: 8.1,
  containsPoint: true,
};
export const MOTT_B: Candidate = {
  ...MOTT_A,
  zoneId: "nyc-101369",
  parknycZoneNumber: "101369",
  maxStayMinutes: 300,
  distanceM: 11.4,
  containsPoint: false,
};

// 30th Ave & Steinway: $2.00/$3.00, 120 min — cheap enough to auto-pay.
export const STEINWAY_A: Candidate = {
  zoneId: "nyc-417371",
  parknycZoneNumber: "417371",
  rateFirstHourUsd: 2.0,
  rateAdditionalHourUsd: 3.0,
  maxStayMinutes: 120,
  hours: HOURS_MON_SAT,
  distanceM: 4.2,
  containsPoint: true,
};
export const STEINWAY_B: Candidate = {
  ...STEINWAY_A,
  zoneId: "nyc-425957",
  parknycZoneNumber: "425957",
  distanceM: 9.8,
};

export function makePolicyService(
  overrides: Partial<Policy> = {},
  envDryRun = true,
): PolicyService {
  const dir = mkdtempSync(join(tmpdir(), "parkagent-policy-"));
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify({ ...DEFAULT_POLICY, ...overrides }));
  return new PolicyService(path, envDryRun);
}

export interface FakeDbState {
  parkedEvents: unknown[];
  decisions: {
    kind: string;
    inputs: Record<string, unknown>;
    rule: string;
    outcome: Record<string, unknown>;
    userId: string;
    parkedEventId: string;
  }[];
  snapshots: { hash: string; policy: unknown; source: string }[];
  /** Rows returned for today's-spend queries (Decimal-ish strings are fine). */
  sessionRows: { amountUsd: unknown; feeUsd: unknown }[];
}

export function makeFakeDb(): { db: AppDb; state: FakeDbState } {
  const state: FakeDbState = {
    parkedEvents: [],
    decisions: [],
    snapshots: [],
    sessionRows: [],
  };
  const db: AppDb = {
    user: {
      findUnique: async ({ where }) =>
        where.apiKey === API_KEY ? { id: "u1", name: "Thomas" } : null,
    },
    parkedEvent: {
      create: async ({ data }) => {
        state.parkedEvents.push(data);
        return { id: `pe${state.parkedEvents.length}` };
      },
    },
    decision: {
      create: async ({ data }) => {
        state.decisions.push(data as FakeDbState["decisions"][number]);
        return { id: `d${state.decisions.length}` };
      },
    },
    session: {
      findMany: async () => state.sessionRows,
    },
    policySnapshot: {
      findFirst: async () => {
        const last = state.snapshots.at(-1);
        return last ? { hash: last.hash } : null;
      },
      create: async ({ data }) => {
        state.snapshots.push(data);
        return data;
      },
    },
  };
  return { db, state };
}

export interface TestApp {
  app: FastifyInstance;
  state: FakeDbState;
  deps: AppDeps;
}

export function makeTestApp(options: {
  candidates?: Candidate[];
  policy?: Partial<Policy>;
  envDryRun?: boolean;
  now?: () => Date;
}): TestApp {
  const { db, state } = makeFakeDb();
  const deps: AppDeps = {
    db,
    policy: makePolicyService(options.policy, options.envDryRun ?? true),
    findCandidates: async () => options.candidates ?? [],
    authenticate: makeAuthenticate(db),
    ...(options.now ? { now: options.now } : {}),
  };
  return { app: buildApp(deps), state, deps };
}

export function parkedBody(overrides: Record<string, unknown> = {}) {
  return {
    lat: 40.7784,
    lng: -73.9819,
    accuracy: 12.5,
    ts: MONDAY_2PM,
    signals: ["motion_stop", "bt_disconnect"],
    ...overrides,
  };
}
