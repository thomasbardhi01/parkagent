# ParkAgent codebase audit — brief for the auditing session

Paste the "PROMPT" section below into a fresh Claude Code session opened at the repo
root (model: Opus). Expect several hours of wall time; the session may compact more than
once, so Phase outputs are written to disk as they finish, never held in the chat.

Why now: main has not moved since 2026-10-05, the nightly FR suite has been red since at
least 2026-10-15 with every model-backed test (FR-21…FR-43, FR-38) failing together, the
daily `supply-chain` job is red, three feature PRs (#212, #213, #214) are waiting, and
V1 is being narrowed to **Boston only**. Before merging anything else we want one honest,
evidence-backed picture of what the build does today, what is broken, and what is dead
weight for a Boston-first MVP.

---

## PROMPT

CODEBASE AUDIT — ParkAgent

TARGET
Repo/path: thomasbardhi01/parkagent, the checkout at ~/Documents/parkagent, branch main.
Version/commit: whatever `git rev-parse HEAD` says; write it on line 1 of the report.
What it does: an iOS app + Fastify server that detects a parked car, quotes the meter, pays
through the driver's own ParkBoston/ParkNYC account via a Playwright executor, auto-extends,
and offers a Claude-backed assistant that finds and plans street or garage parking.
Stack: pnpm 12 workspace; server/ Fastify + TypeScript 6 + Prisma 7 + Postgres/PostGIS
(`pnpm -C server test`, vitest); executor/ Playwright + TypeScript (`pnpm -C executor test`);
ios/ SwiftUI, Swift 6, XcodeGen (`cd ios && xcodegen generate`, then xcodebuild test on a
simulator); data/ Python 3.12 + uv. Read CLAUDE.md first; it is accurate about layout and
rules, and part of your job is to find where it is NOT accurate about the code.

Focus: **Boston (ParkBoston / Passport) is the product.** NYC code stays in the repo but is
out of scope for fixes; for every finding say whether it is on the Boston path.

Off-limits (never read, run, or print):
- `.env`, `ios/Config.xcconfig`, anything under `~/.fly`, `~/.config/gh`, Keychain.
- `fly …` with any subcommand other than `fly status` / `fly releases` / `fly secrets list`
  (names only — never `fly ssh`, never `fly secrets set`, never `fly deploy`).
- Any request to https://parkagent-api.fly.dev other than `GET /health`.
- Any `DATABASE_URL` other than the local dev / Neon dev one; never the prod proxy.
- `pnpm -C executor run login|record` (they open a real provider site).
- `executor/fixtures/**` contents beyond file names and sizes (recorded sessions may hold
  real cookies, names or a plate).
- Real values: the plate, card digits, emails, names of real people, keys, cookies. In the
  report write "plate (6 chars)", "email (17 chars)", etc.

Safe to run: `pnpm install --frozen-lockfile`, `pnpm -r lint`, `pnpm -r test`,
`pnpm audit --prod`, `pnpm -C server prisma validate`, `pnpm -C server prisma migrate diff`
against a scratch DB, `scripts/check-city-neutral.sh`, `scripts/boot-check.sh off|on|broken`
from a scratch worktree with no `.env`, `scripts/audit.mjs`, `scripts/check-action-pins.sh`,
`xcodegen generate`, `xcodebuild … test` on a simulator, `pnpm -C server dev` against a local
Postgres with `DRY_RUN=true` and NO `ANTHROPIC_API_KEY` (the assistant will 503; that is
fine), `gh pr view/checks/diff` and `gh run view --log-failed` (read-only).

GROUND RULES
- Read-only on code until the report is done. Don't fix anything yet. The one exception is
  Phase 3.5 (adding tests), on a branch named `audit/tests-<area>`, never on main.
- Never run anything that writes to production, sends a push, charges money, deletes data,
  comments on GitHub, or merges. Dry runs and local tests only.
- Every claim needs evidence: `file:line`, a command and its output, or a test result. What
  you did not verify is labelled **unverified**. Never say something works because
  CLAUDE.md, API.md or a PR body says so.
- Stop and ask before: adding a dependency, touching `.github/`, `fly.toml`, a migration,
  or anything irreversible.
- Write each phase's output to `docs/audit/2026-10/<phase>.md` as you finish it (create the
  folder). If the session compacts, the next turn reads those files and continues.
