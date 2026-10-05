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
   created with `pnpm -C server create:user --name <name>`, printed
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
{ "identityToken": "eyJ…", "authorizationCode": "c…", "deviceId": "…", "fullName": {"givenName": "Thomas", "familyName": "B"} }
```

`authorizationCode` (optional; the same sign-in's one-time, 5-minute
code) is exchanged at Apple's `/auth/token` for a refresh token, stored
**sealed** (`users.apple_refresh_token_sealed`, AES-256-GCM under
`PROVIDER_STATE_KEY`) so `DELETE /me` can revoke it — App Store Review
5.1.1(v). The exchange authenticates with a client secret: an ES256 JWT
signed with the Sign in with Apple key (`APPLE_SIGNIN_KEY`,
`APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_TEAM_ID`; `sub` = `APPLE_AUDIENCE`).
It never affects the sign-in: without the key group nothing is exchanged,
a code whose `sub` isn't the verified identity's is never stored, and a
failed exchange is recorded (`auth_identity`, rule
`apple_code_exchange_failed`) and retried on the next sign-in. A
carried-over account (`attach-identity`) gets its token the first time
its owner signs in with Apple.

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

**A lost answer is not reuse.** The server rotates, and the answer carrying
the successor dies in a tunnel, so the phone asks again with the token it
still holds. Within 60 s of the rotation (`REFRESH_REUSE_GRACE_MS`), from
the same device, and only while the successor has never been used, the
server retires that undelivered successor (revoked, so presenting it later
is `invalid_token`) and issues a new one. Before this, the honest retry
read as theft and signed the user out. Anything else (another device,
later, a successor that was used) is still `token_reused`, and the family
dies.

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

`GET` → `{user, paymentSource, issuingLive}` — `paymentSource` is the
Wallet's active way to pay (`provider_card` | `link_wallet` |
`parkagent_card`; see "Wallet"), so the Account sheet and the Wallet read
the same fact. `PATCH {name?, phone?}`
edits the profile and returns `{user}`. Changing the phone clears
`phoneVerified` (there is no SMS verification flow yet). The email is
**not** editable here: it is the sign-in identity, and moving it needs
its own verification flow.

### DELETE /me

Irreversible; the app confirms in two steps. In order:

1. any ParkAgent card **frozen, never canceled** — a card that has
   transacted must keep resolving its authorizations — and the Stripe
   **Customer deleted**, which takes the user's saved funding cards with
   it. First, because these are the steps that call out: a Stripe failure
   answers `500` with the account untouched and the delete safely
   retryable;
2. funding-method rows marked removed; the Link wallet disconnected (its
   refresh token revoked, best effort, and the sealed tokens erased);
3. refresh tokens deleted (every device signs out) and device tokens
   deleted (push channels released);
4. provider accounts unlinked and their **sealed cookie state erased**;
5. vehicles and assistant conversations deleted (sessions detach from
   the vehicle but remain — they are the money audit); then the **Sign in
   with Apple token revoked** at Apple's `/auth/revoke` (App Store
   5.1.1(v)), which never blocks the delete: if Apple fails (or the key
   isn't configured yet) the sealed token stays on the tombstone and a
   job (`jobs/appleRevocationTick.ts`) retries with backoff — 1 h,
   doubling, at most a day apart — and gives up after 8 attempts (or at
   once when the sealed token can't be opened), dead-lettering the row
   (`apple_revoke_dead_at`, listed in `/admin/summary`) for a person —
   every attempt a `decisions` row. The schedule lives on the users row,
   so a restart neither loses nor repeats a retry;
6. the `users` row is **tombstoned**: name becomes "Deleted account",
   `email`/`phone`/`apple_sub`/`google_sub`/api-key/`stripe_customer_id`
   columns are nulled (and the sealed Apple token, once revoked), the
   payment source reset, and `deleted_at` is stamped.

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

Phone-detected park. Runs zone lookup → policy check → place
classification, writes a `parked_events` row and **always** writes a
`decisions` row, then returns what the app should do.

Request:

```json
{
  "lat": 40.7784,            // WGS84
  "lng": -73.9818,
  "accuracy": 12.5,          // horizontal accuracy, meters
  "ts": "2026-09-20T14:03:22-04:00",   // optional: when the phone detected the park
  "signals": ["motion_stop", "bt_disconnect"],  // free-form detector evidence
  "placeHint": { … },        // optional: the phone's own read of the place (below)
  "outcomes": ["garage", "nopay"]   // optional: the place outcomes this app can show
}
```

`outcomes` (FR-54) lists the actions beyond the street's four that the app
knows how to show. **An app that lists none is answered exactly as before**:
`action` stays one of `pay | confirm | ignore | unknown_zone` with the
street rules below, hint or no hint. Shipped builds decode `action`
strictly, so the new actions go only to an app that asks for them. Anything
that isn't a list of the known outcomes is none listed.

`placeHint` (FR-53) is what the app's on-device place classifier made of
the park. The server weighs it with what only it knows (the metered zones
in reach, the garage outlines as loaded today); see "The place" below. It
is read leniently: a hint of the wrong shape is no hint, and never a 400.
The decision records it under `inputs.place.hint` (`inputs.body` is the
request without `placeHint` and `outcomes`).

```json
"placeHint": {
  "class": "garage",         // street | garage | lot | nopay | unknown
  "confidence": 0.95,        // the class's score, 0–1 (0 for unknown)
  "runnerUp": { "class": "nopay", "confidence": 0.3 },  // next best (for unknown: the best guess)
  "garageId": "…",           // the footprint, when the class is garage or lot
  "entryFix": { "lat": 42.347, "lng": -71.082, "accuracy": 9, "ts": "2026-09-28T14:01:36Z" },
                             // the last good fix of the car driving in
  "inputs": {
    "located": false,        // false: no fix at the spot (GPS gone); lat/lng are
                             // then the entry fix, and no street is quoted for it
    "memoryHit": false,      // one of the driver's saved places matched —
                             // their names and locations never leave the phone
    "footprintId": "…",
    "containsPoint": true,
    "nearestEntranceM": 8,
    "gpsLoss": true,         // GPS went bad on the way in and stayed bad
    "baroDeltaM": 6.5,       // barometer climb over the stop window, meters
    "crawl": true            // a 30 s parking-lot crawl before the stop
  }
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
  "action": "pay",           // "pay" | "confirm" | "ignore" | "unknown_zone",
                             // and "garage" | "nopay" for an app that lists them
  "candidates": [ Candidate, ... ],
  "quote": Quote | null,     // null when no zone is in reach
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
  "place": {                 // what kind of place this is (FR-54, below)
    "class": "street",       // street | garage | lot | nopay | unknown
    "confidence": 0.9,       // the class's score, 0–1 (0 for unknown)
    "runnerUp": null,        // the next best {class, confidence}; for
                             // unknown, the best guess, which fell short
    "garageId": null,        // the garage or lot in play, from the garages table
    "garageName": null,
    "source": "zones",       // memory | hint | footprint | zones | none
    "attribution": null      // the line the garage's source asks for
                             // wherever its name is shown
  },
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
| `daily_cap_exceeded` | today's spend (sessions + garages approved in Link) + `totalUsd` > `daily_cap_usd` | `confirm` | nearest only |
| `needs_zone_number` | would auto-pay, but the zone's pay-by-app number is unknown (Boston, unreported block) | `confirm` | nearest only |
| `auto_pay_ok` | none of the above | `pay` | nearest only |

`needsZoneNumber` rides on every response (true whenever a payable
provider-covered zone has no stored number, whatever the rule); only an
`auto_pay_ok` outcome is downgraded to `confirm` by it.

### The place (FR-54)

After the street rules, the park is classified
(`src/services/placeClassification.ts`). Each class gets a score from 0 to
1 and the top one is acted on only when it is at least 0.5 and beats the
next by 0.3, the phone classifier's own rule and numbers (FR-53):

| Class | Score |
|---|---|
| `street` | the zone lookup agrees 0.9, disagrees 0.6 |
| `garage` | the fix inside a multi-storey, underground, or rooftop outline 0.9; 0.7 when it is nearer the outline's edge than its own accuracy (it may be the street beside it); no fix at the spot and the entry fix inside one or within reach of its entrance (`classifyByFootprint`) 0.9 |
| `lot` | inside a surface (or untagged) outline that charges 0.85; one nobody tagged a fee on 0.6 |
| `nopay` | inside a free or private lot 0.8; an untagged one 0.3 |
| the hint's class | the phone's confidence. A saved place (`inputs.memoryHit`) scores 0.95 and replaces what the footprints say: it is the driver's own answer |

The server runs its own footprint classification on every park, from the
garages within 150 m; a located fix is in a garage or lot only by being
inside its outline, and a hint of class `unknown` or `street` adds nothing.
The garage a hint names is used for its name only if the garages table has
it within 150 m of the fix. `place` reports the result on every response,
whatever the app lists.

For an app that lists the outcomes, the answer is then:

| Place | Action / rule |
|---|---|
| `garage` | `garage` / `place_garage` |
| `lot` that charges (or the driver's saved lot) | `garage` / `place_lot_fee` |
| `lot` with no fee tagged | asked (below) |
| `nopay`, and nothing in reach would charge | `nopay` / `place_nopay` (`ignore` / `free_period` stays as it is) |
| `nopay`, but a candidate would charge | asked (below) |
| `street` | the street answer, unchanged |
| `unknown` with a garage, lot, or hint in play | asked (below) |
| `unknown` with nothing but the zone lookup | the street answer, unchanged |

**Asked** means `place_unknown`: a street answer of `pay` becomes `confirm`
/ `place_unknown`, one of `unknown_zone` keeps its action with rule
`place_unknown`, and a park that already needed a tap (`confirm`) or was
free (`ignore`) keeps its own rule. `garage` and `nopay` are things
ParkAgent doesn't pay; V1 has no ticket flow (#181).

Two things hold whatever the hint says:

- **No answer is `pay` unless the street rules alone said `pay`.** A hint
  can only make an answer more careful.
- **A meter that would charge is never silenced.** `nopay` needs every
  candidate's quote to be zero, and with `garage` the `candidates` and
  `quote` ride along unchanged, so the driver can still say "not a garage"
  and pay the street.

**No fix at the spot** (`placeHint.inputs.located: false`): `lat`/`lng`
are the entry fix, the last place GPS saw the car driving in. The meters
there are not where the car is, so `candidates` is `[]`, `quote` and
`provider` are `null`, and the answer is `garage`, `nopay`, or
`unknown_zone` (`place_unknown` when asked; plain `unknown_zone` for an app
that lists no outcomes). The zones found at the entry fix are still on the
decision (`candidateZoneIds`).

Reading the garages never fails a park: with no footprint store, or a
lookup that throws, the park is classified without footprints and the
decision says so (`inputs.place.garageLookup`: `ok | unavailable | failed`).

Every `/parked` call writes a `decisions` row: `inputs` (request body,
pricing time and its source, radius, candidate zone ids, effective dry run,
policy hash, and `place`: the outcomes the app listed, `located`, the hint
as read, the zone agreement, what the street rules alone answered, the
footprint match, every class's score, and the garage lookup's state),
`rule`, `outcome` (action, quote, candidates, `place`).

Errors: `400` invalid body (zod details in `error`), `401` bad key.

---

## POST /parked/:id/place

The driver's own answer about a park (FR-54): what the place is, or that
they aren't parked there. It decides nothing and moves nothing. It is the
record the classifier is scored against, and the app writes its place
memory only after this has answered `200`.

```json
{ "class": "garage", "name": "Work garage" }
```

`class` is `street | garage | lot | nopay | not_here`. `not_here` is "I'm
not parked here" (a passenger, a drive-through): recorded, and nothing is
learned. `name` is optional, at most 80 characters, stored as one line.

Response `200`:

```json
{
  "ok": true,
  "parkedEventId": "…",
  "class": "garage",
  "name": "Work garage",
  "was": { "class": "unknown", "confidence": 0, "source": "footprint",
           "garageId": "bos-…", "garageName": "…" },   // what /parked said; null for a park from before FR-54
  "changed": true,           // the answer differs from what /parked said
  "decisionId": "…"
}
```

Writes a `decisions` row, kind `place_confirmation`, rule `place_confirmed`
(the answer is what `/parked` said), `place_corrected`, or `place_not_here`.
Its `inputs` carry the answer, the id of the park's own decision, what that
decision classified, and the classification inputs it recorded.

**Idempotent per user:** the same answer for the same park again returns
the same `decisionId` and writes nothing. A different answer is a new row,
and the last one stands. (An `Idempotency-Key` works as on every unsafe
request.)

Errors: `400` a class that isn't one of the five, or a `name` that isn't a
string of at most 80 characters; `401`; `404 {"error":
"parked_event_not_found"}` for a park that doesn't exist or is someone
else's; `429` (the limit is shared with `POST /parked`: 30 a minute).

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

## GET /garages/near?lat&lng&radius&limit

Garage and lot footprints around a point (FR-49): every garage or lot whose
outline comes within `radius` metres, nearest first, each with whether the
point is inside it, how far its outline is, and how far its nearest
entrance is. The outlines are OpenStreetMap's `amenity=parking` areas,
loaded per city by `pnpm -C server load:garages` (data/README.md).
Parking along the street is a zone (`/zones/near`), never a footprint.

`radius` is optional (default 250 m) and **capped at 1,500 m**, which
covers the app's 2 km footprint cell from its center. `limit` is optional
(default **10**, at most 1,000); `truncated: true` means more garages matched
than were returned. A PostGIS read runs per call, so the route is
rate-limited at 60/min per user (shared with `GET /garages/:id`).

```json
{
  "radiusM": 250,
  "limit": 10,
  "truncated": false,
  "attribution": "© OpenStreetMap contributors",
  "garages": [
    {
      "id": "bos-fixture-deck-0a1b2c",
      "city": "bos",
      "name": "Fixture Deck",
      "operator": "Fixture Parking Co",
      "kind": "multi_storey",
      "fee": true,
      "access": "customers",
      "capacity": 420,
      "website": "https://example.com/deck",
      "polygon": [[-71.0704, 42.3497], [-71.0696, 42.3497], [-71.0696, 42.3503], [-71.0704, 42.3503], [-71.0704, 42.3497]],
      "entrances": [[-71.0696, 42.35]],
      "source": "osm",
      "sourceVersion": "2026-09-30T12:00:00Z",
      "containsPoint": true,
      "distanceM": 0,
      "nearestEntranceM": 20
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | `<city>-<slug>-<hash6>`: the slug from the name (the kind when unnamed), the hash from the outline's identity at the source. Stable across reloads; a rename at the source changes the slug. |
| `kind` | `multi_storey`, `underground`, `surface`, `rooftop`, or `unknown`. A client treats a value it doesn't know as `unknown`. |
| `fee` | `true` charges, `false` is free, `null` the source doesn't say. |
| `access` | The source's access tag (`private`, `customers`, `permit`, …), or `null`. |
| `name`, `operator`, `capacity`, `website` | As tagged, or `null`. `website` is always http(s). |
| `polygon` | The outline's outer ring, GeoJSON `[lng, lat]` pairs, closed. |
| `holes` | Rings cut out of the outline. Present only when there are some. |
| `entrances` | `[lng, lat]` pairs: mapped entrances, else the outline's vertex nearest a road (a guess). Empty when neither is known. |
| `containsPoint` | The point is inside the outline and not in a hole. |
| `distanceM` | Metres from the point to the outline; `0` inside. To 0.1 m. |
| `nearestEntranceM` | Metres from the point to the nearest entrance, or `null` when `entrances` is empty. |
| `source`, `sourceVersion` | Where the outline came from (`osm`) and that source's version (the OSM snapshot time). |

`attribution` is the line the source's license requires wherever its data
is shown (OpenStreetMap's ODbL); a client that draws or lists these
garages shows it.

Reading garages decides nothing and writes nothing: no decisions row.

Errors: `400` bad or missing coordinates, or `radius` / `limit` out of
range; `401` no credential; `429` rate limited; `501 {"error":
"garage_footprints_unavailable"}` on a deployment with no footprint store
wired. A database with no garages loaded answers `200` with an empty list.

---

## GET /garages/:id

One garage by id: `{"garage": {…}, "attribution": "…"}`, the same fields as
above without the three measured from a point (`containsPoint`,
`distanceM`, `nearestEntranceM`). `404 {"error": "garage_not_found"}` for
an id nobody loaded, and for anything that couldn't be an id.

### Classifying a point: `classifyByFootprint`

`server/src/services/garageLookup.ts` exports the pure function `/parked`
classifies with (FR-54; "The place" under `POST /parked` says how its
answer is used):

```ts
classifyByFootprint(point: { lat, lng }, accuracyM: number, garages: GarageFootprint[])
  → { kind, garageId, containsPoint, nearestEntranceM }
```

1. **Containment wins.** The outline the point is inside; of nested
   outlines, the smallest. `containsPoint` is `true`.
2. **Else the nearest entrance** within `max(40, accuracyM)` metres,
   capped at 100 m, among `multi_storey`, `underground`, and `rooftop`
   garages only. `containsPoint` is `false`. A surface lot is matched by
   being inside it; near a lot's entrance is where a street park beside
   the lot is.
3. Otherwise no match: `{kind: null, garageId: null, containsPoint:
   false, nearestEntranceM: null}`.

`nearestEntranceM` is the matched garage's, to 0.1 m (`null` when it has no
entrance). Ties go to the smaller id. A garage whose kind isn't one of the
five is never returned. The geometry is the phone's (equirectangular
metres around the point), so the app's `FootprintIndex` and the server
agree about the same outline. `describeFootprint(point, garage)` gives the
measurements for one garage, including `edgeDistanceM` (how deep inside a
contained point is), and `makeGarageStore(prisma).near(…)` fetches the
`garages` argument.

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
executor already retried once on a fresh context — but only when the
crash came **before** the pay click; after it, a retry could pay twice, so
the error carries `afterPayClick: true`, nothing is retried, and the push
says "Payment not confirmed" — check the provider's app — never "unpaid"), `timeout` (a step or the whole call ran past its budget),
`busy` (every browser slot stayed taken for 45 s — nothing ran),
`provider_unavailable` (the provider's circuit breaker is open after
repeated network/timeout failures — nothing ran; see "Executor capacity
and resilience"), `unknown`. A page load that fails transiently
(`net::ERR_*`, a navigation timeout) is retried once in place — never
after the pay click.

On success the executor may also return the provider's **receipt** (meter /
fee / total) when the confirm/session screen lists it (ParkBoston does); a
start records those ACTUALS on the session and the `start_ok` decision
(`providerReceipt`), so the stored spend and the daily-cap accounting match
the card to the cent even when it differs from the pre-charge estimate
(ParkBoston sells in per-zone duration increments — see the acceptance
report, Job 2).

**Which card pays.** The session snapshots the user's Wallet source
(`sessions.payment_source`): `provider_card` — the card saved on the
provider account — or `parkagent_card`. A `link_wallet` user's street
meters pay with the card on their provider account too (recorded as
`provider_card`, with `requestedSource: "link_wallet"` on the decision):
Link's one-time card can't go on a provider account whose single saved
card is the user's own. For `parkagent_card`:

- **Readiness first**, before any session row, hold, or executor call —
  `409 {"error": "wallet_not_ready", "reason": …}` with `reason`
  `no_funding_method` (no saved card to hold against),
  `no_parkagent_card`, `parkagent_card_frozen`, or
  `parkagent_card_not_on_provider` (the provider account still carries
  the user's own card — charging it while we held on ours would double
  charge; dry run skips this one, since dry run never puts our card on an
  account).
- **Then a hold**, after the caps pass: a manual-capture PaymentIntent,
  confirmed off-session on the user's default saved card, for the quote
  plus a buffer of 20% (never less than $2) — but never more than the
  caps still leave room for (session cap minus what the session already
  spent; daily cap minus today's real spend): the hold is the most our
  card may pay for the leg. Idempotency key `hold:<session>:<leg>`; a leg
  still held is reused, and a leg whose earlier attempt was declined or
  released gets a new attempt (`extend-1.2`, its own row and key — else
  Stripe would replay the old decline after the user fixed their card). A decline answers `409 {"error":
  "card_declined"}`, marks the session `failed`, pays nothing (the
  executor never runs), and pushes `card_declined` ("Your card was
  declined — update it in Wallet"); a Stripe error answers
  `502 hold_failed`. Under dry run no PaymentIntent is created — the
  `wallet_hold` decision records `wouldHold`.
- **The executor pays with our card**; the Issuing webhook approves that
  charge only against this hold (see "issuing_authorization.request").
- **Then the hold settles**: it captures exactly what the ParkAgent card
  was charged (the approved authorizations the webhook attached to it)
  and Stripe releases the rest. A free period or an executor failure
  releases it (capturing only what was actually authorized, usually
  nothing). A paid leg whose authorization hasn't arrived yet is left
  held (`capture_deferred`); the wallet job settles holds older than 15
  minutes — capture what was authorized, release the rest.

Every hold step writes a `decisions` row (kind `wallet_hold`: rules
`dry_run`, `hold_placed`, `hold_declined`, `no_funding_method`,
`stripe_failed`, `hold_captured`, `hold_released`, `capture_deferred`,
`settle_failed`), and the start decision's outcome carries
`hold: {holdId, heldUsd, status, capturedUsd}`.

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
| `daily_cap_exceeded` | real (non-dry-run) spend today — sessions plus garages approved in Link — + total > `daily_cap_usd` |

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
`provider_relink` push. ParkAgent card only: `409 wallet_not_ready`,
`409 card_declined`, `502 hold_failed` (above).

Every call writes a `decisions` row (kind `session_start`; rule
`start_ok`, a cap rule, `wallet_not_ready`, `hold_declined`,
`hold_failed`, or `executor_failed`) and every executor call writes a
`session_events` row (`started` / `failed`).

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

A `parkagent_card` session's extension is its own leg with its own hold
(`hold:<session>:extend-<n>`), placed before the executor and settled
after it exactly like the start's — manual extends and the auto-extend
worker alike. A declined hold answers `409 card_declined` (decision rule
`hold_declined`; the worker records `extend_failed` with
`code: "card_declined"`) and pushes `card_declined`; nothing is charged.

One extension at a time per session, whatever pays it. Auto-extend fires
in the same minutes the user is prompted to tap Extend, and an
extension's number (its hold's leg), its cap room and the totals it adds
to all come from the session row, which moves only once the executor has
paid. So each extension runs start to finish under a transaction-scoped
Postgres advisory lock on its session (`pg_try_advisory_xact_lock`) and
re-reads the row inside it. A second extension arriving meanwhile — or
one priced from a read another extension has since overtaken — is
refused at once with `409 {"error": "extension_in_progress"}`: nothing
held, nothing charged, no push (decision rule `extension_in_progress`;
the worker records the same rule with `action: "none"` and it doesn't
start the hysteresis window, so the next tick decides from the new
expiry). Trying again afterwards is safe.

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

## Payment source

Moved to the Wallet: `GET /wallet` reports the active source and
`PUT /wallet/source` switches it (see "Wallet"). `GET/PUT
/me/payment-source` are gone (`404`); `GET /me` still carries
`paymentSource`. The session and daily caps apply to **every** source —
the choice moves where the charge lands, never what is allowed.
`shadow_mode` is independent of the source.

## POST /device

`{token, platform: "ios", environment: "development" | "production"}` →
`{ok: true}`. `environment` is the APNs environment that MINTED the token
— an Xcode-installed build gets sandbox ("development") tokens, a
TestFlight / App Store build production ones — and each token is pushed to
its own host (`apnsHost` in services/apns.ts: `api.sandbox.push.apple.com`
vs `api.push.apple.com`); a token sent to the other host is rejected as
BadDeviceToken and deleted. The app reads it from its own signing, not its
build configuration (ios Support/APNsEnvironment.swift: the embedded
provisioning profile's `aps-environment`; no embedded profile → App Store
/ TestFlight → production). Registering is idempotent (the app re-sends
on every launch, and a new environment for the same token replaces the
old), but the
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
- `payment_failed` — a pay or extend attempt failed; the meter is unpaid.
  The body says what to do instead (pay in the provider's app or at the
  meter; extend in the app); `code` (the executor error code) rides in
  `extra`, never in the text
- `card_declined` — the ParkAgent card's hold was refused by the user's
  saved card; nothing was paid (the hold comes before the provider).
  Carries `zoneNumber` and `deepLink: "parkagent://wallet"` — the fix is
  updating the card in the Wallet, not a retry
- `provider_relink` — the linked provider session died (`auth_expired`);
  carries `provider` and a deep link into the app's link flow, `zoneNumber`, and `deepLink`
  (`parkagent://pay?zone=<zone>` — opens the Park tab, where the zone
  number is on screen)
- `provider_linked` — a background link finished ("ParkBoston connected",
  naming the card read from the account); carries `provider`
- `provider_link_failed` — a background link failed for good, with the
  plain reason; carries `provider` and the link flow's deep link, so a tap
  starts it again

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

Setup: `pnpm -C server issuing:setup --user <id>` creates the user's
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
| `declined_no_pending_session` | nothing awaits payment: no pending/active session started within the last 10 minutes (`services/pendingSession.ts`) AND no live session hold (an extension's hold counts — its session started long before the window) |
| `declined_over_daily_cap` | approved card spend today (NYC day) + amount > `daily_cap_usd` |
| `declined_dry_run` | everything passed but a dry-run switch is on; the decision records `wouldApprove: true` (no holds exist in dry run, so this means "would approve if a hold covers it") |
| `declined_no_hold` | no live session hold for the user (status `held`, placed within the last 15 minutes) — **the ParkAgent card only pays against a hold on the user's own card** |
| `declined_over_hold` | a live hold exists but the amount doesn't fit in what's left of it |
| `approved` | none of the above, both dry-run switches off, and the hold's room claimed |

The hold claim is the last check and the only write: a compare-and-set
that grows the hold's `authorized_usd` only while it stays within the
hold, so two charges racing for one hold can't both fit. The claimed
hold and its session are stored on the ledger row (`hold_id`,
`session_id`), which is what the leg later captures against. A duplicate
delivery that loses the ledger insert gives its claimed room back. An
`issuing_authorization.updated` with status `reversed` gives an
approval's room back to a still-open hold (guarded on the stored status,
so a replay never gives twice); against an already-captured hold the
decision records `needsRefund: true` for the operator.

The card's own Stripe spending controls (MCC allowlist, per-authorization
and daily limits) are the first line of defense; authorizations they block
never reach the webhook. Every `.request` writes an `issuing_authorizations`
row and a `decisions` row (`kind: "issuing_authorization"`, inputs include
amount, MCC, spend-so-far, pending-session answer, dry run, policy hash).

