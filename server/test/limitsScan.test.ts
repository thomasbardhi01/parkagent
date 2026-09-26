/**
 * Every cap check reads the user's own limits (services/limits.ts
 * policyFor). The global policy is still read directly, but only for
 * things that aren't a user's limits — listed here, each with its reason.
 * A new `policy.get()` anywhere else fails this test: route it through
 * policyFor, or add it here with why a user's limits don't apply.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const ALLOWED: { file: string; line: RegExp; why: string }[] = [
  {
    file: "index.ts",
    line: /snapshotPolicy\(db, policy\.get\(\), "boot"\)/,
    why: "the operator's document, snapshotted at boot",
  },
  {
    file: "routes/policy.ts",
    line: /policy: deps\.policy\.get\(\),/,
    why: "GET /policy returns the operator's document",
  },
  {
    file: "routes/policy.ts",
    line: /snapshotPolicy\(deps\.db, deps\.policy\.get\(\), "put"\)/,
    why: "PUT /policy snapshot",
  },
  {
    file: "routes/limits.ts",
    line: /const policy = deps\.policy\.get\(\);/,
    why: "the ceilings a PUT /me/limits is judged against",
  },
  {
    file: "services/limits.ts",
    line: /const policy = deps\.policy\.get\(\);/,
    why: "policyFor itself",
  },
  {
    file: "services/limits.ts",
    line: /limitsView\(deps\.policy\.get\(\), row\)/,
    why: "limitsFor itself",
  },
  {
    file: "routes/webhooksStripe.ts",
    line: /userId \? await policyFor\(deps, userId\) : deps\.policy\.get\(\)/,
    why: "an unknown card has no owner (declined first)",
  },
  {
    file: "routes/providers.ts",
    line: /deps\.policy\.get\(\)\.shadow_mode/,
    why: "shadow mode is server-wide",
  },
  {
    file: "routes/session.ts",
    line: /deps\.policy\.get\(\)\.shadow_mode/,
    why: "shadow mode is server-wide",
  },
  {
    file: "services/sessions.ts",
    line: /deps\.policy\.get\(\)\.shadow_mode/,
    why: "shadow mode is server-wide",
  },
  {
    file: "services/assistant/tools.ts",
    line: /policy: this\.deps\.policy\.get\(\),/,
    why: "street search reads fees and enforcement hours only",
  },
  {
    file: "services/wallet/parkagentCard.ts",
    line: /const policy = deps\.policy\.get\(\);/,
    why: "the card's own Stripe controls stay at the ceilings: a backstop a later raise can't trip over; the webhook enforces each user's cap",
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("the global policy is read only where a user's limits don't apply", () => {
  const unexplained: string[] = [];
  const used = new Set<number>();
  for (const path of sources(SRC)) {
    const file = relative(SRC, path);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (!/policy\.get\(\)/.test(line)) return;
        const rule = ALLOWED.findIndex((a) => a.file === file && a.line.test(line));
        if (rule < 0) unexplained.push(`${file}:${index + 1}: ${line.trim()}`);
        else used.add(rule);
      });
  }
  expect(unexplained, "route these through policyFor(user), or allow them with a reason").toEqual(
    [],
  );
  // A stale allowance hides nothing but should go.
  expect(ALLOWED.filter((_, i) => !used.has(i)).map((a) => a.file)).toEqual([]);
});
