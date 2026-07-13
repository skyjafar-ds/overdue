"""overdue CLI: observe (poll burst -> resolve -> grade -> site), prune."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import requests

from .agencies import active_agencies
from .site import build_site_data
from .snapshot import fetch_snapshot
from .store import Store
from .truth import TruthEngine


def observe(store: Store, site_dir: Path, snapshots: int, interval: int) -> dict:
    """One poll burst: N snapshots, `interval` seconds apart, per agency.

    Promises stream into the truth engine; resolved arrivals append to the
    permanent graded store; the site data is rebuilt at the end.
    """
    engine = TruthEngine(store.load_state())
    agencies = active_agencies()
    session = requests.Session()
    stats = {a.id: {"snapshots": 0, "promises": 0, "resolved": 0, "errors": 0} for a in agencies}

    for i in range(snapshots):
        t0 = time.time()
        for agency in agencies:
            try:
                rows = [p.to_dict() for p in fetch_snapshot(agency, session)]
            except Exception as e:  # noqa: BLE001 — a feed hiccup must not kill the burst
                print(f"  {agency.id}: fetch failed ({type(e).__name__}: {e})")
                stats[agency.id]["errors"] += 1
                continue
            ts = int(time.time())
            store.append_raw(agency.id, rows, ts)
            resolved = engine.update(agency.id, rows, ts)
            if resolved:
                store.append_graded(agency.id, [r.to_dict() for r in resolved], ts)
            s = stats[agency.id]
            s["snapshots"] += 1
            s["promises"] += len(rows)
            s["resolved"] += len(resolved)
        if i < snapshots - 1:
            time.sleep(max(0.0, interval - (time.time() - t0)))

    engine.flush_stale(int(time.time()))
    store.save_state(engine.state())
    meta = {
        "last_burst": int(time.time()),
        "burst_stats": stats,
        "engine_counters": engine.counters,
        "pending_pairs": len(engine.pairs),
        "agencies": [a.id for a in agencies],
    }
    build_site_data(store, site_dir, meta)
    print(json.dumps(meta, indent=1))
    return meta


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="overdue")
    p.add_argument("--data", default="data", help="store root (raw is gitignored)")
    p.add_argument("--site", default="docs", help="site directory (served by GitHub Pages)")
    sub = p.add_subparsers(dest="cmd", required=True)

    ob = sub.add_parser("observe", help="poll burst + resolve + grade + rebuild site data")
    ob.add_argument("--snapshots", type=int, default=10)
    ob.add_argument("--interval", type=int, default=60)

    sub.add_parser("build-site", help="rebuild site data from the graded store")
    sub.add_parser("prune", help="delete raw snapshots older than 2 days")

    args = p.parse_args(argv)
    store = Store(Path(args.data))
    if args.cmd == "observe":
        observe(store, Path(args.site), args.snapshots, args.interval)
    elif args.cmd == "build-site":
        build_site_data(store, Path(args.site), {"last_burst": None})
        print("site data rebuilt")
    elif args.cmd == "prune":
        removed = store.prune_raw()
        print(f"pruned raw days: {removed or 'none'}")


if __name__ == "__main__":
    main()