Redelivery is idempotent: a replayed `.request` answers the recorded
decision (deciding twice could flip the answer once spend moved) and its
decisions row records `replayed: true`; a `.request` retry that arrives
after a lifecycle `.created` already created the row (decision
`"external"`) decides for real and updates that row in place. That holds
for deliveries in flight at the same time too: the decision, its claim on
the hold, and the ledger row commit in one transaction that starts by
upserting the row by `stripe_authorization_id` (unique), which inserts it
or locks it until commit — a concurrent duplicate waits there, then
answers the stored decision, so an authorization reserves hold room
exactly once in either arrival order.

### Ledger events

`issuing_authorization.created` / `.updated` upsert the
`issuing_authorizations` row (lifecycle `status`, held amount); an
authorization first seen this way is stored with `decision: "external"`.
`issuing_transaction.created` attaches the settled capture
(`stripe_transaction_id`, `captured_usd`) to its authorization row.
`payment_intent.succeeded` for an intent tagged `parkagent=card_topup`
moves the settled amount onto the financial account (see
`POST /card/funding/topup-intent`, admin only now).
`payment_intent.succeeded` / `.canceled` for a session hold
(`parkagent=session_hold`) reconcile a hold Stripe settled on its own —
an uncaptured intent auto-cancels after 7 days — with a compare-and-set
on `held`, so our own settles (already moved on) and redeliveries change
nothing (decision rule `replayed`). Other event types are acknowledged and
ignored.

### Local dev

    stripe listen --forward-to localhost:3000/webhooks/stripe   # terminal A
    pnpm -C server dev                                          # terminal B
    pnpm -C server stripe:trigger --user <id> [--amount 7.28] [--category parking_lots_garages]

