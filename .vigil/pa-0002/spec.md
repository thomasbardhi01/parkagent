<!-- provenance: claude -->
# pa-0002: Feature-map line checker catches stale line references (#272)

## Goal
`scripts/check-feature-map.mjs` fails when a `path:line` reference in `docs/feature-map.md`
points at a comment or blank line, or at a line that doesn't hold the identifier the map names
just before it. The existing references that break this rule on main are re-anchored, so the
check exits zero on main once the doc is fixed.

The new test lives under **`server/test/`** (`server/test/checkFeatureMap.test.ts`, vitest), so
`pnpm -C server test` runs it. It does not live under `scripts/`. The existing
`scripts/check-feature-map.test.mjs` keeps passing under CI's `node --test` step.

## Non-goals
- No change to the path-exists, routes-and-jobs-placed or endpoint checks.
- No re-anchoring of references that pass the new rule, even if their line drifted inside
  the right function.
- No change to `.github/workflows/ci.yml`. It already runs the script and its node test.
- No change to the prose in `docs/feature-map.md`. Only line numbers change.
- No identifier check for a status string, env var or column name that isn't declared
  in the target file (`ui_changed`, `ISSUING_LIVE`, `sessions.needs_review`, …).

## Acceptance criteria
- AC1: `checkFeatureMap(root)` reports a problem for a `path:N` reference (N > 1, the file is `.ts`/`.tsx`/`.mjs`/`.js`/`.swift`) whose line N, trimmed, is empty or starts with `//`, `/*` or `*` (this covers `///` and `/**`), and reports nothing extra for the same file referenced at `:1` or at a code line. test: `pnpm -C server test`
- AC2: `checkFeatureMap(root)` reports a problem when the map writes `` `name` `path:N` `` or `` `name` (`path:N` `` and `name` (or its last `.` segment) is declared in that file (`function name`, `const name`, `let name`, `class name`, `func name`, `export … name`), but line N doesn't contain `name`; it reports nothing when `name` isn't declared in the file. test: `pnpm -C server test`
- AC3: run as a script (`node scripts/check-feature-map.mjs`) against a fixture repo with one such stale reference, it exits non-zero and names the reference. test: `pnpm -C server test`
- AC4: `checkFeatureMap()` on the repo's own root returns no problems after the doc fixes listed under Risks. test: `pnpm -C server test`
- AC5: a reference past the end of its file yields exactly one problem, the existing "has N lines" one, and a reference to a code line in a file that passes today yields none, so the unchanged `scripts/check-feature-map.test.mjs` stays valid. test: `pnpm -C server test`

## Files in scope
- `scripts/check-feature-map.mjs`
- `server/test/checkFeatureMap.test.ts`
- `docs/feature-map.md`

## Files out of scope
- `scripts/check-feature-map.test.mjs`
- `.github/workflows/ci.yml`
- `docs/architecture.md`
- `docs/feature-map.mmd`
- `server/src`
- `server/vitest.config.ts`
- `server/package.json`

## Interfaces
The rule the checker enforces, pinned here so the doc worker can fix the doc to it before the checker exists:
- A reference is `` `<path>:<N>` `` or `` `<path>:<N>-<M>` ``, with `<path>` ending in `.ts`, `.tsx`, `.mjs`, `.js` or `.swift`. Only `N` is checked.
- **Comment rule:** N = 1 always passes, because it points at the file. Otherwise `lines[N-1].trim()` must not be `""` and must not start with `//`, `/*` or `*`. A Swift attribute line (`@MainActor`) is code and passes.
- **Name rule:** when the backticked token just before the reference (separated by one space, or by ` (`) is an identifier (`[A-Za-z_$][\w$.]*`, optionally followed by `()`), take its last `.` segment as `name`. If the file declares `name` (regex `\b(function|const|let|var|class|func|interface|type|enum)\s+name\b`), line N must contain `name`.
- Problem strings are `` `<raw>`: line <N> is a comment or blank `` and `` `<raw>`: line <N> doesn't mention <name> ``.
- `checkFeatureMap(root)` keeps its signature and return type (`string[]`). The new test imports it from `../../scripts/check-feature-map.mjs`.

## Money paths
none

## Risks
- **Count mismatch, question for the owner.** The request says "six stale lines". The rule above flags 14 references on 12 lines of `docs/feature-map.md` at `76d72b3`. I could not read #272's latest comment, which is the source of record for scope. The plan fixes all 14, because AC4 ("exits zero on main") needs them all fixed. If the owner wants only six, the rule must be narrowed, and the owner should name which six. The 14 re-anchors (doc line: old → new):
  - md:54 `server/src/services/quote.ts:55` → `:71`
  - md:59 `server/src/scripts/load-zones.ts:117` → `:120`
  - md:60 `server/src/routes/zones.ts:113` → `:116`
  - md:128 `server/src/routes/assistant.ts:233` → `:235`
  - md:139 `server/src/routes/assistant.ts:657` → `:660`
  - md:157 `ios/ParkAgent/Detection/FootprintIndex.swift:171` → `:181`
  - md:159 `server/src/services/garage/spotheroDeepLink.ts:76` → `:79`
  - md:170 `server/src/jobs/linkWorker.ts:48` → `:49`
  - md:170 `server/src/jobs/linkWorker.ts:54` → `:55`
  - md:172 `server/src/jobs/providerHealthTick.ts:32` → `:33`
  - md:180 `server/src/services/executor.ts:26` → `:30` (twice on that row)
  - md:188 `server/src/services/authService.ts:401` → `:406`
  - md:204 `server/src/routes/card.ts:395` → `:396`
- Some of these may have been deliberate pointers at a constant's doc comment. Under the new rule they point at the declaration, one to a few lines below.
- The name rule could false-positive on a common word declared in the file. The worker must run the real map (AC4) and narrow the rule rather than edit prose.
- `pnpm -C server test` doesn't typecheck or lint `server/test/` (tsconfig and eslint cover `src`), so importing an `.mjs` from vitest is fine. Keep the test hermetic: temp-dir fixtures, no network.
- Ordering: AC4 passes only on top of the doc fix, so the checker worker builds on the doc worker's branch (`depends_on`).
- A file edited between the spec and merge shifts line numbers. Rebase and re-run the check.

## Rollback
Revert the squash commit(s). The checker is CI-only and the doc is text, so nothing runtime or data-bearing changes.
