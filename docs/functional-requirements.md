# ParkAgent functional requirements

What the system must do, numbered, each with an acceptance statement and
the evidence that proves it. Three kinds of evidence back an FR:

- **Live FR suite** (`server/fr/`, `pnpm -C server test:fr`) — runs
  against a deployed API **in dry run** as the dedicated FR user
  (`pnpm -C server create:fr-user`; never a person's key). Test names
  carry their FR ids; a nightly GitHub Action
  (`.github/workflows/nightly-fr.yml`) runs it against prod, uploads the
  report, and manages the "Nightly FR failures" issue. Assistant tests
  make real model calls under a hard per-run budget
  (`FR_ASSISTANT_MAX_CALLS`, default 8) and assert structure and
  grounding, never wording.
- **Unit / fixture suites** (`server/test/`, `executor/test/`) — hermetic
  tests over the fake DB and recorded provider fixture HTML; the executor
  flows are proven from fixtures, never by touching a provider. The
  nightly runs the executor fixture suite alongside the live one.
- **Acceptance record / device-manual** — the real-money Boston run and
  the iOS walkthrough in `docs/acceptance-report.md` (transactions
  831291617, 831908580, 831997285), plus checks that need a physical
  phone.

## Coverage

| FR | Requirement | Coverage | Test file(s) |
|---|---|---|---|
| FR-1 | Park detection → `/parked` | automated + device-manual | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/parked.test.ts`; detector: iOS `ParkAgentTests` (fusion), field test |
| FR-2 | NYC zone resolution | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/zoneLookup.test.ts`, `server/test/city.test.ts` |
| FR-3 | Boston resolution with a provider number | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/zoneNumber.test.ts` |
| FR-4 | Boston resolution without a number | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/parked.test.ts`, `server/test/session.test.ts` |
| FR-5 | Ambiguous fixes require confirmation | automated | `server/test/parked.test.ts`, `server/test/adversarial.test.ts` |
| FR-6 | Unknown zone answers unknown_zone | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/parked.test.ts` |
| FR-7 | Quote correctness (ladder, observed terms, receipts) | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/quote.test.ts`, `server/test/bostonQuote.test.ts`, `server/test/bostonBilling.test.ts`, `server/test/observedTerms.test.ts` |
| FR-8 | Free periods and the 8 pm boundary | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/parked.test.ts`, `server/test/bostonSession.test.ts`, `executor/test/passportParse.test.ts` |
| FR-9 | Timestamp clamping | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/adversarial.test.ts` |
| FR-10 | Session cap on every payment source | automated | `server/fr/00-gate.fr.test.ts`, `server/fr/30-session-providers.fr.test.ts`, `server/test/session.test.ts`, `server/test/paymentSource.test.ts`, `server/test/issuing.test.ts` |
| FR-11 | Daily cap on every payment source | automated | `server/fr/00-gate.fr.test.ts`, `server/test/session.test.ts`, `server/test/paymentSource.test.ts`, `server/test/issuing.test.ts`, `server/test/card.test.ts`, `server/test/assistantItinerary.test.ts` |
| FR-12 | Auto-pay rate ceiling | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/parked.test.ts` |
| FR-13 | Start through the executor | automated + acceptance | `server/fr/30-session-providers.fr.test.ts`, `server/test/session.test.ts`, `server/test/bostonSession.test.ts`, `executor/test/fixtures.test.ts`, `executor/test/parse.test.ts`, `executor/test/passportParse.test.ts`; paid: acceptance report Part B (txn 831908580) |
| FR-14 | Extend continues the ladder | automated + acceptance | `server/test/session.test.ts`, `executor/test/passportParse.test.ts`; paid: acceptance report (txn 831997285) |
| FR-15 | Stop (incl. no-early-stop zones) | automated + acceptance | `server/test/session.test.ts`, `executor/test/passportParse.test.ts`, `executor/test/sessionScreen.dom.test.ts`; walked live 2026-09-23 |
| FR-16 | Auto-extend decisions | automated | `server/test/extendTick.test.ts`, `server/test/adversarial.test.ts` |
| FR-17 | Provider link (per-user, sealed) | automated | `server/fr/30-session-providers.fr.test.ts`, `server/test/providers.test.ts`, `server/test/linkJobs.test.ts`, `server/test/registry.test.ts` |
| FR-18 | Link expiry → relink push | automated | `server/test/executorProvider.test.ts`, `server/test/providers.test.ts` |
| FR-19 | Relink restores the account | automated | `server/test/providers.test.ts` |
| FR-20 | Zone-number reporting & precedence | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/zoneNumber.test.ts`, `server/test/zoneNumberReverts.test.ts`, `data/test_import_parkboston_zones.py` |
| FR-21 | Assistant: single spot | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantLoop.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-22 | Assistant: itinerary | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantItinerary.test.ts` |
| FR-23 | Named-place search within 600 m | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantGeocode.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-24 | Past-date guard | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-25 | Confirm-token gate | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantPlanEnforcement.test.ts` |
| FR-26 | No plan without a quote | automated | `server/test/assistantPlanEnforcement.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-27 | Explanations | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantLoop.test.ts` |
| FR-28 | Pushes | automated + device-manual | `server/fr/50-ops.fr.test.ts`, `server/test/device.test.ts`, `server/test/apnsPush.test.ts`, `server/test/admin.test.ts`; live delivery needs a registered phone |
| FR-29 | Admin summary | automated | `server/fr/50-ops.fr.test.ts`, `server/test/admin.test.ts`, `server/test/authorization.test.ts` |
| FR-30 | Decision audit | automated | `server/fr/10-parked-nyc.fr.test.ts` (decisionId on every response), `server/test/parked.test.ts`, `server/test/adversarial.test.ts`, `server/test/security.test.ts` |
| FR-31 | Dry-run discipline | automated | `server/fr/00-gate.fr.test.ts`, `server/test/policy.test.ts`, `server/test/session.test.ts` |
| FR-32 | Accounts | **pending** | coming in a later PR |
| FR-33 | Wallet | **pending** | coming in a later PR |

---

## Detection and zone resolution

### FR-1 — Park detection hands off to `/parked`

The phone detects that the car parked (two-of-three fusion over motion
stop, audio/BT disconnect, and a settled location fix) and POSTs the fix
to `/parked` with its detector signals. **Accepted when** every `/parked`
call writes a `parked_events` row and a `decisions` row and answers an
action (`pay | confirm | ignore | unknown_zone`), a quote (or null), the
effective dry-run flag, and both row ids.

Evidence: live FR-1 test asserts the response contract (ids, dryRun,
action vocabulary); `parked.test.ts` pins the row writes; the detector
itself is iOS `ParkAgentTests` (ParkFusionEngine) plus the field test —
device-manual.

### FR-2 — NYC zone resolution

A fix on a metered NYC block resolves to candidates within
`max(accuracy, 25) m` of a zone centerline, distance-ranked, each
carrying its ParkNYC zone number, rate ladder, max stay, and hours; the
provider block identifies ParkNYC and its link state. **Accepted when** a
park at a known NYC block returns a numbered `nyc` candidate and
`GET /city` places the point in NYC with the ParkNYC provider.

Evidence: live FR-2 tests at 30th Ave & Steinway (nyc-417371);
`zoneLookup.test.ts` (radius, ranking), `city.test.ts` (20 km metro
lookup).

### FR-3 — Boston zone resolution with a provider number

Once a Boston block's ParkBoston number is known (driver report or
Passport-feed import), every later park resolves it automatically:
candidate carries the number, `needsZoneNumber` is false, provider is
Passport. **Accepted when** a park at the acceptance block (Boylston
D–C, zone 456) returns the stored number and a self-consistent flat-rate
quote (total = meter + fee; both ladder fields equal).