`stripe listen` prints a `whsec_…` — put it in `.env` as
`STRIPE_WEBHOOK_SECRET`. `stripe:trigger` fires a test authorization at the
user's real card via Stripe's test helpers, so the printed `approved` is
the webhook's live answer; vary `--amount`/`--category` to exercise each
decline.

---

## Card endpoints

The ParkAgent card's own surface over the Phase 6 Issuing tables — what
the Wallet's card hero uses (its summary comes from `GET /wallet`).
Everything that talks to Stripe answers
`503 {"error": "stripe_not_configured"}` when `STRIPE_SECRET_KEY` isn't set.
The full card number **never** transits this server: the app reveals it
client-side with an ephemeral key (see `GET /card/reveal`).

**No stored balance.** The card spends against a hold on the user's own
card per session (see "Wallet"), so nothing here funds a user balance any
more. `GET /card` (it carries the platform financial account's balance),
`GET /card/transactions`, and the three funding moves below are
**admin only** (`403 forbidden` for everyone else): keeping the Issuing
balance funded is the operator's job. `POST /card/prepare`,
`GET /card/reveal`, and freeze/unfreeze stay the user's.

### Card lifecycle

The card is created **lazily** — not at signup, but when the user chooses
the ParkAgent card in the Wallet (`PUT /wallet/source`) or reaches the
link flow as a ParkAgent-card user (`POST /card/prepare`). Our DB status then
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
runs for **parkagent_card** users (see "Wallet"): with `provider_card` (the
default) or `link_wallet`, street meters pay with whatever payment method
the account already has, so the consent requirement doesn't apply and
the link decision records `setUpCard: false, paymentSource:
"provider_card"`. (Shadow mode no longer affects linking — it only adds a
test authorization alongside real spends.)

**The request answers at once** — verification runs in the background.
Verifying a session drives a headless browser against the provider's
site, and on a cold 1 GB machine that outlasted the app's request timeout
("That didn't finish — Could not reach the server" while the server went
on to link). Now the sealed cookies go into a durable `link_jobs` row and
the answer is:

```json
202 { "status": "verifying", "phase": "queued", "jobId": "…" }
```

The link worker (`jobs/linkWorker.ts`) then, under a hard **45 s budget**
per attempt: waits for a browser slot (`queued`, with its place in line),
verifies the cookies (`verifying` — the lightest page that proves the
session, images/fonts blocked), upserts the sealed state (`status:
"linked"`), reads the card on file (`reading_card`, its own 25 s budget),
and chains the card setup when asked (`adding_card`). A transient failure
(`timeout`, `network`, `busy`, `provider_unavailable`, `browser_crashed`,
`ui_changed`, `unknown`) → `retrying`, again in 1 then 5 minutes; after the
third attempt the job is **dead-lettered** (`deadAt`, a `link_dead_letter`
decision, listed in `/admin/summary`). `auth_expired` (the cookies weren't
a session) or any other code fails at once, no retry. A restart mid-attempt
loses nothing: the claim is a lease (`lockedUntil`), and the next process
picks the job up when it lapses; two workers never run one attempt (the
claim is a compare-and-set on `attempts`). The sealed cookies are erased
from the job row when it finishes. Poll `link-status` for the outcome.

`cardBrand`/`cardLast4` are the card the **provider account already has
on file**, read from its Your Cards screen at link time so the app can
show which card will actually be charged ("Visa •••• 4242"). Read for
everyone but `parkagent_card` users (who are having ours installed
instead), best effort — a failed read stores nulls and never blocks the
link — and display-only: the PAN is never requested, returned, or
stored. The decision records presence only (`savedCardSeen`), never
digits.

Every link writes `decisions` rows (kind `provider_link`: `link_queued`
at the request, then `link_ok` / `verification_failed` /
`link_dead_letter` with per-stage timings) whose inputs carry only cookie
counts and domains — never values.

### GET /providers/:provider/link-status?jobId=…

The job's real step, for the app's progress screen:

```json
{ "phase": "queued", "linked": false, "elapsedMs": 2100, "attempt": 1, "maxAttempts": 3, "queuePosition": 1 }
{ "phase": "done", "linked": true, "elapsedMs": 9400, "attempt": 1, "maxAttempts": 3, "cardBrand": "Visa", "cardLast4": "1234", "walletBalanceCents": null }
```

`phase`: `queued → verifying → reading_card → (adding_card) → done |
failed`, or `retrying` between attempts (with `nextAttemptAt`).
`queuePosition` (calls ahead of it for a browser slot) only while queued.
`linked` is whether THIS job linked the account (its `linkedAt` is at or
after the job) — a failure with `linked: true` is a card-setup failure,
so the app offers setup-card's retry rather than a new sign-in. On
failure it carries a typed `reason` (an executor code,
`unsupported_card_brand`, or `no_card`) and `retrySafe`: worth trying
again as-is (transient) or something needs fixing first (re-link, a
different card). `dryRun: true` marks a job that "completed" by dry-run
skip. Jobs live in the `link_jobs` table (deploy-safe); the janitor only
times out legacy rows with no lease or schedule. `404 unknown_job` for ids
that aren't yours.

### POST /providers/:provider/link-jobs/:jobId/notify

The app's "Continue — we'll let you know" (offered after 20 s, and sent
when the link sheet is closed mid-job): the outcome arrives as a push —
`provider_linked` ("ParkBoston connected", naming the card) or
`provider_link_failed` (the plain reason). A user who watches the job to
the end gets no push; a job that goes to `retrying` sets it on its own,
since nobody waits minutes on a spinner. `200 {"ok": true, "phase": …,
"notify": true}` (`notify: false` once the job had already finished);
`404 unknown_job`.

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

### Executor capacity and resilience

Every real provider call (pay, extend, stop, link, card read, the daily
health check) opens a Chromium context, and the 1 GB machine runs out of
memory well before the provider does. So, in `services/parknycExecutor.ts`:

- **One warm browser**, launched at boot (`EXECUTOR_WARM_AT_BOOT`, default
  `true`; only with `PROVIDER_STATE_KEY` set) so the first link after a
  deploy doesn't pay Chromium's cold start inside its budget.
- **A concurrency gate**: at most `EXECUTOR_CONCURRENCY` calls at once
  (default 2, max 8); the rest wait in arrival order and can hear their
  place in line (a link job shows it). A session call waits at most 45 s,
  then fails `busy` — nothing ran, and the app says so.
- **A per-provider circuit breaker**: three provider-side failures in a
  row (`network`, `timeout`, `ui_changed`, `unknown`) open it for 60 s,
  doubling on each failed probe up to 10 min; while open, calls fail
  `provider_unavailable` without touching the provider (nothing ran). A
  success closes it. Other codes (`auth_expired`, `payment_declined`, …)
  are the user's, not the provider's, and don't count. Every transition
  writes a `circuit_breaker` decision.
- **Per-step timeouts, one safe retry**: a page load that fails
  transiently is retried once, and a Chromium crash once on a fresh
  context — both only before the pay click. Once the click that can
  charge has happened, nothing is retried (`afterPayClick: true` on the
  error, recorded in the decision); the user hears "Payment not
  confirmed", as before.

Each session decision records the executor's timings (`outcome.executor:
{queueMs, runMs, retries, queuedBehind}`), which `/admin/summary` turns
into per-stage p50/p95.

### POST /providers/:provider/topup

**Admin only** (`403 forbidden` for anyone else) — an operator tool; the app
has no top-up. `{amountUsd}` → top up the provider wallet from the card on
file, through the executor. Policy-gated and audited like every money move (kind
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
  "dryRun": true,            // effective: env DRY_RUN || policy.dry_run
  "editable": false          // may THIS caller PUT it: admin, and the server
                             // can rewrite policy.json
}
```

The policy is the operator's. Its `session_cap_usd` and `daily_cap_usd`
are **ceilings**: each user may set lower caps of their own, and a
different default stay, with `/me/limits` (below). Everything else in it
(dry run, the rate ceiling, auto-extend, fees) applies to everyone as is.

## GET /me/limits · PUT /me/limits

The caller's own spending limits: per stop, per day, and the default stay.
Anyone may set theirs; the app's budget step and Account → Spending
limits read and save through here (they used to PUT the whole shared
policy, which is admin-only — "Couldn't save to the server" for everyone
else).

```json
{
  "limits":   { "sessionCapUsd": 20, "dailyCapUsd": 40, "defaultStayMinutes": 60 },  // in effect now
  "saved":    { "sessionCapUsd": 20, "dailyCapUsd": 40, "defaultStayMinutes": null },  // null = the operator's default
  "defaults": { "sessionCapUsd": 45, "dailyCapUsd": 60, "defaultStayMinutes": 90 },    // policy.json
  "ceilings": { "sessionCapUsd": 45, "dailyCapUsd": 60 },                               // policy.json's caps
  "bounds":   { "minCapUsd": 1, "stayMinutes": { "min": 15, "max": 240 } },
  "clamped":  []                                                                         // saved values a lowered ceiling now caps
}
```

In effect: each cap is `min(saved ?? policy, policy)`, and the per-stop cap
never exceeds the day's — so the operator lowering a cap binds everyone at
once, and a user who never saved runs on the policy exactly as before.

`PUT` takes any of the three fields: a number sets it, `null` goes back to
the operator's default, a field left out keeps its value. Refusals are
`400 {"error": "invalid_limits", "issues": [{field, code, message, limit}]}`
with `code` one of `above_ceiling`, `below_minimum` ($1), `session_above_daily`,
`out_of_range` (stay outside 15 min – 4 h), and `message` the sentence the
app shows as is, e.g. "Per stop can't be more than $45.00 — the most
ParkAgent pays right now." Every PUT, saved or refused, writes a
`decisions` row (kind `limits_update`, rule `saved` | `refused`) with what
it replaced and the ceilings at the time.

**Every cap check reads the caller's own limits** (`services/limits.ts`
`policyFor`): the `/parked` auto-pay decision and its quote's default
stay, session start (and its ParkAgent-card hold room), manual and
automatic extensions, the card-authorization webhook (the card owner's
daily cap), the Wallet's spend line, top-ups, and the assistant's budget
checks. `test/limitsScan.test.ts` fails any new cap read from the global
policy. One exception by design: the ParkAgent card's own Stripe
spending controls stay at the ceilings — a backstop that a later raise
can't trip over; the webhook enforces each user's cap in real time.
`DELETE /me` removes the row.

## PUT /policy

