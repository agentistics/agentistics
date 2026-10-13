# Harness spawn availability

`GET /api/plan-limits` reports `spawnable` and an optional `unavailableReason` on
each budget, plus a `harnesses` map for harnesses without observed plan limits.
`agentistics_harnesses` attaches the same host availability to its usage rows.
Usage meters and totals remain visible when a harness is unavailable.

A harness is unavailable when its launcher binary cannot resolve on the user
PATH (including `~/.local/bin`), or its most recent checked fresh spawn exited
unsuccessfully during the startup window within the past 30 minutes. Startup
health is held in the spawning process's memory, without a new persistent store.
A later successful fresh spawn clears the failure; resume checks do not change it.
Older concurrent spawn checks cannot overwrite a newer fresh spawn's result.

Unavailable budgets have `freeSlots: 0` and `suggestedParallel: 0`. Routing
excludes them from both the selected harness and alternatives. If no harness
can start, the recommendation has no harness and requests zero workers.
Fresh managed server sessions use the existing five-second startup check, so
argument rejections that arrive after the shorter exec check are observed too.
