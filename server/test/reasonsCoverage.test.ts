/**
 * Every rule the server writes has a reason (Issue M): a new rule without
 * an entry in services/reasons.ts fails here. Three nets, because a rule
 * reaches the ledger by many routes:
 * 1. this file reads server/src for rule literals: `rule: "x"`, `rule =
 *    "x"`, either side of a ternary; any literal argument of the local
 *    `audit`/`decide`/`refuse`/`close` helpers, however many arguments
 *    come first (tool names and decision kinds aside); a literal assigned
 *    to a `code`/`rule` variable;
 * 2. it reads the vocabularies rules are taken from at run time: unions
 *    named *Rule, *Reason, *Code (the money gate's, the executor's error
 *    codes, Issuing's, the lifecycle's), and the codes of *_REFUSALS /
 *    *_ERRORS tables (their keys, and the `error:` each maps to);
 * 3. the fake DB records any rule written without a reason, and
 *    test/setup/reasonsGate.ts fails the test file that wrote it.
 * The scan can't see a literal's kind, so a rule it finds needs an entry
 * that holds on any kind (no `kind:` prefix); a kind-specific entry alone
 * covers only that kind, at run time.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { TOOL_DEFINITIONS } from "../src/services/assistant/tools.js";
import { explainDecision } from "../src/services/explanations.js";
import {
  hasGenericReason,
  hasReason,
  reasonKinds,
  reasonOf,
  reasonText,
} from "../src/services/reasons.js";

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
  // location.ts close(status, kind, rule, …): the park's new status.
  "cancelled",
  "covered",
  "free",
]);

/** Literals a helper's argument list carries that aren't rules: the tool
 * a step audits, and the kind a `decide(userId, kind, rule…)` names. */
const NOT_RULE_ARGS = new Set([...TOOL_DEFINITIONS.map((t) => t.name), ...reasonKinds()]);

function literalRules(sourceOf: (file: string) => string = (f) => readFileSync(f, "utf8")) {
  const found = new Map<string, string>();
  const add = (rule: string, file: string) => {
    if (!NOT_RULES.has(rule) && !found.has(rule)) found.set(rule, file.slice(SRC.length));
  };
  const literals = (text: string, file: string, skip = new Set<string>()) => {
    for (const l of text.matchAll(LITERAL)) if (!skip.has(l[1]!)) add(l[1]!, file);
  };
  for (const file of sources(SRC)) {
    const src = sourceOf(file);
    for (const m of src.matchAll(/\brule\s*[:=]\s*([^\n,;]*)/g)) literals(m[1]!, file);
    // A helper's arguments up to the first nested call or object: the
    // rule may come after any number of ids (decide(deps, userId,
    // sessionId, "rule", …), this.audit(ctx, "tool", input, "rule", …)).
    for (const m of src.matchAll(/\b(?:audit|decide|refuse|close)\(([^(){}]*)/g)) {
      literals(m[1]!, file, NOT_RULE_ARGS);
    }
    for (const m of src.matchAll(
      /\b(?:const|let)\s+(?:code|rule|failRule)\b[^=\n]*=\s*([^\n;]*)/g,
    )) {
      literals(m[1]!, file);
    }
    for (const m of src.matchAll(/type\s+\w*(?:Rule|Reason|Code)\w*\s*=([^;]*);/g)) {
      literals(m[1]!, file);
    }
    // Refusal tables: a Map's keys (`["card_used", 409]`) and the
    // `error:` an object table maps to.
    for (const m of src.matchAll(/const\s+[A-Z_]*(?:REFUSALS|ERRORS)\b[\s\S]*?(?:\]\);|\n\};)/g)) {
      for (const k of m[0].matchAll(/\[\s*"([a-z][a-z0-9_]*)"\s*,/g)) add(k[1]!, file);
      for (const k of m[0].matchAll(/\berror:\s*"([a-z][a-z0-9_]*)"/g)) add(k[1]!, file);
    }
  }
  return found;
}

const missingFrom = (found: Map<string, string>) =>
  [...found].filter(([rule]) => !hasGenericReason(rule)).map(([rule, file]) => `${rule} (${file})`);

describe("every rule has a reason", () => {
  test("every rule literal and vocabulary in server/src", () => {
    expect(missingFrom(literalRules()), "add these to services/reasons.ts").toEqual([]);
  });

  test("the scan sees what it should: known rules from each net", () => {
    const found = literalRules();
    for (const rule of [
      "auto_pay_ok", // rule:
      "already_paid", // close()'s third argument
      "tool_error", // this.audit(ctx, name, input, "tool_error", …)
      "stripe_not_configured", // decide(deps, userId, sessionId, "…", …)
      "reveal_failed", // const code = … : "reveal_failed"
      "card_used", // REVEAL_REFUSALS' keys
      "mandate_used", // MANDATE_ERRORS' error:
      "ui_changed", // the executor's error-code union
    ]) {
      expect(found.has(rule), rule).toBe(true);
    }
    // Tool names and decision kinds in an argument list aren't rules.
    expect(found.has("explain_decision")).toBe(false);
  });

  test("a rule covered only by another kind's entry fails the scan", () => {
    // "refused" had only limits_update's and the walk-away start's
    // entries; a third kind writing it would have read as unknown.
    expect(hasGenericReason("refused")).toBe(true);
    const found = new Map([["only_kind_specific_rule", "x.ts"]]);
    expect(missingFrom(found)).toEqual(["only_kind_specific_rule (x.ts)"]);
  });

  test("deleting a rule of each kind from the table fails the scan", () => {
    // Each net, with its rule's source renamed away: the scan then sees
    // the renamed rule, which has no reason.
    for (const rule of ["tool_error", "stripe_not_configured", "card_used", "reveal_failed"]) {
      const found = literalRules((f) =>
        readFileSync(f, "utf8").replaceAll(`"${rule}"`, `"${rule}_x"`),
      );
      expect(
        missingFrom(found).some((m) => m.startsWith(`${rule}_x `)),
        rule,
      ).toBe(true);
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

  test("an error is shown only as a known code, never its free text (#265 review)", () => {
    const failed = (code: unknown) =>
      reasonOf({ kind: "session_stop", rule: "executor_failed", inputs: {}, outcome: { code } });
    expect(failed("ui_changed").because).toEqual([
      { name: "error", label: "the error", value: "ui_changed" },
    ]);
    // A message can quote a URL, a token or a card: it never surfaces.
    for (const message of [
      "fetch https://api.example.com/v1?key=sk_live_123 failed",
      "card 4242424242424242 declined",
      "some_unlisted_code",
    ]) {
      expect(failed(message).because, message).toEqual([]);
    }
    // An id-shaped text fact (a provider) carries no sentence either.
    const linked = (provider: string) =>
      reasonOf({ kind: "provider_link", rule: "link_ok", inputs: { provider }, outcome: {} });
    expect(linked("parkboston").because).toHaveLength(1);
    expect(linked("see https://x.example").because).toEqual([]);
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