**Admin only** (`403 forbidden` otherwise): the policy is the operator's
spending contract — the cap ceilings, dry_run, the rate ceiling — so
changing it is the owner's call; `GET /policy` stays open to every user
(the app shows its rules). The app never PUTs it: users' own limits go
through `/me/limits`.
Full replacement of the policy document. Body is the entire policy object
(same schema as `policy.json`; unknown keys rejected). On success the file
is rewritten, a `policy_snapshots` row is recorded (`source: "put"`), and
the new `GET /policy` payload is returned. `400` on validation failure with
zod details. `503 {error: "policy_not_saved", reason}` when the file can't
be written: nothing changed, and the old policy is still in force (the new
one takes effect only once it's on disk).

The file is written as `policy.json.tmp` next to it, then renamed over, so
its **directory** must be writable. In the image, `/app/policy.json` links
to `/app/var/policy.json` in a node-owned directory, and `/app` stays
root-owned (#154). A server that can't write it lists `policy_edit` in
`/health`'s `degraded`, and `GET /policy` reports `editable: false`.

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
charges is the Wallet's job — see "Wallet"; shadow mode no longer changes
how linking behaves. Since the ParkAgent card approves only against a
session hold, a shadow authorization for a `provider_card` session — which
places no hold — rehearses as `declined_no_hold`.) The shadow result lands on the decision outcome (`shadow:
{fired, authorizationId, approved, amountUsd}` — or `{fired: false,
reason}`) and `pnpm -C server decisions:recent` prints it. Shadow mode
never bypasses the dry-run switches: the executor leg still moves money
only when both are false; the shadow authorization itself is always
test-mode money (`services/shadow.ts`).

The server validates and snapshots (`source: "boot"`) at boot, and refuses
to start on an invalid file.

---

## GET /health · GET /health/ready

No auth. `/health` is liveness plus build identity: `{ok, dryRun, commit,
builtAt, degraded}` (deploys wait on its `commit`). `dryRun` is the
`DRY_RUN` switch as the server read it (anything but `false` runs dry).
`degraded` lists the optional features a setting mistake switched off:
`live_payments`, `provider_accounts`, `push`, `stripe`, `issuing`,
`link_wallet`, `apple_signin_revoke`, `apple_maps`, `email_signin`,
`google_signin`, `parkwhiz`, `assistant` (`server/src/env.ts` FEATURES),
plus `policy_edit` when `policy.json` can't be rewritten. It's `[]` when all
is well. A feature that's simply not configured is off, not degraded. The
log says why, one line each: `config: apple_maps is off — APPLE_MAPS_KEY is
not set, but …`. Only core settings refuse boot. See "Settings" below. `/health/ready` is readiness:
one `SELECT 1` bounded at 3 s → `{ok: true, db: "ok"}`, or `503 {ok:
false, db: "down" | "timeout"}`. Fly's http check uses `/health/ready`
(fly.toml), so a machine that can't reach its database stops getting
traffic, and a deploy that can't isn't marked healthy.

## Settings (env) and check-secrets

`server/src/env.ts` reads every setting once at boot.

- **Core** (refuses boot, "Refusing to start: invalid core settings"):
  `DATABASE_URL` (a `postgres://` URL), `AUTH_JWT_SECRET` (≥ 32 chars),
  `API_KEY_PEPPER` (≥ 16 chars), and `PROVIDER_STATE_KEY` when set (32
  bytes of base64; unset just switches provider linking off).
- **Optional features** (never refuse boot): none of a feature's settings →
  off. Some of them, or one malformed → off, **degraded**, one log line
  naming the variable. A degraded feature's settings are dropped before
  wiring, so nothing can switch it on behind the report's back.
- **Contents are checked:**
  - an Apple `.p8` (`APNS_KEY`, `APPLE_SIGNIN_KEY`, `APPLE_MAPS_KEY`) must
    parse as an EC P-256 private key, not a file name or a public key;
  - Apple key and team ids are 10 characters, bundle ids look like one;
  - vendor keys carry their prefix (`sk_`/`rk_`, `whsec_`, `re_`,
    `sk-ant-`, `pk_`, `….apps.googleusercontent.com`), and URLs are https.
- **Warnings** (logged, never fatal):
  - the same Apple key in two slots, which is fine only if that key has
    both services enabled, and wrong when the two key ids differ;
  - two secrets with one value;
  - a variable with one of our prefixes (`APPLE_`, `APNS_`, `STRIPE_`,
    `RESEND_`, `GOOGLE_`, `LINK_`, …) that the server doesn't read, with
    "did you mean X?";
  - a tuning value (`PORT`, `EXECUTOR_CONCURRENCY`, the assistant's cap
    and models) that falls back to its default.

**Before every `fly secrets set`**, run the same checks on the values you're
about to set:

```sh
pnpm -C server check-secrets APPLE_MAPS_KEY=@~/Downloads/AuthKey_XXXXXXXXXX.p8 \
  APPLE_MAPS_KEY_ID=XXXXXXXXXX APPLE_MAPS_TEAM_ID=YYYYYYYYYY
```

It reads the names already set on `parkagent-api` (names only; values never
leave Fly) and prints three things:
- each proposed setting as ok or REJECTED (with "did you mean …?" for a name
  the server doesn't read, and a `.p8` whose `AuthKey_<id>` file name
  disagrees with the proposed key id);
- every feature it would switch on, off, or leave degraded;
- the `fly secrets set` command to run.

It exits non-zero unless everything is accepted. Other options:
- `NAME=@file` reads a value from a file, and a bare `AuthKey_….p8` just
  inspects the file;
- `--unset NAME` previews a removal;
- `--no-app` judges the proposal alone;
- `--env-file ../.env` checks a local file;
- `--live` asks Apple whether a proposed Maps or Sign in with Apple key
  works. That's a token request only: nothing is created or charged.

## Idempotency keys (every unsafe request)

A signed-in `POST`/`PUT`/`PATCH`/`DELETE` may carry `Idempotency-Key: <8–128
of [A-Za-z0-9_-]>`, and the app sends one on every such call: one key per
action, reused on each automatic retry. The server (`services/idempotency.ts`,
table `idempotency_keys`, kept 24 h) runs a key once per user, and **its
first answer is its answer**, refusals and errors included:

| A request with a key that… | gets |
|---|---|
| is new | the route runs; its status and body are stored |
| was answered | the stored answer, header `Idempotent-Replayed: true`, nothing runs |
| is still running | `409 {"error": "request_in_progress", "retryAfterSeconds": 2}` |
| was used for a different request (method, path, body) | `422 {"error": "idempotency_key_reused"}` |
| is malformed | `400 {"error": "invalid_idempotency_key"}` |

This is what makes a retry safe: a phone that gave up waiting for a
payment (the server kept going), or lost the answer in a tunnel, asks
again and gets the result instead of paying, extending, or recording
twice. A claim that never finished (the process died mid-request) may be
taken over by a retry after 10 minutes.

Never stored, whatever the key: answers that carry a secret. That means the
Link card reveal (card number and CVC; storing it would break the
"never store card numbers" rule), `/wallet/setup-intent` and
`/card/funding/topup-intent` (Stripe client secrets), and `/link/connect`
(OAuth state). These keep their own one-shot semantics, and the app neither
keys nor retries them. Sign-in calls carry no user yet, so they aren't keyed
either.

## Timeouts

- **Outbound:** every call to a third party has a deadline.
  - APNs 8 s per push. Pushes are awaited inside a start and inside an
    extension's lock.
  - Stripe 20 s, with the SDK's own 2 retries under one idempotency key.
  - Resend 10 s, Nominatim/ParkWhiz/SpotHero 8 s, Link 15 s.
  - Apple Maps (6 s a call; 4 s for walking times, which are a refinement
    not worth waiting on), the Apple/Google JWKS, and Apple's token
    endpoint already had their own.
  - The database pool gives up on a connection after 10 s.
  - `test/outboundScan.test.ts` fails a bare `fetch`.
- **Inbound:** a client has 30 s to finish *sending* a request (slow-drip
  bodies). Keep-alive is 75 s, longer than Fly's proxy keeps an idle
  upstream connection.
  - A handler is never cut off mid-run. A payment has to finish or fail
    on its own terms, and the app waits it out through the idempotency key.
- **Shutdown** (SIGTERM; `fly.toml` `kill_timeout` 30 s), in order:
  1. stop the job timers;
  2. close the server (new requests get 503; requests in flight finish);
  3. wait for job passes in flight (an extension, a link);
  4. then close the browser and the database, and exit 0.

  All of this runs within 25 s, or the server exits 1 with a log line
  naming the step it was on. `scripts/boot-check.sh` sends SIGTERM and
  requires exit 0.

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
  "decisionCount": 23,
  "providers": {
    "passport": {
      "stages": {                    // ms, today; n samples
        "queue":  { "n": 5, "p50Ms": 0, "p95Ms": 1800 },
        "verify": { "n": 3, "p50Ms": 6200, "p95Ms": 11900 },
        "card":   { "n": 3, "p50Ms": 3100, "p95Ms": 4000 },
        "link":   { "n": 3, "p50Ms": 9800, "p95Ms": 16400 },
        "start":  { "n": 2, "p50Ms": 21000, "p95Ms": 24000 }
      },
      "timeouts": 1, "retries": 1, "breakerTrips": 0, "breakerState": "closed",
      "links": { "started": 3, "done": 3, "failed": 0, "retrying": 0, "deadLettered": 0 }
    }
  },
  "executor": { "capacity": 2, "inUse": 0, "queued": 0 },
  "deadLetters": { "linkJobs": [], "appleRevocations": 0 },
  "jobs": { "appleRevocationsPending": 0 }
}
```

`providers` covers every stage that talks to a provider: `queue` (waiting
for a browser slot), `verify`, `card` (the saved-card read), `setup`,
`link` (a whole link, request to done), and a session's `start` /
`extend` / `stop` (from the executor timings each session decision now
records). `timeouts` counts `timeout`/`busy` outcomes, `retries` the
in-place page-load retries plus link attempts past the first, and
`breakerTrips` the circuit breaker opening (each a `circuit_breaker`
decision).

A decision's city comes from its session's stored `city`, the quoted
zone's id prefix, or the first candidate; unattributable rows land under
`"unknown"`. Every decisions row also emits one structured log line
(`{"decision": {id, kind, rule, userId, sessionId, parkedEventId}}`) —
identifiers and the rule only, never inputs/outcome (those can carry
ui_changed screenshots).

---

## Assistant

The conversational surface: one Claude tool-use loop that does exactly
two jobs — find one spot, or plan a multi-stop day.

**Model routing.** The loop runs on `ASSISTANT_MODEL` (default
`claude-sonnet-5`; the legacy `ANTHROPIC_MODEL` is still honored as a
fallback), while `explain_decision` phrasing runs on the cheap
`EXPLAIN_MODEL` (default `claude-haiku-4-5-20251001`) — and falls back to
the plain template sentence if that call fails, so an explanation never
fails a turn. Every turn writes an `assistant_turn` decisions row with
the model, summed input/output tokens, model-call count, wall-clock
latency, and an estimated cost from published per-model list prices —
including any call a tool made on its own model (`explain_decision`'s
phrasing lands in `otherModelCalls` and in the cost) — plus
`stateEdits` (the turn's `update_request` calls), `requestVersion`
(the request's version when the turn ended; see "The request" below), and
`planKind` when the turn ended on a card.
`ASSISTANT_DAILY_SPEND_CAP_USD` (default `5`) caps each user's estimated
daily model spend against those rows (midnight ET, the same boundary as
the parking caps); a user over it gets `429 assistant_budget_exhausted`
*before* any paid call is made. The check runs once per turn, so a
user can end a day over the cap by at most one turn (≤ 8 model calls)
per request in flight. The MODEL plans and phrases; the TOOLS enforce policy
(same quoting, caps, and audit services as everything else); **nothing
books or spends without the user's explicit Confirm/Sign off tap on a
plan card**, which is the only thing that mints the single-use
confirmation token the consequential tools demand. Requires
`ANTHROPIC_API_KEY` (else 503). Every tool call, plan, and confirmation
writes a decisions row (kinds `assistant_tool`, `assistant_plan`,
`assistant_confirm`), and a reply that had a sentence dropped writes one
too (`assistant_reply`, see "Searching the request, and saying no").

### POST /assistant/message

`{text | transcript, conversation_id?, location?{lat,lng}}` → one
assistant turn. With `Accept: text/event-stream` the reply streams as SSE:
`text` events carry `{delta}`; a `plan` event carries
`{planId, plan}` the moment `propose_plan` lands, so the card renders
before the reply text settles; one final `done` event carries the full
payload. Otherwise plain JSON:

```json
{
  "conversationId": "conv_…",
  "reply": "Street is cheapest — here are your options.",
  "plan": { "planId": "…", "plan": { "kind": "single_spot" | "itinerary" | "none_meets" | "no_data", … } } | null,
  "suggestions": [ { "label": "Mooo.... · 49 Melcher St, Seaport", "reply": "Mooo...., 49 Melcher St" } ] | null
}
```

`suggestions` are tappable answers to the question the reply asks: the
app shows each `label` as a chip under the newest reply, and a tap sends
`reply` as the user's next message, exactly as if they had typed it. They
come from `ask_user` (below). When a place search this turn came back
ambiguous and the model asked in prose anyway, the ambiguous places are
offered instead, so the question is still one tap. A `none_meets` card's
suggestions are its ways to relax the request, and a turn that searched
but left no card offers "Search again" (both below). The SSE `done` event
carries them too.

**What streams is provisional.** `text` events are the model's words as
they arrive; the `done` event's `reply` is the one to keep, and the app
replaces the streamed text with it. Because streamed text is still seen,
it is held to whole sentences, a sentence with a dollar amount in it never
streams, and nothing streams once the turn has searched: what the model
says about prices reaches the user only in the checked reply.

Conversation state persists per user (last 20 turns) keyed by
`conversation_id`; another user's id answers `404 conversation_not_found`
before any model call (the turn would otherwise be saved over their
transcript). Ids are the server's: one that names no conversation (deleted,
or past retention) starts a NEW conversation under a fresh id (returned
as `conversationId`) rather than reviving the old id with the old plans. Rate-limited 20/min — each turn is a paid model call.

**Times.** Every time a tool takes (`update_request`'s `startsAt`, an
itinerary stop's `arrival`) is read with an explicit offset honored
and an offset-less `YYYY-MM-DDTHH:mm[:ss]` read as ET wall-clock time —
never the host's zone, which is UTC on Fly and ET on a dev Mac. An
unreadable time bounces back to the model (`unreadable_time`), and times
are forwarded and stored in one canonical form with NYC's offset
(`2026-09-26T18:00:00-04:00`).

The model's tools: `update_request(patch)` records what the user asked
for in the conversation's request (see "The request" below).
`geocode_place(query, city?)` looks a NAMED place up and **makes it the
request's place** (`place.resolved`, or `place.candidates` when it matched
several). That covers a restaurant, bar, venue, business, hotel,
landmark, street, or neighborhood. The search is biased to the phone's
city (see "Place search" below). The model calls it FIRST for any named
place; the searches then search there, never the phone's location.
Results outside both metros' bounding boxes are dropped. It answers one
of four ways, each with the request's `stateVersion`, the server's
`resolution`, and (except for "none") a 0–1 `confidence` — the place's
score, see "Place search" below. The model reads both and sets neither:

- `{found: true, match: "exact", resolution: "found", confidence, place}`
  — the place the user named (`place` has `name`, `address`, `area`,
  `kind`, `lat`/`lng`, and a `displayName` like "LoLa 42, Seaport", which
  becomes the card's destination label).
- `{found: true, match: "closest", resolution: "closest_only", confidence,
  place, instruction}` — nothing carried the NAME. `place` is only the
  closest thing found (often the neighborhood), and the model is told to
  say so rather than present it as the place. This was the device test's
  silent "Seaport center" fallback.
- `{found: true, ambiguous: true, resolution: "ambiguous", confidence,
  choices: [{label, reply, lat, lng}]}` — several distinct places match
  (a chain's two locations). The model must ask with `ask_user`; nothing
  is resolved until the user picks one.
- `{found: false, resolution: "none", instruction}` — couldn't find it:
  nothing came back, or nothing that shares a word with what the user
  said. The model asks for an address or cross street, and doesn't ask
  which city when the phone answers that. The answer never carries a
  point: not the phone's, and not the result that was turned down.

Found or not, the request now names that place (`place.query`), so a
search after a failed lookup asks for it and never falls back to the
phone. Without a geocoder the tool answers `geocoding_unavailable`.
`ask_user(question, suggestions[2–4] of {label, reply})` is the only way
the model asks the user anything. Like `propose_plan`, it ENDS the turn:
the question becomes the reply and the suggestions ride along as chips.
If a model asks in prose anyway, the loop still attaches chips
(`clarify.ts` `suggestionsForQuestion`). Ambiguous places get one chip
per place. The three questions a parking request needs get their common
answers:

- which city: the covered cities, from the registry;
- how long: 1, 2, or 3 hours;
- what time: now, in 30 minutes, or tonight at 7.

A question that can be answered by assuming (now, 2 hours) should not be
asked at all, and the prompt says so.

**Assumptions.** Every plan carries a server-computed `assumptions` line,
the window and the place (`clarify.ts` `windowAssumption`, from the search
the card was built from): "Sat 7:00–10:00 PM, near LoLa 42, Seaport",
"Now–3:30 PM", "Mon 3 stops, 10:00 AM–4:30 PM". A request with no start is
for now, for the request's stay. The app shows it above the card
("Assuming …"). The one-line reply a silent proposal gets states it too:
"Here are your options (Now–3:30 PM) — tap one to go ahead."

`quote_street()` and `search_garages()` take **no arguments** (an optional
`note` aside): they search the request — see "Searching the request, and
saying no" below. `build_itinerary(stops[])` prices a multi-stop day,
each stop at its own point and time; `propose_plan(plan)` ends the turn
with the structured plan; `book_garage(option_id, confirmation_token)`
and `start_session(zone, duration, confirmation_token)` are REFUSED
without a live token; `get_history(days)`; `explain_decision(id)` (a
plain-language rendering of a decisions row via
`services/explanations.ts`).

**The street search** (`services/assistant/streetOptions.ts`) covers
**every metered zone within a walking radius** of the place (400 m, about
a 7-minute walk; 800 m when that holds none), not the old "nearest zone
within 25 m". A destination isn't a curb: on the device test the
Seaport's centroid had no zone within 25 m but six within 400 m, and the
assistant said there was no street parking. Each zone is priced for the
stay and described for THAT window (`state` is one of `free`, `metered`,
`metered_then_free`, `free_then_metered`, or `mixed`, in ET wall clock).
These are a street option's `facts`:

```json
{ "zoneId": "bos-seaport-blvd-de413d-01", "street": "Seaport Blvd", "zoneNumber": null,
  "lat": 42.3531, "lng": -71.0463, "distanceM": 271, "walkMinutes": 4,
  "state": "free", "stateText": "Free after 6 PM",
  "summary": "Free after 6 PM on Seaport Blvd — 4 min walk",
  "costUsd": 0, "meterUsd": 0, "feeUsd": 0, "ratePerHourUsd": 3.75, "rateAdditionalHourUsd": 3.75,
  "maxStayMinutes": 240, "clampedMinutes": 180, "enforcedMinutes": 0, "exceedsMaxStay": false,
  "hoursToday": [ { "start": "08:00", "end": "18:00" } ] }
