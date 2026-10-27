<!-- provenance: claude -->
# pa-0002 plan (amended)

## Notes addressed
- **Owner's amendment: "Give the checker task a fresh ID": adopted.** The checker task is now `pa-0002-w3`. `pa-0002-w1` and `pa-0002-w2` are both in `existing_task_ids`, so neither is reused. The spec text doesn't change (see spec_changelog.md).
- **The doc task is already done: no new doc worker.** `pa-0002-w1` (re-anchor the 14 references) merged to main as #316 (`fcacdce`), and the base `287fb86` includes it. So this plan has only the checker worker. It needs no `depends_on`: w1 is flagged "open PR is for different work than the plan names", and its change is already in the base, so naming it would add nothing. AC4 and AC6 run against the base, which carries the doc fix. If the checker flags a reference on the base that isn't in spec.md's list, w3 narrows the rule, as spec.md Risks says. It may not edit the doc (see below).
- **#272's latest comment is the source of record: adopted, with the open question kept.** I can't read the issue from here (no GitHub calls). The "six vs 14" question is still in spec.md Risks, unchanged.
- **Two workers, two draft PRs with worker_report.json: adopted, already half done.** The doc worker's PR merged (#316). The re-planned checker worker `pa-0002-w3` opens the second draft PR. vigild and the worker App open PRs, not the coord.
- **Suggested split (checker plus test / doc lines): adopted.** It was kept as two tasks. The doc half is merged, and the checker half is re-planned here under a fresh id.
- **test_cmd must run the new test offline: adopted via server/test/.** The test is `server/test/checkFeatureMap.test.ts` (vitest, temp-dir fixtures created world-readable, no network), so `pnpm -C server test` runs it. spec.md says explicitly that it does not live under `scripts/`. I didn't use `node --test scripts/ && …`, because the gate refuses `&`.

## Workers
```json
{
 "workers": [
  {
   "task_id": "pa-0002-w3",
   "goal": "Add the comment rule, the name rule and the `--root <dir>` CLI from spec.md Interfaces to scripts/check-feature-map.mjs, with a vitest suite in server/test/checkFeatureMap.test.ts covering AC1-AC6.",
   "why": "Today the checker only checks that a line number is within the file's length. A reference that has drifted onto a doc comment or into a different function still passes CI. Re-planned under a fresh id at the owner's request, after the earlier checker build failed AC1-AC3 at acceptance.",
   "value": 3,
   "risk": 2,
   "size": "S",
   "test_cmd": "pnpm -C server test",
   "must_fail_first": true,
   "verify_level": 0,
   "done_when": "The new tests fail against the current checker, then pass. Every test builds world-readable temp-dir fixtures (dirs 0755, files 0644) and passes the root explicitly. checkFeatureMap(root) returns the pinned problem strings for a reference at a comment or blank line and for a declared name sitting on another line. It returns nothing extra for :1, for a code line, or for a name the file doesn't declare. A past-the-end reference yields exactly the one existing 'has N lines' problem. `node scripts/check-feature-map.mjs --root <stale fixture>` exits 1 and names the reference. With a clean fixture it exits 0. An unknown argument, or a bare --root, exits 2 with the usage line on stderr. checkFeatureMap(<repo root>) returns [] on the branch. With no arguments the script exits 0 on the branch. scripts/check-feature-map.test.mjs passes unchanged, and pnpm -C server test is green.",
   "files_in_scope": [
    "scripts/check-feature-map.mjs",
    "server/test/checkFeatureMap.test.ts"
   ],
   "out_of_scope": [
    "docs/feature-map.md",
    "scripts/check-feature-map.test.mjs",
    ".github/workflows/ci.yml",
    "docs/architecture.md",
    "docs/feature-map.mmd",
    "server/vitest.config.ts",
    "server/package.json",
    "server/src"
   ],
   "depends_on": [],
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
   "why_not_higher": "The CLI's exit status on a stale fixture and on a clean one are two things to observe. There is no state space to model."
  },
  {
   "criterion": "AC4",
   "level": 0,
   "why_not_higher": "One fixed input: the repo's own map at the branch head, passed as an explicit root. An example run is the whole check."
  },
  {
   "criterion": "AC5",
   "level": 0,
   "why_not_higher": "A regression guard on two known cases (past the end, valid code line). No input space beyond them is worth a property."
  },
  {
   "criterion": "AC6",
   "level": 0,
   "why_not_higher": "The no-argument default is one invocation against one fixed tree (the script's own repo). An example run is the whole check."
  }
 ]
}
```
