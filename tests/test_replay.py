"""Vehicle traces and the replay archive emitter."""

import json
import time

from google.transit import gtfs_realtime_pb2

from overdue.agencies import MBTA
from overdue.site import REPLAY_BIN_S, _replay_json, build_site_data
from overdue.snapshot import parse_vehicles
from overdue.store import Store


def make_vehicle_feed(entries):
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    for vid, route, lat, lon in entries:
        e = feed.entity.add()
        e.id = vid
        e.vehicle.vehicle.id = vid
        e.vehicle.trip.route_id = route
        e.vehicle.position.latitude = lat
        e.vehicle.position.longitude = lon
    return feed


def test_parse_vehicles_filters_panel():
    feed = make_vehicle_feed(
        [("v1", "Red", 42.35, -71.06), ("v2", "749", 42.33, -71.08),
         ("v3", "Green-E", 42.34, -71.10)]
    )
    rows = parse_vehicles(MBTA, feed, now=1_000_000)
    assert [r["id"] for r in rows] == ["v1", "v3"]
    assert rows[0] == {"ts": 1_000_000, "id": "v1", "route": "Red", "lat": 42.35, "lon": -71.06}


def test_replay_archive_bins_and_thins(tmp_path):
    store = Store(tmp_path / "data")
    now = int(time.time())
    # One vehicle moving, sampled more finely than the bin width.
    rows = []
    for i in range(30):
        rows.append({"ts": now - 3600 + i * 30, "id": "v1", "route": "Red",
                     "lat": 42.3 + i * 1e-4, "lon": -71.0})
    rows.append({"ts": now - 3600, "id": "lonely", "route": "Red", "lat": 42.0, "lon": -71.0})
    store.append_traces("mbta", rows, now)
    rp = _replay_json(store)
    assert rp is None  # 31 rows: below the 50-trace minimum

    store.append_traces("mbta", rows, now)  # 62 rows: past the floor
    rp = _replay_json(store)
    assert rp is not None
    assert rp["bin_s"] == REPLAY_BIN_S
    v1 = rp["vehicles"]["v1"]
    bins = [p[0] for p in v1["pts"]]
    assert bins == sorted(set(bins))  # one point per bin, ordered
    assert "lonely" not in rp["vehicles"]  # single-point vehicles dropped


def test_build_site_writes_replay(tmp_path):
    store = Store(tmp_path / "data")
    now = int(time.time())
    rows = [
        {"ts": now - i * 60, "id": f"v{j}", "route": "Red", "lat": 42.3 + j * 0.01, "lon": -71.0}
        for i in range(30)
        for j in range(4)
    ]
    store.append_traces("mbta", rows, now)
    site = tmp_path / "site"
    build_site_data(store, site, meta={})
    rp = json.loads((site / "data" / "replay.json").read_text())
    assert rp["agency"] == "mbta"
    assert len(rp["vehicles"]) == 4
