#!/usr/bin/env python3
"""Write the place-classifier traces in Traces/ (FR-53, #178).

    python3 ios/Fixtures/make-traces.py

These are SYNTHESIZED, not recorded: the simulator has no barometer and
never loses GPS, so a garage can't be driven there. Each trace is written
in the signal log's own v2 format from a scenario in
docs/research/3-park-now.md section 2 (an underground garage entered at a
crawl; a home driveway the driver has confirmed twice). Only input lines
are written (motion, fixes, audio, altitude); the replay makes every
decision. Each trace has a `<name>.truth.json` sidecar: what the place
really was, what the phone knew (saved places, footprints, zone data), and
what the classifier must answer. Replace them with phones' logs from the
field test (Diagnostics -> Export signal log) plus a sidecar each.

Also writes Traces/footprints.json, the outlines the sidecars name (a
stand-in for GET /garages/near until WS-2 #174 lands).
"""

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRACES = HERE / "Traces"

M_PER_DEG_LAT = 111_320.0


def offset(origin, n=0.0, e=0.0):
    """The point n meters north and e meters east of origin (lat, lng)."""
    lat, lng = origin
    return (
        lat + n / M_PER_DEG_LAT,
        lng + e / (M_PER_DEG_LAT * math.cos(math.radians(lat))),
    )


def box(center, w, h):
    """A closed rectangle w meters wide and h tall, as GeoJSON [lng, lat]."""
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]
    ring = []
    for sx, sy in corners:
        lat, lng = offset(center, n=sy * h / 2, e=sx * w / 2)
        ring.append([round(lng, 7), round(lat, 7)])
    return ring


def lnglat(point):
    lat, lng = point
    return [round(lng, 7), round(lat, 7)]


# Places. Invented outlines, well away from the simulator drive's spot
# (42.351466, -71.072303) so that trace sees none of them.
GARAGE_UNDERGROUND = (42.34700, -71.08200)  # center, 80 m x 60 m
GARAGE_ENTRANCE = offset(GARAGE_UNDERGROUND, n=30)  # middle of the north wall
GARAGE_MULTISTOREY = (42.34800, -71.08450)
LOT_PAID = (42.34640, -71.07900)
LOT_PRIVATE = (42.35500, -71.09000)
HOME = (42.36000, -71.09500)  # where the driver confirmed "Home" before
DRIVEWAY = offset(HOME, e=12)  # where the car actually stops tonight

FOOTPRINTS = [
    {
        "id": "fixture-garage-underground",
        "name": "Fixture Underground Garage",
        "kind": "underground",
        "fee": True,
        "access": None,
        "polygon": box(GARAGE_UNDERGROUND, 80, 60),
        "entrances": [lnglat(GARAGE_ENTRANCE)],
    },
    {
        "id": "fixture-garage-multistorey",
        "name": "Fixture Deck",
        "kind": "multi_storey",
        "fee": True,
        "access": None,
        "polygon": box(GARAGE_MULTISTOREY, 50, 50),
        "entrances": [lnglat(offset(GARAGE_MULTISTOREY, e=-25))],
    },
    {
        "id": "fixture-lot-paid",
        "name": "Fixture Paid Lot",
        "kind": "surface",
        "fee": True,
        "access": None,
        "polygon": box(LOT_PAID, 60, 40),
        "entrances": [],
    },
    {
        "id": "fixture-lot-private",
        "name": None,
        "kind": "surface",
        "fee": None,
        "access": "private",
        "polygon": box(LOT_PRIVATE, 30, 30),
        "entrances": [],
    },
]


class Log:
    """Lines in time order, however the scenario adds them (a stable sort,
    so lines at the same second keep the order they were added)."""

    def __init__(self, start, header):
        self.start = start
        self.header = ["# parkagent signal log v2"] + [f"# {line}" if line else "#" for line in header]
        self.lines = []

    def at(self, t):
        stamp = self.start + timedelta(seconds=t)
        return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}Z"

    def line(self, t, event, detail=""):
        self.lines.append((t, f"{self.at(t)} {event}" + (f" {detail}" if detail else "")))

    def motion(self, t, kinds):
        self.line(t, "motion", f"{kinds} high")

    def fix(self, t, point, accuracy, speed=None, rejected=None):
        text = f"{point[0]:.6f},{point[1]:.6f} ±{accuracy:.0f}m"
        if speed is not None:
            text += f" {speed:.1f}m/s"
        if rejected:
            self.line(t, "fix_rejected", f"{rejected} {text}")
        else:
            self.line(t, "location_fix", text)

    def altitude(self, t, climbed_m, base_kpa=101.3000, spike_kpa=0.0):
        """One barometer reading: CoreMotion's relative altitude follows the
        pressure, so a door's spike reads as a sudden drop too."""
        relative = climbed_m - spike_kpa / 0.012
        pressure = base_kpa - climbed_m * 0.012 + spike_kpa
        self.line(t, "altitude", f"{relative:.2f}m {pressure:.4f}kPa")

    def write(self, path):
        ordered = [text for _, text in sorted(self.lines, key=lambda entry: entry[0])]
        path.write_text("\n".join(self.header + ordered) + "\n")


