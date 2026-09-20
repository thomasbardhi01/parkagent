# ParkAgent — Phase 0 and Phase 1 in detail

Companion to the build plan. Do these together on a call; both of you should finish with a working checkout, CI passing, and a deployed hello-world server. Budget a full evening for Phase 0 and another for Phase 1.

Conventions: `you` = whoever owns the accounts; `friend` = the collaborator. Commands assume macOS (you need a Mac for Xcode anyway).

---

## Phase 0 — Accounts and tools

### 0.1 Decide account ownership (10 min)

One person owns each external account and adds the other as a team member. Write it in the README so nobody has to ask later.

| Account | Owner | Other person's role |
|---|---|---|
| GitHub org or repo | you | collaborator with write access |
| Apple Developer Program | you | App Store Connect team member (Developer role) |
| Stripe | you | team member (Developer role) |
| Fly.io | you | org member |
| NYC Open Data app token | either | share in the vault |
| Password vault (1Password shared vault or Doppler project) | you | member |

Create the shared vault first. Every secret from here on goes there, never in Slack, iMessage, or the repo.

### 0.2 macOS toolchain (20 min)

Run these one line at a time. Don't paste lines with trailing `#` comments; zsh treats them as arguments, not comments.

```bash
xcode-select --install
```

If it says the tools are already installed, continue. Then Homebrew:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, it prints two lines to add Homebrew to your PATH. Run them; on Apple Silicon they are:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Confirm `which brew` prints `/opt/homebrew/bin/brew`, then:

```bash
brew install git gh nvm pnpm xcodegen flyctl stripe/stripe-cli/stripe
```

