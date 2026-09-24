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
  /** "issuing_card" | "provider_card" | "link_wallet"; pre-assistant
   * fakes may omit it. */
  paymentSource?: string;
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
  vehicleId?: string;
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
  paymentSource?: string;
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

/** Provider-displayed zone terms, keyed (city, zone number) — see
 * schema.prisma. Quoting prefers these over the dataset when present. */
export interface ZoneTermsObservedRow {
  city: string;
  zoneNumber: string;
  /** Decimal | null; convert with Number(...). */
  ratePerHourUsd: unknown;
  maxStayMinutes: number | null;
  rawText: string;
  hoursJson: unknown;
  zoneId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** One imported (Find Parking feed) number for a zone — see schema.prisma. */
export interface ZoneNumberImportRow {
  zoneId: string;
  number: string;
  confidence: number;
  method: string;
  sourceName: string;
  importedAt: Date;
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
  /** provider_card display info read off the provider's Your Cards screen
   * at link time — brand + last4 only, never the PAN. Optional so
   * pre-existing fakes stay valid. */
  cardBrand?: string | null;
  cardLast4?: string | null;
  walletBalanceCents: number | null;
  createdAt: Date;
}

export interface ProviderAccountWrite {
  status?: string;
  stateEncrypted?: string | null;
  linkedAt?: Date;
  lastVerifiedAt?: Date;
  cardAdded?: boolean;
  cardBrand?: string | null;
  cardLast4?: string | null;
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

export interface ItineraryRow {
  id: string;
  userId: string;
  planId: string | null;
  status: string;
  date: Date;
  stops: unknown;
  totalUsd: unknown;
  createdAt: Date;
}

export interface LinkSpendRequestRow {
  id: string;
  userId: string;
  itineraryId: string | null;
  stopId: string | null;
  planId: string | null;
  amountUsd: unknown;
  status: string;
  approvalUrl: string | null;
  cardEncrypted: string | null;
  validUntil: Date | null;
  cardUsedAt: Date | null;
  createdAt: Date;
}

/** The identity view of a users row. Callers that pass `select` must only
 * read the fields they selected — the type is the union of what any caller
 * may ask for, not a promise that every field came back. */
export interface UserIdentityRow {
  id: string;
  name: string;
  isAdmin: boolean;
  paymentSource: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  appleSub: string | null;
  googleSub: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface UserUpdate {
  name?: string;
  paymentSource?: string;
  email?: string | null;
  emailVerified?: boolean;
  phone?: string | null;
  phoneVerified?: boolean;
  appleSub?: string | null;
  googleSub?: string | null;
  deletedAt?: Date;
  apiKey?: null;
  apiKeyHash?: null;
  apiKeyPrefix?: null;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  deviceId: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface EmailLoginCodeRow {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface VehicleRow {
  id: string;
  userId: string;
  plate: string;
  state: string;
  label: string | null;
  createdAt: Date;
}

export interface AppDb {
  user: {
    findUnique(args: {
      where:
        | { apiKeyHash: string }
        | { id: string }
        | { email: string }
        | { appleSub: string }
        | { googleSub: string };
      /** Always pass this on auth-path reads: without it the runtime row
       * carries the key hash and prefix, one spread away from a response
       * body. Read only the fields you selected. */
      select?: Partial<Record<keyof UserIdentityRow, true>>;
    }): Promise<UserIdentityRow | null>;
    create(args: {
      data: {
        name: string;
        email?: string;
        emailVerified?: boolean;
        phone?: string;
        appleSub?: string;
        googleSub?: string;
      };
    }): Promise<UserIdentityRow>;
    update(args: {
      where: { id: string };
      data: UserUpdate;
      select?: Partial<Record<keyof UserIdentityRow, true>>;
    }): Promise<UserIdentityRow>;
  };
  refreshToken: {
    create(args: {
      data: {
        userId: string;
        familyId: string;
        tokenHash: string;
        deviceId: string;
        expiresAt: Date;
      };
    }): Promise<{ id: string }>;
    findUnique(args: { where: { tokenHash: string } }): Promise<RefreshTokenRow | null>;
    update(args: {
      where: { id: string };
      data: { rotatedAt?: Date; revokedAt?: Date };
    }): Promise<unknown>;
    /** Two shapes: reuse detection's kill switch (revoke every live token
     * in a family), and rotation's compare-and-set (stamp one token rotated
     * only if nobody else already has — count 0 means a racing replay). */
    updateMany(
      args:
        | { where: { familyId: string; revokedAt: null }; data: { revokedAt: Date } }
        | { where: { id: string; rotatedAt: null; revokedAt: null }; data: { rotatedAt: Date } },
    ): Promise<{ count: number }>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  emailLoginCode: {
    create(args: {
      data: { email: string; codeHash: string; expiresAt: Date; createdAt?: Date };
    }): Promise<{ id: string }>;
    /** The newest unconsumed code for the address — the one verify checks. */
    findFirst(args: {
      where: { email: string; consumedAt: null };
      orderBy: { createdAt: "desc" };
    }): Promise<EmailLoginCodeRow | null>;
    /** Conditional writes, so concurrent verifies can't share an attempt or
     * both consume the code: claim one attempt while under the cap, and
     * consume only while unconsumed. count 0 means someone else got there. */
    updateMany(
      args:
        | {
            where: { id: string; consumedAt: null; attempts: { lt: number } };
            data: { attempts: { increment: number } };
          }
        | { where: { id: string; consumedAt: null }; data: { consumedAt: Date } },
    ): Promise<{ count: number }>;
    /** Per-email send throttle: codes issued to the address since `gte`. */
    count(args: { where: { email: string; createdAt: { gte: Date } } }): Promise<number>;
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
  zoneNumberImport: {
    findUnique(args: { where: { zoneId: string } }): Promise<ZoneNumberImportRow | null>;
  };
  zoneTermsObserved: {
    findUnique(args: {
      where: { city_zoneNumber: { city: string; zoneNumber: string } };
    }): Promise<ZoneTermsObservedRow | null>;
    /** The /parked batch read: observed rows for the candidate zone numbers. */
    findMany(args: {
      where: { city: string; zoneNumber: { in: string[] } };
    }): Promise<ZoneTermsObservedRow[]>;
    upsert(args: {
      where: { city_zoneNumber: { city: string; zoneNumber: string } };
      create: {
        city: string;
        zoneNumber: string;
        ratePerHourUsd: number | null;
        maxStayMinutes: number | null;
        rawText: string;
        hoursJson?: unknown;
        zoneId?: string;
        lastSeenAt: Date;
      };
      update: {
        ratePerHourUsd: number | null;
        maxStayMinutes: number | null;
        rawText: string;
        hoursJson?: unknown;
        zoneId?: string;
        lastSeenAt: Date;
      };
    }): Promise<ZoneTermsObservedRow>;
  };
  vehicle: {
    /** The session's vehicle: the caller's first saved plate. */
    findFirst(args: {
      where: { userId: string };
      orderBy: { createdAt: "asc" };
    }): Promise<{ id: string; plate: string; state: string } | null>;
    findUnique(args: { where: { id: string } }): Promise<VehicleRow | null>;
    findMany(args: {
      where: { userId: string };
      orderBy: { createdAt: "asc" };
    }): Promise<VehicleRow[]>;
    create(args: {
      data: { userId: string; plate: string; state: string; label?: string | null };
    }): Promise<VehicleRow>;
    update(args: {
      where: { id: string };
      data: { plate?: string; state?: string; label?: string | null };
    }): Promise<VehicleRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
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
  conversation: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; userId: string; turns: unknown } | null>;
    upsert(args: {
      where: { id: string };
      create: { id: string; userId: string; turns: unknown };
      update: { turns: unknown };
    }): Promise<unknown>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  assistantPlan: {
    create(args: {
      data: { id: string; userId: string; conversationId: string; kind: string; plan: unknown };
    }): Promise<{ id: string }>;
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      userId: string;
      conversationId: string;
      kind: string;
      plan: unknown;
    } | null>;
  };
  assistantConfirmation: {
    create(args: {
      data: {
        token: string;
        userId: string;
        planId: string;
        optionId: string | null;
        expiresAt: Date;
      };
    }): Promise<unknown>;
    findUnique(args: { where: { token: string } }): Promise<{
      token: string;
      userId: string;
      planId: string;
      optionId: string | null;
      expiresAt: Date;
      usedAt: Date | null;
    } | null>;
    update(args: { where: { token: string }; data: { usedAt: Date } }): Promise<unknown>;
  };
  itinerary: {
    create(args: {
      data: {
        id: string;
        userId: string;
        planId: string | null;
        status: string;
        date: Date;
        stops: unknown;
        totalUsd: number;
      };
    }): Promise<{ id: string }>;
    findUnique(args: { where: { id: string } }): Promise<ItineraryRow | null>;
    findMany(args: { where: { userId?: string; status?: string } }): Promise<ItineraryRow[]>;
    update(args: {
      where: { id: string };
      data: { stops?: unknown; totalUsd?: number; status?: string };
    }): Promise<unknown>;
  };
  linkAccount: {
    findUnique(args: { where: { userId: string } }): Promise<{
      userId: string;
      status: string;
      tokensEncrypted: string | null;
      connectedAt: Date | null;
    } | null>;
    upsert(args: {
      where: { userId: string };
      create: {
        userId: string;
        status: string;
        tokensEncrypted?: string | null;
        connectedAt?: Date;
      };
      update: { status: string; tokensEncrypted?: string | null; connectedAt?: Date };
    }): Promise<unknown>;
  };
  linkSpendRequest: {
    create(args: {
      data: {
        id: string;
        userId: string;
        planId?: string;
        itineraryId?: string;
        stopId?: string;
        amountUsd: number;
        status: string;
        approvalUrl: string | null;
        validUntil: Date | null;
      };
    }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<LinkSpendRequestRow | null>;
    findMany(args: { where: { userId: string } }): Promise<LinkSpendRequestRow[]>;
    update(args: {
      where: { id: string };
      data: {
        status?: string;
        cardEncrypted?: string;
        validUntil?: Date;
        cardUsedAt?: Date;
      };
    }): Promise<unknown>;
  };
  processedTopup: {
    findUnique(args: {
      where: { paymentIntentId: string };
    }): Promise<{ paymentIntentId: string } | null>;
    create(args: {
      data: { paymentIntentId: string; amountUsd: number; userId?: string | null };
    }): Promise<unknown>;
  };
  linkJob: {
    create(args: {
      data: {
        id: string;
        userId: string;
        provider: string;
        phase: string;
        reason?: string;
        retrySafe?: boolean;
        dryRun?: boolean;
      };
    }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: { phase?: string; reason?: string; retrySafe?: boolean; dryRun?: boolean };
    }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      userId: string;
      provider: string;
      phase: string;
      reason: string | null;
      retrySafe: boolean | null;
      dryRun: boolean | null;
      createdAt: Date;
    } | null>;
    /** The janitor's timeout sweep. */
    updateMany(args: {
      where: { phase: { in: string[] }; createdAt: { lt: Date } };
      data: { phase: string; reason: string; retrySafe: boolean };
    }): Promise<{ count: number }>;
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
    /** explain_decision's read: one row by id (ownership checked above). */
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      kind: string;
      rule: string;
      inputs: unknown;
      outcome: unknown;
      userId: string | null;
      createdAt: Date;
    } | null>;
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
    findMany(args: {
      where: { userId: string } | { status: { in: string[] } };
    }): Promise<ProviderAccountRow[]>;
    upsert(args: {
      where: { userId_provider: { userId: string; provider: string } };
      create: { userId: string; provider: string; status: string } & ProviderAccountWrite;
      update: ProviderAccountWrite;
    }): Promise<ProviderAccountRow>;
    update(args: {
      where: { userId_provider: { userId: string; provider: string } };
      data: ProviderAccountWrite;
    }): Promise<ProviderAccountRow>;
    /** Account deletion: unlink everything and drop the sealed states. */
    updateMany(args: {
      where: { userId: string };
      data: ProviderAccountWrite;
    }): Promise<{ count: number }>;
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
    /** Vehicle/account deletion: detach sessions from vehicles being
     * deleted (sessions themselves stay — they are the money audit). */
    updateMany(args: {
      where: { userId: string } | { vehicleId: string };
      data: { vehicleId: null };
    }): Promise<{ count: number }>;
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
    findUnique(args: { where: { token: string } }): Promise<{ id: string; userId: string } | null>;
    upsert(args: {
      where: { token: string };
      create: { userId: string; token: string; platform: string; environment: string };
      // userId deliberately absent: a binding never moves on update.
      update: { platform: string; environment: string };
    }): Promise<unknown>;
    findMany(args: {
      where: { userId: string };
    }): Promise<{ id: string; token: string; environment: string }[]>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
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
