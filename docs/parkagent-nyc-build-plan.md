# ParkAgent — NYC Prototype Build Plan

Goal: an iOS app + small server that detects you've parked in a NYC metered zone, looks up the block's rate and max stay, starts (or asks you to confirm) a paid session within a budget, and auto-extends using a cost-based rule. Built for one user (you), one car, one city.

Design principle for the prototype: **every automated action has a dry-run mode first.** You'll run the whole loop for a week with "would have paid $X for zone Y" notifications before any money moves.

---

## Phase 0 — Accounts and tools (half a day)

| Need | Action |
|---|---|
| GitHub | Create a private repo `parkagent`. Enable branch protection on `main` later. |
| Apple Developer | $99/yr program membership. Required for background location, push notifications, and running on your own phone for more than 7 days. |
| Xcode | Install current Xcode from the App Store. Open it once so the command-line tools install. |
| Node | Install `nvm`, then `nvm install --lts`. Use pnpm: `npm i -g pnpm`. |
| Claude Code | `npm i -g @anthropic-ai/claude-code`, then `claude` in the repo. Verify install steps at the docs since they change. |
| Stripe | Create an account. You'll use **test mode** for the whole prototype. Live Issuing needs business verification; don't block on it. |
| Fly.io | Install `flyctl`, sign in. Free-tier-ish Postgres + one small machine is enough. |
| NYC Open Data | No account needed for downloads. Create a free Socrata app token anyway to avoid rate limits. |
| ParkNYC | Register, add your plate and a payment method. Do a few manual sessions so you know the flow. |

---

## Phase 1 — Repo layout and dev environment (half a day)

> **Status: complete** (2026-09-20) — monorepo, CI, env validation, hooks: PRs #39, #40.

Monorepo, one language per layer:

```
parkagent/
  CLAUDE.md                 # project brief for Claude Code
  README.md
  .github/workflows/ci.yml  # lint + test on PR
  data/                     # scripts to fetch/build the zone dataset
    fetch_nyc.py
    build_zones.py
    out/zones.geojson       # gitignored, rebuilt
  server/                   # TypeScript, Fastify, Prisma, Postgres
    src/
      routes/               # /parked, /session, /policy, /health
      services/             # zoneLookup, policy, executor, extender, issuing
      jobs/                 # extension tick worker
    prisma/schema.prisma
    fly.toml
  executor/                 # Playwright scripts for ParkNYC web (Node)
  ios/ParkAgent/            # SwiftUI app
  policy.json               # the rules; server reads this at boot
```

**CLAUDE.md** (write this first; Claude Code reads it every session):

```
# ParkAgent
Personal prototype: detect parking in NYC, pay via ParkNYC within budget, auto-extend.
Stack: SwiftUI iOS app; Fastify+TypeScript server on Fly.io; Postgres via Prisma;
Playwright executor; Stripe Issuing (test mode).
Rules:
- All money-moving code paths check policy.json and DRY_RUN env var first.
- Never store card numbers. Only Stripe IDs.
- Log every decision with its inputs to the `decisions` table.
- Prefer small PRs. Run `pnpm test` before proposing changes.
```

Git hygiene: `main` is deployable, work on `feat/*` branches, squash-merge. Add `.env` to `.gitignore` on day one.

Use Claude Code for: scaffolding each package, writing the GeoJSON builder, the Prisma schema, Playwright scripts, and Swift boilerplate. Review everything it writes that touches money or location permissions.

---

## Phase 2 — Zone data (one day)

> **Status: complete** (2026-09-20) — 10,576 passenger zones fetched, built, and loaded into PostGIS (dev and prod): PR #42.

NYC publishes exactly what you need.

1. **Download two datasets** from NYC Open Data (data.cityofnewyork.us):
   - *Parking Meters — ParkNYC Block Faces*: line segments with meter rates and zone info per blockface.
   - *Parking Meters — Citywide Rate Zones*: polygons with rate-zone boundaries.
   - Optionally *Parking Regulation Locations and Signs* for max-stay and hours where the blockface data is thin.
2. **`data/fetch_nyc.py`**: pull via the Socrata API as GeoJSON, save raw to `data/raw/`.
3. **`data/build_zones.py`**: for each blockface, build a record:
   ```
   { zone_id, parknyc_zone_number, rate_first_hour, rate_additional_hour,
     max_stay_minutes, hours_json, geometry (buffered line, ~12 m each side) }
   ```
   Buffer the blockface line into a polygon so a GPS fix on the curb lands inside it. Emit `zones.geojson`.
4. **Load into Postgres** with PostGIS enabled. Index with GiST. Lookup is `ST_Contains(geom, point)`; on a miss, nearest blockface within 25 m; on a bigger miss, return "unknown zone."
5. **Sanity check**: pick 10 blocks you know, query them, compare to the ParkNYC app and the sign. Expect some mismatches; log them. This is your accuracy baseline.

Refresh monthly; rates change.

