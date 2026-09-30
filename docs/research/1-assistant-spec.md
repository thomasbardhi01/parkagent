# ParkAgent Assistant Reliability Spec

Status: proposal · 2026-09-27 · owners: founders
Scope: the conversational assistant (server `services/assistant/*`, iOS `Views/Assistant`)

Sourced claims cite the Sources section by number. Inferences are labeled **Inference**.

---

## 0. Diagnosis (inference from the current code)

Two observed bugs trace to two structural facts, not to prompt wording:

1. **"Locks onto the first constraint."** There is no constraint object. Constraints exist only as words in the transcript and as arguments the model chose to pass to `quote_street` / `search_garages`. Nothing forces a later search to carry "under $20". `captureQuotes` accumulates every quote in the turn, so `synthesizePlan(quotes)` can build a card from a quote that predates the update — the fallback can re-propose the option the user just rejected.
2. **"Confident answers when nothing satisfies."** "A turn that quoted prices MUST end in a plan card" + `PROPOSE_PLAN_REMINDER` + `synthesizePlan` makes the system architecturally biased toward producing a card. There is no representation of "nothing meets this", so the only outputs are card or prose, and prose-with-prices is (correctly) forbidden. The fix is a third terminal outcome, validated by the server.

---

## 1. How industry leaders structure this

### 1.1 What the sources say

**Uber.** Public material is about internal platforms, not a consumer trip planner. The Michelangelo agent SDK supports planning loops, tool use, state and memory, with standardized scaffolding, middleware hooks, observability and evaluation tooling [1]. Every model call goes through a GenAI Gateway; every tool call goes through an MCP gateway that enforces authorization, PII redaction and scanning, with an identity system that traces each tool call back to the initiating human [2]. Recurring lesson: deterministic agents outperformed LLMs for lint/build tasks while still plugging into agentic orchestration [3]. Finch (conversational data agent) evaluates each sub-agent against "golden queries" and measures supervisor routing accuracy [4][5]; high-stakes outputs get a "Request validation" button that routes to a human expert [6]. On production evals: a background comment exposed a failure offline evals missed; the fix was making evaluation the default development path and feeding production traces into the next offline round [7]. Their consumer driver assistant tiers models (small/fast for simple requests, large for reasoning) under an internal "AI Guard" governance layer [8].

**Ramp.** The most directly relevant public writing for a money-adjacent agent. The Policy Agent reads a structured, agent-facing policy document with rules, thresholds and exceptions, and "leans conservative" on ambiguous language [9]. Every decision is explained with citations back to the policy section [10]. Uncertainty has an escape hatch to the pre-agent human process; autonomy is a user-set slider (e.g. review everything above $50 vs. only when the agent flags); the agent earned real-action rights only after proving itself as a copilot [10]. Warning: training on or evaluating against lenient human approvals would have made the agent overly permissive [11]. Money moves only after policy: approve / escalate / decline at intake, before spend [12].

**Google.** Grounding is a tool the model invokes; results must be surfaced as sources. Responses carry `groundingMetadata` with per-claim confidence scores 0–1 [13][14][15]. Google hedges its own data: grounded results "might differ from actual conditions" [13]. AI Overviews appear only where Google has "high confidence in the quality of the responses"; the criteria are unpublished [16].

**Anthropic / OpenAI guidance.** Prefer deterministic graders where the desired state is exactly checkable; grade outcomes, not paths; read transcripts to verify graders; regression evals must be stable, fast and tied to real product failures [17][18]. `strict: true` on a tool guarantees inputs match the JSON schema via constrained sampling [19]. Haiku-class models "may infer missing parameters" on tools [20]. OpenAI: rate each tool low/medium/high risk and pause for guardrail checks before high-risk calls; escalate on failure thresholds (retry limits); guardrails are a layered defense, never a single filter [21][22].

**Dialogue-state-tracking literature.** LLMs struggle to emit the full belief state every turn; emit only the slots that changed and let code accumulate the state [23]. The "changed state" strategy (unmentioned slots inherit prior values) beats re-deriving from context [24]. Classic DST is not designed for open-ended entities and dynamic constraints in tool-augmented agents; separate tool-grounded facts from task-state judgments [25]. τ-bench: even strong function-calling agents succeed on <50% of tasks and are inconsistent (pass^8 <25% on retail); agents follow policy documents poorly; pass^k measures reliability across repeated trials [26][27]. Caveat: outcome-only grading lets a do-nothing agent pass some tasks — add required-output checks [28].

### 1.2 Inference across all of them

Nobody publishes a "constraint state object" design; that is this spec's synthesis of DST (delta updates, code-owned belief state) with the agent-platform pattern (policy in tools, not prompts). Convergent themes: (1) the LLM proposes, deterministic code disposes; (2) every number shown to a user comes from a tool result with provenance; (3) uncertainty has an explicit non-answer path; (4) spend has a policy document and an approval threshold outside the model; (5) evals are graded on end state, seeded from production traces, and gate releases.

### 1.3 Comparison table

| Dimension | Uber | Ramp | Google (Maps/AIO) | Anthropic/OpenAI | DST / τ-bench | ParkAgent today |
|---|---|---|---|---|---|---|
| Where policy lives | Gateways + MCP registry enforce authz per call | Structured policy doc the agent cites | Grounding tool + display requirements | Tool risk ratings; layered guardrails | Domain policy doc (followed poorly) | tools.ts enforces caps; prompt carries the rest |
| Constraint state | not public | Policy + transaction context per decision | Prompt + retrieval config | Structured outputs / strict tools | Belief state, delta updates | **None — lives in model context only** |
| Deterministic checks | Deterministic sub-agents beat LLMs | Approve/escalate/decline before money moves | Confidence score per claim | Code graders first | DB end-state grading | Zod plan schema; cap recompute; zone re-attach |
| "No result" behavior | Traces revealed off-task handling | Escape hatch to human process | Withhold AIO when not confident | Escalate on failure thresholds | — | **Synthesizes a card from any quote** |
| Approval | "Request validation" for exec queries | Autonomy slider (e.g. review > $50) | — | Human-in-loop for high-risk tools | — | Tap mints single-use token (good) |
| Evaluation | Golden queries per sub-agent; traces → datasets | Crawl/walk/run evals; don't learn from lenient approvals | — | Outcome graders, regression suites | pass^k, simulated users | FR suite (live, 12-call budget) + scripted fakes |
| Model tiering | Small for simple, large for reasoning | OpenAI-powered | Flash/Pro | Haiku for simple tools, watch inferred params | — | Sonnet 5 loop, Haiku explain |

