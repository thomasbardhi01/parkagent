/**
 * FR throwaway accounts: minted by scripts/create-fr-throwaway.ts for the
 * FR-32 live tests, deleted by the suite (DELETE /me) — and, when a run
 * dies before that, found and torn down here by
 * scripts/purge-fr-throwaways.ts.
 *
 * Selection is deliberately narrow. A row is a throwaway only when ALL of
 * these hold:
 *  - create-fr-throwaway's marker decision names it (only that script
 *    writes `auth_identity / fr_throwaway_minted`);
 *  - it carries no sign-in identity (email, Apple, Google) and no api key,
 *    and isn't an admin — so neither a person nor the FR user can match;
 *  - while live, its name is still exactly `fr-throwaway <ISO time>`.
 * A live one is torn down only once it is older than the minimum age, so
 * a run in flight is never pulled out from under itself.
 */

import type { AppDb, ThrowawayCheckRow } from "../db.js";
import { deleteAccount, type AccountDeletionDeps } from "./accountDeletion.js";

/** The decision create-fr-throwaway writes for every account it mints. */
export const FR_THROWAWAY_MARKER = { kind: "auth_identity", rule: "fr_throwaway_minted" } as const;

const NAME_PATTERN = /^fr-throwaway \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The name create-fr-throwaway gives an account (and the purge expects). */
export function frThrowawayName(mintedAt: Date): string {
  return `fr-throwaway ${mintedAt.toISOString()}`;
}

export type ThrowawayAction =
  /** Live and old enough: run the DELETE /me teardown. */
  | "delete"
  /** Already tombstoned, but refresh-token rows remain: remove them. */
  | "clear_sessions"
  /** Already tombstoned with nothing left: nothing to do. */
  | "clean"
  /** Live but younger than the minimum age: a run may be using it. */
  | "too_fresh"
  /** Tearing it down would need Stripe or Link: left for a human. */
  | "needs_manual"
  /** Marked, but it doesn't look minted (identity, key, admin, renamed). */
  | "not_a_throwaway";

export interface ThrowawayVerdict {
  userId: string;
  name: string;
  createdAt: Date | null;
  action: ThrowawayAction;
  refreshTokens: number;
  reason?: string;
}

export interface PurgeOptions {
  now: Date;
  minAgeMinutes: number;
  /** Ids exempt from the age gate (the nightly's own throwaway, right
   * after its suite). Every other check still applies. */
  include?: string[];
}

export async function planThrowawayPurge(
  db: AppDb,
  options: PurgeOptions,
): Promise<ThrowawayVerdict[]> {
  const markers = await db.decision.findMany({ where: { ...FR_THROWAWAY_MARKER } });
  const ids = [
    ...new Set(
      markers
        // Re-filtered here too: the read must never widen what it matches.
        .filter((d) => d.kind === FR_THROWAWAY_MARKER.kind && d.rule === FR_THROWAWAY_MARKER.rule)
        .map((d) => d.userId)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  if (ids.length === 0) return [];
  const rows = await db.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      isAdmin: true,
      email: true,
      appleSub: true,
      googleSub: true,
      apiKey: true,
      apiKeyHash: true,
      stripeCustomerId: true,
      deletedAt: true,
      createdAt: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cutoff = options.now.getTime() - options.minAgeMinutes * 60_000;
  const include = new Set(options.include ?? []);

  const verdicts: ThrowawayVerdict[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      verdicts.push(verdict(id, null, "not_a_throwaway", 0, "no users row"));
      continue;
    }
    const refreshTokens = await db.refreshToken.count({ where: { userId: id } });
    const disqualified = disqualify(row);
    if (disqualified) {
      verdicts.push(verdict(id, row, "not_a_throwaway", refreshTokens, disqualified));
      continue;
    }
    if (row.deletedAt) {
      // Tombstoned: no credential works for it any more, so there is no
      // run to protect — any leftover session rows just go.
      verdicts.push(
        verdict(id, row, refreshTokens > 0 ? "clear_sessions" : "clean", refreshTokens),
      );
      continue;
    }
    if (row.createdAt.getTime() > cutoff && !include.has(id)) {
      verdicts.push(verdict(id, row, "too_fresh", refreshTokens));
      continue;
    }
    const manual = await needsManual(db, row);
    if (manual) {
      verdicts.push(verdict(id, row, "needs_manual", refreshTokens, manual));
      continue;
    }
    verdicts.push(verdict(id, row, "delete", refreshTokens));
  }
  return verdicts;
}

export interface PurgeResult {
  deleted: string[];
  sessionsCleared: string[];
}

/**
 * Act on a plan. `delete` runs the exact DELETE /me teardown (its
 * account_delete decision records `via`); `clear_sessions` removes the
 * rows and writes its own decision. Deps carry no Stripe or Link client:
 * rows that would need one were planned `needs_manual`.
 */
export async function applyThrowawayPurge(
  deps: AccountDeletionDeps,
  plan: ThrowawayVerdict[],
  via: string,
): Promise<PurgeResult> {
  const result: PurgeResult = { deleted: [], sessionsCleared: [] };
  for (const item of plan) {
    if (item.action === "delete") {
      await deleteAccount(deps, item.userId, { via, frThrowaway: true });
      result.deleted.push(item.userId);
    } else if (item.action === "clear_sessions") {
      const removed = await deps.db.refreshToken.deleteMany({ where: { userId: item.userId } });
      await deps.db.decision.create({
        data: {
          kind: "account_delete",
          inputs: { via, frThrowaway: true, refreshTokens: item.refreshTokens },
          rule: "fr_throwaway_sessions_cleared",
          outcome: { ok: true, removed: removed.count },
          userId: item.userId,
        },
      });
      result.sessionsCleared.push(item.userId);
    }
  }
  return result;
}

function disqualify(row: ThrowawayCheckRow): string | null {
  if (row.email || row.appleSub || row.googleSub) return "has a sign-in identity";
  if (row.apiKey || row.apiKeyHash) return "has an api key";
  if (row.isAdmin) return "is an admin";
  if (!row.deletedAt && !NAME_PATTERN.test(row.name)) return "renamed";
  return null;
}

async function needsManual(db: AppDb, row: ThrowawayCheckRow): Promise<string | null> {
  if (row.stripeCustomerId) return "has a Stripe Customer";
  const holder = await db.issuingCardholder.findUnique({
    where: { userId: row.id },
    include: { cards: true },
  });
  if (holder && holder.cards.length > 0) return "has an issued card";
  const link = await db.linkAccount.findUnique({ where: { userId: row.id } });
  if (link && (link.status === "connected" || link.tokensEncrypted)) {
    return "has Link wallet tokens";
  }
  return null;
}

function verdict(
  userId: string,
  row: ThrowawayCheckRow | null,
  action: ThrowawayAction,
  refreshTokens: number,
  reason?: string,
): ThrowawayVerdict {
  return {
    userId,
    name: row?.name ?? "",
    createdAt: row?.createdAt ?? null,
    action,
    refreshTokens,
    ...(reason ? { reason } : {}),
  };
}
