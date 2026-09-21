import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

/**
 * The slice of the Prisma client the routes and jobs actually use. Routes
 * and tests are written against this, so tests fake a handful of methods
 * instead of dragging a database into vitest.
 *
 * Decimal columns come back as Prisma Decimal objects; callers convert
 * with Number(...) (they're all ≤ 4 digits of dollars).
 */

export interface SessionRow {
  id: string;
  userId: string;
  vehicleId: string | null;
  zoneId: string;
  /** "nyc" | "bos", from the zone at start; pre-city rows default "nyc". */
  city: string;
  providerZoneNumber: string;
  status: string;
  dryRun: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
  stoppedAt: Date | null;
  amountUsd: unknown;
  feeUsd: unknown;
  parknycConfirmation: string | null;
  parkedEventId: string | null;
  carLat: number | null;
  carLng: number | null;
  rateFirstHour: unknown;
  rateAdditionalHour: unknown;
  maxStayMinutes: number | null;
  hoursJson: unknown;
  purchasedMinutes: number;
  chargedMinutes: number;
  extendCount: number;
  lastExtenderRule: string | null;
  lastExtenderRuleAt: Date | null;
  createdAt: Date;
}

/** Fields sessions routes write; everything else is column defaults. */
export interface SessionWrite {
  userId?: string;
  zoneId?: string;
  city?: string;
  providerZoneNumber?: string;
  status?: string;
  dryRun?: boolean;
  startedAt?: Date;
  expiresAt?: Date;
  stoppedAt?: Date;
  amountUsd?: number;
  feeUsd?: number;
  parknycConfirmation?: string;
  parkedEventId?: string;
  carLat?: number;
  carLng?: number;
  rateFirstHour?: number;
  rateAdditionalHour?: number;
  maxStayMinutes?: number | null;
  hoursJson?: unknown;
  purchasedMinutes?: number;
  chargedMinutes?: number;
  extendCount?: number;
  lastExtenderRule?: string;
  lastExtenderRuleAt?: Date;
}

export interface SessionWhere {
  id?: { not: string };
  userId?: string;
  zoneId?: string;
  dryRun?: boolean;
  status?: string | { in: string[] };
  createdAt?: { gte: Date };
}

export interface ZoneTermsRow {
  zoneId: string;
  /** "nyc" | "bos"; optional so pre-city fakes/fixtures stay valid. */
  city?: string;
  /** Street the zone is on (Boston rows); cross-check evidence. */
  street?: string | null;
  /** "" when unknown — Boston numbers come from user reports. */
  providerZoneNumber: string;
  /** Two different users reported the same number; optional for old fakes. */
  providerZoneNumberVerified?: boolean;
  rateFirstHour: unknown;
  rateAdditionalHour: unknown;
  maxStayMinutes: number | null;
  hoursJson: unknown;
}

/** One user's report of the number posted at a zone. */
export interface ZoneNumberReportRow {
  id: string;
  zoneId: string;
  userId: string;
  number: string;
  source: string;
  createdAt: Date;
}

/** One linked provider account (see providers/registry.ts). */
export interface ProviderAccountRow {
  id: string;
  userId: string;
  provider: string;
  status: string;
  /** Sealed (AES-256-GCM) Playwright storage state; never returned to clients. */
  stateEncrypted: string | null;
  linkedAt: Date | null;
  lastVerifiedAt: Date | null;
  cardAdded: boolean;
  walletBalanceCents: number | null;
  createdAt: Date;
}

export interface ProviderAccountWrite {
  status?: string;
  stateEncrypted?: string | null;
  linkedAt?: Date;
  lastVerifiedAt?: Date;
  cardAdded?: boolean;
  walletBalanceCents?: number | null;
}

/** issuing_cards row as the card lifecycle code reads it. */
export interface IssuingCardRow {
  id: string;
  cardholderId: string;
  stripeCardId: string;
  last4: string;
  status: string;
  perAuthCapUsd: unknown;
  dailyCapUsd: unknown;
  createdAt: Date;
  /** Present when the query included the cardholder. */
  cardholder?: { id: string; userId: string; stripeCardholderId: string; name: string };
}

