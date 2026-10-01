"""Tests for fetch_parking_footprints: kind mapping, entrances (mapped, and
the nearest-road fallback), street-parking exclusion, ids, and the tile
cache, on two small Overpass-shaped fixture tiles — no network.

Run:  uv run data/test_fetch_parking_footprints.py
(plain asserts on purpose: data/ has no test-runner dependency; the file is
pytest-compatible if one ever lands.)

The fixture (data/fixtures/overpass_parking_tile_{a,b}.json) lays its
outlines out in meters east/north of (42.35, -71.07); `at()` below is the
same arithmetic.
"""

from __future__ import annotations

import json
import math
import re
import tempfile
from pathlib import Path

from fetch_parking_footprints import (
    ATTRIBUTION,
    CITY_BOUNDS,
    STREET_PARKING,
    assign_ids,
    build_collection,
    build_features,
    fetch_tiles,
    kind_for,
    overpass_query,
    parse_capacity,
    parse_fee,
    parse_website,
    plan_tiles,
    slugify,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
LAT0, LON0 = 42.35, -71.07
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(LAT0))


def at(east_m: float, north_m: float) -> list[float]:
    """[lon, lat] of a fixture position, rounded as the fixture rounds."""
    return [round(LON0 + east_m / M_PER_DEG_LON, 7), round(LAT0 + north_m / M_PER_DEG_LAT, 7)]


def tile(name: str) -> dict:
    return json.loads((FIXTURES / f"overpass_parking_tile_{name}.json").read_text("utf-8"))


def features() -> list[dict]:
    return build_features("bos", [tile("a"), tile("b")])


def by_osm(found: list[dict], osm_type: str, osm_id: int) -> list[dict]:
    return [
        f
        for f in found
        if f["properties"]["osm_type"] == osm_type and f["properties"]["osm_id"] == osm_id
    ]


def close(a: list[float], b: list[float]) -> bool:
    return abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6


def test_kind_mapping() -> None:
    assert kind_for({"amenity": "parking", "parking": "multi-storey"}) == "multi_storey"
    assert kind_for({"amenity": "parking", "parking": "underground"}) == "underground"
    assert kind_for({"amenity": "parking", "parking": "surface"}) == "surface"
    assert kind_for({"amenity": "parking", "parking": "rooftop"}) == "rooftop"
    # Untagged, or a value we don't model: a footprint of unknown kind.
    assert kind_for({"amenity": "parking"}) == "unknown"
    assert kind_for({"amenity": "parking", "parking": "carports"}) == "unknown"
    assert kind_for({"amenity": "parking", "parking": "garage_boxes"}) == "unknown"
    # Tag values are free text: case and stray spaces don't change the kind.
    assert kind_for({"amenity": "parking", "parking": " Multi-Storey "}) == "multi_storey"
    # Parking along the street is a zone, never a footprint.
    assert kind_for({"amenity": "parking", "parking": "street_side"}) is None
    assert kind_for({"amenity": "parking", "parking": "lane"}) is None
    assert {"street_side", "lane"} <= STREET_PARKING
    for value in STREET_PARKING:
        assert kind_for({"amenity": "parking", "parking": value}) is None, value


def test_street_side_and_lane_are_excluded() -> None:
    found = features()
    assert by_osm(found, "way", 103) == []  # parking=street_side
    assert by_osm(found, "way", 104) == []  # parking=lane
    kinds = {f["properties"]["kind"] for f in found}
    assert kinds <= {"multi_storey", "underground", "surface", "rooftop", "unknown"}, kinds
    # And Overpass is asked not to send them in the first place.
    query = overpass_query(plan_tiles(CITY_BOUNDS["bos"])[0])
    assert "street_side" in query and "lane" in query


