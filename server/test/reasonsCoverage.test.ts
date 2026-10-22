/**
 * Every rule the server writes has a reason (Issue M): a new rule without
 * an entry in services/reasons.ts fails here. Three nets, because a rule
 * reaches the ledger by many routes:
 * 1. this file reads server/src for rule literals (`rule: "x"`, `rule =
 *    "x"`, either side of a ternary, the rule argument of the local
 *    `decide`/`refuse`/`close` helpers);
 * 2. it reads the vocabularies rules are taken from at run time (unions
 *    named *Rule, *Reason, *Code: the money gate's, the executor's error
 *    codes, Issuing's, the lifecycle's);
 * 3. the fake DB records any rule written without a reason, and
 *    test/setup/reasonsGate.ts fails the test file that wrote it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { explainDecision } from "../src/services/explanations.js";
import { hasReason, reasonKeys, reasonOf, reasonText } from "../src/services/reasons.js";

const SRC = new URL("../src/", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "generated" || name === "scripts") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const LITERAL = /"([a-z][a-z0-9_]*)"/g;

/** Strings the patterns catch that are not rules a row carries. */
const NOT_RULES = new Set([
  // `rule: reply.body["rule"]` (pendingSession.ts) reads a field, not a rule.
  "rule",
  // Union members of *Reason/*Code types that are push copy or breaker
  // state, never a decision's rule.
  "budget",
  "max_stay",
  "no_auto_extend",
]);

function literalRules(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (rule: string, file: string) => {
    if (!NOT_RULES.has(rule) && !found.has(rule)) found.set(rule, file.slice(SRC.length));
  };
  for (const file of sources(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\brule\s*[:=]\s*([^\n,;]*)/g)) {
      for (const l of m[1]!.matchAll(LITERAL)) add(l[1]!, file);
    }
    for (const m of src.matchAll(/\b(?:decide|refuse)\(\s*(?:[a-z]\w*,\s*)?"([a-z][a-z0-9_]*)"/g)) {
      add(m[1]!, file);
    }
    for (const m of src.matchAll(/\bclose\(\s*"[a-z_]+",\s*"[a-z_]+",\s*"([a-z][a-z0-9_]*)"/g)) {
      add(m[1]!, file);
    }
    for (const m of src.matchAll(/type\s+\w*(?:Rule|Reason|Code)\w*\s*=([^;]*);/g)) {
      for (const l of m[1]!.matchAll(LITERAL)) add(l[1]!, file);
    }
  }
  return found;
}

describe("every rule has a reason", () => {
  test("every rule literal and vocabulary in server/src", () => {
    const missing = [...literalRules()]
      .filter(([rule]) => !reasonKeys().some((k) => k === rule || k.endsWith(`:${rule}`)))
      .map(([rule, file]) => `${rule} (${file})`);
    expect(missing, "add these to services/reasons.ts").toEqual([]);
  });

  test("the scan sees what it should: a few known rules from each net", () => {
    const found = literalRules();
    for (const rule of ["auto_pay_ok", "session_cap_exceeded", "already_paid", "ui_changed"]) {
      expect(found.has(rule), rule).toBe(true);
    }
  });

  test("templated rules are covered for each value they take", () => {
    // routes/card.ts `${direction}_ok`; webhooksStripe `reconciled_${status}`.
    for (const rule of ["freeze_ok", "unfreeze_ok", "reconciled_released", "reconciled_captured"]) {
      expect(hasReason("x", rule), rule).toBe(true);
    }
  });
});

describe("a reason reads only the row", () => {
  const row = {
    kind: "session_start",
    rule: "session_cap_exceeded",
    inputs: { quote: { totalUsd: 5.4, stayMinutes: 90 }, sessionCapUsd: 5 },
    outcome: { allowed: false },
  };

  test("what happened, the evidence by name with the row's value, and what to do", () => {
    const reason = reasonOf(row);
    expect(reason).toMatchObject({ known: true, subject: "Session start" });
    expect(reason.because).toEqual([
      { name: "price", label: "the price", value: "$5.40" },
      { name: "sessionCap", label: "the per-stop cap", value: "$5.00" },
    ]);
    expect(reason.youCan).toMatch(/per-stop cap/);
    expect(reasonText(reason)).toBe(
      "Session start: The price would pass the per-stop cap (the price was $5.40; the per-stop cap was $5.00). You can raise your per-stop cap in Limits.",
    );
  });

  test("a fact the row doesn't carry is left out, never made up", () => {
    const reason = reasonOf({ ...row, inputs: { quote: { totalUsd: 5.4 } } });
    expect(reason.because.map((e) => e.name)).toEqual(["price"]);
  });

  test("a kind-specific entry wins over the rule's", () => {
    expect(reasonOf({ ...row, kind: "limits_update", rule: "refused" }).what).toMatch(/limits/);
    expect(reasonOf({ ...row, kind: "session_start_walkaway", rule: "refused" }).what).toMatch(
      /start was refused/,
    );
  });

  test("an unknown rule says only that it was recorded", () => {
    const reason = reasonOf({ ...row, rule: "brand_new_rule" });
    expect(reason).toMatchObject({ known: false, because: [], youCan: null });
  });

  test("the template every surface shows is the reason's text", () => {
    const text = explainDecision({ ...row, id: "d1", createdAt: new Date("2026-09-21T18:00:00Z") });
    expect(text).toContain(reasonText(reasonOf(row)));
  });
});
