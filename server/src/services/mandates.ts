/**
 * The one mandate: what a Confirm tap in the app, or an external agent's
 * confirm call, authorizes — one plan option, once, within ten minutes
 * (D0 §4: one confirm-token mechanism for app, REST and MCP). Minted
 * here and nowhere else; consumed here and nowhere else. The token is
 * shown once and stored as its hash, like an API key; a row says who
 * holds it (the agent key, or none for the app's own tap), what the plan
 * looked like (its hash), what it may do (scopes), and the caps it was
 * judged against.
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

import type { AppDb, MandateRow } from "../db.js";
import { hashApiKey } from "./apiKeys.js";
import type { Principal } from "./principal.js";

export const MANDATE_TTL_MS = 10 * 60_000;

export interface MandateDeps {
  db: Pick<AppDb, "mandate">;
  pepper: string;
}

/** SHA-256 of a plan's canonical JSON (keys sorted), so a confirm for a
 * plan that changed since it was minted is refused. */
export function planHashOf(plan: unknown): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Mint one. The plaintext token goes to the caller once; the row keeps
 * its hash. `scopes` is what the mandate may do; a tap's is `confirm`. */
export async function mintMandate(
  deps: MandateDeps,
  principal: Principal,
  input: {
    planId: string;
    optionId: string | null;
    planHash: string;
    scopes: readonly string[];
    capsSnapshot: Record<string, unknown> | null;
  },
  at: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(at.getTime() + MANDATE_TTL_MS);
  await deps.db.mandate.create({
    data: {
      token: hashApiKey(deps.pepper, token),
      userId: principal.userId,
      planId: input.planId,
      optionId: input.optionId,
      agentKeyId: principal.agentKeyId ?? null,
      planHash: input.planHash,
      scopes: [...input.scopes],
      capsSnapshot: input.capsSnapshot,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export type MandateRefusal =
  /** No row, another user's, or another key's. */
  | "not_valid"
  | "used"
  | "expired"
  /** The plan changed since it was minted. */
  | "plan_changed"
  /** The mandate (or the key) lacks the `confirm` scope. */
  | "scope";

export type ConsumeOutcome =
  { ok: true; planId: string; optionId: string | null } | { ok: false; reason: MandateRefusal };

/**
 * Read one and say whether it may be consumed now: this user's and, when
 * an agent key holds it, this key's; unconsumed; unexpired; allowed to
 * confirm. The plan it names is the caller's to check against
 * (`planHashOf`) once loaded. Nothing is claimed yet.
 */
export async function readMandate(
  deps: MandateDeps,
  principal: Principal,
  token: string,
  at: Date,
): Promise<{ ok: true; row: MandateRow } | { ok: false; reason: MandateRefusal }> {
  const row = await deps.db.mandate.findUnique({
    where: { token: hashApiKey(deps.pepper, token) },
  });
  if (!row || row.userId !== principal.userId) return { ok: false, reason: "not_valid" };
  if ((row.agentKeyId ?? null) !== (principal.agentKeyId ?? null)) {
    return { ok: false, reason: "not_valid" };
  }
  if (row.consumedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= at.getTime()) return { ok: false, reason: "expired" };
  if (!row.scopes.includes("confirm") || !principal.scopes.has("confirm")) {
    return { ok: false, reason: "scope" };
  }
  return { ok: true, row };
}

/** Whether the plan as it is now is the plan the mandate was minted for. */
export function planUnchanged(row: MandateRow, plan: unknown): boolean {
  return row.planHash === null || row.planHash === planHashOf(plan);
}

/** Claim a read mandate, atomically: of two concurrent claims exactly one
 * gets it (the single UPDATE … WHERE consumed_at IS NULL). */
export async function claimMandate(
  deps: MandateDeps,
  row: MandateRow,
  at: Date,
): Promise<ConsumeOutcome> {
  const claimed = await deps.db.mandate.updateMany({
    where: { token: row.token, consumedAt: null, expiresAt: { gt: at } },
    data: { consumedAt: at },
  });
  if (claimed.count !== 1) return { ok: false, reason: "used" };
  return { ok: true, planId: row.planId, optionId: row.optionId };
}