---

## Phase 3 — Server (two days)

> **Status: complete** (2026-09-20) — /parked quoting end to end with decisions audit, policy service, migrations on deploy, verified live on Fly: PRs #43, #46 (sessions/executor stubbed until Phase 5).

Fastify + TypeScript + Prisma + Postgres on Fly.io.

**Tables**: `users`, `vehicles`, `zones`, `parked_events`, `sessions`, `decisions`, `policy_snapshots`.

**Endpoints**:
- `POST /parked` — `{lat, lng, accuracy, ts, signals[]}` from the phone. Runs zone lookup → policy check → returns `{action: "pay" | "confirm" | "ignore" | "unknown_zone", zone, quote}`.
- `POST /session/start` — called by the app after confirm (or automatically if policy allows). Invokes executor.
- `POST /session/stop`, `POST /session/extend`.
- `POST /location` — periodic phone location while a session is active (feeds the extender).
- `GET /policy`, `PUT /policy` — read/edit the rules from the app.
- `POST /webhooks/stripe` — Issuing authorization events.

**Policy service** implements `policy.json`:

```json
{
  "dry_run": true,
  "session_cap_usd": 45,
  "daily_cap_usd": 60,
  "auto_pay_max_rate_per_hour": 8.00,
  "default_stay_minutes": 90,
  "auto_extend": { "enabled": true, "max_count": 2, "max_minutes_each": 60,
                   "no_extend_within_minutes_of_max_stay": 15 },
  "respect_enforcement_hours": true,
  "ticket_cost_usd": 65
}
```

Every decision writes a `decisions` row: inputs, rule fired, outcome. You'll read this table constantly.

**Deploy**: `fly launch` in `server/`, attach Postgres, set secrets (`DATABASE_URL`, `STRIPE_SECRET_KEY`, `APNS_*`). Add a `/health` route and a GitHub Action that runs tests then `fly deploy` on merge to `main`.

---

## Phase 4 — iOS app (three to four days)

> **Status: complete** (2026-09-21) — design system, screens on a mock API,
> detection/reporting/push plumbing, appearance + UI tests: PRs #47, #50,
> #51, #54; onboarding + multi-city surfacing: #63. The detector's
> three-signal fusion (settling burst, red-light clearing, signal log,
> unit-test target) landed in the pre-field-test audit PR.

SwiftUI, minimum iOS 17. Three jobs: detect parking, report location, show/approve sessions.

**Capabilities to enable**: Location (Always), Background Modes (location updates, remote notifications), Push Notifications. Add `NSMotionUsageDescription` and location usage strings.

**Parked detector** (`ParkDetector.swift`):
- `CMMotionActivityManager` → watch for `automotive` ending and `stationary`/`walking` beginning.
- `CLLocationManager` with significant-change + a short burst of high-accuracy fixes right after the motion transition, so you get a good resting coordinate.
- Car Bluetooth: observe `AVAudioSession` route changes for the car's audio output disappearing (works for CarPlay and BT audio without special entitlements).
- Rule: fire a `parked` event when motion says "was driving, now not" AND (BT disconnect within 90 s OR location has been still for 60 s). Debounce for 3 minutes so a red light doesn't trigger it.
- Store the car's coordinate locally; it's the anchor for "distance to car."

**Reporter**: while a session is active, send location to `/location` every 60 s (background location). Stop when the session ends.

**UI**: one screen. Current session (zone, expiry countdown, spend), a Stop button, a Confirm/Decline card when the server returns `confirm`, a log of the last 20 decisions, and a policy editor.

**Notifications**: APNs via the server. Four templates: session started, extension applied, needs confirmation, max-stay warning.

Run on your own phone via Xcode with your developer account. Walk around your block to test the detector before the car test.

---

## Phase 5 — Session executor (two days, and the fragile part)

> **Status: code complete, awaiting paid verification** — ParkNYC
> (Flowbird) client + fixtures/tests: PRs #56, #59; per-user linked
> provider accounts replacing the single storage-state secret: #61;
> ParkBoston (Passport) client + shadow mode: #62; driver-reported Boston
> zone numbers: #64. Outstanding: the first PAID `record` run against
> each provider (ParkNYC and ParkBoston) — post-zone screens are drafted
> TODO-verify until then.

There is no public ParkNYC API. For the prototype, run Playwright in `executor/` against the ParkNYC web experience, logged in with your own account.

1. Manually capture the flow once: sign in → enter zone number → select vehicle → choose duration → confirm. Save selectors.
2. Write `startSession(zone, minutes)`, `extendSession(sessionId, minutes)`, `stopSession(sessionId)`. Each returns `{ok, sessionId, expiresAt, amount}` or a typed error.
3. Store the browser auth state (`storageState.json`) as a Fly secret so you don't log in every time.
4. Wrap each call with a screenshot on failure, saved to the `decisions` row.
5. Optional: on an unexpected screen, send the DOM text + screenshot to the Claude API and ask for the next click. Keep the happy path hardcoded; use the model only for recovery.