```

Zones of one street in the same state and price collapse to the nearest,
so the two sides of a block are one choice. Each option's pin is the curb
point nearest the destination. The walk is straight-line distance × 1.3
at 80 m/min, replaced by Apple's walking time when the request names a
place (see "Walking times" below). A stay is priced whole when the meter
allows it. When the
meter runs past the max stay, the stay is priced to the max: the option's
`durationMinutes` is those minutes, and `exceedsMaxStay` plus "(2 hr
max)" in the words say so. Provider-observed terms
(`zone_terms_observed`) apply exactly as they do for `/parked` and
session start (`termsSource: "observed"`). When the radius holds no zone
the result's `street` says `{radiusM, zonesInRadius: 0}` and the model is
told the radius to say. The same search prices itinerary stops (the
cheapest option, then the nearest) and their re-pricing.

**Place search.** `geocode_place` biases to the metro the phone is in
**or near** when the model names no city. An explicit `city` still wins.
"Near" means inside the metro's box or within 60 km of its center
(`NEAR_METRO_KM`): a Braintree phone is outside the Boston box but is in
Boston for a driver, and on the device test it got asked "Boston or
NYC?". The same rule writes the city onto the message's location line
(`[phone location: 42.22060, -71.00410 — in or near Boston]`). The system
prompt tells the model that line answers the city question. A phone
inside the box searches around the phone; one outside it searches around
the city's center, with the phone as a secondary hint. The geocoder falls
THROUGH to the other metro when the biased one has no match: the bias
orders the search, it never blinds it.

Sources, in order (`FallbackGeocoder`): the **Apple Maps Server API**
(`services/assistant/appleMaps.ts`) when `APPLE_MAPS_KEY` /
`APPLE_MAPS_KEY_ID` / `APPLE_MAPS_TEAM_ID` are set (a set of three; see
`docs/apple-maps-setup.md` for the one-time portal steps), then
**Nominatim**. Apple knows businesses by the names people use; Nominatim
knows streets and neighborhoods but few businesses, and alone it returns
nothing for "Lola 42". Inside Apple there are two steps (FR-44):

1. `GET /v1/search`, biased as above.
2. `GET /v1/searchAutocomplete` with the same bias, **only when the search
   is weak**: it found nothing, nothing it found carries a word of the
   name, or its best score is under 0.55. The search reads "lola42"
   literally and returns the neighborhood; autocomplete completes it to
   LoLa 42. Each completion is one more `GET` of its `completionUrl` — at
   most three per city tried, only ones inside a covered city, and only
   Apple's own relative `/v1/search?…` (the request carries the access
   token, so a response can't name another host).

Each result says which step found it (`source`: `apple_search`,
`apple_autocomplete`, or `nominatim`). A source that fails falls through
to the next, and the answer names it (`failures: [{provider, reason}]`).
Apple's HTTP 429 — the team's daily quota of 25,000 calls, shared by every
Maps endpoint — is the typed reason `"quota"`. Autocomplete failing never
fails a search that answered.

**The score** (`placeScore.ts`, pure). Every result is scored 0–1 against
the query:

| Part | Value | From |
|---|---|---|
| name | 0–0.5 | the share of the query's name words the result's name carries; a word it carries only the start of ("Pru" of "Prudential") counts half |
| area | +0.2 / −0.2 / 0 | the area the user named: carried, absent, or none named |
| distance | 0–0.15 | full within 3 km of the bias point (the phone inside the city, else the city's center), linear to 0 at 15 km; full when there is no bias point at all |
| poi | +0.1 | the query names something other than a neighborhood, and the result is a business, venue, or landmark |
| rank | +0.05 | its source listed it first |

Names match loosely: case, punctuation, and stretched letters don't
count ("Moo" is "Mooo...."), abbreviations are spelled out ("St"), words
run together are the words ("lola42" is "LoLa 42", "Trader Joes" is
"Trader Joe's"), and initials stand for a whole name ("MFA" is the Museum
of Fine Arts). A query word that is the start of a longer name word
("Mass" of "Massachusetts") is a fragment: it counts half, and a name
carried by fragments alone ("Pru" for "Prudential Center") isn't carried
at all. A name word that is only the start of the QUERY word is no match:
a made-up "Blorptastic" isn't a place called "Blorp" (on prod,
2026-10-02, "xyzzy restaurant" was taken for W XYZ Bar at 0.80 this way).
A whole word always is the word, at full credit, however short and
whatever else the name holds: "XYZ bar" and "W XYZ" are W XYZ Bar, as
sure as its whole name.
Generic words ("steakhouse") and an area the user named ("in Seaport")
aren't part of the name; a street address counts as a location word, so a
tapped choice's reply ("Mooo...., 15 Beacon St") resolves to exactly that
location.

**What the scores come to** (`placeMatch.ts` `classifyPlaceMatches`,
against `RESOLUTION_THRESHOLDS = { found: 0.75, ambiguousFloor: 0.6,
ambiguousGap: 0.2, closestFloor: 0.3, distinctM: 250 }`):

- **none**: no result, or — with nothing carrying the whole name — no
  result that both shares a whole word with the query and scores at least
  `closestFloor`. A result that is only nearby and listed first is the
  phone's location by another name, so it is never offered. The covered
  cities' own names don't count as a shared word ("in Boston" says which
  city, not which place).
- **closest_only**: nothing carries the whole name; the best-scoring
  result that shares a word with the query is offered as the closest
  thing, and said as that.
- **found**: one place carries the whole name. Among several, the name as
  it was said wins ("Seaport Hotel" is the hotel), then an exact name
  over a longer one ("Seaport" is the neighborhood, not "Seaport Hotel");
  a named area picks a chain's location there; and results within
  `distinctM` of each other, or that would read the same as choices, are
  one place. If several places remain, the best is taken without a
  question only when it scores `found` or better and every other is more
  than `ambiguousGap` behind it — or when they are streets, neighborhoods,
  and stops of one name in one city (fewer than two businesses), where a
  question is noise.
- **ambiguous**: otherwise — a chain's locations, or the name in two
  cities. The choices are the places at `ambiguousFloor` or better and
  within `ambiguousGap` of the best (every place carrying the name, when
  fewer than two are that strong), nearest the bias point first, at most
  three.

**A neighborhood's name is the neighborhood.** When the query, as a whole
(less a covered city's name: "Back Bay Boston"), is the name of an area
the results say they lie in ("Seaport", "Back Bay", "Fenway"), only a
result called exactly that is the place, the area itself before a T stop
or a park of the same name; a business named after it ("Seaport Hotel")
only carries the name, and gets no business bonus. On prod Apple answered
"Seaport" with businesses alone and the hotel was taken.

The chain asks Nominatim too when Apple's results don't carry the name —
and when the query is a neighborhood's name and no result is that area —
and classifies both sets together. Nominatim knows the neighborhoods
("Seaport", "Back Bay", and "Fenway" all come back as areas).

**The decision row.** Every `geocode_place` call (kind `assistant_tool`)
records `{query, source, confidence, candidates: [{name, lat, lng,
score}]}` — the five best-scored candidates, the winner's source, and any
`failures` (`{provider: "apple_maps", reason: "quota"}`). A search that
looks the place up itself leaves the same record under its own tool name
(rule `place_lookup`). `pnpm -C server verify:places` runs the
device-test phrases through the real chain with no model and prints each
one's source and confidence. It ends with two kinds of control
(`placeControls.ts`): a name that exists nowhere, which must come back
not found or as the closest thing only under the `found` line, and a real
bar said by its own words ("XYZ bar", "W XYZ"), which must be W XYZ Bar
by name at or above it.

`propose_plan`'s input schema is generated from the same zod schemas it
validates with (`MODEL_PLAN_JSON_SCHEMA`, minus the server-attached
fields), so the model sees the real field names; with a bare `object`
it guessed (`kind: "street"`, `title`, `costUsd`) and burned a bounced
call per guess. A turn that proposes a plan without any text gets a
one-line reply ("Here are your options — tap one to go ahead.") instead
of an empty bubble.

Plan shapes (zod-validated at the tool boundary — see
`services/assistant/plans.ts`). A plan is one of four kinds:

- `single_spot`: ≤3 options (street or garage), exactly one
  `recommended`, each with `walkMinutes` and `walkEstimate` (false: an
  Apple walking time from the destination to the pin; true: the
  straight-line estimate, to be shown as "~7 min"), plus the server's
  `destination {lat,lng,label}` (the
  request's place, when the user named one), `provenance {provider,
  searchedAt, garage?}`, `assumptions`, and `recommendedReason`: one line
  on why the recommended option is on top, computed from the final prices
  and walks on the card (`plans.ts` `recommendationReason`): "Cheapest and
  closest — free, 4 min walk", "Cheapest — …", "Closest — …", or "Best
  value — $12.00, 3 min walk; the cheapest is $4.10, 9 min walk".
  "Closest" is claimed only when every other option has a walk to compare.
  The app shows it under the recommended option. Choosing an option (a row
  tap or a map-pin tap, one shared selection) highlights its pin,
  recenters the map on it with a walking route from the destination, dims
  the other pins, and opens its detail card, built from these server
  fields alone.
- `itinerary`: 1–12 stops (address, arrival, duration, street|garage
  choice, cost) with `totalUsd` recomputed server-side and refused when it
  busts the remaining daily budget. Every proposed stop has an arrival
  (pricing needs one), and the stops are stored in arrival order whatever
  order the model listed them in.
- `none_meets` and `no_data`: the two cards that say no. The server
  decides and fills them; neither can be confirmed. See the next section
  but one.

`propose_plan`'s input schema is generated from zod schemas
(`MODEL_PLAN_JSON_SCHEMA`), so the model sees real field names; with a
bare `object` it guessed (`kind: "street"`, `title`, `costUsd`) and burned
a bounced call per guess. What it may send is deliberately small: a
single-spot option is `{id, label?, detail?, recommended?, nearMiss?}`
(the id of a search result — everything else on the option is the
search's), and a "no" is `{kind: "none_meets", nearMissIds?}`. A turn
that proposes a plan without any text gets a one-line reply ("Here are
your options — tap one to go ahead.") instead of an empty bubble.

### The request (server-owned state)

Each conversation holds the user's parking request as one versioned
object, `RequestState` (`services/assistant/requestState.ts`), stored in
`conversations.request_state` (JSONB). The loop loads it before the
turn's first model call and saves it with the turn; a turn that fails
mid-flight saves neither its transcript nor its state. A new
conversation, a row from before request state (null), or a stored value
that isn't a state starts from the empty request. It is deleted with its
conversation (retention, `DELETE /assistant/conversations/…`, `DELETE
/me`).

```json
{
  "version": 3,
  "intent": "park_later",
  "place": { "query": "Fenway", "resolved": null, "candidates": null },
  "window": { "startsAt": "2026-09-26T19:00:00-04:00", "durationMinutes": 120, "source": "user" },
  "hard": { "maxPriceUsd": 20, "maxWalkMinutes": null, "kinds": null, "entryType": null, "covered": null },
  "soft": { "rank": null, "prefer": null },
  "log": [ { "version": 3, "field": "hard.maxPriceUsd", "from": 30, "to": 20,
             "utterance": "actually under $20", "at": "2026-09-26T18:02:11.000Z" } ]
}
```

- `hard` holds the limits an option must meet; `soft` only ranks. A null
  `soft.rank` means the user asked for no ranking, so a search offers
  both the cheapest and the closest (decision 8).
- `window.startsAt` is canonical ET with its offset (an offset-less
  `2026-09-26T19:00` is ET wall-clock time); null means now.
  `window.source` is `user` once the user has set or cleared a window
  field, `default` until then.
- `place.resolved` and `place.candidates` are server-written (the model
  can't set them), from a place lookup: `geocode_place`, or a search that
  finds a named place unresolved and looks it up itself. A new
  `placeQuery`, or clearing it, resets both. When a message IS one of the
  candidates (a tapped chip sends its `reply` verbatim), the loop resolves
  the place from that candidate before the model is called: the choice is
  the user's, and no lookup or model step can lose it.
- `intent` is **derived** after every patch: `hard.kinds` exactly
  `["garage"]` → `garage_or_lot` at any time; else a start more than 15
  minutes ahead → `park_later`; else `park_now`. The empty request is
  `park_now`.
- `log` gets one entry per changed field, derived ones included, with the
  user's words that turn (capped at 200 characters); it keeps the latest
  100 entries.

The searches read it, and nothing else decides what is searched:
`quote_street` and `search_garages` take no place, time, stay, or budget
of their own ("Searching the request, and saying no", below).

**The model's view.** The system prompt ends with a "Current request"
block, re-rendered for every model call so it is never behind an edit:
the state as compact JSON with nulls and the log left out. User words
stay inside their JSON strings, so they can't open a line of their own
in the system prompt. One rule goes with it: "When the user changes
anything about the request, call update_request with only what changed
before searching."

**`update_request`** is the only way the model changes the request. It
is a strict tool (`strict: true`, so the API holds the model's input to
its schema) with a flat schema. Every field is optional: `intent`, `placeQuery`, `startsAt`, `durationMinutes` (1–720),
`maxPriceUsd` (≥ 0, kept to cents), `maxWalkMinutes` (1–120), `kinds`
(`street`/`garage`), `entryType` (`self`/`valet`), `covered`, `rank`
(`cheapest`/`closest`/`balanced`), `prefer` (`valet`, `covered`,
`garage`, `street`), and `clear`, an array of dotted names:
`place.query`, `window.startsAt`, `window.durationMinutes`,
`hard.maxPriceUsd`, `hard.maxWalkMinutes`, `hard.kinds`, `hard.entryType`,
`hard.covered`, `soft.rank`, `soft.prefer`. Last comes `reason`, a note
that changes nothing.

**Nothing is required, on purpose.** Strict tool use generates required
properties first. With `reason` required, live Sonnet 5 wrote the whole
request into it ("Newbury St, Tue Oct 6 2pm, 2h") and closed the object:
17 of 17 calls set no field (local FR run, 2026-09-30). So no free-text
field may be required, and a test holds the schema to that.

The strict schema can't carry
ranges (the API rejects `minimum`/`maximum` on strict tools), so the
server checks them. A value replaces the old one (a supersede, never a
range merge). Unmentioned fields keep their values. An equal value (the
same instant in another spelling, a list in another order, a place in
other casing) is no change. Lists are kept in canonical order, and an
empty list clears.

It answers `{version, changed, overrides, state}`: `state` is the full
new request without its log, `changed` the dotted fields that changed,
and `overrides` any intent the model sent that the derivation replaced
(`{field: "intent", requested, applied, why}`). A patch that changes
nothing keeps the version and says "Nothing changed". One that sets no
field at all says so: "reason is only a note", with an example of
fields. Refusals leave the request as it was:

| Refusal | When |
|---|---|
| `invalid_patch` | Not the flat shape: the whole state, an unknown field, a `clear` name not in the list, a value out of range, or one field both set and cleared. The `issues` name the fix. |
| `unreadable_time` | `startsAt` can't be read; the instruction carries the time format and the current time. |
| `too_many_edits` | The turn's third call (at most 2 per turn), so a model can't thrash the request. |

Every call, refusals included, writes an `assistant_tool` decision with
inputs `{tool: "update_request", patch, conversationId}` and outcome
`{version, changed, overrides}` (rule `request_updated`,
`request_unchanged`, or `empty_patch` for a call that set no field), or
the refusal's error (rule `invalid_patch`,
`conflicting_patch`, `unreadable_time`, or `too_many_edits`).

### Searching the request, and saying no

FR-43. The two searches read the request; the server decides what meets
it and what doesn't; `propose_plan` accepts only what the latest search
returned; and the loop no longer builds a plan the model didn't propose.
The code is `services/assistant/search.ts` (pure), the search and
validator methods in `tools.ts`, and the reply check in `loop.ts`.

**What a search reads.** `quote_street` and `search_garages` are strict
tools whose only input is an optional `note`. Anything else a model sends
is ignored. They read from the conversation's request:

- **the place**: `place.resolved`. A named place not yet looked up is
  looked up by the search itself. With no place named, the phone's
  location is the place (`place.source: "default"`), and the card states
  it as an assumption. A place that matched several, or none, is never
  guessed at: the search answers `{error: "place_unresolved", reason,
  candidates?}` and **the turn ends asking the user**, with the candidates
  as chips when there are any. The one fallback from a named place to the
  phone is a `park_now` request whose lookup is *down* (the driver is at
  the curb); the result says so and the model must too. A later request
  with the lookup down asks for an address instead;
- **the window**: `window.startsAt` (now when null) for
  `window.durationMinutes` (two hours when null, said as an assumption).
  A start more than an hour past is `window_in_the_past`, and a search
  that would move a clock time the user named is `requested_time_moved`;
  both tell the model to fix the start with `update_request`;
- **the limits and the ranking**: `hard` and `soft`, below.

A garage search for a NAMED place keeps only garages within 600 m of it
(FR-23), measured from each facility's own coordinates; the rest are
dropped and counted (`garage.droppedForDistance`, with `nearestBeyondM`
so the reply can say how far the closest one is). A search from the
phone's location doesn't clip. A garage offer with no usable price is
dropped and counted too (`garage.droppedNoPrice`): it can't be held to a
budget or shown on a card.

**Walking times (FR-44).** A search of a NAMED place asks Apple for the
real walk from that place to each option's pin before it reads the limits
and the order off the walks: `GET /v1/etas`, `transportType=Walking`, ten
destinations a request (`MAX_WALK_TIMED`, Apple's limit). The options the
search will show are asked about first, then the nearest: what a search
shows is decided by the request's order, not by distance, and on prod
(2026-10-02) the free blocks a Saturday-evening search led with were the
12th to 15th nearest and kept their estimates while ten nearer ones were
timed. If the real walks reorder the list so that an untimed option comes
into view, a second request times it; there is no third
(`MAX_WALK_REQUESTS`). An option that gets one has `walkMinutes =
ceil(seconds / 60)` (never under 1) and `walkEstimate: false`, and a
street option's one-line summary is rebuilt to say that walk. Each of
Apple's answers goes to the pin its echoed destination is nearest, so an
answer left out or moved onto the walkway never lends its time to another
option. Every other option keeps the estimate with `walkEstimate: true`:
options never on view past the first ten, a destination Apple gave no
route to, every option when no place was named (there is no destination
to walk to) or no Apple key is set, and all of them when the call fails
or Apple is out of quota — walking times never fail a search.
Because the search carries them, `maxWalkMinutes` is judged on the real
walk (an option the estimate would pass can come back a near-miss, with
the real minutes as its `actual`), "closest" is the closest by it, and the
card copies both fields from the search like every other fact. The
search's decision row counts them (`walksTimed`). The `no_data` card's
nearest zones and an itinerary's stops still use the estimate.

**What a search answers.** The request's whole search so far at its
current version — both kinds, once both tools have run:

```json
{ "stateVersion": 4, "verdict": "meets",
  "searched": ["street", "garage"], "searchedAt": "2026-09-26T22:05:11.000Z",
  "place": { "lat": 42.3546, "lng": -71.0453, "label": "LoLa 42, Seaport", "source": "user" },
  "window": { "startsAt": "2026-09-26T19:00:00-04:00", "endsAt": "2026-09-26T22:00:00-04:00",
              "durationMinutes": 180, "startsNow": false, "durationSource": "user" },
  "satisfying": [
    { "id": "v4-bos-seaport-blvd-de413d-01", "type": "street", "label": "Street — Seaport Blvd",
      "priceUsd": 0, "walkMinutes": 4, "walkEstimate": false, "distanceM": 271, "durationMinutes": 180,
      "fetchedAt": "2026-09-26T22:05:10.000Z", "axis": "cheapest",
      "zoneId": "bos-seaport-blvd-de413d-01", "summary": "Free after 6 PM on Seaport Blvd — 4 min walk",
      "facts": { … } },
    { "id": "v4-parkwhiz-4521-ab12cd", "type": "garage", "label": "Seaport Garage",
      "priceUsd": 18, "walkMinutes": 2, "walkEstimate": false, "distanceM": 80, "durationMinutes": 180,
      "fetchedAt": "2026-09-26T22:05:11.000Z", "axis": "closest",
      "garageOptionId": "parkwhiz-4521-ab12cd", "provider": "parkwhiz",
      "deepLink": "https://…", "entryType": "self" } ],
  "nearMisses": [
    { "option": { "id": "v4-spothero-88-ab12cd", … "priceUsd": 32 },
      "violates": [ { "field": "maxPriceUsd", "actual": 32, "limit": 30 } ] } ],
  "street": { "radiusM": 400, "zonesInRadius": 6 },
  "garage": { "provider": "parkwhiz+spothero", "found": 5 },
  "instruction": "…" }
