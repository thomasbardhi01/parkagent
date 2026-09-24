# ParkAgent API

Contract for the Phase 3 server. This file is the source of truth for the
HTTP surface; change it in the same PR as the code it describes.

Base URL: `https://parkagent-api.fly.dev` (prod) · `http://localhost:3000` (dev).
All bodies are JSON. All timestamps are ISO 8601 with offset. All money is
USD as a decimal number of dollars (e.g. `7.28`).

## Authentication

Two credentials authenticate a request, tried in this order:

1. **`Authorization: Bearer <jwt>`** — the app's 15-minute access token,
   HS256 over `AUTH_JWT_SECRET`. This is how every user-facing client
   authenticates; see "Identity & sessions" below. The user row is re-read
   per request, so a deleted account's still-valid JWT stops working
   immediately.
2. **`x-api-key: <users.api_key>`** — admin and scripts only now. Keys are
   created with `pnpm -C server create:user -- --name <name>`, printed
   exactly once; at rest the `users` table holds only
   `SHA-256(API_KEY_PEPPER:key)` plus an 8-char identification prefix (the
   pepper is a server env secret, so a DB dump alone can't validate keys).
   Existing plaintext rows are converted by
   `pnpm -C server migrate:api-keys`.

Unknown or missing credential → `401 {"error": "unauthorized"}`.

Auth is an app-level hook with a public allowlist (`/health`,
`/webhooks/stripe` — the Stripe signature is that route's auth,
`/link/callback`, and all of `/auth/*` — the credential is in the body),
so unknown paths 401 too. Authorization on top: `users.is_admin` gates
`PUT /policy` and everything under `/admin/` — any other valid caller gets
`403 {"error": "forbidden"}` (`create:user -- --admin`, or flip the
column in SQL for an existing user). Abuse-prone routes are rate-limited per user
(429 + `Retry-After`): `/parked` 30/min, provider writes 10/min, provider
reads 60/min, `/zones/:zoneId/provider-number` 12/min, `/zones/near` 60/min. The `/auth/*`
routes run before user auth, so they are limited per IP: email start
10/15 min, email verify 15/15 min, token exchanges 30/min — plus a
per-address cap on code sends (see `/auth/email/start`). On Fly the IP is
the edge's `Fly-Client-IP` (the socket peer is Fly's proxy, which would
make every "per-IP" bucket global); off Fly that header is ignored, since
any caller could set it. Unhandled errors
answer `500 {"error": "internal"}` — details go to the server log only.

---

## Identity & sessions

Anyone can sign up: the first successful sign-in creates the account.
**Sign in with Apple is the only method on by default.** Email codes and
Google are built but switched off (`EMAIL_SIGNIN_ENABLED`,
`GOOGLE_SIGNIN_ENABLED`, both default `false`); the server boots and runs
without any Resend or Google settings, a switched-off method's routes
answer `403 {"error": "<method>_signin_disabled"}`, and
`GET /auth/methods` tells the app which buttons to show. All methods land
on the same user when the verified email matches (see "Merging"):

- **Sign in with Apple** — the app sends Apple's identity token; the
  server verifies it against Apple's JWKS (`appleid.apple.com/auth/keys`),
  checking signature, issuer, audience (`APPLE_AUDIENCE`, the bundle id)
  and expiry. Private-relay addresses
  (`…@privaterelay.appleid.com`) are stored like any other verified
  address — which means the sending domain must be registered with
  Apple's private email relay or sign-in codes to those users bounce.
- **Email one-time code** — behind `EMAIL_SIGNIN_ENABLED` (default off;
  on requires `RESEND_API_KEY`). 6 digits, 10-minute expiry, 5 attempts,
  delivered by Resend.
- **Google** — behind `GOOGLE_SIGNIN_ENABLED` (default off). The App
  Store requires offering Sign in with Apple wherever Google is offered,
  which we do; Apple is the primary button either way.

**Merging.** An account is keyed by provider subject first
(`apple_sub` / `google_sub`), then by **verified** email — so Apple,
Google, and email sign-ins with the same verified address all resolve to
one user, and the new subject is attached to it — unless the account
already has a different subject of that kind, which is kept rather than
replaced. An unverified IdP email is **not stored at all** (Google, and
Apple for some managed accounts, can send one): kept in the unique email
column it would squat the owner's address, who would then either land in
the squatter's account by email code or collide on the index forever. An
account found holding an address it never verified gives it up to the
first sign-in that proves the mailbox.

**Sessions.** A sign-in returns a 15-minute access JWT plus an opaque
refresh token. Refresh tokens are stored only as
`SHA-256(AUTH_JWT_SECRET:token)`, bound to the `deviceId` the client
minted, with a **60-day sliding** expiry (each rotation restarts it).
Every refresh **rotates**: the presented token is retired and a sibling
in the same *family* replaces it. Presenting an already-rotated token is
replay — the entire family is revoked and every descendant stops working,
so a stolen token costs the thief and the victim the session, not just
the victim.

### POST /auth/apple

```json
{ "identityToken": "eyJ…", "deviceId": "…", "fullName": {"givenName": "Thomas", "familyName": "B"} }
```

`fullName` is optional and only ever sent once: Apple hands the name to
the **app** on first sign-in, never in the token, so the client forwards
it or it is lost. Response is the session body (below). A token that
fails any check → `401 {"error": "invalid_identity_token", "code": …}`
(`malformed`, `unknown_key`, `bad_signature`, `wrong_issuer`,
`wrong_audience`, `expired`).

### GET /auth/methods

