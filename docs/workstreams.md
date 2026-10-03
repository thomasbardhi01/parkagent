# V1 workstreams

V1 is three workstreams run by two founders in parallel. What V1 includes
and why is in
[decisions/2026-09-29-v1-scope.md](decisions/2026-09-29-v1-scope.md). The
research each PR comes from is in `docs/research/`. Every PR below is one
GitHub issue under the **V1** milestone on project 3. Each issue holds the
full Claude Code prompt from its report, this stream's boundaries, and the
decision record's changes to that prompt. Paste the issue into a session
started in that PR's worktree.

| Stream | Owner | What it delivers | Label | PRs |
|---|---|---|---|---|
| **WS-1** Assistant brain and plan UX | Tom (@thomasbardhi01) | The assistant holds the request as server-owned state, says no when nothing fits, resolves places with a confidence score, and ranks one list that the map, the cards, and the directions handoff share. | `ws-1` | 7 |
| **WS-2** Boston data and garage inventory | Nate (@nbtolva-dot) | Garage and lot footprints, garage sources behind modes and a daily budget, Boston zones from the City's CDS feed with a coverage gate, and garage price freshness. | `ws-2` | 4 |
| **WS-3** Park now: detection, place outcomes, session lifecycle | Tom (@thomasbardhi01) | The phone classifies where it parked, `/parked` answers garage and no-pay outcomes, and a street session runs from walk-away to return with the tap-to-confirm and the YOLO beta. | `ws-3` | 3 |

The V1 milestone also holds #163, a flaky `AssistantUITests` test in
WS-1's files. It's upkeep, not one of the PRs below.

## WS-1: assistant brain and plan UX (Tom)

Order matters: each PR builds on the one before it.

| # | Issue | Branch | Source | Depends on |
|---|---|---|---|---|
| 1 | #167 | `feat/assistant-request-state` | assistant spec PR 1 | — |
| 2 | #168 | `feat/assistant-find-options-and-say-no` | assistant spec PR 2 | #167 |
| 3 | #169 | `feat/place-resolution-confidence` | place resolution PR 1 | #168 (merge order only) |
| 4 | #170 | `feat/assistant-intent-router-and-cards` | assistant spec PR 3 | #168 |
| 5 | #171 | `feat/plan-ranking-map-handoff` | place resolution PR 4 | #169, #170, **WS-2 #175** (curb lines also want WS-2 #176) |
| 6 | #172 | `feat/assistant-budget-and-preferences` | assistant spec PR 4 | #170, #171 |
| 7 | #173 | `feat/assistant-golden-evals-and-gates` | assistant spec PR 5 | #172 |

**Owns** (edits freely):
- `server/src/services/assistant/**`, including the new `requestState.ts`,
  `placeScore.ts`, and `ranking.ts`
- `server/src/routes/assistant.ts`, and a new `server/src/routes/preferences.ts`
  (`/me/preferences`, `/me/ranking-prefs`)
- `server/src/jobs/itineraryTick.ts`, `server/src/jobs/conversationRetentionTick.ts`
- `server/src/scripts/verify-places.ts`, and a new `server/src/scripts/assistant-metrics.ts`
- `server/src/services/explanations.ts`
- `server/test/assistant*.test.ts`, and the new `server/test/requestState*.test.ts`,
  `placeScore.test.ts`, `ranking.test.ts`, `server/test/golden/**`, and
  `server/test/golden.test.ts`
- `server/fr/40-assistant.fr.test.ts`, and a new `server/fr/assistantGolden.fr.test.ts`
- `server/fr/report.mjs` (the pass^k column in PR 7)
- `ios/ParkAgent/Views/Assistant/**`
- `ios/ParkAgent/State/AssistantModel.swift`, `ConversationHistoryModel.swift`
- `ios/ParkAgent/Networking/MockAssistant.swift`, `MockConversations.swift`
- `ios/ParkAgent/Support/DictationTranscript.swift`, `SpeechRecognizer.swift`,
  `AskParkAgentIntent.swift`, and a new `NavigationHandoff.swift`
