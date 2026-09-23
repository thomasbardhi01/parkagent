"""Import ParkBoston zone numbers from the Passport Find Parking feed.

Boston's open data has no ParkBoston zone numbers (see build_boston_zones.py),
but the signed-in Passport web app's Find Parking screen is fed by the
getnearzoneswithoccupancy API, which returns every nearby zone's pay-by-app
NUMBER and block NAME ("North Boylston between Dartmouth and Clarendon") —
PR #87 proved the source. Its coordinates are coarse (~1 km grid), so numbers
are matched onto our meter-derived zones BY NAME, not by point:

  1. Sweep: probe points are derived from our own zone centroids (one per
     ~1 km cell) and handed to the executor's read-only sweep script
     (`pnpm -C executor run sweep`), which drives the real app with the
     saved Passport session and dumps the feed. Politely rate-limited;
     pays for nothing. -> data/raw/parkboston_zones.json
  2. Parse each block name into {side, street, from_street, to_street}
     (rule-based; names the rules can't handle go to the LLM fallback —
     ANTHROPIC_MODEL, strict JSON schema — at lower confidence).
  3. Resolve both corners against the City's own street-segment layer
     (local, offline, exact); the remote geocoders — Google when
     GOOGLE_MAPS_API_KEY is set, else Nominatim (disk cache, 1 req/s,
     proper User-Agent) — are only a fallback, because Nominatim can't
     resolve free-text intersections and our meter lines sit within
     digitizing error of the street centerline anyway.
  4. Match the corner-to-corner segment to our zones by centerline overlap
     + same normalized street + side agreement, where side is compared
     LETTER TO LETTER: the name's "North" against the zone's
     side_of_street ("N", the majority of its meters' DIR) — both are
     City conventions; geometry cannot tell curbs apart here. A segment
     overlapping several of our zones (we split blocks differently)
     assigns its number to each of them; a zone claimed by two DIFFERENT
     numbers is ambiguous and excluded.
  5. Write data/out/parkboston_zone_numbers.json for
     `pnpm -C server load:zone-numbers` (precedence lives server-side:
     verified user report > import > single unverified report).

Run:  uv run data/import_parkboston_zones.py [--skip-sweep] [--no-llm]
Test: uv run data/test_import_parkboston_zones.py
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from nyc_common import OUT_DIR, RAW_DIR, REPO_ROOT, load_root_env

METRIC_CRS = "EPSG:32619"  # UTM 19N, metric, covers Boston
WGS84 = "EPSG:4326"

# Rough Boston envelope for geocode sanity checks and the Nominatim viewbox.
BOSTON_BBOX = (-71.20, 42.22, -70.98, 42.41)  # west, south, east, north

RAW_FEED = RAW_DIR / "parkboston_zones.json"
PROBE_POINTS = RAW_DIR / "parkboston_probe_points.json"
GEOCODE_CACHE = RAW_DIR / "geocode_cache.json"
OUT_FILE = OUT_DIR / "parkboston_zone_numbers.json"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Nominatim usage policy: identify the application; max 1 req/s.
NOMINATIM_UA = "ParkAgent-zone-import/0.1 (personal prototype; github.com/thomasbardhi01/parkagent)"
NOMINATIM_MIN_INTERVAL_S = 1.1

# Matching thresholds (see test_import_parkboston_zones.py for pinned cases).
SEGMENT_BUFFER_M = 20.0  # geocoder corner error + curb offset slack
# A zone claims a segment when this fraction of its centerline lies in the
# segment's buffer. Deliberately below 0.5: one of OUR zones can span two
# provider blocks (we cap runs at 250 m, blocks can be ~85 m) — a low gate
# lets BOTH blocks claim it so the conflicting numbers surface as
# "ambiguous" instead of the zone silently matching nothing.
MIN_OVERLAP_FRAC = 0.35
CORNER_MIN_M, CORNER_MAX_M = 25.0, 900.0  # sane block length between corners

SIDES = ("North", "South", "East", "West")

# "North Boylston between Dartmouth and Clarendon", "Exeter between A and B".
_BLOCK_NAME = re.compile(
    r"^\s*(?:(?P<side>North|South|East|West)\s+)?(?P<street>.+?)\s+between\s+"
    r"(?P<from>.+?)\s+and\s+(?P<to>.+?)\s*$",
    re.IGNORECASE,
)

# Mirrors executor/src/passport/parse.ts normalizeStreet so both sides of the
# pipeline agree on what "the same street" means.
SUFFIXES = {
    "STREET": "ST",
    "AVENUE": "AV",
    "AVE": "AV",
    "BOULEVARD": "BLVD",
    "ROAD": "RD",
    "DRIVE": "DR",
    "PLACE": "PL",
    "SQUARE": "SQ",
    "COURT": "CT",
    "TERRACE": "TER",
    "PARKWAY": "PKWY",
    "HIGHWAY": "HWY",
    "LANE": "LN",
    "CIRCLE": "CIR",
    "WAY": "WAY",
    "WY": "WAY",
    "MALL": "MALL",
    "WHARF": "WHARF",
    "ROW": "ROW",
}
SUFFIX_TOKENS = set(SUFFIXES.keys()) | set(SUFFIXES.values())

# Feed shorthand seen in the 2026-09-21 sweep ("Comm Ave", "West Mass Ave")
# expanded so keys line up with the full names in the City's data.
TOKEN_ALIASES = {
    "COMM": "COMMONWEALTH",
    "MASS": "MASSACHUSETTS",
    "WASH": "WASHINGTON",
    "DOT": "DORCHESTER",
    "SO": "SOUTH",
    "NO": "NORTH",
    # SAM street segments abbreviate directions ("E BERKELEY ST"); the feed
    # spells them out ("East Berkeley").
    "E": "EAST",
    "W": "WEST",
    "N": "NORTH",
    "S": "SOUTH",
}


def normalize_street(street: str) -> str:
    """Uppercase, drop parentheticals, strip punctuation, canonical suffixes."""
    cleaned = re.sub(r"\([^)]*\)", " ", street.upper())
    cleaned = re.sub(r"[^A-Z0-9 ]+", " ", cleaned)
    tokens = [SUFFIXES.get(t, TOKEN_ALIASES.get(t, t)) for t in cleaned.split()]
    return " ".join(tokens)


def street_key(street: str) -> str:
    """The suffix-free comparison key: the feed says "Boylston", our data says
    "BOYLSTON ST" (sometimes with a trailing block code, "NEWBURY ST B-C") —
    both key to "BOYLSTON"/"NEWBURY". A leading suffix word ("AVENUE DE
    LAFAYETTE") is part of the name, so only a suffix past position 0 cuts."""
    tokens = normalize_street(street).split()
    for index, token in enumerate(tokens):
        if index > 0 and token in SUFFIX_TOKENS:
            return " ".join(tokens[:index])
    return " ".join(tokens)


def parse_block_name(name: str) -> dict | None:
    """Rule-based parse of a feed block name. None when the rules don't fit
    (garages, lots, plaza names, ...) — those go to the LLM fallback."""
    match = _BLOCK_NAME.match(name)
    if not match:
        return None
    side = match.group("side")
    return {
        "side": side.capitalize() if side else None,
        "street": match.group("street").strip(),
        "from_street": match.group("from").strip(),
        "to_street": match.group("to").strip(),
    }


# ---------------------------------------------------------------------------
# Local corner resolution from the City's street centerlines. Nominatim
# free-text search does not resolve "A & B" intersections (verified
# 2026-09-21: clean queries return no results), so the PRIMARY corner
# source is Boston's own published street-segment layer — intersections
# are computed locally, offline, with no rate limits. The remote geocoders
# below are the fallback for corners the local network can't produce.

STREET_SEGMENTS = RAW_DIR / "boston_street_segments.geojson"
STREET_SEGMENTS_DATASET = {
    "name": "Boston Street Segments (SAM System)",
    "package": "boston-street-segments-sam-system",
    "resource": "e850cfd2-2c6e-4af6-9ac4-e03019412d1e",
}
STREET_SEGMENTS_URL = (
    "https://data.boston.gov/dataset/"
    f"{STREET_SEGMENTS_DATASET['package']}/resource/"
    f"{STREET_SEGMENTS_DATASET['resource']}/download"
)


def ensure_street_segments() -> Path:
    """Download the street-segment layer once (22 MB, cached in data/raw)."""
    if STREET_SEGMENTS.exists():
        return STREET_SEGMENTS
    from fetch_boston import fetch_with_retries

    print(f"Downloading {STREET_SEGMENTS_DATASET['name']} (one-time, ~22 MB) ...")
    collection = fetch_with_retries(STREET_SEGMENTS_URL).json()
    if not collection.get("features"):
        raise SystemExit("street segments download had no features")
    STREET_SEGMENTS.parent.mkdir(parents=True, exist_ok=True)
    STREET_SEGMENTS.write_text(json.dumps(collection), encoding="utf-8")
    return STREET_SEGMENTS


def segment_street_name(props: dict) -> str | None:
    """"E BERKELEY ST" from SAM's PRE_DIR/ST_NAME/ST_TYPE/SUF_DIR fields."""
    if not props.get("ST_NAME"):
        return None
    parts = [props.get("PRE_DIR"), props["ST_NAME"], props.get("ST_TYPE"), props.get("SUF_DIR")]
    return " ".join(str(p).strip() for p in parts if p and str(p).strip())


class IntersectionIndex:
    """street_key -> metric centerlines; corners come from where two named
    streets' segments touch. Built from any GeoJSON of named LineStrings
    (production: the SAM layer; tests: synthetic fixtures)."""

    # Segments that should share a node sometimes miss by digitizing slop.
    TOUCH_TOLERANCE_M = 1.0
    # Two candidate corners closer than this are the same intersection.
    DEDUPE_M = 5.0

    def __init__(self, collection: dict, transform_to_metric):
        from shapely.geometry import shape
        from shapely.ops import transform as shp_transform

        self.lines: dict[str, list] = defaultdict(list)
        for feature in collection.get("features", []):
            name = segment_street_name(feature.get("properties") or {})
            if not name:
                continue
            geometry = feature.get("geometry")
            if not geometry or geometry.get("type") not in ("LineString", "MultiLineString"):
                continue
            line = shp_transform(transform_to_metric, shape(geometry))
            self.lines[street_key(name)].append(line)

    def _segments_for(self, name: str) -> list:
        """Segments for a street name — exact key first, then a UNIQUE
        prefix match: the feed truncates block names at ~45 characters
        ("East I" for East India, "Cambridg" for Cambridge), so a cut-off
        last token still finds its street when only one street fits."""
        key = street_key(name)
        exact = self.lines.get(key)
        if exact:
            return exact
        if len(key) < 4:
            return []
        candidates = [k for k in self.lines if k.startswith(key)]
        if len(candidates) == 1:
            return self.lines[candidates[0]]
        return []

    def corners(self, street: str, cross: str) -> list[tuple[float, float]]:
        """Deduped metric points where the two streets meet (a street pair
        can meet more than once — Boston reuses names across neighborhoods)."""
        points: list[tuple[float, float]] = []
        if street_key(street) == street_key(cross):
            # "Blossom between Blossom and Emerson" (feed data oddity): a
            # street self-intersects everywhere; no usable corner.
            return points
        for a in self._segments_for(street):
            for b in self._segments_for(cross):
                if a.distance(b) > self.TOUCH_TOLERANCE_M:
                    continue
                overlap = a.intersection(b.buffer(self.TOUCH_TOLERANCE_M))
                if overlap.is_empty:
                    continue
                c = overlap.centroid
                if any(math.dist((c.x, c.y), p) < self.DEDUPE_M for p in points):
                    continue
                points.append((c.x, c.y))
        return points

    def corner_pair(
        self, street: str, from_street: str, to_street: str
    ) -> tuple[tuple[float, float], tuple[float, float]] | None:
        """The block's two corners: the (from, to) candidate pair with the
        shortest plausible block length — same-named streets elsewhere in
        the city drop out because their pairing distance is absurd."""
        best = None
        for a in self.corners(street, from_street):
            for b in self.corners(street, to_street):
                d = math.dist(a, b)
                if not (CORNER_MIN_M <= d <= CORNER_MAX_M):
                    continue
                if best is None or d < best[0]:
                    best = (d, a, b)
        return (best[1], best[2]) if best else None


# ---------------------------------------------------------------------------
# Remote geocoding fallback: intersection -> (lat, lng), disk-cached,
# politely rate-limited. Google resolves intersections well (used when
# GOOGLE_MAPS_API_KEY is set); Nominatim mostly can't, and self-disables
# after repeated connection failures so a blocked/unreachable host doesn't
# stall the whole run.


class Geocoder:
    def __init__(self, cache_path: Path = GEOCODE_CACHE):
        self.cache_path = cache_path
        self.cache: dict[str, list[float] | None] = {}
        if cache_path.exists():
            self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
        self._last_nominatim = 0.0
        self._dirty = 0
        # Consecutive connection failures; at 3 Nominatim is disabled for
        # the rest of the run (2026-09-21: it connect-timed out mid-run and
        # every later corner burned 2 × 20 s on a dead host).
        self._nominatim_errors = 0
        import os

        self.google_key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip() or None

    def _save(self, force: bool = False) -> None:
        self._dirty += 1
        if force or self._dirty % 25 == 0:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(self.cache, indent=0), encoding="utf-8")

    def close(self) -> None:
        self._save(force=True)

    def intersection(self, street: str, cross: str) -> tuple[float, float] | None:
        """(lat, lng) of "<street> & <cross>, Boston MA", or None. Only
        COMPLETED lookups are cached — a connection failure must not be
        remembered as "this corner doesn't exist"."""
        key = f"{street_key(street)} & {street_key(cross)} | boston"
        if key in self.cache:
            value = self.cache[key]
            return (value[0], value[1]) if value else None
        completed, result = (
            self._google(street, cross) if self.google_key else self._nominatim(street, cross)
        )
        if result is not None:
            lat, lng = result
            west, south, east, north = BOSTON_BBOX
            if not (south <= lat <= north and west <= lng <= east):
                result = None
        if completed:
            self.cache[key] = list(result) if result else None
            self._save()
        return result

    def _nominatim(self, street: str, cross: str) -> tuple[bool, tuple[float, float] | None]:
        """(completed, coords). Free-text intersection support is poor and
        the host may be unreachable — after 3 consecutive connection
        failures every later call short-circuits."""
        import requests

        if self._nominatim_errors >= 3:
            return False, None
        west, south, east, north = BOSTON_BBOX
        # Bare names first ("Boylston and Dartmouth"), then with "Street"
        # appended — Nominatim resolves different corners under each form.
        queries = [
            f"{street} and {cross}, Boston, Massachusetts",
            f"{street} Street and {cross} Street, Boston, Massachusetts",
        ]
        for query in queries:
            wait = NOMINATIM_MIN_INTERVAL_S - (time.monotonic() - self._last_nominatim)
            if wait > 0:
                time.sleep(wait)
            self._last_nominatim = time.monotonic()
            try:
                response = requests.get(
                    NOMINATIM_URL,
                    params={
                        "q": query,
                        "format": "jsonv2",
                        "limit": 1,
                        "viewbox": f"{west},{north},{east},{south}",
                        "bounded": 1,
                    },
                    headers={"User-Agent": NOMINATIM_UA},
                    timeout=20,
                )
                response.raise_for_status()
                rows = response.json()
            except Exception as error:  # connection trouble: don't cache, count
                self._nominatim_errors += 1
                print(f"  nominatim error for {query!r}: {error}", file=sys.stderr)
                if self._nominatim_errors >= 3:
                    print("  nominatim disabled for the rest of the run", file=sys.stderr)
                return False, None
            self._nominatim_errors = 0
            if rows:
                return True, (float(rows[0]["lat"]), float(rows[0]["lon"]))
        return True, None

    def _google(self, street: str, cross: str) -> tuple[bool, tuple[float, float] | None]:
        import requests

        try:
            response = requests.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={
                    "address": f"{street} St & {cross} St, Boston, MA",
                    "components": "locality:Boston|administrative_area:MA|country:US",
                    "key": self.google_key,
                },
                timeout=20,
            )
            response.raise_for_status()
            body = response.json()
        except Exception as error:
            print(f"  google geocode error for {street} & {cross}: {error}", file=sys.stderr)
            return False, None
        results = body.get("results") or []
        status = body.get("status")
        if status == "OK" and results:
            location = results[0]["geometry"]["location"]
            return True, (float(location["lat"]), float(location["lng"]))
        if status in ("ZERO_RESULTS", "OK"):
            # A real "no such corner" — the only negative worth caching.
            return True, None
        # OVER_QUERY_LIMIT / REQUEST_DENIED / UNKNOWN_ERROR arrive as HTTP
        # 200 with a non-OK status. They are transient (quota, key config);
        # caching them would poison geocode_cache.json with permanent
        # "corner doesn't exist" answers.
        print(f"  google geocode {status} for {street} & {cross}; not cached", file=sys.stderr)
        return False, None