---

## 2. Recommended design

### 2.1 RequestState — server-owned, model edits via tool

```ts
// server/src/services/assistant/requestState.ts
export interface RequestState {
  version: number;                       // bumps on every accepted patch
  intent: "park_now" | "park_later" | "garage_or_lot" | null;
  place: {
    query: string | null;                // what the user said
    resolved: { lat: number; lng: number; label: string; city: string } | null;
    candidates: PlaceCandidate[] | null; // set when geocode was ambiguous
  };
  window: {
    startsAt: string | null;             // canonical ET ISO; null => now
    durationMinutes: number | null;
    source: "user" | "default";          // defaults are visible, never silent
  };
  hard: {                                // violation => option cannot be proposed as "meets"
    maxPriceUsd?: number;
    maxWalkMinutes?: number;
    kinds?: ("street" | "garage")[];
    entryType?: "self" | "valet";
    covered?: boolean;
  };
  soft: {                                // ranking only, never filtering
    rank: "cheapest" | "closest" | "balanced";
    prefer?: ("valet" | "covered" | "garage" | "street")[];
  };
  log: { turn: number; field: string; from: unknown; to: unknown; utterance: string }[];
}
```

Rules (deterministic, in code):

- Persisted with the conversation row (`request_state` JSONB). Loaded before the model call; injected into the system prompt as a compact "Current request" block every turn (full-state context) while the model edits by delta.
- **The model never sends the whole state; it sends patches** via a new strict tool `update_request({ set?, clear?: string[], reason })`. Server merges, bumps `version`, appends to `log`, returns the full new state plus `changed: string[]` and `overrides: []`.
- A patch on a field already set is a **supersede**, never a range merge. "Under $20" after "under $30" → `maxPriceUsd: 20`. "Closer" with no number → `maxWalkMinutes = min(current, lastShown.walkMinutes − 2)` (server rule, reported in `changed`). "Cheaper" with no number → `maxPriceUsd = lastShown.minPrice − 1`.
- "Tonight instead" → `window.startsAt` set; server re-derives intent. Intent transitions validated (§2.4).
- **`quote_street` / `search_garages` take no lat/lng/when/duration/price arguments.** They read state. Different place or time → `update_request` first. Constraints cannot be dropped on the way into a tool call because there is no argument to drop them from. Mark all state-touching tools `strict: true` [19].
- Every search result carries `stateVersion`. `propose_plan` rejects options from a stale version. Delete the `captureQuotes` accumulator; replace with `ctx.lastSearch: { stateVersion, satisfying, nearMisses, relaxSuggestions }`.

### 2.2 Validator rules (between model output and user)

All in `tools.ts` / `plans.ts`; none in the prompt. Each audits its rule name.

| # | Rule | Failure |
|---|---|---|
| V1 | Every option in `propose_plan` must match an id in `ctx.lastSearch` at the current `stateVersion`. | bounce `stale_or_unknown_option` |
| V2 | `priceUsd`, `walkMinutes`, `zoneId`, `deepLink` are overwritten from the tool result, never trusted from the model. | overwrite + audit `model_price_mismatch` |
| V3 | An option violating any `hard` field may appear only with `nearMiss: true` and server-computed `violates: [{field, actual, limit}]`. Model-supplied `violates` discarded. | bounce `hard_constraint_violation` |
| V4 | If `lastSearch.satisfying` is empty the plan must be kind `none_meets` with 1–3 near-misses; a `single_spot` is rejected. A `none_meets` while options exist is rejected. | bounce `must_say_no` / `options_available` |
| V5 | Itinerary total recomputed; over remaining daily cap → rejected (exists). Any single option over `per_plan_cap_usd` → rejected. | `over_daily_cap` / `over_per_plan_cap` |
| V6 | Reply scan: every `$d.dd` in the final reply must equal a price in `lastSearch` or the plan; otherwise the sentence is dropped. Extends `scrubVerbalConfirm`. | scrub + audit `ungrounded_number` |
| V7 | `park_later` with `startsAt` > 5 min in the past → bounce with ET "now". | `time_in_past` |
| V8 | `place.candidates != null` and `resolved == null` → search tools refuse; loop forces `ask_user` with candidates (reuse `ctx.placeChoices`). | forced ask |
| V9 | `synthesizePlan` is deleted. V4 makes the "no" card the fallback. | — |
| V10 | Max 2 `update_request` calls per turn; third bounces (thrash guard, per failure-threshold guidance [21]). | `too_many_edits` |

### 2.3 The "say no" policy

Third terminal outcome, first-class in `planSchema`:

```ts
kind: "none_meets"
constraintsFailed: [{ field: "maxPriceUsd", limit: 2, nearestActual: 4.50 }]
nearMisses: Option[]            // ≤3, each with violates[]
relaxSuggestions: [{ field, to, wouldYield: n }]  // server re-runs the FILTER with one hard field relaxed
```

- Server decides `none_meets` (V4). The model only phrases.
- Card: "Nothing under $2.00 within 10 min of Cambridge Common. Closest: Mass Ave meter, $4.50, 6 min walk." Each near-miss shows which constraint it breaks and by how much (Ramp's cite-the-rule pattern applied to the user's own constraints).
- `relaxSuggestions` render as tappable chips ("Allow up to $7.00", "Walk 15 min") whose `reply` is a plain sentence so a tap flows through `update_request`. The user changes the constraint, not the assistant.
- Distinguish absence-of-data from constraint failure: `hard` empty and search empty inside coverage → `no_zone_here` (nearest 3 zones via PostGIS); outside coverage → `outside_coverage`; provider down → `unavailable`. Different `rule` values so coverage gaps are visible.

### 2.4 Intent router (three modes)

**No separate classifier call.** `intent` is a required enum slot on `update_request`; Sonnet 5 sets it as a side effect of the first edit; the server derives/validates deterministically and its value wins (override logged). Haiku classifies only as an offline grader on traces.

Server derivation:
- `startsAt` null and no future time in the message → `park_now`.
- `startsAt` > now + 15 min → `park_later`.
- `hard.kinds == ["garage"]` → `garage_or_lot`.
- Phone location line present + `park_now` → `place` defaults to phone location, `source: "default"`, shown as an assumption on the card.

