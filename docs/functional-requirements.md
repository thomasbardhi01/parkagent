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
| FR-1 | Park detection → `/parked` | automated + device-manual | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/parked.test.ts`; detector: iOS `ParkAgentTests` (fusion), `ParkedNoticeTests` (background notification); field test |
| FR-2 | NYC zone resolution | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/zoneLookup.test.ts`, `server/test/city.test.ts` |
| FR-3 | Boston resolution with a provider number | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/zoneNumber.test.ts` |
| FR-4 | Boston resolution without a number | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/parked.test.ts`, `server/test/session.test.ts` |
| FR-5 | Ambiguous fixes require confirmation | automated | `server/test/parked.test.ts`, `server/test/adversarial.test.ts` |
| FR-6 | Unknown zone answers unknown_zone | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/parked.test.ts` |
| FR-7 | Quote correctness (ladder, observed terms, receipts) | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/quote.test.ts`, `server/test/bostonQuote.test.ts`, `server/test/bostonBilling.test.ts`, `server/test/observedTerms.test.ts` |
| FR-8 | Free periods and the 8 pm boundary | automated | `server/fr/20-parked-boston.fr.test.ts`, `server/test/parked.test.ts`, `server/test/bostonSession.test.ts`, `executor/test/passportParse.test.ts` |
| FR-9 | Timestamp clamping | automated | `server/fr/10-parked-nyc.fr.test.ts`, `server/test/adversarial.test.ts` |
| FR-10 | Session cap on every payment source | automated | `server/fr/00-gate.fr.test.ts`, `server/fr/30-session-providers.fr.test.ts`, `server/test/session.test.ts`, `server/test/paymentSource.test.ts`, `server/test/walletHolds.test.ts`, `server/test/linkWallet.test.ts`, `server/test/issuing.test.ts`, `server/test/authorization.test.ts`; iOS `OnboardingUITests`, `AccountUITests` (shared limits read-only) |
| FR-11 | Daily cap on every payment source | automated | `server/fr/00-gate.fr.test.ts`, `server/test/session.test.ts`, `server/test/paymentSource.test.ts`, `server/test/walletHolds.test.ts`, `server/test/issuing.test.ts`, `server/test/card.test.ts`, `server/test/assistantItinerary.test.ts` |
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
| FR-22 | Assistant: itinerary | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantItinerary.test.ts`, `server/test/itineraryOrder.test.ts`, `server/test/itineraryReprice.test.ts`, `server/test/linkWallet.test.ts` (Link at re-priced amounts); iOS `ItineraryOrderTests`, `LiveAPIRequestTests` (the price call on the wire), `AssistantUITests` (arrival order on the card and Home; re-pricing and the over-cap Sign off) |
| FR-23 | Named-place search within 600 m | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantGeocode.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-24 | Past-date guard | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-25 | Confirm-token gate | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantPlanEnforcement.test.ts` |
| FR-26 | No plan without a quote | automated | `server/test/assistantPlanEnforcement.test.ts`, `server/test/assistantAccuracy.test.ts` |
| FR-27 | Explanations | automated | `server/fr/40-assistant.fr.test.ts`, `server/test/assistantLoop.test.ts` |
| FR-28 | Pushes | automated + device-manual | `server/fr/50-ops.fr.test.ts`, `server/test/device.test.ts`, `server/test/apnsPush.test.ts`, `server/test/admin.test.ts`, `server/test/session.test.ts` (copy); live delivery needs a registered phone |
| FR-29 | Admin summary | automated | `server/fr/50-ops.fr.test.ts`, `server/test/admin.test.ts`, `server/test/authorization.test.ts` |
| FR-30 | Decision audit | automated | `server/fr/10-parked-nyc.fr.test.ts` (decisionId on every response), `server/test/parked.test.ts`, `server/test/adversarial.test.ts`, `server/test/security.test.ts` |
| FR-31 | Dry-run discipline | automated | `server/fr/00-gate.fr.test.ts`, `server/test/policy.test.ts`, `server/test/session.test.ts` |
| FR-32 | Accounts | automated + device-manual | `server/fr/60-accounts.fr.test.ts`, `server/test/auth.test.ts`, `server/test/appleTokens.test.ts`, `server/test/frThrowawayPurge.test.ts`, `server/test/authTokens.test.ts`, `server/test/security.test.ts`, `server/test/vehicles.test.ts`; iOS `AuthStoreTests`, `LiveAPIRequestTests`, `OnboardingGateTests`, `AuthUITests`, `AccountUITests`; Apple sign-in and email-code delivery need a phone and a mailbox |
| FR-33 | Wallet | automated + device-manual | `server/fr/70-wallet.fr.test.ts`, `server/test/walletHolds.test.ts`, `server/test/wallet.test.ts`, `server/test/linkWallet.test.ts`, `server/test/paymentSource.test.ts`, `server/test/adversarial.test.ts`, `server/test/webhookStripe.test.ts`; iOS `LiveAPIRequestTests`, `CardBrandTests`, `WalletUITests`, `SessionUITests`, `OnboardingUITests`, `AccountUITests`, `AssistantUITests`; real Apple Pay / PaymentSheet, a real hold, and Link need a phone, the Stripe sandbox, and the Link OAuth client |
| FR-34 | Release builds carry no debug code | automated | iOS `ParkAgentReleaseTests` (scheme `ParkAgentRelease`, runs inside the Release build), `ReleaseDenylistTests`, `ios/Tools/check-release-binary.sh`; UI `AccountUITests` (Diagnostics contents), `WalletUITests` (sandbox toggle) |

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
through — and for the ParkAgent card the refusal comes before any hold is
placed), the ParkAgent card carries the same cap as a Stripe
per-authorization spending control, and a Link spend request over the cap
is never made. The Wallet's choice (`provider_card` default, `link_wallet`,
`parkagent_card` behind `ISSUING_LIVE`) moves where the charge lands,
never what is allowed. **Accepted when** the cap binds on every path and
the source switch respects its gates.

