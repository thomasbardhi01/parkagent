import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

/**
 * The slice of the Prisma client the routes actually use. Routes and tests
 * are written against this, so tests fake five methods instead of dragging
 * a database into vitest.
 */
export interface AppDb {
  user: {
    findUnique(args: { where: { apiKey: string } }): Promise<{ id: string; name: string } | null>;
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
  };
  decision: {
    create(args: {
      data: {
        kind: string;
        inputs: unknown;
        rule: string;
        outcome: unknown;
        userId: string;
        parkedEventId: string;
      };
    }): Promise<{ id: string }>;
  };
  session: {
    findMany(args: {
      where: {
        userId: string;
        dryRun: boolean;
        status: { in: string[] };
        createdAt: { gte: Date };
      };
      select: { amountUsd: true; feeUsd: true };
    }): Promise<{ amountUsd: unknown; feeUsd: unknown }[]>;
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
