/**
 * The "why" eval (Issue M): 30 recorded decisions across every rule family,
 * each with the facts its explanation must state. A fact is an invariant
 * named together with its value in one sentence ("the per-stop cap … $5.00"),
 * never a bare number: "$5.00" alone could be the price, the cap or the
 * hold. CI holds the template to it (test/explainEval.test.ts); the manual
 * `explain-eval` workflow holds EXPLAIN_MODEL's phrasing to the same facts
 * (src/scripts/explain-eval.ts).
 */

export interface GoldenFact {
  /** Words that name the invariant; one must be in the sentence. */
  about: string[];
  /** The value that sentence must carry, exactly as the row formats it. */
  value?: string;
}

export interface GoldenDecision {
  id: string;
  row: { kind: string; rule: string; inputs: unknown; outcome: unknown };
  facts: GoldenFact[];
}

const quote = (totalUsd: number, stayMinutes = 90) => ({
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  stayMinutes,
  totalUsd,
});
const extendInputs = (extra: Record<string, unknown> = {}) => ({
  expiresAt: "2026-01-05T20:30:00.000Z",
  costTicketUsd: 65,
  costExtendUsd: 3.15,
  extendCount: 1,
  sessionSpentUsd: 6.3,
  spentTodayUsd: 12.6,
  maxStayMinutes: 120,
  ...extra,
});

