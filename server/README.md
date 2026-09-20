# server

Fastify + TypeScript API on Fly.io; Prisma + Postgres/PostGIS. The HTTP
contract lives in [API.md](API.md) — keep it in sync with the code.

## Dev

    pnpm -C server dev                     # start locally (repo-root .env)
    pnpm -C server test                    # vitest, no database needed
    pnpm -C server lint
    pnpm -C server prisma migrate dev      # apply migrations to dev (Neon)

Prod migrations are applied by the deploy itself: `fly.toml` runs
`prisma migrate deploy` as the release command.

## Scripts

All scripts read `DATABASE_URL` from the repo-root `.env` (dev/Neon). To run
one against **prod**, proxy the Fly cluster and export the URL first — an
exported variable wins over `.env`:

    # terminal A, leave running:
    fly proxy 15432:5432 -a parkagent-db
    # terminal B: the app's DATABASE_URL with the host swapped for localhost:15432
    fly ssh console -a parkagent-api -C "printenv DATABASE_URL"
    export DATABASE_URL="postgres://<user>:<password>@localhost:15432/parkagent_api?sslmode=disable"

### create:user

    pnpm -C server create:user -- --name Thomas [--plate ABC1234 --state NY]

Creates a user (and optionally a vehicle) and prints the api key **once**;
the app sends it as the `x-api-key` header. Run it with the prod URL
exported to mint a prod key.

### load:zones

    pnpm -C server load:zones              # passenger zones only (default)
    pnpm -C server load:zones -- --all     # include commercial/charter faces

Mirrors `data/out/zones.geojson` into the `zones` table (stale
`data_version` rows deleted) and audits the run in `zone_loads`. Build the
file first — see [data/README.md](../data/README.md) for the full
fetch → build → load-dev → load-prod refresh runbook.

### decisions:recent

    pnpm -C server decisions:recent

Prints the last 20 `decisions` rows — timestamp, rule, action, zone, quote —
which is the evening read during the dry-run week. Point it at prod (proxy +
exported `DATABASE_URL`) to read what the live app decided.