- `ios/ParkAgentTests/` files for the above (`AssistantPlanPresentationTests`,
  `ConversationWireTests`, `PlanSelectionTests`, `DictationTranscriptTests`,
  `SpeechRecognizerTests`, `ItineraryOrderTests`, and new ones);
  `ios/ParkAgentUITests/AssistantUITests.swift`, `SpeechUITests.swift`
- `docs/apple-maps-setup.md`, `docs/assistant-verification.md`, and a new
  `docs/assistant-evals.md`

**Never edits:** `server/src/services/garage/**`, `data/**`,
`server/src/routes/zones.ts`, `server/src/services/zoneLookup.ts`, anything
in WS-3's list below, `executor/**`, wallet and Stripe code
(`services/wallet/**`, `services/link/**`, `issuing.ts`,
`routes/wallet.ts`, `routes/webhooksStripe.ts`), and auth.

## WS-2: Boston data and garage inventory (Nate)

| # | Issue | Branch | Source | Depends on |
|---|---|---|---|---|
| 1 | #174 | `feat/garage-footprints` | park now PR 1 | — |
| 2 | #175 | `feat/garage-provider-capabilities` | place resolution PR 3 | — |
| 3 | #176 | `feat/boston-cds-ingest-and-matcher-v2` | place resolution PR 2 | — (starts with a probe that may stop it) |
| 4 | #177 | `feat/garage-price-freshness` | decision 7 | #175 |

**Owns:**
- `data/**`
- `server/src/services/garage/**`, including the new `registry.ts`,
  `parkwhizShared.ts`, `parkwhizPartner.ts`, and `spotheroPartner.ts`
- `server/src/services/zoneLookup.ts`, `zoneTermsObserved.ts`,
  `zoneNumberReverts.ts`, and the new `zoneNumber.ts` and `garageLookup.ts`
- `server/src/routes/zones.ts`, and the new `server/src/routes/garages.ts`
  and `server/src/routes/adminGarages.ts`
- the new `server/src/jobs/garagePriceRefreshTick.ts` and `cdsRefreshTick.ts`
- `server/src/scripts/load-zones.ts`, `load-zone-numbers.ts`,
  `verify-garages.ts`, and the new `load-garages.ts`
- `server/test/zone*.test.ts`, `server/test/garage*.test.ts`,
  `server/test/parkwhizAdapter.test.ts`, and the new `server/test/loadZones.test.ts`
  and `server/test/garageProviderContract.ts`
- `server/fr/20-parked-boston.fr.test.ts`, and a new `server/fr/80-garages.fr.test.ts`
- `docs/research/2-place-resolution-and-data.md` (as its maintainer)

**Never edits:** `server/src/services/assistant/**` (WS-1 consumes the
garage seam there), `ios/**` (no WS-2 PR has an iOS change),
`server/src/routes/parked.ts`, `session.ts`, `server/src/jobs/extendTick.ts`,
`executor/**`, wallet, Stripe, and auth.

## WS-3: park now: detection, place outcomes, session lifecycle (Tom)

| # | Issue | Branch | Source | Depends on |
|---|---|---|---|---|
| 1 | #178 | `feat/place-classifier` | park now PR 2 | **WS-2 #174** before wiring `/garages/near` |
| 2 | #179 | `feat/parked-place-outcomes` | park now PR 3 | #178, **WS-2 #174** |
| 3 | #180 | `feat/session-lifecycle-yolo-beta` | decisions 1–4, 9 | #179 |

**Owns:**
- `ios/ParkAgent/Detection/**`
- `ios/ParkAgent/State/ParkedNotice.swift`, `ParkOutbox.swift`,
  `LocationReporter.swift`, `PermissionsManager.swift`, `AppServices.swift`,
  `PushManager.swift`, `LimitsDraft.swift`, and a new `PlaceMemory.swift`
- `ios/ParkAgent/Views/Home/**`, `Views/Session/**`,
  `Views/Account/SpendingLimitsView.swift`, a new `Views/Account/YoloModeView.swift`
  (the YOLO consent and switch), `Views/Settings/**`; and `Views/Onboarding/` and
  `Views/Account/` **only** for the YOLO toggle, the consent screen, and the
  session-lifecycle settings (default stay, daily cap). WS-1 keeps everything
  under `Views/Assistant/`.
  (Diagnostics and the detector self-test)