| | park_now | park_later | garage_or_lot |
|---|---|---|---|
| Tools enabled | quote_street, search_garages, propose_plan, ask_user, update_request | same + build_itinerary | search_garages, propose_plan, ask_user, update_request (street only as a server-added near-miss when cheaper and not excluded) |
| Card buttons | Confirm (street) / Confirm (garage link) | Save/Remind (street); garage link | garage link |
| Defaults | duration 60 min (`source: default`) | duration required → ask_user | duration + start required → ask_user |
| Validators | V7 off | V7 on | V7 on; V3 kinds |

Transitions: any intent → any other via patch. `park_now → park_later` is automatic on a future time; `park_later → park_now` requires clearing `startsAt` explicitly so `changed` lists both fields.

### 2.5 Budget and preference model

Three layers, all server-side, none inferred from behavior. Never loosen a cap because the user tapped through it [11].

1. **Hard caps (policy; never changeable in chat):** existing `daily_cap_usd`; add `per_plan_cap_usd` (default = daily cap) and `max_session_minutes` (default 720). Model cannot propose above them (V5). The assistant may state the cap and point at Settings; no tool writes policy.
2. **Approval threshold (the autonomy slider):** every assistant spend requires a tap — keep. Add `confirm_warn_usd` (default $15): options above it render with a visible "over your usual" band and require a long-press. Analog of Ramp's per-amount review threshold [10].
3. **Soft preferences (ranking only):** deterministic scorer in `streetOptions.ts` / garage merge: `cheapest` = price asc then walk; `closest` = walk asc then price; `balanced` = price + $0.50/min walk; `prefer` subtracts a fixed $1.00 bonus, never filters. Per-user defaults in `user_preferences` (rank, prefer, defaultDurationMinutes) seed a new conversation and are marked "(your default)" on the card. A chat-time change edits the request only; `save_preferences` (explicit) writes the row. The model receives the ranked list and does not reorder.

### 2.6 Verification loops and fallbacks

- Geocoder down → `place_unavailable`; `park_now` with phone location proceeds with an assumption; else `ask_user`. Never invent coordinates.
- Garage search down → street-only card with `provenance.garage: unavailable`; under `garage_or_lot` → unavailable card with retry chip, **no street substitute**.
- Zone data empty inside coverage → `no_zone_here` with nearest 3 zones.
- Model prose with numbers and no plan → V6 scrub, one reminder max, **no synthesis**; reply plus "Search again" chip.
- Model call failure → one retry; second failure → 503 with `request_state` intact.

### 2.7 Cost / latency

Keep Sonnet 5 in the loop. **Inference:** `update_request` adds one tool iteration (~1–2 s) on constraint-changing turns and removes iterations where the model previously re-quoted with different numbers; net model calls per turn should fall. Do not put Haiku in the loop for extraction (inferred-parameter risk [20]). Haiku stays on `explain_decision` and offline judging. Track `modelCalls`, `estimatedCostUsd` (exist) and add `stateEdits`.

---

## 3. Evaluation plan

Two tiers, both graded on **end state** (RequestState after each turn + plan kind/option ids), with a required-output check so a do-nothing agent cannot pass [17][28].

- **Tier A (CI, hermetic):** scripted fake model exercising validators and loop. Runs in `pnpm -r test`. 100% required.
- **Tier B (nightly, live):** real Sonnet 5 via the FR harness in dry run, tagged `FR-5x`, graded on state + plan shape; Haiku judge only for phrasing. Report pass^3 on 12 canonical cases. Raise `FR_ASSISTANT_MAX_CALLS` for that file only.

Conventions: `L` = phone location line present (Boston). `→` expected end state / card. NM = near-miss.

### Constraint switches

| ID | Turns | Expected |
|---|---|---|
| CS-01 | "park near Fenway for 2h" → "actually make it under $20" | v2 `maxPriceUsd=20`; second search uses v2; all options ≤ $20 or `none_meets` |
| CS-02 | "garage near Seaport 6–10pm" → "cheaper" | `maxPriceUsd` = last shown min − $1; `changed` includes it; no option ≥ previous min |
| CS-03 | "street near BU for an hour" → "closer" | `maxWalkMinutes` below shown walk; re-ranked; none farther than before |
| CS-04 | "under $30 near Back Bay" → "under $20" → "under $10" | three supersedes, three log entries, final ≤ $10 or `none_meets` |
| CS-05 | "park now near Kendall" → "tonight instead, 7pm" | `intent: park_later`, `startsAt` today 19:00 ET; street options carry `startsAt`; V7 passes |
| CS-06 | "garage tonight near TD Garden" → "actually right now" | `startsAt` cleared, `intent: park_now`; Confirm buttons |
| CS-07 | "cheapest near Harvard Sq" → "no, closest" | `soft.rank` → closest; order changes; `hard` untouched |
| CS-08 | "near Copley, valet if possible" → "no valet" | `soft.prefer` valet removed, `hard.entryType=self`; valet excluded |
| CS-09 | "2h near Fenway" → "make it 4 hours" | duration 240; max-stay violations become NM `violates: maxStay` |
| CS-10 | "under $20 near Seaport" → "forget the budget" | `clear: ["hard.maxPriceUsd"]`; full set returns |
| CS-11 | "near Fenway" → "sorry, near Kenmore" | `place.query` superseded, re-geocoded; v1 option ids rejected by V1 |
| CS-12 | "under $15, within 5 min walk, tonight at 8" (one message) | one patch, three `changed` fields, one search |

### Impossible / nothing meets

| ID | Turns | Expected |
|---|---|---|
| IM-01 | "parking under $2 near Cambridge Common for 2h" | `none_meets`; ≤3 NM by price with `violates.maxPriceUsd`; `relaxSuggestions` includes a price yielding ≥1 |
| IM-02 | "free garage near Seaport" | `none_meets` (garage kind + $0 cap) |
| IM-03 | "street at 3am on Newbury for 6h" | `none_meets` `violates.maxStay`; NM = garages |
| IM-04 | "within 1 min of Fenway, under $5, tonight 7pm on a game night" | `none_meets`; NM show both violations where applicable |
| IM-05 | "garage with valet under $10 near North End" | `none_meets`; NM never label self-park as valet |
| IM-06 | "park near Fenway", both searches return 0, point in coverage | `no_zone_here` card with nearest 3 zones, not `none_meets` |
| IM-07 | "park in Providence" | `outside_coverage` reply; no search; no card |
| IM-08 | "under $20", NM at $22, user taps "Allow up to $25" | v+1 `maxPriceUsd=25`; card `meets` with the $22 option |

