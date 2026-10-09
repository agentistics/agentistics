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

## Fallback

- **A refused start** (stub, login needed, `session/new` error, launch failure) → `base.spawn(req)`,
  the same request, the usual TUI.
- **A driver that fails mid-life** (`onExit({ kind: 'failed' })`) → the composite resumes the
  conversation in tmux under the SAME managed id (`provider.resumeSpawn` = `planSpawn({ resumeId })`)
  and logs it; a kill (`disposed`) or an ordinary end never triggers it. A harness with no id-taking
  resume cannot fall back this way, and says so in the log.

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
| Kimi | `acp` | F2.2 | ready (**V** kimi 2.1.1, 2026-10-09) | — **V** (ACP `session/new` has no id parameter; `kimi acp` has only `--login/--region`) | **V** `session/load` with `session_<uuid>` | **V** `session/set_config_option model` (no `-m` under `acp`) | **V** `set_config_option thinking` (only for a thinking-capable model) | **V** stdio `mcpServers` → `mcp__<name>__*` | first-message, **V measured**: `--agent-file` is not read by `kimi acp` — and since 2.1.1 not by the interactive TUI either | **V** chunks | **V** `request_permission` (approve_once/approve_always/reject) | **V** AskUserQuestion as `request_permission` (`q0_opt_N`+`q0_skip`; first question, no free text) | **V** `session/cancel`, also with a permission open | **V** uuid (store) ↔ `session_<uuid>` (ACP) | see "Kimi 2.1.1 findings" |
| Copilot | `acp` | F2.3 | ready (re-verify `--acp` on 1.0.93) | — (verify `--session-id`) | D | D `--model` | — | D | flag: env `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (verify) | D | D | — | D | verify | |
| Codex | `codex-app-server` | F3.1 | **stub** | — (server mints the thread id) | TARGET `thread/resume` | TARGET | TARGET | TARGET `-c mcp_servers` | TARGET protocol `developerInstructions` | TARGET item deltas | TARGET approvals | TARGET | TARGET `turn/interrupt` | thread id = rollout id? | |
| Antigravity | `agy-stream-json` | F3.2 | **stub** | — (agy mints it) | TARGET `--conversation` | TARGET | TARGET `xhigh/max` | TARGET (P-20) | TARGET first-message unless a field exists | TARGET | TARGET | TARGET | TARGET | from the stream | |
| Claude Code | `claude-stream-json` | F3.3 | **stub** | TARGET `--session-id` | TARGET `--resume` | TARGET | TARGET | TARGET `--mcp-config` | TARGET flag `--append-system-prompt` | TARGET partial messages | TARGET `--permission-prompt-tool` | TARGET AskUserQuestion | TARGET interrupt | = session id | |
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
| Q2 Reopen | Kill from the web → `exited` + Reopen. Reopen → resumes the same conversation (structured when web-born, `resume` via the driver), previous turns in the window. Restart the throwaway server: a structured child dies with the server — record that the row reopens by id (documented limit: no tmux survival). |
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
