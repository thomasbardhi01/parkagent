<!-- provenance: claude -->
# pa-0002 plan

## Notes addressed
- **#272's latest comment is the source of record: adopted, with one open question.** I could not read the issue from here (no GitHub calls), so the scope follows the request. The pinned rule flags 14 references on 12 doc lines, not six. spec.md Risks records that mismatch as a question, with the full list, so the owner can narrow it at spec approval.
- **Two workers, two draft PRs with worker_report.json: adopted.** w1 fixes the doc and w2 changes the checker. Each opens its own draft PR. Opening PRs is the job of vigild and the worker App, not the coord.
- **Suggested split (checker plus test / six doc lines): adopted, ordered.** The two workers touch different files. But the checker's "clean on main" test (AC4) passes only after the doc fix, so w2 `depends_on` w1 and builds on its branch. spec.md `## Interfaces` pins the rule, so w1 can fix the doc before the checker exists.
- **test_cmd must run the new test offline: adopted via server/test/.** The new test is `server/test/checkFeatureMap.test.ts` (vitest, temp-dir fixtures, no network), so `pnpm -C server test` runs it. spec.md says explicitly that the test is not under `scripts/`. I didn't use `node --test scripts/ && …`, because the gate refuses `&`. The existing `scripts/check-feature-map.test.mjs` stays unchanged and still runs in CI's `city-neutral` job.

## Workers
```json
{
 "workers": [
  {
   "task_id": "pa-0002-w1",
   "goal": "Re-anchor the 14 stale path:line references listed in spec.md Risks (12 lines of docs/feature-map.md) to the declaration or code line they describe. Change only those line numbers.",
   "why": "They point at doc comments or blank lines. Readers and agents land on the wrong line, and the new checker (w2) would fail on main.",
   "value": 3,
   "risk": 1,
   "size": "XS",
   "test_cmd": "pnpm -C server test",
   "must_fail_first": false,
   "verify_level": 0,
   "done_when": "Each of the 14 references in spec.md Risks carries its new line number. Every other byte of docs/feature-map.md is unchanged. Under the spec's Interfaces rule, no path:N in the map (N > 1, code file) lands on a blank or comment line. pnpm -C server test is green.",
   "files_in_scope": [
    "docs/feature-map.md"
   ],
   "out_of_scope": [
    "scripts/check-feature-map.mjs",
    "server/test/checkFeatureMap.test.ts",
    "docs/architecture.md",
    "server/src"
   ],
   "depends_on": [],
   "labels": [
    "docs",
    "ws-tooling"
   ]
  },
  {
   "task_id": "pa-0002-w2",
   "goal": "Add the comment rule and the name rule from spec.md Interfaces to scripts/check-feature-map.mjs, with a vitest suite in server/test/checkFeatureMap.test.ts covering AC1-AC5.",
   "why": "Today the checker only checks that a line number is within the file's length. A reference that has drifted onto a doc comment or into a different function still passes CI.",
   "value": 3,
   "risk": 2,
   "size": "S",
   "test_cmd": "pnpm -C server test",
   "must_fail_first": true,
   "verify_level": 0,
   "done_when": "The new tests fail against the current checker, then pass. checkFeatureMap returns the pinned problem strings on two temp-dir fixtures: one with a reference at a comment line, and one where a declared name sits on another line. Run as a script on such a fixture, it exits non-zero. On the repo root (with w1 merged in) it returns []. A past-the-end reference yields exactly one problem. checkFeatureMap's signature is unchanged. node scripts/check-feature-map.mjs exits 0 on the branch, and pnpm -C server test is green.",
   "files_in_scope": [
    "scripts/check-feature-map.mjs",
    "server/test/checkFeatureMap.test.ts"
   ],
   "out_of_scope": [
    "docs/feature-map.md",
    "scripts/check-feature-map.test.mjs",
    ".github/workflows/ci.yml",
    "server/vitest.config.ts",
    "server/package.json",
    "server/src"
   ],
   "depends_on": [
    "pa-0002-w1"
   ],
   "labels": [
    "tooling",
    "ci",
    "ws-tooling"
   ]
  }
 ],
 "verify": [
  {
   "criterion": "AC1",
   "level": 0,
   "why_not_higher": "The rule sorts lines by a handful of fixed comment syntaxes. Hand-picked fixtures (doc block, //, ///, blank, :1, code) cover it. A generator over source text would mostly re-encode the same regex."
  },
  {
   "criterion": "AC2",
   "level": 0,
   "why_not_higher": "Whether a name is declared, and whether the line mentions it, are regex facts about small fixture files. Generating random TS/Swift declarations would test the generator more than the checker."
  },
  {
   "criterion": "AC3",
   "level": 0,
   "why_not_higher": "The CLI's exit status on one fixture is a single thing to observe. There is no state space to model."
  },
  {
   "criterion": "AC4",
   "level": 0,
   "why_not_higher": "One fixed input: the repo's own map at the branch head. An example run is the whole check."
  },
  {
   "criterion": "AC5",
   "level": 0,
   "why_not_higher": "A regression guard on two known cases (past the end, valid code line). No input space beyond them is worth a property."
  }
 ]
}
```