### Ambiguous places

| ID | Turns | Expected |
|---|---|---|
| AP-01 | "park near the Garden" (L) | ambiguous (TD Garden / Public Garden) → `ask_user` with candidates; no search |
| AP-02 | AP-01 → tap "TD Garden" | `place.resolved` set; search; card |
| AP-03 | "near Washington St", no city, no L | ask city (clarify.ts suggestions) |
| AP-04 | "near Dunkin" (L) | ask which; ≤4 candidates within 3 km |
| AP-05 | "here" with L | phone location, `source: default`, assumption shown |
| AP-06 | "here" without L | ask for location; no card |
| AP-07 | "near 123 Fake St, Boston" (geocoder empty) | address not found; no invented coordinates; ask for a landmark |

### Tool failures

| ID | Turns | Expected |
|---|---|---|
| TF-01 | garage provider throws | street-only card, `provenance.garage: unavailable` |
| TF-02 | garage provider throws, `garage_or_lot` | unavailable card with retry chip; no street substitute |
| TF-03 | geocoder 500, `park_now` with L | proceeds with phone location, assumption |
| TF-04 | geocoder 500, `park_later` without L | ask for address; no card |
| TF-05 | quote_street malformed | bounce once; second failure → "couldn't price street parking", garage-only card if any |
| TF-06 | model prose "$4.50" and no plan | V6 scrub; no synthesized card; "Search again" chip |
| TF-07 | `propose_plan` with v1 option id after v2 edit | `stale_or_unknown_option`; final card v2 ids only |
| TF-08 | model `priceUsd: 3.00` for option quoted $4.50 | card shows $4.50; audit `model_price_mismatch` |
| TF-09 | `update_request` 3× in one turn | third bounces `too_many_edits` |

### Date / time

| ID | Turns | Expected |
|---|---|---|
| DT-01 | "tonight at 7" said 10:00 ET | today 19:00 ET |
| DT-02 | "tonight at 7" said 23:30 ET | ask: tomorrow 19:00? |
| DT-03 | "tomorrow morning 9–11" | tomorrow 09:00, 120 min |
| DT-04 | "at 7pm", no date, said 20:00 ET | tomorrow 19:00, stated in `assumptions` |
| DT-05 | offset-less `2026-09-26T18:00` | stored with `-04:00` (regression) |
| DT-06 | "Sunday" said Sat 9/26 | 9/27; free-Sunday zone → $0 option allowed, not `none_meets` |
| DT-07 | "3 hours from 11pm" | ends 02:00 next day; daily cap on start day (document) |
| DT-08 | "next week" | ask for a day; no search |
| DT-09 | DST fallback (Nov 1 2026) 1:30am | canonical offset chosen; test pins it |

### Intent routing

| ID | Turns | Expected |
|---|---|---|
| IR-01 | "park me" with L | `park_now`, 60 min default, Confirm |
| IR-02 | "I'm going to the Seaport at 6" | `park_later` |
| IR-03 | "find me a garage downtown" | `garage_or_lot`; street only as NM |
| IR-04 | "lot or garage, whichever's cheaper near Fenway" | `garage_or_lot`, `rank=cheapest` |
| IR-05 | "what's the weather" | one-sentence redirect; no state change; no tool call |

### Budget / approval

| ID | Turns | Expected |
|---|---|---|
| BG-01 | daily cap $30, spent $25, option $8 | NM `violates.remainingDailyUsd 5.00`; `meets` proposal rejected |
| BG-02 | option $18, `confirm_warn_usd=15` | `warn: true`; iOS long-press |
| BG-03 | user types "confirm" | pointed to card (regression) |
| BG-04 | "raise my cap to $100" | Settings pointer; no policy write; state unchanged |

### Metrics (per `assistant_turn` decision row; aggregated nightly)

- **State accuracy** (JGA analog): state after turn == expected on golden convos. Tier A 100%, Tier B ≥ 90%.
- **Hard-constraint violation rate**: `meets` options violating `hard` — must be **0**.
- **Grounded-number rate**: dollar amounts in reply ∈ tool results — 100%; scrub count → 0.
- **Refusal precision/recall** for `none_meets`.
- **pass^3** on 12 canonical live cases.
- **Recovery rate** on TF cases (card or clear reply; never a hang).
- **Latency p50/p95, modelCalls/turn, cost/turn, stateEdits/turn, too_many_edits count.**
- **Production loop:** 20 traces/week labeled with the same schema; failures promoted to Tier B in the same PR as the fix [7].

---

## 4. Risks and tradeoffs

- **Rigidity.** Argument-less search tools narrow the model's job; "somewhere between Fenway and Kenmore" won't map to one place. `place.query` is free text; ambiguity → ask. Fluency traded for determinism — right trade for a product that spends money.
- **Over-refusing.** Strict `none_meets` on tight-but-satisfiable requests feels obtuse. Relax chips mitigate; they re-run the filter, not the provider (cache the base search).
- **"Closer"/"cheaper" heuristics** (−2 min / −$1) are guesses; show as assumptions, one tap to change. Alternative: always ask for a number. Field-test both.
- **Strict schema limits.** Flat patch schema with `clear` enum; budget a day.
- **"Always a card" was protecting you** from prose quotes; keep it, with `none_meets` as the release valve. Do not let reminder/synthesis creep back.
- **Unofficial garage data.** A "nothing under $20" verdict inherits scrape staleness. Provenance timestamps + "prices may differ" line are the honest minimum [13].
- **Eval cost.** Tier B pass^3 × 12 × ~4 calls ≈ 150 Sonnet calls/night, low single-digit dollars. Not per-PR.
- **Two founders.** Five PRs ≈ 2–4 weeks of one person. The evals PR is the one people cut; it keeps the others honest.

---

## 5. Implementation: five PRs (Claude Code prompts)

Order: 1 → 2 → 3 → 4 → 5. Each prompt is self-contained; paste as-is.

### PR 1 — `feat/assistant-request-state`

