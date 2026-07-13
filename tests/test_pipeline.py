"""Feed parsing, storage, grading, and the site builder — offline."""

import gzip
import json
import time

from google.transit import gtfs_realtime_pb2

from overdue.agencies import MBTA
from overdue.grade import MAX_UNC_S, grade
from overdue.site import build_site_data
from overdue.snapshot import parse_feed
from overdue.store import Store, append_jsonl_gz, read_jsonl_gz


def make_feed(entries):
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    for trip, route, stop, arr in entries:
        e = feed.entity.add()
        e.id = trip
        e.trip_update.trip.trip_id = trip
        e.trip_update.trip.route_id = route
        stu = e.trip_update.stop_time_update.add()
        stu.stop_id = stop
        stu.arrival.time = arr
    return feed


def test_parse_feed_filters_panel_and_horizon():
    now = 1_000_000
    feed = make_feed(
        [
            ("t1", "Red", "s1", now + 300),        # in panel, in window
            ("t2", "749", "s2", now + 300),        # bus route: not in MBTA panel
            ("t3", "Blue", "s3", now + 60 * 60),   # too far out
            ("t4", "Green-E", "s4", now - 60),     # slightly past: kept
        ]
    )
    rows = parse_feed(MBTA, feed, now=now)
    assert [(r.trip, r.route) for r in rows] == [("t1", "Red"), ("t4", "Green-E")]
    assert rows[0].to_dict()["agency"] == "mbta"


def test_gzip_multi_member_append_round_trip(tmp_path):
    path = tmp_path / "x.jsonl.gz"
    append_jsonl_gz(path, [{"a": 1}])
    append_jsonl_gz(path, [{"a": 2}, {"a": 3}])  # second gzip member
    assert read_jsonl_gz(path) == [{"a": 1}, {"a": 2}, {"a": 3}]
    with gzip.open(path, "rt") as f:  # stdlib reads concatenated members
        assert len(f.readlines()) == 3


def _resolution(agency="mbta", route="Red", unc=30, waits=None, truth=None):
    return {
        "agency": agency, "route": route, "stop": "s", "trip": "t",
        "truth": truth or int(time.time()), "unc": unc,
        "waits": waits or {"5": 6.0, "10": 11.5},
    }


def test_grade_bias_and_coverage():
    rows = [_resolution() for _ in range(20)] + [_resolution(unc=MAX_UNC_S + 1) for _ in range(5)]
    out = grade(rows)
    block = out["agencies"]["mbta"]
    assert block["n_arrivals"] == 20
    assert block["coverage"] == 0.8  # 20 of 25 trusted
    by_h = {h["h"]: h for h in block["horizons"]}
    assert by_h[5]["bias"] == 1.0     # promised 5, waited 6
    assert by_h[10]["bias"] == 1.5
    assert by_h[5]["within_1min"] == 1.0
    assert block["bias"] == 1.25


def test_grade_ignores_thin_horizons():
    rows = [_resolution(waits={"5": 5.0}) for _ in range(4)]  # below min n
    out = grade(rows)
    assert out["agencies"]["mbta"]["horizons"] == []


def test_store_and_site_build(tmp_path):
    store = Store(tmp_path / "data")
    ts = int(time.time())
    store.append_graded("mbta", [_resolution() for _ in range(6)], ts)
    site = tmp_path / "site"
    summary = build_site_data(store, site, meta={"last_burst": ts})
    assert summary["agencies"]["mbta"]["n_arrivals"] == 6
    fresh = json.loads((site / "data" / "freshness.json").read_text())
    assert fresh["last_burst"] == ts
    assert fresh["n_resolutions_window"] == 6


def test_prune_raw_keeps_recent_days(tmp_path):
    store = Store(tmp_path / "data")
    now = int(time.time())
    store.append_raw("mbta", [{"x": 1}], now)
    store.append_raw("mbta", [{"x": 1}], now - 5 * 86400)
    removed = store.prune_raw(keep_days=2)
    assert len(removed) == 1
    remaining = [d.name for d in store.raw_dir.iterdir()]
    assert len(remaining) == 1
