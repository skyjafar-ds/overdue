"""The sanity contract: invariants every published payload must satisfy.

Called by the site builder before anything is written. If a number is
impossible — a probability outside [0, 1], a worst miss beyond the outlier
policy's own ceiling, an hour that isn't an hour — the build fails loudly
instead of publishing quietly. A broken observatory run shows up red in
Actions; a nonsensical dashboard erodes the whole project's reason to
exist.
"""

from __future__ import annotations

from .grade import MAX_EARLY_MIN, MAX_EXCESS_MIN, MIN_N
from .truth import HORIZONS_MIN


class SanityError(ValueError):
    pass


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise SanityError(f"sanity contract violated: {msg}")


def _check_share(value, name: str) -> None:
    _check(value is None or 0.0 <= value <= 1.0, f"{name}={value!r} is not a share in [0,1]")


def _check_err(value, name: str) -> None:
    # Under the outlier policy no aggregated error statistic can leave
    # [-MAX_EARLY_MIN, MAX_EXCESS_MIN]; medians of |err| live in [0, ...].
    _check(
        value is None or -MAX_EARLY_MIN <= value <= MAX_EXCESS_MIN,
        f"{name}={value!r} escapes the outlier policy bounds",
    )


def validate_site_data(
    summary: dict, days: list[dict], stations: dict, promises: list[dict], freshness: dict
) -> None:
    for agency, b in (summary.get("agencies") or {}).items():
        _check_share(b.get("coverage"), f"{agency}.coverage")
        _check_share(b.get("within_1min"), f"{agency}.within_1min")
        _check_err(b.get("bias"), f"{agency}.bias")
        _check(
            b.get("median_abs_err") is None or 0 <= b["median_abs_err"] <= MAX_EXCESS_MIN,
            f"{agency}.median_abs_err={b.get('median_abs_err')!r}",
        )
        _check(b.get("excluded_outliers", 0) >= 0, f"{agency}.excluded_outliers negative")
        for h in b.get("horizons", []):
            _check(h["h"] in HORIZONS_MIN, f"{agency} horizon {h['h']} not standard")
            _check(h["n"] >= MIN_N["horizon"], f"{agency} horizon {h['h']} below floor")
            _check(
                0 <= h["mean_wait"] <= h["h"] + MAX_EXCESS_MIN,
                f"{agency} h={h['h']} mean_wait={h['mean_wait']} impossible",
            )
            _check_share(h.get("within_1min"), f"{agency} h={h['h']} within_1min")
        for hr in b.get("by_hour_utc", []):
            _check(0 <= hr["hour"] <= 23, f"{agency} hour={hr['hour']} not an hour")
            _check(hr["n"] >= MIN_N["hour"], f"{agency} hour {hr['hour']} below floor")
            _check(0 <= hr["median_err"] <= MAX_EXCESS_MIN, f"{agency} hour median impossible")
            _check_err(hr.get("bias"), f"{agency} hour {hr['hour']} bias")
        for route, rb in (b.get("routes") or {}).items():
            _check_err(rb.get("bias"), f"{agency}/{route}.bias")
            _check_share(rb.get("within_1min"), f"{agency}/{route}.within_1min")

    for d in days:
        _check(d["n"] >= MIN_N["day"], f"day {d['day']} below floor")
        _check_share(d["within_1min"], f"day {d['day']} within_1min")
        _check_share(d["broken"], f"day {d['day']} broken")
        _check(0 <= d["median_err"] <= MAX_EXCESS_MIN, f"day {d['day']} median impossible")
        _check(
            -MAX_EARLY_MIN <= d["worst_miss"] <= MAX_EXCESS_MIN,
            f"day {d['day']} worst_miss={d['worst_miss']} escapes policy",
        )
        _check(len(d["day"]) == 10 and d["day"][4] == "-", f"day key {d['day']!r} malformed")

    for key, s in stations.items():
        _check(s["n"] >= MIN_N["station"], f"station {key} below floor")
        _check_share(s["within_1min"], f"station {key} within_1min")
        _check(0 <= s["median_err"] <= MAX_EXCESS_MIN, f"station {key} median impossible")

    for c in promises:
        _check(c["promised_min"] in HORIZONS_MIN, f"promise card horizon {c['promised_min']}")
        _check(c["issued"] < c["predicted"], "promise card predicted before issued")
        _check(
            -MAX_EARLY_MIN <= c["err_min"] <= MAX_EXCESS_MIN,
            f"promise card err_min={c['err_min']} escapes policy",
        )
        expected = "kept" if abs(c["err_min"]) <= 1.0 else ("early" if c["err_min"] < 0 else "late")
        _check(c["verdict"] == expected, f"promise card verdict {c['verdict']} != {expected}")
        _check(c["kept"] == (c["verdict"] == "kept"), "promise card kept/verdict mismatch")

    t = freshness.get("today") or {}
    _check_share(t.get("kept_share"), "today.kept_share")
    if t.get("worst_miss") is not None:
        _check(t["n_promises"] >= MIN_N["today"], "today.worst_miss published below floor")
        _check(
            -MAX_EARLY_MIN <= t["worst_miss"] <= MAX_EXCESS_MIN,
            f"today.worst_miss={t['worst_miss']} escapes policy",
        )
