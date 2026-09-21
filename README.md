# ParkAgent

ParkAgent is a personal prototype that notices when a car has parked in a
metered zone, quotes what the meter will cost, pays for the session through
the city's pay-by-app provider (ParkNYC in NYC, ParkBoston in Boston)
inside a fixed budget, and extends it automatically using a cost-based
rule. It is a monorepo: `data/` holds the Python scripts that turn NYC and
Boston open data into zone geometry, `server/` is a Fastify + TypeScript
API on Fly.io backed by Postgres/PostGIS, `executor/` holds the isolated
Playwright scripts that are the only thing allowed to drive the providers'
web apps, and `ios/` is the SwiftUI app. Two cities (NYC and Boston), two
users, iOS only. Boston zone numbers aren't in the open data and the
ParkBoston web app has no map, so drivers report each block's posted
number once and the executor types it in.

Heading out to test? Follow [docs/field-test-checklist.md](docs/field-test-checklist.md).

The conversational assistant (Ask ParkAgent) finds single spots and
plans multi-stop days; garages come from SpotHero via prefilled deep
links (checkout stays in SpotHero), and plans can pay from a connected
Stripe Link wallet — the user approves each paid stop in Link.
**Autonomous street parking stays on the Issuing card** until Link ships
pre-approved spending limits: today every Link spend needs a per-request
human approval with a 10-minute window and a 12-hour card validity,
which suits planned days but not a detector firing at an arbitrary curb.

## Account ownership

One person owns each external account and adds the other as a team member, so
nobody has to ask later who holds what.

| Account | Owner | Other person's role |
|---|---|---|
| GitHub org or repo | @thomasbardhi01 | collaborator with write access |
| Apple Developer Program | @thomasbardhi01 | App Store Connect team member (Developer role) |
| Stripe | @thomasbardhi01 | team member (Developer role) |
| Fly.io | @thomasbardhi01 | org member |
| NYC Open Data app token | either | share in the vault |
| Password vault (1Password shared vault or Doppler project) | @thomasbardhi01 | member |

Every secret goes in the shared vault — never in Slack, iMessage, or the repo.
`.env.example` is committed; real values live in `.env`, which is ignored.

See [CLAUDE.md](CLAUDE.md) for conventions.
