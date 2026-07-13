"""overdue: the public record of transit promises.

Logs real-time arrival predictions from public GTFS-realtime feeds,
infers actual arrivals from the promise stream (documented, tested,
uncertainty-aware), and publishes calibration report cards.
"""

from .agencies import AGENCIES, active_agencies
from .grade import grade
from .snapshot import Promise, parse_feed
from .store import Store
from .truth import Resolution, TruthEngine

__version__ = "0.1.0"

__all__ = [
    "AGENCIES",
    "Promise",
    "Resolution",
    "Store",
    "TruthEngine",
    "__version__",
    "active_agencies",
    "grade",
    "parse_feed",
]