```

- `satisfying`: the options that pass **every set `hard` field**, in the
  server's order (at most five are shown). The model never reorders.
- `nearMisses`: the nearest three options that break a limit, each with
  the server's `violates: [{field, actual, limit}]`.
- `relaxSuggestions`: present only when `satisfying` is empty and a limit
  is set. The same filter is re-run over the options already fetched —
  **never another provider call** — with one limit loosened a step
  (price +$5, walk +5 minutes, kinds → both), and each reports
  `{field, to, wouldYield, label, reply}`. Every relaxable limit is
  listed, zero included.
- `verdict`: `meets`; `none_meets` (a limit is set and nothing passes);
  `no_data` (no limit set, nothing found, inside a covered city);
  `outside_coverage` (the same outside one).
- every option id is `v{stateVersion}-{zone id | garage option id}`, so
  an option from before an edit can never pass for a current one.
- `fetchedAt` is when that option's price was fetched (decision 7).
- `garage.unavailable: true` (with `reason`) is a FAILED garage search —
  thrown or typed — and never "no garages".

Which limits an option breaks (`search.ts` `violationsOf`): `maxPriceUsd`
and `maxWalkMinutes` by comparison; `kinds` by the option's type;
`entryType: "valet"` only by an offer that says valet, `"self"` only
against one that says valet; `covered: true` by everything, since no
source says whether a garage is covered. What can't be verified doesn't
count as met.

**The order (decision 8).** `streetOptions.ts` `rankOptions` is a pure
sort keyed by `soft.rank`: `cheapest` is price then walk; `closest` is
walk then price; `balanced` is price + $0.50 per minute of walk. A
matched `soft.prefer` takes a fixed $1.00 off an option's score: it
reorders, never filters, and never changes the price shown. Ties go to
the cheaper, the nearer, then the id. `orderForRequest` puts the request's
ask first:

- **no ask** (no rank, and a limit on neither or both of price and walk):
  the cheapest and the closest satisfying options lead, labeled
  `axis: "cheapest"` and `axis: "closest"` — one entry, `axis: "both"`,
  when one option is both — and the rest follow by balanced score;
- **an ask** (a rank, or a limit on exactly one of price and walk): the
  option that best honors it comes first, and the best satisfying option
  on the other axis rides second with `secondary: true`. It is an
  alternative, never the recommendation. A secondary option is chosen
  among the satisfying ones only, so "under $20" never surfaces one over
  $20.

`axis` is what an option truly is by price and walk alone, so a label
never says "cheapest" of an option a preference lifted over a cheaper
one.

**The latest search.** A search's result is the conversation's latest
search: held for the turn, and read back on the next one from the stored
transcript (`search.ts` `lastSearchIn`), so "go ahead and propose" after
a question proposes what the last turn found, across restarts and
machines. It is good to propose from only at the request's current
version and for ten minutes (prices are for when they were fetched; the
garage sources' own cache lasts as long).

**The validators.** `propose_plan` holds a single-spot plan to these, in
order. Each refusal is audited (`assistant_tool`) under its own rule and
goes back to the model with what to do:

| # | Rule | Refusal |
|---|---|---|
| V1 | Every option id is in the latest search, run at the request's current version and still fresh. No other field stands in for the id. | `stale_or_unknown_option` with `optionIds`, `validIds`, `stateVersion`, and a `hint` (search first; the request changed; the search is old) |
| V2 | `priceUsd`, `walkMinutes`, `walkEstimate`, `durationMinutes`, `startsAt`, `zoneId`, the street facts, a garage's `provider` and `deepLink`, and the pin are copied from the search. Nothing the model sends for them is read. | none: a price it typed that differs is recorded as `model_price_mismatch` `{optionId, modelPriceUsd, priceUsd}` |
| V3 | An option from `nearMisses` may be on the card only with `nearMiss: true`; it then carries the server's `violates`. The model's are discarded. | `hard_constraint_violation` with `optionIds` and their `violates` |
| V4 | With nothing satisfying, the only plan is the "no". With something satisfying, a "no" is refused. | `must_say_no` / `options_available` (with the search, so the model can propose from it) |
| V5 | An itinerary's total is recomputed and held to the caller's own daily cap (`policyFor(user)`). There is no per-plan cap (decision 9). | `plan_over_daily_cap` |
| V6 | Every dollar amount in the reply is one the server stands behind (below). | the sentence is dropped; `ungrounded_number` |

The card is then built by the server. Its options are in the search's
order, and **the option that honors the ask is always on it and first**:
the first satisfying option is added if the model left it out, and with
no ask both the cheapest and the closest are. The first option holds
`recommended` whatever the model marked. A model's `label` or `detail`
is kept only where it can't mislead: a near-miss is named by the server,
and words quoting an amount that isn't that option's own fall back to
the server's. The card's `note` is held to V6. An itinerary's first
proposal is still outside V2: its per-stop prices are the ones the model
read off `build_itinerary`, summed and capped but not re-quoted (#132).

**`none_meets`: the server says no.** When the verdict is `none_meets`
the model calls `propose_plan({kind: "none_meets"})`, and the server
fills the card:

```json
{ "kind": "none_meets",
  "headline": "Nothing under $2.00 near Cambridge Common. Closest: Street — Mass Ave, $4.50, 5 min walk.",
  "constraintsFailed": [ { "field": "maxPriceUsd", "limit": 2, "nearestActual": 4.5 } ],
  "nearMisses": [ { "id": "v3-bos-mass-ave-1", "type": "street", "priceUsd": 4.5, …,
                    "nearMiss": true,
                    "violates": [ { "field": "maxPriceUsd", "actual": 4.5, "limit": 2 } ] } ],
  "relaxSuggestions": [ { "field": "maxPriceUsd", "to": 7, "wouldYield": 2,
                          "label": "Allow up to $7.00", "reply": "Allow up to $7.00" } ],
  "destination": { … }, "assumptions": "Now–4:00 PM, near Cambridge Common" }
```

- The verdict is never taken on half a search. Before it stands, the
  server runs whichever search the request allows that hasn't run at this
  version: street always (our own data, and what "street or garage is
  fine" would yield), garages unless the request rules them out. If that
  turns something up, the "no" is refused `options_available`.
- Up to three near-misses (`nearMissIds` picks which; by default the
  nearest), each with what it breaks. They are for information: the
  confirm route refuses them.
- `relaxSuggestions` with `wouldYield > 0` are the reply's `suggestions`.
  A tap sends the plain sentence as the user's next message, so the USER
  changes the request, through `update_request`. The assistant never
  loosens a limit itself.
- **The reply is the card's `headline`, word for word.** Whatever the
  model wrote that turn is dropped, so no phrasing of its own can restate
  a near-miss as a fit.
- If the model searches, finds nothing, and still won't propose after the
  one reminder, the loop issues this card itself — the only card it ever
  issues on its own, through the same tool.
- Stored as `assistant_plans.kind = "none_meets"`; its `assistant_plan`
  decision has rule `none_meets`.

**`no_data`: nothing there to refuse.** Both searches empty, inside a
covered city, with no limit set, is a gap in the data, not a refusal, and
gets its own card and rule (`no_zone_here`), so coverage gaps show up as
themselves:

```json
{ "kind": "no_data", "rule": "no_zone_here",
  "headline": "Our data has no street parking or garages within 800 m of you. The nearest metered block is on Brattle St, about 900 m away.",
  "radiusM": 800,
  "nearestZones": [ { "zoneId": "…", "street": "Brattle St", "zoneNumber": null,
                      "distanceM": 900, "walkMinutes": 15, "lat": 42.37, "lng": -71.12 }, … ] }