# ---------------------------------------------------------------------------
# Segment building + matching (pure; unit-tested on synthetic fixtures).


def build_segment(corner_a, corner_b) -> "LineString":
    """The block segment between two metric corner points — the street
    centerline's chord. Deliberately never offset toward the named side:
    the 2026-09-21 traces showed our meter lines sit within digitizing
    error of the street centerline (dx as small as 0.5 m), so geometry
    cannot tell the two curbs apart. Side agreement is data-to-data
    instead — see sides_agree."""
    from shapely.geometry import LineString

    return LineString([corner_a, corner_b])


_LETTER_VEC = {"N": (0.0, 1.0), "S": (0.0, -1.0), "E": (1.0, 0.0), "W": (-1.0, 0.0)}
# A side letter nearly parallel to the street names no curb; below this
# |dot| with the street's perpendicular the side is indeterminate.
MIN_NORMAL_DOT = 0.25


def _curb_normal(letter: str, dx: float, dy: float) -> tuple[float, float] | None:
    """The street perpendicular pointing toward `letter`'s compass half, or
    None when the letter is (near) parallel to the street bearing."""
    lx, ly = _LETTER_VEC[letter]
    nx, ny = -dy, dx
    dot = nx * lx + ny * ly
    if abs(dot) < MIN_NORMAL_DOT:
        return None
    return (nx, ny) if dot > 0 else (-nx, -ny)


