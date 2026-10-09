# Clients on the adapter seam

All harnesses use the same client rules: Claude Code, Codex, Gemini, Copilot, Antigravity, Kimi,
OpenCode and native Agentistics. The adapter flag stays off by default.

The browser, VS Code extension host and terminal cockpit subscribe to `/api/fleet/events`.
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