```

`nearestZones` are the three nearest zones within 3 km. The same
emptiness outside the covered cities is no card: the search's verdict is
`outside_coverage`, a "no" proposed there is refused `outside_coverage`,
and the model says it in a sentence.

**Tool failures.**

- *Garage search down on a garage-only request* (`intent:
  "garage_or_lot"`): the search itself ends the turn on a `none_meets`
  card with `constraintsFailed: [{field: "garageSearch", reason:
  "unavailable"}]`, no near-misses, and **no street substitute** — the
  user asked for a garage. The reply is "I couldn't check garages right
  now." with one chip, "Try again". Its decision rule is
  `garage_search_unavailable`.
- *Garage search down otherwise*: the search result carries
  `garage.unavailable`, the model proposes the street options, and the
  card's `provenance.garage` is `"unavailable"` ("couldn't check
  garages", never "no garages").
- *Place lookup down*: as "the place" above.
- Each failure is audited: `garage_search_error` (with the source's
  `error` and `detail`), `place_unresolved` (with the `reason`).

**No synthesized plan.** A turn that searched owes the user a card; the
model is reminded once. If it still ends in prose and something *did*
meet the request, there is **no card**: the loop used to build one from
whatever the turn had quoted, which could re-propose an option the user
had just ruled out. The reply is checked (next), and its suggestions are
one chip, "Search again".

**The reply check (V6).** After the loop, every sentence of the reply
that states a dollar amount the server doesn't stand behind is dropped
(`loop.ts` `scrubUngroundedAmounts`; "$20" and "$20.00" are the same
amount), and an `assistant_reply` decision with rule `ungrounded_number`
records the amounts. What the server stands behind:

- the request's own budget, and what a relax suggestion would make it;
- the prices on this turn's card (a single spot's options that meet the
  request, with their meter/fee split and hourly rate; an itinerary's
  stops, total, and cap);
- the latest search's satisfying options — except in a turn that searched
  and ended with no card, which is a quote in prose and keeps none;
- amounts the other tools reported in this conversation (the request, a
  day's quotes and budget, past sessions, an explanation).

A near-miss's price is never among them: the card says it, with what it
breaks. A question the SERVER asked (an unresolved place) is its own
words and isn't checked. A `none_meets` or `no_data` reply needs no check:
it is the headline.

### Saved conversations

Every turn saves the conversation. Its model context (`turns`, the last
20 messages) is cut only where a user message starts, because a cut
inside a tool round-trip would leave a context the Messages API refuses,
and a resumed conversation would fail on its next turn. Beside it the
server keeps:

- `title`: the first request, set once;
- `display`: the transcript as the user saw it, `[{role, text, at,
  planId?, suggestions?}]`, appended every turn and never trimmed with the
  model context (capped at 400 entries).

A conversation saved before these existed reads from what its context
still holds. The confirm tap stamps the plan (`assistant_plans.confirmed_at`,
`confirmed_option_id`), so a conversation knows what it came to.

- `GET /assistant/conversations?limit=20&cursor=…` → `{conversations:
  [{id, title, createdAt, updatedAt, messageCount, outcome}], nextCursor,
  retentionDays}`, newest first (by last use). `outcome` is what it came
  to: the plan the user confirmed most recently (`kind` `garage` |
  `street` | `itinerary`, a `label` like "Garage — Underground Deck",
  `amountUsd`, `planId`), else the latest proposed plan (`kind:
  "proposed"`, e.g. "3 options proposed, from $0.00"; a "no" card reads
  "Nothing met the request" or "No parking data for that place"), else
  null.
- `GET /assistant/conversations/:id` → `{id, title, createdAt, updatedAt,
  messages, plans: [{planId, plan, confirmedAt, confirmedOptionId}],
  outcome}`. The app opens it read-only: earlier plans show without
  actions, since their prices were for then. Sending `POST
  /assistant/message` with its id resumes it, grounding and all.
- `DELETE /assistant/conversations/:id` → `{deleted: 1}`;
  `DELETE /assistant/conversations` → `{deleted: n}`. Both write an
  `assistant_history` decisions row.

Another user's conversation is `404 conversation_not_found`, whether
listing, reading, or deleting it.

**Retention: 90 days.** `jobs/conversationRetentionTick.ts` (hourly)
deletes every conversation not used for
`ASSISTANT_CONVERSATION_RETENTION_DAYS` (default `90`): the transcript
and the model context. The money records a conversation led to are
kept under their own rules: plans, garage bookings, itineraries, and the
decisions ledger. A deleted conversation just stops being linked from
Activity. Each purge that deletes anything writes one
`assistant_history` / `retention_purge` decisions row with the cutoff and
the count. `DELETE /me` deletes them all at once, as before.

### POST /assistant/confirm

`{planId, optionId?, stops?}` — the tap. Mints the single-use token
(10-minute TTL) and executes the confirmed option through the same
token-gated tools the model faces. Two things have nothing to confirm and
are refused `409` **before any token is minted**, each with its own
decision: a `none_meets` or `no_data` card (`nothing_to_confirm` — and
any plan kind this route doesn't know, which must never fall through to
the itinerary sign-off), and a near-miss option on a single-spot card
(`near_miss_not_confirmable`: the user changes the limit, and the next
search offers it as an option that meets the request). Otherwise:

- garage option → `{kind: "garage_handoff", deepLink, paymentSource,
  linkApproval, linkSkipped?, bookingId, note}` — the app opens the
  option's own checkout link (SpotHero or ParkWhiz — `note` names which)
  in SFSafariViewController; the pass lives in that site's account. We
  NEVER automate either site's login or checkout. `paymentSource` is
  `link_wallet` when a Link spend request was made (the app walks the user
  through the approval, then the one-time card for that checkout — see
  "Link wallet"), else `garage_checkout` (the user pays there). The
  booking is recorded (`garage_bookings`) for Activity.
- street option → `{kind: "street_confirmed", zoneId, providerZoneNumber,
  durationMinutes, paymentSource, linkApproval: null}` — the session
  itself starts through the existing detector → /parked → /session/start
  flow at the curb, paid by the street source (`provider_card` or
  `parkagent_card`; never Link). `providerZoneNumber` is the pay-by-app
  number (null when the zone has none yet); `zoneId` is the internal slug
  and is not for display.
- itinerary (no optionId) → `{kind: "itinerary_signed_off", itineraryId,
  totalUsd, capUsd, stops, paymentSource, linkApprovals[], linkSkipped?}`
  — the day total is re-checked against `daily_cap_usd` at the moment of
  sign-off (`409 over_daily_cap`, nothing stored and no Link request
  made). `stops` (optional) are the stops as the user left them on the
  card: they are **re-priced on the server** exactly as the price route
  below prices them (their `costUsd` is never read), and the day signs
  off with those server prices, in arrival order; Link spend requests use
  the re-priced garage amounts, and the per-stop session-cap check applies
  to them. Without `stops` the plan signs off at its own prices. Each stop
  is stored with what pays it: street stops the street source; garage
  stops `link_wallet` (one approval per paid garage stop) or
  `garage_checkout`. Garage stops are recorded as planned bookings. The
  `itinerary_signed_off` decision records which stops were re-priced.

### POST /assistant/plans/:planId/price

`{stops}` → the itinerary card's live price before sign-off. The app calls
it after every stop edit. Stops match the proposed plan's by `id` (`400
unknown_stop`); a present arrival must parse (`400 unreadable_time`);
someone else's plan or an unknown one is `404 plan_not_found`; a
single-spot plan is `400 not_an_itinerary`.

Each stop is priced on the server (`AssistantTools.repriceStops` — the
same path `quote_street` and `build_itinerary` use). The client's
`costUsd`, `zoneId`, `garageOptionId`, and `deepLink` are **never read**:

- nothing that sets the price changed (arrival, duration, street vs
  garage, lat/lng) → the plan's own price and fields;
- a changed street stop → re-quoted at the nearest zone for its new
  window (observed terms applied, the stay clamped to the zone's max);
- a changed garage stop → the garage search for its new window, first
  option (its id, link, and price — what `build_itinerary` would pick);
- no set time, no zone at the point, no garage, or the search is down →
  the last price, marked `estimate: true`.

```json
{
  "planId": "…",
  "stops": [ { "id": "s1", "arrival": "2026-01-05T10:00:00-05:00", "costUsd": 30.35, … },
             { "id": "s2", "arrival": null, "costUsd": 8, "estimate": true, … } ],
  "totalUsd": 38.35,
  "capUsd": 60,
  "spentTodayUsd": 0,
  "remainingUsd": 60,
  "fitsCap": true
}
```

Stops come back in arrival order. `fitsCap` is `spentTodayUsd + totalUsd
<= capUsd`, the same test sign-off applies. Writes an `assistant_confirm`
decision (rule `itinerary_repriced`) with the re-priced ids, estimates
and why, and each stop's server price.

Link is used only when it is the Wallet's active source, connected, and
`link_wallet_for_plans` isn't `false`. A spend request becomes a
spendable card once approved, so it is a money path and is **checked
before it is made**: `linkSkipped` says why none was — `dry_run` (either
dry-run switch on, unless `LINK_TEST_MODE`, whose requests carry
`test: true` and can't charge), `session_cap_exceeded` (a garage over
`session_cap_usd` — each garage stop is its own purchase, so the cap
binds each stop, never their sum), `daily_cap_exceeded` (today's real
spend — sessions and garages already approved in Link — plus requests
still awaiting approval today, plus this confirm's whole plan — an
itinerary's street stops included — over `daily_cap_usd`; a pending
request holds its room because approving it makes it spendable), or
`link_failed`. None of these block the handoff — the user can still
pay at the garage's own checkout. The confirm's decision row records
`spentTodayUsd` and `linkPendingTodayUsd`.

The token authorizes the TAPPED option only: `book_garage` /
`start_session` refuse it for any other option id, zone, or duration,
and claim it with one conditional update (unused and unexpired), so two
concurrent uses of one token can't both pass. A Link spend request names
the real payee — the garage's own site.

### GET /assistant/itineraries · PATCH /assistant/itineraries/:id

Signed-off days (last 10) and stop editing/reordering. A PATCH
**re-prices** the edited stops against the STORED day by the same rules as
the price route (an unchanged stop keeps its stored price, a changed one
is re-quoted, the client's costs are never read; a stop new to the day is
priced fresh), re-checks the cap with those server totals (`409
over_daily_cap`, audited, the day unchanged), and preserves per-stop
linkage (attached session ids, pushed garage links, payment source)
across the edit — except a re-priced garage stop, whose link is pushed
again before its new arrival. The response carries the stored stops. The itinerary worker
(60 s) pushes each garage stop's deep link 15 minutes before arrival
(`itinerary_garage_link` push), attaches street sessions that start
inside a stop's window, and marks the day `done` when the last window
passes.

**Stop order.** One rule, applied by the server on propose, PATCH, and
GET, and by the app on every render (`plans.ts` `orderStopsByArrival`,
iOS `ItineraryOrder`): a stop with no set time keeps the slot it is in;
the timed stops fill the other slots in ascending arrival (ties keep
their order). So a later stop never sits above an earlier one, and only
an untimed stop is placed by hand — the app offers drag and Move up/down
for those alone; changing a stop's time re-sorts it.

**No set time.** A PATCH stop's `arrival` may be `null` (or omitted) —
the user cleared it; a present arrival must parse (`400
unreadable_time`, `stopId`) and is stored as ET with its offset. An
untimed stop has no window: no garage-link push, no street session
attached by time, and it keeps the day open until the end of its date.
Its `costUsd` stays what it was priced at, marked `estimate: true`. The
`itinerary_edited` decision records `untimedStops` and what was re-priced.

### Garage providers (SpotHero + ParkWhiz)

`services/garage/` — a provider-agnostic `GarageProvider` interface with
two read-only implementations, merged by `makeMultiGarageProvider`:

- **SpotHeroDeepLinkProvider** — read-only search over the public
  transient-search endpoint, 10-minute cache, ≤8 options. Checkout is a
  prefilled deep link: `spothero.com/checkout/{facility_id}?starts=&ends=`,
  which opens THAT facility with the window filled in (verified live
  2026-09-23; the old area-search link only showed the neighborhood).
  SpotHero reads a window's wall-clock digits and ignores any offset
  (verified 2026-09-24: `22:00Z` rendered a 10 PM checkout for a 6 PM ET
  stay), so windows go to it as ET wall-clock time with no offset.
- **ParkWhizProvider** — the same contract over ParkWhiz's public
  `api.parkwhiz.com/v4/quotes` endpoint, which serves unauthenticated
  JSON at low volume with honest headers (spike verified 2026-09-23; see
  `docs/assistant-verification.md`). Checkout is the API's own
  `site:purchase` link. `PARKWHIZ_ENABLED=false` drops back to SpotHero
  alone.

The merge dedupes by normalized facility address — the same garage is
often listed by both, and the user should see one row at the cheaper
price — and returns at most 8 rows, nearest first. Option ids are
`{provider}-{facilityId}-{windowTag}`: the same facility searched for two
windows is two offers with two prices and two checkout links, and the
two providers' numeric facility ids overlap. A provider that fails while another answers shows up in
`degraded`; only every-provider-failed is a typed search failure.

**Partner status: no API key for either**, so both hand checkout off and
`canReserve` is false. When partner API access arrives for either, a
`PartnerApiProvider` implements the same interface and exactly three
things change: `canReserve` flips true, `book()` returns
`{kind: "reserved", confirmationId}` instead of a deep-link handoff, and
the confirm response stops saying "the pass lives in SpotHero". If either
site ever starts refusing these reads (401/403/429), the adapters return
the typed `blocked` error — that is their call and our stop, never
something to work around. The
adapter also carries the documented **Shared Payment Token seam**
(`garageProvider.ts`): if a garage provider ever accepts Stripe SPTs, the
reserved-booking path is where an SPT checkout would go — no parking
provider accepts them today (2026-09), so it stays a comment, not code.

## Link wallet for agents

Stripe's Link CLI/agentic-commerce surface
(docs.stripe.com/agentic-commerce/link-cli) as the Wallet's `link_wallet`
way to pay. **Scope: assistant plans and garages** — each paid garage
(single spot or itinerary stop) is one spend request the user approves in
Link, and the approved one-time card pays the garage's own checkout.
**Street meters never use Link**: a street meter is paid by the executor
with the provider account's saved card, and both providers keep a single
saved card (ParkNYC's card setup replaces the default; Passport's pay flow
takes the first saved card), so a per-session Link card would overwrite
the user's own card — which we can never put back, since we never hold its
number. A `link_wallet` user's street meters stay on the card on their
provider account, and the Wallet says so.

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
  customer approval at its `approval_url`) per paid garage stop. Limits
  per agent integration: $500/request, $500/day, 30 concurrent active, 10
  concurrent approved, 50 creations/hour, **10-minute approval window**.
- The approved credential is a **one-time-use virtual card**, valid
  until `valid_until` = **12 hours from spend-request creation**, and it
  is **not merchant-locked** ("works at any seller that accepts cards
  online"). `context` must be ≥100 characters and is shown on the
  approval screen.
- Test mode: spend requests carry `test: true` (`LINK_TEST_MODE`), Link
  returns test credentials (e.g. `4000009990001984`) and nothing
  charges.

**Unverified — needs the registered OAuth client + sandbox:** the raw
REST paths under `api.link.com` that `link-cli spend-request …` and
`payment-methods list` wrap are not publicly documented;
`services/link/linkClient.ts` mirrors the CLI contract behind
`LINK_API_BASE` and is marked VERIFY-IN-SANDBOX.

Endpoints: `GET /link/status`, `POST /link/connect` (returns the
authorization URL), `GET /link/callback` (public — the OAuth redirect;
`state` binds it to the user), `POST /link/disconnect`,
`POST /link/spend-requests/:id/sync` (the app polls after an approval;
on approval the one-time card is SEALED server-side with
PROVIDER_STATE_KEY crypto), and `POST /link/spend-requests/:id/card`.

**`POST /link/spend-requests/:id/card`** — the approved one-time card, for
the user to pay the garage's own checkout with (we never automate that
checkout, so the card has to reach the person at it). Only the caller's
own request, only while `approved`, unexpired, and unused — and only
ONCE: the first successful retrieval claims the card by stamping
`revealed_at` with a compare-and-set (only where it is still null), so of
any number of calls, concurrent ones included, exactly one gets the
number, and every later one answers `410 card_already_revealed`.
`Cache-Control: no-store`; the app asks for Face ID first and hides it
after 30 seconds. Every reveal — and every refusal (`404
unknown_spend_request`, `410 card_already_revealed`, `409 not_approved` /
`card_expired` / `card_used` / `card_unreadable`) — writes a `decisions`
row (kind `link_card_reveal`) that never carries the number. Only those
named codes ever leave the route, in the body, the decision, or the log:
any other error answers `500 reveal_failed` and is logged by its class
name alone, since an error's message can quote what it was handling.
`POST /link/spend-requests/:id/sync`, which fetches the card to seal it,
does the same (`404` / `409` / `503` named codes, else `502
sync_failed`).

**Approval timeout.** Each request stores its `approval_expires_at`
(creation + 10 minutes). The wallet job expires every request still
waiting past it (compare-and-set on the waiting statuses, so an approval
landing mid-sweep isn't overwritten; decision `approval_expired`,
`charged: false`), and a sync of an expired request answers `expired`
without asking Link — a late approval can't revive it.

**Payment method.** On connect, and at most every 10 minutes when
`GET /wallet` asks, the wallet's default payment method is read from Link
(display only — type, brand or bank, last4) for "Link · Visa ••1234";
a failed read keeps the cached one. "Manage in Link" opens
`https://app.link.com`.

