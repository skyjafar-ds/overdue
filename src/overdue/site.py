"""Emit the JSON files the dashboard reads (site/data/).

- summary.json   — the report card (grades by agency/route/horizon/hour)
- days.json      — one reliability row per agency-day (calendar heatmap)
- stations.json  — per-stop history for the busiest stops (map panels)
- freshness.json — heartbeat, burst stats, engine counters
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from .grade import MAX_UNC_S, grade
from .store import Store, day_str

WINDOW_DAYS = 30
MAX_STATIONS = 400


def _errs(rows: list[dict]) -> np.ndarray:
    return np.asarray(
        [float(w) - int(h) for r in rows for h, w in r["waits"].items()], dtype=float
    )


def _days_json(trusted: list[dict]) -> list[dict]:
    by_day: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in trusted:
        by_day[(r["agency"], day_str(r["truth"]))].append(r)
    out = []
    for (agency, day), rows in sorted(by_day.items()):
        e = _errs(rows)
        if not len(e):
            continue
        routes = defaultdict(int)
        for r in rows:
            routes[r["route"]] += 1
        busiest = max(routes.items(), key=lambda kv: kv[1])[0]
        out.append(
            {
                "agency": agency,
                "day": day,
                "n": len(rows),
                "median_err": round(float(np.median(np.abs(e))), 2),
                "within_1min": round(float((np.abs(e) <= 1.0).mean()), 3),
                "broken": round(float((e > 1.0).mean()), 3),
                "worst_miss": round(float(e.max()), 1),
                "bias": round(float(e.mean()), 2),
                "busiest_route": busiest,
            }
        )
    return out


def _promise_cards(trusted: list[dict], n: int = 48) -> list[dict]:
    """The thesis, made tangible: recent promises as issued/predicted/reality.

    Timestamps are reconstructed exactly from the ledger: a promise sampled
    at horizon h with actual wait w was issued at truth - w*60 and
    predicted arrival at issue + h*60.
    """
    recent = [r for r in sorted(trusted, key=lambda x: -x["truth"]) if r["waits"]]
    # Prefer bold promises (>= 3 min); pad with short ones while the record
    # is young rather than publish an empty shelf.
    picked = [r for r in recent if max(int(k) for k in r["waits"]) >= 3][: n * 2]
    if len(picked) < n:
        picked += [r for r in recent if r not in picked][: n * 2 - len(picked)]
    cards = []
    for r in picked:
        h = max(int(k) for k in r["waits"])  # the boldest promise made
        wait = float(r["waits"][str(h)])
        issued = int(r["truth"] - wait * 60)
        err = wait - h
        # Early is its own kind of break: the rider wasn't on the platform yet.
        verdict = "kept" if abs(err) <= 1.0 else ("early" if err < 0 else "late")
        cards.append(
            {
                "agency": r["agency"],
                "route": r["route"],
                "stop": r["stop"],
                "issued": issued,
                "promised_min": h,
                "predicted": issued + h * 60,
                "actual": r["truth"],
                "err_min": round(err, 1),
                "kept": abs(err) <= 1.0,
                "verdict": verdict,
            }
        )
        if len(cards) >= n:
            break
    return cards


def _stations_json(trusted: list[dict]) -> dict:
    by_stop: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in trusted:
        by_stop[(r["agency"], r["stop"])].append(r)
    ranked = sorted(by_stop.items(), key=lambda kv: -len(kv[1]))[:MAX_STATIONS]
    out: dict[str, dict] = {}
    for (agency, stop), rows in ranked:
        e = _errs(rows)
        if not len(e):
            continue
        out[f"{agency}:{stop}"] = {
            "n": len(rows),
            "median_err": round(float(np.median(np.abs(e))), 2),
            "within_1min": round(float((np.abs(e) <= 1.0).mean()), 3),
            "bias": round(float(e.mean()), 2),
            "route": rows[0]["route"],
        }
    return out


REPLAY_BIN_S = 120
REPLAY_HOURS = 24


def _replay_json(store: Store, agency: str = "mbta") -> dict | None:
    traces = store.read_traces(agency, hours=REPLAY_HOURS)
    if len(traces) < 50:
        return None
    start = min(t["ts"] for t in traces)
    start -= start % REPLAY_BIN_S
    end = max(t["ts"] for t in traces)
    bins = (end - start) // REPLAY_BIN_S + 1
    vehicles: dict[str, dict] = {}
    for t in sorted(traces, key=lambda r: r["ts"]):
        v = vehicles.setdefault(t["id"], {"route": t["route"], "pts": []})
        b = (t["ts"] - start) // REPLAY_BIN_S
        if not v["pts"] or v["pts"][-1][0] != b:
            v["pts"].append([int(b), t["lat"], t["lon"]])
    vehicles = {k: v for k, v in vehicles.items() if len(v["pts"]) >= 2}
    return {
        "agency": agency,
        "start": int(start),
        "bin_s": REPLAY_BIN_S,
        "bins": int(bins),
        "vehicles": vehicles,
    }


def build_site_data(store: Store, site_dir: Path, meta: dict | None = None) -> dict:
    data_dir = Path(site_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    replay = _replay_json(store)
    if replay is not None:
        (data_dir / "replay.json").write_text(json.dumps(replay, separators=(",", ":")))
    resolutions = store.read_graded_days(WINDOW_DAYS)
    trusted = [r for r in resolutions if r["unc"] <= MAX_UNC_S]
    summary = grade(resolutions)
    summary["window_days"] = WINDOW_DAYS
    (data_dir / "summary.json").write_text(json.dumps(summary, separators=(",", ":")))
    (data_dir / "days.json").write_text(json.dumps(_days_json(trusted), separators=(",", ":")))
    (data_dir / "stations.json").write_text(
        json.dumps(_stations_json(trusted), separators=(",", ":"))
    )
    (data_dir / "promises.json").write_text(
        json.dumps(_promise_cards(trusted), separators=(",", ":"))
    )
    today = day_str()
    today_errs = _errs([r for r in trusted if day_str(r["truth"]) == today])
    freshness = {
        "built": int(time.time()),
        "n_resolutions_window": len(resolutions),
        "record_begins": min((day_str(r["truth"]) for r in resolutions), default=None),
        "today": {
            "n_promises": int(len(today_errs)),
            "worst_miss": round(float(today_errs.max()), 1) if len(today_errs) else None,
            "kept_share": round(float((np.abs(today_errs) <= 1.0).mean()), 3)
            if len(today_errs)
            else None,
        },
        **(meta or {}),
    }
    (data_dir / "freshness.json").write_text(json.dumps(freshness, separators=(",", ":")))
    return summary
