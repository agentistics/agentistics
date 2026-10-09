# Clients on the adapter seam

All harnesses use the same client rules: Claude Code, Codex, Gemini, Copilot, Antigravity, Kimi,
OpenCode and native Agentistics. The adapter flag stays off by default.

The browser, VS Code extension host and terminal cockpit subscribe to `/api/fleet/events?closed=0`.
The first frame carries active rows; history is paged when the consumer displays closed sessions.
`fleetStream.ts` applies the first snapshot and sequential deltas, keeping both row shapes,
server ordering and metadata deletion. Closed-count changes refresh paged history and prune deleted
rows; edits with an unchanged count remain the integration defect recorded below.
A sequence gap or invalid frame closes the stream. Silence
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

Normal commit hooks passed the incremental typecheck and the full suite: 15,398 tests passed,
12 skipped, no failures across 1,081 files. The pure HOME/TMPDIR lives under `/var/tmp` for this
run because the host has an unrelated `/tmp/.git`; the latter remains untouched. The engine binary,
web app and VS Code builds also passed.

Run heavy commands through the blocking shared lock, a systemd scope capped at 4 GB and 200% CPU,
and `NODE_OPTIONS=--max-old-space-size=3600`. Require 3 GB available before starting; the QA and
bench scripts stop their own processes if available memory falls below 2 GB or load rises above 8.

`bun packages/server/scripts/qa-clients-seam.ts` serves the built web app against SSE fixtures.
It checks all eight harnesses at 1280 and 390 pixels, using an actual `ses_` id and native message
protocol for Agentistics. The run on 2026-10-09 passed all 16 cases: partial text, completion,
no horizontal overflow, no terminal captures, and no fleet/data refetch in a healthy 31-second
window. Evidence: `.cache/f1-3-qa-YWEd1Y/results.json` and 32 screenshots. This is contract QA;
it does not substitute for real-session Q1 or mobile keyboard QA.

The compiled terminal cockpit also showed all eight harness rows, held one active fleet stream
after initial view configuration, and made no further fleet snapshot GETs in the healthy window.
Evidence: `.cache/f1-3-tui-qa/results.json`, `calls.json` and `terminal.txt`.

`ENGINE_MAP_SCRIPTS=<engine-map scripts directory> bun packages/server/scripts/bench-clients-seam.ts`
reuses `env-setup.sh` and `fake-harness` against `release/agentop`. It measures the shared fleet
consumer plus data patches, chat SSE and health checks, with 10 fake sessions and 0/1/5 clients.
The unchanged ENGINE.MAP bench models the former polling/terminal client; keep it for comparisons.
The canonical fake currently implements six CLI transcript formats (listed in its header), so
real OpenCode/native timing remains part of the independent eight-harness QA.

Measured on 2026-10-09 with engine slot and adapter flag on:

| Run | CPU, server + reaped children | Per-client traffic | Snapshot | Delta | Extra data GETs |
|---|---:|---:|---:|---:|---:|
| Idle control, C=0 before | 3.40% | — | — | — | — |
| Active snapshot, C=1 | 6.27% | 0.666 KB/min | 22,632 B | none while idle | 0 |
| Active snapshot, C=5 | 6.03% | 0.666 KB/min | 22,632 B | max 4,085 B during controlled activity | 0 |
| Idle control, C=0 after | 5.67% | — | — | — | — |

Evidence: `.cache/f1-3-bench-92RlPO/logs/clients.json`. This run waited for journal backfill,
primed the full dashboard, and used `/var/tmp` to avoid the unrelated `/tmp/.git`.
The controlled fake Claude update produced two applied data patches per client, no full data GET,
and 235.67 KB of activity traffic per client. Idle CPU/traffic samples exclude that activity phase.
The mean of the two control windows is 4.53%; incremental CPU is 1.73 percentage points for C=1
and 0.30 per client for C=5. The controls drift by 2.27 points, so stable attribution still needs work.
The automated CPU and delta checks fail; the snapshot and data-patch checks pass.
**09 section 8 is not yet passed.** Server delta sizing, CPU attribution and the broader memory soak
remain integration work.

Antigravity and Gemini chat streams used legacy sources. Antigravity's payload has a null link;
Gemini reports `unrecoverable/no-id-route`. These are unresolved linkage defects, not proof of
harness limitations: ENGINE.MAP 12 identifies the unused Gemini `--session-id` route (P-12) and
the broken Antigravity link (P-16). Kimi, Copilot and Codex reported adapter sources. Do not infer
real eight-harness adapter coverage from fixture tags; verify each source in independent Q1/Q11.

**Known integration defect:** a `closed=0` stream does not notify edits to previously paged closed
rows when the closed count stays unchanged. Count changes reload history; same-count edits still
need a server invalidation or a delta for those rows. A pure planner reproduction confirms this
for all eight harness tags in `.cache/f1-3-history-proof.json`. Resolve this before relying on
push for closed-history edits; it is a protocol gap, not a harness limitation.

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
Also edit a previously paged closed session from the other client and verify its new title arrives
without changing the closed count; the protocol gap above currently blocks this check.
