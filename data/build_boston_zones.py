"""Build data/out/boston_zones.geojson from the raw Analyze Boston meter points.

Boston publishes individual meter Points (not block-face lines like NYC), so
zones are assembled here: meters are grouped into a zone, a centerline is fit
through the group's points, and the line is buffered per the NYC approach
(one-sided 12 m toward the parking lane when the side of street is known,
symmetric 8 m otherwise — see data/build_zones.py).

Grouping and zone numbers:
  - Meters are grouped by (STREET, PAY_POLICY) — STREET encodes the block
    segment, e.g. "NEWBURY ST B-C".
  - Every zone's `zone_number` is EMPTY with `zone_number_known: false`:
    Analyze Boston publishes no ParkBoston zone numbers. The one candidate
    field, G_PASSPORT_ZONES (ParkBoston runs on Passport), turns out to be a
    per-meter id — 588 distinct values across the 587 meters that carry it —
    not the shared block-zone number a driver enters, so treating it as one
    would be a guess, and an invented number pays someone else's meter.
    Flagged, not guessed; numbers will have to come from signage or the
    provider itself.

Rates: the dataset's rate fields are stale coin increments ($0.25 nearly
everywhere), so rates come from the City's published schedule instead,
applied by area (see RATE_AREAS below; sources cited in data/README.md):
  $3.75  Back Bay, South Boston Waterfront/Seaport (except D Street)
  $2.50  Fenway/Kenmore, Bulfinch Triangle, D Street
  $2.00  everywhere else
Boston posts a flat hourly rate (no NYC-style 2nd-hour ladder), so
rate_first_hour == rate_additional_hour.

Hours and max stay come from each meter's PAY_POLICY ("08:00AM-08:00PM
MON-SAT $0.25 120" — enforced window, days, coin increment, max-stay
minutes). Sundays are free because no PAY_POLICY window includes SUN; City
holidays are also free but are NOT modeled (same limitation as NYC).
Meters with no parseable policy get the citywide default posted on
boston.gov: Mon-Sat 08:00-20:00, 120-minute max.

Run:  uv run data/build_boston_zones.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

import geopandas as gpd
import shapely
from shapely.geometry import LineString, Point, box, mapping

from build_zones import (
    BUFFER_QUAD_SEGS,
    ONE_SIDED_BUFFER_METERS,
    SIDE_TO_ROADWAY,
    TWO_SIDED_BUFFER_METERS,
    WGS84,
    buffer_face,
    round_coords,
    snap_to_grid,
)
from fetch_boston import DATASET
from nyc_common import OUT_DIR, RAW_DIR

# UTM 19N covers Boston and is metric (NYC uses 18N).
METRIC_CRS = "EPSG:32619"

# City-published rates by area (data/README.md cites the boston.gov pages).
# The boxes are hand-drawn WGS84 envelopes around the named districts; the
# City publishes boundary streets, not polygons, so these are approximate —
# refine against ticket data if a border block ever quotes the wrong tier.
BASE_RATE = 2.00
RATE_AREAS = [
    # (name, rate $/hr, polygon)
    ("back_bay", 3.75, box(-71.0915, 42.3425, -71.0715, 42.3565)),
    ("seaport", 3.75, box(-71.0530, 42.3390, -71.0280, 42.3560)),
    ("fenway_kenmore", 2.50, box(-71.1065, 42.3385, -71.0885, 42.3525)),
    # Causeway St / Lomasney Way / Staniford St / Merrimac St /
    # New Chardon St / North Washington St.
    ("bulfinch_triangle", 2.50, box(-71.0655, 42.3615, -71.0565, 42.3670)),
]
# "$2.50 on D Street" carve-out inside the Seaport tier; matched by street
# name, which is more precise than any box.
D_STREET_RATE = 2.50
D_STREET_PREFIX = "D ST"

DEFAULT_MAX_STAY_MINUTES = 120
DEFAULT_HOURS = [{"days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], "start": "08:00", "end": "20:00"}]

# "08:00AM-08:00PM MON-SAT $0.25 120" (one or more comma-separated segments).
_POLICY_SEGMENT = re.compile(
    r"(?P<start>\d{1,2}:\d{2})(?P<start_m>AM|PM)-"
    r"(?P<end>\d{1,2}:\d{2})(?P<end_m>AM|PM)\s+"
    r"(?P<days>[A-Z]{3}(?:-[A-Z]{3})?)\s+"
    r"\$[\d.]+\s+(?P<max_stay>\d+)",
    re.IGNORECASE,
)

DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DAY_NAMES = {"MON": "Mon", "TUE": "Tue", "WED": "Wed", "THU": "Thu", "FRI": "Fri", "SAT": "Sat", "SUN": "Sun"}

_BLANKS = {"", "none", "null", "n/a"}


def is_blank(value) -> bool:
    return value is None or str(value).strip().lower() in _BLANKS


def parse_clock(hhmm: str, meridiem: str) -> str | None:
    """"08:00"+"PM" -> "20:00"; "12:00"+"AM" -> "00:00"; "24:00" -> "24:00"."""
    hour, minute = (int(part) for part in hhmm.split(":"))
    if hour == 24:  # PARK_NO_PAY uses "24:00AM" for end-of-day
        return "24:00" if minute == 0 else None
    if hour > 12 or minute > 59:
        return None
    hour = hour % 12
    if meridiem.upper() == "PM":
        hour += 12
    return f"{hour:02d}:{minute:02d}"


def expand_days(text: str) -> list[str]:
    parts = [DAY_NAMES.get(p.strip().upper()) for p in text.split("-")]
    if not parts or any(day is None for day in parts):
        return []
    if len(parts) == 1:
        return parts
    start, end = DAY_ORDER.index(parts[0]), DAY_ORDER.index(parts[-1])
    if start <= end:
        return DAY_ORDER[start : end + 1]
    return DAY_ORDER[start:] + DAY_ORDER[: end + 1]  # wraps, e.g. SUN-SAT


def parse_pay_policy(text) -> tuple[list[dict], int | None, bool]:
    """PAY_POLICY -> (hours intervals, max-stay minutes, parsed_ok).

    Max stay is the minimum across segments (paying for the most restrictive
    window is always legal — same convention as the NYC builder).
    """
    if is_blank(text):
        return [], None, False
    intervals: list[dict] = []
    stays: list[int] = []
    for match in _POLICY_SEGMENT.finditer(str(text)):
        days = expand_days(match.group("days"))
        start = parse_clock(match.group("start"), match.group("start_m"))
        end = parse_clock(match.group("end"), match.group("end_m"))
        if not days or start is None or end is None:
            continue
        if end == "00:00":
            end = "24:00"
        intervals.append({"days": days, "start": start, "end": end})
        stays.append(int(match.group("max_stay")))
    if not intervals:
        return [], None, False
    return intervals, min(stays), True


def rate_for(point: Point, street: str) -> tuple[float, str]:
    """The published hourly rate for a meter, and the area name for auditing."""
    if street.upper().startswith(D_STREET_PREFIX):
        return D_STREET_RATE, "d_street"
    for name, rate, polygon in RATE_AREAS:
        if polygon.contains(point):
            return rate, name
    return BASE_RATE, "citywide"


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "unnamed"


def fit_centerline(points: list[Point]) -> LineString:
    """A line through the group's meters, ordered along their principal axis.

    A single meter (or coincident points) gets a 2 m east-west stub so the
    centerline column (MultiLineString) and distance ranking still work.
    """
    distinct = sorted({(p.x, p.y) for p in points})
    if len(distinct) < 2:
        # ~1 m in longitude degrees at Boston's latitude.
        stub = 1.2e-5
        x, y = distinct[0] if distinct else (points[0].x, points[0].y)
        return LineString([(x - stub, y), (x + stub, y)])
    xs = [c[0] for c in distinct]
    ys = [c[1] for c in distinct]
    # Principal axis by larger spread; enough for near-straight block faces.
    axis = 0 if (max(xs) - min(xs)) >= (max(ys) - min(ys)) else 1
    ordered = sorted(distinct, key=lambda c: c[axis])
    return LineString(ordered)



# Some STREET values carry no block segment ("COMMONWEALTH AV" spans 5+ km of
# meters), so groups are split spatially: meters ordered along the group's
# principal axis break into a new sub-zone at a gap over GAP_METERS (multi-
# space kiosks sit up to ~60-80 m apart on one block) or when the running
# span passes MAX_SPAN_METERS (~a Boston block and a half — an intersection
# gap alone, ~25-40 m, does not split, so the span cap is what keeps a
# continuous meter run to block scale).
GAP_METERS = 80.0
MAX_SPAN_METERS = 250.0


def split_indices(coords_m: list[tuple[float, float]]) -> list[list[int]]:
    """Cluster metric points into block-scale runs along their principal axis."""
    import numpy as np

    if len(coords_m) == 1:
        return [[0]]
    arr = np.asarray(coords_m)
    centered = arr - arr.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    t = centered @ vt[0]
    order = np.argsort(t, kind="stable")

    clusters: list[list[int]] = []
    current: list[int] = []
    start_t = prev_t = 0.0
    for i in order:
        ti = float(t[i])
        if current and (ti - prev_t > GAP_METERS or ti - start_t > MAX_SPAN_METERS):
            clusters.append(current)
            current = []
        if not current:
            start_t = ti
        current.append(int(i))
        prev_t = ti
    clusters.append(current)
    return clusters


def majority_side(dirs: list[str]) -> str | None:
    """The group's side-of-street letter, when its meters agree on one."""
    letters = [d.strip().upper() for d in dirs if not is_blank(d)]
    letters = [d for d in letters if d in SIDE_TO_ROADWAY]
    if not letters:
        return None
    side, count = Counter(letters).most_common(1)[0]
    return side if count > len(letters) / 2 else None


