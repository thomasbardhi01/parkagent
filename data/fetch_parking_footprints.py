"""Fetch garage and lot footprints from OpenStreetMap and build
data/out/<city>_garages.geojson, one file per city (FR-49).

What it keeps: every `amenity=parking` way and multipolygon relation in the
city's bounding box, as one Polygon per outline, with `name`, `operator`,
`parking` (as `kind`), `fee`, `access`, `capacity`, and `website`.

What it skips: parking along the street (`parking=street_side`, `lane`, and
their kerb-side cousins). Those are our zones, never a footprint.

Entrances, in this order:
  1. nodes on the outline tagged `entrance=*`;
  2. `amenity=parking_entrance` nodes on or within 30 m of the outline (an
     underground garage's ramp is usually mapped beside it);
  3. failing both, the outline's vertex nearest a road centerline within
     60 m (driveable roads; the aisles inside a lot don't count) — a guess,
     and marked as one (`entrance_source: "road_vertex"`).

The source is the public Overpass API, asked one tile at a time (a city in
one query times out), one request at a time, with a pause between requests
and an identifying User-Agent. Each tile's answer is cached in
data/raw/parking_footprints/<city>/, so a rerun asks only for what's
missing; a tile that fails stops the build rather than shrinking it.

OpenStreetMap data is © OpenStreetMap contributors, under the ODbL
(https://www.openstreetmap.org/copyright): wherever these outlines are
shown, that line goes with them. The collection's metadata carries it, and
so does GET /garages/near.

Run:  uv run data/fetch_parking_footprints.py [--city bos|nyc|all] [--force]
Then: pnpm -C server load:garages --file data/out/<city>_garages.geojson
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, NamedTuple

import requests
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

from nyc_common import OUT_DIR, RAW_DIR

# (south, west, north, east). Generous boxes: a garage just over the city
# line is still where somebody parks.
CITY_BOUNDS: dict[str, tuple[float, float, float, float]] = {
    "bos": (42.227, -71.191, 42.400, -70.986),
    "nyc": (40.477, -74.259, 40.918, -73.700),
}

SOURCE = "osm"
ATTRIBUTION = "© OpenStreetMap contributors"
LICENSE = "ODbL 1.0 (https://www.openstreetmap.org/copyright)"

OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
USER_AGENT = "ParkAgent-footprints/0.1 (personal prototype; github.com/thomasbardhi01/parkagent)"
OVERPASS_TIMEOUT_S = 180
# The public server is often busy: it answers 429 or 504 at once, and the
# same query goes through a minute later. Wait up to about ten minutes.
MAX_RETRIES = 8
MAX_BACKOFF_S = 120
PAUSE_BETWEEN_TILES_S = 2.0

# About 4.4 km x 4.1 km at these latitudes: small enough that the densest
# tile answers well inside the timeout.
TILE_LAT_DEG = 0.04
TILE_LNG_DEG = 0.05

# OSM `parking=` values that mean the curb, not a place to drive into.
STREET_PARKING = frozenset({"street_side", "lane", "on_kerb", "half_on_kerb", "shoulder", "layby"})
KINDS = {
    "multi-storey": "multi_storey",
    "underground": "underground",
    "surface": "surface",
    "rooftop": "rooftop",
}

# Roads a car reaches a garage from. Not the aisles inside a lot (every
# vertex is next to one), and nothing a car can't drive on.
ROAD_CLASSES = (
    "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link"
    "|tertiary|tertiary_link|unclassified|residential|living_street|service"
)
ROAD_REACH_M = 60
ENTRANCE_NODE_REACH_M = 30
# How far past a tile's edge its roads and entrance nodes are fetched:
# about 110 m, past both reaches above.
PAD_LAT_DEG = 0.001
PAD_LNG_DEG = 0.0014
MIN_AREA_M2 = 10.0

MAX_TEXT = 200
MAX_WEBSITE = 500
MAX_CAPACITY = 100_000
SLUG_MAX = 40
HASH_MIN, HASH_MAX = 6, 12

M_PER_DEG_LAT = 111_320.0


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


def kind_for(tags: dict) -> str | None:
    """The footprint kind for an element's tags; None for street parking."""
    value = str(tags.get("parking", "")).strip().lower()
    if value in STREET_PARKING:
        return None
    return KINDS.get(value, "unknown")


