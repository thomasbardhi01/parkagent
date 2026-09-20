# ParkAgent API

Contract for the Phase 3 server. This file is the source of truth for the
HTTP surface; change it in the same PR as the code it describes.

Base URL: `https://parkagent-api.fly.dev` (prod) · `http://localhost:3000` (dev).
All bodies are JSON. All timestamps are ISO 8601 with offset. All money is
USD as a decimal number of dollars (e.g. `7.28`).

## Authentication

Every endpoint except `GET /health` requires the header:

    x-api-key: <users.api_key>

Unknown or missing key → `401 {"error": "unauthorized"}`. Keys are created
with `pnpm -C server create:user -- --name <name>` and live only in the
`users` table.

## Dry run

`DRY_RUN` (env) and `dry_run` (policy.json) are independent switches; money
can move only when **both** are false. `/parked` itself never moves money —
it only quotes — but every response and every `decisions` row records the
effective `dryRun` so the week-one dry run is auditable.

---

## POST /parked

Phone-detected park. Runs zone lookup → policy check, writes a
`parked_events` row and **always** writes a `decisions` row, then returns
what the app should do.

Request:

```json
{
  "lat": 40.7784,            // WGS84
  "lng": -73.9818,
  "accuracy": 12.5,          // horizontal accuracy, meters
  "ts": "2026-09-20T14:03:22-04:00",   // optional: when the phone detected the park
  "signals": ["motion_stop", "bt_disconnect"]   // free-form detector evidence
}
```

Quotes are priced at `ts` when the phone sends one, else at server time;
the decision's `inputs` record `pricedAt` and `pricedAtSource`
(`"request_ts"` | `"server_time"`), and a ts-less park stores server time
as the event's `ts`.

Response `200`:

```json
{
  "action": "pay",           // "pay" | "confirm" | "ignore" | "unknown_zone"
  "candidates": [ Candidate, ... ],
  "quote": Quote | null,     // null only for unknown_zone
  "rule": "auto_pay_ok",     // which rule produced the action (see below)
  "dryRun": true,
  "parkedEventId": "…",
  "decisionId": "…"
}
```

### Candidate

One plausible block face for the fix, ranked by distance to the face's
centerline:

```json
{
  "zoneId": "nyc-110436",
  "parknycZoneNumber": "110436",
  "distanceM": 9.3,            // meters, point → centerline
  "containsPoint": true,       // fix landed inside the buffered lane polygon
  "rateFirstHourUsd": 5.0,
  "rateAdditionalHourUsd": 8.25,   // 2nd-hour price (see data/build_zones.py)
  "maxStayMinutes": 120,
  "hours": [{ "days": ["Mon", "..."], "start": "08:00", "end": "19:00" }],
  "quote": Quote               // what this candidate would cost
}
```

### Quote

Cost of the default stay in a zone, priced only over enforced minutes:

```json
{
  "zoneId": "nyc-110436",
  "parknycZoneNumber": "110436",
  "stayMinutes": 90,        // min(policy.default_stay_minutes, zone max stay)
  "chargedMinutes": 90,     // minutes of the stay inside enforcement hours
  "meterUsd": 7.13,         // rate ladder applied to chargedMinutes
  "feeUsd": 0.15,           // policy.parknyc_fee_usd; 0 when meterUsd is 0
  "totalUsd": 7.28
}
```

Pricing: charged minutes consume the ladder in order — the first 60 at
`rateFirstHourUsd` (prorated), everything after at `rateAdditionalHourUsd`
(prorated). Minutes of the stay outside the zone's posted hours cost
nothing. A zone with `hours: []` (nothing posted) is treated as always
enforced. `respect_enforcement_hours: false` in policy also treats every
zone as always enforced. Rounding: half-up to the cent, once, on each of
`meterUsd`/`feeUsd`/`totalUsd`.

### How the action is chosen

Lookup returns every zone whose centerline is within
`max(accuracy, 25) meters` of the fix, ranked by centerline distance.

