# data

Python scripts that fetch open data and build zone GeoJSON, one file per city.

    # NYC
    uv run data/fetch_nyc.py       # -> data/raw/*.geojson   (add --force to refetch)
    uv run data/build_zones.py     # -> data/out/zones.geojson
    pnpm -C server load:zones      # -> upsert into Postgres (see server/src/scripts/)

    # Boston
    uv run data/fetch_boston.py         # -> data/raw/boston_meters.geojson
    uv run data/build_boston_zones.py   # -> data/out/boston_zones.geojson
    pnpm -C server load:zones --file data/out/boston_zones.geojson

(A relative `--file` resolves against the repo root; the old
`../data/out/…` cwd-relative form still works.)

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
    pnpm -C server load:zones --file data/out/boston_zones.geojson

    # 4. Load prod (Fly Postgres) — proxy the cluster to localhost first.
    #    Terminal A (leave it running):
    fly proxy 15432:5432 -a parkagent-db

    #    Terminal B: read the app's DATABASE_URL, then run the loader against
    #    the proxy — same URL with the host swapped for localhost:15432.
    fly ssh console -a parkagent-api -C "printenv DATABASE_URL"
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:zones
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:zones --file data/out/boston_zones.geojson

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
not the block zone number a driver enters — so **every Boston zone is built
with an empty, flagged-unknown zone number** rather than a guess. Numbers
come from two places instead:

- **The Passport Find Parking feed** (PR #87): the signed-in web app's map
  is fed by `getnearzoneswithoccupancy`, which returns every nearby zone's
  number and block name. `data/import_parkboston_zones.py` sweeps it and
  matches numbers onto our zones by block name — see "ParkBoston zone
  numbers (import)" below.
- **Drivers at the meter**: the app collects the posted number on the first
  park at a block (`POST /zones/:zoneId/provider-number`, verified once two
  users agree).

Precedence when both exist: a verified user report beats an import; an
import beats a single unverified report. The loader preserves and
rehydrates both across reloads, and the Passport executor types the stored
number into Enter Zone — see executor/README.md "Passport / ParkBoston".

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

## ParkBoston zone numbers (import)

`data/import_parkboston_zones.py` fills the empty Boston zone numbers from
the Passport Find Parking feed. It needs a saved signed-in Passport session
(`pnpm -C executor run login -- --provider passport`) and the built
`data/out/boston_zones.geojson`. What it does:

1. **Sweep** (read-only, pays for nothing): derives ~1 km probe points from
   our zone centroids and runs `pnpm -C executor run sweep`, which loads the
   Find Parking screen per point with the saved session and captures every
   `getnearzoneswithoccupancy` JSON response, deduped by zone number
   → `data/raw/parkboston_zones.json` (`{number, name, raw}` per zone).
2. **Parse** each block name ("North Boylston between Dartmouth and
   Clarendon") into side/street/cross-streets. Names the rules can't handle
   go to the LLM (`ANTHROPIC_MODEL`, default `claude-opus-5`, strict JSON
   schema; skipped without credentials) at lower confidence. The feed
   truncates names at ~45 chars; a truncated cross street resolves by
   unique prefix.
3. **Corners** come from the City's own street-segment layer
   (`boston-street-segments-sam-system`, fetched once to
   `data/raw/boston_street_segments.geojson`): the two cross-street
   intersections are computed locally, offline. Remote geocoding is only a
   fallback — Google when `GOOGLE_MAPS_API_KEY` is set; Nominatim (disk
   cache, 1 req/s, identifying User-Agent) otherwise, though its free-text
   search cannot resolve intersections and it self-disables after repeated
   connection failures.
4. **Match** the corner-to-corner segment to our zones: same suffix-free
   street name, ≥35% of the zone's centerline inside the segment's 20 m
   buffer, and side agreement — the name's side against the zone's
   `side_of_street` (the meters' DIR majority), compared as **curb
   normals** so diagonal streets where the two conventions pick different
   compass axes still agree; geometry alone can't tell curbs apart (meter
   lines sit within digitizing error of the street centerline). A segment
   overlapping several of our zones (we split blocks at meter gaps)
   assigns its number to each. A zone claimed by two different numbers is
   resolved by dominance (best overlap ≥0.75 with every rival ≤0.45),
   otherwise **ambiguous** and excluded — a driver report resolves it.

Output: `data/out/parkboston_zone_numbers.json` (matches + a report with
matched/ambiguous/unmatched/unparseable). Load and refresh:

    # 1. Import (add --skip-sweep to reuse the last raw feed dump)
    uv run data/import_parkboston_zones.py

    # 2. Load dev (Neon): mirrors zone_number_imports to the file and
    #    applies numbers to zones (never overwriting a verified report)
    pnpm -C server load:zone-numbers

    # 3. Load prod — same fly proxy pattern as load:zones step 4:
    fly proxy 15432:5432 -a parkagent-db            # terminal A
    fly ssh console -a parkagent-api -C "printenv DATABASE_URL"   # terminal B
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:zone-numbers

Tests: `uv run data/test_import_parkboston_zones.py` (parser + matcher, no
network); the precedence rules are pinned in `server/test/zoneNumber.test.ts`.

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
`zone_number_known` (false), `street` (the block's source street name, e.g.
"BOYLSTON ST" — decision evidence: session start forwards it into the
zoneResolution cross-check record; ParkBoston has no map, so nothing gates
on it), `rate_area`, and `meter_count`.

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