Public, no body, no credential: `{"apple": true, "email": false,
"google": false}` — which sign-in methods this deployment accepts. The
welcome screen shows a button only for a method reported `true` (and
Apple only, if it can't ask). Each flag is exactly what the routes do: a
method reported `false` answers `403 <method>_signin_disabled`.

### POST /auth/google

`{idToken, deviceId}` → the same session body. `403
{"error": "google_signin_disabled"}` unless `GOOGLE_SIGNIN_ENABLED=true`
(which also requires `GOOGLE_CLIENT_ID` — the server refuses to boot with
one but not the other).

### POST /auth/email/start

`{email}` → `{"ok": true}`, and a 6-digit code is mailed via Resend. The
code is stored hashed; the plaintext exists only in the email. At most 5
codes per address per 15 minutes and 10 per 24 hours
(`429 email_rate_limited`) on top of the per-IP limit — with 5 attempts a
code, that bounds guessing at one address to 50 a day however many IPs
ask. `403 {"error": "email_signin_disabled"}` unless
`EMAIL_SIGNIN_ENABLED=true`; `502 send_failed` when Resend refuses.

The response is identical whether or not the address has an account —
this endpoint must not become an account-existence oracle.

### POST /auth/email/verify

`{email, code, deviceId}` → the session body; `403
email_signin_disabled` while the method is off (no code verifies then,
whatever an earlier configuration left behind). Wrong code →
`401 invalid_code`; past 10 minutes → `401 code_expired`; after 5 failed
attempts the code is burnt and even the right one answers
`401 too_many_attempts`. Each attempt is claimed with one conditional
write before the comparison, so concurrent guesses can't share a count,
and a successful verify consumes the code the same way (two right answers
racing get one session).

### POST /auth/refresh

`{refreshToken, deviceId}` → a fresh session body (new access token AND
new refresh token — store both). Failures, all `401`: `invalid_token`
(unknown or revoked), `token_reused` (already rotated — the family is now
revoked), `token_expired` (past the 60-day slide), `device_mismatch`.
Rotation claims the old token with a conditional write, so two requests
racing with the same token can't both mint a successor; the loser is
reuse. Clients should sign out only on these `401`s (and `400`/`403`) — a
`429` or `5xx` is no verdict on the token.

### POST /auth/logout

`{refreshToken}` → `{"ok": true}`. Revokes the token's whole family.
Unknown tokens are a no-op: signing out must never fail.

### Session body

```json
{
  "accessToken": "eyJ…",
  "accessExpiresAt": "2026-09-23T18:15:00.000Z",
  "refreshToken": "…",
  "user": {
    "id": "…", "name": "Thomas", "email": "thomas@example.com",
    "emailVerified": true, "phone": null, "phoneVerified": false,
    "appleLinked": true, "googleLinked": false
  },
  "created": true
}
```

`created` is true when this sign-in made the account — the app runs
onboarding on true and goes straight Home on false.

### GET /me · PATCH /me

`GET` → `{user, paymentSource, issuingLive}`. `PATCH {name?, phone?}`
edits the profile and returns `{user}`. Changing the phone clears
`phoneVerified` (there is no SMS verification flow yet). The email is
**not** editable here: it is the sign-in identity, and moving it needs
its own verification flow.

### DELETE /me

Irreversible; the app confirms in two steps. In order:

1. any Issuing card **frozen, never canceled** — a card that has
   transacted must keep resolving its authorizations. First, because it
   is the one step that calls out: a Stripe failure answers `500` with
   the account untouched and the delete safely retryable;
2. refresh tokens deleted (every device signs out) and device tokens
   deleted (push channels released);
3. provider accounts unlinked and their **sealed cookie state erased**;
4. vehicles and assistant conversations deleted (sessions detach from
   the vehicle but remain — they are the money audit);
5. the `users` row is **tombstoned**: name becomes "Deleted account",
   `email`/`phone`/`apple_sub`/`google_sub`/api-key columns are nulled,
   and `deleted_at` is stamped.

The row survives on purpose: `decisions` is a non-negotiable ledger with
a `user_id` on every row, so the id must stay valid — what goes is the
person behind it. A tombstoned row never authenticates (the bearer hook
rejects `deleted_at`), and its freed email/Apple subject make a **new**
account on the next sign-in. `200 {"ok": true, "deleted": true}`, plus a
`decisions` row (kind `account_delete`).

### Vehicles

`GET /me/vehicles` → `{vehicles: [{id, plate, state, label}]}`.
`POST /me/vehicles {plate, state, label?}` → `{vehicle}`.
`PATCH /me/vehicles/:id` (same fields, all optional) → `{vehicle}`.
`DELETE /me/vehicles/:id` → `{ok: true}` — the vehicle's sessions detach
rather than disappear.

Plates are normalized upper-case and are unique by `(plate, state)`
across **all** users (one car, one account): a collision answers
`409 {"error": "plate_taken"}`. A vehicle that isn't the caller's answers
`404 vehicle_not_found` — never 403, which would confirm it exists.

### Migration: attaching an identity to an existing user

    pnpm -C server attach-identity -- --user <id> --email <e> [--apple-sub <s>]

Stores the email as **verified** on that user (the owner asserting the
mailbox is theirs), so the first Apple or email sign-in with that address
merges onto the existing account and its whole history instead of
creating a new one. `--apple-sub` links the Apple identity outright. The
script refuses when the email or subject already belongs to someone else,
and writes an `auth_identity` decisions row.

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
(`"request_ts"` | `"server_time"` | `"request_ts_clamped"`), and a ts-less
park stores server time as the event's `ts`. A `ts` more than 24 h in the
past or 10 min in the future (wrong phone clock, replayed request) would
price the wrong enforcement window, so it is clamped to server time and
the decision says so (`request_ts_clamped`).

Response `200`:

```json
{
  "action": "pay",           // "pay" | "confirm" | "ignore" | "unknown_zone"
  "candidates": [ Candidate, ... ],
  "quote": Quote | null,     // null only for unknown_zone
  "rule": "auto_pay_ok",     // which rule produced the action (see below)
  "dryRun": true,
  "provider": {              // who runs this city's meters (null when the
    "id": "parknyc",         // zone is unknown or the city has no provider)
    "city": "nyc",
    "displayName": "ParkNYC",
    "loginUrl": "https://…", // where the app's link web view starts
    "status": "linked",      // linked | expired | unlinked
    "linked": true           // false → route the user into the link flow
  },
  "needsZoneNumber": false,  // true → collect the posted zone number
                             // (POST /zones/:zoneId/provider-number) first
  "parkedEventId": "…",
  "decisionId": "…"
}
```

The city comes from the zone id prefix (`nyc-…`); the provider registry
lives in `src/providers/registry.ts`. An unlinked (or expired) provider
means `POST /session/start` will refuse — the app should run the link flow
before offering to pay.

### Candidate

One plausible block face for the fix, ranked by distance to the face's
centerline:

```json
{
  "zoneId": "nyc-110436",
  "city": "nyc",               // "nyc" | "bos" — which city's meter system
  "providerZoneNumber": "110436",
  "distanceM": 9.3,            // meters, point → centerline
  "containsPoint": true,       // fix landed inside the buffered lane polygon
  "rateFirstHourUsd": 5.0,
  "rateAdditionalHourUsd": 8.25,   // 2nd-hour price (see data/build_zones.py)
  "maxStayMinutes": 120,
  "hours": [{ "days": ["Mon", "..."], "start": "08:00", "end": "19:00" }],
  "quote": Quote               // what this candidate would cost
}
```

Boston (`city: "bos"`) candidates price with a flat hourly rate (both rate
fields equal), and `providerZoneNumber` starts `""` — Analyze Boston
publishes no ParkBoston zone numbers, and ParkBoston's own web app has no
map to resolve them from (2026-09-21 recording: after login it shows only
an "Enter Zone" number field). Numbers come from drivers instead: the
first park at a block returns `needsZoneNumber: true`, the app collects
the posted number (`POST /zones/:zoneId/provider-number`), and every later
park at that block is automatic. (`providerZoneNumber` is the renamed
`parknycZoneNumber` — the `zones`/`sessions` columns are now
`provider_zone_number`.)

### Quote

Cost of the default stay in a zone, priced only over enforced minutes:

```json
{
  "zoneId": "nyc-110436",
  "providerZoneNumber": "110436",
  "stayMinutes": 90,        // min(policy.default_stay_minutes, zone max stay)
  "chargedMinutes": 90,     // minutes of the stay inside enforcement hours
  "meterUsd": 7.13,         // rate ladder applied to chargedMinutes
  "feeUsd": 0.15,           // the city's parking_fee_usd; 0 when meterUsd is 0
  "totalUsd": 7.28
}
```

Pricing: charged minutes consume the ladder in order — the first 60 at
`rateFirstHourUsd` (prorated), everything after at `rateAdditionalHourUsd`
(prorated). Minutes of the stay outside the zone's posted hours cost
nothing. A zone with `hours: []` (nothing posted) is treated as always
enforced. `respect_enforcement_hours: false` in policy also treats every
zone as always enforced. Rounding: half-up to the cent, once, on each of
`meterUsd`/`feeUsd`/`totalUsd`. `feeUsd` is per city: the zone's `city`
picks `policy.city_overrides.<city>.parking_fee_usd` (ParkBoston charges
$0.35 where ParkNYC charges $0.15).

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
| `needs_zone_number` | would auto-pay, but the zone's pay-by-app number is unknown (Boston, unreported block) | `confirm` | nearest only |
| `auto_pay_ok` | none of the above | `pay` | nearest only |

`needsZoneNumber` rides on every response (true whenever a payable
provider-covered zone has no stored number, whatever the rule); only an
`auto_pay_ok` outcome is downgraded to `confirm` by it.

Every `/parked` call writes a `decisions` row: `inputs` (request body,
pricing time and its source, radius, candidate zone ids, effective dry run,
policy hash), `rule`, `outcome` (action + quote).

Errors: `400` invalid body (zod details in `error`), `401` bad key.

---

## GET /city

`?lat=…&lng=…` — which city's meter system (and so which provider) covers
where the phone is. Onboarding's "Your city" step calls this; it reuses the
zone candidate lookup with a metro-scale radius (20 km), so the nearest
zone's city wins even from home, km away from a meter. Read-only — no
`parked_events` or `decisions` rows.

```json
{
  "city": "nyc",                       // zone-id prefix, or null
  "cityDisplayName": "New York City",  // null when city is null
  "provider": {                        // same shape as /parked's provider,
    "id": "parknyc",                   // plus cookieDomains for the app's
    "city": "nyc",                     // link web view; null when no
    "displayName": "ParkNYC",          // provider covers the city
    "loginUrl": "https://…",
    "cookieDomains": ["nyc.flowbirdapp.com", "flowbirdapp.com"],
    "signup": { "url": "…", "mode": "form", "note": "…", "prefill": [ … ] },
    "status": "linked",
    "linked": true
  }
}
```

`signup` is the link-or-create block (see "Provider accounts"), so
onboarding's Connect step can offer both doors and prefill the
provider's own page. `linked` is true for `expiring` accounts too — they
still pay.

Nowhere near any metered zone → `200` with all three fields null ("we're
not there yet"). Errors: `400` bad query, `401` bad key.

---

## GET /zones/near?lat&lng&radius

The map's curb layer: every metered zone whose centerline is within
`radius` metres of the point, with the geometry to draw it and the terms to
label it. `radius` is optional (default 250 m) and **capped at 400 m** — a
PostGIS read runs per call, so the window stays small and the route is
rate-limited at 60/min.

```json
{
  "radiusM": 250,
  "at": "2026-01-05T19:00:00.000Z",
  "truncated": false,
  "zones": [
    {
      "zoneId": "bos-boylston-st-e-d-819305",
      "city": "bos",
      "providerZoneNumber": "81234",
      "street": "BOYLSTON ST",
      "rateFirstHourUsd": 3.75,
      "rateAdditionalHourUsd": 3.75,
      "maxStayMinutes": 120,
      "distanceM": 12.3,
      "enforcedNow": true,
      "todayHours": [{ "start": "08:00", "end": "20:00" }],
      "hours": [{ "days": ["Mon"], "start": "08:00", "end": "20:00" }],
      "centerline": [[[-71.0812, 42.3502], [-71.0805, 42.3504]]]
    }
  ]
}
```

`centerline` is GeoJSON MultiLineString coordinates (`[[[lng, lat], …], …]`),
simplified to about 2 m — invisible at street zoom, and it keeps a few
hundred lines small on the wire. `enforcedNow` is what the map colors by
(paying now vs free now) and `todayHours` is what the tapped-zone card
shows; a zone with nothing posted reads as enforced all day, exactly as the
quote path treats it. `truncated: true` means the 150-zone ceiling was hit —
there is more metered street here than was returned.

Errors: `400` bad or missing coordinates (or `radius` over the cap), `401`
bad key, `429` rate limited, `501 {"error": "zone_geometry_unavailable"}` on
a deployment with no geometry fetcher wired.

---

## POST /zones/:zoneId/provider-number

The zone number the driver read off the meter — how Boston blocks get
their ParkBoston numbers (the open data has none; the app has no map).
`{"number": "81234", "source": "user"}` (`source` also takes `"scan"` for
a future sticker scan; `number` is 3–10 digits).

One report per (zone, user) — re-reporting replaces yours. The zone's
stored number becomes the latest report; it turns **verified** once two
different users agree on it. A number that is already verified stands
until a NEW two-user consensus replaces it — a single dissenting report
(a typo at the meter) is recorded but changes nothing, and cannot hand
the zone to a conflicting import either. Reports survive `load:zones`
reloads (no FK; the loader keeps non-empty numbers and rehydrates
re-created rows).

`200 {"ok": true, "zoneId": …, "number": "81234", "appliedSource":
"report" | "import" | "verified", "verified": false, "confirmations": 1,
"decisionId": …}` — `number` is what is now ON the zone (what the
executor will type), which under import/verified precedence can differ
from the reported one; clients must pay and display `number`, not their
input. Audited with a decisions row (kind `zone_number_report`) since it
changes what the executor will type at the provider. `400` bad number,
`404` unknown zone.

---

## POST /session/start

The money-moving path. Executes through the executor protocol
(`services/executor.ts`); with effective dry run on, that is the
DryRunExecutor, which logs and returns fake `dry-…` provider ids. Outside
dry run, the real executor — ParkNYC (Flowbird) or ParkBoston (Passport),
picked by the zone's city; both live in the Playwright package in
`executor/`, reached only through `services/parknycExecutor.ts` — runs
**on the caller's own linked provider account**: the account's sealed
cookie state is decrypted per call (`PROVIDER_STATE_KEY`) into a fresh
browser context on one warm shared Chromium process. No linked account, no
state key, or an unparseable state → the call fails typed
(`auth_expired`/`unknown`), it never falls back to someone else's session.
Executor error codes: `auth_expired`, `zone_not_found`,
`payment_declined`, `free_period` (the provider says the zone isn't
charging now — after-hours; the server records a free period with the
notice's parsed hours and pushes "parking is free", no session, no
charge), `payment_method_missing` (the provider account has no
saved payment method — the `payment_failed` push says "add a card to
ParkBoston" instead of offering a retry), `parking_denied` (the operator
blocked re-parking — a repark/zone lockout, ParkBoston's "Parking Denied"
popup after the confirm click; **no charge** — the provider refused before
authorizing, and the push says "wait or move the car", not "tap to pay"),
`ui_changed`, `network`, `browser_crashed` (Chromium died mid-call; the
executor already retried once on a fresh context), `unknown`.

On success the executor may also return the provider's **receipt** (meter /
fee / total) when the confirm/session screen lists it (ParkBoston does); a
start records those ACTUALS on the session and the `start_ok` decision
(`providerReceipt`), so the stored spend and the daily-cap accounting match
the card to the cent even when it differs from the pre-charge estimate
(ParkBoston sells in per-zone duration increments — see the acceptance
report, Job 2).

**Zone numbers.** Every start types a zone number at the provider, so a
provider-covered zone whose `provider_zone_number` is still `""` (a Boston
block nobody has reported yet) refuses `409 {"error":
"needs_zone_number", "zoneId": …}` before any session row or executor call
— the app collects the number first (`POST /zones/:zoneId/provider-number`).
The ParkNYC executor still runs its **non-fatal map cross-check** against
the stored number when the start carries the parked event's fix: both
sides land on the `start_ok` decision outcome as `zoneResolution`
(`{mapZoneNumber, mapStreet, storedZoneNumber, expectedStreet, matched}`).
Passport gets no such check — ParkBoston has no map.

The session row stores the zone's `city` at start; extension pricing (the
per-city fee) and the extension worker's ticket-risk math read it from the
session, not from re-reading the zones table.