def main() -> int:
    source = RAW_DIR / "boston_meters.geojson"
    if not source.exists():
        print(f"Missing {source}. Run `uv run data/fetch_boston.py` first.", file=sys.stderr)
        return 1

    print(f"Reading {source.name} ...")
    raw = json.loads(source.read_text(encoding="utf-8"))
    features = raw.get("features", [])
    provenance = raw.get("metadata", {})
    print(f"  {len(features)} raw meter points")

    stats = Counter()
    groups: dict[tuple, dict] = defaultdict(
        lambda: {"points": [], "dirs": [], "policies": [], "streets": [], "rates": [], "areas": []}
    )

    for feature in features:
        props = feature.get("properties", {})
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if geometry.get("type") != "Point" or len(coords) < 2:
            stats["dropped_no_point_geometry"] += 1
            continue
        point = Point(coords[:2])
        state = str(props.get("METER_STATE") or "").strip().upper()
        if state not in ("", "NONE", "ACTIVE"):
            stats[f"dropped_state_{state.lower()}"] += 1
            continue

        street = str(props.get("STREET") or "").strip()
        policy_text = None if is_blank(props.get("PAY_POLICY")) else str(props["PAY_POLICY"]).strip()
        # G_PASSPORT_ZONES is deliberately NOT read as a zone number — see the
        # module docstring; it is a per-meter id, and guessing pays the wrong
        # meter. Counted here only so a future data refresh that adds real
        # zone numbers shows up in the stats.
        if not is_blank(props.get("G_PASSPORT_ZONES")):
            stats["meters_with_passport_field"] += 1
        rate, area = rate_for(point, street)

        group = groups[("street", street, policy_text)]
        group["points"].append(point)
        group["dirs"].append(str(props.get("DIR") or ""))
        group["policies"].append(policy_text)
        group["streets"].append(street)
        group["rates"].append(rate)
        group["areas"].append(area)

    print(f"  {len(groups)} zone groups")

    from pyproj import Transformer

    to_metric = Transformer.from_crs(WGS84, METRIC_CRS, always_xy=True)

    records = []
    seen_ids: set[str] = set()
    for (_, street_key, policy_text), group in groups.items():
        points = group["points"]
        mx, my = to_metric.transform([p.x for p in points], [p.y for p in points])
        clusters = split_indices(list(zip(mx, my)))
        if len(clusters) > 1:
            stats["street_groups_split"] += 1

        hours, max_stay, parsed_ok = parse_pay_policy(policy_text)
        if not parsed_ok:
            stats["policy_defaulted"] += 1
            hours = DEFAULT_HOURS
            max_stay = DEFAULT_MAX_STAY_MINUTES

        street = street_key or "unknown"
        # Stable for a given (street, policy) pair across rebuilds; the
        # cluster index only moves if the meters themselves move.
        digest = hashlib.md5(f"{street}|{policy_text}".encode()).hexdigest()[:6]

        for cluster_index, indices in enumerate(clusters):
            sub_points = [points[i] for i in indices]
            sub_dirs = [group["dirs"][i] for i in indices]
            sub_rates = [group["rates"][i] for i in indices]
            sub_areas = [group["areas"][i] for i in indices]

            # Rate per sub-zone: a split street can cross rate areas, so the
            # tier is re-derived from this cluster's own meters.
            rate = Counter(sub_rates).most_common(1)[0][0]
            if len(set(sub_rates)) > 1:
                stats["zone_groups_with_mixed_rate"] += 1
            area = Counter(sub_areas).most_common(1)[0][0]
            stats[f"meters_rate_{area}"] += len(sub_points)

            suffix = f"-{cluster_index:02d}" if len(clusters) > 1 else ""
            zone_id = f"bos-{slugify(street)}-{digest}{suffix}"
            stats["zones_number_unknown"] += 1
            if zone_id in seen_ids:
                stats["dropped_duplicate_zone_id"] += 1
                continue
            seen_ids.add(zone_id)

            records.append(
                {
                    "zone_id": zone_id,
                    "city": "bos",
                    "zone_number": "",  # unknown for every zone today (docstring)
                    "zone_number_known": False,
                    # The block's street as the source names it ("BOYLSTON ST").
                    # The Passport executor's zone_mismatch guard compares the
                    # provider map's street against this before paying.
                    "street": street,
                    "vehicle_type": "all",
                    "passenger": True,
                    "rate_first_hour": rate,  # flat hourly rate: no 2nd-hour ladder
                    "rate_additional_hour": rate,
                    "max_stay_minutes": max_stay,
                    "hours_json": json.dumps(hours, separators=(",", ":")),
                    "rate_area": area,
                    "meter_count": len(sub_points),
                    "side_of_street": majority_side(sub_dirs),
                    "centerline": fit_centerline(sub_points),
                    "geometry": fit_centerline(sub_points),
                }
            )

    if not records:
        print("No usable meters; nothing written.", file=sys.stderr)
        return 1

    zones = gpd.GeoDataFrame(records, geometry="geometry", crs=WGS84)

    print(
        f"Buffering {len(zones)} zone lines one-sided by {ONE_SIDED_BUFFER_METERS} m "
        f"(two-sided {TWO_SIDED_BUFFER_METERS} m fallback) in {METRIC_CRS} ..."
    )
    metric_lines = zones.geometry.to_crs(METRIC_CRS)
    buffered = []
    for line, side in zip(metric_lines.values, zones["side_of_street"].values):
        polygon, mode = buffer_face(line, side)
        stats[f"buffered_{mode}"] += 1
        buffered.append(polygon)
    zones["geometry"] = gpd.GeoSeries(buffered, index=zones.index, crs=METRIC_CRS).to_crs(WGS84)
    zones = zones.drop(columns=["side_of_street"])

    invalid = ~zones.geometry.is_valid
    if invalid.any():
        stats["repaired_invalid_buffer"] += int(invalid.sum())
        zones.loc[invalid, "geometry"] = zones.loc[invalid, "geometry"].make_valid()
    zones["geometry"] = [snap_to_grid(geom, stats) for geom in zones.geometry.values]
    invalid = ~zones.geometry.is_valid
    if invalid.any():
        stats["repaired_invalid_after_snap"] += int(invalid.sum())
        zones.loc[invalid, "geometry"] = zones.loc[invalid, "geometry"].make_valid()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    destination = OUT_DIR / "boston_zones.geojson"

    out_features = []
    for record in zones.to_dict("records"):
        geometry = mapping(record.pop("geometry"))
        geometry["coordinates"] = round_coords(geometry["coordinates"])
        centerline = mapping(record.pop("centerline"))
        centerline["coordinates"] = round_coords(centerline["coordinates"])
        record["hours_json"] = json.loads(record["hours_json"])
        record["centerline"] = centerline
        out_features.append({"type": "Feature", "properties": record, "geometry": geometry})

    collection = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "metadata": {
            "generator": "data/build_boston_zones.py",
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sources": {
                "parking_meters": DATASET["resource"],
                "resource_last_modified": provenance.get("resource_last_modified"),
            },
            "one_sided_buffer_meters": ONE_SIDED_BUFFER_METERS,
            "two_sided_buffer_meters": TWO_SIDED_BUFFER_METERS,
            "buffer_quad_segs": BUFFER_QUAD_SEGS,
            "feature_count": len(out_features),
        },
        "features": out_features,
    }
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(collection, handle, separators=(",", ":"))

    print(f"\nWrote {len(out_features)} zones -> {destination}")
    print(f"  size: {destination.stat().st_size / 1_048_576:.1f} MB")
    for stat_key in sorted(stats):
        print(f"  {stat_key}: {stats[stat_key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
