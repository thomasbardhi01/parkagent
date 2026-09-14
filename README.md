# ParkAgent

ParkAgent is a personal prototype that notices when a car has parked in a NYC
metered zone, quotes what the meter will cost, pays for the session through
ParkNYC inside a fixed budget, and extends it automatically using a cost-based
rule. It is a monorepo: `data/` holds the Python scripts that turn NYC Open Data
into zone geometry, `server/` is a Fastify + TypeScript API on Fly.io backed by
Postgres/PostGIS, `executor/` holds the isolated Playwright scripts that are the
only thing allowed to drive ParkNYC, and `ios/` is the SwiftUI app. One city
(NYC), two users, iOS only.

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
