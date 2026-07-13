"""Truth inference against synthetic trajectories with known arrivals."""

from overdue.truth import ACCEPT_HORIZON_S, TruthEngine


def promises(trip, stop, route, ts, arr):
    return [{"trip": trip, "stop": stop, "route": route, "arr": arr}], ts


def run_snapshots(engine, agency, frames):
    """frames: list of (ts, rows). Returns all resolutions."""
    out = []
    for ts, rows in frames:
        out.extend(engine.update(agency, rows, ts))
    return out


def test_clean_arrival_is_resolved_with_truth_and_uncertainty():
    eng = TruthEngine()
    t0 = 1_000_000
    arr = t0 + 300  # promised 5 minutes out, holds steady, then vanishes
    frames = []
    for i in range(6):  # seen at t0, +60, ..., +300 (horizon shrinks to 0)
        frames.append((t0 + i * 60, [{"trip": "T1", "stop": "S1", "route": "Red", "arr": arr}]))
    frames.append((t0 + 360, []))  # missing once
    frames.append((t0 + 420, []))  # missing twice -> confirmed
    res = run_snapshots(eng, "mbta", frames)
    assert len(res) == 1
    r = res[0]
    assert r.truth == arr
    assert r.unc == 60  # gap between last-seen (t0+300) and first-missing (t0+360)
    assert r.waits["5"] == 5.0  # promised 5 at t0, actually arrived 5 later
    assert r.route == "Red" and r.stop == "S1"


def test_late_arrival_shows_up_in_waits():
    eng = TruthEngine()
    t0 = 1_000_000
    frames = []
    # Promise says 5 minutes at t0, but the arrival keeps slipping to t0+480,
    # and the feed tracks it all the way in before it vanishes.
    slips = [t0 + 300, t0 + 360, t0 + 420, t0 + 480, t0 + 480, t0 + 480, t0 + 480, t0 + 480]
    for i, arr in enumerate(slips):
        frames.append((t0 + i * 60, [{"trip": "T1", "stop": "S1", "route": "Red", "arr": arr}]))
    frames.append((t0 + 480 + 60, []))
    frames.append((t0 + 480 + 120, []))
    res = run_snapshots(eng, "mbta", frames)
    assert len(res) == 1
    assert res[0].truth == t0 + 480
    assert res[0].waits["5"] == 8.0  # said 5, meant 8


def test_cancelled_trip_is_rejected_not_graded():
    eng = TruthEngine()
    t0 = 1_000_000
    # Promise 20 minutes out vanishes immediately: reassignment/cancellation.
    frames = [
        (t0, [{"trip": "T2", "stop": "S1", "route": "Blue", "arr": t0 + 1200}]),
        (t0 + 60, []),
        (t0 + 120, []),
    ]
    res = run_snapshots(eng, "mbta", frames)
    assert res == []
    assert eng.counters["rejected"] == 1


def test_one_snapshot_flicker_does_not_resolve():
    eng = TruthEngine()
    t0 = 1_000_000
    arr = t0 + 120
    frames = [
        (t0, [{"trip": "T3", "stop": "S2", "route": "Red", "arr": arr}]),
        (t0 + 60, []),  # single miss (flicker)
        (t0 + 90, [{"trip": "T3", "stop": "S2", "route": "Red", "arr": arr}]),
    ]
    res = run_snapshots(eng, "mbta", frames)
    assert res == []
    assert "mbta|T3|S2" in eng.pairs  # still pending, flicker forgiven


def test_burst_gap_produces_wide_uncertainty():
    eng = TruthEngine()
    t0 = 1_000_000
    arr = t0 + 90
    frames = [
        (t0, [{"trip": "T4", "stop": "S3", "route": "Red", "arr": arr}]),
        # burst boundary: next snapshots come 10 minutes later
        (t0 + 600, []),
        (t0 + 660, []),
    ]
    res = run_snapshots(eng, "mbta", frames)
    assert len(res) == 1
    assert res[0].unc == 600  # grader will discard (> MAX_UNC_S) but count it


def test_state_round_trips_across_engine_restarts():
    eng = TruthEngine()
    t0 = 1_000_000
    arr = t0 + 180
    eng.update("mbta", [{"trip": "T5", "stop": "S4", "route": "Orange", "arr": arr}], t0)
    eng.update("mbta", [{"trip": "T5", "stop": "S4", "route": "Orange", "arr": arr}], t0 + 120)
    # Serialize (burst ends), restore (next burst), then the pair vanishes.
    eng2 = TruthEngine(eng.state())
    eng2.update("mbta", [], t0 + 180)
    res = eng2.update("mbta", [], t0 + 240)
    assert len(res) == 1
    assert res[0].truth == arr


def test_agencies_do_not_interfere():
    eng = TruthEngine()
    t0 = 1_000_000
    eng.update("mbta", [{"trip": "T", "stop": "S", "route": "Red", "arr": t0 + 60}], t0)
    # A BART snapshot must not count as "missing" for MBTA pairs.
    eng.update("bart", [{"trip": "B", "stop": "X", "route": "Yellow", "arr": t0 + 300}], t0)
    assert eng.pairs["mbta|T|S"]["miss"] == 0


def test_acceptance_horizon_boundary():
    eng = TruthEngine()
    t0 = 1_000_000
    arr = t0 + ACCEPT_HORIZON_S + 120  # last seen horizon just over the limit
    frames = [
        (t0, [{"trip": "T6", "stop": "S5", "route": "Red", "arr": arr}]),
        (t0 + 60, []),
        (t0 + 120, []),
    ]
    assert run_snapshots(eng, "mbta", frames) == []
