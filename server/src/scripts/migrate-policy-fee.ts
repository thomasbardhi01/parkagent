/**
 * One-time: move the top-level `parknyc_fee_usd` into
 * `city_overrides.<city>.parking_fee_usd` for every city that has no fee of
 * its own, then drop the deprecated key.
 *
 *   pnpm -C server migrate:policy-fee            # repo-root policy.json
 *   pnpm -C server migrate:policy-fee -- --file /path/to/policy.json
 *   pnpm -C server migrate:policy-fee -- --dry-run
 *
 * The fee is per city (ParkNYC charges $0.15, ParkBoston $0.35), so a
 * NYC-named top-level default was both wrong-shaped and city-biased. The
 * schema still ACCEPTS the old key for one release and cityPolicy() still
 * falls back to it, so running this is safe at any time and skipping it
 * only leaves the old shape in place. Idempotent: a document already
 * migrated is left untouched.
 *
 * Note the `--` before the flags: pnpm swallows them otherwise.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { allProviders } from "../providers/registry.js";
import { policySchema } from "../services/policy.js";

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): number {
  const dryRun = process.argv.includes("--dry-run");
  const filePath =
    flagValue("--file") ?? fileURLToPath(new URL("../../../policy.json", import.meta.url));

  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const fee = raw["parknyc_fee_usd"];
  if (fee === undefined) {
    console.log(`${filePath}: no parknyc_fee_usd — already migrated.`);
    return 0;
  }
  if (typeof fee !== "number") {
    console.error(`${filePath}: parknyc_fee_usd is not a number (${JSON.stringify(fee)}).`);
    return 1;
  }

  const overrides = { ...((raw["city_overrides"] as Record<string, unknown>) ?? {}) };
  const filled: string[] = [];
  for (const { city } of allProviders()) {
    const existing = { ...((overrides[city] as Record<string, unknown>) ?? {}) };
    if (existing["parking_fee_usd"] === undefined) {
      existing["parking_fee_usd"] = fee;
      filled.push(city);
    }
    overrides[city] = existing;
  }

  const next: Record<string, unknown> = { ...raw, city_overrides: overrides };
  delete next["parknyc_fee_usd"];

  // Validate through the real schema before writing: a bad document here
  // would stop the server from booting.
  const result = policySchema.safeParse(next);
  if (!result.success) {
    console.error(
      `${filePath}: migrated document is invalid:\n` +
        result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
    );
    return 1;
  }

  console.log(
    `${filePath}: parknyc_fee_usd ${fee} → city_overrides.{${filled.join(", ") || "none"}}.parking_fee_usd`,
  );
  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return 0;
  }
  // Same write-then-rename as PolicyService.update, so a crash can't tear it.
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(result.data, null, 2) + "\n");
  renameSync(tmp, filePath);
  console.log("Written. Restart the server (or PUT /policy) to pick it up.");
  return 0;
}

process.exitCode = main();