Every executor call records its `durationMs` on the
`session_events` details and the `decisions` outcome; a `ui_changed`
failure also attaches `diagnostics` (page screenshot + visible text) to the
decision row. On any executor error the session stays unpaid (`failed`)
and the `payment_failed` push carries a tap-to-pay deep link.

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
| `free_period` | the whole stay prices to $0 (outside enforcement) — nothing to buy, and typing minutes into the provider anyway could charge money the quote never priced |
| `session_cap_exceeded` | purchase total > `session_cap_usd` |
| `daily_cap_exceeded` | real (non-dry-run) spend today + total > `daily_cap_usd` |

Other errors: `404` unknown/foreign `parkedEventId` or `zoneId`, `409
{"error": "session_already_active"}` (one open session per user — enforced
both by the pre-check and by a partial unique DB index, so two concurrent
starts can never both pay; a pending row orphaned by a crash is swept to
`failed` after 10 minutes), `409
{"error": "provider_not_linked", "provider": "parknyc", "displayName":
"ParkNYC"}` when the zone's city has a provider and the caller has no
account with status `linked` there (dry run included — the executor pays
through the user's own account now, see "Provider accounts"), `409
{"error": "needs_zone_number", "zoneId": …}` when the zone's pay-by-app
number is still unreported (see `POST /zones/:zoneId/provider-number`),
`502 {"error": "executor_failed", "code": …}` — the session row is marked
`failed` and a `payment_failed` push is sent. An `auth_expired` executor
failure also flips the provider account to `expired` and sends a
`provider_relink` push.

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
When the provider answers with its "No Meter Parking" notice, the reply is
`409 {"error": "free_period", "notice"}` — a hold, not a failure: the
session keeps its time, the event/decision are `free_period`, and the push
says parking is free (never a tap-to-pay). The auto-extend worker records
the same as `rule: "free_period"`, `action: "hold"`.

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

## GET /me/payment-source · PUT /me/payment-source

Which source pays the caller's sessions. `GET` →
`{"paymentSource": "provider_card" | "issuing_card", "issuingLive": false}`;
`PUT {"paymentSource": …}` switches it (Settings; onboarding's "How do you
want to pay" step). Values:

- `provider_card` (default for every user) — the card already saved on the
  user's own ParkNYC/ParkBoston account. Onboarding skips card setup and
  funding entirely, and provider linking skips the chained setup-card and
  its consent gate (the account's payment method is never touched).
- `issuing_card` — the ParkAgent Issuing card. Selectable only while the
  `ISSUING_LIVE` env flag is `true`; otherwise `PUT` refuses
  `409 {"error": "issuing_not_live"}` and the app shows "coming soon".

Sessions snapshot the user's source at start (`sessions.payment_source`),
and it rides on `session_start` decision inputs. The session and daily caps
apply to **every** source — the choice moves where the charge lands, never
what is allowed. `shadow_mode` is independent of the source: it only adds a
Stripe test authorization alongside real spends. Every `PUT` writes a
`decisions` row (kind `payment_source`).

## POST /device

`{token, platform: "ios", environment: "development" | "production"}` →
`{ok: true}`. Registering is idempotent (the app re-sends on every
launch; `environment` picks the sandbox or production APNs host), but the
token is **bound to the first registering user**: another account
presenting it gets `409 {"error": "token_bound_elsewhere"}` instead of
silently taking over the push channel. A token Apple reports dead (410)
is deleted.

## DELETE /device

`{token}` → `{ok: true}`. Releases the caller's own binding (sign-out, or
handing the handset to the other tester — who can then register it).
`404 token_not_found` when the token isn't bound to the caller. Deleting
a user cascades their bindings at the database level.

### Push notification types

Pushes carry a standard `aps` payload plus `{"type": ...}`, one of:

- `session_started` — the server paid a meter (dry run says "would have paid")
- `session_extended` — auto-extend (or a manual extend) bought more time
- `session_expiring` — expiring soon and auto-extend will not fire; carries
  `reason`: `"max_stay"` (move the car), `"budget"` (a cap would be hit),
  or `"no_auto_extend"` (disabled or max_count used up)
- `payment_failed` — a pay or extend attempt failed; the meter is unpaid;
  carries `code` (executor error code)
- `provider_relink` — the linked provider session died (`auth_expired`);
  carries `provider` and a deep link into the app's link flow, `zoneNumber`, and `deepLink`
  (`parkagent://pay?zone=<zone>` — tap-to-pay fallback with the zone
  prefilled)

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