def clean_text(value: object, limit: int = MAX_TEXT) -> str | None:
    """Trimmed, single-spaced, printable text, or None when there is none."""
    if not isinstance(value, str):
        return None
    printable = "".join(ch if ch.isprintable() else " " for ch in value)
    text = " ".join(printable.split())
    return text[:limit].rstrip() or None


def parse_fee(value: object) -> bool | None:
    """yes -> True, no -> False; anything else (hours, "donation") -> None."""
    if not isinstance(value, str):
        return None
    return {"yes": True, "no": False}.get(value.strip().lower())


def parse_capacity(value: object) -> int | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,6}", value.strip()):
        return None
    capacity = int(value.strip())
    return capacity if capacity <= MAX_CAPACITY else None


_WEBSITE = re.compile(
    r"https?://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::(\d{1,5}))?(?:[/?#][^\s]*)?",
    re.IGNORECASE,
)


def parse_website(tags: dict) -> str | None:
    """An http(s) URL with a plain host, or None. The app may open what's
    stored, so anything else in the tag (a bare domain, another scheme) is
    dropped rather than repaired."""
    for key in ("website", "contact:website"):
        value = tags.get(key)
        if not isinstance(value, str):
            continue
        url = value.strip()
        match = _WEBSITE.fullmatch(url)
        if not match or len(url) > MAX_WEBSITE or not url.isascii():
            continue
        if match.group(1) and int(match.group(1)) > 65_535:
            continue
        return url
    return None


def slugify(text: str) -> str:
    """lowercase-ascii-with-hyphens, at most SLUG_MAX characters."""
    folded = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(ch for ch in folded if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only.lower()).strip("-")
    return slug[:SLUG_MAX].strip("-")


def _sha1(ref: str) -> str:
    return hashlib.sha1(ref.encode("utf-8")).hexdigest()


def assign_ids(
    city: str, entries: list[tuple[str, str]], digest: Callable[[str], str] = _sha1
) -> list[str]:
    """`<city>-<slug>-<hash6>` for each (slug, ref), in order.

    The hash is of the ref (the outline's identity at the source), so an id
    survives a rebuild. Where two refs under one slug share their first six
    characters, every one of them gets the shortest longer hash that tells
    them apart: the answer doesn't depend on which was seen first.
    """
    hashes = [digest(ref) for _, ref in entries]
    groups: dict[tuple[str, str], list[int]] = {}
    for index, (slug, _) in enumerate(entries):
        groups.setdefault((slug, hashes[index][:HASH_MIN]), []).append(index)
    lengths = [HASH_MIN] * len(entries)
    for members in groups.values():
        if len(members) == 1:
            continue
        for length in range(HASH_MIN + 1, HASH_MAX + 1):
            if len({hashes[i][:length] for i in members}) == len(members):
                break
        else:
            raise ValueError(f"ids collide past {HASH_MAX} characters: {members}")
        for i in members:
            lengths[i] = length
    return [
        f"{city}-{slug}-{hashes[i][: lengths[i]]}" for i, (slug, _) in enumerate(entries)
    ]


# ---------------------------------------------------------------------------
# Overpass
# ---------------------------------------------------------------------------


class Tile(NamedTuple):
    row: int
    col: int
    south: float
    west: float
    north: float
    east: float


def plan_tiles(
    bounds: tuple[float, float, float, float],
    lat_step: float = TILE_LAT_DEG,
    lng_step: float = TILE_LNG_DEG,
) -> list[Tile]:
    """A gapless grid over the box, row 0 at its south edge."""
    south, west, north, east = bounds
    # The epsilon keeps a span that is a whole number of steps (give or
    # take float noise) from growing an extra, empty row.
    rows = max(1, math.ceil((north - south) / lat_step - 1e-9))
    cols = max(1, math.ceil((east - west) / lng_step - 1e-9))
    return [
        Tile(
            row,
            col,
            round(south + row * lat_step, 6),
            round(west + col * lng_step, 6),
            round(south + (row + 1) * lat_step, 6),
            round(west + (col + 1) * lng_step, 6),
        )
        for row in range(rows)
        for col in range(cols)
    ]