```
Branch: feat/assistant-request-state

Read first, in this order: CLAUDE.md, server/API.md (the "Assistant" section fully),
server/src/services/assistant/loop.ts, tools.ts, plans.ts, history.ts, clarify.ts,
server/test/assistantLoop.test.ts, server/test/helpers.ts, docs/assistant-spec.md §2.1.

Goal: the server owns the user's parking request as a versioned RequestState the model
edits only through a new tool. This PR adds the state and the tool; it does NOT yet
change quote_street/search_garages/propose_plan (PR 2).

Behavior:
1. New file server/src/services/assistant/requestState.ts exporting the RequestState
   type (fields: version, intent enum park_now|park_later|garage_or_lot|null, place
   {query, resolved, candidates}, window {startsAt, durationMinutes, source}, hard
   {maxPriceUsd, maxWalkMinutes, kinds, entryType, covered}, soft {rank, prefer}, log[])
   plus pure functions: emptyState(), applyPatch(state, patch, utterance, now) ->
   {state, changed[], overrides[]}. applyPatch: a set on an already-set field is a
   supersede (last wins), clear removes, version bumps by 1 on any change, log appends
   one entry per changed field. Derive intent deterministically after every patch:
   startsAt null -> park_now unless kinds==["garage"] -> garage_or_lot; startsAt more
   than 15 min ahead -> park_later. If the model's intent disagrees, the derived one
   wins and `overrides` records it. All times go through the existing ET helpers in
   hours.ts / tools.ts (parseEasternTime, easternIso); an unreadable startsAt is
   rejected with unreadable_time and the same TIME_FORMAT_HINT.
2. Persist request_state JSONB on the assistant conversation row (Prisma migration +
   the fake DB in test/helpers.ts). Load it before the model call; save after.
3. New tool update_request in TOOL_DEFINITIONS with strict: true and a FLAT schema
   (no Partial<>; explicit optional fields; `clear` is an enum array of dotted field
   names; `reason` string required). Executing it calls applyPatch and returns the
   full new state + changed + overrides. Max 2 calls per turn; the third returns
   {error:"too_many_edits"} and is audited. Every call writes an assistant_tool
   decision row with inputs {patch} and outcome {version, changed, overrides}.
4. System prompt: add a "Current request" block rendered from the state each turn
   (compact JSON, nulls omitted) and one rule: "When the user changes anything about
   the request, call update_request with only what changed before searching."
5. API.md: document the tool, the state, and the persistence.

Tests that MUST fail on main and pass here (server/test/requestState.test.ts and
additions to assistantLoop.test.ts):
- applyPatch supersedes maxPriceUsd 30 -> 20 -> 10 with three log entries, version 3.
- "tonight" patch sets startsAt and flips intent to park_later; clearing startsAt flips
  back to park_now, `changed` lists both.
- model passes intent park_now with startsAt +3h -> overrides records park_later.
- third update_request in one turn returns too_many_edits and is audited.
- state round-trips through the conversation row across two /assistant/message calls
  (scripted model), and a new conversation starts from emptyState().
- offset-less startsAt "2026-09-26T19:00" stores as "2026-09-26T19:00:00-04:00".

Then: pnpm -r lint && pnpm -r test. Boot the API locally per CLAUDE.md (boot-check
against migrated PostGIS) and run the FR suite: pnpm -C server test:fr with
FR_API_BASE pointed at the local boot and the FR user key; the dry-run gate must pass.

Skeptical self-review before saying ready: read your diff as a reviewer who believes
the model will (a) send the whole state instead of a patch, (b) send a patch with no
changes, (c) send a field name not in the enum, (d) send intent that contradicts
startsAt. Add a test for each that isn't covered. Confirm nothing in this PR changes
what propose_plan accepts. Confirm scripts/check-city-neutral.sh still passes (no city
names in requestState.ts). CI must be green (server, boot, ios, city-neutral) before
you say ready. Squash-merge only; do not merge.
```

### PR 2 — `feat/assistant-find-options-and-say-no`

