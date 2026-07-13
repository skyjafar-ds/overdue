"""Emit the JSON files the dashboard reads (site/data/)."""

from __future__ import annotations

import json
import time
from pathlib import Path

from .grade import grade
from .store import Store

WINDOW_DAYS = 30


def build_site_data(store: Store, site_dir: Path, meta: dict | None = None) -> dict:
    data_dir = Path(site_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    resolutions = store.read_graded_days(WINDOW_DAYS)
    summary = grade(resolutions)
    summary["window_days"] = WINDOW_DAYS
    (data_dir / "summary.json").write_text(json.dumps(summary, separators=(",", ":")))
    freshness = {
        "built": int(time.time()),
        "n_resolutions_window": len(resolutions),
        **(meta or {}),
    }
    (data_dir / "freshness.json").write_text(json.dumps(freshness, separators=(",", ":")))
    return summary