The daily cap applies across every source: a garage approved in Link
(`approved` / `succeeded`) counts into today's spend everywhere the cap is
checked — quotes, session starts and extensions, auto-extend, the
assistant — and a request still awaiting approval also holds its room
against further Link requests. Env: `LINK_CLIENT_ID`,
`LINK_CLIENT_SECRET`, `LINK_PUBLISHABLE_KEY`, `LINK_REDIRECT_URI` (all
four or none — without them the Wallet shows "Link — coming soon"),
optional `LINK_TEST_MODE`.

## Wallet

One place that answers "how am I paying, and what have I spent", for
three ways to pay — one active at a time (`users.payment_source`):

| Source | What pays | Available |
|---|---|---|
| `provider_card` (default) | the card saved on the user's ParkNYC/ParkBoston account | always |
| `link_wallet` | the user's Stripe Link wallet — assistant plans' garages, each approved in Link; street meters stay on the provider account's card | when `LINK_*` is configured and the user has connected Link |
| `parkagent_card` | our virtual Issuing card on every linked parking account, funded per session by a hold on the user's own saved card | `ISSUING_LIVE`, or `sandbox: true` from a Debug build while `STRIPE_SECRET_KEY` is a test-mode key (nothing real can move) |

There is **no stored balance** anywhere: the ParkAgent card spends only
against per-leg holds (see `POST /session/start`), Link holds nothing,
and the provider card is the provider's business.

### GET /wallet

```json
{
  "activeSource": "provider_card",
  "dryRun": true,
  "options": [
    { "source": "provider_card", "availability": "available", "needs": null, "sandbox": false },
    { "source": "link_wallet", "availability": "connect", "needs": "connect_link", "sandbox": false },
    { "source": "parkagent_card", "availability": "coming_soon", "needs": null, "sandbox": false }
  ],
  "providerCard": { "cards": [{ "provider": "passport", "displayName": "ParkBoston", "city": "bos", "brand": "Visa", "last4": "1234" }] },
  "link": {
    "configured": true, "connected": false,
    "paymentMethod": { "type": "card", "brand": "Visa", "last4": "1234" } | null,
    "pendingApprovals": [{ "spendRequestId": "lsrq_…", "amountUsd": 4.1, "merchantName": "SpotHero", "approvalUrl": "https://…", "expiresAt": "…" }],
    "manageUrl": "https://app.link.com",
    "covers": "plans_and_garages"
  },
  "parkagentCard": {
    "live": false, "sandboxSelectable": false,
    "fundingMethods": [{ "id": "…", "brand": "Visa", "last4": "4242", "wallet": "apple_pay", "expMonth": 12, "expYear": 2031, "isDefault": true }],
    "card": { "stripeCardId": "ic_…", "last4": "4444", "brand": "Mastercard", "status": "active", "expMonth": 8, "expYear": 2030, "cardholderName": "…" } | null
  },
  "providers": [{
    "id": "passport", "city": "bos", "cityDisplayName": "Boston", "displayName": "ParkBoston",
    "status": "linked",
    "paysWith": { "source": "provider_card", "brand": "Visa", "last4": "1234" } | null,
    "attention": null
  }],
  "spending": { "todayUsd": 4.1, "dailyCapUsd": 60, "sessionCapUsd": 45, "monthUsd": 41.81,
                "byCity": [{ "city": "bos", "cityDisplayName": "Boston", "monthUsd": 16.53 }, …],
                "linkMonthUsd": 18 },
  "activity": { "items": [ …first five of GET /wallet/activity… ], "nextCursor": null }
}
```

- `availability`: `available` | `connect` (a one-time setup first:
  `needs` is `connect_link` or `add_card`) | `coming_soon`. `sandbox` marks
  a ParkAgent card that's selectable only as sandbox (a Release build
  shows it as coming soon).
- `providers[].paysWith`: what pays street meters on that account under
  the active source — `null` while it can't pay (not connected, expired).
  `attention`: `connect`, `reconnect` (expired or expiring),
  `add_parkagent_card` (ParkAgent card active but not on this account yet),
  or `own_card_replaced` (the account carries the ParkAgent card while
  another source is active — the user must add their own card back in the
  provider's app).
- `spending` counts real money only (dry-run sessions moved none),
  whatever paid: today (ET day, the caps' clock — the same figure the
  daily cap is checked against, so it includes garages approved in Link)
  against `daily_cap_usd`, and the month. The month splits into street
  meters per city (`byCity`) plus `linkMonthUsd` (garages approved in
  Link, which have no meter city); together they add up to `monthUsd`.
- Brand/expiry/name on `parkagentCard.card` are read live from Stripe
  (best effort — the card still renders from our mirror).

### GET /wallet/activity

`?limit=20&cursor=…` (limit 1–50) → `{items, nextCursor}` — every way
money moved, newest first, merged across three kinds; `cursor` is opaque
(echo `nextCursor`). Items share `{id: "<kind>:<row id>", kind, at,
createdAt}`:

- `session` — `sessionId, city, cityDisplayName, providerDisplayName,
  zoneNumber, street, durationMinutes, meterUsd, feeUsd, totalUsd, status,
  dryRun, paymentSource, explanation, startedAt, expiresAt, stoppedAt, lat,
  lng, receipt: {providerConfirmation, decisionId, holds: [{leg, heldUsd,
  capturedUsd, status, paymentIntentId}]}, timeline: [{kind, at, minutes,
  amountUsd, code}]`. `explanation` is one plain sentence ("Paid with your
  card on ParkBoston ••1234.", "Your card was declined — nothing was
  paid.") — never a raw code. The timeline interleaves session events with
  hold placed/captured/released.
- `garage` — `bookingId, label, provider, providerDisplayName, priceUsd,
  startsAt, endsAt, status (handed_off | planned), paymentSource,
  deepLink, link: {spendRequestId, status, approvalUrl} | null, receipt:
  {optionId, planId}`.
- `link_payment` — a Link request not already shown on a garage row:
  `spendRequestId, amountUsd, merchantName, status`.
- `plan` — a plan made in the assistant that isn't already a garage row:
  a street spot confirmed there (it pays when the car parks; the row gives
  way to the session row once a session starts in that zone after the
  confirm) or a signed-off day (its stop count and total are the signed-off
  itinerary's, edits included). `planId, planKind (street | itinerary),
  label, plannedUsd, explanation, conversationId`. `plannedUsd` is what it
  was priced at, not money moved: the real amounts are the session and
  garage rows, and the app shows no amount for a plan row.

Garage and plan rows made in the assistant carry `conversationId`, the
conversation they came from, while that conversation is still saved.
Otherwise it is null. The app's detail screen offers "Open the
conversation".

### PUT /wallet/source

`{source, sandbox?, consentReplacePaymentMethod?}` → `{activeSource,
setupJobs: [{provider, jobId}], decisionId}`. Readiness is validated:

| Refusal | When |
|---|---|
| `409 link_not_configured` | `link_wallet` without `LINK_*` |
| `409 link_not_connected` | `link_wallet` before the user connected Link |
| `409 parkagent_card_not_live` | `parkagent_card` without `ISSUING_LIVE`, unless `sandbox: true` against a test-mode key |
| `503 stripe_not_configured` | `parkagent_card` with no Stripe |
| `409 no_funding_method` | `parkagent_card` with no saved card to hold against |
| `400 consent_required` (+ `providers`) | `parkagent_card` while a linked account still carries another card — putting ours on it replaces that card |

Choosing the ParkAgent card creates it if needed (the old
`POST /card/prepare`) and chains setup-card onto every linked account that
lacks it (`setupJobs`; poll `/providers/:provider/link-status`; dry run
records `wouldAdd` and touches no provider). `provider_card` is always
accepted. Every call writes a `decisions` row (kind `payment_source`).

### Saving a card for the ParkAgent card

1. `POST /wallet/setup-intent` `{sandbox?}` → `{setupIntentId,
   clientSecret, customerId, merchantId}`. Creates the user's Stripe
   Customer once (idempotency key per user, first writer stored) and a
   SetupIntent (`usage: off_session`, cards — Apple Pay included). Refused
   `409 parkagent_card_not_live` exactly like the switch. Nothing is
   charged; it moves no money, so it works in dry run.
2. The app confirms it — Apple Pay first (`merchant.com.thomasbardhi.parkagent`),
   or card entry in PaymentSheet.
3. `POST /wallet/funding-methods` `{setupIntentId, makeDefault?}` →
   `{fundingMethod}`. The intent must be the caller's (else `404
   unknown_setup_intent`) and `succeeded` (else `409 setup_not_complete`);
   brand, last4, expiry, and the Apple Pay wallet flag are stored — Stripe
   ids only, never a number. Idempotent per payment method, overlapping
   duplicates included (the one that loses the unique insert answers with
   the winner's row). The first card (or `makeDefault`, the default)
   becomes the default here and on Stripe. The same setup posted again
   after its card was removed reactivates the removed row — but only while
   Stripe still has the payment method on this Customer; removing detaches
   it, and Stripe never lets a detached card pay or be attached again, so
   otherwise it answers `409 funding_method_removed` (decision rule
   `funding_method_readd_refused`) and the card is added afresh through a
   new SetupIntent.

`PUT /wallet/funding-methods/:id/default` switches the default.
`DELETE /wallet/funding-methods/:id` detaches it — refused `409
funding_method_in_use` when it's the ParkAgent card's only card, and `409
hold_in_progress` while a leg's hold on it is open; the newest remaining
card is promoted. Each writes a `decisions` row (kind `wallet_funding`).

### The wallet job

Every minute (`jobs/walletTick.ts`): settle ParkAgent-card holds still
`held` 15 minutes after placing (capture what was authorized, release the
rest), and expire Link approvals past their window. A settle Stripe
refuses because the intent already settled on its side
(`payment_intent_unexpected_state`) closes the hold as `failed` once,
instead of retrying every minute; any other failure puts it back for the
next sweep.

**Sandbox.** Before `ISSUING_LIVE` the ParkAgent card is a test-mode
card, so setup-card never runs for real: choosing it in sandbox (or
re-linking as a sandbox ParkAgent-card user) records `sandbox` on the
`provider_setup_card` decision and leaves every real parking account's
own card alone. Saving a card and holds run against Stripe test mode;
a real ParkAgent-card session needs `ISSUING_LIVE`.