export const GOLDEN: GoldenDecision[] = [
  // ---- detecting and quoting a park
  {
    id: "quote-auto-pay",
    row: { kind: "parked_quote", rule: "auto_pay_ok", inputs: {}, outcome: { quote: quote(3.65) } },
    facts: [
      { about: ["price"], value: "$3.65" },
      { about: ["zone"], value: "417371" },
    ],
  },
  {
    id: "quote-sides-differ",
    row: {
      kind: "parked_quote",
      rule: "candidates_disagree",
      inputs: {},
      outcome: { quote: quote(5.4) },
    },
    facts: [{ about: ["side"] }],
  },
  {
    id: "quote-no-zone",
    row: { kind: "parked_quote", rule: "unknown_zone", inputs: { radiusM: 40 }, outcome: {} },
    facts: [{ about: ["radius"], value: "40 m" }, { about: ["zone"] }],
  },
  {
    id: "quote-free",
    row: { kind: "parked_quote", rule: "free_period", inputs: {}, outcome: {} },
    facts: [{ about: ["charging", "nothing to pay"] }],
  },
  {
    id: "quote-zone-number",
    row: { kind: "parked_quote", rule: "needs_zone_number", inputs: {}, outcome: {} },
    facts: [{ about: ["zone number"] }],
  },
  // ---- the money gate at a start
  {
    id: "start-per-stop-cap",
    row: {
      kind: "session_start",
      rule: "session_cap_exceeded",
      inputs: { quote: quote(5.4), sessionCapUsd: 5 },
      outcome: { allowed: false },
    },
    facts: [
      { about: ["per-stop cap"], value: "$5.00" },
      { about: ["price"], value: "$5.40" },
    ],
  },
  {
    id: "start-daily-cap",
    row: {
      kind: "session_start",
      rule: "daily_cap_exceeded",
      inputs: { quote: quote(8.25), spentTodayUsd: 55, dailyCapUsd: 60 },
      outcome: { allowed: false },
    },
    facts: [
      { about: ["spent today"], value: "$55.00" },
      { about: ["daily cap"], value: "$60.00" },
      { about: ["price"], value: "$8.25" },
    ],
  },
  {
    id: "start-price-moved",
    row: {
      kind: "session_start",
      rule: "quote_changed",
      inputs: { shownTotalUsd: 3.65, quote: quote(4.1) },
      outcome: { allowed: false },
    },
    facts: [
      { about: ["shown"], value: "$3.65" },
      { about: ["price"], value: "$4.10" },
    ],
  },
  {
    id: "start-dry-run-changed",
    row: {
      kind: "session_start",
      rule: "dry_run_changed",
      inputs: { shownDryRun: true, dryRun: false },
      outcome: { allowed: false },
    },
    facts: [
      { about: ["dry run when it was shown"], value: "on" },
      { about: ["dry run"], value: "off" },
    ],
  },
  {
    id: "start-no-account",
    row: {
      kind: "session_start",
      rule: "provider_not_linked",
      inputs: { provider: "parkboston" },
      outcome: { allowed: false },
    },
    facts: [{ about: ["account"] }, { about: ["provider"], value: "parkboston" }],
  },
  {
    id: "start-max-stay",
    row: {
      kind: "session_start",
      rule: "max_stay_exceeded",
      inputs: { quote: quote(9, 180), maxStayMinutes: 120 },
      outcome: { allowed: false },
    },
    facts: [
      { about: ["max stay"], value: "120 min" },
      { about: ["stay"], value: "180 min" },
    ],
  },
  {
    id: "start-provider-error",
    row: {
      kind: "session_start",
      rule: "executor_failed",
      inputs: {},
      outcome: { ok: false, code: "ui_changed" },
    },
    facts: [{ about: ["error"], value: "ui_changed" }],
  },
  // ---- the auto-extend worker
  {
    id: "extend-yes",
    row: { kind: "extend_tick", rule: "extend", inputs: extendInputs(), outcome: {} },
    facts: [
      { about: ["ticket"], value: "$65.00" },
      { about: ["more time"], value: "$3.15" },
    ],
  },
  {
    id: "extend-back-soon",
    row: {
      kind: "extend_tick",
      rule: "hold_return_likely",
      inputs: extendInputs({ distanceM: 140 }),
      outcome: {},
    },
    facts: [{ about: ["distance"], value: "140 m" }, { about: ["back"] }],
  },
  {
    id: "extend-where-unknown",
    row: {
      kind: "extend_tick",
      rule: "hold_position_unknown",
      inputs: extendInputs(),
      outcome: {},
    },
    facts: [{ about: ["location"] }],
  },
  {
    id: "extend-at-car",
    row: {
      kind: "extend_tick",
      rule: "hold_back_at_car",
      inputs: extendInputs({ distanceM: 6 }),
      outcome: {},
    },
    facts: [{ about: ["distance"], value: "6 m" }],
  },
  {
    id: "extend-max-stay",
    row: { kind: "extend_tick", rule: "warn_max_stay", inputs: extendInputs(), outcome: {} },
    facts: [{ about: ["max stay"], value: "120 min" }],
  },
  {
    id: "extend-per-stop-cap",
    row: { kind: "extend_tick", rule: "hold_session_cap", inputs: extendInputs(), outcome: {} },
    facts: [{ about: ["spent on this session"], value: "$6.30" }, { about: ["per-stop cap"] }],
  },
  {
    id: "extend-daily-cap",
    row: { kind: "extend_tick", rule: "hold_daily_cap", inputs: extendInputs(), outcome: {} },
    facts: [{ about: ["spent today"], value: "$12.60" }, { about: ["daily cap"] }],
  },
  {
    id: "extend-ran-out",
    row: { kind: "extend_tick", rule: "expired", inputs: extendInputs(), outcome: {} },
    facts: [{ about: ["meter"], value: "2026-01-05 20:30 UTC" }],
  },
  // ---- the park lifecycle
  {
    id: "park-ttl",
    row: { kind: "park_lifecycle", rule: "ttl_expired", inputs: {}, outcome: {} },
    facts: [{ about: ["hour"] }],
  },
  {
    id: "session-drove-off",
    row: {
      kind: "session_end_return",
      rule: "ended_drove_off",
      inputs: { distanceM: 420 },
      outcome: {},
    },
    facts: [{ about: ["drove off"] }, { about: ["distance"], value: "420 m" }],
  },
  {
    id: "session-stopped-at-return",
    row: {
      kind: "session_end_return",
      rule: "stopped_at_return",
      inputs: { distanceM: 12 },
      outcome: {},
    },
    facts: [{ about: ["stopped"] }],
  },
  {
    id: "session-runs-to-end",
    row: {
      kind: "session_end_return",
      rule: "ended_at_return",
      inputs: { expiresAt: "2026-01-05T21:00:00.000Z" },
      outcome: {},
    },
    facts: [{ about: ["can't stop early"] }, { about: ["end"], value: "2026-01-05 21:00 UTC" }],
  },
  // ---- agents
  {
    id: "agent-no-consent",
    row: { kind: "agent_confirm", rule: "agents_not_allowed", inputs: {}, outcome: {} },
    facts: [{ about: ["agents"] }],
  },
  {
    id: "agent-mandate-used",
    row: { kind: "agent_confirm", rule: "mandate_used", inputs: {}, outcome: {} },
    facts: [{ about: ["already been used"] }],
  },
  {
    id: "agent-bound",
    row: {
      kind: "street_confirmed",
      rule: "agent_plan_bound",
      inputs: { shown: quote(2.15, 60), dryRun: true },
      outcome: {},
    },
    facts: [
      { about: ["stay"], value: "60 min" },
      { about: ["no prompt", "walk away"] },
      { about: ["dry run"], value: "on" },
    ],
  },
  // ---- the card and the assistant
  {
    id: "card-over-hold",
    row: {
      kind: "issuing_authorization",
      rule: "declined_over_hold",
      inputs: { amountUsd: 6.5, heldUsd: 5.5 },
      outcome: {},
    },
    facts: [
      { about: ["hold"], value: "$5.50" },
      { about: ["price"], value: "$6.50" },
    ],
  },
  {
    id: "assistant-none-meets",
    row: { kind: "assistant_plan", rule: "none_meets", inputs: {}, outcome: {} },
    facts: [{ about: ["met", "meet"] }],
  },
  {
    id: "assistant-budget",
    row: {
      kind: "assistant_turn",
      rule: "daily_spend_cap",
      inputs: {},
      outcome: { spentUsd: 5.02, capUsd: 5 },
    },
    facts: [
      { about: ["spend"], value: "$5.02" },
      { about: ["cap"], value: "$5.00" },
    ],
  },
];

/** Whether `answer` states every fact: for each, one sentence that names
 * the invariant and, when the fact has one, carries its value. */
export function missingFacts(answer: string, facts: GoldenFact[]): GoldenFact[] {
  const sentences = answer.split(/(?<=[.!?])\s+|;\s*|\(/).map((s) => s.toLowerCase());
  return facts.filter(
    (fact) =>
      !sentences.some(
        (s) =>
          fact.about.some((word) => s.includes(word.toLowerCase())) &&
          (fact.value === undefined || s.includes(fact.value.toLowerCase())),
      ),
  );
}
