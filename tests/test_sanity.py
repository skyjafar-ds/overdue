"""The outlier policy and the sanity contract."""

import time

import pytest

from overdue.grade import MAX_EXCESS_MIN, clean_samples, grade, sample_ok
from overdue.sanity import SanityError, validate_site_data
from overdue.site import build_site_data
from overdue.store import Store


def _res(waits, unc=30, route="Red", truth=None):
    return {"agency": "mbta", "route": route, "stop": "s", "trip": "t",
            "truth": truth or int(time.time()), "unc": unc, "waits": waits}


def test_sample_policy():
    assert sample_ok(5, 6.0)                      # a normal miss
    assert sample_ok(10, 10 + MAX_EXCESS_MIN)     # at the ceiling
    assert not sample_ok(10, 10 + MAX_EXCESS_MIN + 0.1)  # boundary artifact
    assert not sample_ok(10, -0.5)                # negative wait: impossible
    assert not sample_ok(30, 5.0)                 # 25 min early: artifact
    kept, excluded = clean_samples([_res({"5": 6.0, "10": 49.4})])
    assert kept == [(5, 6.0)]
    assert excluded == 1


def test_grade_excludes_and_counts_outliers():
    rows = [_res({"5": 5.5}) for _ in range(30)] + [_res({"5": 49.0}) for _ in range(3)]
    block = grade(rows)["agencies"]["mbta"]
    assert block["excluded_outliers"] == 3
    by_h = {h["h"]: h for h in block["horizons"]}
    assert by_h[5]["n"] == 30  # the junk never reached the statistics
    assert by_h[5]["mean_wait"] == 5.5


def test_site_build_is_validated_end_to_end(tmp_path):
    store = Store(tmp_path / "data")
    ts = int(time.time())
    rows = [_res({"5": 5.4, "10": 11.0}) for _ in range(40)]
    rows += [_res({"10": 55.0}) for _ in range(5)]  # artifacts: excluded everywhere
    store.append_graded("mbta", rows, ts)
    summary = build_site_data(store, tmp_path / "site", meta={"last_burst": ts})
    b = summary["agencies"]["mbta"]
    assert b["excluded_outliers"] == 5
    import json
    days = json.loads((tmp_path / "site/data/days.json").read_text())
    assert days and all(d["worst_miss"] <= MAX_EXCESS_MIN for d in days)
    cards = json.loads((tmp_path / "site/data/promises.json").read_text())
    assert cards and all(abs(c["err_min"]) <= MAX_EXCESS_MIN for c in cards)
    fresh = json.loads((tmp_path / "site/data/freshness.json").read_text())
    assert fresh["today"]["worst_miss"] <= MAX_EXCESS_MIN


def test_contract_rejects_impossible_payloads():
    ok_summary = {"agencies": {}}
    validate_site_data(ok_summary, [], {}, [], {})
    with pytest.raises(SanityError, match="within_1min"):
        validate_site_data(
            {"agencies": {"mbta": {"within_1min": 1.4, "horizons": []}}}, [], {}, [], {}
        )
    with pytest.raises(SanityError, match="worst_miss"):
        validate_site_data(ok_summary, [{"day": "2026-07-14", "n": 100, "within_1min": 0.8,
                                         "broken": 0.1, "median_err": 0.5, "worst_miss": 49.4}],
                           {}, [], {})
    with pytest.raises(SanityError, match="verdict"):
        validate_site_data(ok_summary, [], {}, [{"promised_min": 5, "issued": 0,
                                                 "predicted": 300, "err_min": 5.0,
                                                 "verdict": "kept", "kept": True}], {})
    with pytest.raises(SanityError, match="below floor"):
        validate_site_data(ok_summary, [], {"mbta:x": {"n": 2, "within_1min": 0.9,
                                                       "median_err": 0.4}}, [], {})
