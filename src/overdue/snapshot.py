"""One snapshot: fetch a GTFS-realtime TripUpdates feed, normalize to rows.

A row is one *promise*: at time ``ts``, the agency predicted that trip
``trip`` would arrive at stop ``stop`` at time ``arr``. Rows are filtered
to the agency's graded panel and to a sane horizon window; everything else
in the feed is ignored (and that scope is documented, not hidden).
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass

import requests
from google.transit import gtfs_realtime_pb2

from .agencies import Agency

MAX_HORIZON_S = 45 * 60  # ignore promises further out than 45 minutes
MIN_HORIZON_S = -3 * 60  # keep slightly-past predictions (feeds lag)
TIMEOUT_S = 25


@dataclass(frozen=True)
class Promise:
    agency: str
    ts: int  # snapshot unix time
    trip: str
    route: str
    stop: str
    arr: int  # predicted arrival unix time

    def to_dict(self) -> dict:
        return asdict(self)


def fetch_snapshot(agency: Agency, session: requests.Session | None = None) -> list[Promise]:
    sess = session or requests
    resp = sess.get(agency.url(), timeout=TIMEOUT_S)
    resp.raise_for_status()
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(resp.content)
    return parse_feed(agency, feed, now=int(time.time()))


def fetch_vehicles(agency: Agency, session: requests.Session | None = None) -> list[dict]:
    """One snapshot of vehicle positions (powers the map's Replay archive)."""
    if agency.vehicles_url is None:
        return []
    sess = session or requests
    resp = sess.get(agency.vehicles_url, timeout=TIMEOUT_S)
    resp.raise_for_status()
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(resp.content)
    return parse_vehicles(agency, feed, now=int(time.time()))


def parse_vehicles(agency: Agency, feed, now: int) -> list[dict]:
    rows = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        v = entity.vehicle
        route = v.trip.route_id or "system"
        if agency.panel_routes is not None and route not in agency.panel_routes:
            continue
        if not v.HasField("position"):
            continue
        rows.append(
            {
                "ts": now,
                "id": v.vehicle.id or entity.id,
                "route": route,
                "lat": round(v.position.latitude, 5),
                "lon": round(v.position.longitude, 5),
            }
        )
    return rows


def parse_feed(agency: Agency, feed, now: int) -> list[Promise]:
    rows: list[Promise] = []
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        tu = entity.trip_update
        route = tu.trip.route_id or "system"  # BART leaves route_id empty
        if agency.panel_routes is not None and route not in agency.panel_routes:
            continue
        trip = tu.trip.trip_id or entity.id
        for stu in tu.stop_time_update:
            # Prefer arrival; fall back to departure (terminals often only
            # publish one of the two).
            t = 0
            if stu.HasField("arrival") and stu.arrival.time:
                t = stu.arrival.time
            elif stu.HasField("departure") and stu.departure.time:
                t = stu.departure.time
            if not t:
                continue
            horizon = t - now
            if MIN_HORIZON_S <= horizon <= MAX_HORIZON_S:
                rows.append(
                    Promise(
                        agency=agency.id,
                        ts=now,
                        trip=str(trip),
                        route=str(route),
                        stop=str(stu.stop_id),
                        arr=int(t),
                    )
                )
    return rows
