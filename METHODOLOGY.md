# overdue: methodology

## What is being measured

A *promise* is one row of a GTFS-realtime TripUpdates feed: at time `t`,
the agency predicted trip `T` would arrive at stop `S` at time `a`. The
observatory measures whether promises come true, as a function of the
promised horizon: **when the feed said x minutes, how long was the real
wait?**

Graded panel: MBTA heavy rail + light rail (Red, Orange, Blue, Mattapan,
Green B/C/D/E); all of BART; Caltrain when a 511.org key is configured.
Buses are out of scope for v1 (feed volume, and GPS-vs-stop matching is
harder to make honest).

## Sampling

GitHub Actions runs a burst every 20 minutes: 12 snapshots, 60 s apart
(~60% temporal coverage). Promises are recorded change-only per
(trip, stop) pair; raw snapshots are working memory (Actions cache,
pruned after 2 days) — the permanent record is one compact JSON row per
resolved arrival, committed to git.

Coverage gaps (burst boundaries, cache eviction, feed outages) surface as
either wide-uncertainty arrivals or unresolved pairs; both are counted
and published rather than silently dropped.

## Truth inference

Feeds never announce arrivals; the arrival is inferred from the promise
stream. A (trip, stop) pair resolves to an arrival at its last published
prediction when all three hold:

1. **Converged**: final predicted horizon ≤ 150 s;
2. **Confirmed gone**: absent from ≥ 2 consecutive snapshots (a single
   miss is treated as feed flicker);
3. **Not cancelled**: it did not vanish > 180 s before its own predicted
   time (that pattern is a cancellation/reassignment, not an arrival).

Every arrival carries an **uncertainty**: the gap between the last
snapshot that saw the pair and the first that did not. Only arrivals with
uncertainty ≤ 120 s enter the statistics; the trusted share is published
as *coverage* per agency.

Known biases, stated plainly:

- The inferred arrival equals the feed's final short-range prediction, so
  a feed that is systematically wrong *in its final 60 seconds* passes
  undetected. The measurement grades medium-horizon promises against the
  feed's own short-horizon convergence — the quantity riders experience,
  but not an independent ground truth (that would need GPS/door sensors).
- Trips that disappear without converging (diversions, expressing,
  cancellations) are excluded from grading and counted as rejected;
  agencies are therefore graded on the promises they kept *tracking*.

## Outlier policy and sample floors

One policy, defined once (`grade.py`), applied by every published surface —
horizon curves, clock hours, almanac days, station records, promise cards,
and today's figures:

- A sample is **excluded** when the actual wait exceeds the promise by more
  than 20 minutes, beats it by more than 15, is negative, or exceeds 90
  minutes total. These are dominated by service-boundary artifacts
  (overnight predictions for next-morning trips being reassigned), with
  genuine major incidents mixed in; separating the two honestly requires
  schedule data the observatory doesn't yet consume, so both are excluded
  from aggregates and the exclusion **count is published** per agency.
- Surfaces publish nothing below a minimum sample: 25 per horizon cell,
  50 per clock hour, 25 per almanac day, 10 per station, 25 for today's
  figures. Thin cells return as the record accrues rather than showing
  noise.
- The ledger itself stays raw and append-only: it records everything;
  the grader judges under this policy. Every published build passes a
  **sanity contract** (`sanity.py`) asserting these bounds — an impossible
  number fails the observatory run instead of reaching the page.

## Grading

For each resolved arrival, the promise trajectory is sampled at standard
horizons (1, 2, 3, 5, 8, 10, 15, 20, 30 min, ±45 s): the actual wait from
the moment each promise was made. Published statistics per agency, route,
horizon, and UTC hour: mean actual wait, median absolute error, bias
(positive = riders wait longer than promised), share within ±1 minute,
counts, and coverage. Horizon cells with n < 5 are suppressed.

All code, tests (synthetic-trajectory truth tests included), and the
graded record are public in this repository; any number on the dashboard
can be recomputed from `data/graded/`.
