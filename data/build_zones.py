"""Build data/out/zones.geojson from the raw NYC block-face and rate-zone data.

Each output feature is one ParkNYC block face, buffered toward its parking lane
so that a GPS fix from a parked car can be point-in-polygon matched against it.

The dataset draws each face along its own curb — opposite faces of the same
street sit ~20 m apart — so the parking lane is on the roadway side of the
line: west of an "E" face, south of an "N" face, and so on. Buffering one-sided
in that direction covers the lane without crossing the street, which is what
made symmetric buffers overlap the opposite face. Faces whose side-of-street
value is not a compass letter (median "C", "Island", blanks) get a symmetric
TWO_SIDED_BUFFER_METERS buffer instead.

Properties, one per feature:
  zone_id               stable id, "nyc-<parknyc_zone_number>"
  parknyc_zone_number   the number a driver types into ParkNYC (`pay_by_cel`)
  vehicle_type          "all" | "commercial" | "charter_bus" | "dual"
  passenger             true when a private car may park ("all" or "dual")
  rate_first_hour       dollars for the 1st hour, float
  rate_additional_hour  dollars for the 2nd hour, float (see note below)
  max_stay_minutes      posted maximum stay, int
  hours_json            JSON array: [{"days": [...], "start": "HH:MM", "end": "HH:MM"}]
                        (empty [] where the city posts no hours for the face)
  centerline            the original face line, kept so the server can rank
                        overlapping candidates by distance to it
  geometry              the face buffered ONE_SIDED_BUFFER_METERS toward its lane

The collection also carries top-level `metadata` (source dataset ids, build
timestamp) that data loaders record as the data_version.

Rate note: NYC prices the 1st and 2nd hour separately and only some zones post a
3rd-hour rate. `rate_additional_hour` is the 2nd-hour price, which is the one an
extension from 1h to 2h actually costs. Zones with a distinct 3rd-hour price are
counted in the summary so the extension rule can be revisited if it matters.

Run:  uv run data/build_zones.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone

import geopandas as gpd
import shapely

from fetch_nyc import DATASETS
from nyc_common import OUT_DIR, RAW_DIR

# One-sided buffer depth, from the curb line into the roadway. A parking lane is
# ~2.5 m; 12 m absorbs consumer-GPS error without reaching the opposite curb of
# most streets (opposite faces sit ~20 m apart).
ONE_SIDED_BUFFER_METERS = 12.0

# Symmetric fallback for faces whose parking side is unknown (median parking,
# "Island", malformed side values). Narrower, since it spreads both ways.
TWO_SIDED_BUFFER_METERS = 8.0

# Direction from a face's curb line toward its parking lane, i.e. the opposite
# of the compass side the face is on: an east-side face's lane is to its west.
SIDE_TO_ROADWAY = {
    "N": (0.0, -1.0),
    "S": (0.0, 1.0),
    "E": (-1.0, 0.0),
    "W": (1.0, 0.0),
}

# UTM 18N covers all five boroughs and is metric, so buffering in it gives a true
# metre distance. Output is reprojected back to WGS84 for GeoJSON.
METRIC_CRS = "EPSG:32618"
WGS84 = "EPSG:4326"

# Segments per quarter-circle on the buffer's caps and joins. The default (8)
# spends 32 vertices per corner for sub-centimetre fidelity that a 12 m tolerance
# cannot use; 4 is visually identical here and roughly halves the file.
BUFFER_QUAD_SEGS = 4

# ~11 cm at NYC's latitude. Far finer than the buffer tolerance, and it keeps the
# output a third of the size that full float64 coordinates produce. Applied via
# shapely.set_precision rather than a naive round(), because rounding raw
# coordinates collapses the hairline interior rings a buffered, doubling-back
# block face can contain and leaves "too few points" invalid polygons behind.
COORD_PRECISION = 6
COORD_GRID_SIZE = 10**-COORD_PRECISION

NOT_APPLICABLE = {"", "n/a", "na", "none", "null"}

VEHICLE_TYPES = {
    "All Vehicles": "all",
    "Commercial Only": "commercial",
    "Charter Bus Only": "charter_bus",
    "Dual (Commercial / All Vehicles)": "dual",
}
# A private car may legally park at these; the loader filters on this by default.
PASSENGER_TYPES = {"all", "dual"}

DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DAY_NAMES = {
    "monday": "Mon",
    "tuesday": "Tue",
    "wednesday": "Wed",
    "thursday": "Thu",
    "friday": "Fri",
    "saturday": "Sat",
    "sunday": "Sun",
    "mon": "Mon",
    "tues": "Tue",
    "tue": "Tue",
    "wed": "Wed",
    "thurs": "Thu",
    "thur": "Thu",
    "thu": "Thu",
    "fri": "Fri",
    "sat": "Sat",
    "sun": "Sun",
}

# "$5.00 1st Hour", "$8.25 2nd Hour", "$13.00 3rd Hour"
_ORDINAL_RATE = re.compile(r"\$\s*([\d.]+)\s*(1st|2nd|3rd|4th)\s*hour", re.IGNORECASE)
# "$5.50 Add'l Hours"
_ADDITIONAL_RATE = re.compile(r"\$\s*([\d.]+)\s*add'?l\s*hours?", re.IGNORECASE)
# "$1.50 per Hour"
_PER_HOUR_RATE = re.compile(r"\$\s*([\d.]+)\s*per\s*hour", re.IGNORECASE)
# "$1.00 per 30 Minutes"
_PER_MINUTES_RATE = re.compile(r"\$\s*([\d.]+)\s*per\s*(\d+)\s*minutes?", re.IGNORECASE)

# "2 Hours", "30 Minutes", "1 Hour"
_DURATION = re.compile(r"(\d+)\s*(hours?|minutes?|mins?)", re.IGNORECASE)

# "Monday-Friday 6 PM-12 AM" / "Saturday 9 AM-7 PM"
_HOURS_SEGMENT = re.compile(
    r"(?P<days>[A-Za-z]+(?:\s*-\s*[A-Za-z]+)?)\s+"
    r"(?P<start>\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?)\s*-\s*"
    r"(?P<end>\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?)",
    re.IGNORECASE,
)


def is_blank(value) -> bool:
    return value is None or str(value).strip().lower() in NOT_APPLICABLE


def parse_rates(text) -> tuple[float | None, float | None, bool]:
    """Parse a rate string into (first_hour, additional_hour, has_third_hour_rate).

    Handles the four shapes the dataset actually uses:
      "$5.00 1st Hour / $8.25 2nd Hour"
      "$5.50 1st Hour / $9.00 2nd Hour / $5.50 Add'l Hours"
      "$1.50 per Hour"
      "$1.00 per 30 Minutes"
    """
    if is_blank(text):
        return None, None, False
    text = str(text)

    by_ordinal: dict[str, float] = {}
    for amount, ordinal in _ORDINAL_RATE.findall(text):
        # Some strings repeat a ladder after a ";" for a PM period; the first
        # occurrence is the daytime rate, so do not overwrite it.
        by_ordinal.setdefault(ordinal.lower(), float(amount))

    first = by_ordinal.get("1st")
    additional = by_ordinal.get("2nd")
    has_third = "3rd" in by_ordinal or bool(_ADDITIONAL_RATE.search(text))

    if first is None:
        per_hour = _PER_HOUR_RATE.search(text)
        if per_hour:
            rate = float(per_hour.group(1))
            return rate, rate, False
        per_minutes = _PER_MINUTES_RATE.search(text)
        if per_minutes:
            rate = float(per_minutes.group(1)) * 60.0 / float(per_minutes.group(2))
            return round(rate, 2), round(rate, 2), False
        return None, None, False

    if additional is None:
        # "$2.00 1st Hour" with no second hour posted, or a flat Add'l rate.
        flat = _ADDITIONAL_RATE.search(text) or _PER_HOUR_RATE.search(text)
        additional = float(flat.group(1)) if flat else first

    return first, additional, has_third


def parse_max_stay_minutes(text) -> int | None:
    """Parse "2 Hours", "30 Minutes", "2 Hours (Mon-Thurs), 4 Hours (Fri)".

    For the conditional strings the first (most restrictive, weekday) duration
    is taken — paying for that is always legal, paying for the longer one is not.
    """
    if is_blank(text):
        return None
    match = _DURATION.search(str(text))
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2).lower()
    return amount * 60 if unit.startswith("hour") else amount


def parse_clock(token: str) -> str | None:
    """"8:30 AM" -> "08:30"; "12 AM" -> "00:00"; "7 PM" -> "19:00"."""
    match = re.match(
        r"(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?", token.strip(), re.IGNORECASE
    )
    if not match:
        return None
    hour = int(match.group(1)) % 12
    minute = int(match.group(2) or 0)
    if match.group(3).upper() == "P":
        hour += 12
    return f"{hour:02d}:{minute:02d}"


def expand_days(text: str) -> list[str]:
    """"Monday-Saturday" -> [Mon..Sat]; "Saturday" -> [Sat]."""
    parts = [p.strip().lower().rstrip(".") for p in text.split("-")]
    resolved = [DAY_NAMES.get(p) for p in parts]
    if not resolved or any(day is None for day in resolved):
        return []
    if len(resolved) == 1:
        return resolved
    start, end = DAY_ORDER.index(resolved[0]), DAY_ORDER.index(resolved[-1])
    if start <= end:
        return DAY_ORDER[start : end + 1]
    # Wraps past Sunday, e.g. "Saturday-Monday".
    return DAY_ORDER[start:] + DAY_ORDER[: end + 1]


def parse_hours(text) -> tuple[list[dict], bool]:
    """Parse an hours string into intervals; returns (intervals, parsed_ok).

    An end of "12 AM" is emitted as "24:00" so that an interval always reads
    left-to-right within one day.
    """
    if is_blank(text):
        return [], True  # "N/A" is a known, meaningful value, not a parse failure

    intervals: list[dict] = []
    for match in _HOURS_SEGMENT.finditer(str(text)):
        days = expand_days(match.group("days"))
        start = parse_clock(match.group("start"))
        end = parse_clock(match.group("end"))
        if not days or start is None or end is None:
            continue
        if end == "00:00":
            end = "24:00"
        intervals.append({"days": days, "start": start, "end": end})

    return intervals, bool(intervals)


def build_rate_zone_fallback(path) -> dict[str, tuple[float | None, float | None]]:
    """Map "Zone M1" -> parsed All-Vehicles rates from the rate-zone polygons.

    The `rate_zone` string packs both vehicle classes, e.g.
      "Zone M1 - Commercial Vehicles: $7.00 ... , All Vehicles: $5.50 ..."
    so the All Vehicles clause is sliced out before parsing.
    """
    zones = gpd.read_file(path)
    fallback: dict[str, tuple[float | None, float | None]] = {}
    for _, row in zones.iterrows():
        key = str(row.get("zone") or "").strip()
        rate_text = str(row.get("rate_zone") or "")
        if not key or key in fallback:
            continue
        lowered = rate_text.lower()
        marker = lowered.find("all vehicles")
        clause = rate_text[marker:] if marker != -1 else rate_text
        first, additional, _ = parse_rates(clause)
        if first is not None:
            fallback[key] = (first, additional)
    return fallback


def buffer_face(line, side: str | None):
    """Buffer one block-face line toward its parking lane, in a metric CRS.

    Returns (polygon, mode) where mode is "one_sided" or "two_sided". The side
    letter picks which of shapely's two single-sided buffers to keep: the one
    whose centroid is displaced from the line's centroid toward the roadway
    (SIDE_TO_ROADWAY). That stays correct for diagonal streets, where the
    displacement still projects positively onto the intended axis.
    """
    target = SIDE_TO_ROADWAY.get(side or "")
    if target is None:
        return (
            line.buffer(TWO_SIDED_BUFFER_METERS, quad_segs=BUFFER_QUAD_SEGS),
            "two_sided",
        )

    merged = shapely.line_merge(line)
    parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    pieces = []
    for part in parts:
        if part.geom_type != "LineString" or part.length == 0:
            pieces.append(
                part.buffer(TWO_SIDED_BUFFER_METERS, quad_segs=BUFFER_QUAD_SEGS)
            )
            continue

        def toward_lane(polygon) -> float:
            if polygon.is_empty:
                return float("-inf")
            dx = polygon.centroid.x - part.centroid.x
            dy = polygon.centroid.y - part.centroid.y
            return dx * target[0] + dy * target[1]

        pick = max(
            (
                part.buffer(ONE_SIDED_BUFFER_METERS, single_sided=True),
                part.buffer(-ONE_SIDED_BUFFER_METERS, single_sided=True),
            ),
            key=toward_lane,
        )
        if pick.is_empty:
            pick = part.buffer(TWO_SIDED_BUFFER_METERS, quad_segs=BUFFER_QUAD_SEGS)
        pieces.append(pick)

    return shapely.union_all(pieces), "one_sided"


def snap_to_grid(geometry, stats):
    """set_precision with a fallback for geometries it refuses to snap.

    GEOS occasionally raises a TopologyException from set_precision even on a
    valid input; for those, snap coordinates pointwise (no topology pass) and
    repair whatever that produces.
    """
    try:
        return shapely.set_precision(geometry, grid_size=COORD_GRID_SIZE)
    except shapely.errors.GEOSException:
        stats["snapped_pointwise"] += 1
        snapped = shapely.set_precision(
            geometry, grid_size=COORD_GRID_SIZE, mode="pointwise"
        )
        return snapped if snapped.is_valid else shapely.make_valid(snapped)


def round_coords(value, precision: int = COORD_PRECISION):
    """Recursively round a GeoJSON coordinate tree to `precision` decimals."""
    if isinstance(value, (list, tuple)):
        return [round_coords(item, precision) for item in value]
    return round(value, precision)


def write_geojson(frame: gpd.GeoDataFrame, destination) -> None:
    """Serialise the frame to GeoJSON directly, without going through GDAL.

    GDAL's GeoJSON driver inspects string properties and silently re-emits any
    that look like JSON as nested objects. Writing here instead makes the shape
    of `hours_json` an explicit decision (a real JSON array, which loads straight
    into a Postgres jsonb column) rather than a side effect of that heuristic,
    and lets coordinates be rounded to a sane precision on the way out.
    """
    from shapely.geometry import mapping

    features = []
    for record in frame.to_dict("records"):
        geometry = mapping(record.pop("geometry"))
        geometry["coordinates"] = round_coords(geometry["coordinates"])
        centerline = mapping(record.pop("centerline"))
        centerline["coordinates"] = round_coords(centerline["coordinates"])
        record["hours_json"] = json.loads(record["hours_json"])
        # The original face line rides along as a property so the server can
        # rank overlapping candidates by distance to it. GeoJSON only allows
        # one geometry per feature, but a geometry object is still valid JSON.
        record["centerline"] = centerline
        features.append(
            {"type": "Feature", "properties": record, "geometry": geometry}
        )

    collection = {
        "type": "FeatureCollection",
        "crs": {
            "type": "name",
            "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"},
        },
        "metadata": {
            "generator": "data/build_zones.py",
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sources": {key: meta["id"] for key, meta in DATASETS.items()},
            "one_sided_buffer_meters": ONE_SIDED_BUFFER_METERS,
            "two_sided_buffer_meters": TWO_SIDED_BUFFER_METERS,
            "feature_count": len(features),
        },
        "features": features,
    }
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(collection, handle, separators=(",", ":"))


def main() -> int:
    block_faces_path = RAW_DIR / "block_faces.geojson"
    rate_zones_path = RAW_DIR / "rate_zones.geojson"
    for path in (block_faces_path, rate_zones_path):
        if not path.exists():
            print(
                f"Missing {path}. Run `uv run data/fetch_nyc.py` first.",
                file=sys.stderr,
            )
            return 1

    print(f"Reading {block_faces_path.name} ...")
    faces = gpd.read_file(block_faces_path)
    print(f"  {len(faces)} raw block faces")

    print(f"Reading {rate_zones_path.name} ...")
    rate_fallback = build_rate_zone_fallback(rate_zones_path)
    print(f"  {len(rate_fallback)} rate zones with parseable All-Vehicles rates")

    stats = Counter()
    records = []
    unparsed_hours: list[str] = []

    for _, row in faces.iterrows():
        zone_number = str(row.get("pay_by_cel") or "").strip()
        if not zone_number:
            stats["dropped_no_zone_number"] += 1
            continue

        raw_vehicle = str(row.get("vehicle_ty") or "").strip()
        vehicle_type = VEHICLE_TYPES.get(
            raw_vehicle, raw_vehicle.lower().replace(" ", "_") or "unknown"
        )
        if vehicle_type not in VEHICLE_TYPES.values():
            stats[f"unmapped_vehicle_type:{raw_vehicle}"] += 1

        side = str(row.get("side_of_st") or "").strip().upper()
        if side not in SIDE_TO_ROADWAY:
            stats["side_unknown_two_sided"] += 1
            side = None

        # All Vehicles is the private-car case; Commercial-Only faces carry their
        # values in the commerci_* columns instead.
        if not is_blank(row.get("all_vehi_2")):
            rate_text = row.get("all_vehi_2")
            stay_text = row.get("all_vehicl")
            hours_text = row.get("all_vehi_1")
        else:
            rate_text = row.get("commerci_2")
            stay_text = row.get("commercial")
            hours_text = row.get("commerci_1")
            stats["used_commercial_columns"] += 1

        first, additional, has_third = parse_rates(rate_text)
        if has_third:
            stats["has_distinct_third_hour_rate"] += 1

        if first is None:
            zone_key = str(row.get("meter_rate") or "").strip()
            if zone_key in rate_fallback:
                first, additional = rate_fallback[zone_key]
                stats["rates_from_rate_zone_fallback"] += 1
            else:
                stats["dropped_no_rate"] += 1
                continue

        max_stay = parse_max_stay_minutes(stay_text)
        if max_stay is None:
            stats["missing_max_stay"] += 1

        hours, parsed_ok = parse_hours(hours_text)
        if not parsed_ok:
            stats["unparsed_hours"] += 1
            if len(unparsed_hours) < 10:
                unparsed_hours.append(str(hours_text))
        if is_blank(hours_text):
            stats["no_posted_hours"] += 1

        records.append(
            {
                "zone_id": f"nyc-{zone_number}",
                "parknyc_zone_number": zone_number,
                "vehicle_type": vehicle_type,
                "passenger": vehicle_type in PASSENGER_TYPES,
                "rate_first_hour": first,
                "rate_additional_hour": additional,
                "max_stay_minutes": max_stay,
                "hours_json": json.dumps(hours, separators=(",", ":")),
                "side_of_street": side,
                "centerline": row.geometry,
                "geometry": row.geometry,
            }
        )

    if not records:
        print("No usable block faces; nothing written.", file=sys.stderr)
        return 1

    zones = gpd.GeoDataFrame(records, geometry="geometry", crs=faces.crs or WGS84)

    empty = zones.geometry.is_empty | zones.geometry.isna()
    if empty.any():
        stats["dropped_empty_geometry"] += int(empty.sum())
        zones = zones[~empty].copy()

    print(
        f"Buffering {len(zones)} block faces one-sided by "
        f"{ONE_SIDED_BUFFER_METERS} m toward their lane in {METRIC_CRS} ..."
    )
    metric_lines = zones.geometry.to_crs(METRIC_CRS)
    buffered = []
    for line, side in zip(metric_lines.values, zones["side_of_street"].values):
        polygon, mode = buffer_face(line, side)
        stats[f"buffered_{mode}"] += 1
        buffered.append(polygon)
    zones["geometry"] = gpd.GeoSeries(
        buffered, index=zones.index, crs=METRIC_CRS
    ).to_crs(WGS84)
    zones = zones.drop(columns=["side_of_street"])

    # Repair before snapping: a one-sided buffer of a line that doubles back can
    # self-intersect, and set_precision raises on some of those ("unable to
    # assign free hole to a shell") instead of cleaning them.
    invalid = ~zones.geometry.is_valid
    if invalid.any():
        stats["repaired_invalid_buffer"] += int(invalid.sum())
        zones.loc[invalid, "geometry"] = zones.loc[invalid, "geometry"].make_valid()

    # Snap to the output grid here, while the result can still be repaired, so
    # that serialisation is pure formatting and never introduces invalidity.
    zones["geometry"] = [snap_to_grid(geom, stats) for geom in zones.geometry.values]

    invalid = ~zones.geometry.is_valid
    if invalid.any():
        stats["repaired_invalid_after_snap"] += int(invalid.sum())
        zones.loc[invalid, "geometry"] = zones.loc[invalid, "geometry"].make_valid()

    degenerate = zones.geometry.is_empty | zones.geometry.isna()
    if degenerate.any():
        stats["dropped_degenerate_after_snap"] += int(degenerate.sum())
        zones = zones[~degenerate].copy()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    destination = OUT_DIR / "zones.geojson"
    write_geojson(zones, destination)

    print(f"\nWrote {len(zones)} zones -> {destination}")
    print(f"  size: {destination.stat().st_size / 1_048_576:.1f} MB")
    for key in sorted(stats):
        print(f"  {key}: {stats[key]}")
    if unparsed_hours:
        print("  sample unparsed hours strings:")
        for text in unparsed_hours:
            print(f"    {text!r}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