def test_fields_carry_over() -> None:
    (garage,) = by_osm(features(), "way", 101)
    props = garage["properties"]
    assert props["city"] == "bos"
    assert props["name"] == "Fixture Garage"
    assert props["operator"] == "Fixture Parking Co"
    assert props["kind"] == "multi_storey"
    assert props["fee"] is True
    assert props["access"] == "customers"
    assert props["capacity"] == 420
    assert props["website"] == "https://example.com/garage"
    assert garage["geometry"]["type"] == "Polygon"
    ring = garage["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 6

    (lot,) = by_osm(features(), "way", 102)
    assert lot["properties"]["fee"] is False
    assert lot["properties"]["capacity"] is None  # "about 40"
    assert lot["properties"]["name"] is None
    assert lot["properties"]["website"] is None

    (private,) = by_osm(features(), "way", 105)
    assert private["properties"]["kind"] == "unknown"
    assert private["properties"]["access"] == "private"
    assert private["properties"]["name"] is None  # "   "
    assert private["properties"]["website"] is None  # javascript:

    (under,) = by_osm(features(), "way", 106)
    assert under["properties"]["fee"] is None  # opening-hours text: not yes, not no
    assert under["properties"]["website"] == "http://example.org/under"  # contact:website


def test_parsers() -> None:
    assert parse_fee("yes") is True and parse_fee("no") is False
    assert parse_fee(None) is None and parse_fee("donation") is None
    assert parse_fee(" YES ") is True
    assert parse_capacity("120") == 120 and parse_capacity(" 35 ") == 35
    for bad in (None, "", "many", "12.5", "-4", "1e3", "999999999"):
        assert parse_capacity(bad) is None, bad
    assert parse_website({"website": "https://example.com/a"}) == "https://example.com/a"
    assert parse_website({"contact:website": "http://example.com"}) == "http://example.com"
    for bad in ("javascript:alert(1)", "example.com", "ftp://example.com", "http://", " "):
        assert parse_website({"website": bad}) is None, bad
    assert parse_website({}) is None
    assert parse_website({"website": "https://example.com/" + "a" * 600}) is None


def test_entrances_from_member_nodes() -> None:
    (garage,) = by_osm(features(), "way", 101)
    entrances = garage["properties"]["entrances"]
    assert entrances["type"] == "MultiPoint"
    assert len(entrances["coordinates"]) == 1
    # Node 1005, the tagged vertex in the middle of the east side — not
    # the nearest-road guess, though no road is near enough to matter.
    assert close(entrances["coordinates"][0], at(20, 0))
    assert garage["properties"]["entrance_source"] == "osm"


def test_entrance_node_near_the_outline() -> None:
    # An underground garage's ramp is mapped beside it (amenity=
    # parking_entrance), not on its outline.
    (under,) = by_osm(features(), "way", 106)
    assert under["properties"]["entrance_source"] == "osm"
    assert [close(c, at(40, 300)) for c in under["properties"]["entrances"]["coordinates"]] == [True]
    # Node 2003 is 800 m from everything: nobody's entrance.
    for f in features():
        for c in f["properties"]["entrances"]["coordinates"]:
            assert not close(c, at(900, 900))


def test_entrance_fallback_is_the_vertex_nearest_a_road() -> None:
    (lot,) = by_osm(features(), "way", 102)
    assert lot["properties"]["entrance_source"] == "road_vertex"
    coordinates = lot["properties"]["entrances"]["coordinates"]
    assert len(coordinates) == 1
    # Road 501 ends 10 m from the south-west corner; every other corner is
    # 40 m or more from it.
    assert close(coordinates[0], at(170, -20)), coordinates
    # The entrance is one of the outline's own vertices.
    assert any(close(coordinates[0], v) for v in lot["geometry"]["coordinates"][0])


def test_no_road_in_reach_means_no_entrance() -> None:
    (private,) = by_osm(features(), "way", 105)
    assert private["properties"]["entrance_source"] == "none"
    assert private["properties"]["entrances"] == {"type": "MultiPoint", "coordinates": []}


def test_relations_become_one_polygon_per_outer() -> None:
    parts = by_osm(features(), "relation", 201)
    assert len(parts) == 2
    assert len({p["properties"]["garage_id"] for p in parts}) == 2
    assert {p["properties"]["name"] for p in parts} == {"Split Lot"}
    assert all(p["geometry"]["type"] == "Polygon" for p in parts)
    big = max(parts, key=lambda p: len(p["geometry"]["coordinates"]))
    small = min(parts, key=lambda p: len(p["geometry"]["coordinates"]))
    # The inner member is a hole in the outer that surrounds it.
    assert len(big["geometry"]["coordinates"]) == 2
    assert len(small["geometry"]["coordinates"]) == 1
    # Road 502 runs past the big part's south-west corner only.
    assert big["properties"]["entrance_source"] == "road_vertex"
    assert close(big["properties"]["entrances"]["coordinates"][0], at(-340, -40))
    assert small["properties"]["entrance_source"] == "none"


def test_relation_ring_split_across_member_ways() -> None:
    (roof,) = by_osm(features(), "relation", 202)
    assert roof["properties"]["kind"] == "rooftop"
    ring = roof["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 5
    # Node 2002 sits on a corner of the stitched ring.
    assert roof["properties"]["entrance_source"] == "osm"
    assert close(roof["properties"]["entrances"]["coordinates"][0], at(320, 280))


def test_broken_outlines_are_skipped() -> None:
    found = features()
    assert by_osm(found, "way", 107) == []  # never closed
    assert by_osm(found, "way", 108) == []  # 4 m²: a mapping slip, not a lot


def test_a_way_in_two_tiles_is_one_garage() -> None:
    found = features()
    assert len(by_osm(found, "way", 101)) == 1
    assert len(by_osm(found, "way", 110)) == 1
    ids = [f["properties"]["garage_id"] for f in found]
    assert len(ids) == len(set(ids))
    # 101, 102, 105, 106, 110, relation 201 twice, relation 202.
    assert len(found) == 8, sorted(ids)


def test_ids_are_city_slug_hash6_and_stable() -> None:
    found = features()
    for f in found:
        assert re.fullmatch(r"bos-[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6}", f["properties"]["garage_id"])
    (garage,) = by_osm(found, "way", 101)
    assert garage["properties"]["garage_id"].startswith("bos-fixture-garage-")
    (lot,) = by_osm(found, "way", 102)
    assert lot["properties"]["garage_id"].startswith("bos-surface-")
    (private,) = by_osm(found, "way", 105)
    assert private["properties"]["garage_id"].startswith("bos-parking-")
    # The same input gives the same ids, in the same order, whichever
    # order the tiles arrive in.
    again = build_features("bos", [tile("b"), tile("a")])
    assert [f["properties"]["garage_id"] for f in again] == [
        f["properties"]["garage_id"] for f in found
    ]
    # Another city's ids never collide with this one's.
    nyc = build_features("nyc", [tile("a")])
    assert all(f["properties"]["garage_id"].startswith("nyc-") for f in nyc)
    assert all(f["properties"]["city"] == "nyc" for f in nyc)


def test_slugify() -> None:
    assert slugify("Boston Common Garage") == "boston-common-garage"
    assert slugify("  Lot #4 — Fenway  ") == "lot-4-fenway"
    assert slugify("Café Très Bien") == "cafe-tres-bien"
    assert slugify("!!!") == ""
    assert len(slugify("a" * 200)) <= 40
    assert not slugify("x" * 39 + " y").endswith("-")


def test_id_collisions_widen_the_hash_for_both() -> None:
    digests = {
        "way/1": "abcdef0123456789",
        "way/2": "abcdef9999999999",
        "way/3": "1234560000000000",
    }
    ids = assign_ids(
        "bos",
        [("surface", "way/1"), ("surface", "way/2"), ("surface", "way/3")],
        digest=lambda ref: digests[ref],
    )
    # 1 and 2 share six characters: both widen to the first length that
    # tells them apart, so neither depends on which was seen first.
    assert ids == ["bos-surface-abcdef0", "bos-surface-abcdef9", "bos-surface-123456"]
    flipped = assign_ids(
        "bos",
        [("surface", "way/2"), ("surface", "way/1")],
        digest=lambda ref: digests[ref],
    )
    assert flipped == ["bos-surface-abcdef9", "bos-surface-abcdef0"]
    # The same hash under different slugs is no collision.
    assert assign_ids(
        "bos", [("deck", "way/1"), ("surface", "way/2")], digest=lambda ref: digests[ref]
    ) == ["bos-deck-abcdef", "bos-surface-abcdef"]


def test_tiles_cover_the_city_without_gaps() -> None:
    for city, (south, west, north, east) in CITY_BOUNDS.items():
        tiles = plan_tiles(CITY_BOUNDS[city])
        assert len(tiles) >= 4, city
        assert min(t.south for t in tiles) == south and max(t.north for t in tiles) >= north
        assert min(t.west for t in tiles) == west and max(t.east for t in tiles) >= east
        names = {(t.row, t.col) for t in tiles}
        assert len(names) == len(tiles)
        rows = max(t.row for t in tiles) + 1
        cols = max(t.col for t in tiles) + 1
        assert len(tiles) == rows * cols
        for t in tiles:
            assert t.north > t.south and t.east > t.west
            if t.row + 1 < rows:
                above = next(u for u in tiles if (u.row, u.col) == (t.row + 1, t.col))
                assert abs(above.south - t.north) < 1e-9
            if t.col + 1 < cols:
                right = next(u for u in tiles if (u.row, u.col) == (t.row, t.col + 1))
                assert abs(right.west - t.east) < 1e-9


def test_query_shape() -> None:
    tiles = plan_tiles(CITY_BOUNDS["bos"])
    query = overpass_query(tiles[0])
    assert '"amenity"="parking"' in query
    assert "relation" in query and "way" in query
    # Entrances, and the roads the fallback measures against — but never
    # the aisles inside a lot, which every vertex is next to.
    assert "parking_entrance" in query and '"entrance"' in query
    assert "highway" in query and "parking_aisle" in query
    assert "out geom" in query
    bbox = f"{tiles[0].south},{tiles[0].west},{tiles[0].north},{tiles[0].east}"
    assert bbox in query


def test_collection_metadata() -> None:
    collection = build_collection("bos", [tile("a"), tile("b")], built_at="2026-10-01T01:00:00Z")
    assert collection["type"] == "FeatureCollection"
    meta = collection["metadata"]
    assert meta["city"] == "bos"
    assert meta["built_at"] == "2026-10-01T01:00:00Z"
    assert meta["source"] == "osm"
    # The newest OSM snapshot any tile was read from.
    assert meta["source_version"] == "2026-09-30T12:07:00Z"
    assert meta["attribution"] == ATTRIBUTION and "OpenStreetMap" in ATTRIBUTION
    assert meta["counts"]["features"] == len(collection["features"]) == 8
    assert meta["counts"]["by_kind"] == {
        "multi_storey": 1,
        "rooftop": 1,
        "surface": 4,
        "underground": 1,
        "unknown": 1,
    }
    assert meta["counts"]["by_entrance_source"] == {"none": 3, "osm": 3, "road_vertex": 2}
    assert all(f["properties"]["city"] == "bos" for f in collection["features"])


def test_tiles_are_cached_and_a_failed_tile_stops_the_build() -> None:
    bounds = (42.30, -71.10, 42.34, -71.05)
    tiles = plan_tiles(bounds)
    assert len(tiles) == 1
    calls: list[str] = []

    def fake_fetch(query: str) -> dict:
        calls.append(query)
        return tile("a")

    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp)
        first = fetch_tiles("bos", bounds=bounds, raw_dir=raw, fetch=fake_fetch, pause_s=0)
        assert len(calls) == 1 and len(first) == 1
        assert first[0]["osm3s"]["timestamp_osm_base"] == "2026-09-30T12:00:00Z"
        cached = list(raw.rglob("*.json"))
        assert len(cached) == 1

        # A second run reads the cache and asks Overpass nothing.
        second = fetch_tiles("bos", bounds=bounds, raw_dir=raw, fetch=fake_fetch, pause_s=0)
        assert len(calls) == 1 and second == first

        # --force asks again.
        fetch_tiles("bos", bounds=bounds, raw_dir=raw, fetch=fake_fetch, pause_s=0, force=True)
        assert len(calls) == 2

        # A cached file that isn't an Overpass answer is refetched, not trusted.
        cached[0].write_text('{"remark": "runtime error: Query timed out"}', encoding="utf-8")
        fetch_tiles("bos", bounds=bounds, raw_dir=raw, fetch=fake_fetch, pause_s=0)
        assert len(calls) == 3

        # A cached tile is only good for the box it was fetched for: after
        # the city's bounds (or the tile size) change, tile 0_0 is a
        # different piece of ground.
        moved = (42.31, -71.10, 42.34, -71.05)
        fetch_tiles("bos", bounds=moved, raw_dir=raw, fetch=fake_fetch, pause_s=0)
        assert len(calls) == 4

    def failing_fetch(query: str) -> dict:
        raise RuntimeError("overpass is down")

    with tempfile.TemporaryDirectory() as tmp:
        try:
            fetch_tiles("bos", bounds=bounds, raw_dir=Path(tmp), fetch=failing_fetch, pause_s=0)
        except RuntimeError as exc:
            assert "overpass is down" in str(exc)
        else:
            raise AssertionError("a failed tile must stop the build, not shrink it")
        assert list(Path(tmp).rglob("*.json")) == []

    # An answer Overpass cut short carries a remark; that is a failure too.
    def truncated_fetch(query: str) -> dict:
        answer = tile("a")
        answer["remark"] = "runtime error: Query run out of memory"
        return answer

    with tempfile.TemporaryDirectory() as tmp:
        try:
            fetch_tiles("bos", bounds=bounds, raw_dir=Path(tmp), fetch=truncated_fetch, pause_s=0)
        except RuntimeError as exc:
            assert "remark" in str(exc) or "memory" in str(exc)
        else:
            raise AssertionError("a cut-short answer must not be cached as a tile")
        assert list(Path(tmp).rglob("*.json")) == []


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for test in tests:
        test()
        print(f"  ok {test.__name__}")
    print(f"{len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
