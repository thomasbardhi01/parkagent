# ParkAgent

Personal prototype: detect that a car has parked in a metered zone, quote
the cost, pay via the city's app (ParkNYC / ParkBoston) within a budget,
and auto-extend using a cost-based rule. Anyone can sign up with Sign in
with Apple (email codes and Google are built but switched off) and connect
their own city's parking account in one guided step. Two cities (NYC and Boston —
zones and sessions rows carry a `city`); Boston zone numbers aren't in the
open data, so they come from the Passport Find Parking feed importer
(`data/import_parkboston_zones.py` → `pnpm -C server load:zone-numbers`)
plus driver reports of the posted number
(`POST /zones/:zoneId/provider-number`, verified when two users agree —
a verified report beats an import, an import beats a single unverified
report) and the executor types the stored number in. The Passport flow is
verified through the Vehicles chooser (which also yields provider-observed
zone terms — `zone_terms_observed` beats the dataset when quoting); the
screens after it remain drafted TODO-verify until the first paid
recording. Two users, iOS only.

## Locations
The checkout lives at `~/Documents/parkagent`; the `feat/nyc-data` worktree
at `~/Documents/parkagent-data`. There is no repo at `~/parkagent` — if a
tool claims there is, it is pointed at a stale path.

## Layout
- data/      Python scripts that fetch NYC/Boston open data and build zone GeoJSON
- server/    Fastify + TypeScript API on Fly.io; Prisma + Postgres/PostGIS
- executor/  Playwright scripts that drive ParkNYC web (isolated, replaceable)
- ios/       SwiftUI app: park detection, location reporting, session UI;
             the Xcode project is generated, see "iOS project" below
- policy.json  Spending and extension rules; server reads it at boot

## Prerequisites
    brew install git gh nvm pnpm xcodegen flyctl stripe/stripe-cli/stripe
    brew install python@3.12 uv

`xcodegen` is required for any iOS work — `ios/ParkAgent.xcodeproj` does not
exist in a fresh checkout until you generate it. Xcode is needed too, from the
Mac App Store.

## Non-negotiables
- Any code path that moves money checks DRY_RUN and policy.json first.
- Never store card numbers or Playwright auth state in the repo. Stripe IDs only.
- Every automated decision writes a row to the `decisions` table with its inputs.
- The executor is the only module allowed to touch ParkNYC. Nothing else imports it.
- Never create a provider account without the user present, never store a
  provider password, never automate a terms checkbox, a verification code,
  or a captcha. Link-or-create prefills empty TEXT inputs on the
  provider's own page and nothing else (see "Accounts" below).

## Accounts (identity + sessions)
Users sign in with Apple (identity token verified against Apple's JWKS,
audience `APPLE_AUDIENCE`) — the only method on by default. Email codes
(`EMAIL_SIGNIN_ENABLED` + `RESEND_API_KEY`) and Google
(`GOOGLE_SIGNIN_ENABLED` + `GOOGLE_CLIENT_ID`) are built but switched off:
their routes answer `403 <method>_signin_disabled`, the server boots
without any of their settings, and the Welcome screen shows only what
`GET /auth/methods` reports on. A sign-in
returns a 15-minute HS256 access JWT (`AUTH_JWT_SECRET`) plus an opaque
refresh token: stored hashed, bound to a device id, 60-day sliding
expiry, **rotated on every use**, and replay of a rotated token revokes
the whole family. Verified-email matches merge into one account.

`Authorization: Bearer` is how the app authenticates; `x-api-key` remains
for admin and scripts only, and the iOS app no longer carries a key at
all (tokens live in the Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
so background detection can refresh while locked and a restored backup
never carries a refresh family to a second phone). Carry an existing
script-made user across with
`pnpm -C server attach-identity -- --user <id> --email <e> [--apple-sub <s>]`.

`DELETE /me` tombstones the users row rather than deleting it — the
`decisions` ledger needs a valid user id, so the person goes and the id
stays. See server/API.md "Identity & sessions" for the full contract.

