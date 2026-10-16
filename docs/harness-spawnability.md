# Harness spawn availability

`GET /api/plan-limits` reports `spawnable` and an optional `unavailableReason` on
each budget, plus a `harnesses` map for harnesses without observed plan limits.
`agentistics_harnesses` attaches the same host availability to its usage rows.
Usage meters and totals remain visible when a harness is unavailable.

A harness is unavailable when its launcher binary cannot resolve on the user
PATH (including `~/.local/bin`), or its most recent checked fresh spawn exited
unsuccessfully during the startup window within the past 30 minutes. Startup
health is held in the server's memory, without a new persistent store. CLI fresh
spawn checks report classified outcomes through the existing OS-account-authenticated
service socket; an unreachable service does not fail the CLI command.
A wholly unobservable capture check preserves the previous result.
A later observed successful fresh spawn clears the failure; resume checks do not change it.
Older concurrent spawn checks cannot overwrite a newer fresh spawn's result.

Unavailable budgets have `freeSlots: 0` and `suggestedParallel: 0`. Routing
excludes them from both the selected harness and alternatives. If no harness
can start, the recommendation has no harness and requests zero workers.
Fresh managed server sessions use the existing five-second startup check, so
argument rejections that arrive after the shorter exec check are observed too.

Both the direct development server and `agentop server` start the vault socket through
`server/server-bootstrap.ts`, independently of vault initialization or unlock. `fresh-spawn`
is a non-secret operation on that shared socket. Reports use integer millisecond
startup timestamps within five minutes of server time; invalid timestamps are rejected.
Ordering records expire after 30 minutes, so an expired observation cannot veto a new report.