(Postgres is handled in 0.11 below; don't install `postgresql` or `postgis` via Homebrew.)

Homebrew's nvm post-install note tells you to add a few lines to `~/.zshrc`. Do that, open a new terminal, then:

```bash
nvm install --lts
nvm alias default 'lts/*'
node -v
pnpm -v
```

Python for the data scripts:

```bash
brew install python@3.12 uv
uv --version
```

### 0.3 Xcode (20 min, mostly download)

1. Install Xcode from the Mac App Store. Open it once and accept the license.
2. Xcode → Settings → Accounts → add your Apple ID.
3. Xcode → Settings → Platforms → make sure the iOS platform and an iOS Simulator runtime are installed.
4. On your iPhone: Settings → Privacy & Security → Developer Mode → on (you'll be prompted the first time you run from Xcode anyway).

### 0.4 Apple Developer Program (15 min + approval wait)

1. Enroll at developer.apple.com ($99/yr). Individual enrollment is fine for the prototype; you can convert to an organization later.
2. Once approved, in App Store Connect → Users and Access, invite your friend with the Developer role.
3. In developer.apple.com → Certificates, Identifiers & Profiles → Identifiers, register an App ID: `com.<yourname>.parkagent`, with capabilities Push Notifications and Background Modes enabled. Xcode can also do this automatically when you enable capabilities in the project, but doing it here first avoids confusion.
4. Create an APNs key: Keys → + → enable Apple Push Notifications service → download the `.p8` file once. Put it in the vault along with the Key ID and your Team ID. You will not be able to download it again.

### 0.5 GitHub (15 min)

```bash
gh auth login                          # choose GitHub.com, SSH, browser
gh repo create parkagent --private --clone
cd parkagent
```

Then in the repo settings on github.com:

- Collaborators → add your friend (write access).
- Branches → add a ruleset or classic protection rule for `main`: require a pull request before merging, require 1 approval, require status checks to pass (you'll add the check name after CI exists).
- General → Pull Requests → allow squash merging only, and enable "automatically delete head branches."
- Issues → Labels: create `ios`, `server`, `data`, `executor`, `infra`, `bug`.
- Projects → create a board with columns Todo / In progress / Review / Done. Link it to the repo.

Your friend then clones with `gh repo clone <you>/parkagent`.

### 0.6 Stripe (10 min)

1. Create the account at dashboard.stripe.com. Complete only enough of the profile to unlock test mode; skip business verification for now.
2. Developers → API keys → copy the **test** secret key (`sk_test_...`) into the vault. Never use a live key in the prototype.
3. Invite your friend: Settings → Team → Developer role.
4. Enable Issuing in test mode: Products → Issuing → get started. Test mode Issuing works without verification.
5. Log in the CLI: `stripe login`. You'll use `stripe listen` later to forward webhooks to localhost.

### 0.7 Fly.io (10 min)

```bash
fly auth signup                        # or fly auth login
fly orgs create parkagent              # a shared org so both of you can deploy
```

Invite your friend from the Fly dashboard → org → Members. Add a credit card to the org; the prototype will cost a few dollars a month.

### 0.8 NYC Open Data (5 min)

1. Create a free account at data.cityofnewyork.us.
2. Profile → Developer Settings → Create New App Token. Put the token in the vault as `SOCRATA_APP_TOKEN`.
3. Bookmark the two datasets you'll use: search the portal for "ParkNYC block faces" and "citywide rate zones" under Parking Meters. Note their four-by-four dataset IDs (the `xxxx-xxxx` in the URL); you'll need them in Phase 2.

### 0.9 ParkNYC (10 min)

Both of you: register in the ParkNYC app, add your plate and a normal card, and pay for one real session manually. Screenshot every screen of the flow and drop them in the vault or a shared folder; those screenshots are the spec for the Playwright executor in Phase 5.

### 0.10 Claude Code (10 min)

Install with one of the official methods from the quickstart at code.claude.com/docs/en/quickstart. On macOS the Homebrew cask is the simplest:

```bash
brew install --cask claude-code
```

The docs also offer a native installer script and an npm package; any of them work. The first time you run `claude` in the repo it will ask you to log in with a Claude subscription (Pro, Max, Team, or Enterprise) or a Claude Console account. Both of you install it; you'll each run your own sessions against the same repo.

### 0.11 Dev database (10 min)

Use one hosted Postgres with PostGIS for local development so both of you query the same zone data and nobody installs PostGIS. Neon's free tier works: create a project called `parkagent-dev`, open the SQL editor, and run `CREATE EXTENSION IF NOT EXISTS postgis;`. Copy the connection string into the vault as `DATABASE_URL`. Production stays on Fly Postgres (1.7), so dev and prod never share data.

If you'd rather run it locally, Postgres.app includes PostGIS with no build step. Skip the Homebrew route entirely.

### Phase 0 done when

- Both of you can `git push` to a branch on the repo.
- Both of you can build and run an empty iOS app on your own phone from Xcode.
- `stripe listen` and `fly status` work for both of you.
- The vault contains: Stripe test key, Socrata token, APNs `.p8` + Key ID + Team ID.

---

## Phase 1 — Repo layout and dev environment

### 1.1 Bootstrap the monorepo (20 min)

From the repo root:

```bash
mkdir -p data server executor ios .github/workflows
pnpm init                               # root package.json for workspace tooling
```

Root `pnpm-workspace.yaml`:

```yaml
packages:
  - server
  - executor
```

Root `.gitignore`:

```
.env
.env.*
!.env.example
node_modules/
dist/
data/raw/
data/out/
executor/storageState.json
*.log
.DS_Store
ios/**/xcuserdata/
ios/**/DerivedData/
```

Root `.env.example` (committed; real values live in `.env`, which is ignored):

```
DATABASE_URL=postgresql://user:pass@your-neon-host/parkagent?sslmode=require
STRIPE_SECRET_KEY=sk_test_replace_me
STRIPE_WEBHOOK_SECRET=whsec_replace_me
SOCRATA_APP_TOKEN=replace_me
APNS_KEY_ID=replace_me
APNS_TEAM_ID=replace_me
APNS_BUNDLE_ID=com.yourname.parkagent
DRY_RUN=true
```

Root `README.md`: one paragraph on what this is, the ownership table from 0.1, and "see CLAUDE.md for conventions."

### 1.2 CLAUDE.md (20 min, and worth the time)

Claude Code reads this file at the start of every session. Write it as if onboarding a new engineer.

```markdown
# ParkAgent

Personal prototype: detect that a car has parked in a NYC metered zone,
quote the cost, pay via ParkNYC within a budget, and auto-extend using a
cost-based rule. One city (NYC), two users, iOS only.

## Layout
- data/      Python scripts that fetch NYC Open Data and build zones.geojson
- server/    Fastify + TypeScript API on Fly.io; Prisma + Postgres/PostGIS
- executor/  Playwright scripts that drive ParkNYC web (isolated, replaceable)
- ios/       SwiftUI app: park detection, location reporting, session UI
- policy.json  Spending and extension rules; server reads it at boot

## Non-negotiables
- Any code path that moves money checks DRY_RUN and policy.json first.
- Never store card numbers or Playwright auth state in the repo. Stripe IDs only.
- Every automated decision writes a row to the `decisions` table with its inputs.
- The executor is the only module allowed to touch ParkNYC. Nothing else imports it.

## Working style
- Small PRs on feat/* branches, squash-merged into main.
- Run `pnpm -r lint && pnpm -r test` before proposing a change.
- Ask before adding a dependency over ~50 KB or any native module.
- When touching Swift, note that background location and motion permissions
  are already configured; do not add new entitlements without asking.

## Commands
- `pnpm -C server dev`         start the API locally
- `pnpm -C server prisma migrate dev`   apply migrations
- `uv run data/fetch_nyc.py`   refresh raw NYC data
- `uv run data/build_zones.py` rebuild zones.geojson
```

### 1.3 Server scaffold (30 min)

```bash
cd server
pnpm init
pnpm add fastify @fastify/cors zod dotenv
pnpm add -D typescript tsx @types/node vitest eslint prisma
pnpm add @prisma/client
npx tsc --init --rootDir src --outDir dist --module nodenext --moduleResolution nodenext --target es2022 --strict
npx prisma init
```

`server/src/index.ts` — a hello-world with a health route:

```ts
import Fastify from "fastify";
import "dotenv/config";

const app = Fastify({ logger: true });
app.get("/health", async () => ({ ok: true, dryRun: process.env.DRY_RUN === "true" }));

app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
```

`server/package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
```

Copy `.env.example` to `.env` at the root and fill in real values from the vault, including the Neon `DATABASE_URL` from 0.11. Confirm `pnpm -C server dev` starts and `curl localhost:3000/health` returns `{"ok":true,"dryRun":true}`.

Add one vitest test that hits `/health` so CI has something to run.

### 1.4 Executor and data scaffolds (10 min)

```bash
cd ../executor && pnpm init && pnpm add playwright && npx playwright install chromium
cd ../data && uv init --no-workspace && uv add requests geopandas shapely
```

Leave both as empty packages with a README line each. They get filled in Phases 2 and 5.

### 1.5 iOS project (30 min)

The Xcode project is **generated from a manifest, not created in Xcode**. `.pbxproj` merge conflicts are miserable, and two people editing project settings in parallel is exactly how you get them. `ios/project.yml` is the source of truth; XcodeGen builds the `.xcodeproj` from it.

Nothing in this section is hand-edited in Xcode. If you find yourself changing project settings in the Xcode UI, stop — the change is erased on the next generate. Edit `ios/project.yml` instead.

1. Install XcodeGen (already in the 0.2 brew line):

   ```bash
   brew install xcodegen
   ```

2. `ios/project.yml` defines a single iOS app target `ParkAgent`:
   - bundle ID `com.<yourname>.parkagent`, SwiftUI, Swift 6, iOS 17 deployment target
   - automatic code signing, with `DEVELOPMENT_TEAM` supplied by xcconfig rather than hardcoded
   - sources in `ios/ParkAgent/`, with `Detection/`, `Networking/`, `Views/`, and `Models/` each holding a placeholder Swift file so PRs land in predictable places
   - `info.properties` — the Info.plist keys, including these three with plain-English values, because Apple reviews them and users see them:
     - `NSLocationAlwaysAndWhenInUseUsageDescription`
     - `NSLocationWhenInUseUsageDescription`
     - `NSMotionUsageDescription`

     plus `UIBackgroundModes` = `[location, remote-notification, processing]` and `API_BASE_URL` = `$(API_BASE_URL)`
   - `entitlements.properties` — `aps-environment` = `development` (flip to `production` for TestFlight) and `com.apple.developer.usernotifications.time-sensitive` = `true`

   Info.plist keys and entitlements go in `project.yml`, not in the plist files. XcodeGen's `info:` and `entitlements:` keys mean *generate this file*: a hand-written plist at those paths is silently overwritten on the first generate.

3. Copy the build config and fill in your Team ID (the 10-character ID from the vault, or developer.apple.com → Membership):

   ```bash
   cp ios/Config.example.xcconfig ios/Config.xcconfig
   ```

   `Config.xcconfig` is gitignored and holds `DEVELOPMENT_TEAM` and `API_BASE_URL`; `Config.example.xcconfig` is committed. `API_BASE_URL` reaches the app through Info.plist and is read by `AppConfig`, so the app can point at localhost, Fly, or a friend's machine without a code change. Note that `//` starts a comment in xcconfig, so a URL scheme's slashes must be escaped: `http:$()/$()/localhost:3000`.

4. Generate and build:

   ```bash
   cd ios && xcodegen generate
   xcodebuild -project ios/ParkAgent.xcodeproj -scheme ParkAgent \
     -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
   ```

5. Run on your phone once from Xcode. This is the step that needs a real `DEVELOPMENT_TEAM`; the simulator build above does not.

**Do not commit** `ios/ParkAgent.xcodeproj/`, `ios/ParkAgent/Info.plist`, `ios/ParkAgent/ParkAgent.entitlements`, or `ios/Config.xcconfig` — all four are generated or local, and all four are gitignored. Commit `project.yml`, the Swift sources, and `Config.example.xcconfig`.

Run `xcodegen generate` after every pull that touches `ios/`, and whenever you change `project.yml`. A fresh checkout has no `.xcodeproj` at all until you do.

### 1.6 CI (20 min)

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  server:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: lts/*, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C server lint
      - run: pnpm -C server test
      - run: pnpm -C server build

  ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      # The .xcodeproj is gitignored and generated from ios/project.yml.
      - run: brew install xcodegen
      # Config.xcconfig is gitignored; the example supplies an empty
      # DEVELOPMENT_TEAM, which is all an unsigned simulator build needs.
      - run: cp ios/Config.example.xcconfig ios/Config.xcconfig
      - run: xcodegen generate
        working-directory: ios
      - run: xcodebuild -project ios/ParkAgent.xcodeproj -scheme ParkAgent -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

The `ios` job cannot just check out and build: `ios/ParkAgent.xcodeproj` is
gitignored and generated, so the runner has to install XcodeGen, supply a
`Config.xcconfig` (the gitignored real one is absent on CI), and generate the
project before `xcodebuild` has anything to open.

Push to a branch, open a PR, watch both jobs go green, then go back to branch protection and add `server` and `ios` as required status checks.

### 1.7 First deploy (20 min)

```bash
cd server
fly launch --org parkagent --name parkagent-api --region ewr --no-deploy
```

Accept the generated `fly.toml` and `Dockerfile`, but check that the Dockerfile runs `pnpm build` and starts with `node dist/index.js`. Then:

```bash
fly postgres create --org parkagent --name parkagent-db --region ewr
fly postgres attach parkagent-db --app parkagent-api
fly ssh console -a parkagent-api -C "psql \$DATABASE_URL -c 'CREATE EXTENSION IF NOT EXISTS postgis;'"
fly secrets set -a parkagent-api STRIPE_SECRET_KEY=sk_test_... SOCRATA_APP_TOKEN=... DRY_RUN=true
fly deploy
curl https://parkagent-api.fly.dev/health
```

Add a `deploy` job to `ci.yml` that runs `flyctl deploy --remote-only` on push to `main`, using a `FLY_API_TOKEN` repo secret created with `fly tokens create deploy`. Your friend never needs the token; merging to `main` deploys.

### 1.8 Seed the backlog (15 min)

Turn each bullet of Phases 2 through 8 in the build plan into a GitHub issue with the right label and assignee. Put them on the board. Agree on who takes `ios` versus `server`/`data`/`executor`, and put the API contract for `/parked`, `/session/*`, and `/location` into `server/API.md` before you split.

### Phase 1 done when

- `main` has the monorepo skeleton, `CLAUDE.md`, `.env.example`, and CI passing.
- `https://parkagent-api.fly.dev/health` returns `{"ok":true,"dryRun":true}`.
- Both phones run the empty ParkAgent app with location and motion permission prompts appearing, after `cp ios/Config.example.xcconfig ios/Config.xcconfig` and `xcodegen generate`.
- **Repo visibility decided: public.** Branch protection and required status checks are not available on a private repo on the GitHub free plan — the API returns "Upgrade to GitHub Pro or make this repository public to enable this feature," and the rules configured in 0.5 silently do not apply. Public was chosen: protection is free, and the repo is a prototype with no secrets committed. Secrets live in Fly secrets, the shared vault, and gitignored files (`.env`, `ios/Config.xcconfig`) — never in the history.
- Branch protection blocks a direct push to `main`, with `server` and `ios` as required status checks. This applies, because the repo is public.
- The backlog exists and each of you has picked up a first issue.
