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
| Gemini | `acp` | F2.1 | ready | — (V 2026-10-09: `--session-id` is ignored under `--acp` and leaves a stray file; the link is the sessionId `session/new` states = the chat header's `sessionId` = `native_session_id`) | V `session/load` (same chat file appended; replay streams on AFTER the load result) | V `-m` before `--acp` (`_meta.quota.model_usage` names it) | — (no flag, gemini --help 0.63.0) | V `session/new mcpServers` (TRUSTED folder only; every MCP call is a permission request) | first-message, HELD and joined to the person's first words (ACP v1 has no field; no gemini flag; `GEMINI_SYSTEM_MD` would replace the system prompt) | V `agent_message_chunk` + `agent_thought_chunk` → `thinking` | V `request_permission` (`proceed_always` / `proceed_once` / `cancel`) | — (`ask_user` is EXCLUDED by gemini in `--acp`: `if (!interactive \|\| isAcpMode) extraExcludes.push(ASK_USER_TOOL_NAME)`) | V `session/cancel` (`stopReason: cancelled`, next prompt works) | identity: the ACP uuid (host bridges to the synthetic `<project>/<file>` by `native_session_id`) | see § F2.1 |
| Kimi | `acp` | F2.2 | ready (**V** kimi 2.1.1, 2026-10-09) | — **V** (ACP `session/new` has no id parameter; `kimi acp` has only `--login/--region`) | **V** `session/load` with `session_<uuid>` | **V** `session/set_config_option model` (no `-m` under `acp`) | **V** `set_config_option thinking` (only for a thinking-capable model) | **V** stdio `mcpServers` → `mcp__<name>__*` | first-message, **V measured**: `--agent-file` is not read by `kimi acp` — and since 2.1.1 not by the interactive TUI either | **V** chunks | **V** `request_permission` (approve_once/approve_always/reject) | **V** AskUserQuestion as `request_permission` (`q0_opt_N`+`q0_skip`; first question, no free text) | **V** `session/cancel`, also with a permission open | **V** uuid (store) ↔ `session_<uuid>` (ACP) | see "Kimi 2.1.1 findings" |
| Copilot | `acp` | F2.3 | ready (re-verify `--acp` on 1.0.93) | — (verify `--session-id`) | D | D `--model` | — | D | flag: env `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (verify) | D | D | — | D | verify | |
| Codex | `codex-app-server` | F3.1 | ready | — (0.161.0 server mints thread.id) | V `thread/resume`, relay restart | V `gpt-6.1-sol` | V `low`; other catalog efforts D | D `config.mcp_servers` | D protocol `developerInstructions` | V item deltas | V exec/options/restart; D patch | D user-input/MCP forms | V `turn/interrupt` | V thread id = rollout id | Partial; [evidence and gaps](f3-1-codex.md) (2026-10-09, CLI 0.161.0) |
| Antigravity | `agy-stream-json` | F3.2 | **ready** (schema from agy docs; first live capture pending `f3-2-agy-live.sh`) | — (agy mints it; stated on every event, `conversation_id`) | D `--conversation <id>` (stream-json pairing: live step W) | D `--model` | D `--effort low\|medium\|high\|xhigh\|max` | D global `mcp_config.json` via `agy mcp add` at boot (`agy-mcp.ts`, P-20) — **no per-session MCP flag** | first-message (no system-prompt flag in `--help` 1.3.2; input message = `content` only; `--agent` replaces the main agent) | D `step_update` `agent_response` `text_delta` | — print mode soft-denies a tool needing approval (stderr notice + `tool_info.error`); allow-rules in `settings.json` | — agent settles a choice itself in print mode | D end the process, next prompt resumes (`control_request` = exit 2, no interrupt) | identity (store keys on the stream's `conversation_id`) | fake: 25/25 (`f3-2-agy-fake-resultado.txt`); live: owner |
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
  the engine copy. F2.0b hook: the driver launches through `req.transport`, stamps turns by `pipe.now()`,
  writes fixed/ordered request ids (`agentistics-init`, `agentistics-interrupt-<n>`), and a re-attach of a
  RESUMED session dedupes the transcript tail against the replayed frames by entry uuid (the protocol's
  frames carry the transcript's uuids, 11/11 measured). Without a transport (F2.0 path) the engine's
  launcher ends live children on the host's exit (a `claude -p` child noticed its parent's death only
  ~3 s later). Mode cycle (`control_request set_permission_mode`) and `!` bash are not wired (Q10).
- **gemini `storeIdOf`** must map the ACP sessionId to the store's synthetic `${dir}/${file}` (F2.1),
  or the row links to an id no reader resolves.
## Kimi 2.1.1 findings (F2.2, 2026-10-09)

Recordings of three real sessions live in the engine (`engine/test/fixtures/live-probe/acp/kimi-2.1.1-*.jsonl`) and are
played back through the driver by `kimi-structured.test.ts`; the live script is
`~/.agentistics/leader/qa/f2-2-kimi-live.sh` (real kimi, mock model, throwaway server).

- **The conversation id has two spellings.** ACP and the TUI's `-S` use `session_<uuid>` (the directory name); the
  store, the registry and every reader use the bare `<uuid>`. `storeIdOf` strips the prefix and `acpIdOf` re-adds it
  on `resumeId`. **`kimi -S <bare-uuid>` answers "Session … not found" on 2.1.1** — the tmux resume was broken for
  every kimi session until `spawn-spec.ts` (and the copyable command in `resumeCommand.ts`, and the argv reader in
  `live-sessions.ts`) learned the prefix.
- **No opening-context channel survives.** `--agent-file` is a root option that `kimi acp` does not read, and on 2.1.1
  the *interactive* TUI binds the default profile too (`kimi --agent-file f -p …` still works; the lazily created
  interactive session does not). MCP `instructions` are not injected. Kimi therefore takes the fenced first message
  (hidden from the chat, replays stripped) on both paths.
- **Model and effort are session options**, not launch flags: `session/set_config_option` `model` / `thinking`, applied
  right after the session opens; a refused value is a refused start (host falls back to tmux, same sentence).
- **A question is a permission request** with `kind: question` on our side: `AskUserQuestion` → `request_permission`
  (options `q0_opt_N` + `q0_skip`). Only the first question, single-select, no free text. With the `elicitation` client
  capability kimi sends the full multi-question/multi-select form instead (`elicitation/create`, verified) — the
  contract has no shape for several questions yet, so it is not used.
- **There is no trust dialog under ACP.** Project-level MCP servers (`.mcp.json`) of an untrusted folder are skipped
  silently. The TUI (the tmux fallback) still shows it, and on 2.1.1 it is bigger: its footer sits under the title and
  the old attention rule could not see it. Three footers are now matched (trust, tool approval, question) with verbatim
  frames in `attention-rules.test.ts`. Reading the OPTIONS of those numbered dialogs (`▶ 1.`, `→ [1]`) is not done:
  `dialog-choice.ts` has no marker for them, so a keystroke answer stays refused in words (attach), as before.
- **P-20**: `kimi-mcp.ts` writes the agentistics MCP into `$KIMI_CODE_HOME/mcp.json` (verified: the tools appear in a
  TUI/ACP session), merge-preserving, idempotent, canonical-server only.
- Not done / follow-ups: replayed tool calls are not drawn in a resumed window (shared fold ignores them in replay);
  `usage_update` (context gauge) and `session_info_update` (title) are ignored; `mode` (default/plan/auto/yolo) is a
  config option the structured spawn has no field for; the spawn wizard offers no effort for kimi because the TUI has
  no flag (the structured path could offer `thinking`).

## F2.1 — Gemini: what was measured (gemini 0.63.0, 2026-10-09) and what it changed

Live script: `~/.agentistics/leader/qa/f2-1-gemini-live.sh` (throwaway server, flag ON, the engine worktree in the
slot, real gemini on `gemini-3.5-flash-lite`). Recorded frames: engine `test/fixtures/live-probe/acp/gemini-f21.jsonl`.

- **The link is the uuid itself.** `session/new` → `sessionId`; the chat file is
  `tmp/<project>/chats/session-<ts>-<first 8 of uuid>.jsonl` and its header `sessionId` is that uuid
  (= `SessionMeta.native_session_id`, F0.2). The file is written on the FIRST message, so the store's synthetic
  `<project>/<file>` cannot exist at second zero; `withNativeAliases` / `resolveGeminiTranscript` bridge the uuid to
  it on lookup. `--session-id <uuid> --acp` is **ignored** (the ACP session mints its own) and leaves an empty
  stray file for the offered uuid, so the driver never passes it. `gemini --acp` additionally writes a
  *bootstrap-only* second chat file per session (just `<session_context>`); `gemini-parse` already drops it.
- **`session/load` answers after the FIRST replayed frame**; the rest of the replay streams on afterwards (a
  prompt sent at once was answered among old frames). `AcpDriverDeps.replaySettleMs` (gemini: 300 ms quiet, cap 5 s)
  keeps frames flagged as replay until the stream goes quiet. The replay carries gemini's `<session_context>`
  bootstrap and each tool result (`[Function Response: <tool>]`) as USER chunks — both dropped; one user chunk is one
  whole message (`userChunksAreMessages`). Thought chunks of the replay become the turn's `thinking`.
- **Opening context: held, never alone.** First-message harnesses (gemini, kimi) used to send the fenced block as a
  message of its own when there was no initial prompt — and the model *answered it* (ran `git status`, called an
  MCP tool). It is now held and joined to the person's first `prompt()` (same moment the TUI path prepends it),
  hidden from the chat.
- **Questions are absent, cited**: gemini excludes its own `ask_user` tool in `--acp` mode. A question is message
  text; the answer is the next prompt. Permissions are fully covered (3 options for file edits; MCP tools add
  `proceed_always_server` / `proceed_always_tool`).
- **MCP** reaches gemini only in a folder gemini *trusts* (`trustedFolders.json`); an untrusted folder drops
  `session/new.mcpServers` silently. Declared on the row; not worked around (trust is the person's decision).
- **Tokens**: the prompt result's `_meta.quota.token_count` (+ per-model `model_usage`) is the protocol's statement;
  `StructuredSession.usage?()` (engine-api, additive, optional) accumulates it, and `input` equals the chat file's
  `tokens.input` for the same turn, so the store keeps reading the full breakdown from the file. A refused turn states
  nothing (never a 0).
- **A model error is a turn**: a quota/503 comes back as a JSON-RPC error on `session/prompt` with no frames; the
  chat shows `⚠ <message>` instead of silence.
- **Process tree**: gemini relaunches its worker (`--max-old-space-size`) and the MCP servers live under that, so
  killing the launcher pid leaked two node processes and a bun per session. `launchAcp` now starts the child as its own
  process group and `kill` signals the group (TERM, KILL after 3 s).
- **Host fixes this surfaced (shared, additive)**: (1) `SessionView.dialogStated` — a dialog the protocol stated is
  pickable by number on every harness; `canChoose` used to ask the *keystroke* spec, so gemini's card was shown with
  "nobody has verified how to pick an option on gemini — attach"; (2) a reopen pressed in the browser carries
  `origin: 'web'` (`ResumeSessionRequest.origin`), so it resumes structured again (it was a TUI resume).

## F3.2 — Antigravity (`agy-stream-json`): what the protocol states and what it does not

Source of the schema, read 2026-10-09 (agy 1.3.2): `agy --help`, agy's own docs
(antigravity.google/docs/cli/headless) and its embedded release notes. **Not yet captured from a live run**:
starting agy needs a login and the sandbox classifier refuses copying it, so `f3-2-agy-live.sh` (live mode,
owner-seeded) records the real wire (step W) before anything else. The parser is tolerant exactly where the
docs are silent (where `conversation_id` sits, the shape of `error`) and strict elsewhere.

- **In**: `{"event":"user","message":{"content":"…"}}`, one per line; prompts come only from stdin (never `-p "…"`);
  any non-text block ends the session; `control_request`/`control_response` end it with exit 2.
- **Out**: `init` (once per process), `step_update` (`step_type` user_input | agent_response | tool | checkpoint;
  `text_delta`; `tool_info`), `result` (once per turn). `conversation_id` is on every event.
- **No permission request, no question, no interrupt, no reasoning field is documented.** Print mode
  soft-denies a tool that needs approval (the run goes on; `tool_info.error` names it), so a structured agy
  session never has an open card; a refused tool is shown on its turn ("refused: …") and on the Terminal tab.
  Anything the person must allow is configured in agy's `settings.json` `permissions.allow` (or
  `--dangerously-skip-permissions`, which this driver never passes). **Product consequence for the integrator:**
  shell commands (default Ask) are refused in a web-born agy session until an allow-rule exists — decide whether
  to route agy structured by default, or to offer a mode choice later (`--mode accept-edits|plan` exists; the
  contract has no `mode` field yet).
- **Cancel** ends the child; the next prompt relaunches with `--conversation <id>`, so a stopped turn does not
  lose the conversation. **Resume** seeds the window from the engine's own agy transcript reader (stream-json
  does not replay history).
- **MCP** is global to agy (`~/.gemini/config/mcp_config.json`), registered by the host at boot through
  `agy mcp add` (`agy-mcp.ts`, same default-server gate as the other harnesses) — P-20.
- **P-23**: `--effort` accepts `xhigh|max` on 1.3.2 (`spawn-spec.ts` updated).
- The driver adds `AGENTOP_MANAGED_ID` to the child's env (the MCP's session proof needs it; the `acp` driver does
  not yet — a shared fix in `structuredSpawnOf` would cover all drivers).