The caps live in one shared policy that only the operator edits (`PUT
/policy` is admin-only). `GET /policy` tells the app whether the caller
may (`editable`), so everyone else — every invited user — sees the limits
read-only in onboarding and in Account → Spending limits, instead of
steppers whose save would fail.

Evidence: `session.test.ts`, `walletHolds.test.ts` ("caps bind every
source" — all three), `linkWallet.test.ts` (no request over the cap),
`paymentSource.test.ts`, `issuing.test.ts`; live: the gate test pins the
caps on the active policy and FR-10 exercises the ParkAgent card's gate
(`parkagent_card_not_live` / `no_funding_method`).

### FR-11 — Daily cap on every payment source

Real (non-dry-run) spend today plus the new total may not exceed
`daily_cap_usd` — enforced at `/parked` (confirm), session start/extend
(hard 409, before any hold), the Issuing webhook
(`declined_over_daily_cap`), Link garage requests (`daily_cap_exceeded`,
no request made), the operator's card funding moves
(`amount_over_daily_cap`), provider wallet top-ups, and itinerary sign-off
(day total vs remaining budget). **Accepted when**
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
typed, mark the session `failed`, and push `payment_failed`: the text
says what to do instead (pay in the provider's app or at the meter;
`parking_denied` and `payment_method_missing` get their own wording — no
charge happened), the executor code rides in the payload and never in the
text, and the deep link opens the Park tab. **Accepted when** the
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
`parkagent_card` users the chained setup-card re-runs; `provider_card`
and `link_wallet` touch nothing on the account). **Accepted when** the
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
Stops always display in arrival-time order, one rule on both sides
(`orderStopsByArrival` / `ItineraryOrder`): untimed stops keep their slots
and the timed ones fill the rest by arrival, so a later stop can never
render above an earlier one. Only a stop without a set time can be dragged
or moved; changing a stop's time re-sorts it, and a time can be cleared.
Edits made on the plan card before sign-off are saved with it.
Every edit is **priced by the server**, never at the phone's numbers: the
card asks `POST /assistant/plans/:planId/price` after each edit and shows
the server's per-stop costs and day total, with Sign off off while it
prices and while the day is over the cap (saying why); the edits ride the
sign-off, which re-prices them and refuses a day over the cap before
anything is stored or any Link request made (Link asks for the re-priced
garage amounts); a PATCH re-prices against the stored day. A stop whose
time, length, kind, and place are unchanged keeps the server's price; a
changed one is re-quoted the way `build_itinerary` quoted it; a stop with
no set time, or one that can't be quoted, keeps its last price marked an
estimate. **Accepted when** the six-stop day, ordering, reorder,
re-pricing, cap-refusal, and worker behaviors are pinned and the live
surface answers.