Redelivery is idempotent: a replayed `.request` answers the recorded
decision (deciding twice could flip the answer once spend moved) and its
decisions row records `replayed: true`; a `.request` retry that arrives
after a lifecycle `.created` already created the row (decision
`"external"`) decides for real and updates that row in place.

### Ledger events

`issuing_authorization.created` / `.updated` upsert the
`issuing_authorizations` row (lifecycle `status`, held amount); an
authorization first seen this way is stored with `decision: "external"`.
`issuing_transaction.created` attaches the settled capture
(`stripe_transaction_id`, `captured_usd`) to its authorization row.
`payment_intent.succeeded` for an intent tagged `parkagent=card_topup`
moves the settled amount onto the financial account (see
`POST /card/funding/topup-intent`). Other event types are acknowledged and
ignored.

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

### Card lifecycle

The card is created **lazily** — not at signup, but when the user reaches
the app's "Link provider" step (`POST /card/prepare`). Our DB status then
reads `pending_onboarding` (the Stripe card itself is active; the overlay
is ours and `GET /card` never re-mirrors it away) until
`POST /providers/:provider/setup-card` puts the card on the provider
account, which graduates it to `active`.

Abandoned onboarding is reaped by a daily in-process janitor
(`jobs/cardJanitor.ts`): a `pending_onboarding` card older than 7 days
whose user has **never** linked a provider is canceled on Stripe, and its
cardholder — if left with no live cards — is deactivated and dropped, so a
returning user just gets a fresh card from the next `/card/prepare`. A
card that has ever transacted is **never canceled** (its authorizations
must keep resolving) — it is frozen instead. Every sweep action writes a
`decisions` row (kind `card_janitor`).