- `ios/ParkAgent/Networking/MockDetectorProbe.swift`
- `ios/Fixtures/**` (the GPX route and `Traces/`)
- `ios/ParkAgentTests/` files for the above (`ParkFusionEngineTests`,
  `ParkDetectorTests`, `FixGateTests`, `SignalTraceTests`,
  `DetectionCapabilitiesTests`, `DetectionPersistenceTests`,
  `LocationReporterTests`, `ParkedNoticeTests`, `ParkOutboxTests`,
  `LimitsDraftTests`, `CurbHitTestTests`, and a new `PlaceClassifierTests`);
  `ios/ParkAgentUITests/DetectorUITests.swift`, `ParkFlowUITests.swift`,
  `SessionUITests.swift`
- `server/src/routes/parked.ts`, `session.ts`, `location.ts`, `limits.ts`,
  and the new `server/src/routes/beta.ts` and `server/src/routes/adminBeta.ts`
- `server/src/services/sessions.ts`, `pendingSession.ts`, `limits.ts`,
  `quote.ts`, and the new `placeClassification.ts`
- `server/src/jobs/extendTick.ts`
- `server/test/parked*.test.ts`, `session*.test.ts`, `extendTick.test.ts`,
  `walkAwayRoute.test.ts`, `limits*.test.ts`, `bostonSession.test.ts`
- `server/fr/10-parked-nyc.fr.test.ts`, `30-session-providers.fr.test.ts`,
  `35-limits.fr.test.ts`, and a new `server/fr/90-park-now.fr.test.ts`
- `docs/field-test-plan.md`, `docs/field-test-checklist.md`, `docs/device-smoke-test.md`

