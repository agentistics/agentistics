# F3.1 — Codex sessions through app-server

With `adapter-chat` enabled, a web-born Codex session uses the engine's ready
`codex-app-server` driver. The protocol supplies its conversation id, live text, completed
turns, reasoning, activity and approval/question cards. The rollout reader remains the history
and terminal-session fallback. The wire was checked against the installed codex-cli **0.161.0**
experimental TypeScript schema on 2026-10-09, including `thread/start.developerInstructions`,
`thread/resume.threadId`, `turn/start.effort` and `turn/interrupt.turnId`.

The driver uses the F2.0b host transport, ordered RPC ids and the pipe's clock. Re-attachment
replays recorded input/output and host calls; it does not start a second Codex process or deliver
old prompts or answers again. The engine's relay integration test covers idle turns, an open
permission, a question, queued text, interrupt and subsequent prompts.

The public integration makes these changes:

- Codex effort is passed as `-c model_reasoning_effort="<value>"` for the terminal fallback and
  as protocol fields for structured sessions. The installed server's model catalog declares
  `low`, `medium`, `high`, `xhigh`, `max` and `ultra`; only `low` has been used in real inference here.
- The legacy reliable paste method routes structured prompts through the driver. Prompting
  checks the protocol's open attention before delivery. Terminal delivery retains its old path.
- The injected MCP launch explicitly carries `AGENTISTICS_API` for this host's port, so an
  isolated test server's Codex child addresses that test server.
- Reopening keeps the prior model/effort. A protocol-stated Codex id can resolve immediately
  before the independent metrics/file cache includes its rollout. F2.0b controls whether the
  reopened row is structured or terminal-born.
- Free-text answers preserve their whitespace through the HTTP action and structured answer
  boundary. Empty answers are still refused. Questions without alternatives and non-enum MCP
  fields offer a text option to the existing approval card.

## Evidence and remaining acceptance

The engine has 26 passing structured tests, including recorded real 0.161.0 events and the
real detached relay with a schema-shaped fake peer. Its typecheck passed after the F2.0b merge.
The public commit's normal hooks passed typechecking and 6,538 tests (one skipped), including the
added whitespace and effort inheritance regression tests. Fake-protocol results establish behavior,
not a completed real-browser gate.

Real CLI smoke verified new-thread linking, streaming/final OK, same-id resume with previous turns
and interrupt. Real web API probes verified protocol-stated linking, adapter SSE user echo,
live/final OK, waiting/working and interrupt. The four production MCP configurations had matching
before/after fingerprints and their agentistics endpoints remained localhost:47291.
The final real web API probe also passed idle and mid-turn restarts, protocol interrupt,
kill/reopen to the same conversation id, history hydration, and another restart after reopen.
Content and turn counts were preserved. F2.0b timestamps can differ by milliseconds between
live and replay, and the host's transient `composer` flag disappears after restart.
Measured web spawn exceeded Q1's 2-second target (2.713 seconds in the final probe);
first live OK arrived 2.194 seconds after sending. These timings are recorded rather than
called a complete Q1 pass.

A real command approval also passed through the web API. Its three options retained their
protocol order; sending another prompt was refused while it was open; restarting the server
preserved the pending card. Option 2 sent the exact `acceptWithExecpolicyAmendment` object
once, as confirmed in the relay's delivered input. The engine includes the sanitized real
request/reply fixture. The isolated approval probe uses `on-request` with a read-only sandbox:
the runtime rejects `untrusted` even though 0.161.0's generated union still includes it.

Repeat probes from the engine worktree, outside the heavy-suite lock:

```sh
bun engine/scripts/codex-app-server-live.ts <evidence-directory>
bun engine/scripts/codex-web-live.ts <public-worktree> <evidence-directory>
```

They copy only Codex's `auth.json` into their own temporary HOME, reserve free ports, save their
process handles, and clean up their own children, relay records and temporary credentials.
`F3_CODEX_FORCE=1` is an explicit test-only admission override for one session; it is off by default.
The owner wrapper is `~/.agentistics/leader/qa/f3-1-codex-live.sh`.

Independent Q1–Q11/F1–F3 acceptance, real approval/question screenshots at 1280 and 390 px, and
the ten-session/two-tab load gate remain **uncertified**. The machine is under memory pressure;
the probes keep a single Codex session. Account switching, bang commands and mode cycling have
no implemented structured control in this driver. Question cards and permission choices are
covered by protocol tests and exec approval by the real web API; they must still be exercised
through the real browser for acceptance. File-change approval and interactive questions await
real-browser acceptance.

The engine implementation and version-specific protocol notes live in its own
`docs/f3-1-codex.md`. No engine-api shape change is needed.