def overpass_query(tile: Tile) -> str:
    bbox = f"{tile.south},{tile.west},{tile.north},{tile.east}"
    # Entrances and roads just past the tile's edge belong to outlines on it.
    padded = (
        f"{round(tile.south - PAD_LAT_DEG, 6)},{round(tile.west - PAD_LNG_DEG, 6)},"
        f"{round(tile.north + PAD_LAT_DEG, 6)},{round(tile.east + PAD_LNG_DEG, 6)}"
    )
    street = "|".join(sorted(STREET_PARKING))
    # Roads and entrance nodes are asked for by box, not "around the
    # parking": the box is an index lookup, and the around-filter times out
    # on a dense tile. build_features does the measuring.
    return f"""[out:json][timeout:{OVERPASS_TIMEOUT_S}];
(
  way["amenity"="parking"]["parking"!~"^({street})$"]({bbox});
  relation["amenity"="parking"]["parking"!~"^({street})$"]({bbox});
)->.parking;
.parking out geom;
way(r.parking)->.members;
(
  node(w.parking)["entrance"];
  node(w.members)["entrance"];
  node["amenity"="parking_entrance"]({padded});
)->.entrances;
.entrances out;
way["highway"~"^({ROAD_CLASSES})$"]["service"!="parking_aisle"]({padded});
out ids geom;
"""


def fetch_overpass(query: str) -> dict:
    """One Overpass request, retried with backoff when the server is busy."""
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers={"User-Agent": USER_AGENT},
                timeout=OVERPASS_TIMEOUT_S + 60,
            )
            # 429 and 504 are Overpass saying "later", not "never".
            if response.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {response.status_code}", response=response)
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as exc:
            if attempt == MAX_RETRIES - 1:
                raise RuntimeError(f"Overpass request failed: {exc}") from exc
            backoff = min(MAX_BACKOFF_S, 15 * 2**attempt)
            print(f"    request failed ({exc}); retrying in {backoff}s", file=sys.stderr)
            time.sleep(backoff)
    raise AssertionError("unreachable")


def _usable(answer: object, query: str | None = None) -> bool:
    """A whole Overpass answer (to this very query, when one is given)."""
    if not isinstance(answer, dict) or not isinstance(answer.get("elements"), list):
        return False
    # Overpass reports a timeout or an out-of-memory stop as a 200 with a
    # remark and whatever it had so far.
    if answer.get("remark"):
        return False
    # A cached tile is good only for the query that fetched it: a changed
    # box, tile size, or query text asks again.
    return query is None or answer.get("_query") == query


def fetch_tiles(
    city: str,
    *,
    bounds: tuple[float, float, float, float] | None = None,
    raw_dir: Path = RAW_DIR,
    fetch: Callable[[str], dict] = fetch_overpass,
    pause_s: float = PAUSE_BETWEEN_TILES_S,
    force: bool = False,
) -> list[dict]:
    """Every tile's Overpass answer for the city, from the cache where it
    holds one. A tile that can't be fetched whole raises: a build from part
    of a city would load as a city with most of its garages gone."""
    tiles = plan_tiles(bounds or CITY_BOUNDS[city])
    cache_dir = raw_dir / "parking_footprints" / city
    answers: list[dict] = []
    for index, tile in enumerate(tiles):
        path = cache_dir / f"{tile.row}_{tile.col}.json"
        query = overpass_query(tile)
        if path.exists() and not force:
            try:
                cached = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                cached = None
            if _usable(cached, query):
                answers.append(cached)
                continue
        print(f"  tile {index + 1}/{len(tiles)} ({tile.row}_{tile.col}) ...", flush=True)
        answer = fetch(query)
        if not _usable(answer):
            remark = answer.get("remark") if isinstance(answer, dict) else None
            raise RuntimeError(
                f"tile {tile.row}_{tile.col}: Overpass did not answer in full (remark: {remark})"
            )
        stored = {**answer, "_query": query}
        cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(stored), encoding="utf-8")
        answers.append(stored)
        if pause_s > 0 and index + 1 < len(tiles):
            time.sleep(pause_s)
    return answers


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------