def garage_underground():
    """Drive south at 10 m/s, crawl the last 120 m at 3 m/s through the
    entrance, lose GPS 8 m inside, circle down the ramps for half a
    minute, park, shut the door (a pressure spike), walk to the stairs and
    climb 7 m to the street, where GPS is good again (the driver, not the
    car)."""
    log = Log(
        datetime(2026, 9, 28, 14, 0, 0, tzinfo=timezone.utc),
        [
            "SYNTHESIZED by ios/Fixtures/make-traces.py, not recorded: an underground",
            "garage entered at a crawl, GPS lost 8 m inside the entrance, parked two",
            "levels down, the driver climbing 7 m to the street. See garage-underground.truth.json.",
        ],
    )
    log.line(0, "armed", "arm")
    log.line(0, "wake", "arm")
    log.line(0, "tracking_started", "arm")
    log.motion(0, "automotive")
    # 10 m/s from 700 m north of the entrance to 160 m north.
    for t in range(1, 56):
        if t % 20 == 0:
            log.motion(t, "automotive")
        log.fix(t, offset(GARAGE_ENTRANCE, n=700 - 10 * (t - 1)), 5, speed=10)
    # The crawl: 3 m/s for 40 s, ending 8 m inside the entrance.
    for k in range(0, 41):
        t = 56 + k
        if t % 20 == 0:
            log.motion(t, "automotive")
        accuracy = 9 if k == 40 else 6
        speed = 2.6 if k == 40 else 3.0
        log.fix(t, offset(GARAGE_ENTRANCE, n=112 - 3 * k), accuracy, speed=speed)
    # Down the ramp: accuracy blows up, then nothing at all.
    log.fix(97, offset(GARAGE_ENTRANCE, n=-15), 180)
    log.fix(98, offset(GARAGE_ENTRANCE, n=-20), 1414)
    log.motion(100, "automotive")
    log.motion(120, "automotive")
    # Parked two levels down.
    log.motion(131, "stationary")
    log.fix(135, offset(GARAGE_ENTRANCE, n=-40), 1414, rejected="coarse")
    log.line(139, "audio_disconnect", "bluetooth")
    log.fix(150, offset(GARAGE_ENTRANCE, n=-40), 1414, rejected="coarse")
    log.motion(165, "walking")
    # The barometer runs from the stop: level, the door's spike at 140 s,
    # then the stairs (7 m between 185 s and 215 s).
    for t in range(131, 231):
        if t < 185:
            climbed = 0.0
        elif t < 215:
            climbed = 7.0 * (t - 185) / 30
        else:
            climbed = 7.0
        log.altitude(t, climbed, spike_kpa=0.06 if t == 140 else 0.0)
    # Out on the street: the driver's fixes, not the car's.
    log.fix(228, offset(GARAGE_ENTRANCE, n=40), 8, speed=1.3)
    log.fix(230, offset(GARAGE_ENTRANCE, n=43), 7, speed=1.3)
    log.write(TRACES / "garage-underground.log")

    sidecar = {
        "trace": "garage-underground.log",
        "synthesized": True,
        "truth": {
            "place": "underground garage, two levels down",
            "class": "garage",
            "garageId": "fixture-garage-underground",
        },
        "context": {"footprints": "footprints.json", "memory": [], "zones": "unknown"},
        "expect": {
            "class": "garage",
            "minConfidence": 0.9,
            "footprintId": "fixture-garage-underground",
            "located": False,
            "gpsLoss": True,
            "baroDeltaM": 7.0,
            "never": ["street", "lot", "nopay"],
        },
    }
    (TRACES / "garage-underground.truth.json").write_text(json.dumps(sidecar, indent=2) + "\n")


def home_driveway():
    """Home at night: up the street at 9 m/s, slow into the driveway, stop,
    engine off, walk inside. The driver has confirmed "Home" (no payment)
    three times, 12 m from where the car stops tonight."""
    log = Log(
        datetime(2026, 9, 28, 22, 30, 0, tzinfo=timezone.utc),
        [
            "SYNTHESIZED by ios/Fixtures/make-traces.py, not recorded: a home driveway",
            "the driver has confirmed as Home three times. See home-driveway.truth.json.",
        ],
    )
    log.line(0, "wake", "significantChange")
    log.line(0, "tracking_started", "significantChange")
    log.motion(0, "automotive")
    # Up the street at 9 m/s.
    for t in range(1, 45):
        if t % 20 == 0:
            log.motion(t, "automotive")
        log.fix(t, offset(HOME, n=-400 + 9 * (t - 1)), 5, speed=9)
    # Slowing into the driveway, 12 m east of where "Home" was confirmed.
    for k in range(0, 9):
        log.fix(45 + k, offset(HOME, n=-12 + 1.5 * k, e=12 * k / 8), 5, speed=1.5)
    log.motion(54, "stationary")
    for t in range(54, 59):
        log.fix(t, DRIVEWAY, 5, speed=0)
    log.line(60, "audio_disconnect", "bluetooth")
    log.motion(72, "walking")
    log.fix(77, offset(HOME, n=4, e=4), 6, speed=1.2)
    log.write(TRACES / "home-driveway.log")

    sidecar = {
        "trace": "home-driveway.log",
        "synthesized": True,
        "truth": {"place": "home driveway", "class": "nopay"},
        "context": {
            "footprints": "footprints.json",
            "memory": [{"name": "Home", "class": "nopay", "lat": HOME[0], "lng": HOME[1], "visits": 3}],
            "zones": "unknown",
        },
        "expect": {
            "class": "nopay",
            "minConfidence": 0.95,
            "located": True,
            "memoryHit": True,
            "withoutMemory": "unknown",
            "never": ["garage", "lot"],
        },
    }
    (TRACES / "home-driveway.truth.json").write_text(json.dumps(sidecar, indent=2) + "\n")


def main():
    TRACES.mkdir(exist_ok=True)
    (TRACES / "footprints.json").write_text(json.dumps(FOOTPRINTS, indent=2) + "\n")
    garage_underground()
    home_driveway()


if __name__ == "__main__":
    main()
