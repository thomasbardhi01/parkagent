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
report) and the executor types the stored number in. The Passport flow was
walked with real money (start through receipt in #112, extend in #113;
Boston has no early stop). Its Vehicles chooser also yields
provider-observed zone terms, and `zone_terms_observed` beats the dataset
when quoting. ParkNYC's paid run is still to do (#24). iOS only.

Current release: `v1.0.0-rc3` (79413c4), with prod in dry run. The README
has the status and the release tags. What's left is in three GitHub
milestones (Field test, TestFlight 1.0, App Store 1.0) on project board 3.

## Locations
The checkout lives at `~/Documents/parkagent`. There is no repo at
`~/parkagent`, and no `~/Documents/parkagent-data` worktree any more. A tool
that claims either is pointed at a stale path. Helper-agent worktrees go
under `.claude/worktrees/`, which is gitignored. Remove them, and any
`~/Documents/pa-*` worktree, once their branch has merged.

## Layout
- data/      Python scripts that fetch NYC/Boston open data and build zone GeoJSON
- server/    Fastify + TypeScript API on Fly.io; Prisma + Postgres/PostGIS
- executor/  Playwright scripts that drive the ParkNYC and ParkBoston web apps (isolated, replaceable)
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
- The executor is the only module allowed to touch a provider's site (ParkNYC,
  ParkBoston). Nothing else imports it.
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
stays. It also revokes the person's Sign in with Apple token at Apple
(App Store 5.1.1(v)): the sign-in's authorization code is exchanged for a
refresh token stored sealed, which needs the `APPLE_SIGNIN_KEY` /
`_KEY_ID` / `_TEAM_ID` group; a failed revoke is retried hourly. See server/API.md "Identity & sessions" for the full contract.

A daily job (`jobs/providerHealthTick.ts`) verifies each linked provider
session headlessly and pushes "Reconnect …" when one is expiring or
expired, so it is fixed before the next park. The `expiring` status still
pays — use `providerStatusUsable()` from the registry, never
`status === "linked"`.

## Paying: three sources and their gates
`users.payment_source` picks one. Caps (`session_cap_usd`,
`daily_cap_usd`) bind all three, and "today's spend" counts everything that
paid, including garages approved in Link.
- `provider_card` (default, **live**): the card already saved on the
  user's ParkNYC/ParkBoston account. The executor pays with it. We never
  see the card number.
