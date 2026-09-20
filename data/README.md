# data

Python scripts that fetch NYC Open Data and build `zones.geojson`.

    uv run data/fetch_nyc.py     # -> data/raw/*.geojson   (add --force to refetch)
    uv run data/build_zones.py   # -> data/out/zones.geojson
    pnpm -C server load:zones    # -> upsert into Postgres (see server/src/scripts/)

Both output directories are gitignored; the pipeline is reproducible from the
two scripts.

## Refreshing zone data

Rates change; the build plan says refresh monthly. No cron — run it by hand,
each step from the repo root:

    # 1. Fetch fresh NYC Open Data (--force refetches even if raw files exist)
    uv run data/fetch_nyc.py --force

    # 2. Rebuild zones.geojson from the raw data
    uv run data/build_zones.py

    # 3. Load dev (Neon) — DATABASE_URL comes from the repo-root .env
    pnpm -C server load:zones

    # 4. Load prod (Fly Postgres) — proxy the cluster to localhost first.
    #    Terminal A (leave it running):
    fly proxy 15432:5432 -a parkagent-db

    #    Terminal B: read the app's DATABASE_URL, then run the loader against
    #    the proxy — same URL with the host swapped for localhost:15432.
    fly ssh console -a parkagent-api -C "printenv DATABASE_URL"
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:zones

An exported `DATABASE_URL` wins over the `.env` one (dotenv never overrides
existing variables), which is what makes step 4 safe to run from the same
checkout. The loader mirrors the file into the `zones` table (stale
`data_version` rows deleted) and audits every run in `zone_loads`; prod must
already have its migrations, which `fly deploy` applies via the release
command. Add `-- --all` to a load to include commercial/charter faces.

## Sources

| Dataset | Socrata ID | Used for |
| --- | --- | --- |
| Parking Meters - ParkNYC Block Faces | `e7yp-wx55` | 11,185 metered block-face curb lines with ParkNYC zone number, rates, max stay and hours |
| Parking Meters - Citywide Rate Zones | `f72k-2u3b` | 52 rate-zone polygons; fallback rate source when a block face's own rate fields are `N/A` |

`SOCRATA_APP_TOKEN` is read from the repo-root `.env`. Requests work without it
but NYC Open Data throttles unauthenticated clients, so set a real token before
relying on this in anything automated.

## Output

`data/out/zones.geojson` — one feature per block face. The dataset draws each
face along its own curb (opposite faces sit ~9-21 m apart, median 12.7 m), so
the geometry is the face line buffered 12 m one-sided toward its parking lane
(the roadway side of the curb, from `side_of_st`); faces with a non-compass
side value (median "C", "Island") get a symmetric 8 m buffer.

    zone_id               "nyc-<parknyc_zone_number>"
    parknyc_zone_number   the number a driver enters in ParkNYC
    vehicle_type          "all" | "commercial" | "charter_bus" | "dual"
    passenger             true when a private car may park (all/dual)
    rate_first_hour       dollars, float
    rate_additional_hour  dollars for the 2nd hour, float
    max_stay_minutes      int
    hours_json            [{"days": ["Mon", ...], "start": "HH:MM", "end": "HH:MM"}]
    centerline            the original face line (GeoJSON geometry in properties)

The collection's top-level `metadata` records the source dataset ids and build
timestamp; the loader stores that timestamp as each row's `data_version`.

## Ambiguity

One-sided buffering cut zone-zone overlap from 97% to 94% of zones (88% with
more than 5 m² of shared area). The residual is physical, not fixable by
geometry: on streets narrower than ~24 m curb-to-curb, the two sides' 12 m
corridors meet mid-roadway, and consumer GPS error (10-30 m) swamps the
curb-to-curb distance anyway. The consumer must treat multiple candidates as
the normal case: rank by distance to `centerline`, and where candidates differ
in what they'd charge, ask the user which side they parked on. Measured on this
build, the two sides of a both-sides-metered block differ in rate or max stay
on only 2.3% of blocks (differ in enforcement hours on a further 46%), and
about half of passenger faces are on blocks metered on one side only.
