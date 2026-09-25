/**
 * Shared test scaffolding: the default policy, fake AppDb, and NYC fixture
 * candidates taken from the PR #42 verification table (real zones, rates,
 * and max stays; distances representative).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import type { AppDeps, AuthConfig } from "../src/app.js";
import { buildApp, makeAuthenticate } from "../src/app.js";
import { hashApiKey } from "../src/services/apiKeys.js";
import type {
  AppDb,
  AppTx,
  EmailLoginCodeRow,
  FundingMethodRow,
  GarageBookingRow,
  ItineraryRow,
  LinkSpendRequestRow,
  SessionHoldRow,
  ProviderAccountRow,
  RefreshTokenRow,
  SessionRow,
  SessionWhere,
  UserIdentityRow,
  VehicleRow,
  ZoneNumberImportRow,
  ZoneNumberReportRow,
  ZoneTermsObservedRow,
  ZoneTermsRow,
} from "../src/db.js";
import { makeStateCrypto } from "../src/services/crypto.js";
import type { ModelClient } from "../src/services/assistant/loop.js";
import { AssistantTools } from "../src/services/assistant/tools.js";
import type { GarageProvider } from "../src/services/garage/garageProvider.js";
import type { GeocoderProvider } from "../src/services/assistant/geocoder.js";
import type { AppleTokenClient } from "../src/services/appleTokens.js";
import type { LinkClient } from "../src/services/link/linkClient.js";
import { LinkWallet } from "../src/services/link/linkWallet.js";
import type { ProviderAccountOps, ProviderOpsFactory } from "../src/services/providerOps.js";
import type { Push } from "../src/services/apns.js";
import type { Executor } from "../src/services/executor.js";
import { DryRunExecutor } from "../src/services/executor.js";
import { makePendingSessionCheck } from "../src/services/pendingSession.js";
import type { Policy } from "../src/services/policy.js";
import { PolicyService } from "../src/services/policy.js";
import type { StripeGateway } from "../src/services/stripeGateway.js";
import type { Candidate, NearbyZone } from "../src/services/zoneLookup.js";

export const API_KEY = "test-key";
/** A second, non-admin user's key — for authorization (403) tests. */
export const NONADMIN_API_KEY = "test-key-two";
/** The pepper every test app hashes keys with (see makeAuthenticate). */
export const TEST_PEPPER = "test-pepper-16-chars-min";
/** Signs test access JWTs and peppers refresh/code hashes (≥ 32 chars). */
export const TEST_JWT_SECRET = "test-jwt-secret-32-chars-minimum-ok";

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
  auto_extend: {
    enabled: true,
    max_count: 2,
    max_minutes_each: 60,
    no_extend_within_minutes_of_max_stay: 15,
  },
  respect_enforcement_hours: true,
  ticket_cost_usd: 65,
  city_overrides: {
    nyc: { parking_fee_usd: 0.15, ticket_cost_usd: 65 },
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
  providerZoneNumber: "110436",
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
  providerZoneNumber: "113828",
  distanceM: 10.2,
};

// Mott & Canal: same ladder but 120 vs 300 min max stay — the disagreeing pair.
export const MOTT_A: Candidate = {
  zoneId: "nyc-107114",
  city: "nyc",
  providerZoneNumber: "107114",
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
  providerZoneNumber: "101369",
  maxStayMinutes: 300,
  distanceM: 11.4,
  containsPoint: false,
};

// 30th Ave & Steinway: $2.00/$3.00, 120 min — cheap enough to auto-pay.
export const STEINWAY_A: Candidate = {
  zoneId: "nyc-417371",
  city: "nyc",
  providerZoneNumber: "417371",
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
  providerZoneNumber: "425957",
  distanceM: 9.8,
};

// Boylston St E-D block, Back Bay: Boston's flat $3.75/hr, Mon-Sat 8-8,
// 120 min — real values from the Phase "boston-data" load. ParkBoston zone
// numbers are unknown for every Boston zone (see data/build_boston_zones.py).
export const BOYLSTON_BOS: Candidate = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  providerZoneNumber: "",
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
  sessionId?: string | null;
  holdId?: string | null;
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
  /** Per-user payment source ("provider_card" default when absent). */
  userPaymentSources: Record<string, string>;
  /** Full identity rows. Seeded with u1 (Thomas, admin) and u2 (Ana);
   * auth tests create more through the routes. u1/u2 hold the test api
   * keys implicitly; a test seeding another keyed user sets apiKeyHash. */
  users: (UserIdentityRow & { apiKeyHash?: string | null; apiKey?: string | null })[];
  refreshTokens: RefreshTokenRow[];
  emailLoginCodes: EmailLoginCodeRow[];
  parkedEvents: FakeParkedEvent[];
  decisions: {
    kind: string;
    inputs: Record<string, unknown>;
    rule: string;
    outcome: Record<string, unknown>;
    userId?: string | null;
    parkedEventId?: string;
    sessionId?: string;
    createdAt?: Date;
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
   * routes read the extra fields; the webhook only needs the id → user link.
   * Cardholders are derived: id `ch-<userId>`, stripe id `ich-<userId>`. */
  issuingCards: {
    stripeCardId: string;
    userId: string;
    last4?: string;
    status?: string;
    perAuthCapUsd?: number;
    dailyCapUsd?: number;
    holderName?: string;
    createdAt?: Date;
  }[];
  /** Cardholders created explicitly (POST /card/prepare) — lets a holder
   * exist with zero cards; derived holders come from issuingCards. */
  issuingCardholders: { userId: string; name: string }[];
  issuingAuthorizations: FakeIssuingAuthorizationRow[];
  providerAccounts: ProviderAccountRow[];
  zoneNumberReports: ZoneNumberReportRow[];
  zoneNumberImports: ZoneNumberImportRow[];
  zoneTermsObserved: ZoneTermsObservedRow[];
  vehicles: VehicleRow[];
  processedTopups: { paymentIntentId: string; amountUsd: number; userId: string | null }[];
  conversations: { id: string; userId: string; turns: unknown }[];
  assistantPlans: {
    id: string;
    userId: string;
    conversationId: string;
    kind: string;
    plan: unknown;
  }[];
  assistantConfirmations: {
    token: string;
    userId: string;
    planId: string;
    optionId: string | null;
    expiresAt: Date;
    usedAt: Date | null;
  }[];
  itineraries: ItineraryRow[];
  linkAccounts: {
    userId: string;
    status: string;
    tokensEncrypted: string | null;
    connectedAt: Date | null;
    pmType?: string | null;
    pmBrand?: string | null;
    pmLast4?: string | null;
    pmFetchedAt?: Date | null;
  }[];
  linkSpendRequests: LinkSpendRequestRow[];
  fundingMethods: FundingMethodRow[];
  sessionHolds: SessionHoldRow[];
  garageBookings: GarageBookingRow[];
  linkJobs: {
    id: string;
    userId: string;
    provider: string;
    phase: string;
    reason: string | null;
    retrySafe: boolean | null;
    dryRun: boolean | null;
    createdAt: Date;
  }[];
}

