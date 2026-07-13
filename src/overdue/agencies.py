"""Agency registry: where each feed lives and which routes we grade.

The *panel* is the set of routes we log and grade. It is deliberately the
high-frequency core of each system (heavy rail + light rail): frequent
arrivals give the truth-inference engine dense evidence, and a bounded
panel keeps the public data small enough to live in a git repo forever.

Caltrain rides through 511.org, which requires a (free) API key; it
activates automatically when ``OVERDUE_511_KEY`` is set and stays dormant
otherwise, so the default deployment needs zero signups.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Agency:
    id: str
    name: str
    trip_updates_url: str
    panel_routes: frozenset[str] | None  # None = every route in the feed
    extra_params: dict = field(default_factory=dict)

    def enabled(self) -> bool:
        return "{key}" not in self.trip_updates_url or bool(os.environ.get("OVERDUE_511_KEY"))

    def url(self) -> str:
        return self.trip_updates_url.format(key=os.environ.get("OVERDUE_511_KEY", ""))


MBTA = Agency(
    id="mbta",
    name="MBTA (Boston)",
    trip_updates_url="https://cdn.mbta.com/realtime/TripUpdates.pb",
    panel_routes=frozenset(
        {"Red", "Orange", "Blue", "Mattapan", "Green-B", "Green-C", "Green-D", "Green-E"}
    ),
)

BART = Agency(
    id="bart",
    name="BART (SF Bay Area)",
    trip_updates_url="https://api.bart.gov/gtfsrt/tripupdate.aspx",
    panel_routes=None,  # BART's whole feed is heavy rail
)

CALTRAIN = Agency(
    id="caltrain",
    name="Caltrain (SF Peninsula)",
    trip_updates_url="https://api.511.org/transit/tripupdates?api_key={key}&agency=CT",
    panel_routes=None,
)

AGENCIES: dict[str, Agency] = {a.id: a for a in (MBTA, BART, CALTRAIN)}


def active_agencies() -> list[Agency]:
    return [a for a in AGENCIES.values() if a.enabled()]