### POST /card/prepare

Idempotent lazy creation: an existing non-canceled card is returned as-is
(`created: false`); otherwise the cardholder (if needed) and one virtual
card are created with spending controls from the current policy, and a
`decisions` row (kind `card_prepare`) is written.

```json
{ "created": true, "card": { "stripeCardId": "ic_…", "last4": "7777", "status": "pending_onboarding" } }
```

### GET /card

The user's virtual card summary. With no card yet (`/card/prepare` hasn't
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

### POST /card/funding/topup-intent

Apple Pay top-up, step 1: `{amountUsd}` → a Stripe PaymentIntent the app
confirms client-side with the Apple Pay sheet.

- Policy gate: a single top-up may not exceed `daily_cap_usd`
  (`409 amount_over_daily_cap`).
- **Dry run**: `200` with a fake secret
  (`{"clientSecret": "pi_dryrun_…", "paymentIntentId": null, "dryRun": true}`)
  — no PaymentIntent exists and nothing can ever charge; the decisions row
  (kind `card_topup_intent`, rule `dry_run`) records the refusal.
- Real: `200 {"clientSecret": "pi_…_secret_…", "paymentIntentId": "pi_…", "dryRun": false}`,
  intent metadata `parkagent=card_topup` + `userId`.

Step 2 is the webhook: on `payment_intent.succeeded` for a tagged intent,
the server moves the settled amount onto the financial account backing the
cards (test mode: the sandbox ACH-credit helper) and writes a `decisions`
row (kind `card_topup_funded`). Idempotent against Stripe redelivery: a
processed intent is recorded in `processed_topups`, so a second delivery
is acknowledged (decision rule `replayed`) without moving funds again; a
FAILED move records nothing, so redelivery retries it.

**Apple Pay setup (one-time, Stripe dashboard + Apple):** native in-app
Apple Pay needs (1) an Apple **merchant ID** (e.g.
`merchant.com.thomasbardhi.parkagent`) in the Apple Developer portal and
the Apple Pay capability on the app ID; (2) in the Stripe Dashboard →
Settings → Payments → **Apple Pay** → iOS certificates: download the CSR,
create the payment-processing certificate against it in the Apple portal,
and upload the certificate back to Stripe; (3) only if a web flow is ever
added: register the domain on the same dashboard page. The iOS app then
uses the merchant ID with PassKit/Stripe when confirming the intent.

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

## Provider accounts

Per-user linked accounts at the parking operators, replacing the old
single-secret executor auth and laying the multi-city foundation. The
registry (`src/providers/registry.ts`) maps city → provider — `nyc` →
`parknyc` (Flowbird), `bos` → `passport` (ParkBoston, Passport's
white-label web app at `bostonma.ppprk.com/park/` — sign-in is
passwordless: T&C accept, e-mail/phone code, 4-digit PIN), anything else →
none — with each provider's display name, login URL for the app's web
view, and the cookie domains that constitute a session (`ppprk.com` and
`paywithpassport.com` for ParkBoston).

Each registry entry also carries a `signup` block — the **link-or-create**
metadata for a user who has no provider account yet:

```json
"signup": {
  "url": "https://bostonma.ppprk.com/park/",
  "mode": "passwordless",
  "note": "Sign in or sign up on ParkBoston's own page — we never see a password; there isn't one.",
  "prefill": [{ "field": "emailOrPhone", "selector": "#regEmail" }]
}
```

