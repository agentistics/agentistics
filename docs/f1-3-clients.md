# Clients on the adapter seam

All harnesses use the same client rules: Claude Code, Codex, Gemini, Copilot, Antigravity, Kimi,
OpenCode and native Agentistics. The adapter flag stays off by default.

The browser, VS Code extension host and terminal cockpit subscribe to `/api/fleet/events?closed=0`.
The first frame carries active rows; history is paged when the consumer displays closed sessions.
`fleetStream.ts` applies the first snapshot and sequential deltas, keeping both row shapes,
server ordering and metadata deletion. A sequence gap or invalid frame closes the stream. Silence
for 45 seconds also closes it. Existing polling is the fallback while a stream is unhealthy;
a healthy stream suppresses periodic fleet GETs. Connections belong to mounted consumers and
are aborted on unmount, language/arrangement change or disposal.

An adapter chat never subscribes to terminal captures. `live` carries replacement structured text
and reasoning; `state` supplies working status. Completed turns retire partial text. Terminal tabs
keep their existing stream. Legacy chat keeps its existing behavior.

Local dashboard builds can carry `X-Agentistics-Data-Revision` with the adapter flag enabled.
`/api/events` sends `data-patch` with `{base, revision, set, remove, sessions?}` followed by a
`change` naming that revision. Sessions are upserted and removed by harness, machine, user and
session id; their order travels separately. Live process fields are preserved. Clients apply
only a patch whose base matches their last GET or patch; a mismatch, malformed patch, partial
baseline or missed connection falls back to a GET. The following matching change causes no GET.
A 15-second heartbeat allows healthy clients to suppress the dashboard interval too.

Central data retains its scoped GET path. The shared broadcast stream must not carry unscoped
team session bodies; extending patches to central deployments requires per-viewer subscriptions.

## Reproducible checks and measured limits

Run heavy commands through the blocking shared lock, a systemd scope capped at 4 GB and 200% CPU,
and `NODE_OPTIONS=--max-old-space-size=3600`. Require 3 GB available before starting; the QA and
bench scripts stop their own processes if available memory falls below 2 GB or load rises above 8.

`bun packages/server/scripts/qa-clients-seam.ts` serves the built web app against SSE fixtures.
It checks all eight harnesses at 1280 and 390 pixels, using an actual `ses_` id and native message
protocol for Agentistics. The run on 2026-10-09 passed all 16 cases: partial text, completion,
no horizontal overflow, no terminal captures, and no fleet/data refetch in a healthy 31-second
window. Evidence: `.cache/f1-3-qa-YWEd1Y/results.json` and 32 screenshots. This is contract QA;
it does not substitute for real-session Q1 or mobile keyboard QA.

`ENGINE_MAP_SCRIPTS=<engine-map scripts directory> bun packages/server/scripts/bench-clients-seam.ts`
reuses `env-setup.sh` and `fake-harness` against `release/agentop`. It measures the shared fleet
consumer plus data patches, chat SSE and health checks, with 10 fake sessions and 0/1/5 clients.
The unchanged ENGINE.MAP bench models the former polling/terminal client; keep it for comparisons.
The canonical fake currently implements six CLI transcript formats (listed in its header), so
real OpenCode/native timing remains part of the independent eight-harness QA.

Measured on 2026-10-09 with engine slot and adapter flag on:

| Run | CPU, server + reaped children | Per-client traffic | Snapshot | Delta | Extra data GETs |
|---|---:|---:|---:|---:|---:|
| Active snapshot, C=1 | 6.67% | 15.65 KB/min | 22,223 B | max 3,877 B | 0 |
| Active snapshot, C=5 | 7.53% | 0.666 KB/min | 22,361 B | none in window | 0 |

Evidence: `.cache/f1-3-bench-hGP81C/logs/clients.json`. Four of five observed chat streams were
adapter sources; one used the server's legacy fallback. Its harness/source needs independent
investigation rather than assuming equal adapter coverage from fixture tags.
The C=0 window overlapped the first journal import (24.07% CPU); it cannot establish a steady idle
baseline or prove the per-client CPU budget. The active first frame meets 50 KB, but observed deltas
exceed 2 KB. **09 section 8 is not yet passed.** Server delta sizing, stable CPU attribution,
the legacy fallback and the 30-minute memory soak remain integration work.
That recorded run used a partial dashboard baseline, so its zero extra GETs does not establish
data-patch correctness. The benchmark now requires the full dashboard revision and records patch
counts and the harness/id for every chat source; repeat it for dashboard performance evidence.

## Independent QA handoff

Run ENGINE.MAP Q1 and Q11 with another model, on real sessions of every harness. Use the pure
throwaway HOME, sanitized AGENTISTICS_DIR, own free ports and own TMUX_TMPDIR prescribed by
`docs/engine-map/scripts/env-setup.sh` in the engine-map worktree. Never use production ports,
config directories, tmux socket or services. Save PIDs and stop only those processes.

For each harness, at 1280 and 390 pixels: create a session, send once, watch the echo and completed
answer, and confirm state ends. Capture the row JSON, chat frames and screenshots. At 390 px,
assert `document.documentElement.scrollWidth <= window.innerWidth`, type in the composer, send,
and check the keyboard does not hide it. Adapter chats must have no `/api/fleet/stream` request.
Open the Terminal tab separately and confirm it still streams.

For Q11, use two browser tabs and ten real-or-fake sessions for ten minutes. Record per-client
KB/min, CPU, RSS, tmux calls/min and first-frame/delta bytes against ENGINE.MAP 09 section 8.
A healthy fleet subscription must not issue five-second `/api/fleet` GETs. A healthy dashboard
subscription must apply data-patch without `/api/data` refetch. Disconnect SSE, check fallback,
then reconnect and check snapshots replace stale state and polling stops again. Real-harness QA
and budget compliance are reported separately from fixture/browser contract checks.
