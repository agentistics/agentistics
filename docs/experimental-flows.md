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

Known experimental limits: waiting-poll history is process-local and its freshness
still needs refinement; handback evidence is supplied by the caller; cleanup only
previews. Independent QA and owner validation are required before release.
