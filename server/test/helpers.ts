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
import type { AppDb, SessionRow, SessionWhere, ZoneTermsRow } from "../src/db.js";
import type { Push } from "../src/services/apns.js";
import type { Executor } from "../src/services/executor.js";
import { DryRunExecutor } from "../src/services/executor.js";
import type { Policy } from "../src/services/policy.js";
import { PolicyService } from "../src/services/policy.js";
import type { StripeGateway } from "../src/services/stripeGateway.js";
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
  city_overrides: {
    nyc: { ticket_cost_usd: 65 },
    bos: { parking_fee_usd: 0.35, ticket_cost_usd: 40 },
  },
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
  city: "nyc",
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
  city: "nyc",
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
  city: "nyc",
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

// Boylston St E-D block, Back Bay: Boston's flat $3.75/hr, Mon-Sat 8-8,
// 120 min — real values from the Phase "boston-data" load. ParkBoston zone
// numbers are unknown for every Boston zone (see data/build_boston_zones.py).
export const BOYLSTON_BOS: Candidate = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  parknycZoneNumber: "",
  rateFirstHourUsd: 3.75,
  rateAdditionalHourUsd: 3.75,
  maxStayMinutes: 120,
  hours: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }],
  distanceM: 6.1,
  containsPoint: true,
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

export interface FakeParkedEvent {
  id: string;
  userId: string;
  lat: number;
  lng: number;
  accuracyM: number;
  ts: Date;
  signals: string[];
}

export interface FakeSessionEvent {
  id: string;
  sessionId: string;
  kind: string;
  at: Date;
  minutes?: number;
  amountUsd?: number;
  feeUsd?: number;
  expiresAt?: Date;
  providerSessionId?: string;
  dryRun: boolean;
  details?: unknown;
}

export interface FakeFix {
  id: string;
  sessionId: string;
  userId: string;
  lat: number;
  lng: number;
  accuracyM: number;
  ts: Date;
}

export interface FakeIssuingAuthorizationRow {
  stripeAuthorizationId: string;
  stripeCardId: string;
  userId: string | null;
  amountUsd: number;
  merchantCategory: string | null;
  merchantCategoryCode: string | null;
  merchantName: string | null;
  approved: boolean;
  decision: string;
  status: string;
  stripeTransactionId?: string;
  capturedUsd?: number;
  createdAt: Date;
}

export interface FakeDbState {
  parkedEvents: FakeParkedEvent[];
  decisions: {
    kind: string;
    inputs: Record<string, unknown>;
    rule: string;
    outcome: Record<string, unknown>;
    userId?: string | null;
    parkedEventId?: string;
    sessionId?: string;
  }[];
  snapshots: { hash: string; policy: unknown; source: string }[];
  sessions: SessionRow[];
  sessionEvents: FakeSessionEvent[];
  locationFixes: FakeFix[];
  deviceTokens: {
    id: string;
    userId: string;
    token: string;
    platform: string;
    environment: string;
  }[];
  zones: ZoneTermsRow[];
  /** Cards the fake issuingCard/issuingCardholder queries resolve. The card
   * routes read the extra fields; the webhook only needs the id → user link. */
  issuingCards: {
    stripeCardId: string;
    userId: string;
    last4?: string;
    status?: string;
    perAuthCapUsd?: number;
    dailyCapUsd?: number;
    holderName?: string;
  }[];
  issuingAuthorizations: FakeIssuingAuthorizationRow[];
}

function emptySession(id: string): SessionRow {
  return {
    id,
    userId: "u1",
    vehicleId: null,
    zoneId: "",
    parknycZoneNumber: "",
    status: "pending",
    dryRun: true,
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    amountUsd: 0,
    feeUsd: 0,
    parknycConfirmation: null,
    parkedEventId: null,
    carLat: null,
    carLng: null,
    rateFirstHour: null,
    rateAdditionalHour: null,
    maxStayMinutes: null,
    hoursJson: null,
    purchasedMinutes: 0,
    chargedMinutes: 0,
    extendCount: 0,
    lastExtenderRule: null,
    lastExtenderRuleAt: null,
    createdAt: new Date(MONDAY_2PM),
  };
}

/** Insert a session row with overrides; returns it for further mutation. */
export function seedSession(state: FakeDbState, overrides: Partial<SessionRow>): SessionRow {
  const session = { ...emptySession(`seed${state.sessions.length + 1}`), ...overrides };
  state.sessions.push(session);
  return session;
}

