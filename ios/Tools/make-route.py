#!/usr/bin/env python3
"""Writes ios/Fixtures/drive-park-walk.gpx, the detector's test route.

    python3 ios/Tools/make-route.py

Boston's Boylston St, westbound, one fix a second (the timeline is short so
a UI test can walk it in real time):

  drive   20 s at 10 m/s
  light   30 s stopped at a red light, 350 m short of the spot
  drive   35 s at 10 m/s to the spot (a zone 456 block, Dartmouth-Clarendon)
  park    10 s still, car off
  walk   100 s at 3 m/s, 300 m further west
  stand   10 s
  walk   100 s back to the car
  stand   10 s

Standing still, a real GPS wanders by a fraction of a meter. The simulator
only delivers a fix when the location changes, so the still phases wobble
by 0.2 m: without it a red light would produce no fixes at all and never be
judged.

Used by DetectorUITests (fed to the simulator through XCUIDevice.location),
LocationReporterTests and SignalTraceTests (unit), and the server's
extendTick route test (the walk away and back, as /location fixes). The
<type> of each point names its phase, so tests can find the light, the
spot, and the far end of the walk without hardcoding indexes.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path

SPOT = (42.35038, -71.07630)          # zone 456 fixture (Boylston D-C)
# Boylston St's direction, per meter, pointing east (from Dartmouth
# toward Arlington): ~613 m spans +0.0019 lat, +0.0070 lng.
EAST = (0.0019 / 613, 0.0070 / 613)

def along(meters_east, north=0.0):
    return (SPOT[0] + EAST[0] * meters_east + north / 111_320, SPOT[1] + EAST[1] * meters_east)

STILL = {"light", "park", "far", "back"}

points = []  # (phase, meters_east)
pos = 350 + 200.0
for _ in range(20):             # drive toward the light
    points.append(("drive", pos)); pos -= 10
for _ in range(30):             # red light
    points.append(("light", pos))
for _ in range(35):             # drive to the spot
    points.append(("drive", pos)); pos -= 10
assert abs(pos) < 1e-6
for _ in range(10):             # parked, car off
    points.append(("park", 0.0))
for i in range(1, 101):         # walk 300 m west
    points.append(("walk_away", -3.0 * i))
for _ in range(10):
    points.append(("far", -300.0))
for i in range(1, 101):         # walk back
    points.append(("walk_back", -300.0 + 3.0 * i))
for _ in range(10):
    points.append(("back", 0.0))

start = datetime(2026, 9, 15, 14, 30, 0, tzinfo=timezone.utc)
lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="ios/Tools/make-route.py" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk><name>drive-park-walk</name><trkseg>',
]
for i, (phase, meters) in enumerate(points):
    wobble = (0.1 if i % 2 else -0.1) if phase in STILL else 0.0
    lat, lng = along(meters, wobble)
    t = (start + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines.append(f'    <trkpt lat="{lat:.6f}" lon="{lng:.6f}"><time>{t}</time><type>{phase}</type></trkpt>')
lines += ['  </trkseg></trk>', '</gpx>', '']
out = Path(__file__).resolve().parent.parent / "Fixtures" / "drive-park-walk.gpx"
out.write_text("\n".join(lines))
print(f"wrote {out} ({len(points)} points, {len(points)} s)")