**Never edits:** `server/src/services/assistant/**`, `ios/ParkAgent/Views/Assistant/**`,
`server/src/services/garage/**`, `data/**`, `server/src/routes/zones.ts`,
`server/src/services/garageLookup.ts` (WS-2's; WS-3 imports it),
`executor/**`, wallet, Stripe, and auth.

## Shared files

Some files every stream has to touch. Each PR edits them **additively**,
changes only its own entries, and rebases right after the other founder
merges.

| File | Rule |
|---|---|
| `server/prisma/schema.prisma`, `server/prisma/migrations/**` | New models and columns only; no destructive migration. If both founders add a migration, the second to merge regenerates theirs after rebasing so the timestamps stay ordered. |
| `server/API.md` | Edit only your own sections. |
| `docs/functional-requirements.md` | Edit only your FR rows and sections. The new FR numbers are reserved per PR below. |
| `server/src/env.ts`, `scripts/boot-check.sh`, `.env.example` | A new optional variable gets its FEATURES entry, a line in both boot-check lists, and a broken value (CLAUDE.md). |
| `server/src/index.ts`, `server/src/app.ts` | Wiring lines for your own services and routes only. |
| `policy.json`, `server/src/services/policy.ts`, `server/src/routes/policy.ts` | New fields only, with validation and a default; name the owning stream in the PR. |
| `server/src/routes/admin.ts` | A new `/admin/summary` section only; new admin routes go in your own file. |
| `server/src/routes/me.ts` | No new routes; use your own route file. |
| `ios/ParkAgent/Views/Account/AccountSheetView.swift` | One new row that links to your own view. |
| `.github/workflows/nightly-fr.yml` | Only WS-1's #173 (its per-file `FR_ASSISTANT_MAX_CALLS` and the pass^3 issue rule), read by the other founder. |
| `.github/workflows/ci.yml` | Only WS-2's #176 (a new advisory `data` job), read by the other founder. Making a job required is the repo owner's call. |
| `ios/project.yml`, `ios/Tools/release-denylist.txt` | Your own entries only; run `xcodegen generate` after pulling. |
| `ios/ParkAgent/Networking/APIClient.swift`, `LiveAPI.swift`, `MockAPI.swift`, `ios/ParkAgent/Models/**`, `ios/ParkAgentTests/LiveAPIRequestTests.swift` | New endpoints and types only. |
| `server/test/helpers.ts` (the fake DB) | New tables and helpers only. |
| `ios/ParkAgent/State/AppModel.swift`, `server/src/db.ts`, `ios/ParkAgent/Support/LaunchOverrides.swift`, `ios/ParkAgentTests/HangingAPI.swift` | Small additive edits only; announce in the PR. |
| `server/fr/pool.mjs`, `server/fr/client.ts` | A new label for a new FR file; new fixtures only. |
| `CLAUDE.md`, `README.md` | Only when your PR changes what they describe. |

Nothing in V1 edits `executor/**`. A PR that needs to is out of scope:
file an issue and talk first.

## Cross-stream dependencies

| Blocked | Needs merged first | Why |
|---|---|---|
| WS-3 #178: wiring `FootprintIndex` to the server | WS-2 #174 | `GET /garages/near` is WS-2's. The classifier and its tests can be written against a fixture index before then. |
| WS-3 #179 | WS-2 #174 | `/parked` classifies with WS-2's `garageLookup.classifyByFootprint`. |
| WS-1 #171 | WS-2 #175 | WS-1 consumes WS-2's provider capabilities (`capabilities`, `quote`/`book`, `provenance.fetchedAt`, `entrance`, `availability`) after they merge. |
| WS-1 #171: curb lines on the mini-map | WS-2 #176 (`/zones/near?state_at=`) | Optional. If it hasn't merged, PR 5 ships without curb lines and files the follow-up. |
| WS-2 #177 | WS-2 #175 | Freshness reads `provenance.fetchedAt` and the read budget. |
| WS-3 #180: "Walk to …" on the session card | WS-1 #171 (`NavigationHandoff.swift`) | Optional. If it hasn't merged, the button is a follow-up. |

## New FRs, reserved per PR

These are pending rows in `docs/functional-requirements.md`. Each PR
fills in its row and adds the live test where one is listed.

| FR | PR | What |
|---|---|---|
| FR-42 | WS-1 #167 | The request is server-owned, versioned state |
| FR-43 | WS-1 #168 | Options come from the latest search, and the assistant says no |
| FR-44 | WS-1 #169 | Place resolution with a confidence score and walking times |
| FR-45 | WS-1 #170 | Three intents, request chips, near-miss cards |
| FR-46 | WS-1 #171 | One ranking; map, list, and directions share it; garages open in-app |
| FR-47 | WS-1 #172 | Budget-aware search and saved preferences |
| FR-48 | WS-1 #173 | Golden conversations graded on end state, pass^3 nightly |
| FR-49 | WS-2 #174 | Garage and lot footprints |
| FR-50 | WS-2 #175 | Garage sources run under modes, a budget, and declared capabilities |
| FR-51 | WS-2 #176 | Boston zones from the City's CDS feed; restrictions; a coverage gate |
| FR-52 | WS-2 #177 | Garage price freshness |
| FR-53 | WS-3 #178 | The phone classifies the place it parked |
| FR-54 | WS-3 #179 | `/parked` answers garage and no-pay outcomes |
| FR-55 | WS-3 #180 | A street session runs from walk-away to return |
| FR-56 | WS-3 #180 | YOLO beta mode |
| FR-57–59 | V2 #181, #182, #183 | Ticket capture, garage stays, the stay budget |

## Working agreement

1. **One PR per issue.** The branch is the issue's branch. The PR body
   says `Closes #<issue>`.
2. **The author merges their own PR** after CI is green and after a
   self-review. **Exception:** a PR that touches money or provider access
   — anything under a DRY_RUN check, caps and limits, holds, Issuing, Link,
   the Stripe webhook, the executor, provider linking, or the YOLO beta —
   is read by the other founder before it merges.
3. **One merge in flight at a time, across both people.** Announce it in
   chat before merging ("merging #N") and again when its deploy and
   nightly are green.
4. **After every merge:** `waitdeploy <N> && nightly` (or `shipit <N>`,
   which merges first). Don't merge the next PR until the nightly is green.
5. **Rebase after the other person merges**, before pushing again.
6. **A Claude Code session works in its own worktree per PR**
   (`.claude/worktrees/<branch>`, gitignored) and never edits a file
   outside its stream's list. A shared file is edited only as the table
   above allows. Remove the worktree once the PR merges.
7. **A session never merges.** It pushes, opens the PR, and says ready
   when CI is green. The founder merges.