def sides_agree(named_side: str | None, zone_side_letter: str | None, segment) -> bool:
    """The provider name's side ("North") against the zone's side_of_street
    ("N", the majority DIR of its meters). Either missing -> no constraint:
    overlap + street already pin the block, and a zone-level number
    conflict still lands in "ambiguous".

    Boston's diagonal streets make the two conventions pick different
    compass axes for the SAME curb (Financial District, 2026-09-22 run:
    Passport "East Batterymarch" vs DIR 'W'), so letters are compared as
    CURB NORMALS: each letter projects onto the street's perpendicular and
    the sides agree when both point at the same curb. A letter parallel to
    the street names no curb — fail closed (money: a wrong side pays the
    wrong meter)."""
    if named_side is None or not isinstance(zone_side_letter, str) or not zone_side_letter.strip():
        return True
    a = named_side[0].upper()
    b = zone_side_letter.strip().upper()[0]
    if a not in _LETTER_VEC or b not in _LETTER_VEC:
        return True
    if a == b:
        return True
    (x0, y0) = segment.coords[0]
    (x1, y1) = segment.coords[-1]
    length = math.hypot(x1 - x0, y1 - y0) or 1.0
    dx, dy = (x1 - x0) / length, (y1 - y0) / length
    normal_a = _curb_normal(a, dx, dy)
    normal_b = _curb_normal(b, dx, dy)
    if normal_a is None or normal_b is None:
        return False
    return normal_a[0] * normal_b[0] + normal_a[1] * normal_b[1] > 0


