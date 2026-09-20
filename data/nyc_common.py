"""Shared helpers for the NYC data scripts: .env loading and paths.

Kept dependency-free on purpose — `data/pyproject.toml` lists only geopandas,
requests and shapely, and a ~10-line .env reader is cheaper than another dep.
"""

from __future__ import annotations

import os
from pathlib import Path

# data/nyc_common.py -> data/ -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
OUT_DIR = REPO_ROOT / "data" / "out"

# Values shipped in .env.example that mean "not filled in yet".
_PLACEHOLDERS = {"", "replace_me"}


def load_root_env() -> None:
    """Load the repo-root .env into os.environ by explicit path.

    Same reasoning as `server/src/index.ts` and `prisma7.config.ts`: these
    scripts run as `uv run data/<script>.py` from the repo root, but the path is
    resolved from __file__ so the cwd does not matter. Real environment
    variables win over the file.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def socrata_app_token() -> str | None:
    """Return SOCRATA_APP_TOKEN, or None if unset or still the placeholder."""
    token = os.environ.get("SOCRATA_APP_TOKEN", "").strip()
    return None if token in _PLACEHOLDERS else token