Two candidates **agree** when their rate ladder (both values), max stay, and
minute-by-minute enforcement status over the next 60 minutes all match.
Differing posted hours that behave identically for the next hour still
agree.

| Rule (in order) | Condition | Action | candidates[] |
|---|---|---|---|
| `unknown_zone` | no candidate in radius | `unknown_zone` | `[]`, quote `null` |
| `candidates_disagree` | some candidate disagrees with the nearest | `confirm` | nearest + nearest disagreeing, each with its own quote; top-level quote is the nearest's |
| `free_period` | all agree, `totalUsd` is 0 | `ignore` | nearest only |
| `rate_above_ceiling` | ladder max > `auto_pay_max_rate_per_hour` | `confirm` | nearest only |
| `session_cap_exceeded` | `totalUsd` > `session_cap_usd` | `confirm` | nearest only |
| `daily_cap_exceeded` | today's session spend + `totalUsd` > `daily_cap_usd` | `confirm` | nearest only |
| `auto_pay_ok` | none of the above | `pay` | nearest only |

Every `/parked` call writes a `decisions` row: `inputs` (request body,
pricing time and its source, radius, candidate zone ids, effective dry run,
policy hash), `rule`, `outcome` (action + quote).

Errors: `400` invalid body (zod details in `error`), `401` bad key.

---

## POST /session/start

The money-moving path. Executes through the executor protocol
(`services/executor.ts`); with effective dry run on, that is the
DryRunExecutor, which logs and returns fake `dry-…` provider ids. Outside
dry run the real ParkNYC executor is a Phase 5 stub that fails with
`not_implemented` — nothing can move money yet.

Request: `{parkedEventId, zoneId, minutes?}`. `minutes` defaults to
`min(policy.default_stay_minutes, zone max stay)`. The zone's terms (rate
ladder, max stay, hours) are snapshotted onto the session, and the parked
event's fix becomes the session's car coordinate.

Response `200`: `{sessionId, expiresAt, amountUsd}` — `amountUsd` is the
meter + ParkNYC fee for this purchase, priced like `/parked` quotes
(enforced minutes only, ladder in order).

Policy is enforced **hard** here, before the executor runs (`/parked`'s
"confirm" covers zone ambiguity and the rate ceiling; the caps are budget
guarantees and cannot be confirmed through — raise them via `PUT /policy`):

| `409 {"error": "policy_violation", "rule": …}` | Condition |
|---|---|
| `max_stay_exceeded` | `minutes` > zone max stay |
| `session_cap_exceeded` | purchase total > `session_cap_usd` |
| `daily_cap_exceeded` | real (non-dry-run) spend today + total > `daily_cap_usd` |

Other errors: `404` unknown/foreign `parkedEventId` or `zoneId`, `409
{"error": "session_already_active"}` (one active session per user), `502
{"error": "executor_failed", "code": …}` — the session row is marked
`failed` and a `payment_failed` push is sent.

Every call writes a `decisions` row (kind `session_start`; rule
`start_ok`, a cap rule, or `executor_failed`) and every executor call
writes a `session_events` row (`started` / `failed`).

## POST /session/extend