def match_segment(segment, side: str | None, key: str, zones: list[dict]) -> list[dict]:
    """Our zones this provider block covers: same street key, >=
    MIN_OVERLAP_FRAC of the zone's centerline inside the segment's buffer,
    and no side disagreement. Several matches are normal — we split blocks
    at meter gaps, Passport doesn't."""
    buffered = segment.buffer(SEGMENT_BUFFER_M)
    matched = []
    for zone in zones:
        if zone["street_key"] != key:
            continue
        centerline = zone["centerline_m"]
        if centerline.length == 0:
            continue
        overlap = centerline.intersection(buffered).length / centerline.length
        if overlap < MIN_OVERLAP_FRAC:
            continue
        if not sides_agree(side, zone["side"], segment):
            continue
        matched.append({"zone": zone, "overlap": overlap})
    return matched


# A zone claimed by several numbers is decided by dominance: the top
# number's best overlap must be decisive and every rival marginal —
# otherwise the zone is ambiguous and excluded (paying on a guess pays the
# wrong meter). Rivals below the claim gate never appear at all; these
# bounds separate "corner bleed-over" (a 20 m buffer grazing the next
# block) from a zone genuinely straddling two provider blocks.
DOMINANT_MIN_OVERLAP = 0.75
RIVAL_MAX_OVERLAP = 0.45


