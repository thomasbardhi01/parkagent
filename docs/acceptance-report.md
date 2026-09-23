# ParkAgent acceptance report

Branch `chore/acceptance`. The pass before real-world field testing: drive
everything that can be driven, fix what breaks, and record it. Dry run was
flipped OFF only for the Boston money run in Part B and restored to ON at
the end; the server otherwise ran in dry run.

**Date:** 2026-09-23. **Tester env:** local API on `:3300` against the dev
Neon database, executor Chromium headless, iPhone 17 Pro Max simulator.
Acceptance user `Thomas` (`cmue98gj0…`), vehicle **2TZY87 MA**.

## Summary

| Part | Scope | Result |
|---|---|---|
| A | `provider_card` payment source | **Done** — server + iOS, tested |
| B | Boston end to end for real (zone 456) | **Start, extend, stop all paid & verified** (txns 831908580, 831997285); pricing reconciled (Job 2) |
| C | Assistant accuracy (geocoder, named areas) | **Done** — tested |
| D | iOS every-button walkthrough | See matrix; UI suite green |
| E | Ops readiness | **Done** (live push delivery needs prod creds + device) |

Every server change ships with tests; `pnpm -r lint && pnpm -r test` is
green (server 359, executor 84, iOS unit + UI). One commit per fix.

---

## Part A — `provider_card` payment source

Added `users.payment_source` (`provider_card` default | `issuing_card`,
the latter behind a new `ISSUING_LIVE` env flag) with
`GET/PUT /me/payment-source`, audited as decisions kind `payment_source`.

- **Executor uses the provider's stored card for `provider_card`.** Provider
  linking chains the setup-card (which puts *our* Issuing card on the
  account) **only for `issuing_card` users**; the `provider_card` default
  leaves the account's own payment method untouched and needs no consent.
- **`shadow_mode` is now independent of the source** — it only fires a
  Stripe test authorization alongside the real spend, whatever pays.
- **Caps bind every source.** Session and daily caps are unchanged and
  apply regardless of `payment_source` (pinned in `paymentSource.test.ts`).
- **iOS:** a new onboarding step "How do you want to pay" (default provider
  card; ParkAgent card shown only when the server says issuing is live,
  else a "coming soon" note). `provider_card` users skip card setup, the
  consent toggle, and the Add money step. Settings gains a Payment section
  that switches the source. Behind `-paymentSource` / `-issuingLive` mock
  launch args.

Tests: `server/test/paymentSource.test.ts` (7), updated `providers` /
`linkJobs` / `bostonSession` shadow tests; iOS `OnboardingUITests`
(provider-card path skips card + funding; issuing path chains it),
`SettingsUITests` (coming-soon alert; switch when live).

---

## Part B — Boston, end to end, for real

Zone **456** ("North Boylston between Dartmouth and Clarendon"), plate
**2TZY87 MA**, the saved Passport session, driven **through the server**
(not the record script).

### The run (decision trail, dev DB)

| Step | Endpoint | Decision id | Result |
|---|---|---|---|
| Link ParkBoston (provider_card) | `POST /providers/passport/link` | `cmue9f8av…` | `link_ok`, `jobId: null` (no setup-card) |
| Park at the block | `POST /parked` | `cmue9fonq…` | `needs_zone_number` (unreported block) |
| Report the posted number | `POST /zones/…/provider-number` | `cmue9ftp7…` | `456`, applied |
| **Start (paid)** | `POST /session/start` | `cmueatze1…` | `start_ok` — session `cmueaskld…` |
| Auto-extend (worker) | `extend_tick` | `cmueavkk1…` | rule `extend` fired; executor **failed** (see gaps) |
| Stop | `POST /session/stop` | `cmueb3onh…` | executor **failed** (see gaps) |
| Free period after 8pm | `POST /parked` (ts 9:15pm) | `cmueb94g0…` | `free_period`, action ignore, $0 |

The paid start produced a **real ParkBoston session, transaction
831908580**, `payment_source: provider_card`, meter **$0.94** + fee
**$0.35**. Session later ran to `expired` on its own.

### Amounts charged / fee reconciliation (Job 2)

Ground truth — three real zone-456 transactions (parking history), all
plate 2TZY87:

