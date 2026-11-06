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

The host's `pipeline-entrega` proves a clean feature worktree and local HEAD equal to origin. `pipeline-pr` additionally proves an open PR on that HEAD and reports actual CI/mergeability (unknown stays unknown). Caller-supplied push/PR booleans do not satisfy either gate. These operations use Git and the authenticated `gh` CLI, with bounded probes and no Linux-specific process paths. Autonomous mode's environment-gate policy is supplied by `applyAutonomousFlows` in the separate autonomous-mode change.

`pipeline-autonomo` records the explicit lifecycle from demand through triage, spawn, execution, delivery, independent QA, leader review, PR, cleanup, handback, merge, release and post-release verification. Call it through `agentistics_flow_run`; MCP forwards the session proof and HTTP binds `actorId` to that verified caller. Each call supplies a stable `pipelineId`, unique `eventId`, `action` and the current `revision` (except `start`). Start also needs `subtaskId` and `criteria`; the leader must be filed on its task. Use the returned revision on the next call. Retries of an event are idempotent; stale revisions refuse.

The leader performs `start`, `triage`, `spawn` (record harness/model/worktree plan in `detail`), and `execute` (`authorId`). The spawned worker must already exist, be filed on the chosen subtask, have its own worktree including `origin/main`, and carry a known model. The author calls `deliver` with its report in `detail`. The leader assigns `qa` with `qaId` and throwaway instructions in `detail`; that worker must use another known model. The assigned QA worker calls `qa-pass` or `qa-fail` with evidence/findings in `detail`. FAIL returns to the author; after `maxRounds` failures (default 3, configurable 1–10), it blocks and alerts the leader. `block` records an actionable incident; `retry` requires the leader's recovery decision and starts a new retry budget.

After QA passes, the leader calls `review`, opens the PR using existing tools, and calls `cleanup`. That phase authorizes the existing `limpeza-real`/`ambiente-descer` tools; it does not itself delete anything. Pipeline-managed removal rechecks pushed HEAD, open PR, CI and mergeability immediately before the effect. `handback` requires a recorded `limpeza-real` removal at the delivered HEAD. The leader's `merge` transition admits one pipeline to the release queue, then existing PR/release tools perform the actual merge. `release` requires a merged PR and `runId`; `verify` proves `.github/workflows/release.yml` passed for its merge SHA; `await-owner` records post-release evidence and keeps the subtask in review. No transition marks it done.

Spawn planning, throwaway QA instructions, leader review, deletion review and post-release checks are recorded attestations by their responsible sessions. Git/PR/CI/release checks and cleanup completion are host/journal evidence. The flow coordinates those actors; it does not invent QA findings, open PRs, merge code or publish releases. Board status/comments and an empty `flows` SSE refresh accompany successful transitions. `pipelines.json` holds the durable journal and revision history. For memory admission, Linux uses MemAvailable and macOS uses the portable free-memory reading (a conservative lower bound).

Execution/delivery/QA/review transitions wake their next actor through the composer. QA assignment also registers the existing durable handback wait, with a 30-minute deadline for its leader. If a failed-QA author cannot be reached, the leader is notified to resume or `reassign` execution to another verified worker. Leader handoffs resolve to their current successor on the same task.