def resolve_zone_claims(zone_claims: list[dict]) -> dict | None:
    """One zone's claims -> the winning claim, or None when the numbers
    genuinely conflict. Claims carry {number, overlap, confidence, ...}."""
    best_by_number: dict[str, dict] = {}
    for claim in zone_claims:
        current = best_by_number.get(claim["number"])
        if current is None or claim["overlap"] > current["overlap"]:
            best_by_number[claim["number"]] = claim
    ranked = sorted(best_by_number.values(), key=lambda c: c["overlap"], reverse=True)
    if len(ranked) == 1:
        return ranked[0]
    top, runner = ranked[0], ranked[1]
    if top["overlap"] >= DOMINANT_MIN_OVERLAP and runner["overlap"] <= RIVAL_MAX_OVERLAP:
        return top
    return None


def confidence_for(method: str, side: str | None, match_count: int) -> float:
    """Documented, monotone confidence: rule-parsed, sided, unique match is
    the best case; LLM parses and split/sideless matches score lower."""
    score = 0.9 if method == "rule" else 0.7
    if side is None:
        score -= 0.1
    if match_count > 1:
        score -= 0.1
    return round(max(score, 0.3), 2)


# ---------------------------------------------------------------------------
# LLM fallback for names the rules can't parse (ANTHROPIC_MODEL, strict JSON).