- Use subagents to keep your own context small: `code-map` (Haiku) for sweeps and callers,
  `test-run` (Sonnet) for suites, `ci-watch` (Haiku) for GitHub logs. You keep the judgement.

PHASE 1 — INVENTORY AND SAFETY SCAN  → `01-inventory.md`
1. Every tracked file by area (server src / server tests / FR tests / executor / ios app /
   ios tests / data / scripts / CI / docs) with line counts (`git ls-files | xargs wc -l`).
   Note untracked-but-present files that matter (`git status --ignored`, names only).
2. Secrets and private-data scan of the working tree AND the full history
   (`git log --all -p` piped through a pattern search; `git log --all --format=%B` for
   commit messages): API keys, `sk_live`/`sk_test`, `AuthKey_*.p8` contents, JWTs,
   cookies, `postgres://` URLs with passwords, emails, phone numbers, a license plate, real
   names other than the two founders. Confirm `.env`, `Config.xcconfig` and Playwright
   `storageState` were never committed in any revision. Report PASS/FAIL per category with
   redacted evidence (commit short-sha + path, never the value). Issue #48 already lists
   known exposures; confirm or extend it.
3. Dependencies: `pnpm audit --prod`, `scripts/audit.mjs`, outdated majors
   (`pnpm -r outdated`), unused deps (compare `package.json` to imports), the two deliberate
   pins (Prisma ^7, TypeScript 6) still justified or not, Python deps in `data/pyproject.toml`.
   Explain why the daily `supply-chain` workflow is currently red (read its latest log with
   `gh run view --log-failed`).

PHASE 2 — FUNCTIONALITY AUDIT  → `02-modules.md`, one section per module
Modules, in this order (Boston money path first):
  a. `server/src/routes/parked.ts` → `services/zoneLookup*`, `services/quote*`,
     `services/placeClassification.ts`
  b. `server/src/routes/session.ts`, `services/sessions.ts`, the 60 s extension worker,
     `services/limits.ts`, `policy.json` loading, DRY_RUN evaluation
  c. `server/src/services/parknycExecutor.ts` ↔ `executor/src/**` (Passport flow only in
     depth; Flowbird skimmed) — every typed result, every place a click happens after
     `afterPayClick`, retry/idempotency, the circuit breaker, the gate
  d. providers: link job, cookie sealing (`PROVIDER_STATE_KEY`), `providerHealthTick`
  e. accounts: Apple sign-in, JWT + refresh rotation, `DELETE /me`, revocation job
  f. wallet: `payment_source` switching, holds, Issuing gates, Link gates
  g. assistant: `services/assistant/{loop,tools,plans,requestState,…}.ts`, `routes/assistant.ts`
     — budgets (`ASSISTANT_DAILY`), confirmation tokens, validators V1–V5, every external
     call (Anthropic, Apple Maps, SpotHero, ParkWhiz, Nominatim)
  h. jobs and schedulers: list every `setInterval`/cron-like loop, its lock, overlap risk
  i. `server/src/env.ts` + `scripts/boot-check.sh`: every env var, who reads it, what turns off
  j. ios: `Detection/*` (fusion engine, classifier), `State/AppModel.swift`, `LiveAPI.swift`,
     `ParkOutbox`, Keychain; where the app can still PAY without the user seeing an amount
  k. data/: Boston zone build + Passport zone-number import; NYC scripts listed only
