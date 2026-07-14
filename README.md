# overdue_

[![CI](https://github.com/skyjafar-ds/overdue/actions/workflows/ci.yml/badge.svg)](https://github.com/skyjafar-ds/overdue/actions/workflows/ci.yml)
[![Observe](https://github.com/skyjafar-ds/overdue/actions/workflows/observe.yml/badge.svg)](https://github.com/skyjafar-ds/overdue/actions/workflows/observe.yml)

**The public record of transit promises.**
Live dashboard: **https://skyjafar-ds.github.io/overdue/**

Every minute, transit agencies publish thousands of predictions — *"bus
arriving in 4 minutes."* The MBTA grades its own predictions
([their dashboard](https://www.mbta.com/performance-metrics/arrival-prediction-accuracy)),
with bins the agency chose; most agencies publish nothing at all. overdue
is the **independent audit**: an always-on observatory, unaffiliated with
any agency, that logs the promises, infers what actually happened with an
open tested method, and publishes full calibration curves — not just
binned accuracy — in an append-only public ledger anyone can recompute,
under one ruler across multiple agencies. (An earlier version of this
README claimed to be the first public accuracy record; the MBTA's
self-reported dashboard predates us, and this project keeps its own
promises too. Independence, finer methodology, and cross-agency
comparability are the actual contributions.)

Currently observing the **MBTA** (Boston subway + light rail) and **BART**
(SF Bay Area), with Caltrain support behind a free 511.org key.

## Two halves

**The observatory** (this repo's Python package + GitHub Actions):
every 20 minutes, a workflow polls the agencies' public GTFS-realtime
feeds in a 12-minute burst, streams promises through a truth-inference
engine, and commits one compact record per resolved arrival. Raw
snapshots are working memory (Actions cache, pruned after 2 days); the
graded record in [`data/graded/`](data/graded) is permanent and public.
Total infrastructure cost: **$0**.

**The dashboard** ([`docs/`](docs), served by GitHub Pages): a live
arrival board — station search, pinned favorites, official line colors,
countdowns ticking in real time, straight from the agencies' APIs in
your browser — sitting on top of the accumulating report card:
calibration curves ("when they say 10, you wait…"), bias by horizon,
coverage, all rebuilt after every observatory run.

## The hard part, honestly

Feeds never announce arrivals, so truth must be *inferred*: a prediction
tracked to short range (≤150 s) that then disappears from consecutive
snapshots resolves to an arrival; vanishing early is a cancellation, not
an arrival; every resolution carries an uncertainty, and only tight ones
(≤120 s) are graded, with the trusted share published as coverage. The
rules, their known biases, and what this measurement can and cannot claim
are written down in [METHODOLOGY.md](METHODOLOGY.md) and pinned by
synthetic-trajectory tests in [`tests/test_truth.py`](tests/test_truth.py).

In its very first 6-minute live burst, the pipeline logged **15,346 real
promises** and resolved **292 arrivals** across every MBTA rapid-transit
line and BART — including surviving a mid-burst timeout from both feeds.

## Run it yourself

```bash
git clone https://github.com/skyjafar-ds/overdue && cd overdue
python3 -m venv .venv && .venv/bin/pip install -e . --group dev
.venv/bin/pytest                     # truth-inference + pipeline tests
.venv/bin/overdue observe --snapshots 5 --interval 45   # a real 3-minute burst
open docs/index.html                 # the dashboard, now showing your data
```

Fork it, enable Actions and Pages (`main` branch, `/docs` folder), and you
have your own observatory for any GTFS-realtime agency — add one entry in
[`src/overdue/agencies.py`](src/overdue/agencies.py).

## Provenance

Part of a series exploring honest measurement:
[SixTwo](https://github.com/skyjafar-ds/sixtwo) (calibrated volleyball
prediction platform) → [rallycast](https://github.com/skyjafar-ds/rallycast)
(exact pricing library) → [RallyBench](https://github.com/skyjafar-ds/rallybench)
(oracle-graded LLM eval) → culpa (data-corruption localization) →
**overdue** (grading the graders, live).

## License

MIT. Not affiliated with the MBTA, BART, Caltrain, or 511.org; feed data
belongs to the respective agencies.