`{sessionId, minutes}` → `{sessionId, expiresAt, amountUsd}`. `amountUsd`
is the price of this extension: minutes are priced from the current expiry
and continue the rate ladder from the charged minutes already bought (an
extension past the first hour is all second-hour rate). Same hard cap
rules as start, where `max_stay_exceeded` compares total purchased minutes
against the zone's max stay. Decisions kind `session_extend`; session
event `extended` (details.source `"manual"` — the worker's are `"auto"`).

## POST /session/stop

`{sessionId}` → `{sessionId, stoppedAt}`. Marks the session `stopped` and
records the dwell (`stoppedAt` feeds the dwell model). Decisions kind
`session_stop`. `404` unknown session, `409` not active, `502` executor
failure.

## POST /location

`{lat, lng, accuracy, ts}` while a session is active, sent by the app
every 60 s. Stored in `location_fixes` keyed to the user's active session
→ `{ok: true, sessionId}`. `409 {"error": "no_active_session"}` when there
is nothing to attach the fix to (the app treats that as "stop reporting").

## POST /device

`{token, platform: "ios", environment: "development" | "production"}` →
`{ok: true}`. Upserts the APNs token by its value, so the app re-sending
on every launch is idempotent; `environment` picks the sandbox or
production APNs host per device. A token Apple reports dead (410) is
deleted.

### Push notification types

Pushes carry a standard `aps` payload plus `{"type": ...}`, one of:

- `session_started` — the server paid a meter (dry run says "would have paid")
- `session_extended` — auto-extend (or a manual extend) bought more time
- `session_expiring` — expiring soon and auto-extend will not fire; carries
  `reason`: `"max_stay"` (move the car), `"budget"` (a cap would be hit),
  or `"no_auto_extend"` (disabled or max_count used up)
- `payment_failed` — a pay or extend attempt failed; the meter is unpaid;
  carries `code` (executor error code)

Sending requires the `APNS_KEY` (contents of the `.p8` auth key),
`APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_BUNDLE_ID` env vars; with any of
them missing the server logs and drops pushes instead of sending.

---

## Extension worker

Not an endpoint, but half the Phase 7 surface: an in-process job ticks
every 60 s over active sessions. Per session it computes time remaining,
straight-line×1.3 distance and walking ETA from the latest fix to the car,
heading (toward/away/still from the last 3 fixes), P(return in time), and
expected ticket cost `ticket_cost_usd × (1 − P)` vs the cost of extending
to the P80 of predicted remaining dwell (dwell model v1: median of the
user's past sessions at this zone, else `default_stay_minutes`).

Within 12 minutes of expiry it extends when ticket risk clearly exceeds
extension cost (×1.2 margin) and policy allows, clamped by
`auto_extend.max_count`, `max_minutes_each`,
`no_extend_within_minutes_of_max_stay`, and the session/daily caps; it
pushes `session_expiring` when it cannot extend. A settled rule is held
for 5 minutes (hysteresis) and warning pushes fire only when the rule
changes. **Every tick writes a `decisions` row** (kind `extend_tick`) with
all inputs; rules are `extend`, `extend_failed`, `warn_max_stay`,
`hold_return_likely`, `hold_not_near_expiry`, `hold_session_cap`,
`hold_daily_cap`, `hold_max_extensions`, `hold_auto_extend_disabled`,
`hysteresis_hold`, and `expired` (bookkeeping when the meter ran out).

---

## POST /webhooks/stripe

Stripe Issuing events (Phase 6, test mode). **No `x-api-key`** — the
request is authenticated by verifying the `stripe-signature` header against
`STRIPE_WEBHOOK_SECRET` (required whenever `STRIPE_SECRET_KEY` is set; the
server refuses to boot with one but not the other). Body must be the raw
Stripe payload. `400` on a missing/invalid signature; `503` when Stripe
isn't configured.

Setup: `pnpm -C server issuing:setup -- --user <id>` creates the user's
cardholder and one virtual card with spending controls from `policy.json`
(`allowed_categories: parking_lots_garages` only, per-authorization limit =
`session_cap_usd`, daily limit = `daily_cap_usd`). Stripe IDs only — the
card number never touches the repo or the database. On money-management
Issuing accounts the card needs a financial account id, which the script
discovers from an existing card or takes via `--financial-account` /
`STRIPE_FINANCIAL_ACCOUNT`.

### issuing_authorization.request (real-time)

Stripe holds the card swipe open (~2 s) while the server decides, then
answers **in the HTTP response**: `200`, a `Stripe-Version` header, and
`{approved, metadata: {reason}}` (the older approve/decline API calls are
deprecated). The authorization and its `decisions` row are written before
the reply, so the audit persists even if the response is slow. Checks, in
order — the first failure is the `reason`:

| Reason | Condition |
|---|---|
| `declined_unknown_card` | card isn't in `issuing_cards` |
| `declined_wrong_mcc` | merchant category isn't `parking_lots_garages` / MCC 7523 |
| `declined_no_pending_session` | no pending/active session for the card's user started within the last 10 minutes (`services/pendingSession.ts`) |
| `declined_over_daily_cap` | approved card spend today (NYC day) + amount > `daily_cap_usd` |
| `declined_dry_run` | everything passed but a dry-run switch is on; the decision records `wouldApprove: true` |
| `approved` | none of the above, both dry-run switches off |

The card's own Stripe spending controls (MCC allowlist, per-authorization
and daily limits) are the first line of defense; authorizations they block
never reach the webhook. Every `.request` writes an `issuing_authorizations`
row and a `decisions` row (`kind: "issuing_authorization"`, inputs include
amount, MCC, spend-so-far, pending-session answer, dry run, policy hash).

### Ledger events

`issuing_authorization.created` / `.updated` upsert the
`issuing_authorizations` row (lifecycle `status`, held amount); an
authorization first seen this way is stored with `decision: "external"`.
`issuing_transaction.created` attaches the settled capture
(`stripe_transaction_id`, `captured_usd`) to its authorization row. Other
event types are acknowledged and ignored.

### Local dev

    stripe listen --forward-to localhost:3000/webhooks/stripe   # terminal A
    pnpm -C server dev                                          # terminal B
    pnpm -C server stripe:trigger -- --user <id> [--amount 7.28] [--category parking_lots_garages]

`stripe listen` prints a `whsec_…` — put it in `.env` as
`STRIPE_WEBHOOK_SECRET`. `stripe:trigger` fires a test authorization at the
user's real card via Stripe's test helpers, so the printed `approved` is
the webhook's live answer; vary `--amount`/`--category` to exercise each
decline.

---

## Card endpoints

The Card tab's server surface over the Phase 6 Issuing tables. All of these
require `x-api-key`; everything that talks to Stripe answers
`503 {"error": "stripe_not_configured"}` when `STRIPE_SECRET_KEY` isn't set.
The full card number **never** transits this server: the app reveals it
client-side with an ephemeral key (see `GET /card/reveal`).

### GET /card

The user's virtual card summary. With no card yet (issuing:setup hasn't
run), `200` with `card: null` — the app shows its "set up" state.

