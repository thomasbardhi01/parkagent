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
