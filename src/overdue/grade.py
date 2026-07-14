"""Grading: resolved arrivals -> the public report card.

Only arrivals with uncertainty <= MAX_UNC_S enter the statistics; the
share that didn't is published as *coverage*, so precision is bought
openly rather than by silent filtering. All errors are in minutes, from
the rider's side: positive bias means you waited longer than promised.
"""

from __future__ import annotations

import time
from collections import defaultdict

import numpy as np

from .truth import HORIZONS_MIN

MAX_UNC_S = 120

# ---------------------------------------------------------------------------
# The single outlier policy and sample floors, applied by EVERY published
# surface (horizon curves, clock hours, almanac days, station records,
# promise cards, today's figures). The ledger itself stays raw and
# append-only — it records; this module judges. See METHODOLOGY.md.
# ---------------------------------------------------------------------------
MAX_EXCESS_MIN = 20.0  # waited > promise + 20 min: boundary artifact or major
MAX_EARLY_MIN = 15.0   # incident — excluded from aggregates, counted openly
MAX_WAIT_MIN = 90.0
MIN_N = {"horizon": 25, "hour": 50, "day": 25, "station": 10, "today": 25}


def sample_ok(h: int, wait: float) -> bool:
    return 0.0 <= wait <= MAX_WAIT_MIN and -MAX_EARLY_MIN <= wait - h <= MAX_EXCESS_MIN


def clean_samples(rows: list[dict]) -> tuple[list[tuple[int, float]], int]:
    """All (promised_min, actual_wait) samples passing the policy, + excluded count."""
    kept: list[tuple[int, float]] = []
    excluded = 0
    for r in rows:
        for hs, w in r["waits"].items():
            h, wait = int(hs), float(w)
            if sample_ok(h, wait):
                kept.append((h, wait))
            else:
                excluded += 1
    return kept, excluded


def _block(waits_by_h: dict[int, list[float]]) -> dict:
    """Per-horizon stats + overall summary for one slice of arrivals."""
    horizons = []
    all_errs: list[float] = []
    for h in HORIZONS_MIN:
        actual = waits_by_h.get(h, [])
        if len(actual) < MIN_N["horizon"]:
            continue
        arr = np.asarray(actual)
        errs = arr - h
        all_errs.extend(errs.tolist())
        horizons.append(
            {
                "h": h,
                "n": len(arr),
                "mean_wait": round(float(arr.mean()), 2),
                "median_err": round(float(np.median(np.abs(errs))), 2),
                "bias": round(float(errs.mean()), 2),
                "within_1min": round(float((np.abs(errs) <= 1.0).mean()), 3),
            }
        )
    out: dict = {"horizons": horizons}
    if all_errs:
        e = np.asarray(all_errs)
        out["median_abs_err"] = round(float(np.median(np.abs(e))), 2)
        out["bias"] = round(float(e.mean()), 2)
        out["within_1min"] = round(float((np.abs(e) <= 1.0).mean()), 3)
        out["n_promises"] = len(all_errs)
    return out


def grade(resolutions: list[dict]) -> dict:
    """Aggregate resolved arrivals into the site's summary structure."""
    by_agency: dict[str, list[dict]] = defaultdict(list)
    for r in resolutions:
        by_agency[r["agency"]].append(r)

    agencies: dict[str, dict] = {}
    for agency, rows in sorted(by_agency.items()):
        trusted = [r for r in rows if r["unc"] <= MAX_UNC_S]
        waits: dict[int, list[float]] = defaultdict(list)
        by_route: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
        by_hour: dict[int, list[float]] = defaultdict(list)
        excluded = 0
        for r in trusted:
            hour = time.gmtime(r["truth"]).tm_hour
            for h_str, wait in r["waits"].items():
                h = int(h_str)
                if not sample_ok(h, wait):
                    excluded += 1
                    continue
                waits[h].append(wait)
                by_route[r["route"]][h].append(wait)
                if h <= 10:  # hour-of-day view uses short-horizon promises
                    by_hour[hour].append(wait - h)
        block = _block(waits)
        block["n_arrivals"] = len(trusted)
        block["coverage"] = round(len(trusted) / len(rows), 3) if rows else None
        block["excluded_outliers"] = excluded
        block["routes"] = {
            route: _block(w) for route, w in sorted(by_route.items()) if any(w.values())
        }
        # Hour cells need a real sample: service-boundary artifacts (e.g.
        # overnight first-trip predictions being reassigned) show up as a
        # handful of absurd resolutions in hours with no actual service.
        block["by_hour_utc"] = [
            {
                "hour": hr,
                "median_err": round(float(np.median(np.abs(np.asarray(errs)))), 2),
                "bias": round(float(np.mean(errs)), 2),
                "n": len(errs),
            }
            for hr, errs in sorted(by_hour.items())
            if len(errs) >= MIN_N["hour"]
        ]
        agencies[agency] = block
    return {"generated": int(time.time()), "max_unc_s": MAX_UNC_S, "agencies": agencies}