class _Projection:
    """Equirectangular meters around one latitude: plenty for distances of
    tens of meters across a city."""

    def __init__(self, lat0: float, lon0: float) -> None:
        self.lat0, self.lon0 = lat0, lon0
        self.kx = M_PER_DEG_LAT * math.cos(math.radians(lat0))

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * M_PER_DEG_LAT)

    def ring(self, coords) -> list[tuple[float, float]]:
        return [self.xy(lon, lat) for lon, lat in coords]

    def polygon(self, polygon: Polygon) -> Polygon:
        return Polygon(
            self.ring(polygon.exterior.coords),
            [self.ring(interior.coords) for interior in polygon.interiors],
        )


def _lonlat(geometry: list[dict] | None) -> list[tuple[float, float]]:
    return [
        (float(p["lon"]), float(p["lat"]))
        for p in geometry or []
        if isinstance(p, dict) and "lon" in p and "lat" in p
    ]


def _rounded(polygon: Polygon) -> Polygon:
    def ring(coords) -> list[tuple[float, float]]:
        return [(round(x, 7), round(y, 7)) for x, y in coords]

    return Polygon(ring(polygon.exterior.coords), [ring(i.coords) for i in polygon.interiors])


def _polygons(geometry) -> list[Polygon]:
    """The Polygons in whatever a repair returned."""
    if geometry is None or geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [p for part in geometry.geoms for p in _polygons(part)]
    return []


def _valid_parts(polygon: Polygon) -> list[Polygon]:
    """The outline as valid polygons at 7 decimal places: usually itself; a
    self-crossing ring comes back as its pieces."""
    candidates = [polygon] if polygon.is_valid else _polygons(shapely.make_valid(polygon))
    parts: list[Polygon] = []
    for candidate in candidates:
        rounded = _rounded(candidate)
        if not rounded.is_valid:
            # Rounding moved a repaired vertex across a neighbor.
            repaired = _polygons(rounded.buffer(0))
            parts.extend(p for p in (_rounded(r) for r in repaired) if p.is_valid)
        else:
            parts.append(rounded)
    return [p for p in parts if not p.is_empty]


def _way_polygons(element: dict) -> list[Polygon]:
    coords = _lonlat(element.get("geometry"))
    if len(coords) < 4 or coords[0] != coords[-1]:
        return []  # not a closed ring: a line somebody tagged as parking
    return _valid_parts(Polygon(coords))


def _relation_polygons(element: dict) -> list[Polygon]:
    outer, inner = [], []
    for member in element.get("members", []):
        if member.get("type") != "way":
            continue
        coords = _lonlat(member.get("geometry"))
        if len(coords) < 2:
            continue
        (inner if member.get("role") == "inner" else outer).append(LineString(coords))
    if not outer:
        return []
    # A ring is often split across member ways; polygonize stitches them.
    shells = list(polygonize(unary_union(outer)))
    holes = list(polygonize(unary_union(inner))) if inner else []
    polygons: list[Polygon] = []
    for shell in shells:
        inside = [h for h in holes if shell.contains(h.representative_point())]
        polygons.extend(
            _valid_parts(Polygon(shell.exterior.coords, [h.exterior.coords for h in inside]))
        )
    return polygons


def _key(lon: float, lat: float) -> tuple[float, float]:
    return (round(lon, 7), round(lat, 7))


def _is_entrance(tags: dict) -> bool:
    return "entrance" in tags or tags.get("amenity") == "parking_entrance"