- `link_wallet`: Stripe Link. It pays **garages only**. Each paid garage is
  a spend request the user approves in Link, and the one-time card is
  revealed once for the garage's own checkout. Providers keep ONE saved
  card, so Link never pays a street meter (#128). `/link/*` answers 503,
  and the app shows "Coming soon", until `LINK_CLIENT_ID` /
  `_CLIENT_SECRET` / `_PUBLISHABLE_KEY` / `_REDIRECT_URI` are set.
  `LINK_TEST_MODE` lets a spend request through under dry run.
- `parkagent_card`: our Issuing card on each linked parking account,
  funded per session by a manual-capture **hold** on the user's own card
  (`services/wallet/holds.ts`). There is no stored balance anywhere. It's
  selectable only with `ISSUING_LIVE=true`, or in a Debug build with the
  Diagnostics sandbox toggle against a test-mode key. Before
  `ISSUING_LIVE`, setup-card never runs against a real provider.

Dry run is effective when env `DRY_RUN` is true OR `policy.json`'s
`dry_run` is. It is server-wide, for every account. `PUT /policy` is
admin-only (`GET /policy` reports `editable`) and rewrites `policy.json`
inside the container, so any restart or deploy, including `fly secrets
set`, reloads the image's copy (dry run on, caps 45/60). To go real: flip
the `DRY_RUN` secret first, then the caps, then the policy.

## Working style
- Small PRs on feat/* branches, squash-merged into main.
- All changes land through a PR — no direct pushes to main, no exceptions.
  Before any commit, check `git branch --show-current`; if it says main,
  branch first (the checkout can land on main after a PR merge). Branch
  protection (admins included) requires the `server`, `ios`, and `executor`
  checks. Only squash merges are allowed, and merged branches are deleted
  on GitHub automatically. The user merges. Auto mode can't.
- CI (`.github/workflows/ci.yml`):
  - `city-neutral` runs `scripts/check-city-neutral.sh`. No city or provider
    names in app/server sources outside the registries. Take names from
    `CityCatalog` / the provider registry.
  - `server`, `executor`, `ios` (unit tests, the `ParkAgentRelease` scheme,
    and the Release-binary `strings` check).
  - `boot` runs `scripts/boot-check.sh off` and `on` against a migrated
    PostGIS.
  - `ui-tests` (`continue-on-error`).
  - `deploy` needs `server`, `boot`, and `ios`. A new optional env var gets
    a line in **both** of `boot-check.sh`'s lists, and anything that logs at
    boot goes through the `app` from `createFastify()`
    (`docs/incidents.md`).
- pnpm 12 passes a literal `--` through to scripts, and a script using
  strict `parseArgs` rejects it. So call `pnpm -C server decisions:recent
  --city bos`, not `… -- --city bos`. Only `attach-identity`,
  `create:fr-user`, and `purge:fr-throwaways` strip the `--`.
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
inside a SwiftUI preview, exists only in Debug builds, and the choice is
never persisted — a missing
`API_BASE_URL` puts the app on `UnconfiguredAPI` (a visible error state:
the welcome screen's sign-in failure, or Home's banner once signed in),
never a silent swap to fixtures. Launch order is Welcome (no valid
session) → the onboarding truth gate (`State/OnboardingGate.swift`, the
one place that decides which setup step is missing) → Home. Developer
tools live in `Settings/DiagnosticsView.swift`, reached by tapping the
version number in the Account sheet's About section five times, and
compiled out of Release. It holds exactly the field-test kit — detector
status, signal-log export, the effective dry run, Reset onboarding, and
the ParkAgent-card sandbox toggle — and nothing else.

**Release builds carry no debug code (FR-34).** Everything mock, scenario,
launch-argument, UI-test-hook, preview, and Diagnostics is inside `#if
DEBUG`; a Release build honors no launch argument. Anything new of that
kind goes inside `#if DEBUG` too, and its type name or a 16+-byte marker
(an accessibility identifier) goes into `ios/Tools/release-denylist.txt`.
Proof runs in CI: `xcodebuild -scheme ParkAgentRelease test` (tests that
run inside the Release build) and `ios/Tools/check-release-binary.sh
<ParkAgent.app>` (`strings`). TestFlight uploads come from the manual
`testflight` workflow; see `docs/testflight.md`.

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
(a constant `false`, showing "coming soon"). Turning it on for real requires the
`com.apple.developer.payment-pass-provisioning` entitlement, which Apple
grants only after an application through Stripe (support-issuing@stripe.com)
— add it to `project.yml` when approved, flip the constant, and add `STPPushProvisioningContext`
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
Its tests run over recorded fixture HTML and never touch a provider's live
site. A few DOM tests launch a local headless Chromium, and they skip
themselves where it is absent. CI's required `executor` job runs lint and
the tests with Chromium installed (#93). `pnpm -C server build` needs
`executor/dist` types, so run `pnpm -C executor run build` first. It is a personal-use prototype
against ParkNYC's own web app. The repo is public. #37 tracks making it
private, or moving `executor/` out, before anything beyond friends. Details: `executor/README.md`.

## Deploy, verify, roll back
A merge to main deploys through CI's `deploy` job, about 10–25 minutes
after the merge because it waits on `ios`. The release command runs
`prisma migrate deploy` first. Two shell helpers (in `~/.zshrc`, not the
repo) wrap the checks:

    # block until prod's /health reports PR <n>'s merge commit
    waitdeploy(){ SHA=$(gh pr view "$1" --repo thomasbardhi01/parkagent --json mergeCommit -q .mergeCommit.oid); until curl -s https://parkagent-api.fly.dev/health | grep -q "$SHA"; do sleep 20; done; echo "deployed $SHA"; }
    # dispatch the nightly FR suite against prod and watch it
    nightly(){ gh workflow run nightly-fr.yml --repo thomasbardhi01/parkagent && sleep 8 && gh run watch "$(gh run list --repo thomasbardhi01/parkagent --workflow=nightly-fr.yml --limit 1 --json databaseId -q '.[0].databaseId')" --repo thomasbardhi01/parkagent; }

So after merging PR N: `waitdeploy N && nightly`. Don't dispatch the
nightly before the deploy lands, or it tests the old build (its report
prints the commit it tested).

**Rollback.** For a crash-looping or broken release:

    fly releases -a parkagent-api --image     # the last good release's image
    fly deploy -a parkagent-api --image registry.fly.io/parkagent-api:deployment-<id>
    curl -s https://parkagent-api.fly.dev/health

Then fix forward in a PR. A rollback doesn't revert migrations, so keep
them additive. `fly deploy` re-applies `fly.toml`'s `[[vm]]` block
(memory 512 MB), which undoes any `fly scale memory`.

## Commands
- `pnpm -C server dev`         start the API locally
- `pnpm -C server prisma migrate dev`   apply migrations
- `pnpm -C server migrate:policy-fee`   move parknyc_fee_usd into city_overrides
- `./scripts/check-city-neutral.sh`     fail on hardcoded city/provider names
- `scripts/boot-check.sh off|on`       boot the built server with every optional feature off / on and
  assert /health (CI gates deploy on both; needs a migrated DATABASE_URL and no repo-root .env —
  run it from a scratch worktree). A new optional env var gets a line in both of its lists.
- `pnpm -C server attach-identity -- --user <id> --email <e>`  give an existing user a sign-in identity
  (or `--api-key-prefix <8 chars>` in place of `--user`; on prod:
  `fly ssh console -a parkagent-api -C "node dist/scripts/attach-identity.js …"`)
- `pnpm -C server create:fr-throwaway`  mint a throwaway session for FR-32's live tests (needs the target's DB + AUTH_JWT_SECRET)
- `pnpm -C server purge:fr-throwaways [-- --apply]`  tear down throwaways a run left behind (dry run by default; the nightly applies it on prod)
- `pnpm -C executor run login`     headed browser; sign in to ParkNYC once, save auth state
- `pnpm -C executor run record`    record a real ParkNYC flow (HAR/trace/screens) to fixtures/
- `pnpm -C executor run build`     compile (server build needs its d.ts first)
- `uv run data/fetch_nyc.py`   refresh raw NYC data
- `uv run data/build_zones.py` rebuild zones.geojson
- `uv run data/fetch_boston.py`         refresh raw Boston meter data
- `uv run data/build_boston_zones.py`   rebuild boston_zones.geojson
  (load either file with `pnpm -C server load:zones [--file …]`, once per city)