Evidence: `assistantItinerary.test.ts` (the real Boston six-stop day);
`itineraryReprice.test.ts` (only changed stops re-quoted, at
`quote_street`'s price; a low client cost can't get a day under the cap at
price, sign-off, or PATCH; search-down estimates; decision rows — each
mutation-checked);
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
applied; a zoneId the model dropped is re-attached from the
conversation's quotes, and a street option with no quote to ground it
is refused), a garage option the id `search_garages` returned; plans are
zod-validated at the tool boundary and itinerary totals recomputed
server-side, so an invented zone never reaches a card. Prices: a
single-spot option's price and every EDITED itinerary stop's price come
from the server's own quote (#131); an itinerary's first proposal still
carries the per-stop prices the model read off `build_itinerary`, summed
and capped server-side but not re-quoted yet (#132).
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
`session_expiring` (with reason), `payment_failed` (the executor code in the
payload, plain next steps in the text, a deep link to the Park tab), and
`provider_relink`. Device tokens register idempotently, are bound to
their first user (`409 token_bound_elsewhere` for anyone else), release
on delete, and dead tokens (APNs 410) are removed. With APNs credentials
missing the server drops-and-logs instead of failing, and
`POST /admin/push-test` reports per-device APNs status for the field
test. A push navigates only when the driver
TAPS it (to the Park tab, the Wallet for `card_declined`, the link flow for
`provider_relink`, the garage's own link for `itinerary_garage_link`); a
banner in the foreground never moves the app by itself. The app also posts
one LOCAL notification of its own: a park detected in the background that
has something to pay ("Parked in zone …", time-sensitive) — never for an
unknown zone or a free period. **Accepted when** registration/binding/
release and the push-test report hold live, and each push type's trigger
is pinned.

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
tick, issuing authorization, card hold placed/declined/captured/released,
payment-source switch, saved card added/removed, Link approval
expired/card revealed, card/funding move, provider link, zone number
report, assistant tool call/plan/confirmation — writes a
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

### FR-32 — Accounts

Anyone can sign up and stay signed in, and an account's lifecycle is
safe end to end:

- **Sign-in** by Apple (identity token verified against Apple's JWKS:
  signature, issuer, audience, expiry) — the only method on by default.
  An emailed 6-digit code (10-minute expiry, 5 attempts, 5 sends per
  address per 15 minutes and 10 a day) and Google are built but switched
  off (`EMAIL_SIGNIN_ENABLED`, `GOOGLE_SIGNIN_ENABLED`): their routes
  answer `403 <method>_signin_disabled`, `GET /auth/methods` reports them
  off, and the app shows only the Apple button. Verified-email matches
  merge into one account; unverified emails are never stored.
- **Sessions**: 15-minute access JWTs plus refresh tokens stored only
  hashed, bound to a device id, 60-day sliding expiry, rotated on every
  use. Presenting a rotated token is reuse and revokes the whole family;
  two requests racing with one token can't both win.
- **Profile**: `GET /me` returns the caller's public profile and nothing
  secret; `PATCH /me` edits name and phone, and an edited phone is never
  verified (there is no SMS flow).
- **Deletion**: `DELETE /me` freezes any issued card first (a Stripe
  failure leaves the account whole and the delete retryable), then signs
  out every device, unlinks providers and erases their sealed state,
  deletes vehicles and conversations, revokes the Sign in with Apple token
  at Apple (App Store 5.1.1(v); the refresh token from the sign-in's
  authorization-code exchange, stored sealed — a failed revoke never
  blocks the delete and is retried hourly), and tombstones the users row — the
  decisions ledger keeps a valid id, the person goes, and the account's
  still-valid access token stops working at once.
- **Admin keys** keep working for scripts and the FR user; the app never
  carries one.

**Accepted when** the live suite proves the reported sign-in methods
match the routes, profile read/write, refresh refusal, device binding,
rotation, reuse detection, and deletion against the deployed API, and the unit suites pin the verification, throttles,
merge rules, and teardown.

The live session-lifecycle tests need a real refresh session, minted by
`pnpm -C server create:fr-throwaway` — an admin script that needs the
target's own `DATABASE_URL` and `AUTH_JWT_SECRET`, run inside the prod
machine by the nightly (`fly ssh console`). It is deliberately not an API
route: nothing on the public surface can mint a session without a
verified identity. Without one (`FR_THROWAWAY_SESSION` unset) those four
tests skip. The suite deletes the throwaway it is given however its tests
end — a file-level `afterAll` sends `DELETE /me` with the throwaway's own
access token even when the dry-run gate fails and every test skips — and
the nightly then runs `purge-fr-throwaways --apply` in the prod machine,
which catches what the suite couldn't (a run that died first, a token
already dead) with the same teardown `DELETE /me` runs
(`services/accountDeletion.ts`). The purge only ever touches rows
`create-fr-throwaway` minted — its marker decision, its exact name, no
sign-in identity, no api key, not admin — and a live one only once it is
30 minutes old (or named by `--include`); `pnpm -C server
purge:fr-throwaways` dry-runs it against any database. Other per-run
state is put back in `afterAll` too: the FR user's name and phone, its
payment source, and the fake device token.

**Device-manual**: Sign in with Apple on a phone (the system sheet can't
be automated, and a real identity token only comes from Apple). Email-code
delivery to a real mailbox (Resend, including Apple's private relay) is
device-manual too, once email sign-in is switched on.

Evidence: live FR-32 tests; `auth.test.ts` (real RS256 verification,
code throttles, rotation, the rotation race, deletion teardown including
the Stripe-failure ordering), `authTokens.test.ts`, `security.test.ts`,
`vehicles.test.ts`; iOS `AuthStoreTests` (single-flight refresh, device
id across sign-out, a late refresh after sign-out),
`LiveAPIRequestTests` (every identity and account call on the wire, the
401 → refresh → retry path), `OnboardingGateTests`, `AuthUITests`,
`AccountUITests`.

## Wallet

### FR-33 — Wallet

One place answers "how am I paying, and what have I spent", for three
ways to pay, one active at a time:

- **Your card on the provider** (`provider_card`, the default): the card
  saved on the user's ParkNYC/ParkBoston account; nothing to set up.
- **Link** (`link_wallet`): the user's Stripe Link wallet, for assistant
  plans and garages — one spend request per paid garage, approved in
  Link; the approved one-time card pays the garage's own checkout
  (revealed behind Face ID for 30 seconds). Street meters stay on the
  provider account's card: its single saved card can't take a per-session
  Link card without losing the user's own. Link is refused until it is
  configured (`LINK_*`; otherwise "Link — coming soon") and connected;
  approvals expire after Link's 10-minute window, uncharged; no request is
  made in dry run (unless Link test mode) or over a cap.
- **ParkAgent card** (`parkagent_card`, "Coming soon — pending approval"
  until `ISSUING_LIVE`; a Debug build may choose it in sandbox against a
  test-mode Stripe key): the user saves their own card once (Apple Pay
  first, card entry via PaymentSheet — a SetupIntent, nothing charged);
  our virtual card goes on every linked parking account (consent first);
  each paid leg — start and every extension — places a hold on the user's
  card for the quote plus max($2, 20%) **before** the executor runs; the
  Issuing webhook approves our card only against a live hold with room
  (compare-and-set, so two charges can't both fit); after the provider
  charge the hold captures exactly what our card paid and releases the
  rest; free periods and failures release; late authorizations are
  settled by a sweep; a declined hold pays nothing and pushes "Your card
  was declined — update it in Wallet". Idempotent under webhook replay
  (a replayed approval never claims twice; Stripe-side cancels reconcile
  once). Under dry run no hold is ever placed.

There is no stored balance: top-up, withdraw, and Add money are
admin-only operator tools. `GET /wallet` reports the active source, the
three options with availability, each option's details, every parking
account and what pays there, today's and the month's spend against the
caps — whatever paid: street meters per city plus garages approved in
Link, the same figure every daily-cap check uses (a Link request still
awaiting approval also holds its room) — and the first page of the
unified Activity ledger
(sessions with meter, fee, explanation, holds, and timeline; garage
bookings; Link payments with their approval state; receipt ids).
`PUT /wallet/source` validates readiness. The app's tabs are Park ·
Activity · Wallet, and the Wallet, the Account sheet, and onboarding's
pay step read the same summary with the same copy. Every step writes a
decisions row. **Accepted when** the hold → capture → release path holds
in all its branches (decline, extension, free period, failure, late
authorization, replay, races), the caps bind all three sources, Link's
approval and timeout flows and its street restriction are pinned, source
switching refuses what isn't ready, and the live summary answers
honestly for an unlinked user in dry run.

Evidence: `walletHolds.test.ts` (holds end to end through the real
webhook route, including barrier-forced races on settling and on a
hold's room), `wallet.test.ts` (each Wallet state's shape, setup-intent
and funding methods, activity paging and explanations, admin-only
funding, `DELETE /me` taking the Customer and Link with it),
`linkWallet.test.ts` (garage approval → reveal, the street restriction,
dry-run and cap gating — including today's approved and pending Link
requests — and approval timeout), `session.test.ts` (a street start
refused once Link garages used the day's cap), `paymentSource.test.ts`,
`adversarial.test.ts` (replay claims once); live FR-33 tests (summary
shape and honesty, paging, switch refusals, setup-intent refusal before
any Stripe call, the old route gone) — run against a local API on the
wallet branch, and nightly against prod after deploy; iOS `WalletUITests`
(each Wallet state: provider card active, Link connected and active, Link
not configured, ParkAgent card sandbox with reveal and freeze, empty;
switching to Link and to the ParkAgent card; Activity from the Wallet),
`LiveAPIRequestTests` (every Wallet call on the wire, decoded from a real
server body). **Device-manual:** Apple Pay and PaymentSheet saving a card
against the Stripe sandbox, a real hold captured after a real provider
charge (needs `ISSUING_LIVE` or sandbox + a linked account outside dry
run), and Link's OAuth, approval, and one-time card (needs the registered
Link OAuth client; the REST paths are VERIFY-IN-SANDBOX).

## Release

### FR-34 — Release builds carry no debug code

A Release build (TestFlight, App Store) contains no mock API, fixtures,
scenario switches, launch-argument handling, UI-test hooks, previews, or
Diagnostics — compiled out, not hidden. Debug builds keep exactly the
field-test kit behind five taps on the version number: detector status,
signal-log export, the effective dry run, Reset onboarding, and the
ParkAgent-card sandbox toggle (off by default). **Accepted when** the
Release binary has none of the markers in `ios/Tools/release-denylist.txt`
and none of its debug-only types, and Diagnostics shows those five things
and nothing else.

Evidence: `ParkAgentReleaseTests` runs inside the Release build (scheme
`ParkAgentRelease`): a byte scan of its own executable against the
denylist (with required markers, so a clean scan can't come from the wrong
file), a Swift-runtime lookup of each debug-only type by mangled name,
and the App Store Info.plist (version 1.0.0, integer build,
`ITSAppUsesNonExemptEncryption`, the `location` background mode only,
plain-English usage strings, privacy manifest, icon). `ReleaseDenylistTests`
proves every listed type resolves in a Debug build, so an absence can't
be vacuous. `ios/Tools/check-release-binary.sh` runs `strings` over a
built app with the same list (CI and the TestFlight workflow); the pre-RC
Release build had 27 hits. Blind spot, by construction: literals of 15
bytes or fewer live inline in the instruction stream, so the list uses
type names and 16+-byte markers (accessibility identifiers).

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