def build_features(city: str, responses: list[dict]) -> list[dict]:
    """GeoJSON features, one per outline, from Overpass answers. Pure: the
    same answers give the same features in the same order, whatever order
    the tiles come in."""
    parking: dict[tuple[str, int], dict] = {}
    nodes: dict[int, dict] = {}
    roads: dict[int, list[tuple[float, float]]] = {}
    for response in responses:
        for element in response.get("elements", []):
            kind, osm_id = element.get("type"), element.get("id")
            tags = element.get("tags") or {}
            if kind == "node":
                if _is_entrance(tags) and "lon" in element and "lat" in element:
                    nodes[osm_id] = element
            elif tags.get("amenity") == "parking":
                # A way that straddles two tiles is in both answers.
                parking[(kind, osm_id)] = element
            elif kind == "way" and not tags:
                coords = _lonlat(element.get("geometry"))
                if len(coords) >= 2:
                    roads[osm_id] = coords

    # Outlines, in a fixed order, each as (ref, element, polygon).
    outlines: list[tuple[str, str, int, dict, Polygon]] = []
    for (osm_type, osm_id), element in sorted(parking.items()):
        tags = element.get("tags") or {}
        if kind_for(tags) is None:
            continue
        polygons = _way_polygons(element) if osm_type == "way" else _relation_polygons(element)
        if not polygons:
            continue
        outlines.extend((osm_type, f"{osm_type}/{osm_id}", osm_id, element, p) for p in polygons)
    if not outlines:
        return []

    lats = [lat for *_, polygon in outlines for _, lat in polygon.exterior.coords]
    lons = [lon for *_, polygon in outlines for lon, _ in polygon.exterior.coords]
    projection = _Projection(sum(lats) / len(lats), sum(lons) / len(lons))

    # Drop slivers, then number the parts of a multi-part outline largest
    # first, so a part's ref doesn't depend on member order.
    by_ref: dict[str, list[tuple[float, tuple, str, int, dict, Polygon, Polygon]]] = {}
    for osm_type, ref, osm_id, element, polygon in outlines:
        flat = projection.polygon(polygon)
        if flat.area < MIN_AREA_M2:
            continue
        centroid = polygon.centroid
        by_ref.setdefault(ref, []).append(
            (flat.area, (centroid.x, centroid.y), osm_type, osm_id, element, polygon, flat)
        )
    kept: list[tuple[str, str, int, dict, Polygon, Polygon]] = []
    for ref in sorted(by_ref):
        parts = sorted(by_ref[ref], key=lambda part: (-part[0], part[1]))
        for index, (_, _, osm_type, osm_id, element, polygon, flat) in enumerate(parts):
            kept.append(
                (ref if index == 0 else f"{ref}/{index}", osm_type, osm_id, element, polygon, flat)
            )
    if not kept:
        return []

    # Entrance nodes: on an outline's vertex, else within reach of the
    # nearest outline.
    vertex_owners: dict[tuple[float, float], list[int]] = {}
    for index, (*_, polygon, _flat) in enumerate(kept):
        for lon, lat in polygon.exterior.coords[:-1]:
            vertex_owners.setdefault(_key(lon, lat), []).append(index)
    mapped: dict[int, list[tuple[float, float]]] = {}
    flat_tree = STRtree([flat for *_, flat in kept])
    for node_id in sorted(nodes):
        node = nodes[node_id]
        lon, lat = float(node["lon"]), float(node["lat"])
        owners = vertex_owners.get(_key(lon, lat))
        if owners is None and (node.get("tags") or {}).get("amenity") == "parking_entrance":
            nearest = flat_tree.query_nearest(
                Point(projection.xy(lon, lat)), max_distance=ENTRANCE_NODE_REACH_M
            )
            # Equally near (inside two nested outlines): an entrance to both.
            owners = sorted(int(i) for i in nearest) if len(nearest) > 0 else None
        for owner in owners or []:
            mapped.setdefault(owner, []).append(_key(lon, lat))

    road_lines = [LineString(projection.ring(coords)) for _, coords in sorted(roads.items())]
    road_tree = STRtree(road_lines) if road_lines else None

    def nearest_road_vertex(polygon: Polygon) -> tuple[float, float] | None:
        if road_tree is None:
            return None
        vertices = list(polygon.exterior.coords[:-1])
        points = [Point(projection.xy(lon, lat)) for lon, lat in vertices]
        nearest = road_tree.nearest(points)
        best: tuple[float, float, float] | None = None
        for (lon, lat), point, road_index in zip(vertices, points, nearest):
            candidate = (round(point.distance(road_lines[int(road_index)]), 3), lon, lat)
            if candidate[0] <= ROAD_REACH_M and (best is None or candidate < best):
                best = candidate
        return None if best is None else _key(best[1], best[2])

    entries: list[tuple[str, str]] = []
    drafts: list[dict] = []
    for index, (ref, osm_type, osm_id, element, polygon, _flat) in enumerate(kept):
        tags = element.get("tags") or {}
        kind = kind_for(tags)
        assert kind is not None  # street parking never got this far
        name = clean_text(tags.get("name"))
        entrances = sorted(set(mapped.get(index, [])))
        entrance_source = "osm"
        if not entrances:
            guess = nearest_road_vertex(polygon)
            entrances = [guess] if guess else []
            entrance_source = "road_vertex" if guess else "none"
        slug = slugify(name) if name else ""
        if not slug:
            slug = "parking" if kind == "unknown" else kind.replace("_", "-")
        entries.append((slug, ref))
        access = clean_text(tags.get("access"))
        drafts.append(
            {
                "type": "Feature",
                "properties": {
                    "garage_id": "",
                    "city": city,
                    "name": name,
                    "operator": clean_text(tags.get("operator")),
                    "kind": kind,
                    "fee": parse_fee(tags.get("fee")),
                    "access": access.lower() if access else None,
                    "capacity": parse_capacity(tags.get("capacity")),
                    "website": parse_website(tags),
                    "entrances": {
                        "type": "MultiPoint",
                        "coordinates": [[lon, lat] for lon, lat in entrances],
                    },
                    "entrance_source": entrance_source,
                    "osm_type": osm_type,
                    "osm_id": osm_id,
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[lon, lat] for lon, lat in ring.coords]
                        for ring in (polygon.exterior, *polygon.interiors)
                    ],
                },
            }
        )
    for draft, garage_id in zip(drafts, assign_ids(city, entries)):
        draft["properties"]["garage_id"] = garage_id
    return drafts


