# ENGINE.MAP bench in CI (F0.4)

A mixed fleet of **fake** harnesses — `claude`, `codex`, `gemini`, `copilot`, `kimi`, `agy` (antigravity) —
on a **throwaway** `agentop server`, driven by simulated web clients. It measures what the web app, the
cockpit and the VS Code extension cost the server and how fast a prompt, an answer and a session switch
show up. Job: `engine-map-bench` in `.github/workflows/ci.yml` (push, PR and `workflow_dispatch`).

| file | what |
|---|---|
| `run.sh` | builds the throwaway environment, starts the server, runs the bench, checks the budgets, cleans up by PID |
| `bench.ts` | the bench (copy of the engine's, one patch — see its header) |
| `fake-harness`, `tmux-shim` | byte-identical copies of the engine's; the shim logs every tmux call the server makes |
| `budgets.ts`, `check.ts` | **pure** budget arithmetic + the CLI that prints the verdicts and the `::warning::` annotations |
| `SOURCE.json`, `sync.ts` | where the copies came from and the hashes that stop them drifting |

## Budgets: failures (F4.B)

`scripts/perf/budgets.json` → `engineMap` holds the 09 §8 ceilings, each with a `level`:
`warn` (annotation + job summary, job stays green) or `fail` (job fails). **Every budget is `fail` since F4.B.**
A value above `max` but within the **tolerance** (default 10 %, `tolerance` per budget; a shared 2-core runner is noisy) is
reported `near` — a warning annotation — and only a value above `max × (1 + tolerance)` fails the job. `budget.ts` (PERF.1) ignores that object. A budget the plan did not measure is reported
`not measured`, never `ok` — `quick` stops at N=10 and has no soak, so `tmuxPerMinN50` and `soakSlopeMBh`
stay un-measured until a `full` run (`workflow_dispatch`, `bench_plan=full`, `bench_soak_min=30`).

The aggregate p95s cannot see one harness never answering, so `check.ts` also lists, **per harness**, what
did not happen (not in the fleet, not linked to its conversation, never echoed, never shown).

## Safety (same rules as the engine's `run-bench.sh`)

Never ports 47291/47292 · refuses a port in use · `env -i` · synthetic `HOME` (nothing copied from or
linked to a real `~/.claude ~/.codex ~/.gemini ~/.copilot`) · own `TMUX_TMPDIR` · the four real harness
configs are checked before and after · the server is stopped only by the PIDs `run.sh` recorded, tmux only
by its own socket — no `pkill` by name.

On a developer machine it is a heavy job: ≥ 5 GB available, one at a time, a capped scope, and **the server
never inside `flock`**:

```
systemd-run --user --scope -p MemoryMax=3G -p CPUQuota=200% scripts/perf/engine-map/run.sh
```

## Keeping the copies in sync

The canonical bench is in the engine repo (branch `docs/engine-map`, `docs/engine-map/scripts/`).
`bun test scripts/perf/engine-map` pins our hashes; `ENGINE_REPO=~/agentistics-engine bun test
scripts/perf/engine-map/sync.test.ts` also re-reads the engine's side and says when it moved. To re-sync:
copy the engine file, re-apply the patch listed in `bench.ts`'s header, `bun scripts/perf/engine-map/sync.ts --write`.