A daily job (`jobs/providerHealthTick.ts`) verifies each linked provider
session headlessly and pushes "Reconnect …" when one is expiring or
expired, so it is fixed before the next park. The `expiring` status still
pays — use `providerStatusUsable()` from the registry, never
`status === "linked"`.

## Working style
- Small PRs on feat/* branches, squash-merged into main.
- All changes land through a PR — no direct pushes to main, no exceptions.
  Before any commit, check `git branch --show-current`; if it says main,
  branch first (the checkout can land on main after a PR merge).
- Run `pnpm -r lint && pnpm -r test` before proposing a change.
- `pnpm install` registers a lefthook pre-commit hook (see lefthook.yml):
  lint-staged runs prettier and eslint --fix on staged files, then the server
  tests run. `git commit --no-verify` bypasses it in a pinch; `pnpm format`
  reformats the whole repo.
- Ask before adding a dependency over ~50 KB or any native module.
- When touching Swift, note that background location and motion permissions
  are already configured; do not add new entitlements without asking.

## iOS project
`ios/ParkAgent.xcodeproj` is generated by XcodeGen and is gitignored. After
pulling, or any time `ios/project.yml` changes, run:

    cd ios && xcodegen generate

Never hand-edit the `.xcodeproj` — `.pbxproj` merge conflicts are miserable, and
your edits are erased on the next generate. Change `ios/project.yml` instead.
`ios/ParkAgent/Info.plist` and `ios/ParkAgent/ParkAgent.entitlements` are also
generated from `project.yml`, so add plist keys and entitlements there too.

First checkout also needs `cp ios/Config.example.xcconfig ios/Config.xcconfig`
and your `DEVELOPMENT_TEAM` filled in; the file is gitignored and holds
`API_BASE_URL`, which reaches the app through Info.plist via `AppConfig`.
There is no `API_KEY` any more — the app authenticates as the signed-in
user.

Sign in with Apple needs the capability on the App ID; the entitlement is
declared in `project.yml`. On an UNSIGNED simulator build
(`CODE_SIGNING_ALLOWED=NO`, how the tests run) every Keychain call fails
`errSecMissingEntitlement` (-34018), so `Keychain.swift` keeps a
in-memory fallback — without it nobody could stay signed in on the
simulator. It is compiled only into DEBUG *simulator* builds: a Debug
build on a phone never has it, so a locked-phone Keychain error can't
quietly sign the app out onto an empty store.

The app talks to the **live API on every build**, Debug included. `MockAPI`
activates only for a launch carrying `-useMockAPI YES` (the UI tests) or
inside a SwiftUI preview, and the choice is never persisted — a missing
`API_BASE_URL` puts the app on `UnconfiguredAPI` (a visible error state:
the welcome screen's sign-in failure, or Home's banner once signed in),
never a silent swap to fixtures. Launch order is Welcome (no valid
session) → the onboarding truth gate (`State/OnboardingGate.swift`, the
one place that decides which setup step is missing) → Home. Developer
tools live in `Settings/DiagnosticsView.swift`, reached by tapping the
version number in the Account sheet's About section five times, and
compiled out of Release.

Maps use MapKit for now; Mapbox is a possible later swap and nothing outside
the map views should depend on MapKit types.

The app depends on the Stripe iOS SDK (SPM, declared in `project.yml`) to
save the card the ParkAgent card's per-session holds are placed on — a
SetupIntent confirmed with Apple Pay or PaymentSheet (nothing is charged;
there is no stored balance). `Support/StripeWallet.swift` is the only file
that imports it, and the mock never reaches it. Live confirmation needs
`STRIPE_PUBLISHABLE_KEY` in `Config.xcconfig` plus the one-time Apple Pay
merchant setup (`merchant.com.thomasbardhi.parkagent`; see server/API.md
"Apple Pay setup").

The tabs are Park · Activity · Wallet. The Wallet answers "how am I
paying, and what have I spent" for three ways to pay (`provider_card`
default, `link_wallet`, `parkagent_card`); one `WalletModel` on AppModel
feeds the Wallet, the Account sheet's "How you pay" row, and onboarding's
pay step, and `Views/Wallet/WalletCopy.swift` holds every sentence about
paying — so the three never disagree. Link never pays a street meter (the
provider keeps one saved card); see server/API.md "Wallet".

The Wallet's "Add to Apple Wallet" is behind `FeatureFlags.applePayProvisioning`
(default off, showing "coming soon"). Turning it on for real requires the
`com.apple.developer.payment-pass-provisioning` entitlement, which Apple
grants only after an application through Stripe (support-issuing@stripe.com)
— add it to `project.yml` when approved, plus `STPPushProvisioningContext`
(see AddToWalletButton.swift).

## Pinned versions
Two server deps are deliberately held below `latest`. Don't bump them casually.
- `prisma` / `@prisma/client` pinned to `^7`. The `latest` npm tag currently
  points at an `8.0.0-rc`, and installing it gives a v8-rc CLI against a v7
  client, which is a broken pair. Bump both together once v8 is stable.
- `typescript` pinned to `6.x` in server/ and executor/. TS 7 builds fine,
  but no typescript-eslint release supports it yet, so lint hard-errors.
  Revisit when typescript-eslint ships TS 7 support (their issue #10940).

Note that Prisma 7 reads `DATABASE_URL` from `prisma7.config.ts`, not from
`schema.prisma`. That config and `server/src/index.ts` both load the repo-root
`.env` by explicit path, because `pnpm -C server dev` runs with cwd `server/`
and bare `dotenv/config` would miss it.

## Executor (Phase 5 + provider accounts)
The real executors (ParkNYC/Flowbird and ParkBoston/Passport) are the
Playwright package in `executor/`;
`server/src/services/parknycExecutor.ts` is its only importer. Auth is per
user: each user links their own ParkNYC account (cookies from the app's
login web view via `POST /providers/:provider/link`), sealed with
AES-256-GCM under the `PROVIDER_STATE_KEY` secret in `provider_accounts`.
Real calls run only with env `DRY_RUN=false`, the state key set, and a
linked account for the zone's provider; each call gets a fresh browser
context on one warm shared Chromium process. The old single-secret
`PARKNYC_STATE_PATH`/`PARKNYC_STATE_JSON` plumbing is gone
(`pnpm -C executor run login` remains as a local way to capture cookies).
Its tests are unit tests over recorded fixture HTML; they never launch a
browser or touch ParkNYC, and nothing in `executor/` runs in CI (CI only
compiles it — `pnpm -C server build` needs `executor/dist` types, so run
`pnpm -C executor run build` first). It is a personal-use prototype
against ParkNYC's own web app; issue #37 tracks moving it to a private repo
before any customer use. Details: `executor/README.md`.

## Commands
- `pnpm -C server dev`         start the API locally
- `pnpm -C server prisma migrate dev`   apply migrations
- `pnpm -C server migrate:policy-fee`   move parknyc_fee_usd into city_overrides
- `./scripts/check-city-neutral.sh`     fail on hardcoded city/provider names
- `pnpm -C server attach-identity -- --user <id> --email <e>`  give an existing user a sign-in identity
  (or `--api-key-prefix <8 chars>` in place of `--user`; on prod:
  `fly ssh console -a parkagent-api -C "node dist/scripts/attach-identity.js …"`)
- `pnpm -C server create:fr-throwaway`  mint a throwaway session for FR-32's live tests (needs the target's DB + AUTH_JWT_SECRET)
- `pnpm -C executor run login`     headed browser; sign in to ParkNYC once, save auth state
- `pnpm -C executor run record`    record a real ParkNYC flow (HAR/trace/screens) to fixtures/
- `pnpm -C executor run build`     compile (server build needs its d.ts first)
- `uv run data/fetch_nyc.py`   refresh raw NYC data
- `uv run data/build_zones.py` rebuild zones.geojson
- `uv run data/fetch_boston.py`         refresh raw Boston meter data
- `uv run data/build_boston_zones.py`   rebuild boston_zones.geojson
  (load either file with `pnpm -C server load:zones [--file …]`, once per city)
