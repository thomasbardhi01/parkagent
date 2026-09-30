# ParkAgent

ParkAgent notices when a car has parked in a metered zone, quotes what the
meter will cost, and pays for the session through the city's pay-by-app
provider (ParkNYC in NYC, ParkBoston in Boston) inside a fixed budget. It
extends the session automatically using a cost-based rule. Anyone can sign
up with Sign in with Apple and connect their own parking account in one
guided step. It covers two cities, NYC and Boston, and runs on iOS only.

It is a monorepo:
- `data/` holds the Python scripts that turn NYC and Boston open data into
  zone geometry.
- `server/` is a Fastify + TypeScript API on Fly.io, backed by
  Postgres/PostGIS.
- `executor/` holds the isolated Playwright scripts, the only thing allowed
  to drive the providers' web apps.
- `ios/` is the SwiftUI app.

Boston zone numbers aren't in the open data. They come from the Passport
Find Parking feed plus drivers reporting a block's posted number, and the
executor types the stored number in.

Heading out to test? Follow [docs/field-test-plan.md](docs/field-test-plan.md)
(which day is dry run, which is real money, and the go/no-go). The
per-stop routine is in [docs/field-test-checklist.md](docs/field-test-checklist.md).

## Status (2026-09-30)

Prod runs **`c0f64cb`** (`v1.0.0-rc3` plus 16 merges; see "Releases") in
**dry run**, which is server-wide: nothing pays until `DRY_RUN` and the
policy both allow it. `/health` reports `"degraded":[]`. A nightly
functional suite (`docs/functional-requirements.md`, FR-1…FR-41) runs
against prod. The 2026-09-30 run passed 61 of 62 tests and skipped one
(FR-9, which only runs off-hours).

**Works today**
- **Sign-in and setup.** Sign in with Apple, with email codes and Google
  built but switched off. Then setup: permissions, car, city, how you pay,
  connect ParkNYC or ParkBoston, and limits. Account deletion revokes the
  Apple token.
- **Detection and quoting.** Detection in the background (two of motion,
  car audio, and location) keeps working with the app closed, and sends a
  time-sensitive **"Parked in zone …"** notification with the quote. A
  park reported with no signal waits in an outbox until it can be sent.
  Curb lines on the map show each block's rate, max stay, and hours.
- **Paying.** A tap pays through the provider with **the card already saved
  on the user's parking account** (`provider_card`), within each user's
  own per-stop and daily caps (never above the policy's ceilings).
  ParkBoston start and extend were verified with real money (#112, #113).
  ParkNYC's paid run is still to do (#24).
- **Auto-extension** by the cost-based rule, one extension at a time.
- **Activity and the Wallet**, which show what paid, what it cost, and how
  you pay.
- **The parking assistant** (Ask ParkAgent) finds a spot or plans a day.
  It resolves the places people name through Apple Maps, says what each
  block is doing at that hour, keeps saved conversations, and takes
  continuous dictation. Garages come from SpotHero and ParkWhiz, and
  checkout happens on their pages in an in-app browser.
- **Requests survive the network.** Idempotency keys on every unsafe
  call, a deadline on every outbound call, and a shutdown that drains work
  in flight. Provider links are background jobs.
- **Release builds carry no debug code**, and CI proves it. CI also boots
  the real server before every deploy, including with every optional
  setting broken. A bad optional secret switches its feature off instead
  of taking prod down.

**Gated on someone else**
- **Stripe.** The **ParkAgent card** (`parkagent_card`, per-session holds on
  your own card) needs live Issuing and an answer on the consumer-program
  question (#66, #126). **Link** needs a registered OAuth client (#100,
  #127). It pays garages only, and street meters wait on Stripe's
  pre-approved limits (#128). Both read "Coming soon" in the app.
- **Apple.**
  - TestFlight needs the App Store Connect record and an API key (#136),
    the pipeline secrets (#137), and the first upload (#138).
  - Apple Pay needs the merchant ID and App ID capabilities (#67).
  - "Add to Apple Wallet" needs the provisioning entitlement (#68).
- **Partners.** Sanctioned API access from SpotHero (#102), ParkWhiz (#141),
  and Passport/Flowbird (#103, #36).

**What's left for V1** is three workstreams, decided on 2026-09-29
([docs/decisions/2026-09-29-v1-scope.md](docs/decisions/2026-09-29-v1-scope.md)).
Each PR is one issue under the **V1** milestone. Order, owners, file
boundaries, and the working agreement are in
[docs/workstreams.md](docs/workstreams.md).
- **WS-1: assistant brain and plan UX** (Tom, #167–#173).
- **WS-2: Boston data and garage inventory** (Nate, #174–#177).
- **WS-3: park now: detection, place outcomes, session lifecycle** (Tom,
  #178–#180).

Ticket capture and garage stays are **V2** (#181–#183). By-hand and
partner work stays in the **Field test**, **TestFlight 1.0**, and **App
Store 1.0** milestones. Phase-by-phase history, and what shipped since
rc3, is in
[docs/parkagent-nyc-build-plan.md](docs/parkagent-nyc-build-plan.md).
Outages are in [docs/incidents.md](docs/incidents.md).

## Releases

| Tag | Commit | What |
|---|---|---|
| `v0.9-prototype` | `0ae01ad` (#114) | Everything through the acceptance pass: two cities, both executors, the assistant, a real Boston payment |
| 1.0.0-rc1 (**known bad**, never tagged) | `45d4f37` (#130) | Release builds without debug code, TestFlight pipeline, field-test plan. Its deploy crash-looped prod (Fly v70); see `docs/incidents.md`. |
| `v1.0.0-rc2` | `2a930c4` (#133) | The rc1 boot fix, plus the CI `boot` job that gates deploy |
| `v1.0.0-rc3` (**latest tag**) | `79413c4` (#134) | Wallet review fixes: per-stop Link gate, webhook reserves once, one extension at a time, removed-card re-add, one-time Link card reveal |
| `v1.0.0-rc4` (**proposed, not tagged yet**) | `c0f64cb` (#164) | What prod runs now. The reliability series (#145, #146, #150, #151), config resilience (#156), the Apple Maps fix, FR isolation, and the supply-chain gate (#162), the requested-time fix (#165), and the Dependabot process (#160). The nightly has been green on it since 2026-09-28. |

## Account ownership

One person owns each external account and adds the other as a team member,
so nobody has to ask later who holds what.

| Account | Owner | Other person's role |
|---|---|---|
| GitHub org or repo | @thomasbardhi01 | collaborator with write access |
| Apple Developer Program | @thomasbardhi01 | App Store Connect team member (Developer role) |
| Stripe | @thomasbardhi01 | team member (Developer role) |
| Fly.io | @thomasbardhi01 | org member |
| NYC Open Data app token | either | share in the vault |
| Password vault (1Password shared vault or Doppler project) | @thomasbardhi01 | member |

Every secret goes in the shared vault, never in Slack, iMessage, or the
repo. `.env.example` is committed, and real values live in `.env`, which is
ignored.

See [CLAUDE.md](CLAUDE.md) for conventions.