```
Branch: feat/assistant-find-options-and-say-no

Read first: CLAUDE.md, server/API.md, docs/assistant-spec.md §2.1–2.3 and §2.6,
server/src/services/assistant/{loop,tools,plans,streetOptions,requestState}.ts,
server/src/services/garage/garageProvider.ts,
server/test/{assistantLoop,assistantHistory,assistantModelRouting}.test.ts.

Goal: searches read constraints from RequestState instead of model arguments; the
server decides when nothing meets the request; propose_plan validates every option
against the latest search and the hard constraints; the loop stops synthesizing plans.

Behavior:
1. quote_street and search_garages lose their lat/lng/when/duration/price parameters.
   They take no input except an optional `note` string. They read place.resolved,
   window, hard, soft from the conversation's RequestState. If place.resolved is null
   they return {error:"place_unresolved"} (with candidates if any); the loop then forces
   ask_user with those candidates (reuse ctx.placeChoices). Mark both strict: true.
2. Each search result is {stateVersion, satisfying: Option[], nearMisses: {option,
   violates:[{field, actual, limit}]}[], relaxSuggestions?: [{field, to, wouldYield}]}.
   Satisfying = passes every set `hard` field. Ranking is a pure function in
   streetOptions.ts keyed by soft.rank (cheapest: price then walk; closest: walk then
   price; balanced: price + 0.50/min walk); soft.prefer subtracts a fixed 1.00 bonus.
   The model never reorders. relaxSuggestions are computed only when satisfying is
   empty: re-run the filter (not the provider call) with each hard field relaxed one
   step (price +$5, walk +5 min, kinds -> both) and report the count.
3. Store the latest result on ctx.lastSearch keyed by stateVersion. Delete
   captureQuotes/synthesizePlan and the synthesis branch in loop.ts. Keep the ONE
   PROPOSE_PLAN_REMINDER.
4. plans.ts: add kind "none_meets" {constraintsFailed[], nearMisses[], relaxSuggestions[]}.
   propose_plan validators, in this order, each auditing its rule name:
   V1 every option id must exist in ctx.lastSearch at the current stateVersion else
   {error:"stale_or_unknown_option"}; V2 priceUsd, walkMinutes, zoneId, deepLink are
   overwritten from the search result (audit model_price_mismatch when different);
   V3 an option in nearMisses may appear only with nearMiss:true and server-copied
   violates, else {error:"hard_constraint_violation"}; V4 if lastSearch.satisfying is
   empty the plan must be kind none_meets, else {error:"must_say_no"} — and if the
   model calls propose_plan with kind none_meets while satisfying is non-empty, reject
   {error:"options_available"}; V5 keep the daily-cap recompute and add per_plan_cap_usd
   from policy (default = daily cap).
5. Reply scrub: after the loop, every $d.dd in the reply must match a price in
   lastSearch or the plan; drop the sentence otherwise and audit ungrounded_number.
6. Tool failures: garage provider error with intent garage_or_lot -> the loop returns
   a none_meets-shaped card with constraintsFailed [{field:"garageSearch",
   reason:"unavailable"}] and no street options; with other intents the existing
   street-only card with provenance.garage "unavailable". Geocoder error with intent
   park_now and a phone location -> proceed with phone location, source "default".
   Empty results inside coverage with no hard constraints -> a "no data" card
   (rule no_zone_here, nearest 3 zones), never a none_meets.
7. API.md: document the new result shape, none_meets, and every validator rule.

Tests that MUST fail on main and pass here (server/test/assistantSayNo.test.ts,
assistantValidators.test.ts, plus updates to assistantLoop.test.ts):
- state maxPriceUsd 2 near a point whose candidates cost 4.50/6.00 -> search returns
  satisfying [] with two nearMisses each violating maxPriceUsd, relaxSuggestions
  includes price 7 wouldYield 2; propose_plan single_spot is rejected must_say_no;
  propose_plan none_meets is accepted and the card carries the near-misses.
- CS-01 end to end with a scripted model: turn 1 quotes, turn 2 update_request
  maxPriceUsd 20 then search; a propose_plan using a turn-1 option id ->
  stale_or_unknown_option; final card ids all from v2.
- model sends priceUsd 3.00 for an option quoted 4.50 -> card shows 4.50, audit row
  model_price_mismatch.
- model ends in prose "It's $4.50 on Mass Ave" with no plan -> after the one reminder
  the reply has no dollar amount, no card, no synthesized plan, audit ungrounded_number.
- garage provider throws with intent garage_or_lot -> none_meets card, zero street
  options; with intent park_now -> street card with provenance.garage unavailable.
- quote_street called with place.resolved null -> place_unresolved and the turn ends
  in ask_user with candidates.
- empty provider results inside coverage, no hard constraints -> no_zone_here card.
- cheapest vs closest ranking on a fixed fixture produces the documented orders.

Then: pnpm -r lint && pnpm -r test. Boot the API locally and run the FR suite against
it in dry run; the existing FR assistant tests must still pass (they exercise the real
model against the new tool shapes — if one fails, read the decision rows with
pnpm -C server decisions:recent before touching the prompt).

Skeptical self-review: assume the model will try to call propose_plan with an option
it invented, an option from a previous turn, a none_meets while options exist, and a
reply that restates a near-miss price as if it met the budget. Assume the garage
provider returns options with priceUsd null. Verify the SSE plan event still fires for
none_meets. CI green before ready. Do not merge.
```

### PR 3 — `feat/assistant-intent-router-and-cards`

```
Branch: feat/assistant-intent-router-and-cards

Read first: CLAUDE.md (iOS project section: XcodeGen, project.yml, #if DEBUG rules,
release-denylist), server/API.md, docs/assistant-spec.md §2.3–2.4,
server/src/services/assistant/{loop,tools,plans,requestState}.ts,
ios/ParkAgent/Views/Assistant/ (every file), the iOS MockAPI fixtures for the
assistant, ios UI tests touching the plan card.

Goal: the three intents change which tools are enabled, which defaults apply, and how
the card renders; the app shows the current request as editable chips and renders
none_meets with near-miss badges and relax chips.

Server behavior:
1. Tool gating by intent, computed per model call in loop.ts from the loaded state:
   park_now -> quote_street, search_garages, propose_plan, ask_user, update_request;
   park_later -> those + build_itinerary; garage_or_lot -> search_garages, propose_plan,
   ask_user, update_request (street may appear only as a nearMiss the server adds when
   a street option is cheaper and hard.kinds does not exclude it). A call to a gated
   tool returns {error:"tool_not_available_for_intent", intent}.
2. Defaults: park_now durationMinutes 60 (source "default"); park_later and
   garage_or_lot with durationMinutes null -> searches return {error:"duration_needed"}
   and the loop forces ask_user with suggestions "1 hour / 2 hours / 4 hours / all day"
   (extend clarify.ts). V7: park_later with startsAt more than 5 min in the past ->
   {error:"time_in_past", nowEastern}.
3. Card payload gains: requestSummary (the state minus log, for the chips),
   verdict "meets"|"none_meets", per-option nearMiss/violates, relaxSuggestions, and
   warn:true on any option with priceUsd > policy.confirm_warn_usd (new policy field,
   default 15, PUT /policy validated, documented in API.md and in both lists in
   scripts/boot-check.sh if it gets an env default).
4. Suggestions: relaxSuggestions become suggestion chips whose `reply` is a plain
   sentence ("Allow up to $7.00") so a tap flows through update_request naturally.

iOS behavior (Views/Assistant):
5. A RequestChipsView above the newest card: intent, place label, time window, each
   hard constraint, and the rank; tapping a chip sends a short message ("change the
   budget") — no local editing of state; the server owns it.
6. NoneMeetsCardView: headline from constraintsFailed, up to 3 near-miss rows each
   with a badge "$2.00 over your $20.00 cap" / "4 min past your 10-min walk", and the
   relax chips. No Confirm button on near-miss rows.
7. warn:true rows require a long-press to confirm. Nothing else changes about how a
   tap mints the confirmation token.
8. MockAPI fixtures for none_meets and warn cards; SwiftUI previews; project.yml only
   if a new file group is needed (never the .xcodeproj).

Tests that MUST fail on main and pass here:
- server: garage_or_lot + quote_street -> tool_not_available_for_intent; park_later
  with no duration -> ask_user with the duration suggestions; startsAt in the past ->
  time_in_past; option 18.00 with confirm_warn_usd 15 -> warn true; a street option
  cheaper than every garage under garage_or_lot appears once, as a nearMiss.
- iOS unit tests: decoding the none_meets and warn payloads; the badge text formatter
  for price and walk overages; RequestChipsView renders one chip per set field.
- iOS UI test (MockAPI): none_meets fixture shows no Confirm button; warn fixture
  requires long-press (tap alone does not call /assistant/confirm).

Then: pnpm -r lint && pnpm -r test; cd ios && xcodegen generate && run the unit tests
and the ParkAgentRelease scheme tests; ios/Tools/check-release-binary.sh on the Release
app. Boot the API locally and run the FR suite in dry run.

Skeptical self-review: assume the user says "garage" then "or street is fine" — does
intent move back and the gate reopen (test it)? Assume the phone location line is
missing under park_now — the card must not silently default the place. Assume the
relax chip reply text could be misread by the model as a new hard cap on a different
field. Confirm no Debug-only code leaked outside #if DEBUG (release strings check). CI
green including ui-tests where possible before ready. Do not merge.
```