`mode` is `passwordless` (ParkBoston: one screen for both sign-in and
sign-up — T&C accept, an emailed/texted code, then a 4-digit PIN) or
`form` (ParkNYC's registration panel). `prefill` tells the app which
profile values to type into which inputs on the provider's own page, so
nobody enters their name, email, phone, ZIP, or plate twice.

**The limits are the point.** The app fills **text inputs only**, only
ones that are still **empty**, and never submits. It never ticks a terms
checkbox, never answers a verification code or PIN, and never touches a
captcha — the user is present on the provider's page and finishes it.
Provider accounts are never created without the user, and provider
passwords are never stored (ParkBoston has none at all). ParkNYC's
selectors are DRAFTED against the recorded panel's naming convention and
marked TODO-verify; `test/fixtures/signup/*.html` and
`test/registrySignup.test.ts` hold the registry and the fixtures together
so a live recording can't update one without the other.

Session state (the cookies the app captures after the user signs in inside
the web view) is sealed with AES-256-GCM under the `PROVIDER_STATE_KEY`
secret and stored in `provider_accounts`; it is never logged and never
returned by any endpoint. Generate a key with `openssl rand -base64 32`;
set it with
`fly secrets set -a parkagent-api PROVIDER_STATE_KEY="$(openssl rand -base64 32)"`.
Rotating the key invalidates stored states — accounts fail `auth_expired`
and users re-link. Without the key (or on a server without the executor),
linking answers `503 {"error": "provider_linking_not_configured"}`.

### POST /providers/:provider/link

```json
{
  "cookies": [ { "name": "…", "value": "…", "domain": ".nyc.flowbirdapp.com", "path": "/", "expires": 1790000000, "httpOnly": true, "secure": true, "sameSite": "Lax" } ],
  "set_up_card": true,                      // default true: chain setup-card
  "consent_replace_payment_method": true    // REQUIRED true when set_up_card
}
```

Cookies are filtered against the provider's registered domains — anything
else is dropped at the door; none left → `400 no_session_cookies` (with
`expectedDomains`). With `set_up_card` and no explicit consent →
`400 consent_required`, before anything runs. The chained setup-card only
runs for **issuing_card** users (see `/me/payment-source`): with the
`provider_card` default, sessions pay with whatever payment method the
account already has, so the consent requirement doesn't apply and `jobId`
is always `null`; the link decision records
`setUpCard: false, paymentSource: "provider_card"`. (Shadow mode no longer
affects linking — it only adds a test authorization alongside real
spends.) The surviving cookies are
verified headlessly (the executor loads the provider's account page); a
sign-in screen → `409 {"error": "verification_failed", "code": "auth_expired"}`.
On success the sealed state is upserted (`status: "linked"`) and:

```json
{ "status": "linked", "walletBalanceCents": 1250, "cardBrand": "Visa", "cardLast4": "4242", "jobId": "…" }
```

`cardBrand`/`cardLast4` are the card the **provider account already has
on file**, read from its Your Cards screen at link time so the app can
show which card will actually be charged ("Visa •••• 4242"). Read only
for `provider_card` users (issuing_card users are having ours installed
instead), best effort — a failed read stores nulls and never blocks the
link — and display-only: the PAN is never requested, returned, or
stored. The decision records presence only (`savedCardSeen`), never
digits.

`jobId` is non-null when `set_up_card`: verification passed, so the card
setup runs immediately as a background job (the executor takes seconds).
Every link attempt writes a `decisions` row (kind `provider_link`) whose
inputs carry only cookie counts and domains — never values.

### GET /providers/:provider/link-status?jobId=…

The chained job's phase: `linking → adding_card → done | failed` (jobs
currently start at `adding_card` — verification happens inside the link
request itself). On failure it carries a typed `reason`
(executor code, `unsupported_card_brand`, or `no_card`) and `retrySafe`:
whether re-running `POST /providers/:provider/setup-card` as-is is worth
it (transient failure) or something needs fixing first (re-link, different
card). `dryRun: true` marks a job that "completed" by dry-run skip. Jobs live in the link_jobs table (deploy-safe); a janitor times out rows stuck past 15 minutes. `404 unknown_job` for ids that aren't
yours.

### GET /providers/status

Every registry provider merged with the caller's account:

```json
{ "providers": [ { "id": "parknyc", "city": "nyc", "cityDisplayName": "New York City", "displayName": "ParkNYC", "loginUrl": "https://…", "cookieDomains": ["nyc.flowbirdapp.com", "flowbirdapp.com"], "signup": { … }, "status": "linked", "linkedAt": "…", "lastVerifiedAt": "…", "cardAdded": true, "cardBrand": "Visa", "cardLast4": "4242", "walletBalanceCents": 1250 } ] }
```

`cookieDomains` is the registry's session-domain list — the app's link web
view watches them to know when the user has signed in before capturing
cookies. `signup` is the link-or-create block described above.

`status` is `linked` | `expiring` | `expired` | `unlinked`. **`expiring`
still pays** — the health job saw the session cookies dying soon and
asked for a reconnect early; everything that accepts `linked` accepts it
too (`providerStatusUsable` in the registry). Only `expired` and
`unlinked` refuse.

### POST /providers/:provider/setup-card

Puts the user's Issuing card on the provider account as its payment
method. The executor fills the payment form with number/expiry/CVC
retrieved server-side from Stripe (expand `number`,`cvc`) and selects the
card-type radio from the Stripe **brand** (the card-brand fix; an
unmapped brand → typed `unsupported_card_brand`). The values never appear
in logs or decisions and are blanked after submit. On success the card
graduates `pending_onboarding → active` and the account records
`cardAdded`.

- Dry run: the provider is never touched; `200 {"ok": true, "dryRun": true}`
  and the decisions row (kind `provider_setup_card`, rule `dry_run`)
  records `wouldAdd: true`.
- `409 provider_not_linked` / `409 no_card` (run `/card/prepare` first) /
  `502 {"error": "setup_card_failed", "code": …, "retrySafe": …}`.

### POST /providers/:provider/unlink

Unlinks and clears the sealed state. Best effort first: while the cookies
still work, the executor removes our card from the provider account
(failure never blocks the unlink; the outcome lands in the decisions row).
If the user has **no other linked provider**, the Issuing card is frozen —
never canceled: a card that has transacted keeps its ledger, and a
re-link simply unfreezes-by-setup later.

`200 {"ok": true, "cardRemoval": "removed" | "failed:…" | "skipped", "cardFrozen": true}`;
`404 not_linked` when there is nothing to unlink. The stored display card
(`cardBrand`/`cardLast4`) is cleared too.

### Provider session health (daily job)

Not an endpoint: an in-process job (`jobs/providerHealthTick.ts`) verifies
every `linked`/`expiring` account headlessly once a day, so a dead or
dying provider session is fixed on the couch rather than discovered at the
curb. It also runs 30 s after every boot, and a pass skips any account
verified in the last 20 hours — so a day of deploys neither re-verifies
every session against the provider's site nor repeats the same
"Reconnect" push once per restart. Per account:

| Outcome | Condition | Effect |
|---|---|---|
| `verified` | cookies work, expiry far off | `lastVerifiedAt` refreshed; an `expiring` account that recovered returns to `linked` |
| `expiring` | cookies work, but the earliest cookie expiry is **within 5 days** | status → `expiring` (still pays) + a `provider_relink` push ("Reconnect ParkBoston") carrying the deep link |
| `expired` | `auth_expired`, no stored state, or state that won't decrypt (rotated key) | status → `expired` + the same push |
| `check_failed` | any other executor error (`network`, `ui_changed`, …) | **nothing changes** — a transient failure is not evidence the session died; tomorrow's run retries |

Cookies with no expiry at all (session cookies) never trigger the warning
— they die with the browser, not the clock. Every outcome writes a
`decisions` row (kind `provider_health`): the check decides whether to
nag a human, and nags must be auditable.

### POST /providers/:provider/topup

`{amountUsd}` → top up the provider wallet from the card on file, through
the executor. Policy-gated and audited like every money move (kind
`provider_topup`): single move ≤ `daily_cap_usd`
(`409 amount_over_daily_cap`), dry run refuses (`409 dry_run`,
`wouldAllow: true`), executor failures come back typed
(`502 {"error": "<code>", …}`; `auth_expired` also expires the account and
pushes `provider_relink`). Success returns and stores the fresh
`walletBalanceCents`.

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

**Admin only** (`403 forbidden` otherwise): the policy is the shared
spending contract — caps, dry_run, the rate ceiling — so changing it is
the owner's call; `GET /policy` stays open to every user (the app renders
it, and onboarding's budget step simply reports "couldn't save" on 403).
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
  "shadow_mode": false,
  "session_cap_usd": 45,
  "daily_cap_usd": 60,
  "auto_pay_max_rate_per_hour": 8.0,
  "default_stay_minutes": 90,
  "auto_extend": {
    "enabled": true,
    "max_count": 2,
    "max_minutes_each": 60,
    "no_extend_within_minutes_of_max_stay": 15
  },
  "respect_enforcement_hours": true,
  "ticket_cost_usd": 65,
  "city_overrides": {
    "nyc": { "parking_fee_usd": 0.15, "ticket_cost_usd": 65 },
    "bos": { "parking_fee_usd": 0.35, "ticket_cost_usd": 40 }
  }
}
```

`city_overrides` is optional, keyed by `"nyc"`/`"bos"`, and each field is
optional. `parking_fee_usd` is the city provider's pay-by-app fee and lives
only here; a missing `ticket_cost_usd` falls back to the top-level one.

A deprecated top-level `parknyc_fee_usd` is still accepted for one release
and still serves as the fee fallback, so documents written before the move
keep validating. Migrate one with

    pnpm -C server migrate:policy-fee            # repo-root policy.json
    pnpm -C server migrate:policy-fee -- --file /path/to/policy.json

which copies the value into every city that lacks its own
`parking_fee_usd`, then drops the key. Quotes, session starts/extensions, and the extension
worker all price per city now: sessions store their zone's `city` at start,
so the worker's ticket-risk math uses that city's `ticket_cost_usd` (a $40
Boston ticket argues for extension less strongly than a $65 NYC one).

`shadow_mode` (optional, default false) is the rehearsal switch for a new
city, **independent of the payment source**: every session start and
extension **also** fires a Stripe test-mode Issuing authorization for the
same amount at the user's virtual card, so the webhook, budget checks, and
ledger run in parallel with the real spend. (Which card the provider
charges is the payment-source setting's job — see `/me/payment-source`;
shadow mode no longer changes how linking behaves.) The shadow result lands on the decision outcome (`shadow:
{fired, authorizationId, approved, amountUsd}` — or `{fired: false,
reason}`) and `pnpm -C server decisions:recent` prints it. Shadow mode
never bypasses the dry-run switches: the executor leg still moves money
only when both are false; the shadow authorization itself is always
test-mode money (`services/shadow.ts`).

The server validates and snapshots (`source: "boot"`) at boot, and refuses
to start on an invalid file.

---

## GET /health

No auth. `{ok, dryRun, commit, builtAt}`.

---

## POST /admin/push-test

Auth-gated and **admin only**. Sends a representative sample of each push
type to the caller's own registered devices and reports the APNs response
per device — the field-test "did notifications actually arrive?" check.
Moves no money and writes no decisions.

Body (optional): `{"types": ["session_started", …]}` to send a subset;
omitted → all five documented user-facing types (`session_started`,
`session_extended`, `session_expiring`, `payment_failed`,
`provider_relink`). `503 {"error": "apns_not_configured"}` when the APNs
credential set is incomplete.

```json
{
  "configured": true,
  "anyDevices": true,
  "allAccepted": true,          // every delivery returned APNs 200
  "sent": [
    {
      "type": "session_started",
      "configured": true,
      "deviceCount": 1,
      "results": [
        { "tokenPrefix": "a1b2c3d4", "environment": "development",
          "status": 200, "reason": null, "deleted": false }
      ]
    }
  ]
}
```

`status` is the APNs HTTP status (200 = accepted); `reason` carries APNs's
`reason` string on a non-200 (e.g. `"BadDeviceToken"`, `"Unregistered"`),
and a 410/BadDeviceToken deletes the dead token (`deleted: true`) exactly
as the live sender does. Only the token's 8-char prefix is returned — a
device token is a credential.

## GET /admin/summary

Auth-gated like everything else (`x-api-key`) and **admin only**
(`403 forbidden` for non-admin keys). The field-test dashboard:
today's activity (NYC calendar day) aggregated from the
decisions/parked_events/sessions tables, per city. Read-only.

```json
{
  "since": "2026-09-21T04:00:00.000Z",
  "now": "2026-09-21T18:00:00.000Z",
  "dryRun": true,
  "policyHash": "sha256:…",
  "cities": {
    "nyc": {
      "parks": 4,                  // parked_quote decisions
      "unknownZone": 1,
      "sessionsStarted": 2,        // sessions rows (non-failed)
      "sessionsFailed": 0,
      "extensionsAuto": 1,         // extend_tick rule "extend"
      "extensionsManual": 0,       // session_extend rule "extend_ok"
      "declines": { "daily_cap_exceeded": 1, "declined_wrong_mcc": 1 },
      "executorErrors": { "ui_changed": 1 },
      "shadow": { "fired": 2, "approved": 2, "declined": 0, "missed": 0 },
      "spendUsd": 14.56            // meter + fees on today's sessions
    }
  },
  "detectorSignals": { "motion_stop": 4, "audio_disconnect": 3, "location_settled": 4 },
  "decisionCount": 23
}
```

A decision's city comes from its session's stored `city`, the quoted
zone's id prefix, or the first candidate; unattributable rows land under
`"unknown"`. Every decisions row also emits one structured log line
(`{"decision": {id, kind, rule, userId, sessionId, parkedEventId}}`) —
identifiers and the rule only, never inputs/outcome (those can carry
ui_changed screenshots).

---

## Assistant

The conversational surface: one Claude tool-use loop (model from the
`ANTHROPIC_MODEL` env var, default `claude-haiku-4-5-20251001`) that
does exactly two jobs — find one spot, or plan
a multi-stop day. The MODEL plans and phrases; the TOOLS enforce policy
(same quoting, caps, and audit services as everything else); **nothing
books or spends without the user's explicit Confirm/Sign off tap on a
plan card**, which is the only thing that mints the single-use
confirmation token the consequential tools demand. Requires
`ANTHROPIC_API_KEY` (else 503). Every tool call, plan, and confirmation
writes a decisions row (kinds `assistant_tool`, `assistant_plan`,
`assistant_confirm`).

### POST /assistant/message

`{text | transcript, conversation_id?, location?{lat,lng}}` → one
assistant turn. With `Accept: text/event-stream` the reply streams as SSE
(`text` events carry `{delta}`, one final `done` event carries the full
payload); otherwise plain JSON:

```json
{
  "conversationId": "conv_…",
  "reply": "Street is cheapest — here are your options.",
  "plan": { "planId": "…", "plan": { "kind": "single_spot", "options": [ … ] } } | null
}
```

Conversation state persists per user (last 20 turns) keyed by
`conversation_id`. Rate-limited 20/min — each turn is a paid model call.

The model's tools: `geocode_place(query, city?)` — resolve a NAMED place
or area (a street, neighborhood, or landmark) to coordinates, biased hard
to the two cities we cover (NYC and Boston) so "Newbury Street" lands in
Back Bay, not Ohio; the model calls it FIRST for any named area and quotes
at the returned point instead of the phone's location, and results outside
both metros' bounding boxes are dropped (found:false rather than a wrong
fallback). Requires a geocoder (Nominatim; without one the tool answers
`geocoding_unavailable`). `search_garages(area, window, budget, within_m?)`
— pass `within_m: 600` for a named-area search so every option is
walkable from the place; farther options are dropped and counted
(`droppedForDistance`). `quote_street(lat, lng, duration, when)` — now
applies provider-observed terms (`zone_terms_observed`) the same way
`/parked` and session start do, so a named-area quote matches what the
curb actually charges (result carries `termsSource: "observed"` when a
driver-reported term overrode the dataset). `build_itinerary(stops[])`,
`propose_plan(plan)` (ends the turn with the structured plan),
`book_garage(option_id, confirmation_token)` and
`start_session(zone, duration, confirmation_token)` (REFUSED without a
live token), `get_history(days)`, `explain_decision(id)` (plain-language
rendering of a decisions row via `services/explanations.ts`).

Plan shapes (zod-validated at the tool boundary — see
`services/assistant/plans.ts`): `single_spot` is ≤3 options (street or
garage; price, walk minutes, entry type, exactly one `recommended`);
`itinerary` is 1–12 stops (address, arrival, duration, street|garage
choice, cost) with `totalUsd` recomputed server-side and refused when it
busts the remaining daily budget.

### POST /assistant/confirm

`{planId, optionId?}` — the tap. Mints the single-use token
(10-minute TTL) and executes the confirmed option through the same
token-gated tools the model faces:

- garage option → `{kind: "garage_handoff", deepLink, paymentSource,
  linkApproval?, note}` — the app opens the SpotHero deep link in
  SFSafariViewController; the pass lives in SpotHero. We NEVER automate
  SpotHero login or checkout.
- street option → `{kind: "street_confirmed", zoneId, providerZoneNumber,
  durationMinutes, paymentSource, linkApproval?}` — the session itself
  starts through the existing detector → /parked → /session/start flow at
  the curb. `providerZoneNumber` is the pay-by-app number (null when the
  zone has none yet); `zoneId` is the internal slug and is not for display.
- itinerary (no optionId) → `{kind: "itinerary_signed_off", itineraryId,
  totalUsd, capUsd, paymentSource, linkApprovals[]}` — the day total is
  re-checked against `daily_cap_usd` at the moment of sign-off.

### GET /assistant/itineraries · PATCH /assistant/itineraries/:id

Signed-off days (last 10) and stop editing/reordering. A PATCH re-checks
the cap and preserves per-stop linkage (attached session ids, pushed
garage links, payment source) across the edit. The itinerary worker
(60 s) pushes each garage stop's deep link 15 minutes before arrival
(`itinerary_garage_link` push), attaches street sessions that start
inside a stop's window, and marks the day `done` when the last window
passes.

### SpotHero (garage provider)

`services/garage/` — a provider-agnostic `GarageProvider` interface with
one implementation today: **SpotHeroDeepLinkProvider** (read-only search
over the public search endpoint, 10-minute cache, ≤8 options; checkout
is a prefilled deep link the user finishes in SpotHero). **Partner
status: no API key.** When SpotHero Partner API access arrives, a
`PartnerApiProvider` implements the same interface and exactly three
things change: `canReserve` flips true, `book()` returns
`{kind: "reserved", confirmationId}` instead of a deep-link handoff, and
the confirm response stops saying "the pass lives in SpotHero". The
adapter also carries the documented **Shared Payment Token seam**
(`garageProvider.ts`): if a garage provider ever accepts Stripe SPTs, the
reserved-booking path is where an SPT checkout would go — no parking
provider accepts them today (2026-09), so it stays a comment, not code.

## Link wallet for agents

Stripe's Link CLI/agentic-commerce surface
(docs.stripe.com/agentic-commerce/link-cli) as a second payment source
for assistant plans. `PaymentSource` on sessions and bookings:
`provider_card` (the user-level default — see `/me/payment-source`) |
`issuing_card` (autonomous street parking on the ParkAgent card, when
`ISSUING_LIVE`) | `link_wallet`.

**Verified against the docs (2026-09-21):**

- OAuth (hosted agent, confidential client — registered through Stripe
  sales): authorize `https://login.link.com/auth` with PKCE S256 +
  `state`, scopes `payment_methods.agentic userinfo:read`, `key` = the
  Stripe publishable key; token exchange/refresh/revoke at
  `login.link.com/auth/token` / `/auth/revoke`. Access token 1 h;
  refresh token 1 year, ROTATED on every use (the wallet persists the
  new one each refresh).