function matchesSessionWhere(s: SessionRow, where: SessionWhere): boolean {
  if (where.id?.not !== undefined && s.id === where.id.not) return false;
  if (where.userId !== undefined && s.userId !== where.userId) return false;
  if (where.zoneId !== undefined && s.zoneId !== where.zoneId) return false;
  if (where.dryRun !== undefined && s.dryRun !== where.dryRun) return false;
  if (typeof where.status === "string" && s.status !== where.status) return false;
  if (
    typeof where.status === "object" &&
    where.status !== null &&
    !where.status.in.includes(s.status)
  ) {
    return false;
  }
  if (where.createdAt?.gte !== undefined && s.createdAt < where.createdAt.gte) return false;
  return true;
}

export function makeFakeDb(): { db: AppDb; state: FakeDbState } {
  const state: FakeDbState = {
    parkedEvents: [],
    decisions: [],
    snapshots: [],
    sessions: [],
    sessionEvents: [],
    locationFixes: [],
    deviceTokens: [],
    zones: [],
    issuingCards: [],
    issuingAuthorizations: [],
  };
  const db: AppDb = {
    user: {
      findUnique: async ({ where }) =>
        where.apiKey === API_KEY ? { id: "u1", name: "Thomas" } : null,
    },
    zone: {
      findUnique: async ({ where }) => state.zones.find((z) => z.zoneId === where.zoneId) ?? null,
    },
    parkedEvent: {
      create: async ({ data }) => {
        const row = { id: `pe${state.parkedEvents.length + 1}`, ...data };
        state.parkedEvents.push(row);
        return { id: row.id };
      },
      findUnique: async ({ where }) => state.parkedEvents.find((p) => p.id === where.id) ?? null,
    },
    decision: {
      create: async ({ data }) => {
        state.decisions.push(data as FakeDbState["decisions"][number]);
        return { id: `d${state.decisions.length}` };
      },
    },
    session: {
      create: async ({ data }) => {
        const row = { ...emptySession(`s${state.sessions.length + 1}`), ...data } as SessionRow;
        state.sessions.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.sessions.find((s) => s.id === where.id);
        if (!row) throw new Error(`no session ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }) => state.sessions.find((s) => s.id === where.id) ?? null,
      findFirst: async ({ where }) =>
        state.sessions.find((s) => matchesSessionWhere(s, where)) ?? null,
      findMany: async ({ where }) => state.sessions.filter((s) => matchesSessionWhere(s, where)),
    },
    sessionEvent: {
      create: async ({ data }) => {
        const row = { id: `se${state.sessionEvents.length + 1}`, ...data };
        state.sessionEvents.push(row);
        return { id: row.id };
      },
    },
    locationFix: {
      create: async ({ data }) => {
        const row = { id: `f${state.locationFixes.length + 1}`, ...data };
        state.locationFixes.push(row);
        return { id: row.id };
      },
      findMany: async ({ where, take }) =>
        state.locationFixes
          .filter((f) => f.sessionId === where.sessionId)
          .sort((a, b) => b.ts.getTime() - a.ts.getTime())
          .slice(0, take),
    },
    deviceToken: {
      upsert: async ({ where, create, update }) => {
        const existing = state.deviceTokens.find((t) => t.token === where.token);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `dt${state.deviceTokens.length + 1}`, ...create };
        state.deviceTokens.push(row);
        return row;
      },
      findMany: async ({ where }) => state.deviceTokens.filter((t) => t.userId === where.userId),
      delete: async ({ where }) => {
        const i = state.deviceTokens.findIndex((t) => t.id === where.id);
        if (i >= 0) state.deviceTokens.splice(i, 1);
        return {};
      },
    },
    issuingCardholder: {
      findUnique: async ({ where }) => {
        const cards = state.issuingCards.filter((c) => c.userId === where.userId);
        const first = cards[0];
        if (!first) return null;
        return {
          id: `ch-${where.userId}`,
          stripeCardholderId: `ich-${where.userId}`,
          name: first.holderName ?? "Thomas",
          cards: cards.map((c) => ({
            id: `card-${c.stripeCardId}`,
            stripeCardId: c.stripeCardId,
            last4: c.last4 ?? "4242",
            status: c.status ?? "active",
            perAuthCapUsd: c.perAuthCapUsd ?? 45,
            dailyCapUsd: c.dailyCapUsd ?? 60,
          })),
        };
      },
    },
    issuingCard: {
      findUnique: async ({ where }) => {
        const card = state.issuingCards.find((c) => c.stripeCardId === where.stripeCardId);
        return card
          ? {
              id: `card-${card.stripeCardId}`,
              stripeCardId: card.stripeCardId,
              cardholder: { userId: card.userId },
            }
          : null;
      },
      update: async ({ where, data }) => {
        const card = state.issuingCards.find((c) => c.stripeCardId === where.stripeCardId);
        if (card) Object.assign(card, data);
        return card ?? {};
      },
    },
    issuingAuthorization: {
      findUnique: async ({ where }) => {
        const row = state.issuingAuthorizations.find(
          (a) => a.stripeAuthorizationId === where.stripeAuthorizationId,
        );
        return row ? { id: row.stripeAuthorizationId } : null;
      },
      // Serves both AppDb shapes: the spend sum (select amountUsd) and the
      // transactions page (orderBy/take, optional created-before cursor).
      findMany: (async (args: {
        where: { userId: string; approved?: boolean; createdAt?: { gte?: Date; lt?: Date } };
        select?: { amountUsd: true };
        take?: number;
      }) => {
        const rows = state.issuingAuthorizations
          .filter(
            (a) =>
              a.userId === args.where.userId &&
              (args.where.approved === undefined || a.approved === args.where.approved) &&
              (args.where.createdAt?.gte === undefined ||
                a.createdAt >= args.where.createdAt.gte) &&
              (args.where.createdAt?.lt === undefined || a.createdAt < args.where.createdAt.lt),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take ?? Infinity);
        if (args.select) return rows.map((a) => ({ amountUsd: a.amountUsd }));
        return rows.map((a) => ({
          id: a.stripeAuthorizationId,
          stripeTransactionId: a.stripeTransactionId ?? null,
          capturedUsd: a.capturedUsd ?? null,
          ...a,
        }));
      }) as AppDb["issuingAuthorization"]["findMany"],
      create: async ({ data }) => {
        state.issuingAuthorizations.push({ ...data, createdAt: new Date() });
        return { id: data.stripeAuthorizationId };
      },
      update: async ({ where, data }) => {
        const row = state.issuingAuthorizations.find(
          (a) => a.stripeAuthorizationId === where.stripeAuthorizationId,
        );
        if (row) Object.assign(row, data);
        return row ?? {};
      },
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
  /** Every push the app tried to send, in order. */
  pushes: { userId: string; push: Push }[];
}

/**
 * A StripeGateway of benign fakes for the card routes: an active Visa, a
 * funded balance, no-op moves. Override the pieces a test exercises;
 * verifyEvent stays unusable (webhook tests build their own).
 */
export function makeFakeGateway(overrides: Partial<StripeGateway> = {}): StripeGateway {
  return {
    verifyEvent: () => {
      throw new Error("verifyEvent not faked");
    },
    apiVersion: "2026-08-26.dahlia",
    retrieveCard: async () => ({
      brand: "Visa",
      expMonth: 8,
      expYear: 2030,
      cardholderName: "Thomas",
      status: "active",
    }),
    setCardStatus: async (_id, status) => status,
    createEphemeralKey: async (_id, options = {}) => ({
      secret: "ek_test_fake",
      apiVersion: options.apiVersion ?? "2026-08-26.dahlia",
      expiresAt: new Date(new Date(MONDAY_2PM).getTime() + 15 * 60_000),
    }),
    fundingBalance: async () => ({ balanceUsd: 50, pendingUsd: 0 }),
    fundingTopup: async () => {},
    fundingWithdraw: async () => {},
    ...overrides,
  };
}

export function makeTestApp(options: {
  candidates?: Candidate[];
  policy?: Partial<Policy>;
  envDryRun?: boolean;
  now?: () => Date;
  zones?: ZoneTermsRow[];
  /** Override the executor used for BOTH dry-run and real paths. */
  executor?: Executor;
  /** Wire a (fake) Stripe gateway; without it /card & co. answer 503. */
  stripe?: StripeGateway;
}): TestApp {
  const { db, state } = makeFakeDb();
  state.zones.push(...(options.zones ?? []));
  const pushes: TestApp["pushes"] = [];
  const dryRunExecutor = new DryRunExecutor(() => {}, options.now ?? (() => new Date()));
  const deps: AppDeps = {
    db,
    policy: makePolicyService(options.policy, options.envDryRun ?? true),
    findCandidates: async () => options.candidates ?? [],
    authenticate: makeAuthenticate(db),
    executorFor: () => options.executor ?? dryRunExecutor,
    sendPush: async (userId, push) => {
      pushes.push({ userId, push });
    },
    ...(options.stripe ? { stripe: options.stripe } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return { app: buildApp(deps), state, deps, pushes };
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