function emptySession(id: string): SessionRow {
  return {
    id,
    userId: "u1",
    vehicleId: null,
    zoneId: "",
    city: "nyc",
    providerZoneNumber: "",
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
  if (where.createdAt?.lt !== undefined && s.createdAt >= where.createdAt.lt) return false;
  return true;
}

const seedUser = (
  id: string,
  name: string,
  isAdmin: boolean,
  overrides: Partial<UserIdentityRow> = {},
): UserIdentityRow => ({
  id,
  name,
  isAdmin,
  paymentSource: "provider_card",
  email: null,
  emailVerified: false,
  phone: null,
  phoneVerified: false,
  appleSub: null,
  googleSub: null,
  deletedAt: null,
  createdAt: new Date(MONDAY_2PM),
  ...overrides,
});

/** Creation time for fake hold/booking rows. Tests that need the sweep's
 * grace period to pass (or a row "older" than another) set it. */
let fakeRowClock: () => Date = () => new Date(MONDAY_2PM);
export function setFakeRowClock(clock: () => Date): void {
  fakeRowClock = clock;
}
const holdClock = () => fakeRowClock();

export function makeFakeDb(): { db: AppDb; state: FakeDbState } {
  fakeRowClock = () => new Date(MONDAY_2PM);
  const state: FakeDbState = {
    userPaymentSources: {},
    users: [seedUser("u1", "Thomas", true), seedUser("u2", "Ana", false)],
    refreshTokens: [],
    emailLoginCodes: [],
    parkedEvents: [],
    decisions: [],
    snapshots: [],
    sessions: [],
    sessionEvents: [],
    locationFixes: [],
    deviceTokens: [],
    zones: [],
    issuingCards: [],
    issuingCardholders: [],
    issuingAuthorizations: [],
    providerAccounts: [],
    zoneNumberReports: [],
    zoneNumberImports: [],
    zoneTermsObserved: [],
    vehicles: [],
    processedTopups: [],
    linkJobs: [],
    conversations: [],
    assistantPlans: [],
    assistantConfirmations: [],
    itineraries: [],
    linkAccounts: [],
    linkSpendRequests: [],
    fundingMethods: [],
    sessionHolds: [],
    garageBookings: [],
  };
  const cardholderFor = (userId: string) => {
    const explicit = state.issuingCardholders.find((c) => c.userId === userId);
    const cards = state.issuingCards.filter((c) => c.userId === userId);
    if (!explicit && cards.length === 0) return null;
    return {
      id: `ch-${userId}`,
      userId,
      stripeCardholderId: `ich-${userId}`,
      name: explicit?.name ?? cards[0]?.holderName ?? "Thomas",
    };
  };
  const toCardRow = (c: FakeDbState["issuingCards"][number]) => ({
    id: `card-${c.stripeCardId}`,
    cardholderId: `ch-${c.userId}`,
    stripeCardId: c.stripeCardId,
    last4: c.last4 ?? "4242",
    status: c.status ?? "active",
    perAuthCapUsd: c.perAuthCapUsd ?? 45,
    dailyCapUsd: c.dailyCapUsd ?? 60,
    createdAt: c.createdAt ?? new Date(MONDAY_2PM),
  });
  const accountKey = (userId: string, provider: string) =>
    state.providerAccounts.find((a) => a.userId === userId && a.provider === provider);
  // Payment source keeps living in userPaymentSources (older tests seed
  // it there); reads merge it over the identity row.
  const withSource = (row: UserIdentityRow): UserIdentityRow => ({
    ...row,
    paymentSource: state.userPaymentSources[row.id] ?? row.paymentSource,
  });
  // Postgres's locks, as far as the race tests need them: a row lock a
  // transaction takes (its upsert's) is held until the transaction ends,
  // and another transaction's upsert of that row WAITS for it; an advisory
  // lock taken with pg_try_advisory_xact_lock is held the same way, and a
  // second try answers false at once — exactly the serialization the code
  // relies on. Autocommit statements lock and release on their own. The
  // fake never rolls back.
  const lockHolders = new Map<string, symbol>();
  const lockWaiters = new Map<string, (() => void)[]>();
  const acquireLock = async (key: string, owner: symbol) => {
    while (lockHolders.has(key) && lockHolders.get(key) !== owner) {
      await new Promise<void>((resolve) => {
        lockWaiters.set(key, [...(lockWaiters.get(key) ?? []), resolve]);
      });
    }
    lockHolders.set(key, owner);
  };
  const releaseLocks = (owner: symbol) => {
    for (const [key, holder] of [...lockHolders]) {
      if (holder !== owner) continue;
      lockHolders.delete(key);
      const waiters = lockWaiters.get(key) ?? [];
      lockWaiters.delete(key);
      waiters.forEach((wake) => wake());
    }
  };
  const queryRawAs = async (owner: symbol, query: TemplateStringsArray, values: unknown[]) => {
    const sql = query.join("?");
    if (sql.includes("pg_try_advisory_xact_lock(")) {
      const key = `advisory:${String(values[0])}`;
      const holder = lockHolders.get(key);
      if (holder !== undefined && holder !== owner) return [{ locked: false }];
      lockHolders.set(key, owner);
      return [{ locked: true }];
    }
    throw new Error(`fake $queryRaw: no stand-in for ${sql.trim()}`);
  };
  const upsertIssuingAuthorization = async (
    owner: symbol,
    { where, create, update }: Parameters<AppDb["issuingAuthorization"]["upsert"]>[0],
  ) => {
    await acquireLock(`issuing_authorizations:${where.stripeAuthorizationId}`, owner);
    let row = state.issuingAuthorizations.find(
      (a) => a.stripeAuthorizationId === where.stripeAuthorizationId,
    );
    if (row) {
      Object.assign(row, update);
    } else {
      row = { ...create, createdAt: new Date() };
      state.issuingAuthorizations.push(row);
    }
    return {
      id: row.stripeAuthorizationId,
      approved: row.approved,
      decision: row.decision,
      status: row.status,
      amountUsd: row.amountUsd,
      holdId: row.holdId ?? null,
    };
  };

  const db: AppDb = {
    user: {
      // Auth looks up by hash now — mirror prod: only the peppered hashes
      // match. u1 is the owner/admin; u2 exercises the 403 paths.
      findUnique: async ({ where }) => {
        if ("apiKeyHash" in where) {
          if (where.apiKeyHash === hashApiKey(TEST_PEPPER, API_KEY)) {
            return withSource(state.users.find((u) => u.id === "u1")!);
          }
          if (where.apiKeyHash === hashApiKey(TEST_PEPPER, NONADMIN_API_KEY)) {
            return withSource(state.users.find((u) => u.id === "u2")!);
          }
          return null;
        }
        const match = state.users.find((u) => {
          if ("id" in where) return u.id === where.id;
          if ("email" in where) return u.email === where.email;
          if ("appleSub" in where) return u.appleSub === where.appleSub;
          return u.googleSub === where.googleSub;
        });
        return match ? withSource(match) : null;
      },
      create: async ({ data }) => {
        // users.email is UNIQUE in Postgres; a fake that let duplicates in
        // hid a sign-in that would 500 in production.
        if (data.email && state.users.some((u) => u.email === data.email)) {
          throw Object.assign(new Error("Unique constraint failed on users.email"), {
            code: "P2002",
          });
        }
        const row = seedUser(`u${state.users.length + 1}`, data.name, false, {
          email: data.email ?? null,
          emailVerified: data.emailVerified ?? false,
          phone: data.phone ?? null,
          appleSub: data.appleSub ?? null,
          googleSub: data.googleSub ?? null,
        });
        state.users.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.users.find((u) => u.id === where.id);
        if (!row) throw new Error(`fake user.update: no user ${where.id}`);
        if (data.paymentSource !== undefined) {
          state.userPaymentSources[where.id] = data.paymentSource;
        }
        const rest = { ...data };
        delete rest.paymentSource;
        Object.assign(row, rest);
        return withSource(row);
      },
      updateMany: async ({ where, data }) => {
        // Compare-and-set, like the real UPDATE … WHERE stripe_customer_id IS NULL.
        const row = state.users.find((u) => u.id === where.id);
        if (!row || (row.stripeCustomerId ?? null) !== null) return { count: 0 };
        row.stripeCustomerId = data.stripeCustomerId;
        return { count: 1 };
      },
      findMany: (async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        if (!("id" in where)) {
          // Pending Apple revocations: tombstoned, token still sealed.
          return state.users
            .filter((u) => u.deletedAt !== null && (u.appleRefreshTokenSealed ?? null) !== null)
            .slice(0, take ?? Infinity)
            .map((u) => ({ id: u.id, appleRefreshTokenSealed: u.appleRefreshTokenSealed ?? null }));
        }
        const ids = (where as { id: { in: string[] } }).id.in;
        return state.users
          .filter((u) => ids.includes(u.id))
          .map((u) => ({
            id: u.id,
            name: u.name,
            isAdmin: u.isAdmin,
            email: u.email,
            appleSub: u.appleSub,
            googleSub: u.googleSub,
            apiKey: u.apiKey ?? null,
            // u1/u2 authenticate with the test keys (see findUnique above).
            apiKeyHash:
              u.apiKeyHash ??
              (u.id === "u1"
                ? hashApiKey(TEST_PEPPER, API_KEY)
                : u.id === "u2"
                  ? hashApiKey(TEST_PEPPER, NONADMIN_API_KEY)
                  : null),
            stripeCustomerId: u.stripeCustomerId ?? null,
            deletedAt: u.deletedAt,
            createdAt: u.createdAt,
          }));
      }) as AppDb["user"]["findMany"],
    },
    refreshToken: {
      create: async ({ data }) => {
        const row: RefreshTokenRow = {
          id: `rt${state.refreshTokens.length + 1}`,
          rotatedAt: null,
          revokedAt: null,
          createdAt: new Date(MONDAY_2PM),
          ...data,
        };
        state.refreshTokens.push(row);
        return { id: row.id };
      },
      findUnique: async ({ where }) =>
        state.refreshTokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }) => {
        const row = state.refreshTokens.find((t) => t.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const t of state.refreshTokens) {
          // Mirrors Prisma: every where-field must match, nulls included,
          // which is what makes the rotation claim a compare-and-set.
          const matches =
            "id" in where
              ? t.id === where.id && t.rotatedAt === null && t.revokedAt === null
              : t.familyId === where.familyId && t.revokedAt === null;
          if (matches) {
            Object.assign(t, data);
            count += 1;
          }
        }
        return { count };
      },
      deleteMany: async ({ where }) => {
        const before = state.refreshTokens.length;
        state.refreshTokens = state.refreshTokens.filter((t) => t.userId !== where.userId);
        return { count: before - state.refreshTokens.length };
      },
      count: async ({ where }) =>
        state.refreshTokens.filter((t) => t.userId === where.userId).length,
    },
    emailLoginCode: {
      create: async ({ data }) => {
        const row: EmailLoginCodeRow = {
          id: `elc${state.emailLoginCodes.length + 1}`,
          attempts: 0,
          consumedAt: null,
          createdAt: new Date(MONDAY_2PM),
          ...data,
        };
        state.emailLoginCodes.push(row);
        return { id: row.id };
      },
      // Newest first; insertion order breaks the fixed-clock timestamp tie.
      findFirst: async ({ where }) =>
        [...state.emailLoginCodes]
          .reverse()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .find((c) => c.email === where.email && c.consumedAt === null) ?? null,
      updateMany: async ({ where, data }) => {
        const row = state.emailLoginCodes.find((c) => c.id === where.id);
        // Every where-field must match, as in Postgres — that is the claim.
        if (
          !row ||
          row.consumedAt !== null ||
          ("attempts" in where && !(row.attempts < where.attempts.lt))
        ) {
          return { count: 0 };
        }
        if ("attempts" in data) row.attempts += data.attempts.increment;
        else row.consumedAt = data.consumedAt;
        return { count: 1 };
      },
      count: async ({ where }) =>
        state.emailLoginCodes.filter(
          (c) => c.email === where.email && c.createdAt >= where.createdAt.gte,
        ).length,
    },
    zone: {
      findUnique: async ({ where }) => state.zones.find((z) => z.zoneId === where.zoneId) ?? null,
      update: async ({ where, data }) => {
        const zone = state.zones.find((z) => z.zoneId === where.zoneId);
        if (!zone) throw new Error(`fake zone.update: no zone ${where.zoneId}`);
        if (data.providerZoneNumber !== undefined)
          zone.providerZoneNumber = data.providerZoneNumber;
        if (data.providerZoneNumberVerified !== undefined) {
          zone.providerZoneNumberVerified = data.providerZoneNumberVerified;
        }
        return zone;
      },
    },
    zoneNumberReport: {
      findMany: async ({ where }) =>
        state.zoneNumberReports.filter((r) => r.zoneId === where.zoneId),
      upsert: async ({ where, create, update }) => {
        const existing = state.zoneNumberReports.find(
          (r) => r.zoneId === where.zoneId_userId.zoneId && r.userId === where.zoneId_userId.userId,
        );
        if (existing) {
          existing.number = update.number;
          existing.source = update.source;
          return existing;
        }
        const row = {
          id: `znr${state.zoneNumberReports.length + 1}`,
          createdAt: new Date(MONDAY_2PM),
          ...create,
        };
        state.zoneNumberReports.push(row);
        return row;
      },
    },
    zoneNumberImport: {
      findUnique: async ({ where }) =>
        state.zoneNumberImports.find((r) => r.zoneId === where.zoneId) ?? null,
    },
    zoneTermsObserved: {
      findUnique: async ({ where }) =>
        state.zoneTermsObserved.find(
          (r) =>
            r.city === where.city_zoneNumber.city &&
            r.zoneNumber === where.city_zoneNumber.zoneNumber,
        ) ?? null,
      findMany: async ({ where }) =>
        state.zoneTermsObserved.filter(
          (r) => r.city === where.city && where.zoneNumber.in.includes(r.zoneNumber),
        ),
      upsert: async ({ where, create, update }) => {
        const existing = state.zoneTermsObserved.find(
          (r) =>
            r.city === where.city_zoneNumber.city &&
            r.zoneNumber === where.city_zoneNumber.zoneNumber,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: ZoneTermsObservedRow = {
          hoursJson: null,
          zoneId: null,
          firstSeenAt: create.lastSeenAt,
          ...create,
        } as ZoneTermsObservedRow;
        state.zoneTermsObserved.push(row);
        return row;
      },
    },
    vehicle: {
      findFirst: async ({ where }) =>
        [...state.vehicles]
          .filter((v) => v.userId === where.userId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
      findUnique: async ({ where }) => state.vehicles.find((v) => v.id === where.id) ?? null,
      findMany: async ({ where }) =>
        state.vehicles
          .filter((v) => v.userId === where.userId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      create: async ({ data }) => {
        if (state.vehicles.some((v) => v.plate === data.plate && v.state === data.state)) {
          throw Object.assign(new Error("Unique constraint failed: vehicles_plate_state"), {
            code: "P2002",
          });
        }
        const row: VehicleRow = {
          id: `v${state.vehicles.length + 1}`,
          label: data.label ?? null,
          createdAt: new Date(MONDAY_2PM),
          ...data,
        };
        state.vehicles.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.vehicles.find((v) => v.id === where.id);
        if (!row) throw new Error(`fake vehicle.update: no vehicle ${where.id}`);
        const nextPlate = data.plate ?? row.plate;
        const nextState = data.state ?? row.state;
        if (
          state.vehicles.some(
            (v) => v.id !== row.id && v.plate === nextPlate && v.state === nextState,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed: vehicles_plate_state"), {
            code: "P2002",
          });
        }
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        const i = state.vehicles.findIndex((v) => v.id === where.id);
        if (i >= 0) state.vehicles.splice(i, 1);
        return {};
      },
      deleteMany: async ({ where }) => {
        const before = state.vehicles.length;
        state.vehicles = state.vehicles.filter((v) => v.userId !== where.userId);
        return { count: before - state.vehicles.length };
      },
    },
    parkedEvent: {
      create: async ({ data }) => {
        const row = { id: `pe${state.parkedEvents.length + 1}`, ...data };
        state.parkedEvents.push(row);
        return { id: row.id };
      },
      findUnique: async ({ where }) => state.parkedEvents.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }) => state.parkedEvents.filter((p) => p.ts >= where.ts.gte),
    },
    conversation: {
      findUnique: async ({ where }) => state.conversations.find((c) => c.id === where.id) ?? null,
      upsert: async ({ where, create, update }) => {
        const existing = state.conversations.find((c) => c.id === where.id);
        if (existing) Object.assign(existing, update);
        else state.conversations.push({ ...create });
        return {};
      },
      deleteMany: async ({ where }) => {
        const before = state.conversations.length;
        state.conversations = state.conversations.filter((c) => c.userId !== where.userId);
        return { count: before - state.conversations.length };
      },
    },
    assistantPlan: {
      create: async ({ data }) => {
        state.assistantPlans.push({ ...data });
        return { id: data.id };
      },
      findUnique: async ({ where }) => state.assistantPlans.find((r) => r.id === where.id) ?? null,
    },
    assistantConfirmation: {
      create: async ({ data }) => {
        state.assistantConfirmations.push({ usedAt: null, ...data });
        return {};
      },
      findUnique: async ({ where }) =>
        state.assistantConfirmations.find((r) => r.token === where.token) ?? null,
      updateMany: async ({ where, data }) => {
        // Synchronous check-and-set: the fake's stand-in for the single
        // UPDATE … WHERE used_at IS NULL the real database runs.
        const row = state.assistantConfirmations.find(
          (r) =>
            r.token === where.token &&
            r.usedAt === null &&
            r.expiresAt.getTime() > where.expiresAt.gt.getTime(),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    itinerary: {
      create: async ({ data }) => {
        state.itineraries.push({ createdAt: new Date(MONDAY_2PM), ...data } as ItineraryRow);
        return { id: data.id };
      },
      findUnique: async ({ where }) => state.itineraries.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }) =>
        state.itineraries.filter(
          (r) =>
            (where.userId === undefined || r.userId === where.userId) &&
            (where.status === undefined || r.status === where.status),
        ),
      update: async ({ where, data }) => {
        const row = state.itineraries.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return {};
      },
    },
    linkAccount: {
      findUnique: async ({ where }) =>
        state.linkAccounts.find((r) => r.userId === where.userId) ?? null,
      update: async ({ where, data }) => {
        const row = state.linkAccounts.find((r) => r.userId === where.userId);
        if (row) Object.assign(row, data);
        return {};
      },
      upsert: async ({ where, create, update }) => {
        const existing = state.linkAccounts.find((r) => r.userId === where.userId);
        if (existing) Object.assign(existing, update);
        else {
          state.linkAccounts.push({
            tokensEncrypted: null,
            connectedAt: null,
            ...create,
          } as FakeDbState["linkAccounts"][number]);
        }
        return {};
      },
    },
    linkSpendRequest: {
      create: async ({ data }) => {
        state.linkSpendRequests.push({
          itineraryId: null,
          stopId: null,
          planId: null,
          cardEncrypted: null,
          validUntil: null,
          cardUsedAt: null,
          revealedAt: null,
          createdAt: new Date(MONDAY_2PM),
          ...data,
        } as LinkSpendRequestRow);
        return {};
      },
      findUnique: async ({ where }) =>
        state.linkSpendRequests.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }) =>
        state.linkSpendRequests.filter((r) =>
          "userId" in where ? r.userId === where.userId : where.status.in.includes(r.status),
        ),
      update: async ({ where, data }) => {
        const row = state.linkSpendRequests.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return {};
      },
      // Synchronous check-and-set, standing in for the conditional UPDATE.
      updateMany: async ({ where, data }) => {
        const row = state.linkSpendRequests.find(
          (r) =>
            r.id === where.id &&
            (typeof where.status === "string"
              ? r.status === where.status && (r.revealedAt ?? null) === null
              : where.status.in.includes(r.status)),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    fundingMethod: {
      findMany: async ({ where }) =>
        state.fundingMethods.filter((m) => m.userId === where.userId && m.removedAt === null),
      findUnique: async ({ where }) =>
        state.fundingMethods.find((m) =>
          "id" in where
            ? m.id === where.id
            : m.stripePaymentMethodId === where.stripePaymentMethodId,
        ) ?? null,
      create: async ({ data }) => {
        if (
          state.fundingMethods.some((m) => m.stripePaymentMethodId === data.stripePaymentMethodId)
        ) {
          throw Object.assign(new Error("Unique constraint failed: funding_methods_pm"), {
            code: "P2002",
          });
        }
        const row: FundingMethodRow = {
          id: `fm${state.fundingMethods.length + 1}`,
          expMonth: null,
          expYear: null,
          wallet: null,
          createdAt: new Date(MONDAY_2PM),
          removedAt: null,
          ...data,
        } as FundingMethodRow;
        state.fundingMethods.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.fundingMethods.find((m) => m.id === where.id);
        if (!row) throw new Error(`fake fundingMethod.update: no ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const m of state.fundingMethods) {
          if (m.userId === where.userId) {
            Object.assign(m, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    sessionHold: {
      create: async ({ data }) => {
        // unique (session_id, leg) and unique payment_intent_id, as in Postgres.
        if (
          state.sessionHolds.some(
            (h) =>
              (h.sessionId === data.sessionId && h.leg === data.leg) ||
              (data.paymentIntentId && h.paymentIntentId === data.paymentIntentId),
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed: session_holds"), {
            code: "P2002",
          });
        }
        const row: SessionHoldRow = {
          id: `hold${state.sessionHolds.length + 1}`,
          paymentIntentId: null,
          fundingMethodId: null,
          authorizedUsd: 0,
          capturedUsd: null,
          declineCode: null,
          settledAt: null,
          createdAt: holdClock(),
          ...data,
        } as SessionHoldRow;
        state.sessionHolds.push(row);
        return row;
      },
      findUnique: async ({ where }) =>
        state.sessionHolds.find((h) =>
          "id" in where ? h.id === where.id : h.paymentIntentId === where.paymentIntentId,
        ) ?? null,
      findMany: async ({ where }) =>
        state.sessionHolds.filter((h) => {
          if ("sessionId" in where) return where.sessionId.in.includes(h.sessionId);
          if ("userId" in where) {
            return (
              h.userId === where.userId && (where.status === undefined || h.status === where.status)
            );
          }
          return h.status === where.status && h.createdAt < where.createdAt.lt;
        }),
      update: async ({ where, data }) => {
        const row = state.sessionHolds.find((h) => h.id === where.id);
        if (!row) throw new Error(`fake sessionHold.update: no ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        // Synchronous check-and-set, standing in for the conditional UPDATE.
        const row = state.sessionHolds.find((h) => h.id === where.id && h.status === "held");
        if (!row) return { count: 0 };
        if ("authorizedUsd" in data) {
          const authorized = Number(row.authorizedUsd ?? 0);
          if ("increment" in data.authorizedUsd) {
            const limit = (where as { authorizedUsd?: { lte: number } }).authorizedUsd?.lte;
            if (limit !== undefined && authorized > limit + 1e-9) return { count: 0 };
            row.authorizedUsd = Math.round((authorized + data.authorizedUsd.increment) * 100) / 100;
          } else {
            row.authorizedUsd = Math.round((authorized - data.authorizedUsd.decrement) * 100) / 100;
          }
          return { count: 1 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    garageBooking: {
      create: async ({ data }) => {
        const row: GarageBookingRow = {
          id: `gb${state.garageBookings.length + 1}`,
          planId: null,
          itineraryId: null,
          provider: null,
          startsAt: null,
          endsAt: null,
          deepLink: null,
          linkSpendRequestId: null,
          createdAt: holdClock(),
          ...data,
        } as GarageBookingRow;
        state.garageBookings.push(row);
        return row;
      },
      findMany: async ({ where, take }) =>
        state.garageBookings
          .filter(
            (b) =>
              b.userId === where.userId &&
              (where.createdAt?.lt === undefined || b.createdAt < where.createdAt.lt),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take),
    },
    processedTopup: {
      findUnique: async ({ where }) =>
        state.processedTopups.find((t) => t.paymentIntentId === where.paymentIntentId)
          ? { paymentIntentId: where.paymentIntentId }
          : null,
      create: async ({ data }) => {
        if (state.processedTopups.some((t) => t.paymentIntentId === data.paymentIntentId)) {
          throw Object.assign(new Error("Unique constraint failed: processed_topups_pkey"), {
            code: "P2002",
          });
        }
        state.processedTopups.push({ userId: null, ...data });
        return {};
      },
    },
    linkJob: {
      create: async ({ data }) => {
        state.linkJobs.push({
          reason: null,
          retrySafe: null,
          dryRun: null,
          createdAt: new Date(MONDAY_2PM),
          ...data,
        } as FakeDbState["linkJobs"][number]);
        return { id: data.id };
      },
      update: async ({ where, data }) => {
        const row = state.linkJobs.find((j) => j.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      },
      findUnique: async ({ where }) => state.linkJobs.find((j) => j.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const job of state.linkJobs) {
          if (where.phase.in.includes(job.phase) && job.createdAt < where.createdAt.lt) {
            Object.assign(job, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    decision: {
      create: async ({ data }) => {
        state.decisions.push({
          createdAt: new Date(MONDAY_2PM),
          ...(data as FakeDbState["decisions"][number]),
        });
        return { id: `d${state.decisions.length}` };
      },
      findUnique: async ({ where }) => {
        const index = Number(where.id.replace(/^d/, "")) - 1;
        const d = state.decisions[index];
        if (!d) return null;
        return {
          id: where.id,
          kind: d.kind,
          rule: d.rule,
          inputs: d.inputs,
          outcome: d.outcome,
          userId: d.userId ?? null,
          createdAt: d.createdAt ?? new Date(MONDAY_2PM),
        };
      },
      findMany: async ({ where }) =>
        state.decisions
          .map((d, i) => ({ d, i }))
          .filter(({ d }) =>
            "sessionId" in where
              ? d.sessionId !== undefined && where.sessionId.in.includes(d.sessionId)
              : "rule" in where
                ? d.kind === where.kind && d.rule === where.rule
                : (d.createdAt ?? new Date(MONDAY_2PM)) >= where.createdAt.gte,
          )
          .map(({ d, i }) => ({
            kind: d.kind,
            rule: d.rule,
            outcome: d.outcome,
            inputs: d.inputs,
            userId: d.userId ?? null,
            sessionId: d.sessionId ?? null,
            createdAt: d.createdAt ?? new Date(MONDAY_2PM),
            id: `d${i + 1}`,
          })),
    },
    session: {
      create: async ({ data }) => {
        // Mirrors the one_open_session_per_user partial unique index
        // (prisma/migrations/20260921140000): a second pending/active row
        // for a user fails P2002, exactly like prod Postgres.
        const userId = (data as { userId?: string }).userId ?? "u1";
        if (
          state.sessions.some(
            (s) => s.userId === userId && (s.status === "pending" || s.status === "active"),
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed: one_open_session_per_user"), {
            code: "P2002",
          });
        }
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
      findMany: async ({ where, orderBy, take }) => {
        const rows = state.sessions.filter((s) => matchesSessionWhere(s, where));
        if (orderBy) rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return take === undefined ? rows : rows.slice(0, take);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const s of state.sessions) {
          const hit =
            "userId" in where ? s.userId === where.userId : s.vehicleId === where.vehicleId;
          if (hit) {
            Object.assign(s, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    sessionEvent: {
      create: async ({ data }) => {
        const row = { id: `se${state.sessionEvents.length + 1}`, ...data };
        state.sessionEvents.push(row);
        return { id: row.id };
      },
      findMany: async ({ where }) =>
        state.sessionEvents
          .filter((e) => where.sessionId.in.includes(e.sessionId))
          .sort((a, b) => a.at.getTime() - b.at.getTime())
          .map((e) => ({
            minutes: null,
            amountUsd: null,
            feeUsd: null,
            expiresAt: null,
            providerSessionId: null,
            details: null,
            ...e,
          })),
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
      findUnique: async ({ where }) => {
        const row = state.deviceTokens.find((t) => t.token === where.token);
        return row ? { id: row.id, userId: row.userId } : null;
      },
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
      deleteMany: async ({ where }) => {
        const before = state.deviceTokens.length;
        state.deviceTokens = state.deviceTokens.filter((t) => t.userId !== where.userId);
        return { count: before - state.deviceTokens.length };
      },
    },
    providerAccount: {
      findUnique: async ({ where }) =>
        accountKey(where.userId_provider.userId, where.userId_provider.provider) ?? null,
      findMany: async ({ where }) =>
        state.providerAccounts.filter((a) =>
          "userId" in where ? a.userId === where.userId : where.status.in.includes(a.status),
        ),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const a of state.providerAccounts) {
          if (a.userId === where.userId) {
            Object.assign(a, data);
            count += 1;
          }
        }
        return { count };
      },
      upsert: async ({ where, create, update }) => {
        const existing = accountKey(where.userId_provider.userId, where.userId_provider.provider);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: ProviderAccountRow = {
          id: `pa${state.providerAccounts.length + 1}`,
          stateEncrypted: null,
          linkedAt: null,
          lastVerifiedAt: null,
          cardAdded: false,
          walletBalanceCents: null,
          createdAt: new Date(MONDAY_2PM),
          ...create,
        } as ProviderAccountRow;
        state.providerAccounts.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = accountKey(where.userId_provider.userId, where.userId_provider.provider);
        if (!row) throw new Error("no provider account");
        Object.assign(row, data);
        return row;
      },
    },
    issuingCardholder: {
      findUnique: async ({ where }) => {
        const holder = cardholderFor(where.userId);
        if (!holder) return null;
        return {
          id: holder.id,
          stripeCardholderId: holder.stripeCardholderId,
          name: holder.name,
          cards: state.issuingCards.filter((c) => c.userId === where.userId).map(toCardRow),
        };
      },
      create: async ({ data }) => {
        state.issuingCardholders.push({ userId: data.userId, name: data.name });
        return {
          id: `ch-${data.userId}`,
          stripeCardholderId: data.stripeCardholderId,
          name: data.name,
        };
      },
      delete: async ({ where }) => {
        const userId = where.id.replace(/^ch-/, "");
        const i = state.issuingCardholders.findIndex((c) => c.userId === userId);
        if (i >= 0) state.issuingCardholders.splice(i, 1);
        return {};
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
      findMany: async ({ where, include }) =>
        state.issuingCards
          .filter((c) => {
            if (typeof where.status === "string" && (c.status ?? "active") !== where.status) {
              return false;
            }
            if (
              typeof where.status === "object" &&
              where.status !== null &&
              (c.status ?? "active") === where.status.not
            ) {
              return false;
            }
            if (
              where.createdAt?.lt !== undefined &&
              (c.createdAt ?? new Date(MONDAY_2PM)) >= where.createdAt.lt
            ) {
              return false;
            }
            if (where.cardholderId !== undefined && `ch-${c.userId}` !== where.cardholderId) {
              return false;
            }
            return true;
          })
          .map((c) => ({
            ...toCardRow(c),
            ...(include?.cardholder ? { cardholder: cardholderFor(c.userId)! } : {}),
          })),
      create: async ({ data }) => {
        const userId = data.cardholderId.replace(/^ch-/, "");
        const row = {
          stripeCardId: data.stripeCardId,
          userId,
          last4: data.last4,
          status: data.status,
          perAuthCapUsd: data.perAuthCapUsd,
          dailyCapUsd: data.dailyCapUsd,
          createdAt: new Date(MONDAY_2PM),
        };
        state.issuingCards.push(row);
        return toCardRow(row);
      },
      update: async ({ where, data }) => {
        const card = state.issuingCards.find((c) => c.stripeCardId === where.stripeCardId);
        if (card) Object.assign(card, data);
        return card ?? {};
      },
      deleteMany: async ({ where }) => {
        for (let i = state.issuingCards.length - 1; i >= 0; i -= 1) {
          if (`ch-${state.issuingCards[i]!.userId}` === where.cardholderId) {
            state.issuingCards.splice(i, 1);
          }
        }
        return {};
      },
    },
    issuingAuthorization: {
      findUnique: async ({ where }) => {
        const row = state.issuingAuthorizations.find(
          (a) => a.stripeAuthorizationId === where.stripeAuthorizationId,
        );
        return row
          ? {
              id: row.stripeAuthorizationId,
              approved: row.approved,
              decision: row.decision,
              status: row.status,
              amountUsd: row.amountUsd,
              holdId: row.holdId ?? null,
            }
          : null;
      },
      findFirst: async ({ where }) => {
        const row = state.issuingAuthorizations.find((a) => a.stripeCardId === where.stripeCardId);
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
        // stripe_authorization_id is UNIQUE in Postgres.
        if (
          state.issuingAuthorizations.some(
            (a) => a.stripeAuthorizationId === data.stripeAuthorizationId,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed: issuing_authorizations"), {
            code: "P2002",
          });
        }
        state.issuingAuthorizations.push({ ...data, createdAt: new Date() });
        return { id: data.stripeAuthorizationId };
      },
      upsert: async (args) => {
        const owner = Symbol("autocommit");
        try {
          return await upsertIssuingAuthorization(owner, args);
        } finally {
          releaseLocks(owner);
        }
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
    $queryRaw: (async (query: TemplateStringsArray, ...values: unknown[]) => {
      const owner = Symbol("autocommit");
      try {
        return await queryRawAs(owner, query, values);
      } finally {
        releaseLocks(owner);
      }
    }) as AppDb["$queryRaw"],
    $transaction: async (fn) => {
      const owner = Symbol("transaction");
      const tx: AppTx = {
        ...db,
        issuingAuthorization: {
          ...db.issuingAuthorization,
          upsert: (args) => upsertIssuingAuthorization(owner, args),
        },
        $queryRaw: ((query: TemplateStringsArray, ...values: unknown[]) =>
          queryRawAs(owner, query, values)) as AppDb["$queryRaw"],
      };
      try {
        return await fn(tx);
      } finally {
        releaseLocks(owner);
      }
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
    retrieveCardSecret: async () => ({
      number: "4242424242424242",
      cvc: "123",
      expMonth: 8,
      expYear: 2030,
      brand: "Visa",
      last4: "4242",
    }),
    createCardholder: async () => ({ stripeCardholderId: "ich-u1" }),
    createCard: async () => ({ stripeCardId: "ic_test_new", last4: "9999", status: "active" }),
    deactivateCardholder: async () => {},
    createPaymentIntent: async () => ({
      paymentIntentId: "pi_test_1",
      clientSecret: "pi_test_1_secret_abc",
    }),
    moveToFinancialAccount: async () => {},
    createTestAuthorization: async () => ({ authorizationId: "iauth_test_1", approved: true }),
    createCustomer: async ({ userId }) => ({ customerId: `cus_${userId}` }),
    deleteCustomer: async () => {},
    createSetupIntent: async () => ({
      setupIntentId: "seti_test_1",
      clientSecret: "seti_test_1_secret_abc",
    }),
    retrieveSetupIntent: async (id) => ({
      setupIntentId: id,
      status: "succeeded",
      customerId: "cus_u1",
      paymentMethodId: "pm_test_visa",
    }),
    retrievePaymentMethod: async (id) => ({
      paymentMethodId: id,
      customerId: "cus_u1",
      brand: "Visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2031,
      wallet: "apple_pay",
    }),
    setCustomerDefaultPaymentMethod: async () => {},
    detachPaymentMethod: async () => {},
    createHold: async ({ idempotencyKey }) => ({
      ok: true,
      paymentIntentId: `pi_${idempotencyKey.replace(/[^a-z0-9]/gi, "_")}`,
    }),
    captureHold: async () => ({ status: "succeeded" }),
    cancelHold: async () => ({ status: "canceled" }),
    ...overrides,
  };
}

/** 32 bytes of a fixed value — a real key, deterministic for tests. */
export const TEST_STATE_KEY = Buffer.alloc(32, 7).toString("base64");

export const testStateCrypto = () => makeStateCrypto(TEST_STATE_KEY);

/** Benign provider ops: cookies verify, card setup and wallet moves work. */
export function makeFakeProviderOps(
  overrides: Partial<ProviderAccountOps> = {},
): ProviderAccountOps {
  return {
    verifyAccount: async () => ({ ok: true, walletBalanceCents: 1250 }),
    setupCard: async () => ({ ok: true }),
    removeCard: async () => ({ ok: true }),
    topupWallet: async () => ({ ok: true, walletBalanceCents: 3250 }),
    readSavedCard: async () => ({ ok: true, brand: "Visa", last4: "4242" }),
    ...overrides,
  };
}

/** Seed a live ParkAgent-card hold (what the Issuing webhook approves
 * against). Defaults: u1, $10 held on session "seed-session", created now. */
export function seedHold(
  state: FakeDbState,
  overrides: Partial<SessionHoldRow> = {},
): SessionHoldRow {
  const row: SessionHoldRow = {
    id: `hold${state.sessionHolds.length + 1}`,
    sessionId: "seed-session",
    userId: "u1",
    leg: "start",
    paymentIntentId: `pi_seed_${state.sessionHolds.length + 1}`,
    fundingMethodId: null,
    quoteUsd: 8,
    amountUsd: 10,
    authorizedUsd: 0,
    capturedUsd: null,
    status: "held",
    declineCode: null,
    settledAt: null,
    createdAt: new Date(MONDAY_2PM),
    ...overrides,
  };
  state.sessionHolds.push(row);
  return row;
}

/** Seed a saved funding card on u1's Stripe Customer (default by default). */
export function seedFundingMethod(
  state: FakeDbState,
  overrides: Partial<FundingMethodRow> = {},
): FundingMethodRow {
  const userId = overrides.userId ?? "u1";
  const user = state.users.find((u) => u.id === userId);
  if (user && !user.stripeCustomerId) user.stripeCustomerId = `cus_${userId}`;
  const row: FundingMethodRow = {
    id: `fm${state.fundingMethods.length + 1}`,
    userId,
    stripePaymentMethodId: `pm_seed_${state.fundingMethods.length + 1}`,
    brand: "Visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2031,
    wallet: "apple_pay",
    isDefault: true,
    createdAt: new Date(MONDAY_2PM),
    removedAt: null,
    ...overrides,
  };
  state.fundingMethods.push(row);
  return row;
}

/** Seed a Link spend request (a garage paid with Link). Approved by
 * default — committed spend against the daily cap. */
export function seedLinkSpendRequest(
  state: FakeDbState,
  overrides: Partial<LinkSpendRequestRow> = {},
): LinkSpendRequestRow {
  const row: LinkSpendRequestRow = {
    id: `lsrq_seed_${state.linkSpendRequests.length + 1}`,
    userId: "u1",
    itineraryId: null,
    stopId: null,
    planId: null,
    amountUsd: 20,
    status: "approved",
    approvalUrl: null,
    merchantName: "SpotHero",
    cardEncrypted: null,
    validUntil: null,
    cardUsedAt: null,
    revealedAt: null,
    createdAt: new Date(MONDAY_2PM),
    ...overrides,
  };
  state.linkSpendRequests.push(row);
  return row;
}

/** Seed a saved vehicle (the session's plate, passed to the executor). */
export function seedVehicle(
  state: FakeDbState,
  overrides: Partial<FakeDbState["vehicles"][number]> = {},
): FakeDbState["vehicles"][number] {
  const row = {
    id: `v${state.vehicles.length + 1}`,
    userId: "u1",
    plate: "ABC123",
    state: "MA",
    label: null,
    createdAt: new Date(MONDAY_2PM),
    ...overrides,
  };
  state.vehicles.push(row);
  return row;
}

/** Seed a linked provider account; state defaults to a sealed empty state. */
export function seedProviderAccount(
  state: FakeDbState,
  overrides: Partial<ProviderAccountRow> = {},
): ProviderAccountRow {
  const row: ProviderAccountRow = {
    id: `pa${state.providerAccounts.length + 1}`,
    userId: "u1",
    provider: "parknyc",
    status: "linked",
    stateEncrypted: testStateCrypto().seal(JSON.stringify({ cookies: [], origins: [] })),
    linkedAt: new Date(MONDAY_2PM),
    lastVerifiedAt: new Date(MONDAY_2PM),
    cardAdded: false,
    walletBalanceCents: null,
    createdAt: new Date(MONDAY_2PM),
    ...overrides,
  };
  state.providerAccounts.push(row);
  return row;
}

export function makeTestApp(options: {
  candidates?: Candidate[];
  /** What GET /zones/near draws; absent leaves the route's 501 seam open. */
  nearbyZones?: NearbyZone[];
  /** Whether the fake geometry fetcher reports hitting its ceiling. */
  nearbyTruncated?: boolean;
  policy?: Partial<Policy>;
  envDryRun?: boolean;
  now?: () => Date;
  zones?: ZoneTermsRow[];
  /** Override the executor used for BOTH dry-run and real paths. */
  executor?: Executor;
  /** Wire a (fake) Stripe gateway; without it /card & co. answer 503. */
  stripe?: StripeGateway;
  /** Fake provider ops; without it provider linking answers 503. */
  providerOps?: ProviderOpsFactory;
  /** Session start requires a linked provider account; u1 gets one unless
   * a test opts out to exercise provider_not_linked. */
  seedLinkedProvider?: boolean;
  /** Scripted assistant transport; absent → /assistant/message 503s. */
  assistantModel?: ModelClient;
  /** Scripted EXPLAIN_MODEL transport for explain_decision phrasing. */
  explainModel?: ModelClient;
  /** ASSISTANT_DAILY_SPEND_CAP_USD equivalent; unset → uncapped. */
  assistantDailySpendCapUsd?: number;
  /** Garage search fake; default returns no results and hits no network. */
  garage?: GarageProvider;
  /** Named-place geocoder fake; default resolves nothing (geocode_place
   * then answers no_match). */
  geocoder?: GeocoderProvider;
  /** Faked Link client; wires the LinkWallet as configured. */
  linkClient?: LinkClient;
  /** Sign in with Apple's token + revoke endpoints (services/appleTokens.ts). */
  appleTokens?: AppleTokenClient;
  /** u1's payment source (default "provider_card", like a fresh user). */
  paymentSource?: string;
  /** ISSUING_LIVE: whether "parkagent_card" may be chosen (default false). */
  issuingLive?: boolean;
  /** A test-mode Stripe key: a Debug build's sandbox choice is honored. */
  issuingSandbox?: boolean;
  /** LINK_TEST_MODE: spend requests are test requests (allowed in dry run). */
  linkTestMode?: boolean;
  /** Reporting APNs delivery for the admin push-test endpoint; absent →
   * that endpoint answers 503. */
  apnsDelivery?: AppDeps["apnsDelivery"];
  /** Override pieces of the auth config (fake verifiers, an email-sender
   * capture). The default verifies nothing — auth tests inject their own. */
  auth?: Partial<AuthConfig>;
}): TestApp {
  const { db, state } = makeFakeDb();
  if (options.paymentSource) {
    state.userPaymentSources["u1"] = options.paymentSource;
  }
  state.zones.push(...(options.zones ?? []));
  if (options.seedLinkedProvider !== false) {
    seedProviderAccount(state);
  }
  const pushes: TestApp["pushes"] = [];
  // Deterministic clock: without it, fixture timestamps (Jan 2026) drift
  // ever further past /parked's ts-clamp window and tests become
  // wall-clock-dependent. Tests that care pass their own `now`.
  const now = options.now ?? (() => new Date(MONDAY_2PM));
  const dryRunExecutor = new DryRunExecutor(() => {}, now);
  const garage: GarageProvider = options.garage ?? {
    id: "fake-garage",
    canReserve: false,
    search: async () => ({ ok: true, options: [], fromCache: false }),
    optionById: () => null,
    book: async () => {
      throw new Error("no garage options in this test");
    },
  };
  const findCandidates = async () => options.candidates ?? [];
  const findNearbyZones = async () => ({
    zones: options.nearbyZones ?? [],
    truncated: options.nearbyTruncated ?? false,
  });
  const policyService = makePolicyService(options.policy, options.envDryRun ?? true);
  const linkWallet = new LinkWallet({
    db,
    stateCrypto: testStateCrypto(),
    linkClient: options.linkClient,
    testMode: options.linkTestMode,
    now,
  });
  const assistantTools = new AssistantTools({
    db,
    policy: policyService,
    findCandidates,
    garage,
    ...(options.geocoder ? { geocoder: options.geocoder } : {}),
    linkWallet,
    ...(options.explainModel ? { explainModel: options.explainModel } : {}),
    now,
  });
  const auth: AuthConfig = {
    jwtSecret: TEST_JWT_SECRET,
    // Default: reject every provider token; auth tests inject verifiers
    // that check real signatures against their own generated keys.
    verifyAppleToken: async () => ({ ok: false, code: "bad_signature" }),
    ...options.auth,
  };
  const deps: AppDeps = {
    db,
    policy: policyService,
    findCandidates,
    findNearbyZones,
    auth,
    authenticate: makeAuthenticate(db, TEST_PEPPER, TEST_JWT_SECRET, now),
    executorFor: () => options.executor ?? dryRunExecutor,
    sendPush: async (userId, push) => {
      pushes.push({ userId, push });
    },
    // The real "is a session awaiting payment?" check over the fake tables,
    // so webhook requests posted through a test app decide like prod.
    hasPendingSession: makePendingSessionCheck(db),
    stateCrypto: testStateCrypto(),
    ...(options.providerOps ? { providerOps: options.providerOps } : {}),
    ...(options.stripe ? { stripe: options.stripe } : {}),
    ...(options.assistantModel ? { assistantModel: options.assistantModel } : {}),
    assistantTools,
    ...(options.assistantDailySpendCapUsd !== undefined
      ? { assistantDailySpendCapUsd: options.assistantDailySpendCapUsd }
      : {}),
    linkWallet,
    ...(options.issuingLive !== undefined ? { issuingLive: options.issuingLive } : {}),
    ...(options.issuingSandbox !== undefined ? { issuingSandbox: options.issuingSandbox } : {}),
    ...(options.apnsDelivery ? { apnsDelivery: options.apnsDelivery } : {}),
    ...(options.appleTokens ? { appleTokens: options.appleTokens } : {}),
    now,
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