- **No batch approval exists.** A spend request carries ONE amount and
  ONE merchant; a multi-stop plan therefore creates one request (and one
  customer approval at its `approval_url`) per paid stop. Limits per
  agent integration: $500/request, $500/day, 30 concurrent active, 10
  concurrent approved, 50 creations/hour, 10-minute approval window.
- The approved credential is a **one-time-use virtual card**, valid
  until `valid_until` = **12 hours from spend-request creation**, and it
  is **not merchant-locked** ("works at any seller that accepts cards
  online") — so nothing blocks it at ParkNYC, Passport, or SpotHero card
  forms. `context` must be ≥100 characters and is shown on the approval
  screen.
- Test mode: spend requests carry `test: true` (`LINK_TEST_MODE`), Link
  returns test credentials (e.g. `4000009990001984`) and nothing
  charges.

**Unverified — needs the registered OAuth client + sandbox:** the raw
REST paths under `api.link.com` that `link-cli spend-request …` wraps are
not publicly documented; `services/link/linkClient.ts` mirrors the CLI
contract behind `LINK_API_BASE` and is marked VERIFY-IN-SANDBOX.

Endpoints: `GET /link/status`, `POST /link/connect` (returns the
authorization URL), `GET /link/callback` (public — the OAuth redirect;
`state` binds it to the user), `POST /link/disconnect`,
`POST /link/spend-requests/:id/sync` (the app polls after an approval;
on approval the one-time card is SEALED server-side with
PROVIDER_STATE_KEY crypto and never returned).

Flow: policy `link_wallet_for_plans` (default true) + a connected wallet
→ plan confirmation creates the spend request(s) and the Confirm tap
deep-links into the Link approval; at pay time the executor seam asks
`usableCardForStop` — an approved, unexpired, unused card pays as
`link_wallet`; an expired (12 h) or missing card **falls back to the
Issuing card and the user is told**. The daily cap applies across BOTH
sources (plans count into the same `daily_cap_usd` check). Env:
`LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `LINK_PUBLISHABLE_KEY`,
`LINK_REDIRECT_URI` (all four or none), optional `LINK_TEST_MODE`.