```json
{
  "card": {
    "stripeCardId": "ic_…",
    "last4": "4242",
    "brand": "Visa",
    "status": "active",          // active | inactive (frozen) | canceled
    "expMonth": 8,
    "expYear": 2030,
    "cardholderName": "Thomas",
    "spendingControls": {         // the controls actually on the Stripe card,
      "perAuthorizationUsd": 45,  // mirrored from policy.json at the last
      "dailyUsd": 60              // issuing:setup run
    },
    "spentTodayUsd": 7.28,        // approved authorizations, NYC day
    "spentThisMonthUsd": 12.28    // approved authorizations, NYC month
  },
  "funding": {                    // financial-account balance, best-effort:
    "available": true,            // false (fields absent) when the account
    "balanceUsd": 50.0,           // isn't ready or Stripe hiccups — the card
    "pendingUsd": 0               // still renders
  },
  "dryRun": true
}
```

Brand, expiry, and cardholder name are read live from Stripe; a status
changed in the Stripe dashboard is re-mirrored onto `issuing_cards`.

### GET /card/transactions

`?limit=20&cursor=…` → the user's `issuing_authorizations` ledger, newest
first. `cursor` is opaque (echo back `nextCursor`); `nextCursor: null`
means the last page.

```json
{
  "items": [{
    "id": "…",                       // issuing_authorizations.id
    "stripeAuthorizationId": "iauth_…",
    "merchantName": "PARKNYC TEST METER",
    "merchantCategory": "parking_lots_garages",
    "amountUsd": 7.28,               // the hold
    "capturedUsd": 7.28,             // settled amount; null until captured
    "approved": true,
    "decision": "approved",          // approved | declined_* | external
    "status": "closed",              // Stripe lifecycle: pending | closed | reversed
    "createdAt": "2026-01-05T18:00:00.000Z",
    "sessionId": "…"                 // linked parking session, or null
  }],
  "nextCursor": "2026-01-05T18:00:00.000Z"
}
```

