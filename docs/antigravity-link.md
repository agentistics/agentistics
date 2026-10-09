# Antigravity conversation linking (agy 1.3.2)

Agentop supplies `--log-file <AGENTISTICS_DATA_DIR>/agy-logs/<managed-id>.log` for every managed
Antigravity spawn, including `--conversation <id>` reopens. The planner only adds the override for
Antigravity; the host creates the log directory before launching. The conversation id on a reopen
is still the id passed to `--conversation`.

The exclusive log is read from the managed id, without a process lookup or cwd/time guess. The
last `Created conversation <uuid>` or `Streaming conversation <uuid>` identifies the selected
conversation; a lookup alone is never evidence. A process-derived link is
followed when another creation appears; a resumed or explicitly assigned link stays fixed.
The log survives process exit, so a finished row can still be linked and reopened.

`HARNESS_PROCESS_TRANSCRIPTS.antigravity` remains `onlyRoute: true`. Its Linux fd route also
recognizes `antigravity-cli/conversations/<uuid>.db` and the DB's WAL/SHM files, or an open path
under `brain/<uuid>`. All open paths must name one UUID. Two different UUIDs refuse attribution.
Directories merely present on disk never participate; their ages and a shared cwd cannot establish
ownership. The old `cli-<timestamp>.log` reader, collision guard, and spawn-window recovery remain.

## Author probes

2026-10-09, agy 1.3.2, isolated HOME with only a copied agy OAuth credential (removed after each
probe), PTY, `MemoryMax=2G`, `CPUQuota=100%`, stopped by its saved PID/process group:

- Print mode: reply `OK`; exclusive log contained `Created conversation` at +2.734 s from its
  first log timestamp. Open conversation DB observed at +2.836 s from spawn; brain transcript at
  +3.239 s. The log and DB identify the same UUID.
- TUI with `--prompt-interactive`: reply `OK`; exclusive log contained `Created conversation`.
- Resume with `--conversation`: previous conversation retained and the follow-up replied `OK`.

Raw author evidence is in `/tmp/f0-1-agy-link/probe3` and `probe5` (logs, terminal output, fd/path
snapshots, transcript copies). Throwaway HOME directories and copied credentials are deleted.
These probes establish CLI behavior; they are not independent product QA or a fleet benchmark.

## Independent QA handoff

Use the engine map's `10-qa-scripts.md` and safety setup scripts on branch `docs/engine-map`.
A different model runs Q1 steps 1–4, Q4 (three Antigravity sessions in the SAME folder), and Q2.
Use a throwaway server/HOME/data dir, separate ports/socket, and saved-PID cleanup. Copy credentials
only for the run and remove them and the throwaway HOME immediately afterward. Honor the leader's
current resource limits; never touch the real server or harness configs.

Save evidence under `<QA-root>/evidence/f0-1/`: fleet rows at 0/5/30 s, timestamped SSE frames,
per-id log files, transcript stat/timestamps, screenshots at 1280/390 px, and benchmark per-harness
rows. For every session, `conversationId` must match its own log/DB/transcript within 5 s after
its first transcript line; the three same-folder chats must contain only their own distinct prompt.
Reopen must give a new managed id and log file while preserving the conversation and history.
Test `/new` or the supported conversation-creation action for relink; an ambiguous fd fixture must
remain unlinked. The Antigravity benchmark row must report `linked = yes` before calling F0.1 done.

Compatibility checks: Claude Code, Codex, Gemini, Copilot and Kimi keep their existing argv and
link rules (unit tests cover all of them). OpenCode's null spawn entry and the native provider path
are unchanged. Independent mixed-fleet QA must record each harness's result and any cited harness
limitation, as required by the engine parity matrix; do not infer real QA success from unit tests.