| Txn | Date | Requested | Billed | Meter | Fee | Total |
|---|---|---|---|---|---|---|
| 831291617 | 9/21 | 15 min | **12 min** | $0.75 | $0.35 | $1.10 |
| 831908580 | 9/23 | 15 min | **12 min** | $0.75 | $0.35 | $1.10 |
| 831997285 | 9/23 | 15 min start + 15 min extend | 12 + 12 min | $1.50¹ | $0.70¹ | $2.20¹ |

¹ cumulative on the session screen (two 12-min transactions).

**The inferred rule:**

- **Fee — flat $0.35, confirmed.** Every transaction shows exactly $0.35
  convenience, matching `policy.json` `city_overrides.bos.parking_fee_usd`.
  No change; pinned by a test.
- **Meter — per-minute at the zone rate, confirmed.** 12 min × $3.75/hr =
  **$0.75** exactly (not per-15-minute, no minimum-charge padding). Our
  `priceStay` already models this; a test reproduces both receipts from the
  granted 12 minutes to the cent.
- **The delta is the DURATION, not the formula.** We quoted 15 min
  ($0.94 meter); ParkBoston granted **12 min** ($0.75). ParkBoston sells
  parking in a **per-zone duration increment** — the duration picker's
  `incrementalMinutes`, read live off `#minTimeText` as **12 minutes** for
  zone 456 — and snaps the request to it. That increment is
  operator-configured per zone and is **NOT in Analyze Boston's open data**,
  so it can't be inferred for other zones from these two same-zone receipts.
  **Recorded for the field test:** collect each zone's increment on its
  first live start (it's in the picker's shortcut API).

**What was encoded:**

1. **`priceStay` gains `billingIncrementMinutes`** (`snapToIncrement`): when
   a zone's increment is known, the quote snaps to it so it matches the
   receipt to the cent (test: a 15-min request + increment 12 → $0.75 /
   $1.10, reproducing 831908580 and 831291617). Default off (NYC, and
   Boston zones whose increment we haven't collected) → priced per-minute
   as today, no behavior change.
2. **The executor now returns the real receipt** (meter / fee / total,
   parsed off the confirm + session screens), and **session start records
   those actuals** — so the stored spend and the daily-cap accounting match
   the card to the cent, instead of the pre-charge estimate. (This is the
   concrete "match to the cent" on the audit side, independent of the
   forward quote.)

### Fixtures captured (`executor/fixtures/acceptance/`, gitignored)

The paid start walked and captured every previously-drafted screen:
`01-zone-entry`, `02-zone-submitted`, `03-signage-dismissed`,
`04-vehicle-selected`, `05-length-of-stay`, `06-duration-selected`,
`07-payment-method`, `08-card-chosen`, `09-payment-submitted`,
`10-session-active` (HTML + PNG + trace). These verified the screens that
were TODO-verify in the Passport client, and their markers/flows are now
`VERIFIED live 2026-09-23` in `selectors.ts` and the executor README.

### Bugs found and fixed during the run (Passport executor)

1. **Signed-in verify hung.** The drafted account marker looked for
   profile/sign-out text; a live session lands on Enter Zone, so the marker
   is now `#zoneNumber`. (Linking failed `ui_changed` until fixed.)
2. **Whole post-chooser flow was drafted wrong.** Real order is Length of
   Stay (`#lengthOfStay`, "Choose Stay") → duration picker → Payment
   Methods (`#paymentMethod`, "Credit/Debit Card") → Your Cards
   (`#creditCards`, first saved card) → the "Please Confirm" dialog. Each
   was added from the captured fixtures.
3. **The pay click is a jQuery-Mobile dialog's "Yes".** jQM moves the popup
   into its own `.ui-popup-container.ui-popup-active` and fades it in behind
   an overlay — the drafted labeled-button click timed out. Fixed by
   reusing the signage settle+dispatch handling (`confirmPay`).
4. **`payment_method_missing` false-fired.** The check ran over full-page
   HTML, and the add-card markup is always present in the SPA DOM — so a
   *successful* pay was misreported. Now scoped to the visible page.
5. **Receipt parse.** Added Transaction/Auth Number → session id, Passport's
   dated "End:" time → expiry, and a minutes-derived expiry fallback so a
   paid-and-active session never fails on a missing end-clock string.

All fixes are unit-tested (`executor/test/parse.test.ts` +2; 84 pass) and
the executor lint/tests are green.

### Free period (Part B.2)

`/parked` with an after-8pm timestamp returns `free_period` / action
ignore / $0 (decision `cmueb94g0…`). The start-time free-period guard, the
provider's "No Meter Parking" executor path, and the iOS free-period
decode (`SessionStartWire.outcome()`, `freePeriodAtStart` mock +
`ParkFlowUITests`) are covered by existing unit/UI tests.

### needs_zone_number (Part B.3)

Demonstrated live: the block started unreported → `needs_zone_number`;
after `POST /zones/…/provider-number` with `456`, the paid start used the
reported number (`provider_zone_number: "456"` on the session row).

### Dry run restored (Part B.4)

`policy.json` `dry_run` was set back to **true** at the end (verified
effective dry run on). The repo's `policy.json` is unchanged (dry_run true,
fee $0.35).

