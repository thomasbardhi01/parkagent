# data

Python scripts that fetch open data and build zone GeoJSON, one file per city.

    # NYC
    uv run data/fetch_nyc.py       # -> data/raw/*.geojson   (add --force to refetch)
    uv run data/build_zones.py     # -> data/out/zones.geojson
    pnpm -C server load:zones      # -> upsert into Postgres (see server/src/scripts/)

    # Boston
    uv run data/fetch_boston.py         # -> data/raw/boston_meters.geojson
    uv run data/build_boston_zones.py   # -> data/out/boston_zones.geojson
    pnpm -C server load:zones --file ../data/out/boston_zones.geojson

Both output directories are gitignored; the pipeline is reproducible from the
scripts. Loads are per-city: each run mirrors only the rows of the city in
the file (stale `data_version` rows of that city are deleted; the other
city's rows are untouched), so run the loader once per city.

## Refreshing zone data

Rates change; the build plan says refresh monthly. No cron — run it by hand,
each step from the repo root:

    # 1. Fetch fresh open data (--force refetches even if raw files exist)
    uv run data/fetch_nyc.py --force
    uv run data/fetch_boston.py --force

    # 2. Rebuild the zone files from the raw data
    uv run data/build_zones.py
    uv run data/build_boston_zones.py

    # 3. Load dev (Neon) — DATABASE_URL comes from the repo-root .env.
    #    One loader run per city; each mirrors only its own city's rows.
    pnpm -C server load:zones
    pnpm -C server load:zones --file ../data/out/boston_zones.geojson

    # 4. Load prod (Fly Postgres) — proxy the cluster to localhost first.
    #    Terminal A (leave it running):
    fly proxy 15432:5432 -a parkagent-db

    #    Terminal B: read the app's DATABASE_URL, then run the loader against
    #    the proxy — same URL with the host swapped for localhost:15432.
    fly ssh console -a parkagent-api -C "printenv DATABASE_URL"
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:zones
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:zones --file ../data/out/boston_zones.geojson

An exported `DATABASE_URL` wins over the `.env` one (dotenv never overrides
existing variables), which is what makes step 4 safe to run from the same
checkout. The loader mirrors the file into the `zones` table (stale
`data_version` rows deleted) and audits every run in `zone_loads`; prod must
already have its migrations, which `fly deploy` applies via the release
command. Add `-- --all` to a load to include commercial/charter faces.

## Sources

### NYC (NYC Open Data, data.cityofnewyork.us)

| Dataset | Socrata ID | Used for |
| --- | --- | --- |
| Parking Meters - ParkNYC Block Faces | `e7yp-wx55` | 11,185 metered block-face curb lines with ParkNYC zone number, rates, max stay and hours |
| Parking Meters - Citywide Rate Zones | `f72k-2u3b` | 52 rate-zone polygons; fallback rate source when a block face's own rate fields are `N/A` |

`SOCRATA_APP_TOKEN` is read from the repo-root `.env`. Requests work without it
but NYC Open Data throttles unauthenticated clients, so set a real token before
relying on this in anything automated.

### Boston (Analyze Boston, data.boston.gov — CKAN, no token needed)

| Dataset | CKAN resource | Used for |
| --- | --- | --- |
| Parking Meters | `9314c461-69c3-452e-82dc-9da9dee486f8` | ~7k meter Points with per-meter enforced hours + max stay (`PAY_POLICY`), block segment (`STREET`), side of street (`DIR`) |

Analyze Boston publishes **no ParkBoston zone layer** (a CKAN search finds
only this dataset and a 2015 transactions CSV), and the one zone-ish field,
`G_PASSPORT_ZONES`, is a per-meter id (588 distinct values on 587 meters),
not the block zone number a driver enters — so **every Boston zone is loaded
with an empty, flagged-unknown zone number** rather than a guess. Numbers
will have to come from street signage or the provider.

The dataset's rate fields are stale coin increments ($0.25 almost
everywhere), so **rates are applied from the City's published schedule**,
verified 2026-09-20 against
[How do Parking Meters Work? (boston.gov)](https://www.boston.gov/departments/parking-clerk/how-do-parking-meters-work):

- $3.75/hr — Back Bay, South Boston Waterfront/Seaport
- $2.50/hr — Fenway/Kenmore, Bulfinch Triangle (bounded by Causeway St,
  Lomasney Way, Staniford St, Merrimac St, New Chardon St, N Washington St —
  per the City's July 2019 rate announcement), and D Street
- $2.00/hr — all other metered areas
- Flat hourly rate — Boston has no NYC-style 2nd-hour ladder, so both rate
  columns carry the same value.

The special areas are hand-drawn bounding boxes in `build_boston_zones.py`
(the City publishes boundary streets, not polygons); the per-tier meter
counts in the build summary are the sanity check. Unmodeled micro-zones from
the same page: $0.50/15 min stalls in parts of Back Bay/Beacon Hill, $1.00/15
min on Boylston St's south side, $0.50/hr motorcycle spaces.

Enforcement is per-meter from `PAY_POLICY` (typically Mon–Sat, 8 AM–6 or
8 PM; boston.gov's blanket line is "Monday through Saturday from 8 a.m. to
8 p.m."). **Sundays are free** (no policy window includes SUN — matching
boston.gov: "On Sundays and City holidays you can park for free"). **City
holidays are also free but are NOT modeled** — same limitation as NYC.
Per-city fee and ticket cost live in `policy.json` `city_overrides`:
ParkBoston's fee is $0.35 per session/extension
([ParkBoston, boston.gov](https://www.boston.gov/departments/parking-clerk/parkboston));
a "Meter Fee Unpaid" ticket is $40
([Parking ticket fines and codes, boston.gov](https://www.boston.gov/departments/parking-clerk/parking-ticket-fines-and-codes)).

## Output

Every feature carries a `city` property ("nyc" | "bos"); the loader keys its
mirror semantics on it.

`data/out/boston_zones.geojson` — one feature per zone assembled from meter
Points: meters grouped by (`STREET` block segment, `PAY_POLICY`), split into
block-scale runs (a new zone at a >80 m gap along the group's principal axis
or past a ~250 m span, since some STREET values span kilometres), a
centerline fit through each run's points, then buffered exactly like NYC
(one-sided 12 m toward the lane when `DIR` gives a side, symmetric 8 m
otherwise). Properties additionally carry `zone_number` (empty),
`zone_number_known` (false), `rate_area`, and `meter_count`.

`data/out/zones.geojson` — one feature per NYC block face. The dataset draws each
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
