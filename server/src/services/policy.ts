/**
 * policy.json: the spending and extension rules. Loaded and validated at
 * boot (the server refuses to start on an invalid file), replaceable at
 * runtime via PUT /policy, and snapshotted to policy_snapshots whenever a
 * distinct document is seen.
 *
 * Dry run is two independent switches: the DRY_RUN env var and dry_run in
 * the policy file. Money-moving code must check effectiveDryRun(), which is
 * true unless BOTH are false.
 */

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

export const policySchema = z.strictObject({
  dry_run: z.boolean(),
  // Shadow mode: the real executor pays with whatever payment method the
  // user's provider account already has (linking skips setup-card and its
  // consent gate), and every session start/extension ALSO fires a Stripe
  // test-mode authorization for the same amount, so the webhook, budget
  // checks, and ledger run in parallel with the real spend. The dry-run
  // switches still gate the executor exactly as before — shadow mode never
  // bypasses them; the shadow authorization itself is test-mode money.
  // Optional so pre-shadow policy documents stay valid (absent = false).
  shadow_mode: z.boolean().optional(),
  // Plans pay through the user's Link wallet when it's connected (each
  // paid stop gets a Link spend request the user approves); false keeps
  // plans on the Issuing card even when Link is connected. The daily cap
  // applies across BOTH sources.
  link_wallet_for_plans: z.boolean().optional(),
  session_cap_usd: z.number().positive(),
  daily_cap_usd: z.number().positive(),
  auto_pay_max_rate_per_hour: z.number().nonnegative(),
  default_stay_minutes: z.number().int().positive().max(720),
  // DEPRECATED, accepted for one release: the pay-by-app fee is per city and
  // now lives in city_overrides.<city>.parking_fee_usd. Kept optional so a
  // policy document written before the migration (and any client that
  // round-trips the field through PUT /policy) still validates.
  parknyc_fee_usd: z.number().nonnegative().optional(),
  auto_extend: z.strictObject({
    enabled: z.boolean(),
    max_count: z.number().int().nonnegative(),
    max_minutes_each: z.number().int().positive(),
    no_extend_within_minutes_of_max_stay: z.number().int().nonnegative(),
  }),
  respect_enforcement_hours: z.boolean(),
  ticket_cost_usd: z.number().nonnegative(),
  // Per-city numbers. parking_fee_usd is the city provider's pay-by-app fee
  // and belongs here, per city; anything absent falls back to the top-level
  // ticket_cost_usd (and, for the fee, to the deprecated parknyc_fee_usd
  // then DEFAULT_PARKING_FEE_USD).
  city_overrides: z
    .partialRecord(
      z.enum(["nyc", "bos"]),
      z.strictObject({
        parking_fee_usd: z.number().nonnegative().optional(),
        ticket_cost_usd: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
});

export type Policy = z.infer<typeof policySchema>;

export interface CityPolicy {
  /** Pay-by-app transaction fee for this city's provider. */
  parkingFeeUsd: number;
  ticketCostUsd: number;
}

/**
 * Last-resort pay-by-app fee: only reached for a city with no
 * city_overrides entry in a document that also dropped the deprecated
 * top-level field. Both shipped cities set their own.
 */
export const DEFAULT_PARKING_FEE_USD = 0.15;

/**
 * Resolve the per-city numbers. The fee comes from the city's own override;
 * a document still carrying the deprecated top-level parknyc_fee_usd keeps
 * working. An unknown or missing city (pre-city rows only — every zone row
 * carries one) falls through to the same defaults.
 */
export function cityPolicy(policy: Policy, city: string | undefined): CityPolicy {
  const overrides = city === "nyc" || city === "bos" ? policy.city_overrides?.[city] : undefined;
  return {
    parkingFeeUsd: overrides?.parking_fee_usd ?? policy.parknyc_fee_usd ?? DEFAULT_PARKING_FEE_USD,
    ticketCostUsd: overrides?.ticket_cost_usd ?? policy.ticket_cost_usd,
  };
}

// Sorted keys at every level. (JSON.stringify's replacer-array form filters
// nested objects by the same key list, so it can't be used for this.)
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => JSON.stringify(key) + ":" + canonicalize((value as Record<string, unknown>)[key]),
      );
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}

/** sha256 over sorted-key JSON, so formatting changes don't churn snapshots. */
export function policyHash(policy: Policy): string {
  return "sha256:" + createHash("sha256").update(canonicalize(policy)).digest("hex");
}

export class PolicyService {
  private current: Policy;

  constructor(
    private readonly filePath: string,
    private readonly envDryRun: boolean,
  ) {
    this.current = this.parse(readFileSync(filePath, "utf-8"));
  }

  private parse(text: string): Policy {
    const result = policySchema.safeParse(JSON.parse(text));
    if (!result.success) {
      throw new Error(
        `Invalid policy (${this.filePath}):\n` +
          result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    }
    return result.data;
  }

  get(): Policy {
    return this.current;
  }

  hash(): string {
    return policyHash(this.current);
  }

  effectiveDryRun(): boolean {
    return this.envDryRun || this.current.dry_run;
  }

  /** Shadow mode (see the schema comment); absent in the file means off. */
  shadowMode(): boolean {
    return this.current.shadow_mode === true;
  }

  /** Validate and persist a full replacement (PUT /policy). Throws ZodError. */
  update(next: unknown): Policy {
    this.current = policySchema.parse(next);
    // Write-then-rename so a crash can't leave a torn policy.json.
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.current, null, 2) + "\n");
    renameSync(tmp, this.filePath);
    return this.current;
  }
}

interface SnapshotDb {
  policySnapshot: {
    findFirst(args: {
      orderBy: { id: "desc" };
      select: { hash: true };
    }): Promise<{ hash: string } | null>;
    create(args: { data: { hash: string; policy: Policy; source: string } }): Promise<unknown>;
  };
}

/** Record the policy in policy_snapshots unless it matches the latest row. */
export async function snapshotPolicy(
  db: SnapshotDb,
  policy: Policy,
  source: "boot" | "put",
): Promise<void> {
  const hash = policyHash(policy);
  const latest = await db.policySnapshot.findFirst({
    orderBy: { id: "desc" },
    select: { hash: true },
  });
  if (latest?.hash === hash) return;
  await db.policySnapshot.create({ data: { hash, policy, source } });
}
