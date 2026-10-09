# F2.0 — One structured-session backend for every harness

ENGINE.MAP Phase 2/3 base piece. Every F2 (gemini, kimi, copilot) and F3 (codex, antigravity, Claude
Code) worker builds on this; nothing here names a harness first.

## The decision it encodes

- **Web-born sessions run STRUCTURED** (owner, ENGINE.MAP 11 Q1): a session started from the browser
  (`/api/fleet/new`, Nay), with the `adapter-chat` experimental flag ON and a READY driver for its
  harness, is started over the harness's official protocol — no TUI. **Terminal-born sessions stay a
  TUI in tmux.** "Open in terminal" on a structured session is a TUI resume of the SAME conversation id.
- **The official protocol is the PRIMARY source** (owner, 09/10) for every session agentistics starts:
  turns, in-flight text, state, permission requests, questions, the conversation id. Files and the
  screen are the fallback — history, and sessions started outside agentistics.
- **Equal depth for every harness.** Every capability is DECLARED per harness: a source (`via`), or a
  sentence citing why not (`absent`). The host never assumes.

## Where it lives

| Piece | Repo | File |
|---|---|---|
| The contract (1.10) | public | `packages/engine-api/src/structured.ts` |
| Routing (pure) + the answer rule | public | `packages/server/server/sessions/structured-route.ts` |
| The composite backend (over tmux) | public | `packages/server/server/sessions/structured-backend.ts` |
| A5.4's ACP opt-in (now a wrapper) | public | `packages/server/server/sessions/acp-backend.ts` |
| `acp` driver (gemini, kimi, copilot) | engine | `engine/src/structured/acp-structured.ts` |
| `claude-stream-json` driver (claude, F3.3) | engine | `engine/src/structured/claude-stream-json.ts` |
| F3 stubs + their TARGET declarations | engine | `engine/src/structured/stubs.ts` |
| `engine.structured` registry | engine | `engine/src/structured/engine-structured.ts` |

## The driver interface (engine-api 1.10)

```ts
type StructuredDriverId = 'acp' | 'claude-stream-json' | 'codex-app-server' | 'agy-stream-json'

interface StructuredDriver {
  id: StructuredDriverId
  status: 'ready' | 'stub'               // a stub refuses every start in a sentence → tmux
  harnesses: readonly HarnessId[]        // a harness is served by at most ONE driver
  declares(h): StructuredDeclaration     // total over `harnesses`
  start(req: StructuredSpawn): Promise<{ ok: true; session } | { ok: false; reason }>  // never throws
}

interface StructuredSpawn {
  id; harness; cwd
  model?; effort?
  conversationId?        // offered for ASSIGNMENT; applied only where `declares.assignId` has a `via`
  resumeId?              // resume this conversation
  initialPrompt?         // the person's words ALONE
  instructions?: { text; block }   // the opening context (QUAL.8) — see below
  mcp?: StructuredMcpServer[]      // the agentistics MCP, from `agentisticsMcpLaunch()`
  env?                              // the TUI plan's env (e.g. copilot's instructions dir)
}

interface StructuredSession {
  conversationId(): string | null  // in the form the harness's STORE keys on — the exact link
  activity(): 'starting' | 'working' | 'waiting' | 'waiting-approval' | 'exited'
  attention(): StructuredAttention | null   // { requestId, kind: permission|question, prompt?, options[{id,label,kind?,freeText?}], freeText? }
  screen(lines): string[]                   // the Terminal tab's view; never journaled
  prompt(text): boolean
  answer({ requestId?, choice?, text? }): boolean   // `answerFits` decides; a stale requestId is refused
  cancel(): void
  follow(max, on: (d: HarnessChatDelta) => void): () => void   // window → append/grow/live/state
  onExit(cb: (e: { kind: 'disposed' } | { kind: 'ended' } | { kind: 'failed'; reason }) => void)
  dispose(): void
}

interface StructuredDeclaration {
  assignId, resume, model, effort, mcp, live, permissions, questions, cancel: { via } | { absent }
  instructions: { channel: 'protocol' | 'flag'; via } | { channel: 'first-message'; reason }
}
```

`Engine.structured: EngineStructured` = `drivers()`, `driverFor(h)` (READY drivers only),
`declares(h)`, `start(req)`. Pure helpers: `structuredRegistry`, `stubDriver`, `answerFits`.
Engine-api moved to **1.10.0**; everything is optional, so a 1.9 engine still loads (the host adapts
its `Engine.acp` into a structured registry, `acpAsStructured`) and a 1.10 engine on a 1.9 host is
never asked. `engine.pin` keeps its `api` range.

### The opening context — `instructions` (QUAL.8)

The agentistics block injected at spawn goes through the harness's OFFICIAL channel first:

