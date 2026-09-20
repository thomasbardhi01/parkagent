"""Fetch the two NYC Open Data parking-meter datasets as GeoJSON into data/raw/.

Datasets (found via the Socrata discovery API, search_context=data.cityofnewyork.us):

  e7yp-wx55  Parking Meters - ParkNYC Block Faces
             One MultiLineString per metered block face, carrying the ParkNYC
             zone number (`pay_by_cel`), max stay, hours and rate ladder for
             All Vehicles and for Commercial vehicles separately.

  f72k-2u3b  Parking Meters - Citywide Rate Zones
             MultiPolygon rate-zone boundaries ("Zone M1", "Zone 3", ...) with a
             human-readable rate string. Used by build_zones.py as the fallback
             rate source when a block face's own rate fields are "N/A".

Run:  uv run data/fetch_nyc.py [--force]

Output is written to data/raw/ (gitignored). Existing files are reused unless
--force is passed, so a rebuild does not re-download ~30 MB every time.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import requests

from nyc_common import RAW_DIR, load_root_env, socrata_app_token

DOMAIN = "https://data.cityofnewyork.us"

DATASETS = {
    "block_faces": {
        "id": "e7yp-wx55",
        "name": "Parking Meters - ParkNYC Block Faces",
    },
    "rate_zones": {
        "id": "f72k-2u3b",
        "name": "Parking Meters - Citywide Rate Zones",
    },
}

# Socrata caps a single page at 50k rows; 5k keeps each response small enough
# that a transient failure costs little to retry.
PAGE_SIZE = 5_000
MAX_RETRIES = 4
TIMEOUT_SECONDS = 120


def fetch_geojson(dataset_id: str, token: str | None) -> dict:
    """Page through a Socrata dataset's .geojson endpoint and merge the features.

    `$order=:id` pins a stable sort so that paging cannot skip or repeat rows.
    """
    headers = {"Accept": "application/json"}
    if token:
        headers["X-App-Token"] = token

    features: list[dict] = []
    offset = 0
    while True:
        params = {"$limit": PAGE_SIZE, "$offset": offset, "$order": ":id"}
        url = f"{DOMAIN}/resource/{dataset_id}.geojson"

        payload = None
        for attempt in range(MAX_RETRIES):
            try:
                response = requests.get(
                    url, params=params, headers=headers, timeout=TIMEOUT_SECONDS
                )
                response.raise_for_status()
                payload = response.json()
                break
            except requests.RequestException as exc:
                if attempt == MAX_RETRIES - 1:
                    raise
                backoff = 2**attempt
                print(
                    f"    request failed ({exc}); retrying in {backoff}s",
                    file=sys.stderr,
                )
                time.sleep(backoff)

        page = payload.get("features", [])
        features.extend(page)
        print(f"    +{len(page):>5} features (total {len(features)})")

        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-download even if the raw file already exists",
    )
    args = parser.parse_args()

    load_root_env()
    token = socrata_app_token()
    if token:
        print(f"Using SOCRATA_APP_TOKEN from .env ({len(token)} chars).")
    else:
        print(
            "WARNING: SOCRATA_APP_TOKEN is unset or still the .env.example "
            "placeholder.\n"
            "         Falling back to unauthenticated requests, which NYC Open "
            "Data throttles\n"
            "         aggressively and may reject under load. Register a token "
            "at\n"
            "         https://data.cityofnewyork.us/profile/edit/developer_"
            "settings\n"
            "         and set SOCRATA_APP_TOKEN in the repo-root .env.",
            file=sys.stderr,
        )

    RAW_DIR.mkdir(parents=True, exist_ok=True)

    for key, meta in DATASETS.items():
        destination = RAW_DIR / f"{key}.geojson"
        if destination.exists() and not args.force:
            print(f"{meta['name']}: {destination} exists, skipping (--force to refetch)")
            continue

        print(f"{meta['name']} ({meta['id']}):")
        collection = fetch_geojson(meta["id"], token)
        destination.write_text(json.dumps(collection), encoding="utf-8")
        size_mb = destination.stat().st_size / 1_048_576
        print(
            f"  wrote {len(collection['features'])} features -> "
            f"{destination.relative_to(RAW_DIR.parent.parent)} ({size_mb:.1f} MB)"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