### PR 4 — `feat/assistant-budget-and-preferences`

```
Branch: feat/assistant-budget-and-preferences

Read first: CLAUDE.md, server/API.md (policy, caps, wallet activity),
docs/assistant-spec.md §2.5, the policy service,
server/src/services/assistant/{tools,plans,requestState,streetOptions}.ts,
the spentToday helper, ios Settings views that show the daily cap.

Goal: a clear three-layer money model — hard caps (policy), an approval threshold
(confirm_warn_usd from PR 3, plus long-press), and persisted soft preferences — with
the assistant able to explain caps but never change them.

Behavior:
1. Policy: per_plan_cap_usd (default = daily_cap_usd) and max_session_minutes (default
   720) added to the policy document, PUT /policy validation, GET /policy, API.md, and
   both boot-check.sh lists if they get env defaults. propose_plan V5 enforces both;
   itinerary stops over max_session_minutes are rejected with the stop id.
2. user_preferences table (userId, rank, prefer[], defaultDurationMinutes, updatedAt)
   with GET/PUT /me/preferences. RequestState.emptyState(userPrefs) seeds soft.rank
   and soft.prefer from it; the card's requestSummary marks them "(your default)". A
   soft change made in chat updates the request only — never the stored default —
   unless the user says so and the model calls a new tool save_preferences({rank,
   prefer, defaultDurationMinutes}) which writes the row and audits it. No tool can
   write policy: any attempt phrased as a cap change ("raise my cap") is answered by
   the assistant pointing at Settings; add a prompt line and a test.
3. Remaining-budget awareness without model arithmetic: search results include
   remainingDailyUsd; options above it move to nearMisses with violates field
   "remainingDailyUsd" (server-computed), so BG-01 produces a near-miss not a rejection
   after the fact.
4. Wallet activity: plan rows show plannedUsd (exists); add the cap context
   (capUsd, remainingAtProposalUsd) for the explain_decision template.

Tests that MUST fail on main and pass here:
- daily cap 30, spent 25, option 8.00 -> search puts it in nearMisses violating
  remainingDailyUsd 5.00; propose_plan with it as meets -> hard_constraint_violation.
- per_plan_cap_usd 20 with a 22.00 option -> nearMiss; itinerary stop 800 min ->
  rejected with stop id.
- preferences row rank=closest seeds soft.rank on a new conversation; "cheapest" in
  chat changes the request but GET /me/preferences still says closest;
  save_preferences writes it and audits.
- scripted model calls a nonexistent set_policy tool / "raise my cap" -> no policy
  write; reply mentions Settings.
- PUT /policy rejects per_plan_cap_usd > daily_cap_usd and negative values.

Then: pnpm -r lint && pnpm -r test; boot locally; run the FR suite in dry run (the FR
harness never calls PUT /policy — do not add a test that does; test policy validation
in the unit suite only).

Skeptical self-review: assume a race between two turns of the same user each proposing
a plan near the remaining cap — the tap path (consumeConfirmation + session start) must
still be the place the cap is finally enforced; confirm it is and add a test if not.
Assume prefer contains a value not in the enum. Assume defaultDurationMinutes is 0.
CI green before ready. Do not merge.
```

### PR 5 — `feat/assistant-golden-evals-and-gates`

```
Branch: feat/assistant-golden-evals-and-gates

Read first: CLAUDE.md (CI section), docs/assistant-spec.md §3, server/vitest.config.ts,
server/vitest.fr.config.ts, server/fr/client.ts, server/fr/report.mjs,
docs/functional-requirements.md, .github/workflows/ci.yml and the nightly FR workflow,
server/test/helpers.ts, server/src/services/assistant/{loop,requestState}.ts,
the decisions:recent script.

Goal: a golden conversation suite that grades END STATE (RequestState + plan kind/
option ids), runs hermetically in CI against the scripted model, and nightly against
the real model with pass^3 reporting; plus per-turn metrics on the decision row.

Behavior:
1. server/test/golden/*.json: at least 40 conversations covering the IDs CS-01..12,
   IM-01..08, AP-01..07, TF-01..09, DT-01..09, IR-01..05, BG-01..04 from
   docs/assistant-spec.md §3. Each case: fixture (candidates, garage options, geocode
   results, provider failures), user turns, and expected {stateAfterEachTurn (fields
   that matter), finalPlanKind, allowedOptionIds, forbiddenOptionIds, mustAsk?,
   replyMustNotMatch: [regex]}. A required-output check on every case so a do-nothing
   run fails.
2. A golden runner (server/test/golden.test.ts) that plays each conversation through
   the app with a scripted model per case and asserts the expectations. This runs in
   pnpm -r test and therefore in CI `server`. 100% required.
3. server/fr/assistantGolden.fr.test.ts: the 12 cases tagged FR-5x in the JSON run
   against the live API with the REAL model, each 3 times, graded by the same
   expectation code; report pass^3 per case in the FR summary (extend fr/report.mjs
   with a pass^k column parsed from test names). Raise the assistant call budget for
   this file only via FR_ASSISTANT_MAX_CALLS in the nightly workflow; keep retry 0.
   Optional Haiku judge (EXPLAIN_MODEL) only for "reply is phrased as a no" on
   none_meets cases, never for state.
4. Metrics: the assistant_turn decision row gains stateEdits, stateVersion,
   verdict, groundedNumbers/scrubbedNumbers, validatorBounces[], and
   toolFailures[]. Add pnpm -C server assistant:metrics --days 7 printing bounce rate,
   hard-violation count (must be 0), scrub count, none_meets rate, p50/p95 latency,
   cost/turn, modelCalls/turn.
5. CI gate: a new job `assistant-golden` (or the existing server job) fails the PR on
   any golden failure; the nightly opens/updates the FR issue when pass^3 < 0.67 on any
   case or a hard-violation count > 0 appears in the last 24h of decisions.
6. docs/assistant-evals.md documents the schema, how to add a case from a production
   trace (decisions:recent -> fixture), and the promotion rule (a failed prod trace
   becomes a golden case in the same PR as its fix).

Tests that MUST fail on main and pass here:
- the golden runner itself: a deliberately wrong expectation file in test/golden/
  _selftest/ must make the runner report a failure (test the grader, then skip the
  fixture); a case with no required-output check is rejected by the loader.
- at least one golden case per group fails if PR 2's validators are disabled (guard:
  run the runner with an env flag that stubs V4 off and assert IM-01 fails).

Then: pnpm -r lint && pnpm -r test; boot the API locally; run the FR suite in dry run
including the new file with a small FR_ASSISTANT_MAX_CALLS to confirm the budget guard
fails the run cleanly before running it with the full budget once.

Skeptical self-review: assume the scripted model in a golden case is written to pass
rather than to imitate the real model's mistakes — add at least 5 cases where the
script does the WRONG thing (stale id, invented price, prose with prices, wrong
intent, three edits) and the expectation is the validator's correction. Assume the
Haiku judge is flaky — it must never be the sole reason a case fails. Confirm the
nightly cannot run against a non-dry-run server (the gate). CI green before ready.
Do not merge.
```