For each: purpose, inputs/outputs, imports and callers, external calls (endpoint, method,
fields sent/read), state read/written (table + columns), behaviour on timeout / bad data /
partial failure / rate limit / run twice, docs-vs-code mismatches (CLAUDE.md, server/API.md,
docs/functional-requirements.md, docs/reliability.md), dead code and TODOs, and a risk
rating: High (can move money wrongly, lose/corrupt/leak data), Medium, Low.
Cross-module: config switches that do nothing; env keys read but never defined in
`env.ts`; jobs that can overlap; logging gaps (after a failed payment, can we reconstruct
what happened from `decisions` + logs alone?); injection / unvalidated input / auth gaps /
secrets in logs. Specifically answer: **is there any path on which money moves without (1)
DRY_RUN false, (2) a cap check through `policyFor(user)`, (3) a `decisions` row, and (4) a
user tap or an explicit YOLO consent?** Quote the code for each of the four.
Boston-first triage: for every module and route, mark `boston-path` / `nyc-only` /
`garage-only` / `both`. Propose what can be feature-flagged off or deleted for the MVP.

PHASE 3 — TESTING  → `03-tests.md`
1. Full suites on the supported runtime: server, executor, iOS unit tests (simulator), lint,
   city-neutral, boot-check off/on/broken (scratch worktree). Counts, failures, skips,
   warnings, runtime.
2. Fresh-clone run: `git clone` into a temp dir with no `.env`, `pnpm install
   --frozen-lockfile`, run the server and executor suites. Prove nothing depends on this Mac.
3. Coverage: `vitest run --coverage` for server and executor if configured (ask before adding
   the coverage package); otherwise map test files to modules by hand. List modules and
   branches with no coverage, Boston money path first.
4. Test quality: three examples each (file:line) of tests that assert nothing meaningful,
   mock the thing under test, or can't fail.
5. The FR suite: read `server/fr/*.fr.test.ts` and the latest nightly failure
   (`gh run view <id> --log-failed`, issue #216). Determine whether the nine failing
   assistant FRs share one cause (model backend) or several. Do NOT run the FR suite
   against prod.
3.5 Add tests for the highest-risk gaps found in Phase 2, offline only, on
   `audit/tests-<area>`. Each new test must fail when the behaviour it covers is broken:
   prove it by breaking the code, running, restoring, running again, and record both
   outputs.

PHASE 4 — SYSTEM MAP  → `04-system-map.md` (+ `04-system-map.html`)
From the code, not the docs: a Mermaid diagram of entry points (routes, jobs, iOS
triggers), modules, who calls whom, external systems (Passport, Flowbird, Anthropic, Apple
Maps/APNs/Sign-in, Stripe, SpotHero, ParkWhiz, Nominatim, Fly), data stores (each Prisma
model), scheduled loops. A field-flow table per external system and per table (fields in,
fields out, owning module, where transformed). Sequence diagrams for: (1) park detected →
quote → tap → Passport pay → session → extension → stop; (2) assistant request →
plan → confirm → session; (3) provider link. Mark every box and arrow "verified in code"
or "from docs only". Colour the Boston path.

PHASE 5 — REPORT  → `docs/audit/AUDIT-2026-10.md`
1. Verdict in 5 lines: does it work, can it be trusted with a real card in Boston, top risks.
2. Findings table: # | Area | file:line | Issue | Evidence | Risk | Boston-path? |
   Suggested fix | Effort (S/M/L). Ranked by risk.
3. Docs-vs-code mismatches (CLAUDE.md, API.md, FRs, workstreams).
4. Test results and coverage gaps (counts, not adjectives).
5. What you could not verify and why (prod state, Apple Maps live, Passport live, etc.).
6. Recommended fix order grouped into issues of under a day each, with a proposed PR
   title and the files each touches, Boston money path first, then "restore the nightly",
   then "turn off / delete for MVP".
7. What to do with the three open PRs (#212, #213, #214) and the two Dependabot PRs
   (#219, #220): merge as-is, rebase, split, or close — with the reason from the code.

FINISH
Re-read your own report and spot-check 5 findings against the code; delete any you
cannot reproduce. Print the list of files you added (nothing else should have changed:
`git status --short` must show only `docs/audit/**` and, on the tests branch, test files).
Don't merge, don't push main, don't comment on GitHub. Stop.
