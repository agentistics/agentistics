# Server publication forecasts

`sessions/task-live.ts` owns the pure `resolvePieceForecast` projection. It composes stage
estimates when every remaining stage has at least three closed visits, otherwise it resolves
one whole-piece estimate. Open pieces always have an approximate interval. Terminal pieces
retain `none: final` for publication. Visibility and Calendar placement are separate consumers;
this calculation change does not broaden the existing Live visibility rules.

Publication samples use the first recorded execution/queue start (or measured session start)
and a real `publishedAt` from a published delivery record. A terminal session span without that
evidence is labeled `work-span`, uses general widening and low confidence, and never joins a
publication distribution. Blocked waits remain in wall-clock durations. Abandoned pieces,
status-only/recovered spans, invalid timestamps, duplicates and sampled parent/group rollups
are excluded with diagnostic counts. Multiple sessions produce one piece sample.

The bounded index keeps the newest 500 eligible pieces completed within 90 days. Publication
cohorts relax from type/harness/model to type/harness to harness. Each needs three samples.
Their median and p25/p75 interval are widened by at least 25% of the median and a 15-minute
half-width. The existing sample count/IQR rule gives confidence. General evidence uses its
arithmetic mean, at least half-to-double widening, and quarter-to-triple widening below eight
samples or for work spans. With fewer than three usable samples, the versioned bootstrap is
4 hours centered in a 1–12 hour range, low confidence, n=0. Bounds, source, endpoint, statistic,
confidence, exclusions, computation timestamp and method version accompany the estimate.

Elapsed wall time is subtracted once. Remaining lower bounds floor at 15 minutes; the upper
bound stays at least 15 minutes later. Past the original center the forecast marks overrun.
At the original upper bound it revises using general remaining durations, widening the upper
duration by `min(4, 1 + elapsed/originalUpper)`. Revisions use hourly boundaries measured from
the original upper-bound crossing, so polls within a bucket and restarts keep the same dates.
`forecast-anchors.json` caches only these anchors; the existing delivery tick atomically saves
them from the most recent Live projection. GET reads a shared cache and never writes the board
or the forecast file. Even before the next tick saves, the boundary is reproducible from the
real start and original upper duration. A changed source distribution may revise that duration.

Queued forecasts anchor at an active scheduled hold's `until`, bounded below by now; otherwise
they say `if-started-now` and `queueTimeUnknown`. Blocked forecasts carry their reason and
`conditional: blocked`, anchored after hypothetical resumption. They do not predict an unblock
date. The summary `eta` carries the same publication center/bounds when stages are preferred.

Per Live request, the existing source-version check adds one fixed activity-stamp `stat`.
Five-second result freshness and in-flight sharing remain in place. The history index is cached
by book, registry, delivery, proof and activity revisions, method version and hourly age bucket.
Cold builds scan existing loaded history while retaining at most 500 samples, then sort only
bounded cohort distributions and stage visits from that population. Warm projections perform
at most three indexed similar lookups plus general fallback per piece, and a fixed-size stage
walk. There are no forecasting network/model calls, transcript scans, per-card filesystem probes
or database queries. Anchor reads share one promise per process; background persistence skips
unchanged maps. The cache is regenerable and excluded from backup explicitly.

This slice was authored statically: tests, type checks, servers and benchmarks were not run.
The reviewer must run `task-live-forecast.test.ts`, the existing `task-live*.test.ts` suites,
backup coverage, and type checks inside `agentop run --rm`. Isolated baseline/change benchmarks
must report p50/p95 and sample count; the warm target is at most 10 ms additional CPU and 5%
of baseline Live p95. No performance measurement is claimed here. Independent UI, complete
open-piece projection, deadline handling and immutable dispatch snapshots belong to the next
integration slice.
