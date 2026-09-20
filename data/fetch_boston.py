"""Fetch the Analyze Boston parking-meter dataset as GeoJSON into data/raw/.

Dataset (found via the CKAN search API on data.boston.gov):

  parking-meters  "Parking Meters" — one Point per metered space (~7k), with
                  PAY_POLICY (enforced windows + max stay per window),
                  PARK_NO_PAY (the complementary free windows), STREET (block
                  segment, e.g. "NEWBURY ST B-C"), DIR (side of street), and
                  G_PASSPORT_ZONES — the ParkBoston (Passport-platform) zone
                  number, present on only a small minority of meters.

Analyze Boston publishes no ParkBoston zone-boundary layer (CKAN search for
parking/zone layers finds only this dataset and a 2015 transactions CSV), so
zone numbers can come only from the meters themselves; build_boston_zones.py
flags the zones whose number is unknown rather than guessing.

Run:  uv run data/fetch_boston.py [--force]

Output is written to data/raw/boston_meters.geojson (gitignored). The existing
file is reused unless --force is passed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import requests

from nyc_common import RAW_DIR, load_root_env

# CKAN resource id of the GeoJSON distribution of "Parking Meters".
DOMAIN = "https://data.boston.gov"
DATASET = {
    "name": "Parking Meters",
    "package": "parking-meters",
    "resource": "9314c461-69c3-452e-82dc-9da9dee486f8",
}
DOWNLOAD_URL = f"{DOMAIN}/dataset/{DATASET['package']}/resource/{DATASET['resource']}/download"

MAX_RETRIES = 4
TIMEOUT_SECONDS = 120


def fetch_with_retries(url: str) -> requests.Response:
    for attempt in range(MAX_RETRIES):
        try:
            # The download URL 302s to the stored file; requests follows it.
            response = requests.get(url, timeout=TIMEOUT_SECONDS, allow_redirects=True)
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            if attempt == MAX_RETRIES - 1:
                raise
            backoff = 2**attempt
            print(f"    request failed ({exc}); retrying in {backoff}s", file=sys.stderr)
            time.sleep(backoff)
    raise AssertionError("unreachable")


def resource_last_modified() -> str | None:
    """CKAN's last-modified stamp for the resource, for provenance."""
    try:
        response = fetch_with_retries(
            f"{DOMAIN}/api/3/action/resource_show?id={DATASET['resource']}"
        )
        result = response.json().get("result", {})
        return result.get("last_modified") or result.get("created")
    except requests.RequestException:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-download even if the raw file already exists",
    )
    args = parser.parse_args()

    load_root_env()  # not needed for CKAN (no token), kept for consistency
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    destination = RAW_DIR / "boston_meters.geojson"
    if destination.exists() and not args.force:
        print(f"{DATASET['name']}: {destination} exists, skipping (--force to refetch)")
        return 0

    print(f"{DATASET['name']} ({DATASET['resource']}):")
    collection = fetch_with_retries(DOWNLOAD_URL).json()
    features = collection.get("features", [])
    if not features:
        print("  no features in the download; refusing to overwrite.", file=sys.stderr)
        return 1

    # Stamp provenance onto the raw file so the builder can carry it forward.
    collection["metadata"] = {
        "source": f"{DOMAIN}/dataset/{DATASET['package']}",
        "resource_id": DATASET["resource"],
        "resource_last_modified": resource_last_modified(),
    }
    destination.write_text(json.dumps(collection), encoding="utf-8")
    size_mb = destination.stat().st_size / 1_048_576
    print(f"  wrote {len(features)} features -> {destination} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