/** Full ledger row, as GET /card/transactions reads it. */
export interface IssuingAuthorizationRow {
  id: string;
  stripeAuthorizationId: string;
  stripeCardId: string;
  userId: string | null;
  amountUsd: unknown;
  merchantCategory: string | null;
  merchantCategoryCode: string | null;
  merchantName: string | null;
  approved: boolean;
  decision: string;
  status: string;
  stripeTransactionId: string | null;
  capturedUsd: unknown;
  createdAt: Date;
}

export interface AppDb {
  user: {
    findUnique(args: {
      where: { apiKeyHash: string };
      /** Always pass this: without it the runtime row carries the key
       * hash and prefix, one spread away from a response body. */
      select?: { id: true; name: true; isAdmin: true };
    }): Promise<{ id: string; name: string; isAdmin: boolean } | null>;
  };
  zone: {
    findUnique(args: { where: { zoneId: string } }): Promise<ZoneTermsRow | null>;
    update(args: {
      where: { zoneId: string };
      data: { providerZoneNumber?: string; providerZoneNumberVerified?: boolean };
    }): Promise<ZoneTermsRow>;
  };
  zoneNumberReport: {
    findMany(args: { where: { zoneId: string } }): Promise<ZoneNumberReportRow[]>;
    upsert(args: {
      where: { zoneId_userId: { zoneId: string; userId: string } };
      create: { zoneId: string; userId: string; number: string; source: string };
      update: { number: string; source: string };
    }): Promise<ZoneNumberReportRow>;
  };
  parkedEvent: {
    create(args: {
      data: {
        userId: string;
        lat: number;
        lng: number;
        accuracyM: number;
        ts: Date;
        signals: string[];
      };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; userId: string; lat: number; lng: number; ts: Date } | null>;
    /** The /admin/summary read: today's parks and their detector signals. */
    findMany(args: {
      where: { ts: { gte: Date } };
    }): Promise<{ id: string; userId: string; signals: unknown; ts: Date }[]>;
  };
  decision: {
    create(args: {
      data: {
        kind: string;
        inputs: unknown;
        rule: string;
        outcome: unknown;
        // userId nullable: issuing decisions may have no user (unknown card).
        userId?: string | null;
        parkedEventId?: string;
        sessionId?: string;
      };
    }): Promise<{ id: string }>;
    /** The /admin/summary read: today's decisions, oldest first. */
    findMany(args: { where: { createdAt: { gte: Date } } }): Promise<
      {
        kind: string;
        rule: string;
        outcome: unknown;
        inputs: unknown;
        userId: string | null;
        sessionId: string | null;
        createdAt: Date;
      }[]
    >;
  };
  providerAccount: {
    findUnique(args: {
      where: { userId_provider: { userId: string; provider: string } };
    }): Promise<ProviderAccountRow | null>;
    findMany(args: { where: { userId: string } }): Promise<ProviderAccountRow[]>;
    upsert(args: {
      where: { userId_provider: { userId: string; provider: string } };
      create: { userId: string; provider: string; status: string } & ProviderAccountWrite;
      update: ProviderAccountWrite;
    }): Promise<ProviderAccountRow>;
    update(args: {
      where: { userId_provider: { userId: string; provider: string } };
      data: ProviderAccountWrite;
    }): Promise<ProviderAccountRow>;
  };
  issuingCardholder: {
    findUnique(args: { where: { userId: string }; include: { cards: true } }): Promise<{
      id: string;
      stripeCardholderId: string;
      name: string;
      cards: {
        id: string;
        stripeCardId: string;
        last4: string;
        status: string;
        perAuthCapUsd: unknown;
        dailyCapUsd: unknown;
      }[];
    } | null>;
    create(args: {
      data: { userId: string; stripeCardholderId: string; name: string };
    }): Promise<{ id: string; stripeCardholderId: string; name: string }>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  issuingCard: {
    findUnique(args: {
      where: { stripeCardId: string };
      include: { cardholder: true };
    }): Promise<{ id: string; stripeCardId: string; cardholder: { userId: string } } | null>;
    // The janitor sweeps by status+age (with the cardholder for the user
    // link); the cardholder cleanup asks for its remaining cards.
    findMany(args: {
      where: {
        status?: string | { not: string };
        createdAt?: { lt: Date };
        cardholderId?: string;
      };
      include?: { cardholder: true };
    }): Promise<IssuingCardRow[]>;
    create(args: {
      data: {
        cardholderId: string;
        stripeCardId: string;
        last4: string;
        status: string;
        perAuthCapUsd: number;
        dailyCapUsd: number;
      };
    }): Promise<IssuingCardRow>;
    update(args: { where: { stripeCardId: string }; data: { status: string } }): Promise<unknown>;
    deleteMany(args: { where: { cardholderId: string } }): Promise<unknown>;
  };
  issuingAuthorization: {
    findUnique(args: {
      where: { stripeAuthorizationId: string };
    }): Promise<{ id: string; approved?: boolean; decision?: string } | null>;
    /** "Has this card ever transacted?" — the janitor's cancel-vs-freeze test. */
    findFirst(args: { where: { stripeCardId: string } }): Promise<{ id: string } | null>;
    // Two shapes share findMany (interface overloads): the daily/monthly spend
    // sum reads amounts only; the transactions list reads full rows, newest
    // first, with an optional created-before cursor.
    findMany(args: {
      where: { userId: string; approved: boolean; createdAt: { gte: Date } };
      select: { amountUsd: true };
    }): Promise<{ amountUsd: unknown }[]>;
    findMany(args: {
      where: { userId: string; createdAt?: { lt: Date } };
      orderBy: { createdAt: "desc" };
      take: number;
    }): Promise<IssuingAuthorizationRow[]>;
    create(args: {
      data: {
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
      };
    }): Promise<{ id: string }>;
    update(args: {
      where: { stripeAuthorizationId: string };
      data: {
        approved?: boolean;
        decision?: string;
        status?: string;
        amountUsd?: number;
        stripeTransactionId?: string;
        capturedUsd?: number;
      };
    }): Promise<unknown>;
  };
  session: {
    create(args: { data: SessionWrite }): Promise<SessionRow>;
    update(args: { where: { id: string }; data: SessionWrite }): Promise<SessionRow>;
    findUnique(args: { where: { id: string } }): Promise<SessionRow | null>;
    findFirst(args: { where: SessionWhere }): Promise<SessionRow | null>;
    findMany(args: { where: SessionWhere }): Promise<SessionRow[]>;
  };
  sessionEvent: {
    create(args: {
      data: {
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
      };
    }): Promise<{ id: string }>;
  };
  locationFix: {
    create(args: {
      data: {
        sessionId: string;
        userId: string;
        lat: number;
        lng: number;
        accuracyM: number;
        ts: Date;
      };
    }): Promise<{ id: string }>;
    findMany(args: {
      where: { sessionId: string };
      orderBy: { ts: "desc" };
      take: number;
    }): Promise<{ lat: number; lng: number; accuracyM: number; ts: Date }[]>;
  };
  deviceToken: {
    upsert(args: {
      where: { token: string };
      create: { userId: string; token: string; platform: string; environment: string };
      update: { userId: string; platform: string; environment: string };
    }): Promise<unknown>;
    findMany(args: {
      where: { userId: string };
    }): Promise<{ id: string; token: string; environment: string }[]>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  policySnapshot: {
    findFirst(args: {
      orderBy: { id: "desc" };
      select: { hash: true };
    }): Promise<{ hash: string } | null>;
    create(args: { data: { hash: string; policy: unknown; source: string } }): Promise<unknown>;
  };
}

export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

/**
 * View the full client through the narrow interface. Prisma's generic
 * method signatures aren't structurally assignable to the plain ones above,
 * hence the cast; the shapes match by construction.
 */
export function asAppDb(prisma: PrismaClient): AppDb {
  return prisma as unknown as AppDb;
}