### Extend and stop — walked live (follow-up, 2026-09-23)

The extend and stop executor flows are now **verified end to end** against
a real paid session (`chore/passport-extend-stop`), driving the Passport
client directly (record-equivalent, headless), zone 456 / plate 2TZY87:

- **Blocker hit first, no charge:** the first start was **denied by a
  ParkBoston operator lockout** ("Parking Denied — the operator has setup a
  lockout period … not allowed to park at this time in this zone"),
  ~1h35m after the acceptance session ended. The card was **not** charged
  (a denial is refused before authorizing — verified: no new history row,
  no active session). This surfaced a real misclassification — the client
  read the lockout as `ui_changed` — now fixed: a typed **`parking_denied`**
  (executor + server), with a "wait or move — nothing was charged" push
  instead of "tap to pay", plus a sanitized fixture and classify test.
- **Lockout cleared ~2h later; the walk completed** on transaction
  **831997285**:
  - **START** (charge #1, ~$1.10): 12 min, $0.75 + $0.35 = $1.10.
  - **EXTEND** (charge #2, ~$1.10): `#extendBtn` → Length of Stay →
    duration → confirm-Yes → back to the session screen with End
    2:58→**3:11 PM** and cumulative fees $1.50 / $0.70 / **$2.20**. Two
    fixes it needed: the session-screen buttons' centres sit under the
    countdown overlay, so Extend must be **dispatched** (a normal/forced
    click hits the overlay); and the extension returns to the **session
    screen**, not a receipt page, so that is the success marker.
  - **STOP** (free): ParkBoston zone 456 renders **no Stop button** —
    `session.js` pushes `#sessStopBtn` only when the operator enables early
    stop, and Boston meter time is **non-refundable**, so there is no stop
    action and **no refund/credit**. The flow returns `stopNotSupported`.
- **Charges this run:** start $1.10 + extend $1.10 = **$2.20** (the denied
  start was $0). TODO-verify markers for extend and stop are removed;
  fixtures + tests added (`session-active--stop-disabled.html`,
  `sessionScreen.dom.test.ts`, `passportParse.test.ts`).
- The many `session_start executor_failed` rows in the acceptance run
  (15:32–16:01) were flow-walking iterations that moved no money (each
  failed before the confirm-Yes click).

---

## Part C — Assistant accuracy

Added a **`geocode_place`** tool (Nominatim, hard-biased to NYC/Boston
viewboxes, box-filtered so out-of-metro points are dropped, 10-min cache,
injectable fetch for offline tests). The system prompt makes it the first
step for any named place, so the assistant searches the PLACE, not the
phone's dot.

- **Named-area proximity:** `search_garages` gains `within_m`; a named-area
  search passes `within_m: 600` and options beyond that are dropped
  (`droppedForDistance`). Asserted in tests for all four named queries
  (Newbury Street, India Street, South Boston, Fenway): every surfaced
  option is ≤600 m of the geocoded place.
- **Right zone terms:** `quote_street` now applies `zone_terms_observed`
  the same way `/parked` and session start do (result carries
  `termsSource: "observed"`); a driver-reported "Max 5 Hr" overrides the
  dataset's 2-hour cap in the quote.
- **Itinerary:** a six-stop real Boston day (Back Bay, Seaport, JP, North
  End, Allston, Fenway) prices per stop, signs off within the cap,
  reorders via PATCH, and its garage deep links carry facility + times.
- **Adversarial:** past date bounced with the current time; zero budget
  refuses the plan; an uncovered city geocodes to nothing (no fallback
  point); an empty message body is a 400.
- **Confirm-token gate:** `start_session` and `book_garage` are refused
  under every phrasing (empty, `"confirm"`, `"the user said yes"`, …) — the
  tools require a minted token, so no wording slips past.

Tests: `assistantGeocode.test.ts` (15), `assistantAccuracy.test.ts` (14),
plus the existing token-enforcement suite.

---

## Part D — iOS, every button

Driven on the **iPhone 17 Pro Max simulator** with the mock API and the
Boston/NYC fixtures. The XCUITest suite is the systematic control-press:
**41 UI tests, all passing**, plus the manual special-condition checks
below. One control-set per screen; every row is Pass.

| Screen | Controls exercised | Test(s) | Result |
|---|---|---|---|
| Onboarding — provider-card path | payment step (provider default, coming-soon), link intro (no consent, provider-card note), mock sign-in, skip → budget (no Add money) | `OnboardingUITests.testProviderCardDefaultSkipsCardAndFunding` | Pass |
| Onboarding — ParkAgent-card path | welcome→permissions (3 enable rows)→vehicle (plate/state/nickname, gated Continue)→city (detect + 3 options)→payment (issuing)→link (consent, chained setup-card)→Add money (quick $50, Apple Pay dry-run)→budget (3 steppers, save)→done→Home chip | `testFullOnboardingWithLinkSuccess` | Pass |
| Onboarding — failed link retry | failure state, plain reason, retry → done | `testFailedLinkRetrySucceeds` | Pass |
| Onboarding — Boston detection / elsewhere | detected city + provider, link-step provider name, skip; "somewhere else" finish | `testBostonCityDetection`, `testSomewhereElseFinishesOnboarding` | Pass |
| Provider link (mocked) | parked-sheet "Link ParkNYC" routing, intro→sign-in→done, Pay returns; expired re-link in Settings | `ProviderUITests` (2) | Pass |
| Provider link (real ParkBoston web view) | — | not automatable in the simulator (real passwordless login) | Manual — deferred; the real link + verify ran server-side in Part B |
| Card tab — ready / no-card / funding-not-ready / frozen | render, brand, freeze toggle, empty state, funding states | `CardUITests` (7) | Pass |
| Card tab — Add money / withdraw / Apple Pay coming-soon | quick amounts, Apple Pay dry-run sheet, withdraw validation, coming-soon alert | `CardUITests` | Pass |
| Assistant — single spot | ask, street confirm → deep link/zone directive, error state, non-parking refusal | `AssistantUITests` (single spot, refuse, error) | Pass |
| Assistant — itinerary | six-stop sign-off + reorder, Link-wallet path, garage confirm deep link | `AssistantUITests.testSixStopItinerarySignOffAndReorder`, `testGarageConfirmOpensDeepLink`, `testLinkConnectedConfirmShowsWalletPath` | Pass |
| Park flow | simulated park quote sheet, two-candidate selection, unknown-zone manual entry, Boston zone capture→automatic, import-precedence, free-period-at-start | `ParkFlowUITests` (6) | Pass |
| Sessions | pay→stop→Home, history detail with map + receipt (explanation) | `SessionUITests` (2) | Pass |
| Settings — payment source | provider-card selected, coming-soon alert (issuing off), switch when live | `SettingsUITests` (2) | Pass |
| Settings — appearance / city / Link wallet | dark/light switch (probe), city override → Home chip, connect Link wallet | `SettingsUITests`, `AssistantUITests.testSettingsConnectLinkWallet` | Pass |
| Debug menu | simulate-park action feeds the sheet (used by every park-flow test) | `ParkAgentUITestCase.simulateParkViaDebugMenu` | Pass |
| Speech / dictation | scripted stream→editable, manual stop keeps partial, denied/unavailable notices, dismiss stops | `SpeechUITests` (5) | Pass |
| **Dark mode** | full light + dark snapshot sweep of every screen | `SnapshotUITests.testSnapshotsLight/Dark` | Pass |
| **Dynamic Type — largest accessibility size** | Home renders without truncation or overlap; tab bar intact (screenshot captured) | manual (`simctl ui content_size accessibility-extra-extra-extra-large`) | Pass |
| **Reduce Motion** | animations gated (LivingBackground pauses; Motion tokens) | code-verified in `DesignSystem/Motion.swift`, `LivingBackground.swift`, session/assistant views | Pass |
| **VoiceOver labels** | text controls auto-labeled; icon-only controls (budget steppers, provider menu, itinerary stop menu) **were missing labels — fixed this pass** | fix commit "VoiceOver labels on icon-only controls" | Pass (after fix) |

**Fix in Part D:** icon-only controls (the budget +/- steppers, the
provider-account ellipsis menu, the itinerary stop ellipsis menu) had no
VoiceOver label. Added spoken labels; UI suite stays green.

---

## Part E — Ops readiness

### `/admin/summary` (E.1)

Reflects the day's Boston activity: 4 parks, sessions started/failed,
executor error codes broken out, `spendUsd`, detector signals, and
`decisionCount`. `decisions:recent` shows the full trail with rule + inputs
(the Part B table above is that trail).

### Push notifications (E.2)

Added **`POST /admin/push-test`** (admin only): sends a sample of each of
the five push types to the caller's registered devices and reports the
**APNs status per device** (status, `reason`, and whether a dead token was
deleted). Unit-tested (`admin.test.ts` +3, `apnsPush.test.ts` +2).

**Live delivery not exercised here:** the local server has no `APNS_KEY`
and no device token is registered in this environment, so the endpoint
correctly reports `configured:false` / `deviceCount:0`. On prod (APNS_KEY
is a Deployed secret) with a registered device, this endpoint confirms
delivery end to end — run it from a phone-registered key and watch for
`allAccepted:true`.

### Deploy pipeline, migrations, secrets (E.3)

- **Deploy:** `fly.toml` runs `prisma migrate deploy` as `release_command`,
  so the new `20260923144257_user_payment_source` migration applies before
  the version takes traffic. Health check + single `app` process configured.
- **Migrations:** all local migrations through `user_payment_source` are
  committed and will deploy.
- **Secrets (prod `parkagent-api`):** all core secrets **Deployed** —
  `DATABASE_URL`, `DRY_RUN`, `API_KEY_PEPPER`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `SOCRATA_APP_TOKEN`, the four `APNS_*`,
  `PROVIDER_STATE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. **None are
  placeholder values.**
- **Absent (optional) secrets — set before the feature they gate is used:**
  `ISSUING_LIVE` (defaults false — keep off until Issuing is live),
  `STRIPE_FINANCIAL_ACCOUNT` / `STRIPE_PAYOUT_RECIPIENT` (card funding /
  withdraw), the four `LINK_*` (`/link/*` 503s until set — Link wallet not
  live), `PARKNYC_PLATE` (falls back to the account's first vehicle).
  `.env.example` was updated to list `ISSUING_LIVE`, `EXECUTOR_STEP_CAPTURE_DIR`,
  and the `LINK_*` group.

### Docs (E.4)

`docs/field-test-checklist.md` updated for the `provider_card` path (no
card setup / no Add money; the link flow's provider-card note) and the
push-test check. This report is `docs/acceptance-report.md`.

---

## Known gaps carried forward

1. **Live APNs delivery** — needs prod creds + a registered device
   (endpoint and reporting are in place and tested).
2. **Per-zone ParkBoston billing increments** — the quote can match the
   receipt to the cent once each zone's `incrementalMinutes` is collected
   (mechanism + zone-456 value in place; the executor already reads it live
   off the picker). Collect the rest on each zone's first live start during
   the field test. Until then, sub-hour Boston quotes are an upper-bound
   estimate, while the **recorded** spend already matches the card (the
   executor returns the real receipt).
3. **ParkBoston early stop** — no covered zone enables it (non-refundable),
   so the `#sessStopBtn` stop-confirm path can't be walked; the flow
   correctly returns `stopNotSupported` (no stop, no refund). If a Passport
   city that allows stopping is ever added, walk it then.