- `protocol` — a field of the protocol (codex app-server `thread/start { developerInstructions }`);
- `flag` — a launch flag / env the CLI reads in structured mode (claude `--append-system-prompt`,
  copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`);
- only where neither exists, `first-message` — the fenced `block` sent ahead of the first prompt (or
  alone), **with the reason cited**, and HIDDEN from the chat (the user turn carries the person's
  words only).

A resume never re-sends it. The host clears the TUI's `pendingContext` for a structured session so it
is never prepended twice.

## Routing (host)

`routeSpawn` (pure):

| Input | Route |
|---|---|
| flag ON + `origin: 'web'` + a READY driver | `structured` |
| `preferences.acpHarnesses` includes it + `Engine.acp` drives it (A5.4) | `acp-legacy` — exactly as before |
| anything else (flag OFF, terminal-born, stub, no driver) | `tmux` — the same request, byte for byte |

`origin: 'web'` is set by `fleet-web.ts` (`/api/fleet/new`, which Nay also goes through) on
`SpawnSessionRequest`; every other door leaves it absent. The spawn carries a
`BackendSpawn.structured: StructuredIntent` built by `structuredIntentOf` (tmux ignores it).

**Reopen.** A row hosted structurally is stamped `ManagedSession.structuredDriver`. A WEB reopen of
such a row runs structured again (`structuredReopenOrigin`); a terminal-born row reopened from the web
stays a TUI, and every non-web reopen (cockpit, `agentop session open`) is a TUI resume of the same
conversation id — "open in terminal".

**`StructuredSpawn.env` is never a secret**: the engine reads no environment of its own, so extra
variables reach the child through `env(1)` on its command line.

## Fallback

- **A refused start** (stub, login needed, `session/new` error, launch failure) → `base.spawn(req)`,
  the same request, the usual TUI.
- **A driver that fails mid-life** (`onExit({ kind: 'failed' })`) → the composite resumes the
  conversation in tmux under the SAME managed id (`provider.resumeSpawn` = `planSpawn({ resumeId })`)
  and logs it; a kill (`disposed`) or an ordinary end never triggers it. A harness with no id-taking
  resume cannot fall back this way, and says so in the log.

## Surviving a server restart, and "open in terminal" (F2.0b)

**A structured session survives `agentop server` restarting, like every tmux session does.** The child
is never the server's own: the driver starts it through `StructuredSpawn.transport` (engine-api 1.10,
optional), which the host implements with a detached RELAY (`structured-relay.ts`, `agentop
__structured-relay <dir>` / `bun run` in a checkout). The relay owns the child's stdio and records both
directions in `<data dir>/structured/<managed id>/` (0700; `out.jsonl` every stdout line, `in.jsonl`
every delivered write); the server talks to it over a unix socket. Under the unit's `KillMode=process`
the relay outlives the server exactly as the tmux server does.

- **Record.** Every call the host makes on the session (prompt / answer / cancel) is appended to
  `calls.jsonl` with the number of lines the driver had read when it was made (`recordingSession`).
  Lines are handed to the driver ONE PER MACROTASK, live and in replay alike — that is what makes a call
  land between the same two lines in both.
- **Re-attach** (`agentop server` boot → `reattachStructuredSessions`; `list()` waits for it, so no
  poll reads `lost`): a fresh driver is started for the SAME saved request over a REPLAY pipe — the
  recorded lines and calls in order, every write CHECKED against `in.jsonl` (`structured-replay.ts`),
  then live from where the record ends (output the child wrote while nobody listened is in the file).
  No event is lost and none is repeated: the session is registered only once the replay is done, so
  the replay emits to nobody. Turns keep their original times (`StructuredPipe.now`). A replay that
  diverges (a non-deterministic driver, a tampered record) ends the child and falls back to the
  conversation-id resume in tmux, as a failed driver always did.
- **Any other process** (the cockpit, a one-shot `agentop session …`) lists a relayed row as running
  and never connects to it (one client per relay; a newer one replaces the older).
- **Driver rule (every driver, the F3 ones included):** start the child through `req.transport` when
  given, stamp turns with `pipe.now()`, and be deterministic over the pipe (ids in order, no timer or
  randomness in what it writes). `acp-structured.ts` is the worked example; `stubs.ts` states it.

**"Open in terminal"** on a LIVE structured session = fleet action `terminal`, `GET /api/fleet/attach`,
the cockpit's attach and `agentop session attach` (`backend.toTerminal`): the child is ended FIRST
(marked `ending`, so its exit is never read as a failure to fall back from — from any process), then
the same conversation resumes as a TUI under the SAME managed id (`resumeSpawn`). `structuredDriver`
stays on the row, so the next web reopen runs structured again. A harness with no id-taking TUI resume
(gemini: `-r` takes "latest" or an index) is refused in words and left running.

Verified 2026-10-09 on a throwaway server (own HOME/data/tmux, free ports) with the real engine `acp`
driver: a gemini session re-attached after two restarts (SIGTERM to the server's PID) with its prompts
replayed exactly once and the next prompt delivered once; a kimi session opened in a terminal as
`kimi -S session_…` under the same id. Mid-turn restart is covered by the fake-driver tests (real
processes: relay + fake protocol peer), as the throwaway harnesses had no usable quota/login.

## What the host reads from a structured session

| Host need | Verb | Source |
|---|---|---|
| Row state | `activityOf` | `session.activity()` (the poller trusts a stated activity) |
| Dialog options on the row | `dialogOf` | `attention().options[].label` |
| Answer a card | `attentionOf` + `answer` (via `answerSession`) | the driver — no screen read, no keystroke |
| Free text option | `sendChoiceText` → `answer({ choice, text })` | the driver |
| Chat (turns, live text, state) | `chatOf(id)` → `adapter-chat-web.ts` | `session.follow()` — served before any file reader |
| Conversation link | `onConversation` → registry `conversationLinkVia: 'protocol-stated'` | `session.conversationId()` |
| Terminal tab | `captureTerminal` | `session.screen()` |
| Prompt / cancel / kill | `sendText` / `sendKey('Escape')` / `kill` | `prompt` / `cancel` / `dispose` |

## Per-harness checklist — each F2/F3 worker fills its row

Legend: **D** declared in code · **V** verified on a real session (date + CLI version) · **—** declared absent (cited).
"TARGET" means the stub's declaration is the goal, not a fact.

| Harness | Driver | Worker | status | assignId | resume | model | effort | MCP | instructions | live | permissions | questions | cancel | storeIdOf | Q1–Q11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Gemini | `acp` | F2.1 | ready | — (verify `--session-id` under `--acp`) | D `session/load` | D `-m` | — | D `mcpServers` | first-message (ACP v1 has no field; gemini has no flag) | D chunks | D `request_permission` | — | D `session/cancel` | **map ACP id → synthetic `${dir}/${file}`** | |
| Kimi | `acp` | F2.2 | ready | — | D `session/load` | — (verify a flag) | — | D | first-message (verify `--agent-file` under `kimi acp`) | D | D | — | D | verify `session_<uuid>` | |
| Copilot | `acp` | F2.3 | ready (re-verify `--acp` on 1.0.93) | — (verify `--session-id`) | D | D `--model` | — | D | flag: env `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (verify) | D | D | — | D | verify | |
| Codex | `codex-app-server` | F3.1 | **stub** | — (server mints the thread id) | TARGET `thread/resume` | TARGET | TARGET | TARGET `-c mcp_servers` | TARGET protocol `developerInstructions` | TARGET item deltas | TARGET approvals | TARGET | TARGET `turn/interrupt` | thread id = rollout id? | |
| Antigravity | `agy-stream-json` | F3.2 | **stub** | — (agy mints it) | TARGET `--conversation` | TARGET | TARGET `xhigh/max` | TARGET (P-20) | TARGET first-message unless a field exists | TARGET | TARGET | TARGET | TARGET | from the stream | |
| Claude Code | `claude-stream-json` | F3.3 | **ready** | V `--session-id` (stated back as `system/init` `session_id`) | V `--resume` (same id; no stdout replay → window = transcript tail, bounded) | V `--model` | D `--effort` (`--help`) | V `--mcp-config` (replaces the user-scope `agentistics`; `AGENTOP_MANAGED_ID` reaches the MCP) | V flag `--append-system-prompt` | V `stream_event` text/thinking deltas | V `can_use_tool` → allow/deny (+ `updatedPermissions` per suggestion; deny-with-text) | V AskUserQuestion via `can_use_tool` → `updatedInput.answers` (+ “Type something”) | V `control_request interrupt` | = session id | V 2026-10-09 claude 2.1.295 (driver fixtures); Q1–Q11 by another model: `~/.agentistics/leader/qa/f3-3-claude-live.sh` |
| OpenCode | — | F5 | absent | | | | | | | | | | | | |

A worker's row is done when: the driver is `ready`, every cell is **V** or a cited **—**, its driver
test (fake protocol peer, like `acp-structured.test.ts`) and a recorded real-session fixture pass, and
Q1–Q11 below pass on a REAL session run by a different model.

## QA — Q1–Q11 for a STRUCTURED session (per harness)

Environment as ENGINE.MAP `10-qa-scripts.md`: a throwaway server (own HOME with copied credentials
only, free ports — never 47291/47292 — own `TMUX_TMPDIR`, `AGENTISTICS_THROWAWAY=1`,
`AGENTISTICS_TELEMETRY=0`, `AGENTISTICS_ADAPTER_CHAT=1`), stopped by its saved PID only; the four
real harness MCP configs checked before/after. Evidence: screenshots (1280 + 390 px), the fleet row
JSON, `curl -N /api/fleet/chat-stream?id=` frames with arrival times.

| # | Structured-session expectation |
|---|---|
| Q1 New session | Web → New session (no prompt): row < 2 s, `waiting`; `conversationId` present as soon as the protocol states it (`conversationLinkVia: protocol-stated`); send "QA-1 say only OK": echo < 500 ms, **`live` frames while the answer streams**, the finished turn lands as `append`, state back to waiting ≤ 1.5 s after the protocol's turn end; the opening context is NOT a visible user turn; 390 px usable. |
| Q2 Reopen | Kill from the web → `exited` + Reopen. Reopen → resumes the same conversation (structured when web-born, `resume` via the driver), previous turns in the window. Restart the throwaway server (idle AND mid-turn): the row stays live, the chat continues, no turn lost or repeated (F2.0b). "Open in terminal" → a TUI resume of the same id under the same row. |
| Q3 Reboot sim | Kill the throwaway tmux socket: TUI rows `lost`; structured rows are unaffected while the server lives; record. |
| Q4 Parallel | 3 structured sessions of H in one folder, a distinct message each: every chat shows only its own conversation (no first-sighting guess — each link is protocol-stated). |
| Q5 Account switch | Record the harness's behaviour in structured mode (most have no in-protocol login: say so). |
| Q6 Approvals & questions | (a) a tool permission: the card lists the protocol's options in order; option 2 → the protocol receives option 2's id (check the agent's log / transcript); (b) a ≥ 3-option question where the protocol has one, (c) free text arrives intact; a stale card answer is refused in words; the composer is blocked while a request is open. No keystroke is sent (tmux untouched). |
| Q7 Send reliability | 10 prompts in a row, including while working: each delivered ONCE, in order (count user turns in the harness's store). |
| Q8 Attachments & vault | Attachment paths in the message are read; a vault secret never appears in any frame. |
| Q9 External | A terminal-born session of H stays a TUI (flag ON): proves routing by origin. |
| Q10 Bang & modes | `!pwd` and mode cycle: record what the protocol offers (absent is fine, cited). |
| Q11 Load sanity | 10 structured sessions + 2 tabs for 10 min: server CPU, RSS, child processes, `/api/fleet` bytes; no tmux calls for structured rows. |

Plus the **fallback checks** for every harness: (F1) flag OFF → the web spawn is a TUI, byte for byte
(compare the argv and registry row with a pre-F2.0 build); (F2) make the driver refuse (e.g. revoke the
login) → the session starts as a TUI with no error to the person; (F3) kill the structured child
process by its PID (never by name) → the row continues as a TUI resume of the same conversation.

## Open items for the integrator / next pieces

- **Public branch not pushed** (weekday business hours): `feat/f2-0-structured-backend` is local only;
  push after 17h BRT. The engine's `public.pin` names that local commit.
- **Done in F2.0b** (above): survival across a server restart, and "open in terminal" on a live
  structured session. The web has the `terminal` action but no BUTTON yet (a UI decision).
- **The relay's record grows with the session** (every protocol line) and is deleted when the session
  ends; a re-attach replays all of it. Fine for ordinary sessions; a compaction of the record is the
  next step if a very long-lived one makes the boot re-attach slow.
- **The web composer and cards** were not changed: a structured row's `dialogOptions` / `attentionOf`
  feed the existing approve path; the free-text affordance of a protocol `question` (`freeText`
  without an option) needs a UI decision when a driver first states one (F3.3 AskUserQuestion, F3.1).
- **F3.3 Claude Code** (claude 2.1.295, measured 2026-10-09): prompts sent while a turn runs are MERGED by
  the CLI into one user message (one `result` for several prompts), so the driver tracks what the CLI took
  through `--replay-user-messages` and the row reads `waiting` only once nothing sent is untaken — Q7's
  "each delivered once" holds as text, but the store may hold one merged user turn. No login →
  `initialize` answers `account.tokenSource: "none"` and the start is refused (F2 fallback). Shared,
  additive host changes: `structuredSpawnOf` sets `AGENTOP_MANAGED_ID` on every structured child (like a
  tmux pane), `StructuredProvider.prepare` ensures the session-identity key, `DialogOption.freeText`
  carries a protocol-stated free-text option to the row, and `promptSession` refuses a prompt while a
  structured session states an open request. P-07 restored (d851b3fa reverted) in the public reader and
  the engine copy. Mode cycle (`control_request set_permission_mode`) and `!` bash are not wired (Q10).
- **gemini `storeIdOf`** must map the ACP sessionId to the store's synthetic `${dir}/${file}` (F2.1),
  or the row links to an id no reader resolves.
