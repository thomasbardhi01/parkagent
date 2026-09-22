"""Tests for import_parkboston_zones: the block-name parser and the segment
matcher, on synthetic fixtures — no network, no browser, no LLM.

Run:  uv run data/test_import_parkboston_zones.py
(plain asserts on purpose: data/ has no test-runner dependency; the file is
pytest-compatible if one ever lands.)
"""

from __future__ import annotations

from shapely.geometry import LineString

from import_parkboston_zones import (
    IntersectionIndex,
    build_segment,
    confidence_for,
    match_segment,
    parse_block_name,
    resolve_zone_claims,
    sides_agree,
    street_key,
)


def test_parse_block_name() -> None:
    parsed = parse_block_name("North Boylston between Dartmouth and Clarendon")
    assert parsed == {
        "side": "North",
        "street": "Boylston",
        "from_street": "Dartmouth",
        "to_street": "Clarendon",
    }
    # Case-insensitive side, multi-word streets, no side at all.
    assert parse_block_name("west Exeter between Newbury and Boylston")["side"] == "West"
    parsed = parse_block_name("Commonwealth between Massachusetts Ave and Charlesgate East")
    assert parsed["side"] is None
    assert parsed["street"] == "Commonwealth"
    assert parsed["to_street"] == "Charlesgate East"
    # A street whose NAME starts with a compass word still parses (the
    # importer retries with the side folded back in at match time).
    parsed = parse_block_name("East Berkeley between Washington and Harrison")
    assert parsed["side"] == "East"
    assert parsed["street"] == "Berkeley"
    # Not street blocks -> None (LLM fallback territory).
    assert parse_block_name("Government Center Garage") is None
    assert parse_block_name("Lot 4 - Fenway Special Event") is None


def test_street_key() -> None:
    assert street_key("BOYLSTON ST") == "BOYLSTON"
    assert street_key("Boylston") == "BOYLSTON"
    assert street_key("Boylston Street") == "BOYLSTON"
    assert street_key("Commonwealth Avenue") == "COMMONWEALTH"
    assert street_key("COMMONWEALTH AV") == "COMMONWEALTH"
    # Trailing block codes in our STREET values are cut with the suffix.
    assert street_key("NEWBURY ST B-C") == "NEWBURY"
    # A leading suffix word is part of the name, not a suffix.
    assert street_key("AVENUE DE LAFAYETTE") == "AV DE LAFAYETTE"
    assert street_key("D ST") == "D"
    # Feed shorthand and SAM direction abbreviations meet in the middle.
    assert street_key("Comm Ave") == "COMMONWEALTH"
    assert street_key("West Mass Ave") == "WEST MASSACHUSETTS"
    assert street_key("E BERKELEY ST") == "EAST BERKELEY"
    assert street_key("East Berkeley St") == "EAST BERKELEY"
    assert street_key("Lomasney Wy") == "LOMASNEY"
    assert street_key("LOMASNEY WAY") == "LOMASNEY"
    assert street_key("Cummington Mall") == "CUMMINGTON"


def test_sides_agree() -> None:
    east_west = LineString([(0, 0), (100, 0)])
    # Same letters always agree; opposite letters on a straight street never.
    assert sides_agree("North", "N", east_west)
    assert not sides_agree("North", "S", east_west)
    assert sides_agree("West", "w", LineString([(0, 0), (0, 100)]))
    # Either side missing -> no constraint (overlap + street pin the block;
    # a number conflict still surfaces as ambiguous).
    assert sides_agree(None, "N", east_west)
    assert sides_agree("North", None, east_west)
    assert sides_agree("North", "", east_west)
    # Diagonal street (NE-SW): its curbs face NW and SE, so the two
    # conventions can pick different axes for the SAME curb — "North" and
    # DIR 'W' are the NW curb; 'S' is the other one.
    diagonal = LineString([(0, 0), (100, 100)])
    assert sides_agree("North", "W", diagonal)
    assert sides_agree("East", "S", diagonal)
    assert not sides_agree("North", "S", diagonal)
    assert not sides_agree("North", "E", diagonal)
    # A letter parallel to the street names no curb — fail closed.
    assert not sides_agree("West", "N", east_west)


def test_resolve_zone_claims() -> None:
    def claim(number: str, overlap: float) -> dict:
        return {"number": number, "overlap": overlap, "confidence": 0.9}

    # One number: trivially wins, best overlap kept.
    assert resolve_zone_claims([claim("117", 0.6), claim("117", 1.0)])["overlap"] == 1.0
    # Corner bleed-over: a dominant claim beats a marginal rival.
    assert resolve_zone_claims([claim("117", 1.0), claim("118", 0.36)])["number"] == "117"
    # A genuine straddle (two strong claims) is ambiguous.
    assert resolve_zone_claims([claim("479", 1.0), claim("481", 0.77)]) is None
    # Two middling claims are ambiguous too.
    assert resolve_zone_claims([claim("747", 0.5), claim("989", 0.43)]) is None


def test_build_segment_is_the_raw_chord() -> None:
    # The segment is the street centerline's chord — deliberately never
    # offset (the side test uses the zone's meter line instead; see the
    # build_segment docstring for why centroids can't be trusted).
    plain = build_segment((0, 0), (100, 0))
    assert plain.length == 100
    assert plain.interpolate(0.5, normalized=True).y == 0