Fallback when the executor fails: the server sends a "tap to pay" notification with the zone number prefilled in your clipboard. The agent still saved you the lookup.

Keep this module isolated so it can be swapped for a real integration later without touching policy or the app.

Note: automating a consumer app against its terms is fine as a personal experiment; it is not what you ship.

---

## Phase 6 — Stripe Issuing, test mode (one day)

> **Status: complete in test mode** (2026-09-21) — card setup, real-time
> authorization webhook, ledger: PR #52; E2E fixes (real-time response
> shape, card setup): #55; Card tab + card endpoints: #57; card lifecycle
> + provider-account chaining: #61; Apple Pay top-ups: #63. Outstanding
> (by hand): live Issuing application, Apple Pay merchant ID + Stripe
> certificate, Wallet provisioning entitlement.

1. Create an Issuing cardholder (you) and one virtual card.
2. Set spending controls: `allowed_categories: ["parking_lots_garages"]` (MCC 7523), `spending_limits` matching `policy.json` (per-authorization and daily).
3. Enable real-time authorization: subscribe to `issuing_authorization.request` at `/webhooks/stripe`, approve only if the amount fits remaining daily budget and a session is pending. Decline otherwise.
4. In test mode, simulate authorizations from the Stripe CLI to exercise the webhook.
5. Add the card to ParkNYC only when you leave dry-run and have live Issuing. Until then, your normal card stays on ParkNYC and Stripe is exercised purely through webhooks.

---

## Phase 7 — Extension worker (one day)

> **Status: complete** (2026-09-21) — worker, /location feed, APNs pushes:
> PR #53; per-city ticket-risk pricing: #62; stale-fix and at-the-car
> hardening in the audit PR.

`server/src/jobs/extendTick.ts`, run every 60 s for each active session:

```
remaining      = expiresAt - now
walkEta        = routing(phoneLoc → carLoc)          // straight-line × 1.3 if no routing API yet
heading        = toward | away | still               // from last 3 phone fixes
pReturnInTime  = f(remaining, walkEta, heading, dwellModel)
costExtend     = extendPrice + fee
costTicket     = ticketCost × (1 - pReturnInTime)
if remaining <= 12 min and costTicket > costExtend × 1.2 and policyAllows:
    minutes = clamp(P80(remainingDwell), 15, maxEach, maxStay - elapsed - buffer)
    extend(minutes) ; log decision
elif remaining <= 12 min and near max stay:
    notify("Move the car")
```

Start `dwellModel` as "median of your past sessions at this location, else default_stay." Replace with something learned once you have 50+ sessions.

Hysteresis: once a decision is made for a session, don't reverse it for 5 minutes.

---

## Phase 8 — Test on yourself (two weeks)

> **Status: next.** The pre-field-test audit PR (chore/audit) hardened
> every surface and added `GET /admin/summary` + the detector signal log;
> docs/field-test-checklist.md is the step-by-step runbook for the Boston
> and NYC dry-run days.

Week 1, **dry run**: `dry_run: true`. Drive normally. The app detects parks, the server quotes, you get "would have paid $X for zone Y, Z min" notifications, and you pay manually as usual. Each evening, read the `decisions` table. Track:
- Detection precision (false parks per day) and recall (missed parks).
- Zone accuracy (quoted zone vs. sign).
- Quote vs. actual paid.

Fix the detector thresholds and zone buffer until you get a few days clean.

Week 2, **assisted**: `dry_run: false` but `auto_pay: false`. Every session needs your one-tap confirm. Executor runs for real. Extension worker runs for real, capped at one extension.

Then, **autonomous** for zones under the rate ceiling, confirm-only above it.

Ship milestone: five consecutive days of correct autonomous sessions with zero tickets and no manual intervention.

---

## Order of work, condensed

1. Accounts, Xcode, Node, Claude Code, repo + CLAUDE.md
2. NYC data → PostGIS → lookup verified on 10 known blocks
3. Server with /parked returning quotes (dry run)
4. iOS detector + reporter, notifications
5. Executor against ParkNYC web
6. Stripe Issuing test mode + webhook
7. Extension worker
8. Dry run week → assisted week → autonomous

Roughly three to four weeks of evenings. The data and server pieces are the ones to do first, because they're what you'd reuse if you later pivot the detection or payment layers.

---

## Beyond the plan: Boston (2026-09)

The prototype grew a second city, which the original plan didn't cover:
Boston zone data with a `city` column and per-city fees (PR #60), per-user
provider accounts (#61), the Passport/ParkBoston executor with shadow mode
(#62), onboarding around provider linking + Apple Pay top-ups (#63), and
driver-reported zone numbers — ParkBoston publishes none and its web app
has no map (#64). `zones` and `sessions` rows carry `city`; policy has
`city_overrides` (fee, ticket cost).
