# data

Python scripts that fetch open data and build zone GeoJSON, one file per city,
and garage and lot footprints from OpenStreetMap (see "Garage and lot
footprints" below).

    # NYC
    uv run data/fetch_nyc.py       # -> data/raw/*.geojson   (add --force to refetch)
    uv run data/build_zones.py     # -> data/out/zones.geojson
    pnpm -C server load:zones      # -> upsert into Postgres (see server/src/scripts/)

    # Boston
    uv run data/fetch_boston.py         # -> data/raw/boston_meters.geojson
    uv run data/build_boston_zones.py   # -> data/out/boston_zones.geojson
    pnpm -C server load:zones --file data/out/boston_zones.geojson

    # Garages and lots, both cities
    uv run data/fetch_parking_footprints.py   # -> data/out/<city>_garages.geojson
    pnpm -C server load:garages --file data/out/bos_garages.geojson
    pnpm -C server load:garages --file data/out/nyc_garages.geojson

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
(`pnpm -C executor run login --provider passport`) and the built
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

## Garage and lot footprints

`data/fetch_parking_footprints.py` builds `data/out/<city>_garages.geojson`
from OpenStreetMap: every `amenity=parking` way and multipolygon relation in
the city's bounding box, one Polygon per outline (a relation with two outer
rings is two features). The server keeps them in the `garages` table, beside
`zones`; the park-now classifier reads them to tell a garage or a lot from a
metered curb (`GET /garages/near`, `classifyByFootprint`; server/API.md).

    uv run data/fetch_parking_footprints.py [--city bos|nyc|all] [--force]

**What it keeps:** `name`, `operator`, `parking` (as `kind`:
`multi_storey`, `underground`, `surface`, `rooftop`, else `unknown`), `fee`
(`yes` → true, `no` → false, anything else null), `access`, `capacity`
(whole numbers only), and `website` (http(s) only; anything else in the tag
is dropped, since the app may open it).

**What it skips:** parking along the street — `parking=street_side`,
`lane`, `on_kerb`, `half_on_kerb`, `shoulder`, `layby`. Those are our zones.
Also outlines that never close and ones under 10 m².

**Entrances**, in order: nodes on the outline tagged `entrance=*`;
`amenity=parking_entrance` nodes on or within 30 m of the outline (an
underground garage's ramp is usually mapped beside it), unless the node
names a different place or says it leads to a different kind of parking;
failing both, the outline's vertex nearest a road centerline within 60 m —
driveable roads only, and never the aisles inside a lot. That last one is a
guess, and each feature says which it got in `entrance_source` (`osm`,
`road_vertex`, or `none`). The build summary counts them.

**What OSM doesn't outline, this doesn't have.** A garage mapped as a
single point (`amenity=parking` on a node), or only by its entrance nodes,
has no polygon and isn't in the file. In Boston on 2026-10-01 that was 31
multi-storey and underground garages — the Boston Common Garage, the
Garage at Post Office Square, Copley Place, Center Plaza, and 60 State
Street among them — against 207 that are outlined. Two ways to add one:
draw its outline in OpenStreetMap (the next fetch picks it up), or load a
hand-made file with its own `metadata.source` (say `manual`): the loader
mirrors per city and per source, so an OSM reload never deletes those rows.

**Ids** are `<city>-<slug>-<hash6>`: the slug from the name (the kind when
unnamed, `parking` when the kind is unknown too), the hash from the
outline's OSM type and id, so an id survives a rebuild. A rename in OSM
changes the slug. Where two outlines under one slug share six hash
characters, both get the shortest longer hash that tells them apart.

**Source and politeness.** The public Overpass API, one tile (about
4.4 km × 4.1 km) at a time, one request at a time, a 2 s pause between
requests, backoff on 429/504, and an identifying User-Agent. Each tile's
answer is cached in `data/raw/parking_footprints/<city>/`, so a rerun asks
only for what's missing (`--force` refetches). Boston is 25 tiles, New York
144: allow ten minutes and an hour, more when the public server is busy
(it answers 429 or 504 and the script waits and asks again, for up to
about ten minutes a tile). A tile that still fails stops the build rather
than shrinking it; rerun to resume from the cache. `OVERPASS_URL` points
the script at another Overpass instance.

**License.** OpenStreetMap data is © OpenStreetMap contributors, under the
[ODbL](https://www.openstreetmap.org/copyright). The collection's metadata
carries the attribution, `GET /garages/near` returns it, and wherever the
outlines are shown that line goes with them.

Load and refresh (the same pattern as zones):

    # 1. Fetch and build (cached; --force for fresh OSM data)
    uv run data/fetch_parking_footprints.py

    # 2. Load dev (Neon) — DATABASE_URL comes from the repo-root .env.
    #    One loader run per city; each mirrors only its own city's rows.
    pnpm -C server load:garages --file data/out/bos_garages.geojson
    pnpm -C server load:garages --file data/out/nyc_garages.geojson

    # 3. Load prod (Fly Postgres) — after the deploy that carries the
    #    garages migration. Proxy the cluster to localhost first.
    #    Terminal A (leave it running):
    fly proxy 15432:5432 -a parkagent-db

    #    Terminal B: read the app's DATABASE_URL, then run the loader against
    #    the proxy — same URL with the host swapped for localhost:15432.
    fly ssh console -a parkagent-api -C "printenv DATABASE_URL"
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:garages --file data/out/bos_garages.geojson
    DATABASE_URL="postgres://<user>:<password>@localhost:15432/<db>?sslmode=disable" \
      pnpm -C server load:garages --file data/out/nyc_garages.geojson

With no `--file`, the loader loads every `data/out/*_garages.geojson`, each
in its own transaction. The table mirrors each load per city and per
source: rows of that city and source whose id the file no longer carries
are deleted, and nothing else is touched. The file is checked whole before
anything is written (ids, kinds, closed polygons, http(s) websites), and a
file with under half the rows the city already has is refused — a
cut-short fetch must not empty the table — unless `--allow-shrink` says the
drop is real. Check a load with `GET /garages/near` at a garage you know.

Tests: `uv run data/test_fetch_parking_footprints.py` (kind mapping,
entrances and the fallback, street-side exclusion, ids, the tile cache; two
fixture tiles in `data/fixtures/`, no network); the loader's checks are
pinned in `server/test/garageFootprintFile.test.ts`.

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
