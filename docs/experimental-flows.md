# Experimental flows

The official build exposes `agentop flow` and the flow MCP tools only with
`AGENTISTICS_FLOWS=1`. The community build refuses execution.

- `agentop flow ls` lists `worker-checar` and `limpeza`.
- `agentop flow run worker-checar --session <id> --cwd <repo> --handbackReceived true`
  checks waiting activity, a clean tree, origin's HEAD and handback evidence, then records a verdict.
  A check that lacks evidence stops with a refusal and its reasons.
- `agentop flow run limpeza --dry-run --cwd <repo>` lists worktrees with
  `wouldRemove: false`. `--dry-run 1` also works. This explicit preview skips session gates.
  Without `--dry-run`, `limpeza` runs the same evidence checks before listing.
  Neither path removes files, worktrees or sessions.
- `agentop flow status <runId>` reads a persisted run. Only lowercase UUID v4 IDs
  minted by the engine are accepted; HTTP and MCP reject invalid IDs before storage access.

Built-ins declare their inputs and pass `workflow.inputs` into every op using CEL.
Runs and step events live in `<dataDir>/flows/runs/<runId>.json`; verdicts append to
`<dataDir>/flows/verdicts.jsonl`. Startup marks unfinished runs interrupted only
when the experimental flag is enabled. Git probes disable optional locks and
fsmonitor, suppress credential prompts and time out after 15 seconds.

The engine vendors the MIT duckflux core at `duckflux.pin`, so the ordinary official
binary build needs only the public checkout and engine checkout.

### Intermediate handbacks and subject-filtered waits

`agentistics_session_message` accepts an optional `awaiting` (kind=handback only, one line, at most 200
characters): "I stopped on purpose, waiting for X". The `session.handback` event carries `awaiting` and the
message `text`; the engine records both and `fechar-entregue` refuses to close the worker ("worker awaiting: X")
while its newest handback has `awaiting`. A later handback without `awaiting` is final again.

A `agentistics_wait` handback condition takes an optional `match` (case-insensitive substring of the handback
text). Without it the wait fires on any handback from that session, as before.

Known experimental limits: waiting-poll history is process-local and its freshness
still needs refinement; handback evidence is supplied by the caller; cleanup only
previews. Independent QA and owner validation are required before release.

### Autonomous delivery and stalled workers

`sessao-parada` is enabled by default behind `AGENTISTICS_FLOWS=1`. The paired engine scans managed workers once a minute. After 30 minutes without observed activity, it sends a `block` message to the worker's current leader, including the last text, account-limit evidence, dirty-work state and recovery commands. It follows leader handoffs. Unknown observations do not prove inactivity; final handbacks suppress alerts, while intermediate handbacks are described. Episodes and delivery reservations survive restart; reminders are at least 30 minutes apart. Disable with `agentop flow disable sessao-parada`.

`retomar-sessao` sends a prompt through the existing composer path. The leader can also choose an account with `agentistics_session_switch_account` (`resendPending: true`), use `fechar-entregue` after delivery, or ask the author to commit WIP and push before closing. No alert bypasses an approval dialog or commits dirty work automatically. `AGENTISTICS_STALLED_AFTER_MS` configures the timer threshold; it must be a positive finite number. First observation starts the idle clock, so a new monitor needs a full observation window.