LLM_BATCH_SIZE = 40
LLM_SCHEMA = {
    "type": "object",
    "properties": {
        "parses": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "parseable": {"type": "boolean"},
                    "side": {"type": "string", "enum": ["North", "South", "East", "West", "none"]},
                    "street": {"type": "string"},
                    "from_street": {"type": "string"},
                    "to_street": {"type": "string"},
                },
                "required": ["name", "parseable", "side", "street", "from_street", "to_street"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["parses"],
    "additionalProperties": False,
}

LLM_PROMPT = """These are parking-zone block names from Boston's ParkBoston app.
Most follow "[Side] <Street> between <CrossA> and <CrossB>"; the ones below did
NOT match that pattern. For each, extract the street block if one is described:
side (compass side of the street the parking is on, or "none"), the street the
parking is ON, and the two cross streets bounding the block. Street names must
be bare names without suffixes (e.g. "Boylston", not "Boylston St"). If the
name is not a street block (a garage, lot, park, or event zone), or you cannot
tell the bounding cross streets, set parseable=false and empty strings.
Echo each name back verbatim in "name".

Names:
{names}"""


def llm_parse(names: list[str], model: str) -> dict[str, dict]:
    """name -> parsed dict (same shape as parse_block_name) for the names the
    LLM could handle. Requires ANTHROPIC_API_KEY; raises on API errors."""
    import anthropic

    client = anthropic.Anthropic()
    parsed: dict[str, dict] = {}
    for start in range(0, len(names), LLM_BATCH_SIZE):
        batch = names[start : start + LLM_BATCH_SIZE]
        listing = "\n".join(f"- {name}" for name in batch)
        response = client.messages.create(
            model=model,
            max_tokens=16000,
            messages=[{"role": "user", "content": LLM_PROMPT.format(names=listing)}],
            output_config={"format": {"type": "json_schema", "schema": LLM_SCHEMA}},
        )
        text = next(block.text for block in response.content if block.type == "text")
        for row in json.loads(text)["parses"]:
            if not row["parseable"] or row["name"] not in batch:
                continue
            if not (row["street"] and row["from_street"] and row["to_street"]):
                continue
            parsed[row["name"]] = {
                "side": None if row["side"] == "none" else row["side"],
                "street": row["street"],
                "from_street": row["from_street"],
                "to_street": row["to_street"],
            }
        print(f"  llm: parsed {len(parsed)} of {start + len(batch)} sent")
    return parsed


# ---------------------------------------------------------------------------
# Sweep orchestration: probe grid from our own zones, executor does the driving.


def probe_points(zones_geojson: dict, cell_meters: float) -> list[dict]:
    """One probe point per ~cell of zone-centerline centroids: covers exactly
    the metered areas, nothing else."""
    from pyproj import Transformer
    from shapely.geometry import shape

    to_metric = Transformer.from_crs(WGS84, METRIC_CRS, always_xy=True)
    to_wgs = Transformer.from_crs(METRIC_CRS, WGS84, always_xy=True)
    cells: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    for feature in zones_geojson["features"]:
        centroid = shape(feature["properties"]["centerline"]).centroid
        x, y = to_metric.transform(centroid.x, centroid.y)
        cells[(int(x // cell_meters), int(y // cell_meters))].append((x, y))
    points = []
    for members in cells.values():
        mx = sum(p[0] for p in members) / len(members)
        my = sum(p[1] for p in members) / len(members)
        lng, lat = to_wgs.transform(mx, my)
        points.append({"lat": round(lat, 6), "lng": round(lng, 6)})
    return points


def run_sweep(points: list[dict], delay_ms: int, headed: bool) -> None:
    PROBE_POINTS.parent.mkdir(parents=True, exist_ok=True)
    PROBE_POINTS.write_text(json.dumps(points, indent=1), encoding="utf-8")
    command = [
        "pnpm",
        "-C",
        "executor",
        "run",
        "sweep",
        "--",
        "--points",
        str(PROBE_POINTS),
        "--out",
        str(RAW_FEED),
        "--delay",
        str(delay_ms),
    ]
    if headed:
        command.append("--headed")
    print(f"Sweeping {len(points)} probe points via the executor (read-only) ...")
    result = subprocess.run(command, cwd=REPO_ROOT)
    if result.returncode != 0:
        raise SystemExit(f"sweep failed (exit {result.returncode}); see output above")


# ---------------------------------------------------------------------------


def load_zone_index(zones_geojson: dict) -> list[dict]:
    """Our zones with metric centerlines/centroids and street keys."""
    from pyproj import Transformer
    from shapely.ops import transform as shp_transform
    from shapely.geometry import shape

    to_metric = Transformer.from_crs(WGS84, METRIC_CRS, always_xy=True).transform
    zones = []
    for feature in zones_geojson["features"]:
        props = feature["properties"]
        centerline = shp_transform(to_metric, shape(props["centerline"]))
        polygon = shp_transform(to_metric, shape(feature["geometry"]))
        zones.append(
            {
                "zone_id": props["zone_id"],
                "street": props["street"],
                "street_key": street_key(props["street"]),
                # "N"/"S"/"E"/"W" from the meters' DIR majority, or None.
                "side": props.get("side_of_street"),
                "centerline_m": centerline,
                "centroid_m": polygon.centroid,
            }
        )
    return zones


def corner_distance_ok(a, b) -> bool:
    d = math.dist(a, b)
    return CORNER_MIN_M <= d <= CORNER_MAX_M


def main() -> int:
    load_root_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-sweep", action="store_true", help="reuse data/raw/parkboston_zones.json")
    parser.add_argument("--no-llm", action="store_true", help="skip the LLM name fallback")
    parser.add_argument("--cell-meters", type=float, default=1000.0)
    parser.add_argument("--delay", type=int, default=4000, help="ms between sweep probes")
    parser.add_argument("--headed", action="store_true", help="watch the sweep browser")
    args = parser.parse_args()

    zones_path = OUT_DIR / "boston_zones.geojson"
    if not zones_path.exists():
        print(f"Missing {zones_path}. Run `uv run data/build_boston_zones.py` first.", file=sys.stderr)
        return 1
    zones_geojson = json.loads(zones_path.read_text(encoding="utf-8"))

    if args.skip_sweep and RAW_FEED.exists():
        print(f"Reusing {RAW_FEED}")
    else:
        points = probe_points(zones_geojson, args.cell_meters)
        run_sweep(points, args.delay, args.headed)

    feed = json.loads(RAW_FEED.read_text(encoding="utf-8"))
    feed_zones = feed["zones"]
    print(f"{len(feed_zones)} distinct feed zones (swept {feed.get('swept_at')})")

    # ---- parse names -------------------------------------------------------
    parsed: dict[str, dict] = {}
    method: dict[str, str] = {}
    unparseable: list[str] = []
    for row in feed_zones:
        result = parse_block_name(row["name"])
        if result:
            parsed[row["name"]] = result
            method[row["name"]] = "rule"
        else:
            unparseable.append(row["name"])

    if unparseable and not args.no_llm:
        import os

        model = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5").strip()
        print(f"LLM fallback for {len(unparseable)} names ({model}) ...")
        try:
            # The SDK resolves ANTHROPIC_API_KEY or an `ant auth login`
            # profile; with neither, the first call raises and we carry on
            # with the names marked unparseable.
            for name, result in llm_parse(unparseable, model).items():
                parsed[name] = result
                method[name] = "llm"
            unparseable = [n for n in unparseable if n not in parsed]
        except Exception as error:
            print(f"  LLM fallback unavailable ({error}); leaving names unparsed.")

    # ---- geocode + match ---------------------------------------------------
    from pyproj import Transformer

    to_metric = Transformer.from_crs(WGS84, METRIC_CRS, always_xy=True)
    zones = load_zone_index(zones_geojson)
    known_keys = {z["street_key"] for z in zones}
    geocoder = Geocoder()

    print("Building the local intersection index from the City's street segments ...")
    segments = json.loads(ensure_street_segments().read_text(encoding="utf-8"))
    index = IntersectionIndex(segments, to_metric.transform)
    print(f"  {len(index.lines)} indexed street names")
    local_corners = remote_corners = 0

    claims: dict[str, list[dict]] = defaultdict(list)  # zone_id -> claims
    unmatched: list[dict] = []
    geocode_failed: list[dict] = []
    matched_feed = 0

    try:
        for row in feed_zones:
            name = row["name"]
            if name not in parsed:
                continue
            p = parsed[name]
            side, street = p["side"], p["street"]
            key = street_key(street)
            # A "side" that is really part of the street name ("East Berkeley
            # St"): if the bare street is unknown to our data but the sided
            # form is, fold the side back into the name.
            if side and key not in known_keys and street_key(f"{side} {street}") in known_keys:
                street, key, side = f"{side} {street}", street_key(f"{side} {street}"), None
            if key not in known_keys:
                # No zone of ours is on this street at all — it can never
                # match, so don't spend geocoder calls on it.
                unmatched.append({"number": row["number"], "name": name, "reason": "unknown street"})
                continue

            # Corners: the City's own street network first (offline, exact);
            # the remote geocoder only for what it can't produce.
            pair = index.corner_pair(street, p["from_street"], p["to_street"])
            if pair is not None:
                a_m, b_m = pair
                local_corners += 1
            else:
                corner_a = geocoder.intersection(street, p["from_street"])
                corner_b = geocoder.intersection(street, p["to_street"])
                if corner_a is None or corner_b is None:
                    geocode_failed.append({"number": row["number"], "name": name})
                    continue
                a_m = to_metric.transform(corner_a[1], corner_a[0])
                b_m = to_metric.transform(corner_b[1], corner_b[0])
                if not corner_distance_ok(a_m, b_m):
                    geocode_failed.append(
                        {"number": row["number"], "name": name, "reason": "corner distance"}
                    )
                    continue
                remote_corners += 1

            segment = build_segment(a_m, b_m)
            matches = match_segment(segment, side, key, zones)
            if not matches:
                unmatched.append({"number": row["number"], "name": name})
                continue
            matched_feed += 1
            conf = confidence_for(method[name], side, len(matches))
            for m in matches:
                claims[m["zone"]["zone_id"]].append(
                    {
                        "number": row["number"],
                        "name": name,
                        "confidence": conf,
                        "method": method[name],
                        "overlap": round(m["overlap"], 3),
                    }
                )
    finally:
        geocoder.close()

    # ---- resolve claims per zone ------------------------------------------
    matches_out: list[dict] = []
    ambiguous: list[dict] = []
    for zone_id, zone_claims in sorted(claims.items()):
        best = resolve_zone_claims(zone_claims)
        if best is None:
            # Two provider blocks both cover this zone of ours with different
            # numbers and neither claim dominates — paying either could pay
            # the wrong meter. Excluded; a driver report resolves it.
            ambiguous.append({"zone_id": zone_id, "claims": zone_claims})
            continue
        matches_out.append(
            {
                "zone_id": zone_id,
                "number": best["number"],
                "confidence": best["confidence"],
                "method": best["method"],
                "name": best["name"],
            }
        )

    report = {
        "feed_zones": len(feed_zones),
        "parsed_rule": sum(1 for n in method.values() if n == "rule"),
        "parsed_llm": sum(1 for n in method.values() if n == "llm"),
        "unparseable": len(unparseable),
        "corners_local": local_corners,
        "corners_remote": remote_corners,
        "geocode_failed": len(geocode_failed),
        "feed_matched": matched_feed,
        "feed_unmatched": len(unmatched),
        "zones_matched": len(matches_out),
        "zones_ambiguous": len(ambiguous),
        "zones_total": len(zones),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        json.dumps(
            {
                "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": "passport getnearzoneswithoccupancy (Find Parking feed)",
                "report": report,
                "matches": matches_out,
                "ambiguous": ambiguous,
                "unmatched": unmatched,
                "geocode_failed": geocode_failed,
                "unparseable": unparseable,
            },
            indent=1,
        ),
        encoding="utf-8",
    )

    print(f"\nWrote {len(matches_out)} zone-number matches -> {OUT_FILE}")
    for stat_key, value in report.items():
        print(f"  {stat_key}: {value}")
    if unmatched:
        print("\nUnmatched feed blocks (first 40):")
        for row in unmatched[:40]:
            print(f"  #{row['number']}: {row['name']}")
    print("\nLoad with: pnpm -C server load:zone-numbers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
