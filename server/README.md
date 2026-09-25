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

    pnpm -C server create:user --name Thomas [--plate ABC1234 --state NY]

Creates a user (and optionally a vehicle) and prints the api key **once**.
Only `SHA-256(API_KEY_PEPPER:key)` and an 8-char identification prefix are
stored — losing the printed key means minting a new one. Run it with the
prod URL exported to mint a prod key (the pepper must match the server's
`API_KEY_PEPPER` Fly secret).

API keys are the **admin and script** credential now: the app signs users
in (Sign in with Apple / an emailed code) and authenticates with a bearer
JWT, so a phone never carries a key. Use `--admin` for a key that may
`PUT /policy` and read `/admin/*`.

### attach-identity

    pnpm -C server attach-identity -- --user <id> --email <e> [--apple-sub <s>]

Gives an existing script-created user a real sign-in identity, so the
owner's account and history carry over instead of a second account
appearing at first sign-in. The email is stored **verified** (this command
is you asserting the mailbox is yours), which is what makes the first
Apple or email sign-in merge onto it. Refuses when the address or Apple
subject already belongs to someone else.

### migrate:api-keys

    pnpm -C server migrate:api-keys

One-time conversion of pre-hashing rows: computes `api_key_hash` +
`api_key_prefix` from each plaintext `users.api_key` and NULLs the
plaintext. Idempotent. Needs `API_KEY_PEPPER` set; a plaintext row that
hasn't been migrated **cannot authenticate**, so run this right after
deploying the hashing change. Against prod: fly proxy + exported
`DATABASE_URL` (see above) **and the same pepper the server has**:

    API_KEY_PEPPER="<the value in fly secrets>" DATABASE_URL="postgres://…@localhost:15432/…" \
      pnpm -C server migrate:api-keys

The phones keep their existing keys — nothing changes client-side.

### load:zones

    pnpm -C server load:zones              # passenger zones only (default)
    pnpm -C server load:zones --all     # include commercial/charter faces

Mirrors `data/out/zones.geojson` into the `zones` table (stale
`data_version` rows deleted) and audits the run in `zone_loads`. Build the
file first — see [data/README.md](../data/README.md) for the full
fetch → build → load-dev → load-prod refresh runbook.

### issuing:setup

    pnpm -C server issuing:setup --user <users.id> [--email <email>]

Creates the user's Stripe Issuing cardholder and one virtual card
(test mode), spending controls from `policy.json`: MCC
`parking_lots_garages` only, `session_cap_usd` per authorization,
`daily_cap_usd` per day. Idempotent — re-run after editing policy.json to
re-apply the controls. Needs `STRIPE_SECRET_KEY` in `.env`.

### stripe:trigger

    stripe listen --forward-to localhost:3000/webhooks/stripe   # terminal A
    pnpm -C server dev                                          # terminal B
    pnpm -C server stripe:trigger --user <users.id> [--amount 7.28] [--category parking_lots_garages]

Fires a test-mode authorization at the user's card via Stripe's test
helpers so the `/webhooks/stripe` real-time path runs end to end; the
printed `approved` is the webhook's decision. `stripe listen` prints a
`whsec_…` secret — set it as `STRIPE_WEBHOOK_SECRET` in `.env` first.
Useful variations: `--category taxicabs_limousines` (wrong-MCC decline),
`--amount 61` (over the daily cap — declined by the card's own controls
before the webhook if above the per-auth cap too).

### decisions:recent

    pnpm -C server decisions:recent
    pnpm -C server decisions:recent --user Thomas --city bos --limit 50

Prints the last 20 `decisions` rows — timestamp, rule, action, zone, quote —
which is the evening read during the dry-run week. `--user` filters by the
users row (id or case-insensitive name); `--city nyc|bos` keeps rows
attributable to that city (quoted zone prefix, the session's stored city,
or the first candidate); `--limit` changes the count. Point it at prod
(proxy + exported `DATABASE_URL`) to read what the live app decided.

During a field test, `GET /admin/summary` (see API.md) is the same story
pre-aggregated: today's parks, sessions, extensions, declines, executor
error counts, shadow results, and detector signal counts per city.
