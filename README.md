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

## Status (2026-09-25)

Prod runs **`v1.0.0-rc3`** in **dry run**, which is server-wide: nothing
pays until `DRY_RUN` and the policy both allow it. A nightly functional
suite (`docs/functional-requirements.md`, FR-1…FR-34) runs against prod.

**Works today**
- **Sign-in and setup.** Sign in with Apple, with email codes and Google
  built but switched off. Then setup: permissions, car, city, how you pay,
  connect ParkNYC or ParkBoston, and limits. Account deletion revokes the
  Apple token.
- **Detection and quoting.** Detection in the background (two of motion,
  car audio, and location) sends a time-sensitive **"Parked in zone …"**
  notification with the quote. Curb lines on the map show each block's
  rate, max stay, and hours.
- **Paying.** A tap pays through the provider with **the card already saved
  on the user's parking account** (`provider_card`), within per-stop and
  daily caps. ParkBoston start and extend were verified with real money
  (#112, #113). ParkNYC's paid run is still to do (#24).
- **Auto-extension** by the cost-based rule, one extension at a time.
- **Activity and the Wallet**, which show what paid, what it cost, and how
  you pay.
- **The parking assistant** (Ask ParkAgent) finds a spot or plans a day.
  Garages come from SpotHero and ParkWhiz via deep links, and checkout
  stays on their sites.
- **Release builds carry no debug code**, and CI proves it. CI also boots
  the real server before every deploy.

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

What's left is grouped in three milestones: **Field test**, **TestFlight
1.0**, and **App Store 1.0**. Phase-by-phase history is in
[docs/parkagent-nyc-build-plan.md](docs/parkagent-nyc-build-plan.md), and
outages are in [docs/incidents.md](docs/incidents.md).

## Releases

| Tag | Commit | What |
|---|---|---|
| `v0.9-prototype` | `0ae01ad` (#114) | Everything through the acceptance pass: two cities, both executors, the assistant, a real Boston payment |
| 1.0.0-rc1 (**known bad**, never tagged) | `45d4f37` (#130) | Release builds without debug code, TestFlight pipeline, field-test plan. Its deploy crash-looped prod (Fly v70); see `docs/incidents.md`. |
| `v1.0.0-rc2` | `2a930c4` (#133) | The rc1 boot fix, plus the CI `boot` job that gates deploy |
| `v1.0.0-rc3` (**current**) | `79413c4` (#134) | Wallet review fixes: per-stop Link gate, webhook reserves once, one extension at a time, removed-card re-add, one-time Link card reveal |

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