def build_collection(city: str, responses: list[dict], built_at: str | None = None) -> dict:
    features = build_features(city, responses)
    stamps = [
        stamp
        for response in responses
        if isinstance(stamp := (response.get("osm3s") or {}).get("timestamp_osm_base"), str)
    ]
    by_kind = Counter(f["properties"]["kind"] for f in features)
    by_entrance = Counter(f["properties"]["entrance_source"] for f in features)
    return {
        "type": "FeatureCollection",
        "metadata": {
            "city": city,
            "built_at": built_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": SOURCE,
            # The newest OSM snapshot any tile was read from; the loader
            # stores it as each row's source_version.
            "source_version": max(stamps) if stamps else "unknown",
            "attribution": ATTRIBUTION,
            "license": LICENSE,
            "counts": {
                "features": len(features),
                "by_kind": dict(sorted(by_kind.items())),
                "by_entrance_source": dict(sorted(by_entrance.items())),
            },
        },
        "features": features,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--city", choices=[*CITY_BOUNDS, "all"], default="all")
    parser.add_argument(
        "--force", action="store_true", help="refetch every tile, ignoring the cache"
    )
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for city in CITY_BOUNDS if args.city == "all" else [args.city]:
        print(f"{city}: {len(plan_tiles(CITY_BOUNDS[city]))} tiles")
        try:
            responses = fetch_tiles(city, force=args.force)
        except RuntimeError as exc:
            print(f"  {exc}\n  nothing written for {city}; rerun to resume.", file=sys.stderr)
            return 1
        collection = build_collection(city, responses)
        counts = collection["metadata"]["counts"]
        if counts["features"] == 0:
            print(f"  no footprints for {city}; refusing to write an empty file.", file=sys.stderr)
            return 1
        destination = OUT_DIR / f"{city}_garages.geojson"
        destination.write_text(json.dumps(collection), encoding="utf-8")
        size_mb = destination.stat().st_size / 1_048_576
        print(
            f"  wrote {counts['features']} footprints -> {destination} ({size_mb:.1f} MB)\n"
            f"  kinds: {counts['by_kind']}\n"
            f"  entrances: {counts['by_entrance_source']}\n"
            f"  OSM data as of {collection['metadata']['source_version']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