Evidence: live FR-3 test (self-healing: reports "456" first if the
target DB hasn't got it — the number verified live 2026-09-23);
`zoneNumber.test.ts`.

### FR-4 — Boston zone resolution without a number

An unreported Boston block must never be auto-paid: `needsZoneNumber`
rides the response, a would-be `auto_pay_ok` downgrades to `confirm`
(rule `needs_zone_number`), and `POST /session/start` refuses
`409 needs_zone_number` before any session row or executor call.
**Accepted when** a park at an unreported block answers
`needsZoneNumber: true` and never `pay`.

Evidence: live FR-4 test at an unnumbered Albany St block (self-skips if
the block gains a number); `parked.test.ts` (downgrade rule),
`session.test.ts` (the 409 before any row).

### FR-5 — Ambiguous fixes require confirmation

When a candidate within radius disagrees with the nearest (rate ladder,
max stay, or next-60-minutes enforcement), the action is `confirm` with
both candidates and their own quotes — the driver picks. **Accepted
when** the disagreeing pair produces `candidates_disagree` with exactly
the nearest plus the nearest disagreeing candidate.

Evidence: `parked.test.ts`, `adversarial.test.ts` (the Mott & Canal
120- vs 300-minute pair). Not asserted live — whether two prod zones
disagree at a point is data, not behavior.

### FR-6 — Unknown zone

A fix with no candidate in radius answers `unknown_zone`: empty
candidates, null quote, null provider — and the app falls back to manual
entry. **Accepted when** a park far from any meter returns exactly that,
and `GET /city` nowhere near a metro answers all-null.

Evidence: live FR-6 tests (open water fix); `parked.test.ts`.

## Quoting and pricing

### FR-7 — Quote correctness

Quotes price only enforced minutes through the rate ladder (first 60
charged minutes at the first-hour rate, the rest at the additional-hour
rate, prorated, rounded half-up once per field), plus the per-city fee
(zero when the meter is zero); `total = meter + fee` exactly.
Provider-observed terms (`zone_terms_observed`) beat the dataset
everywhere quotes are made (`/parked`, session start, the assistant's
`quote_street`), with verified driver reports ahead of imports. Where a
zone's billing increment is known, the quote snaps to it so it matches
the provider's receipt to the cent — the $1.10 zone-456 receipt
(12 min × $3.75/h = $0.75 + $0.35 fee) is reproduced from the recorded
fixture. **Accepted when** a live quote recomputes exactly from its own
candidate's terms, and the receipt-reproduction tests hold.

Evidence: live FR-7 ladder recomputation on the NYC candidate;
`quote.test.ts`, `bostonQuote.test.ts`, `bostonBilling.test.ts`
(831291617/831908580 to the cent), `observedTerms.test.ts`; ground truth
in the acceptance report, Job 2.

### FR-8 — Free periods and the 8 pm boundary

Minutes outside posted hours cost nothing. A stay that prices to $0 is
`ignore`/`free_period` with no fee; a stay straddling the end of
enforcement charges only the enforced minutes; and when the provider
itself declares "No Meter Parking" at pay time, the server records a free
period, holds the session, and pushes "parking is free" — never a
tap-to-pay. **Accepted when** a 9:15 pm Boylston park is free, a 7:30 pm
90-minute quote charges ≤ 30 minutes, and the provider-notice path stays
pinned.

Evidence: live FR-8 tests; `parked.test.ts`, `session.test.ts`,
`bostonSession.test.ts`, `executor/test/passportParse.test.ts`; the
acceptance run's 9:15 pm decision (`cmueb94g0…`).

### FR-9 — Timestamp clamping

A park timestamp more than 24 h past or 10 min future would price the
wrong enforcement window, so it is clamped to server time and the
decision records `request_ts_clamped`. **Accepted when** a stale ts
prices at server time (live: a 3-day-old afternoon ts prices as the
current off-hours free period) and the decision inputs say why.

Evidence: live FR-9 test (runs in the nightly's off-hours window);
`adversarial.test.ts` (all three `pricedAtSource` values).

## Budget caps

### FR-10 — Session cap on every payment source

No single purchase may exceed `session_cap_usd`, whatever pays:
`/parked` downgrades to confirm, `/session/start` and `/session/extend`
hard-refuse `409 session_cap_exceeded` (a cap can never be confirmed
through), and the Issuing card carries the same cap as a Stripe
per-authorization spending control. The payment-source choice
(`provider_card` default, `issuing_card` behind `ISSUING_LIVE`) moves
where the charge lands, never what is allowed. **Accepted when** the cap
binds on every path and the source switch respects its gate.

Evidence: `session.test.ts`, `paymentSource.test.ts` ("caps bind every
source"), `issuing.test.ts`; live: the gate test pins the caps on the
active policy and FR-10 exercises the payment-source gate
(`issuing_not_live`).

### FR-11 — Daily cap on every payment source

Real (non-dry-run) spend today plus the new total may not exceed
`daily_cap_usd` — enforced at `/parked` (confirm), session start/extend
(hard 409), the Issuing webhook (`declined_over_daily_cap`), card
funding moves (`amount_over_daily_cap`), provider wallet top-ups, and
itinerary sign-off (day total vs remaining budget). **Accepted when**
each surface refuses past the cap in its own vocabulary.

Evidence: `session.test.ts`, `issuing.test.ts`, `card.test.ts`,
`paymentSource.test.ts`, `assistantItinerary.test.ts`; live: caps
asserted present on the active policy (a live overrun can't be staged in
dry run without spending).

### FR-12 — Auto-pay rate ceiling

A zone whose ladder tops `auto_pay_max_rate_per_hour` is never paid
silently: the action downgrades to `confirm` (`rate_above_ceiling`).
**Accepted when** a park at a $9/h block never answers `pay`.

Evidence: live FR-12 test at a $5.50/$9.00 Financial District block;
`parked.test.ts`.

## Sessions through the executor

### FR-13 — Start

`POST /session/start` is the only money-moving path for street parking.
It refuses before the executor when policy says no (max stay, free
period, caps), when the zone has no number, or when the caller has no
linked provider account (`409 provider_not_linked`, dry run included —
payment always runs on the caller's own account). One open session per
user is enforced by a partial unique index, so concurrent starts can
never both pay. On success the executor types the stored zone number at
the provider, the session snapshots the zone's terms and city, receipt
actuals are recorded when the provider shows them, and a `start_ok`
decision plus `session_started` push follow. Executor failures come back
typed, mark the session `failed`, and push `payment_failed` with a
tap-to-pay deep link (`parking_denied` and `payment_method_missing` get
their own no-retry wording — no charge happened). **Accepted when** the
refusal order and the paid path both hold.

Evidence: live FR-13/FR-17 test (unlinked start refuses before
anything); `session.test.ts`, `bostonSession.test.ts`,
`executorProvider.test.ts`; executor flows from recorded fixtures
(`fixtures.test.ts`, `parse.test.ts`, `passportParse.test.ts`,
`classify.test.ts`); paid for real: acceptance Part B, txn 831908580
($0.75 + $0.35, `provider_card`).

### FR-14 — Extend

`POST /session/extend` prices minutes from the current expiry,
continuing the ladder from minutes already bought, under the same hard
caps (max stay compares total purchased minutes). The provider's
"No Meter Parking" answer is a hold (`409 free_period`), not a failure.
**Accepted when** extension pricing, caps, and the free-period hold hold
in tests and the live extend walked.

Evidence: `session.test.ts`; Passport extend flow from fixtures
(dispatched Extend click, session-screen success marker,
`passportParse.test.ts`); paid for real: txn 831997285 (12 + 12 min,
$2.20 cumulative).

### FR-15 — Stop

`POST /session/stop` marks the session stopped and records the dwell for
the dwell model. A provider/zone without early stop (ParkBoston: meter
time is non-refundable, no Stop button rendered) returns
`stopNotSupported` — no stop, no refund, no failure. **Accepted when**
both the stop and the not-supported paths are pinned.

Evidence: `session.test.ts`, `executor/test/sessionScreen.dom.test.ts`
(`session-active--stop-disabled.html` fixture), `passportParse.test.ts`;
walked live 2026-09-23 (acceptance report, extend/stop follow-up).

### FR-16 — Auto-extend decisions

The extension worker ticks every 60 s over active sessions, computing
distance and walking ETA to the car, heading, P(return in time), and
expected ticket cost (per-city `ticket_cost_usd`) vs extension cost.
Within 12 minutes of expiry it extends when ticket risk clearly exceeds
cost (×1.2) and policy allows; otherwise it holds or warns. **Accepted
when**: far from the car near expiry → `extend`; heading back with time
→ `hold_return_likely`; at the zone's max stay → `warn_max_stay` and a
`session_expiring(max_stay)` push (move the car); a cap in the way →
`hold_session_cap`/`hold_daily_cap` and a `session_expiring(budget)`
push; the free boundary → `free_period` hold (no purchase past the end
of enforcement); every tick writes an `extend_tick` decision and settled
rules get 5-minute hysteresis.

Evidence: `extendTick.test.ts` (every rule above), `adversarial.test.ts`
(hysteresis, heading); live auto-extend fired in the acceptance run
(decision `cmueavkk1…`). Not in the live FR suite — it would need an
active session, which needs a linked provider.

## Provider accounts

### FR-17 — Link

Each user links their own provider account: cookies from the app's login
web view are filtered against the provider's registered domains (none
left → `400 no_session_cookies`), verified headlessly, sealed with
AES-256-GCM under `PROVIDER_STATE_KEY`, and stored per (user, provider).
State is never logged and never returned; link decisions record only
cookie counts and domains. The registry advertises both cities' display
names, login URLs, and cookie domains. **Accepted when** the registry
answers for both providers, an unlinked user's start refuses, and the
cookie filter rejects at the door.

Evidence: live FR-17 tests (`/providers/status`, wrong-domain link
refusal, unlinked start); `providers.test.ts`, `registry.test.ts`,
`linkJobs.test.ts`, `security.test.ts` (nothing leaks state).

### FR-18 — Expiry

When an executor call fails `auth_expired`, the provider account flips to
`expired` and a `provider_relink` push (with provider, deep link, zone
number) routes the user back into the link flow. **Accepted when** the
flip and the push are pinned.

Evidence: `executorProvider.test.ts`, `providers.test.ts`,
`apnsPush.test.ts`.

### FR-19 — Relink

Re-linking upserts fresh sealed state and returns the account to
`linked`; an expired account heals with nothing else to fix (for
`issuing_card` users the chained setup-card re-runs; the `provider_card`
default touches nothing on the account). **Accepted when** the
expired→linked transition is pinned.

Evidence: `providers.test.ts`; iOS re-link flow in `ProviderUITests`
(device-manual for the real web view).

## Zone numbers

### FR-20 — Reporting and verification precedence

Drivers fill in Boston's missing ParkBoston numbers:
`POST /zones/:zoneId/provider-number` stores one report per (zone, user)
(re-reporting replaces yours), the zone's number becomes the latest
report, and it turns **verified** when two users agree. Precedence: a
verified report beats an import, an import beats a single unverified
report; a verified number stands until a new two-user consensus; a lone
dissent changes nothing. Reports survive zone reloads, and the response's
`number` is what is ON the zone — what the executor will type — which
clients must display over their own input. Every report writes a
decision. **Accepted when** the live report flow applies and the
precedence matrix is pinned.

Evidence: live FR-20/FR-3 test (report → automatic resolution);
`zoneNumber.test.ts` (precedence, verification, replacement),
`zoneNumberReverts.test.ts` (reload survival, revert),
`data/test_import_parkboston_zones.py` (import side); demonstrated live
in acceptance Part B.3.

## Assistant

### FR-21 — Single spot

"Find me a spot" yields at most one structured `single_spot` plan per
turn: ≤3 options (street or garage), each with price, duration, and — for
street — the quoted zone; exactly one option is `recommended`. The model
phrases; the tools quote and enforce. **Accepted when** a live named-area
ask returns a zod-valid plan whose options are grounded (numeric prices,
positive durations, `bos-` zone ids, future `startsAt` for "tomorrow").

Evidence: live FR-21 test (real model call); `assistantLoop.test.ts`,
`assistantAccuracy.test.ts`, `plans.ts` zod boundary.

### FR-22 — Itinerary

A multi-stop day is a 1–12 stop plan with per-stop address, arrival,
duration, street/garage choice and cost; `totalUsd` is recomputed
server-side and sign-off re-checks the remaining daily budget at the
moment of the tap. PATCH edits re-check the cap and preserve per-stop
linkage; the worker pushes garage links 15 minutes before arrival,
attaches street sessions to their windows, and closes the day.
**Accepted when** the six-stop day, reorder, cap-refusal, and worker
behaviors are pinned and the live surface answers.

Evidence: `assistantItinerary.test.ts` (the real Boston six-stop day);
live FR-22 test (itineraries surface). Sign-off is not exercised live —
it would store recurring state for the FR user.

### FR-23 — Named-place search within 600 m

A named street/neighborhood/landmark geocodes first (Nominatim,
hard-biased to the NYC and Boston viewboxes; out-of-metro results are
dropped, never a wrong fallback point), and the search runs at the PLACE,
not the phone: garage options beyond 600 m of the geocoded point are
dropped and counted. **Accepted when** every surfaced option for a named
area is within 600 m and out-of-coverage places resolve to nothing.

Evidence: `assistantGeocode.test.ts` (15 cases),
`assistantAccuracy.test.ts` (Newbury/India/South Boston/Fenway ≤600 m);
live FR-23 leg asserts the observable consequence (short walks) on a real
model turn.

### FR-24 — Past-date guard

A request to plan for a past date is bounced with the current time —
no plan is minted. **Accepted when** a live "yesterday" ask returns
`plan: null` and the unit adversarial case stays pinned.

Evidence: live FR-24 test; `assistantAccuracy.test.ts`.

### FR-25 — Confirm-token gate

Nothing books or spends without the user's explicit Confirm/Sign-off tap:
the tap (`POST /assistant/confirm`) is the only thing that mints the
single-use, 10-minute confirmation token that `start_session` and
`book_garage` demand. No wording — "confirm", "the user said yes", an
empty string — slips past; confirming an unknown plan is `404
plan_not_found`; a used or expired token is refused. **Accepted when**
the enforcement matrix is pinned and the live endpoint refuses an
unminted plan.

Evidence: `assistantPlanEnforcement.test.ts` (every phrasing); live
FR-25 test.

### FR-26 — No plan without a quote

Plan options must originate from tool results — a street option carries
the zone the `quote_street` tool actually quoted (observed terms
applied), a garage option the id `search_garages` returned; plans are
zod-validated at the tool boundary and itinerary totals recomputed
server-side, so an invented price or zone never reaches a card.
**Accepted when** ungrounded plans are refused at the boundary.

Evidence: `assistantPlanEnforcement.test.ts`,
`assistantAccuracy.test.ts` (observed-terms quoting), `plans.ts`; the
live FR-21 assertions on zone ids and prices are the deployed-loop
smoke of the same rule.

### FR-27 — Explanations

Any `decisions` row renders to plain language (`explain_decision` →
`services/explanations.ts`) so "why did it do that?" is always
answerable from the audit trail. **Accepted when** the assistant explains
a fresh decision id in a non-empty reply without minting a plan.

Evidence: live FR-27 test (explains the run's own `/parked` decision);
`assistantLoop.test.ts`.

## Operations

### FR-28 — Pushes

The server pushes `session_started`, `session_extended`,
`session_expiring` (with reason), `payment_failed` (with executor code
and tap-to-pay deep link where retrying makes sense), and
`provider_relink`. Device tokens register idempotently, are bound to
their first user (`409 token_bound_elsewhere` for anyone else), release
on delete, and dead tokens (APNs 410) are removed. With APNs credentials
missing the server drops-and-logs instead of failing, and
`POST /admin/push-test` reports per-device APNs status for the field
test. **Accepted when** registration/binding/release and the push-test
report hold live, and each push type's trigger is pinned.

Evidence: live FR-28 tests (token lifecycle, push-test);
`device.test.ts`, `apnsPush.test.ts`, `admin.test.ts`; delivery to a
physical phone is device-manual (prod creds + registered device).

### FR-29 — Admin summary

`GET /admin/summary` (admin-only; others 403) aggregates today's
activity per city — parks, unknown zones, sessions started/failed,
auto/manual extensions, declines and executor errors by code, shadow
results, spend — plus detector signal counts and the day's decision
count. **Accepted when** the live shape holds and non-admin access is
refused.

Evidence: live FR-29 test; `admin.test.ts`, `authorization.test.ts`.

## Cross-cutting

### FR-30 — Decision audit

Every automated decision — quote, session start/extend/stop, extension
tick, issuing authorization, card/funding move, provider link, zone
number report, assistant tool call/plan/confirmation — writes a
`decisions` row with its inputs, rule, and outcome, and money-adjacent
responses return the `decisionId`. **Accepted when** each surface's
decision write is pinned and live responses carry the id.

Evidence: decision assertions throughout `server/test/`; live FR tests
assert `decisionId` on `/parked` and the zone-number report.

### FR-31 — Dry-run discipline

`DRY_RUN` (env) and `dry_run` (policy) are independent switches; money
moves only when BOTH are false. Every response and decision records the
effective flag; in dry run the DryRunExecutor answers fake provider ids
and nothing reaches a provider. The FR suite itself refuses to run
unless the target reports effective dry run ON. **Accepted when** the
gate holds and the both-switches rule is pinned.

Evidence: live FR-31 gate tests; `policy.test.ts`, `session.test.ts`,
`executorProvider.test.ts`.

## Pending (later PRs)

### FR-32 — Accounts (pending)

Real multi-user accounts: sign-up/sign-in beyond hand-created api keys,
per-account data isolation guarantees, and account lifecycle (rename,
revoke, delete-with-cascade). Requirements and tests land with the
accounts PR; today's closest coverage is the api-key auth suite
(`apiKeys.test.ts`, `authorization.test.ts`, `security.test.ts`).

### FR-33 — Wallet (pending)

The funded-wallet surface: Issuing card funding balance E2E (top-up /
withdraw / Apple Pay against a live financial account), `ISSUING_LIVE`
turn-on, and the Link agentic wallet as a plan payment source
(spend-request approval → sealed one-time card → pay-at-curb; today
VERIFY-IN-SANDBOX per API.md). Requirements and tests land with the
wallet PRs; today's closest coverage is `card.test.ts`,
`cardLifecycle.test.ts`, `linkWallet.test.ts` over fakes.

---

## Running the live suite

```
# once, against the TARGET environment's database (prod for the nightly):
pnpm -C server create:fr-user            # prints the key once → FR_API_KEY

# then:
FR_API_KEY=… pnpm -C server test:fr                       # against prod
FR_API_BASE=http://localhost:3000 FR_API_KEY=… pnpm -C server test:fr
```

The suite hard-refuses when the target's effective dry run is off, makes
at most `FR_ASSISTANT_MAX_CALLS` (default 8) paid model calls per run,
never links a provider, never calls `PUT /policy`, and never starts a
session (the unlinked-start refusal is itself one of its assertions).
Zone fixture coordinates are env-overridable (`FR_NYC_AUTOPAY_LAT`, …)
— see `server/fr/client.ts`.

The nightly workflow (`nightly-fr.yml`, Tue–Sat 09:17 UTC + manual
`workflow_dispatch`) runs the executor fixture suite and this suite
against prod, uploads `fr-report.json` + `fr-summary.md` as the
`fr-report` artifact, and opens/updates a single **"Nightly FR
failures"** issue on failure, closing it on the next green run.
Secrets: `FR_API_KEY` (only one — the report and issue use the built-in
`GITHUB_TOKEN`).