---

## 6. Open questions for the founders

1. **Detector auto-pay threshold.** Should `confirm_warn_usd` also gate the automatic pay-on-park path (push-to-confirm above it), or does the assistant's tap-always rule stay separate from the detector's auto-pay? Same money model; users will expect one answer.
2. **"Closer"/"cheaper" without numbers:** server heuristic shown as an assumption, or always ask for a number? Field test both for a week and count re-edits.
3. **Garage-only intent and street.** Show a cheaper meter as a near-miss (proposal) or not at all?
4. **Preference persistence.** Silent after N uses, or only via explicit `save_preferences`? Recommendation: explicit.
5. **Refusal on stale garage data.** Do you want a "nothing under $20" verdict when garage prices are an unofficial scrape possibly hours old, or should garage near-misses always be labeled "as of HH:MM"? Acceptable staleness before the verdict degrades to "couldn't check garages"?
6. **Per-plan cap default.** Equal to daily cap, or lower (e.g. 50%)?
7. **Eval budget.** ~$3–5/night and ~150 nightly live calls acceptable now? If not, pass^3 → pass^1 and you lose the reliability signal.
8. **Who reads traces.** Who owns the weekly 20-trace review, and does it happen before or after field-test days?

---

## Sources

1. Uber Engineering — Solving the Identity Crisis for AI Agents (May 2026): https://www.uber.com/us/en/blog/solving-the-agent-identity-crisis/
2. Speakeasy — How Uber built the enterprise AI security playbook (May 2026): https://www.speakeasy.com/blog/uber-enterprise-ai-playbook
3. TMCnet — How Uber Built AI Agents That Saved 21,000 Developer Hours (LangGraph Interrupt talk): https://blog.tmcnet.com/blog/rich-tehrani/ai/how-uber-built-ai-agents-that-saved-21000-developer-hours.html
4. Uber Engineering — Unlocking Financial Insights with Finch (Jul 2025): https://www.uber.com/us/en/blog/unlocking-financial-insights-with-finch/
5. ByteByteGo — How Uber Built a Conversational AI Agent for Financial Analysis (Nov 2025): https://blog.bytebytego.com/p/how-uber-built-a-conversational-ai
6. Dot — Uber's Finch (Jul 2025): https://www.getdot.ai/blog/uber-finch-financial-data-agent
7. Arize — How Uber evaluates AI agents at production scale (Aug 2026): https://arize.com/blog/how-uber-evaluates-ai-agents-at-production-scale/
8. The Technology Express — Uber Launches OpenAI Assistant for Drivers and Voice Ride Booking (May 2026): https://thetechnologyexpress.com/uber-launches-openai-assistant-for-drivers-and-voice-ride-booking/
9. Ramp Help Center — Policy Agent Overview: https://support.ramp.com/hc/en-us/articles/44072387128979-Policy-Agent-Overview
10. Ramp Builders — How To Build Agents Users Can Trust (Jul 2025): https://builders.ramp.com/post/how-to-build-agents-users-can-trust
11. ZenML LLMOps DB — Ramp: Building Trustworthy AI Agents for Automated Expense Management: https://www.zenml.io/llmops-database/building-trustworthy-ai-agents-for-automated-expense-management
12. Ramp — Procurement Case Studies (Aug 2026): https://ramp.com/blog/procurement-case-studies
13. Firebase — Grounding with Google Maps: https://firebase.google.com/docs/ai-logic/grounding-google-maps
14. Google AI for Developers — Grounding with Google Maps: https://ai.google.dev/gemini-api/docs/maps-grounding
15. Google Cloud — GroundingSupport / GroundingMetadata reference: https://cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/GroundingMetadata
16. arXiv 2605.14021 — Measuring Google AI Overviews: Activation, Source Quality, Claim Fidelity: https://arxiv.org/pdf/2605.14021
17. Anthropic Engineering — Demystifying evals for AI agents (Jan 2026): https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
18. ai-eval.org deep dive on [17]: https://ai-eval.org/deep-dive/anthropic-demystifying-evals-for-ai-agents
19. Claude API docs — Strict tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use.md
20. Claude API docs — How to implement tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
21. OpenAI — A practical guide to building agents: https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
22. OpenAI — same guide, PDF: https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
23. arXiv 2304.06556 — Are LLMs All You Need for Task-Oriented Dialogue?: https://arxiv.org/pdf/2304.06556
24. arXiv 2202.07156 — On Tracking Dialogue State by Inheriting Slot Values in Mentioned Slot Pools: https://arxiv.org/pdf/2202.07156
25. arXiv 2608.15755 — Intent-Driven Situation Tracking for User-Centric Multi-Turn Agents: https://arxiv.org/pdf/2608.15755
26. arXiv 2406.12045 — τ-bench: A Benchmark for Tool-Agent-User Interaction: https://arxiv.org/abs/2406.12045
27. Sierra — τ-Bench: Benchmarking AI agents for the real-world: https://sierra.ai/blog/benchmarking-ai-agents
28. arXiv 2507.02825 — Establishing Best Practices for Building Rigorous Agentic Benchmarks: https://arxiv.org/pdf/2507.02825