def _zone(zone_id: str, street: str, side: str | None, line: LineString) -> dict:
    return {
        "zone_id": zone_id,
        "street": street,
        "street_key": street_key(street),
        "side": side,
        "centerline_m": line,
        "centroid_m": line.centroid,
    }


def test_match_segment() -> None:
    # Our data: Boylston's north side split into two zones (we split at meter
    # gaps), the south side one zone, and a different street nearby. The
    # centerlines all sit within metres of the street centerline on purpose:
    # geometry can't tell curbs apart here, only the DIR letters can.
    zones = [
        _zone("bos-boylston-n1", "BOYLSTON ST", "N", LineString([(0, 2), (45, 2)])),
        _zone("bos-boylston-n2", "BOYLSTON ST", "N", LineString([(55, 2), (100, 2)])),
        _zone("bos-boylston-s", "BOYLSTON ST", "S", LineString([(0, -1), (100, -1)])),
        _zone("bos-newbury", "NEWBURY ST", "N", LineString([(0, 108), (100, 108)])),
    ]

    # "North Boylston between A and B": corners are street-centerline nodes.
    segment = build_segment((0, 0), (100, 0))
    matched = match_segment(segment, "North", street_key("Boylston"), zones)
    ids = sorted(m["zone"]["zone_id"] for m in matched)
    # Both north-side splits match; the south side and Newbury don't.
    assert ids == ["bos-boylston-n1", "bos-boylston-n2"], ids

    # The south side finds the south zone alone.
    matched = match_segment(segment, "South", "BOYLSTON", zones)
    assert [m["zone"]["zone_id"] for m in matched] == ["bos-boylston-s"]

    # No side named: everything on the block matches (both sides).
    matched = match_segment(segment, None, "BOYLSTON", zones)
    assert len(matched) == 3

    # A zone with no DIR letter is not excluded by a sided name.
    unsided = [_zone("bos-boylston-u", "BOYLSTON ST", None, LineString([(0, 1), (100, 1)]))]
    assert len(match_segment(segment, "North", "BOYLSTON", unsided)) == 1

    # A segment on a different block of the same street: no overlap, no match.
    far = build_segment((300, 0), (400, 0))
    assert match_segment(far, "North", "BOYLSTON", zones) == []

    # Wrong street key: never matches even with perfect overlap.
    assert match_segment(segment, "North", "NEWBURY", zones) == []


def _segment_feature(name: str, coords: list[tuple[float, float]]) -> dict:
    # Synthetic SAM-shaped feature: PRE_DIR/ST_NAME/ST_TYPE like the real
    # layer ("E BERKELEY ST" arrives split across the three fields).
    tokens = name.split()
    pre = tokens[0] if tokens[0] in ("E", "W", "N", "S") else None
    rest = tokens[1:] if pre else tokens
    return {
        "type": "Feature",
        "properties": {"PRE_DIR": pre, "ST_NAME": " ".join(rest[:-1]), "ST_TYPE": rest[-1]},
        "geometry": {"type": "LineString", "coordinates": [list(c) for c in coords]},
    }


def test_intersection_index() -> None:
    # A toy street grid, already metric (identity transform): Boylston runs
    # east-west; Dartmouth and Clarendon cross it; a same-named "Dartmouth"
    # exists absurdly far away (Boston reuses names across neighborhoods).
    collection = {
        "features": [
            _segment_feature("BOYLSTON ST", [(0, 0), (6000, 0)]),
            _segment_feature("DARTMOUTH ST", [(100, -50), (100, 150)]),
            _segment_feature("CLARENDON ST", [(200, -50), (200, 50)]),
            _segment_feature("DARTMOUTH ST", [(5000, -50), (5000, 50)]),
            _segment_feature("E BERKELEY ST", [(0, 100), (300, 100)]),
        ]
    }
    index = IntersectionIndex(collection, lambda x, y: (x, y))

    corners = index.corners("Boylston", "Dartmouth")
    assert len(corners) == 2  # both citywide Dartmouths cross it in the toy grid
    pair = index.corner_pair("Boylston", "Dartmouth", "Clarendon")
    assert pair is not None
    (ax, ay), (bx, by) = pair
    # The plausible-block-length rule picks the near Dartmouth, not x=5000.
    assert abs(ax - 100) < 2 and abs(ay) < 2
    assert abs(bx - 200) < 2 and abs(by) < 2
    # The feed's spelled-out direction finds SAM's abbreviated PRE_DIR.
    assert index.corners("East Berkeley", "Dartmouth")
    # Streets that never touch produce no pair.
    assert index.corner_pair("Boylston", "Dartmouth", "Nowhere") is None
    # The feed truncates names at ~45 chars ("Clarendo" for Clarendon): a
    # unique prefix still resolves; an ambiguous or tiny prefix does not.
    assert index.corners("Boylston", "Clarendo")
    assert not index.corners("Boylston", "Cl")
    assert index.corner_pair("Boylston", "Dartmouth", "Clarendo") is not None


def test_confidence() -> None:
    assert confidence_for("rule", "North", 1) == 0.9
    assert confidence_for("rule", None, 1) == 0.8
    assert confidence_for("rule", "North", 2) == 0.8
    assert confidence_for("llm", "North", 1) == 0.7
    assert confidence_for("llm", None, 3) == 0.5
    # Floor.
    assert confidence_for("llm", None, 2) >= 0.3


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for test in tests:
        test()
        print(f"  ok {test.__name__}")
    print(f"{len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