`sessionId` is a read-time join: the newest session of the user that
started within the 10 minutes before the charge — the same window the
webhook approves against (`services/pendingSession.ts`). The ledger row
itself stores no session id.

### POST /card/funding/topup · POST /card/funding/withdraw

`{amountUsd}` → move money onto / off the Stripe financial account backing
the card. **Test mode only for now**: top-up simulates an ACH credit at the
account's financial address via Stripe's sandbox test helper; withdraw
creates a v2 outbound payment to the Global Payouts recipient in
`STRIPE_PAYOUT_RECIPIENT` (unset → `funding_unavailable`).

Both are policy-gated and audited — every call writes a `decisions` row
(kind `card_topup` / `card_withdraw`), and checks run in webhook order
(caps first, dry run last, so the audit shows what would have happened):

| Refusal | Status | Condition |
|---|---|---|
| `amount_over_daily_cap` | 409 | a single move may not exceed `daily_cap_usd` |
| `insufficient_funds` | 409 | withdraw only; carries `balanceUsd` |
| `dry_run` | 409 | either dry-run switch on; outcome records `wouldAllow: true` |
| `funding_unavailable` | 503 | financial account/address/recipient not ready; carries `reason` — this is the "not available yet" answer, never a 500 |
| `stripe_failed` | 502 | any other Stripe error |

Success: `200 {"ok": true, "balanceUsd": …, "pendingUsd": …, "decisionId": …}`
(the balance re-read after the move; a test-mode ACH credit may land in
`pendingUsd` first).

### GET /card/reveal

Short-lived Stripe ephemeral key for client-side PAN reveal — the app
calls Stripe's API directly with it; the number and CVC never touch this
server. Optional query params for Stripe client SDKs: `api_version` (the
version the SDK speaks; defaults to the server SDK's pinned version) and
`nonce` (Issuing Elements flow). Every reveal writes a `decisions` row
(kind `card_reveal`).

```json
{
  "stripeCardId": "ic_…",
  "ephemeralKeySecret": "ek_test_…",
  "apiVersion": "2026-08-26.dahlia",
  "expiresAt": "2026-01-05T19:15:00.000Z"   // Stripe keys live ~15 minutes
}
```

`404 {"error": "no_card"}` when issuing:setup hasn't run.

### POST /card/freeze · POST /card/unfreeze

No body. Sets the Stripe card `status` to `inactive` / `active`, mirrors it
onto `issuing_cards`, writes a `decisions` row (kind `card_status`), and
returns `{"status": "inactive" | "active"}`. A frozen card declines inside
Stripe before the webhook ever sees the authorization.

---

## GET /policy

Returns the active policy plus bookkeeping:

```json
{
  "policy": { …policy.json… },
  "hash": "sha256:…",        // canonical-JSON hash, matches policy_snapshots
  "dryRun": true             // effective: env DRY_RUN || policy.dry_run
}
```

## PUT /policy

Full replacement of the policy document. Body is the entire policy object
(same schema as `policy.json`; unknown keys rejected). On success the file
is rewritten, a `policy_snapshots` row is recorded (`source: "put"`), and
the new `GET /policy` payload is returned. `400` on validation failure with
zod details.

Note: on Fly the filesystem is ephemeral — a `PUT` there lasts until the
next deploy. The repo's `policy.json` stays the source of truth; snapshots
give the audit trail either way.

### policy.json schema

```json
{
  "dry_run": true,
  "session_cap_usd": 45,
  "daily_cap_usd": 60,
  "auto_pay_max_rate_per_hour": 8.0,
  "default_stay_minutes": 90,
  "parknyc_fee_usd": 0.15,
  "auto_extend": {
    "enabled": true,
    "max_count": 2,
    "max_minutes_each": 60,
    "no_extend_within_minutes_of_max_stay": 15
  },
  "respect_enforcement_hours": true,
  "ticket_cost_usd": 65
}
```

The server validates and snapshots (`source: "boot"`) at boot, and refuses
to start on an invalid file.

---

## GET /health

No auth. `{ok, dryRun, commit, builtAt}`.
