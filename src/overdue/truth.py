"""Truth inference: turning a stream of promises into observed arrivals.

Transit feeds never say "the bus has arrived." The arrival must be
inferred from the promise stream itself, and the rule — with its
acceptance criteria and uncertainty — is the scientific heart of overdue:

**A (trip, stop) pair's arrival is the last predicted time it published,
accepted only when the evidence says the vehicle genuinely got there:**

1. the prediction was tracked to short range (final predicted horizon
   <= 150 s — the feed converged on an imminent arrival), and
2. the pair then disappeared from >= 2 consecutive snapshots (not a
   one-poll flicker), and
3. it did not vanish long before its own predicted time (which signals a
   cancellation or trip reassignment, not an arrival).

Every accepted arrival carries an **uncertainty**: the gap between the
last snapshot that saw the pair and the first that didn't. The grader
only trusts arrivals with uncertainty <= 120 s and reports how many were
discarded, so coverage is measured rather than assumed. Rules 1-3 and the
uncertainty budget are tested against synthetic trajectories in
``tests/test_truth.py``.

Along the way, each pair's promise trajectory is sampled at standard
horizons: "when the feed said H minutes, how long was the real wait?" —
the raw material of every calibration statistic downstream.
"""

from __future__ import annotations

from dataclasses import dataclass

CONFIRM_MISSES = 2  # consecutive absent snapshots to confirm disappearance
ACCEPT_HORIZON_S = 150  # last-seen predicted horizon must be at most this
LATE_VANISH_S = 180  # vanishing this long before its own prediction = cancelled
STALE_S = 20 * 60  # give up on pairs unseen for this long (coverage gap)
MAX_SAMPLES = 48  # cap stored trajectory changes per pair

HORIZONS_MIN = (1, 2, 3, 5, 8, 10, 15, 20, 30)
HORIZON_TOL_S = 45  # match a sample to a standard horizon within this


@dataclass
class Resolution:
    agency: str
    route: str
    stop: str
    trip: str
    truth: int  # inferred arrival unix time
    unc: int  # seconds between last-seen and first-missing snapshot
    waits: dict[str, float]  # promised horizon (min, str key) -> actual wait (min)

    def to_dict(self) -> dict:
        return {
            "agency": self.agency,
            "route": self.route,
            "stop": self.stop,
            "trip": self.trip,
            "truth": self.truth,
            "unc": self.unc,
            "waits": self.waits,
        }


def _sample_waits(samples: list[list[int]], truth: int) -> dict[str, float]:
    """For each standard horizon H: when the feed first promised ~H minutes,
    how many minutes did the rider actually wait?"""
    waits: dict[str, float] = {}
    for h in HORIZONS_MIN:
        target = h * 60
        best: tuple[int, int] | None = None
        for ts, arr in samples:
            gap = abs((arr - ts) - target)
            if gap <= HORIZON_TOL_S and (best is None or gap < best[0]):
                best = (gap, ts)
        if best is not None:
            waits[str(h)] = round((truth - best[1]) / 60.0, 3)
    return waits


class TruthEngine:
    """Streaming inference over successive snapshots. JSON-serializable
    state lets the engine survive across poll bursts and workflow runs."""

    def __init__(self, state: dict | None = None) -> None:
        self.pairs: dict[str, dict] = (state or {}).get("pairs", {})
        self.counters: dict[str, int] = (state or {}).get(
            "counters", {"resolved": 0, "rejected": 0, "stale": 0}
        )

    def state(self) -> dict:
        return {"pairs": self.pairs, "counters": self.counters}

    def update(self, agency: str, rows: list[dict], ts: int) -> list[Resolution]:
        """Feed one snapshot's promises; returns arrivals resolved by it."""
        seen: set[str] = set()
        for r in rows:
            key = f"{agency}|{r['trip']}|{r['stop']}"
            seen.add(key)
            pair = self.pairs.get(key)
            if pair is None:
                pair = {"r": r["route"], "s": [[ts, r["arr"]]], "ls": ts, "miss": 0}
                self.pairs[key] = pair
            else:
                pair["ls"] = ts
                pair["miss"] = 0
                pair.pop("fm", None)  # a flicker: forget the missed snapshot
                if pair["s"][-1][1] != r["arr"]:
                    pair["s"].append([ts, r["arr"]])
                    if len(pair["s"]) > MAX_SAMPLES:
                        # Keep the earliest sample (long horizons) + recent tail.
                        pair["s"] = pair["s"][:1] + pair["s"][-(MAX_SAMPLES - 1) :]

        resolved: list[Resolution] = []
        for key, pair in list(self.pairs.items()):
            if not key.startswith(agency + "|") or key in seen:
                continue
            pair["miss"] += 1
            if pair["miss"] == 1:
                pair["fm"] = ts  # first snapshot that failed to see the pair
            if pair["miss"] < CONFIRM_MISSES:
                continue
            del self.pairs[key]
            res = self._resolve(agency, key, pair, first_missing_ts=pair.get("fm", ts))
            if res is not None:
                resolved.append(res)
        return resolved

    def _resolve(
        self, agency: str, key: str, pair: dict, first_missing_ts: int
    ) -> Resolution | None:
        last_ts, last_arr = pair["ls"], pair["s"][-1][1]
        last_horizon = last_arr - last_ts
        vanished_early = last_arr - first_missing_ts > LATE_VANISH_S
        if last_horizon > ACCEPT_HORIZON_S or vanished_early:
            self.counters["rejected"] += 1
            return None
        self.counters["resolved"] += 1
        truth = last_arr
        _, trip, stop = key.split("|", 2)
        return Resolution(
            agency=agency,
            route=pair["r"],
            stop=stop,
            trip=trip,
            truth=truth,
            unc=max(0, first_missing_ts - last_ts),
            waits=_sample_waits(pair["s"], truth),
        )

    def flush_stale(self, now: int) -> int:
        """Drop pairs unseen for STALE_S (burst-boundary orphans)."""
        dropped = 0
        for key, pair in list(self.pairs.items()):
            if now - pair["ls"] > STALE_S:
                del self.pairs[key]
                self.counters["stale"] += 1
                dropped += 1
        return dropped
