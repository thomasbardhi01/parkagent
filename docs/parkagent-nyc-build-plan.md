# ParkAgent — NYC Prototype Build Plan

Goal: an iOS app + small server that detects you've parked in a NYC metered zone, looks up the block's rate and max stay, starts (or asks you to confirm) a paid session within a budget, and auto-extends using a cost-based rule. Built for one user (you), one car, one city.

Design principle for the prototype: **every automated action has a dry-run mode first.** You'll run the whole loop for a week with "would have paid $X for zone Y" notifications before any money moves.

## Status (2026-09-25, `v1.0.0-rc3` = `79413c4`)

This is the original plan, with each phase's real status added in a quote
block. The prototype outgrew it: two cities, sign-up for anyone, a Wallet
with three ways to pay, and a parking assistant. Those are under "Beyond
the plan" at the end.

| Phase | Status | Delivered by |
|---|---|---|
| 0 Accounts and tools | done; Apple portal setup for TestFlight remains | — (#67) |
| 1 Repo and dev env | complete | #1, #3, #4, #35, #39, #40 |
| 2 Zone data | complete for NYC and Boston; ground truth pending | #42, #60, #64, #87, #105, #111 |
| 3 Server | complete, hardened, gated by a CI boot check | #43, #46, #49, #65, #79, #116, #133 |
| 4 iOS app | complete; Release builds proven free of debug code | #3, #47, #50, #51, #54, #63, #104, #119, #123, #118, #124, #130 |
| 5 Session executor | ParkBoston verified paid; ParkNYC awaits its paid run | #56, #61, #62, #87–#94, #106, #109, #112, #113 (#24) |
| 6 Stripe Issuing | complete in test mode, reshaped into the Wallet; live needs Stripe | #52, #55, #57, #61, #112, #124, #134 (#66) |
| 7 Extension worker | complete; one extension at a time per session | #53, #62, #65, #124, #134 |
| 8 Test on yourself | **next**: the Boston field days | #130 (plan); #71, #135 |

What's left lives in three milestones:
- **Field test**: Apple developer setup (#67), the Boston dry-run day (#71), and the Boston real-money day (#135).
- **TestFlight 1.0**: the App Store Connect record and API key (#136), TestFlight secrets and App Privacy (#137), the first upload (#138), the final accounts-server review (#140), the Anthropic spend limit (#101), the NYC dry-run day (#72, #45), and inviting friends in dry run (#139, #32).
- **App Store 1.0**:
  - the Sign in with Apple device check (#142);
  - key rotation (#48) and a private repo (#37);
  - real money in NYC (#24, #44);
  - the assisted and autonomous weeks (#33, #34);
  - everything waiting on a partner: Stripe Issuing (#66, #126, #125, #68), Link (#100, #127, #128), SpotHero/ParkWhiz/Passport (#102, #141, #103, #36);
  - code follow-ups (#22, #70, #110, #132).

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

> **Status: complete** (2026-09-20). Server and iOS scaffolds, Dockerfile, CI
> deploy, env validation, hooks, Dependabot: PRs #1, #3, #4, #35, #39, #40.
> CI has since grown `city-neutral` (#119), `executor` with Chromium (#93),
> the iOS unit and Release-binary gate (#130), and `boot` (#133). Deploy
> needs `server`, `boot`, and `ios`.

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

> **Status: complete for both cities.**
> - **NYC:** 10,576 passenger zones fetched, built, and loaded into PostGIS on dev and prod (#42).
> - **Boston:** zones built from meter data with a `city` column and per-city fees (#60).
> - **ParkBoston zone numbers** aren't in the open data. They come from the Passport Find Parking import (#87, #105, #111) plus driver reports, verified when two users agree (#64).
> - **Outstanding:** ground truth against posted signs (#45); Boston max stay from observed terms instead of the blanket 2 hours (#110); an optional Street View bootstrap (#70).

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

> **Status: complete.**
> - `/parked` quoting end to end with the decisions audit, the policy service, and migrations on deploy (#43, #46, #49).
> - **Hardening:** hashed API keys, admin authz, rate limits, webhook idempotency, `/admin/summary` (#65, #79).
> - **Identity:** Sign in with Apple, rotating refresh tokens, `DELETE /me` tombstones (#118).
> - **Proof:** a live FR suite runs nightly against prod in dry run (#116, #121, #122).
> - **Boot check:** since the v70 outage (`docs/incidents.md`), CI boots the real server before every deploy (#133).

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

> **Status: complete (1.0.0).**
> - **Foundations:** design system, screens, detection/reporting/push plumbing, UI tests (#47, #50, #51, #54); onboarding and multi-city (#63); two-of-three detector fusion and the signal log (#65); polish (#104, #108).
> - **Real device build:** the live API on every build, the truth-gated onboarding, curb lines on the map, Diagnostics (#119, #123).
> - **Sign-up and the Account sheet** (#118).
> - **Tabs** Park · Activity · Wallet (#124).
> - **1.0.0-rc1 (#130):** Release builds carry no debug code (FR-34, proven in CI); a time-sensitive "Parked in zone …" notification; App Store readiness (privacy manifest, opaque icon, account deletion).
> - **Outstanding:** a fuller policy editor (#22). Only the per-stop cap, daily cap, and default stay are editable, and only by an admin. TestFlight is #136–#139.

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

> **Status: ParkBoston verified with real money; ParkNYC awaits its paid run.**
> - **ParkNYC** (Flowbird) client with fixtures and tests (#56, #59).
> - **Per-user linked provider accounts**, sealed with `PROVIDER_STATE_KEY` (#61).
> - **ParkBoston** (Passport) client and shadow mode (#62), then its flow screen by screen (#87–#94, #106) and the Vehicles chooser with observed zone terms (#109).
> - **Real ParkBoston sessions:**
>   - a paid start through receipt (#112);
>   - extend walked for real (#113);
>   - stop is unsupported in Boston, since meter time isn't refundable;
>   - an operator lockout is typed `parking_denied`.
> - **CI:** executor tests with Chromium (#93).
> - **Outstanding:**
>   - ParkNYC's paid `record` run (#24).
>   - Passport card management, used only by the ParkAgent card (#126).
>   - A few extend-path checks on the Boston real-money day (#135).

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

> **Status: complete in test mode, then reshaped into the Wallet.**
> - **Issuing basics:** card setup, the real-time authorization webhook, the ledger (#52, #55); the Card tab and card lifecycle (#57, #61); Apple Pay top-ups (#63).
> - **#112** made the user's own card on the provider (`provider_card`) the default, with Issuing behind `ISSUING_LIVE`.
> - **#124** replaced the stored balance with a **Wallet** of three ways to pay:
>   - `provider_card` (live);
>   - `link_wallet` (garages only, "coming soon" until the Link OAuth client is set);
>   - `parkagent_card` (per-session holds on the user's own card; "coming soon" until `ISSUING_LIVE`).
> - **#134** fixed the review's findings: the webhook reserves once, and one extension at a time.
> - **Outstanding:** live Issuing and the consumer-program question (#66), its launch checklist (#126, #125), the Apple Pay merchant ID (#67), the provisioning entitlement (#68), and the Link OAuth client (#100, #127, #128).

1. Create an Issuing cardholder (you) and one virtual card.
2. Set spending controls: `allowed_categories: ["parking_lots_garages"]` (MCC 7523), `spending_limits` matching `policy.json` (per-authorization and daily).
3. Enable real-time authorization: subscribe to `issuing_authorization.request` at `/webhooks/stripe`, approve only if the amount fits remaining daily budget and a session is pending. Decline otherwise.
4. In test mode, simulate authorizations from the Stripe CLI to exercise the webhook.
5. Add the card to ParkNYC only when you leave dry-run and have live Issuing. Until then, your normal card stays on ParkNYC and Stripe is exercised purely through webhooks.

---

## Phase 7 — Extension worker (one day)

> **Status: complete.**
> - Worker, `/location` feed, APNs pushes (#53); per-city ticket-risk pricing (#62); stale-fix and at-the-car hardening (#65).
> - Since #124, each extension leg gets its own hold on the ParkAgent card.
> - Since #134, one extension at a time per session: an advisory lock, and `409 extension_in_progress` for the loser.
> - The app's auto-extend toggle became a read-only row, because the worker follows the policy (#130).

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

> **Status: next.**
> - `docs/field-test-plan.md` (#130) is the runbook: the night before, day 1 in dry run in Boston (#71), day 2 with real money on your own card through ParkBoston (#135), and the go/no-go for inviting friends.
> - `docs/field-test-checklist.md` has the per-stop routine and how to read the signal log.
> - The two weeks below map to #32 (dry-run week, with friends in dry run), #33 (assisted), and #34 (autonomous).

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

## Beyond the plan (2026-09)

The prototype grew well past one user, one city.

- **Boston.**
  - Zone data with a `city` column and per-city fees (#60).
  - Per-user provider accounts (#61), and the Passport/ParkBoston executor with shadow mode (#62).
  - Onboarding around provider linking (#63).
  - Driver-reported zone numbers (#64), then the Passport Find Parking import (#87, #105, #111).
  - `zones` and `sessions` rows carry `city`, and policy has `city_overrides` (fee, ticket cost).
- **The parking assistant.**
  - Finds a spot or plans a day (#81–#86).
  - v2 (#117): grounded results, SpotHero plus ParkWhiz garages, per-turn cost accounting, and a per-user daily model-spend cap.
  - Itinerary stops are re-priced on the server (#130). The model's first per-stop prices are next (#132).
- **Accounts** (#118).
  - Sign in with Apple for anyone; email codes and Google are built and switched off.
  - Rotating refresh tokens and link-or-create for the provider account.
  - `DELETE /me` tombstones the user row, and revokes the Apple token (#130).
- **Wallet** (#124, #134). Three ways to pay, holds instead of a stored balance, Link for garages, and Activity.
- **Proof.**
  - The functional-requirements doc and a nightly FR suite against prod in dry run (#116, #121, #122).
  - An acceptance pass with a real Boston payment (#112, #113).
  - Release builds proven free of debug code (#130).
  - A CI boot check after the v70 outage (#133, `docs/incidents.md`).
- **Releases.**
  - `v0.9-prototype` (`0ae01ad`).
  - 1.0.0-rc1 (#130, `45d4f37`): never tagged; it crash-looped prod.
  - `v1.0.0-rc2` (#133, `2a930c4`).
  - `v1.0.0-rc3` (#134, `79413c4`).
