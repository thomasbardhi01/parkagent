/**
 * Which throwaway users the FR suite needs: one per fr/ file, labelled by
 * the file ("35-limits" for 35-limits.fr.test.ts), plus the extra users a
 * file declares here. The nightly mints exactly these before the suite
 * (create-fr-throwaway --pool), and each file claims its own by label
 * (client.ts), so no two files ever share a user.
 *
 *   node server/fr/pool.mjs   → the labels, comma-separated
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A second user a file needs beside its own, as "<file>.<name>". */
export const EXTRA_USERS = {
  // One user's limits never affect another's: two users of its own.
  "35-limits": ["other"],
  // Rotation, reuse detection, and DELETE /me burn a session: not the
  // one the file's profile tests run as.
  "60-accounts": ["lifecycle"],
};

/** The label of an fr/ test file, from its path or file URL. */
export function fileLabel(file) {
  const base = String(file).split("/").pop() ?? "";
  return base.replace(/\.fr\.test\.ts$/, "");
}

export function poolLabels(dir = fileURLToPath(new URL(".", import.meta.url))) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".fr.test.ts"))
    .sort();
  return files.flatMap((f) => {
    const label = fileLabel(f);
    return [label, ...(EXTRA_USERS[label] ?? []).map((extra) => `${label}.${extra}`)];
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(poolLabels().join(","));
}
