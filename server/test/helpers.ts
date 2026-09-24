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
import { hashApiKey } from "../src/services/apiKeys.js";
import type {
  AppDb,
  ItineraryRow,
  LinkSpendRequestRow,
  ProviderAccountRow,
  SessionRow,
  SessionWhere,
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
import type { LinkClient } from "../src/services/link/linkClient.js";
import { LinkWallet } from "../src/services/link/linkWallet.js";
import type { ProviderAccountOps, ProviderOpsFactory } from "../src/services/providerOps.js";
import type { Push } from "../src/services/apns.js";
import type { Executor } from "../src/services/executor.js";
import { DryRunExecutor } from "../src/services/executor.js";
import type { Policy } from "../src/services/policy.js";
import { PolicyService } from "../src/services/policy.js";
import type { StripeGateway } from "../src/services/stripeGateway.js";
import type { Candidate, NearbyZone } from "../src/services/zoneLookup.js";

export const API_KEY = "test-key";
/** A second, non-admin user's key — for authorization (403) tests. */
export const NONADMIN_API_KEY = "test-key-two";
/** The pepper every test app hashes keys with (see makeAuthenticate). */
export const TEST_PEPPER = "test-pepper-16-chars-min";

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
  vehicles: { id: string; userId: string; plate: string; state: string; createdAt: Date }[];
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
  }[];
  linkSpendRequests: LinkSpendRequestRow[];
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
  return true;
}

export function makeFakeDb(): { db: AppDb; state: FakeDbState } {
  const state: FakeDbState = {
    userPaymentSources: {},
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
  const db: AppDb = {
    user: {
      // Auth looks up by hash now — mirror prod: only the peppered hashes
      // match. u1 is the owner/admin; u2 exercises the 403 paths.
      findUnique: async ({ where }) => {
        const sourceFor = (id: string) => state.userPaymentSources[id] ?? "provider_card";
        if ("apiKeyHash" in where) {
          if (where.apiKeyHash === hashApiKey(TEST_PEPPER, API_KEY)) {
            return { id: "u1", name: "Thomas", isAdmin: true, paymentSource: sourceFor("u1") };
          }
          if (where.apiKeyHash === hashApiKey(TEST_PEPPER, NONADMIN_API_KEY)) {
            return { id: "u2", name: "Ana", isAdmin: false, paymentSource: sourceFor("u2") };
          }
          return null;
        }
        if (where.id === "u1") {
          return { id: "u1", name: "Thomas", isAdmin: true, paymentSource: sourceFor("u1") };
        }
        if (where.id === "u2") {
          return { id: "u2", name: "Ana", isAdmin: false, paymentSource: sourceFor("u2") };
        }
        return null;
      },
      update: async ({ where, data }) => {
        state.userPaymentSources[where.id] = data.paymentSource;
        return { paymentSource: data.paymentSource };
      },
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
      update: async ({ where, data }) => {
        const row = state.assistantConfirmations.find((r) => r.token === where.token);
        if (row) Object.assign(row, data);
        return {};
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
          createdAt: new Date(MONDAY_2PM),
          ...data,
        } as LinkSpendRequestRow);
        return {};
      },
      findUnique: async ({ where }) =>
        state.linkSpendRequests.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }) =>
        state.linkSpendRequests.filter((r) => r.userId === where.userId),
      update: async ({ where, data }) => {
        const row = state.linkSpendRequests.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return {};
      },
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
          .filter((d) => (d.createdAt ?? new Date(MONDAY_2PM)) >= where.createdAt.gte)
          .map((d, i) => ({
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
    },
    providerAccount: {
      findUnique: async ({ where }) =>
        accountKey(where.userId_provider.userId, where.userId_provider.provider) ?? null,
      findMany: async ({ where }) =>
        state.providerAccounts.filter((a) => a.userId === where.userId),
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
          ? { id: row.stripeAuthorizationId, approved: row.approved, decision: row.decision }
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
    ...overrides,
  };
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
  /** Garage search fake; default returns no results and hits no network. */
  garage?: GarageProvider;
  /** Named-place geocoder fake; default resolves nothing (geocode_place
   * then answers no_match). */
  geocoder?: GeocoderProvider;
  /** Faked Link client; wires the LinkWallet as configured. */
  linkClient?: LinkClient;
  /** u1's payment source (default "provider_card", like a fresh user). */
  paymentSource?: string;
  /** ISSUING_LIVE: whether "issuing_card" may be chosen (default false). */
  issuingLive?: boolean;
  /** Reporting APNs delivery for the admin push-test endpoint; absent →
   * that endpoint answers 503. */
  apnsDelivery?: AppDeps["apnsDelivery"];
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
    now,
  });
  const assistantTools = new AssistantTools({
    db,
    policy: policyService,
    findCandidates,
    garage,
    ...(options.geocoder ? { geocoder: options.geocoder } : {}),
    linkWallet,
    now,
  });
  const deps: AppDeps = {
    db,
    policy: policyService,
    findCandidates,
    findNearbyZones,
    authenticate: makeAuthenticate(db, TEST_PEPPER),
    executorFor: () => options.executor ?? dryRunExecutor,
    sendPush: async (userId, push) => {
      pushes.push({ userId, push });
    },
    stateCrypto: testStateCrypto(),
    ...(options.providerOps ? { providerOps: options.providerOps } : {}),
    ...(options.stripe ? { stripe: options.stripe } : {}),
    ...(options.assistantModel ? { assistantModel: options.assistantModel } : {}),
    assistantTools,
    linkWallet,
    ...(options.issuingLive !== undefined ? { issuingLive: options.issuingLive } : {}),
    ...(options.apnsDelivery ? { apnsDelivery: options.apnsDelivery } : {}),
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
